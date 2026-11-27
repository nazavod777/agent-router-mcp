import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDocument as parseYamlDocument } from "yaml";
import type { DriverKind } from "../drivers.js";
import type { HarnessConcurrencyInfo } from "../types.js";
import type { HarnessConfig } from "./schema.js";

/** Parallel jobs per CLI when no config states a limit; mirrors the `default_harness_concurrency` schema default. */
export const DEFAULT_CLI_CONCURRENCY_FALLBACK = 5;

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_LIMIT_VALUE = 64;
const MAX_YAML_ALIASES = 50;
const MAX_PATCH_ENTRIES = 1_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 256;
const UTF8_BOM = 0xfeff;
const SAFE_PROFILE_NAME = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/i;
const DISCOVERY_TIMEOUT_MS = 3_000;
/** After a discovery timeout the fallback is reused this long, so a stalled mount cannot hang every call. */
const TIMEOUT_FALLBACK_TTL_MS = 15_000;
const MAX_WARNINGS = 20;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
/** Files that may hold credentials; never opened, whatever path points at them. */
const DENIED_BASENAMES: readonly RegExp[] = [
  /^auth\.json$/i, /credentials/i, /^\.env/i, /\.pem$/i, /\.key$/i, /^\.?claude\.json$/i,
  /^id_/i, /^\.netrc$/i, /token/i, /secret/i, /^hosts\.ya?ml$/i,
];
/** Only these environment variables influence discovery; the cache key never copies the whole environment. */
const RELEVANT_ENV = [
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "CLAUDE_CODE_MAX_CONCURRENT_AGENTS",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG", "APPDATA", "DSH_HOME", "GEMINI_CLI_HOME", "PI_CODING_AGENT_DIR", "ProgramData", "PROGRAMDATA",
  "ProgramFiles", "PROGRAMFILES", "HOME", "USERPROFILE",
] as const;
const DSH_SUBAGENT_IDS: ReadonlySet<string> = new Set(["subagent", "subagent-spawn-in-process", "tool-subagent"]);

export type CliLimitSource = "cli_config" | "fallback";

export interface CliLimitDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  cwd?: string;
  /**
   * Directory that stands in for the filesystem root when system-wide files (managed Claude settings, Gemini system
   * settings) are looked up on macOS and Linux, e.g. `<root>/etc/claude-code/managed-settings.json`. Tests inject it so a
   * real machine-wide config can never affect them; Windows system paths are already steered by `ProgramData`/`ProgramFiles`.
   */
  systemRoot?: string;
  /** Ignore cached results. */
  refresh?: boolean;
  cacheTtlMs?: number;
}

export interface CliLimits {
  driver: DriverKind;
  /** Parallel limit found in the CLI's own config; 0 when none is stated. */
  max_concurrent: number;
  /** Native subagent depth found in the CLI's own config; 0 means subagents are off. */
  max_depth?: number;
  /** DSH only: the depth found per subagent plugin id, so a clamp can lower exactly the plugins that exceed its limit. */
  max_depth_by_plugin?: Record<string, number>;
  native_subagents: HarnessConcurrencyInfo["native_subagents"];
  source: CliLimitSource;
  fallback_used: boolean;
  /** Dotted config keys that held a valid value; invocation clamping only emits keys the user already has. */
  discovered_keys: string[];
  config_files: string[];
  warnings: string[];
}

type ConfigFormat = "json" | "toml" | "yaml";
interface Candidate { path: string; format: ConfigFormat }
interface KeySpec { path: readonly string[]; allowString?: boolean }
interface Findings {
  maxConcurrent?: number; maxDepth?: number; enabled?: boolean; keys: Set<string>; toolSubagentEnabled?: boolean;
  /** Last value per DSH plugin id; a later patch entry for the same id replaces an earlier one. */
  pluginDepths: Record<string, number>;
}
interface ResolvedOptions {
  env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; cwd: string; refresh: boolean; cacheTtlMs: number;
  path: typeof posix; systemRoot?: string;
}
type ReadResult = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "skipped"; reason: string };

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/** Removes `//` and block comments and trailing commas outside string literals, so the result is plain JSON. */
export function stripJsoncComments(raw: string): string {
  const text = raw.charCodeAt(0) === UTF8_BOM ? raw.slice(1) : raw;
  const out: string[] = [];
  let index = 0;
  let inString = false;
  let lastComma = -1;
  while (index < text.length) {
    const char = text[index];
    if (inString) {
      out.push(char);
      if (char === "\\" && index + 1 < text.length) {
        out.push(text[index + 1]);
        index += 2;
        continue;
      }
      if (char === "\"") inString = false;
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      // A comment still separates tokens: `1/*c*/2` must not become `12`.
      out.push(" ");
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === ",") {
      lastComma = out.length;
    } else if (char === "}" || char === "]") {
      if (lastComma >= 0) out[lastComma] = "";
      lastComma = -1;
    } else if (!/\s/.test(char)) {
      lastComma = -1;
    }
    if (char === "\"") inString = true;
    out.push(char);
    index += 1;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Safe file access
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(source: unknown, key: string): unknown {
  return isPlainObject(source) && !UNSAFE_KEYS.has(key) && Object.hasOwn(source, key) ? source[key] : undefined;
}

function valueAt(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const key of path) {
    current = ownValue(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

async function readBoundedText(candidate: Candidate, opts: ResolvedOptions): Promise<ReadResult> {
  const { path } = candidate;
  const name = opts.path.basename(path);
  if (DENIED_BASENAMES.some((pattern) => pattern.test(name))) return { kind: "skipped", reason: "file name is denied" };
  try {
    const entry = await lstat(path);
    if (!entry.isFile()) return { kind: "skipped", reason: "not a regular file" };
    if (entry.size > MAX_CONFIG_BYTES) return { kind: "skipped", reason: "file is too large" };
    const noFollow = opts.platform !== "win32" ? constants.O_NOFOLLOW ?? 0 : 0;
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_CONFIG_BYTES) return { kind: "skipped", reason: "not a bounded regular file" };
      const bytes = Buffer.allocUnsafe(opened.size);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      let text = bytes.subarray(0, length).toString("utf8");
      if (text.charCodeAt(0) === UTF8_BOM) text = text.slice(1);
      return { kind: "ok", text: text.replace(/\r\n?/g, "\n") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "skipped", reason: code === "ELOOP" ? "symbolic link" : "not readable" };
  }
}

async function fileStamp(path: string): Promise<string> {
  try {
    const entry = await lstat(path, { bigint: true });
    return `${entry.mtimeNs}:${entry.size}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
}

// ---------------------------------------------------------------------------
// Candidate files per CLI
// ---------------------------------------------------------------------------

function resolveOptions(options: CliLimitDiscoveryOptions): ResolvedOptions {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const envHome = platform === "win32" ? env.USERPROFILE : env.HOME;
  return {
    env,
    platform,
    home: options.home ?? (envHome || homedir()),
    cwd: options.cwd ?? process.cwd(),
    refresh: options.refresh === true,
    cacheTtlMs: options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    path: platform === "win32" ? win32 : posix,
    ...(options.systemRoot !== undefined ? { systemRoot: options.systemRoot } : {}),
  };
}

/** An absolute POSIX system path, re-rooted under `systemRoot` when one is injected. */
function systemPath(opts: ResolvedOptions, absolute: string): string {
  return opts.systemRoot === undefined ? absolute : posix.join(opts.systemRoot, absolute);
}

function programData(opts: ResolvedOptions): string {
  return opts.env.ProgramData ?? opts.env.PROGRAMDATA ?? "C:\\ProgramData";
}

function programFiles(opts: ResolvedOptions): string {
  return opts.env.ProgramFiles ?? opts.env.PROGRAMFILES ?? "C:\\Program Files";
}

/** A directory or file named by an environment variable; a relative value resolves against the working directory. */
function envPath(opts: ResolvedOptions, name: string): string | undefined {
  const value = opts.env[name];
  return value ? opts.path.resolve(opts.cwd, value) : undefined;
}

function jsonPair(path: typeof posix, dir: string, stem: string): Candidate[] {
  return [{ path: path.join(dir, `${stem}.json`), format: "json" }, { path: path.join(dir, `${stem}.jsonc`), format: "json" }];
}

function claudeCandidates(opts: ResolvedOptions): Candidate[] {
  const { path, home, cwd, platform } = opts;
  const userDir = envPath(opts, "CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude");
  // Managed settings come last (highest precedence). On Windows the Program Files location wins over the legacy ProgramData one.
  const managed = platform === "win32"
    ? [path.join(programData(opts), "ClaudeCode", "managed-settings.json"), path.join(programFiles(opts), "ClaudeCode", "managed-settings.json")]
    : platform === "darwin" ? [systemPath(opts, "/Library/Application Support/ClaudeCode/managed-settings.json")]
      : [systemPath(opts, "/etc/claude-code/managed-settings.json")];
  return [
    path.join(userDir, "settings.json"), path.join(userDir, "settings.local.json"),
    path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"), ...managed,
  ].map((file) => ({ path: file, format: "json" }));
}

function opencodeCandidates(opts: ResolvedOptions): Candidate[] {
  const { path, env, home, cwd, platform } = opts;
  const candidates: Candidate[] = [];
  if (platform === "win32" && env.APPDATA) candidates.push(...jsonPair(path, path.join(env.APPDATA, "opencode"), "opencode"));
  candidates.push(...jsonPair(path, path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode"), "opencode"));
  const configDir = envPath(opts, "OPENCODE_CONFIG_DIR");
  if (configDir) candidates.push(...jsonPair(path, configDir, "opencode"));
  const configFile = envPath(opts, "OPENCODE_CONFIG");
  if (configFile) candidates.push({ path: configFile, format: "json" });
  candidates.push(...jsonPair(path, cwd, "opencode"));
  return candidates;
}

function dshCandidates(harness: HarnessConfig, opts: ResolvedOptions, warnings: string[]): Candidate[] {
  const { path, home } = opts;
  const dir = envPath(opts, "DSH_HOME") ?? path.join(home, ".dsh");
  const profile = harness.profile ?? "headless";
  const candidates: Candidate[] = [];
  if (SAFE_PROFILE_NAME.test(profile)) {
    for (const extension of ["yml", "yaml"]) candidates.push({ path: path.join(dir, "profiles", `${profile}.${extension}`), format: "yaml" });
  } else {
    warnings.push("Ignored the DSH profile file: the profile name is not a plain file name.");
  }
  candidates.push({ path: path.join(dir, "cordis.patch.yml"), format: "yaml" });
  return candidates;
}

function geminiCandidates(opts: ResolvedOptions): Candidate[] {
  const { path, home, cwd, platform } = opts;
  const system = platform === "win32" ? path.join(programData(opts), "gemini-cli", "settings.json")
    : platform === "darwin" ? systemPath(opts, "/Library/Application Support/GeminiCli/settings.json")
      : systemPath(opts, "/etc/gemini-cli/settings.json");
  // System settings override user and project settings, so they come last.
  return [path.join(envPath(opts, "GEMINI_CLI_HOME") ?? home, ".gemini", "settings.json"), path.join(cwd, ".gemini", "settings.json"), system]
    .map((file) => ({ path: file, format: "json" }));
}

/** Config files that can hold limits for a driver, lowest precedence first. Pure: nothing is read. */
export function listCliConfigCandidates(
  driver: DriverKind, harness: Pick<HarnessConfig, "profile">, options: CliLimitDiscoveryOptions = {},
): Candidate[] {
  return candidatesFor(driver, harness as HarnessConfig, resolveOptions(options), []);
}

function candidatesFor(driver: DriverKind, harness: HarnessConfig, opts: ResolvedOptions, warnings: string[]): Candidate[] {
  const { path, home } = opts;
  switch (driver) {
    case "codex": return [{ path: path.join(envPath(opts, "CODEX_HOME") ?? path.join(home, ".codex"), "config.toml"), format: "toml" }];
    case "claude": return claudeCandidates(opts);
    case "opencode": return opencodeCandidates(opts);
    case "dsh": return dshCandidates(harness, opts, warnings);
    case "gemini": return geminiCandidates(opts);
    case "pi": return [{ path: path.join(envPath(opts, "PI_CODING_AGENT_DIR") ?? path.join(home, ".pi", "agent"), "settings.json"), format: "json" }];
    case "droid": return [{ path: path.join(home, ".factory", "settings.json"), format: "json" }];
    case "qwen": return [{ path: path.join(home, ".qwen", "settings.json"), format: "json" }];
    case "kimi": return [{ path: path.join(home, ".kimi", "config.toml"), format: "toml" }];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const CLAUDE_SPECS = {
  concurrency: [
    { path: ["env", "CLAUDE_CODE_MAX_CONCURRENT_AGENTS"], allowString: true },
    { path: ["env", "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS"], allowString: true },
    { path: ["subagentMaxConcurrency"] },
    { path: ["maxConcurrentSubagents"] },
  ],
  depth: [{ path: ["env", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"], allowString: true }, { path: ["maxSubagentSpawnDepth"] }],
};
const OPENCODE_SPECS = {
  concurrency: [
    { path: ["experimental", "max_concurrent_subagents"] }, { path: ["subagents", "max_concurrent"] },
    { path: ["subagents", "maxConcurrent"] },
  ],
  depth: [{ path: ["subagent_depth"] }, { path: ["experimental", "subagent_depth"] }],
};
const GEMINI_SPECS = {
  concurrency: [
    { path: ["agents", "maxConcurrency"] }, { path: ["agents", "maxConcurrent"] }, { path: ["subagents", "maxConcurrent"] },
  ],
  depth: [{ path: ["agents", "maxDepth"] }, { path: ["subagents", "maxDepth"] }],
  enabled: [{ path: ["experimental", "enableAgents"] }],
};
const PI_SPECS = {
  concurrency: [{ path: ["subagents", "maxConcurrent"] }, { path: ["subagent", "maxConcurrent"] }, { path: ["maxConcurrentSubagents"] }],
  depth: [{ path: ["subagents", "maxDepth"] }, { path: ["subagent", "maxDepth"] }],
};
const GENERIC_SPECS = {
  concurrency: [{ path: ["subagents", "maxConcurrent"] }, { path: ["subagents", "max_concurrent"] }, { path: ["maxConcurrentSubagents"] }],
  depth: [{ path: ["subagents", "maxDepth"] }, { path: ["subagents", "max_depth"] }],
};

interface SpecSet { concurrency: readonly KeySpec[]; depth: readonly KeySpec[]; enabled?: readonly KeySpec[] }

/** Returns an integer in 0..64, or undefined (with a warning naming only the key) when the value is not usable. */
function boundedInt(value: unknown, key: string, warnings: string[], allowString = false): number | undefined {
  if (value === undefined) return undefined;
  let number: number | undefined;
  if (typeof value === "number") number = value;
  else if (allowString && typeof value === "string" && /^\d{1,4}$/.test(value.trim())) number = Number(value.trim());
  if (number === undefined || !Number.isInteger(number) || number < 0 || number > MAX_LIMIT_VALUE) {
    warnings.push(`Ignored ${key}: expected an integer from 0 to ${MAX_LIMIT_VALUE}.`);
    return undefined;
  }
  return number;
}

function applySpecs(source: unknown, specs: SpecSet, findings: Findings, warnings: string[]): void {
  for (const spec of specs.concurrency) {
    const key = spec.path.join(".");
    const value = boundedInt(valueAt(source, spec.path), key, warnings, spec.allowString);
    if (value !== undefined) {
      findings.maxConcurrent = value;
      findings.keys.add(key);
    }
  }
  for (const spec of specs.depth) {
    const key = spec.path.join(".");
    const value = boundedInt(valueAt(source, spec.path), key, warnings, spec.allowString);
    if (value !== undefined) {
      findings.maxDepth = value;
      findings.keys.add(key);
    }
  }
  for (const spec of specs.enabled ?? []) {
    const value = valueAt(source, spec.path);
    if (typeof value === "boolean") {
      findings.enabled = value;
      findings.keys.add(spec.path.join("."));
    }
  }
}

function mergeObjects(base: Record<string, unknown>, top: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(top)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const current = merged[key];
    merged[key] = isPlainObject(current) && isPlainObject(value) ? mergeObjects(current, value) : value;
  }
  return merged;
}

function extractCodex(root: unknown, profile: string | undefined, findings: Findings, warnings: string[]): void {
  if (!isPlainObject(root)) return;
  const profileTable = profile === undefined ? undefined : valueAt(root, ["profiles", profile]);
  const config = isPlainObject(profileTable) ? mergeObjects(root, profileTable) : root;

  const multiAgent = valueAt(config, ["features", "multi_agent"]);
  if (typeof multiAgent === "boolean") {
    findings.enabled = multiAgent;
    findings.keys.add("features.multi_agent");
  }
  const v2 = valueAt(config, ["features", "multi_agent_v2"]);
  const v2Active = v2 === true || (isPlainObject(v2) && v2.enabled !== false);
  if (isPlainObject(v2) && typeof v2.enabled === "boolean") findings.keys.add("features.multi_agent_v2.enabled");
  const v2Threads = boundedInt(valueAt(v2, ["max_concurrent_threads_per_session"]),
    "features.multi_agent_v2.max_concurrent_threads_per_session", warnings);
  const newThreads = boundedInt(valueAt(config, ["agents", "max_concurrent_threads_per_session"]),
    "agents.max_concurrent_threads_per_session", warnings);
  const legacyThreads = newThreads === undefined ? boundedInt(valueAt(config, ["agents", "max_threads"]), "agents.max_threads", warnings) : undefined;
  const agentsThreads = newThreads ?? legacyThreads;

  if (v2Active && v2Threads !== undefined) {
    // v2 counts the parent session too, so the child threads are one fewer (never below one while enabled).
    findings.maxConcurrent = v2Threads > 0 ? Math.max(1, v2Threads - 1) : 0;
    findings.keys.add("features.multi_agent_v2.max_concurrent_threads_per_session");
  } else if (agentsThreads !== undefined) {
    findings.maxConcurrent = agentsThreads;
    findings.keys.add(newThreads === undefined ? "agents.max_threads" : "agents.max_concurrent_threads_per_session");
  }
  const depth = boundedInt(valueAt(config, ["agents", "max_depth"]), "agents.max_depth", warnings);
  if (depth !== undefined) {
    findings.maxDepth = depth;
    findings.keys.add("agents.max_depth");
  }
}

function extractDsh(source: unknown, findings: Findings, warnings: string[]): void {
  const container = isPlainObject(source) ? (ownValue(source, "patches") ?? ownValue(source, "patch")) : source;
  if (!Array.isArray(container)) return;
  for (const entry of container.slice(0, MAX_PATCH_ENTRIES) as unknown[]) {
    const id = ownValue(entry, "id");
    if (typeof id !== "string" || !DSH_SUBAGENT_IDS.has(id)) continue;
    const disabled = ownValue(entry, "disabled");
    if (typeof disabled === "boolean") {
      findings.enabled = findings.enabled === false ? false : !disabled;
      findings.keys.add(`${id}.disabled`);
    }
    if (id === "tool-subagent" && disabled !== true) findings.toolSubagentEnabled = true;
    const config = ownValue(entry, "config");
    for (const name of ["maxActiveSubagents", "maxConcurrentAgents"]) {
      const value = boundedInt(ownValue(config, name), `${id}.config.${name}`, warnings);
      if (value !== undefined) {
        findings.maxConcurrent = value;
        findings.keys.add(`${id}.config.${name}`);
      }
    }
    const depth = boundedInt(ownValue(config, "maxDepth"), `${id}.config.maxDepth`, warnings);
    if (depth !== undefined) {
      findings.pluginDepths[id] = depth;
      findings.keys.add(`${id}.config.maxDepth`);
    }
  }
  // The deepest plugin decides how deep subagents can go, so the result does not depend on the order of the patch entries.
  const depths = Object.values(findings.pluginDepths);
  if (depths.length > 0) findings.maxDepth = Math.max(...depths);
}

function specsFor(driver: DriverKind): SpecSet | undefined {
  switch (driver) {
    case "claude": return CLAUDE_SPECS;
    case "opencode": return OPENCODE_SPECS;
    case "gemini": return GEMINI_SPECS;
    case "pi": return PI_SPECS;
    case "droid": case "qwen": case "kimi": return GENERIC_SPECS;
    default: return undefined;
  }
}

function parseConfig(candidate: Candidate, text: string): unknown {
  switch (candidate.format) {
    case "json": return JSON.parse(stripJsoncComments(text));
    case "toml": return parseToml(text);
    case "yaml": return parseYamlConfig(text);
  }
}

/**
 * Parses YAML without side effects: nothing reaches stderr or `process.emitWarning`, and the thrown error carries no
 * source text (the caller reports only the file path). Parser warnings are dropped; errors reject the file. The alias
 * limit is a `toJS` option: it is enforced while aliases are resolved, which throws on a billion-laughs style document.
 */
function parseYamlConfig(text: string): unknown {
  const doc = parseYamlDocument(text, { logLevel: "silent" });
  if (doc.errors.length > 0) throw new Error("invalid YAML");
  return doc.toJS({ maxAliasCount: MAX_YAML_ALIASES });
}

/** Process env layer for Claude: only the allowlisted variables are copied, never the whole environment. */
function claudeEnvLayer(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const names = [...CLAUDE_SPECS.concurrency, ...CLAUDE_SPECS.depth].flatMap((spec) => spec.path[0] === "env" ? [spec.path[1]] : []);
  const picked: Record<string, unknown> = {};
  for (const name of names) if (env[name] !== undefined) picked[name] = env[name];
  return { env: picked };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Limits with nothing discovered; the runtime then falls back to `default_harness_concurrency`. */
export function emptyCliLimits(driver: DriverKind, warnings: string[] = []): CliLimits {
  return {
    driver, max_concurrent: 0, native_subagents: "unknown", source: "fallback", fallback_used: true,
    discovered_keys: [], config_files: [], warnings,
  };
}

interface CacheEntry { expiresAt: number; stamps: string[]; limits: CliLimits; generation: number }
const cache = new Map<string, CacheEntry>();
/** One running discovery per cache key: concurrent callers share it instead of each probing the filesystem. */
interface InFlightDiscovery { promise: Promise<CliLimits>; startedAt: number }
const inFlight = new Map<string, InFlightDiscovery>();
/** Grows with every started discovery, so a slow older one can tell it was overtaken by a newer (for example forced) one. */
let nextGeneration = 0;
/** Fallbacks served for a short time after a discovery timed out. */
const timeoutFallbacks = new Map<string, { expiresAt: number; limits: CliLimits }>();

export function clearCliLimitsCache(): void {
  cache.clear();
  timeoutFallbacks.clear();
  inFlight.clear();
}

function buildLimits(driver: DriverKind, findings: Findings, files: string[], warnings: string[]): CliLimits {
  const disabledByConfig = findings.enabled === false || findings.maxConcurrent === 0 || findings.maxDepth === 0;
  const maxConcurrent = (findings.maxConcurrent ?? 0) >= 1 ? findings.maxConcurrent! : 0;
  const native = driver === "pi" ? "disabled_by_invocation"
    : disabledByConfig ? "disabled_by_config" : findings.keys.size > 0 || findings.toolSubagentEnabled ? "enabled" : "unknown";
  const fromConfig = maxConcurrent >= 1;
  return {
    driver,
    max_concurrent: maxConcurrent,
    ...(findings.maxDepth !== undefined ? { max_depth: findings.maxDepth } : {}),
    ...(Object.keys(findings.pluginDepths).length > 0 ? { max_depth_by_plugin: { ...findings.pluginDepths } } : {}),
    native_subagents: native,
    source: fromConfig ? "cli_config" : "fallback",
    fallback_used: !fromConfig,
    discovered_keys: [...findings.keys].sort(),
    config_files: files,
    warnings: warnings.length > MAX_WARNINGS
      ? [...warnings.slice(0, MAX_WARNINGS), `${warnings.length - MAX_WARNINGS} more warnings omitted.`] : warnings,
  };
}

async function discover(
  driver: DriverKind, harness: HarnessConfig, candidates: Candidate[], opts: ResolvedOptions, warnings: string[],
): Promise<CliLimits> {
  const findings: Findings = { keys: new Set(), pluginDepths: {} };
  const files: string[] = [];
  const specs = specsFor(driver);
  if (driver === "claude" && specs) applySpecs(claudeEnvLayer(opts.env), specs, findings, warnings);
  for (const candidate of candidates) {
    const read = await readBoundedText(candidate, opts);
    if (read.kind === "missing") continue;
    if (read.kind === "skipped") {
      warnings.push(`Skipped ${candidate.path}: ${read.reason}.`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseConfig(candidate, read.text);
    } catch {
      warnings.push(`Could not parse ${candidate.path}.`);
      continue;
    }
    files.push(candidate.path);
    if (driver === "codex") extractCodex(parsed, harness.profile, findings, warnings);
    else if (driver === "dsh") extractDsh(parsed, findings, warnings);
    else if (specs) applySpecs(parsed, specs, findings, warnings);
  }
  return buildLimits(driver, findings, files, warnings);
}

class DiscoveryTimeoutError extends Error {}

/** A hung filesystem (network mount) must not stall callers; the discovery then reports the fallback. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DiscoveryTimeoutError("timeout")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function remember<T>(entries: Map<string, T>, key: string, entry: T): void {
  if (entries.size >= MAX_CACHE_ENTRIES && !entries.has(key)) entries.delete(entries.keys().next().value!);
  entries.set(key, entry);
}

/** Stamps the candidate files, serves a fresh cache hit, or reads the files. Runs under the discovery deadline. */
async function discoverCached(
  driver: DriverKind, harness: HarnessConfig, candidates: Candidate[], opts: ResolvedOptions, warnings: string[], cacheKey: string,
  generation: number,
): Promise<CliLimits> {
  const stamps = await Promise.all(candidates.map((candidate) => fileStamp(candidate.path)));
  const cached = cache.get(cacheKey);
  if (!opts.refresh && cached && cached.expiresAt > Date.now() && cached.stamps.join("|") === stamps.join("|")) return cached.limits;
  const limits = await discover(driver, harness, candidates, opts, warnings);
  // A discovery that was overtaken (it timed out for its caller and a forced refresh finished first) must not overwrite the newer result.
  const current = cache.get(cacheKey);
  if (current === undefined || current.generation <= generation) {
    remember(cache, cacheKey, { expiresAt: Date.now() + opts.cacheTtlMs, stamps, limits, generation });
  }
  return limits;
}

/** Joins the discovery already running for `cacheKey`, or starts one; a forced refresh always starts a new one. */
function sharedDiscovery(cacheKey: string, refresh: boolean, start: (generation: number) => Promise<CliLimits>): Promise<CliLimits> {
  const running = inFlight.get(cacheKey);
  // A discovery older than the deadline is stuck (a hung mount): callers still get their own timeout, and a later one probes afresh.
  if (running && !refresh && Date.now() - running.startedAt < DISCOVERY_TIMEOUT_MS) return running.promise;
  const entry: InFlightDiscovery = { promise: undefined as unknown as Promise<CliLimits>, startedAt: Date.now() };
  entry.promise = start(++nextGeneration).finally(() => {
    if (inFlight.get(cacheKey) === entry) inFlight.delete(cacheKey);
  });
  remember(inFlight, cacheKey, entry);
  return entry.promise;
}

/** Reads a CLI's own config for parallel and subagent limits. Never throws; unreadable input yields the fallback. */
export async function discoverCliLimits(
  driver: DriverKind, harness: HarnessConfig, options: CliLimitDiscoveryOptions = {},
): Promise<CliLimits> {
  const opts = resolveOptions(options);
  const warnings: string[] = [];
  let cacheKey: string | undefined;
  try {
    const candidates = candidatesFor(driver, harness, opts, warnings);
    cacheKey = JSON.stringify([driver, harness.profile ?? null, opts.cwd, opts.platform, opts.home, opts.systemRoot ?? null,
      RELEVANT_ENV.map((name) => opts.env[name] ?? null)]);
    const stalled = timeoutFallbacks.get(cacheKey);
    if (!opts.refresh && stalled && stalled.expiresAt > Date.now()) return structuredClone(stalled.limits);
    const key = cacheKey;
    const limits = await withTimeout(
      sharedDiscovery(key, opts.refresh, (generation) => discoverCached(driver, harness, candidates, opts, warnings, key, generation)),
      DISCOVERY_TIMEOUT_MS,
    );
    // A discovery that finished makes an earlier timeout fallback stale, even one that has not expired yet.
    timeoutFallbacks.delete(cacheKey);
    return structuredClone(limits);
  } catch (error) {
    const limits = emptyCliLimits(driver, [...warnings, `Could not discover CLI limits for ${driver}.`]);
    if (cacheKey !== undefined && error instanceof DiscoveryTimeoutError) {
      remember(timeoutFallbacks, cacheKey, { expiresAt: Date.now() + TIMEOUT_FALLBACK_TTL_MS, limits });
    }
    return structuredClone(limits);
  }
}

export async function discoverAllCliLimits(
  config: { harnesses: Record<string, HarnessConfig> }, options: CliLimitDiscoveryOptions = {},
): Promise<Record<string, CliLimits>> {
  const entries = await Promise.all(Object.entries(config.harnesses).map(async ([id, harness]) =>
    [id, await discoverCliLimits(harness.driver, harness, options)] as const));
  return Object.fromEntries(entries);
}
