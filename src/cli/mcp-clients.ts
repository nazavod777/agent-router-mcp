import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DRIVER_KINDS, DRIVER_METADATA, type DriverKind } from "../drivers.js";
import { resolveBinary } from "../adapters/probe-utils.js";
import { getEnvValue } from "../runtime/guard.js";
import type { JsonValue } from "./jsonc-edit.js";
import { CLI_NAME } from "./name.js";
import { realIfExists, resolveLauncherEntry } from "./npm-shim.js";
import { defaultSkillSourcePath } from "./skill-install.js";

export type ClientId = DriverKind;
export const CLIENT_IDS: readonly ClientId[] = DRIVER_KINDS;
export const SERVER_NAME = "orchestrator";
const DSH_MCP_PLUGIN = "@deepseek-ai/dsh-mcp-client";
const DSH_ENTRY_ID = "mcp-orchestrator";

/** Everything environment-dependent; tests inject all of it so no real home directory is ever touched. */
export interface InstallContext {
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /** Absolute path of the Node binary written into configs. */
  nodePath: string;
  /** Absolute path of this build's `dist/cli/main.js`. */
  entryPath: string;
  cwd: string;
  /** Finds a binary on PATH (defaults to `resolveBinary`). */
  pathResolver: (binary: string) => string | undefined;
  skillSourcePath: string;
  now?: () => Date;
}

/**
 * The Node path to register. `process.execPath` is the real file (`/opt/homebrew/Cellar/node/22.1.0/bin/node`), which a
 * Node upgrade deletes; when `node` on PATH is the very same file (`/opt/homebrew/bin/node`), that stable path survives
 * upgrades. A PATH `node` that is a different binary (or missing) is not used.
 */
export function preferStableNodePath(execPath: string, pathResolver: (binary: string) => string | undefined): string {
  const onPath = pathResolver("node");
  return onPath !== undefined && isAbsolute(onPath) && realOrResolved(onPath) === realOrResolved(execPath) ? onPath : execPath;
}

export function createInstallContext(overrides: Partial<InstallContext> = {}): InstallContext {
  const env = overrides.env ?? process.env;
  const platform = overrides.platform ?? process.platform;
  const pathResolver = overrides.pathResolver ?? ((binary: string) => resolveBinary(binary, {
    platform, pathEnv: getEnvValue(env, "PATH", platform), pathExt: getEnvValue(env, "PATHEXT", platform),
  }));
  return {
    homeDir: homedir(),
    env,
    platform,
    nodePath: overrides.nodePath ?? preferStableNodePath(process.execPath, pathResolver),
    entryPath: resolve(fileURLToPath(new URL("./main.js", import.meta.url))),
    cwd: process.cwd(),
    pathResolver,
    skillSourcePath: defaultSkillSourcePath(),
    ...overrides,
  };
}

/** What the installer writes: this build's Node and `main.js mcp`. */
export function canonicalArgv(ctx: InstallContext): string[] {
  return [ctx.nodePath, ctx.entryPath, "mcp"];
}

export type ConfigFormat = "json" | "toml-table" | "toml-array" | "yaml";

export interface ClientLayout {
  configPath: string;
  /** Directory holding `SKILL.md` (…/skills/orchestrate). */
  skillDir: string;
  /** The CLI's own config directory; its presence (beyond our skill) means the CLI is set up here. */
  rootDir: string;
  /** Existing files that prove the CLI is configured. */
  detectFiles: string[];
  /** Extra directories that prove the CLI is configured. */
  detectDirs: string[];
  /** Entries of `rootDir` that belong to other tools and must not count as proof. */
  ignoredRootEntries: string[];
  /** Instances only: the profile directory that must contain `rootDir` after symlinks are resolved. */
  containerDir?: string;
}

export interface ClientSpec {
  id: ClientId;
  label: string;
  binary: string;
  /** Extra, independently configured copies of this client (for example T3 Code's isolated Antigravity profiles). */
  instances?(ctx: InstallContext): Promise<ClientTarget[]>;
  /** Included in `agrmcp skill install --target all` even when not detected. */
  core: boolean;
  format: ConfigFormat;
  layout(ctx: InstallContext): ClientLayout;
  /** JSON clients: where the entry lives (OpenCode inspects the document to pick V1 or V2). */
  jsonEntryPath?(root: JsonValue | undefined): string[];
  /** JSON clients: the entry written for `argv`. */
  jsonEntry?(argv: readonly string[], existingPath: readonly string[]): JsonValue;
  /** JSON clients: entry keys the user may have tailored; a repair keeps their existing value instead of the default. */
  preserveOnMerge?: readonly string[];
  /** The binary name is shared with an unrelated tool, so PATH alone does not prove the client; the config directory must also exist. */
  binaryNeedsConfigDir?: boolean;
}

/** One configurable location of a client: the primary one, or a named instance (`antigravity:t3:<short>`). */
export interface ClientTarget {
  spec: ClientSpec;
  layout: ClientLayout;
  /** Set for extra instances only; absent on the primary target so primary output never changes. */
  instance?: string;
  /** `spec.id` for the primary target, `<spec.id>:<instance>` for an instance. */
  targetId: string;
}

export function primaryTarget(spec: ClientSpec, ctx: InstallContext): ClientTarget {
  return { spec, layout: spec.layout(ctx), targetId: spec.id };
}

/** Accepts a bare spec (primary location) or an already resolved target, so older callers keep working. */
export function toTarget(input: ClientSpec | ClientTarget, ctx: InstallContext): ClientTarget {
  return "targetId" in input ? input : primaryTarget(input, ctx);
}

/** The primary target followed by every instance the client has on this machine. */
export async function expandClientTargets(spec: ClientSpec, ctx: InstallContext): Promise<ClientTarget[]> {
  return [primaryTarget(spec, ctx), ...(spec.instances ? await spec.instances(ctx) : [])];
}

/** Name shown to humans and accepted by `--target`: `antigravity` or `antigravity:t3:<short>`. */
export function targetDisplayId(entry: { client: string; instance?: string }): string {
  return entry.instance === undefined ? entry.client : `${entry.client}:${entry.instance}`;
}

function envDir(ctx: InstallContext, name: string): string | undefined {
  const value = getEnvValue(ctx.env, name, ctx.platform);
  return value ? resolve(ctx.cwd, value) : undefined;
}

function simpleLayout(configRoot: string, configFile: string, extra: Partial<ClientLayout> = {}): ClientLayout {
  const configPath = join(configRoot, ...configFile.split("/"));
  return {
    configPath, skillDir: join(configRoot, "skills", "orchestrate"), rootDir: configRoot,
    detectFiles: [configPath], detectDirs: [], ignoredRootEntries: [], ...extra,
  };
}

function xdgConfigHome(ctx: InstallContext): string {
  return envDir(ctx, "XDG_CONFIG_HOME") ?? join(ctx.homeDir, ".config");
}

function command(argv: readonly string[]): { command: string; args: string[] } {
  return { command: argv[0], args: argv.slice(1) };
}

const OPENCODE_FILES = ["opencode.json", "opencode.jsonc"];

function opencodeLayout(ctx: InstallContext): ClientLayout {
  const root = envDir(ctx, "OPENCODE_CONFIG_DIR") ?? join(xdgConfigHome(ctx), "opencode");
  const explicit = envDir(ctx, "OPENCODE_CONFIG");
  const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };
  const candidates = OPENCODE_FILES.map((name) => join(root, name));
  // An explicit OPENCODE_CONFIG is where OpenCode reads its config, so that is where we write, even before the file exists.
  const configPath = explicit ?? candidates.find(isFile) ?? candidates[0];
  return { ...simpleLayout(root, "opencode.json"), configPath, detectFiles: [...(explicit ? [explicit] : []), ...candidates] };
}

/** OpenCode V2 nests servers under `mcp.servers`; V1 keeps them directly under `mcp`. New files use V2. */
export function opencodeEntryPath(root: JsonValue | undefined): string[] {
  const mcp = isObject(root) ? root.mcp : undefined;
  if (isObject(mcp)) {
    if (isObject(mcp[SERVER_NAME])) return ["mcp", SERVER_NAME];
    if (isObject(mcp.servers)) return ["mcp", "servers", SERVER_NAME];
    if (Object.keys(mcp).length > 0) return ["mcp", SERVER_NAME];
  }
  return ["mcp", "servers", SERVER_NAME];
}

function isObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function antigravityLayout(ctx: InstallContext): ClientLayout {
  const gemini = envDir(ctx, "GEMINI_HOME") ?? join(ctx.homeDir, ".gemini");
  const modern = join(gemini, "config");
  const legacy = join(gemini, "antigravity");
  const useLegacy = existsSync(join(legacy, "mcp_config.json")) && !existsSync(join(modern, "mcp_config.json"));
  const root = useLegacy ? legacy : modern;
  return simpleLayout(root, "mcp_config.json", {
    detectFiles: [join(modern, "mcp_config.json"), join(legacy, "mcp_config.json")],
    detectDirs: [modern, legacy],
  });
}

const T3_PROFILE_NAME = /^[A-Za-z0-9._-]{1,128}$/;
/** Raw directory entries examined, so empty or invalid directories cannot hide valid profiles behind the profile cap. */
const MAX_T3_SCAN_ENTRIES = 256;
const MAX_T3_PROFILES = 32;
const T3_SHORT_LENGTH = 12;
export const PRIMARY_INSTANCE = "primary";

/** Comparison key of a path: Windows paths differ only by case. */
function pathKey(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

/** Real path of `file` when it exists, else its real parent plus the file name; undefined when neither can be resolved. */
function canonicalConfigPath(file: string): string | undefined {
  try { return realpathSync(file); } catch { /* fall through to the parent */ }
  try { return join(realpathSync(dirname(file)), basename(file)); } catch { return undefined; }
}

function isInsideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Names of the real (non-symlink) profile directories among the first `MAX_T3_SCAN_ENTRIES` entries below `root`, in a stable order; the profile cap applies later, to profiles that hold a usable config. */
async function t3ProfileDirectories(root: string): Promise<string[]> {
  let rootReal: string;
  let entries: string[];
  try {
    rootReal = realpathSync(root);
    entries = await readdir(root);
  } catch {
    return [];
  }
  const valid: string[] = [];
  for (const name of entries.sort().slice(0, MAX_T3_SCAN_ENTRIES)) {
    if (name === "." || name === ".." || !T3_PROFILE_NAME.test(name)) continue;
    try {
      const info = lstatSync(join(root, name));
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      if (!isInsideRoot(rootReal, realpathSync(join(root, name)))) continue;
    } catch {
      continue;
    }
    valid.push(name);
  }
  return valid;
}

/** Fixed prefix of each name; it grows only for names that would otherwise share the same id, so ids stay stable. */
function shortProfileIds(names: readonly string[]): Map<string, string> {
  const ids = new Map<string, string>();
  for (const name of names) {
    let length = T3_SHORT_LENGTH;
    while (names.some((other) => other !== name && other.slice(0, length) === name.slice(0, length))) length += 1;
    ids.set(name, name.slice(0, length));
  }
  return ids;
}

/**
 * A profile counts when its `config` directory is a real directory inside it and holds an MCP config or other own content
 * (a symlinked `skills` folder is not own content). An `mcp_config.json` that is a symlink is never trusted: writing
 * through it could reach any file.
 */
async function t3ProfileConfig(profileDir: string): Promise<string | undefined> {
  const configDir = join(profileDir, "config");
  const configFile = join(configDir, "mcp_config.json");
  try {
    if (!lstatSync(configDir).isDirectory()) return undefined;
    const configReal = realpathSync(configDir);
    if (!isInsideRoot(realpathSync(profileDir), configReal)) return undefined;
    let fileInfo: ReturnType<typeof lstatSync> | undefined;
    try { fileInfo = lstatSync(configFile); } catch { fileInfo = undefined; }
    if (fileInfo !== undefined) {
      if (fileInfo.isSymbolicLink()) return undefined;
      if (!isInsideRoot(configReal, canonicalConfigPath(configFile) ?? "")) return undefined;
    }
  } catch {
    return undefined;
  }
  return existsSync(configFile) || await hasOwnContent(configDir, ["skills"]) ? configDir : undefined;
}

/**
 * T3 Code keeps an isolated Antigravity profile per account under `<T3_HOME>/userdata/providers/antigravity/<profile>/config`.
 * Only real directories directly below that root count; a profile that resolves to the primary's (or an earlier instance's)
 * config file and skills folder is skipped, so `GEMINI_HOME` pointing into a profile never yields the same files twice.
 */
/** The T3 Code directory that holds one isolated Antigravity profile per account. */
function t3AntigravityRoot(ctx: InstallContext): string {
  return join(envDir(ctx, "T3_HOME") ?? join(ctx.homeDir, ".t3"), "userdata", "providers", "antigravity");
}

async function antigravityInstances(ctx: InstallContext): Promise<ClientTarget[]> {
  const root = t3AntigravityRoot(ctx);
  const names = await t3ProfileDirectories(root);
  if (names.length === 0) return [];
  const spec = CLIENTS.antigravity;
  const found: Array<{ name: string; profileDir: string; layout: ClientLayout }> = [];
  for (const name of names) {
    const profileDir = join(root, name);
    const configDir = await t3ProfileConfig(profileDir);
    if (configDir !== undefined) {
      if (found.length >= MAX_T3_PROFILES) break;
      found.push({ name, profileDir, layout: simpleLayout(configDir, "mcp_config.json", { ignoredRootEntries: ["skills"], containerDir: profileDir }) });
    }
  }
  const ids = shortProfileIds(found.map((entry) => entry.name));
  const seen = new Set<string>();
  const keyOf = (layout: ClientLayout): string | undefined => {
    const config = canonicalConfigPath(layout.configPath);
    const skills = canonicalConfigPath(layout.skillDir);
    return config === undefined ? undefined : `${pathKey(config, ctx.platform)}\0${pathKey(skills ?? "", ctx.platform)}`;
  };
  const primaryKey = keyOf(antigravityLayout(ctx));
  if (primaryKey !== undefined) seen.add(primaryKey);
  const targets: ClientTarget[] = [];
  for (const { name, layout } of found) {
    // Only a profile whose config file AND skills folder both repeat an earlier location is a duplicate.
    const key = keyOf(layout);
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const instance = `t3:${ids.get(name)}`;
    targets.push({ spec, layout, instance, targetId: `${spec.id}:${instance}` });
  }
  return targets;
}

/** The shared Antigravity skills folders a T3 profile may legitimately link its own `skills` to. */
function trustedSharedSkillsDirs(ctx: InstallContext): string[] {
  const base = envDir(ctx, "GEMINI_HOME") ?? join(ctx.homeDir, ".gemini");
  return [...new Set([join(base, "config", "skills"), join(ctx.homeDir, ".gemini", "config", "skills"), join(antigravityLayout(ctx).rootDir, "skills")])];
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
    throw error;
  }
}

function realOrUndefined(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

/** `path` is `root` itself or lies inside it. */
function isWithin(root: string, path: string): boolean {
  return path === root || isInsideRoot(root, path);
}

function refuseInstance(target: ClientTarget, what: string): never {
  throw new Error(`refusing to write for ${target.targetId}: ${what}`);
}

/**
 * The layout whose writes must stay inside a profile: an instance's own layout, or the primary Antigravity layout when
 * `GEMINI_HOME` points into a T3 Code profile (the profile directory then becomes the container). Undefined: unchecked.
 */
function guardedLayout(target: ClientTarget, ctx: InstallContext | undefined): ClientLayout | undefined {
  if (target.instance !== undefined) return target.layout;
  if (ctx === undefined || target.spec.id !== "antigravity") return undefined;
  const t3Root = t3AntigravityRoot(ctx);
  const t3Real = realOrUndefined(t3Root);
  for (const [root, rootDir] of [[resolve(t3Root), resolve(target.layout.rootDir)], ...(t3Real === undefined ? [] : [[t3Real, realOrUndefined(target.layout.rootDir) ?? ""]])]) {
    if (!isInsideRoot(root, rootDir)) continue;
    const profile = relative(root, rootDir).split(/[\\/]/)[0];
    return { ...target.layout, containerDir: join(root, profile) };
  }
  return undefined;
}

/**
 * Instance writes stay inside the profile: the profile's config directory must still be a real directory inside the
 * profile, and `mcp_config.json` must not be a symlink. Throws before anything is written; a primary target is unchecked.
 */
export function assertInstanceConfigWritable(target: ClientTarget, ctx?: InstallContext): void {
  const layout = guardedLayout(target, ctx);
  if (layout === undefined) return;
  const rootInfo = lstatOrUndefined(layout.rootDir);
  if (rootInfo === undefined) return; // not created yet: the parent was validated when the profile was discovered
  const rootReal = realOrUndefined(layout.rootDir);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || rootReal === undefined) refuseInstance(target, `${layout.rootDir} is not a real directory.`);
  const container = layout.containerDir === undefined ? undefined : realOrUndefined(layout.containerDir);
  if (layout.containerDir !== undefined && (container === undefined || !isInsideRoot(container, rootReal))) {
    refuseInstance(target, `${layout.rootDir} resolves outside its profile.`);
  }
  if (ctx !== undefined && container !== undefined) {
    // Re-checked right before writing: the profile directory itself must still lie inside the real T3 root.
    const t3Real = realOrUndefined(t3AntigravityRoot(ctx));
    if (t3Real === undefined || !isInsideRoot(t3Real, container)) refuseInstance(target, `${layout.containerDir} resolves outside the T3 Code profiles folder.`);
  }
  const file = lstatOrUndefined(layout.configPath);
  if (file === undefined) return;
  if (file.isSymbolicLink()) refuseInstance(target, `${layout.configPath} is a symbolic link.`);
  const fileReal = realOrUndefined(layout.configPath);
  if (fileReal === undefined || !isInsideRoot(rootReal, fileReal)) refuseInstance(target, `${layout.configPath} resolves outside ${layout.rootDir}.`);
}

/**
 * The profile's `skills` folder must be a real directory inside the profile, or a link to the primary Antigravity's shared
 * skills folder and nothing else (a dangling or foreign link is refused); `skills/orchestrate` and its `SKILL.md` must not
 * be symlinks that leave the allowed skills folder. Throws before the skill is written; a primary target is unchecked.
 */
export function assertInstanceSkillWritable(target: ClientTarget, ctx: InstallContext): void {
  const layout = guardedLayout(target, ctx);
  if (layout === undefined) return;
  assertInstanceConfigWritable(target, ctx);
  const rootReal = realOrUndefined(layout.rootDir);
  if (rootReal === undefined) return;
  const skillsDir = dirname(layout.skillDir);
  const skillsInfo = lstatOrUndefined(skillsDir);
  if (skillsInfo === undefined) return;
  let allowedRoot: string;
  const skillsReal = realOrUndefined(skillsDir);
  if (skillsInfo.isSymbolicLink()) {
    const trusted = trustedSharedSkillsDirs(ctx).map(realOrUndefined);
    if (skillsReal === undefined || !trusted.some((dir) => dir !== undefined && pathKey(dir, ctx.platform) === pathKey(skillsReal, ctx.platform))) {
      refuseInstance(target, `${skillsDir} is a link that does not lead to the shared Antigravity skills folder.`);
    }
    allowedRoot = skillsReal;
  } else {
    if (!skillsInfo.isDirectory() || skillsReal === undefined || !isInsideRoot(rootReal, skillsReal)) refuseInstance(target, `${skillsDir} is not a real directory inside the profile.`);
    allowedRoot = skillsReal;
  }
  for (const path of [layout.skillDir, join(layout.skillDir, "SKILL.md")]) {
    const info = lstatOrUndefined(path);
    if (info === undefined) continue;
    const real = realOrUndefined(path);
    if (info.isSymbolicLink() && (real === undefined || !isInsideRoot(allowedRoot, real))) {
      refuseInstance(target, `${path} is a symbolic link that leaves the skills folder.`);
    }
    if (real !== undefined && !isWithin(allowedRoot, real)) refuseInstance(target, `${path} resolves outside the skills folder.`);
  }
}

function kimiLayout(ctx: InstallContext): ClientLayout {
  const modern = join(ctx.homeDir, ".kimi-code");
  const legacy = join(ctx.homeDir, ".kimi");
  const root = envDir(ctx, "KIMI_CODE_HOME") ?? (existsSync(legacy) && !existsSync(modern) ? legacy : modern);
  return simpleLayout(root, "mcp.json", { detectDirs: [modern, legacy] });
}

/** Home-relative root, optionally overridden by an env var that points at the root itself. */
function rooted(envVar: string | undefined, ...segments: string[]): (ctx: InstallContext) => string {
  return (ctx) => (envVar ? envDir(ctx, envVar) : undefined) ?? join(ctx.homeDir, ...segments);
}

const mcpServersEntry = (argv: readonly string[]): JsonValue => command(argv);

const CLIENT_SPECS: Record<ClientId, Omit<ClientSpec, "id" | "label" | "binary" | "core">> = {
  claude: {
    format: "json",
    layout: (ctx) => {
      const override = envDir(ctx, "CLAUDE_CONFIG_DIR");
      const root = override ?? join(ctx.homeDir, ".claude");
      const configPath = override ? join(override, ".claude.json") : join(ctx.homeDir, ".claude.json");
      return simpleLayout(root, ".claude.json", { configPath, detectFiles: [configPath] });
    },
    jsonEntryPath: () => ["mcpServers", SERVER_NAME],
    jsonEntry: (argv) => ({ type: "stdio", ...command(argv) }),
  },
  codex: { format: "toml-table", layout: (ctx) => simpleLayout(rooted("CODEX_HOME", ".codex")(ctx), "config.toml") },
  dsh: { format: "yaml", layout: (ctx) => simpleLayout(rooted("DSH_HOME", ".dsh")(ctx), "cordis.patch.yml") },
  pi: {
    format: "json",
    layout: (ctx) => simpleLayout(rooted("PI_CODING_AGENT_DIR", ".pi", "agent")(ctx), "mcp.json"),
    jsonEntryPath: () => ["mcpServers", SERVER_NAME],
    jsonEntry: mcpServersEntry,
  },
  antigravity: {
    format: "json", layout: antigravityLayout, instances: antigravityInstances,
    jsonEntryPath: () => ["mcpServers", SERVER_NAME], jsonEntry: mcpServersEntry,
  },
  opencode: {
    format: "json", layout: opencodeLayout, jsonEntryPath: opencodeEntryPath,
    jsonEntry: (argv, path): JsonValue => path.length === 2 ? { type: "local", command: [...argv], enabled: true } : { type: "local", command: [...argv] },
  },
  gemini: {
    format: "json",
    layout: (ctx) => {
      const home = envDir(ctx, "GEMINI_CLI_HOME");
      return simpleLayout(home ? join(home, ".gemini") : join(ctx.homeDir, ".gemini"), "settings.json", { ignoredRootEntries: ["antigravity", "config"] });
    },
    jsonEntryPath: () => ["mcpServers", SERVER_NAME], jsonEntry: mcpServersEntry,
  },
  cursor: {
    format: "json", layout: (ctx) => simpleLayout(join(ctx.homeDir, ".cursor"), "mcp.json"),
    jsonEntryPath: () => ["mcpServers", SERVER_NAME], jsonEntry: mcpServersEntry,
  },
  grok: { format: "toml-table", layout: (ctx) => simpleLayout(rooted("GROK_HOME", ".grok")(ctx), "config.toml") },
  kiro: {
    format: "json", layout: (ctx) => simpleLayout(join(ctx.homeDir, ".kiro"), "settings/mcp.json"),
    jsonEntryPath: () => ["mcpServers", SERVER_NAME], jsonEntry: mcpServersEntry,
  },
  fx: {
    binaryNeedsConfigDir: true, // `fx` on PATH is usually Anton Medvedev's JSON viewer, not Vercel fx
    format: "json", layout: (ctx) => simpleLayout(rooted("FX_HOME", ".fx")(ctx), "mcp.json"),
    jsonEntryPath: () => ["mcpServers", SERVER_NAME], jsonEntry: (argv) => ({ type: "stdio", command: [...argv] }),
  },
  muse: {
    format: "json", layout: (ctx) => simpleLayout(join(xdgConfigHome(ctx), "muse"), "settings.json"),
    jsonEntryPath: () => ["mcp_servers", SERVER_NAME],
    jsonEntry: (argv) => ({ transport: "stdio", ...command(argv), mode: "optional" }),
  },
  copilot: {
    format: "json", layout: (ctx) => simpleLayout(rooted("COPILOT_HOME", ".copilot")(ctx), "mcp-config.json"),
    jsonEntryPath: () => ["mcpServers", SERVER_NAME],
    jsonEntry: (argv) => ({ type: "local", ...command(argv), tools: ["*"] }),
    preserveOnMerge: ["tools"],
  },
  droid: {
    format: "json", layout: (ctx) => simpleLayout(join(ctx.homeDir, ".factory"), "mcp.json"),
    jsonEntryPath: () => ["mcpServers", SERVER_NAME], jsonEntry: (argv) => ({ type: "stdio", ...command(argv) }),
  },
  qwen: {
    format: "json", layout: (ctx) => simpleLayout(rooted("QWEN_HOME", ".qwen")(ctx), "settings.json"),
    jsonEntryPath: () => ["mcpServers", SERVER_NAME], jsonEntry: mcpServersEntry,
  },
  kimi: {
    format: "json", layout: kimiLayout,
    jsonEntryPath: () => ["mcpServers", SERVER_NAME], jsonEntry: mcpServersEntry,
  },
  vibe: { format: "toml-array", layout: (ctx) => simpleLayout(rooted("VIBE_HOME", ".vibe")(ctx), "config.toml") },
};

export const CLIENTS: Readonly<Record<ClientId, ClientSpec>> = Object.fromEntries(CLIENT_IDS.map((id) => {
  const meta = DRIVER_METADATA[id];
  const core = meta.skillDir?.coreTarget === true;
  return [id, { id, label: meta.label, binary: meta.defaultBinary, core, ...CLIENT_SPECS[id] }];
})) as Record<ClientId, ClientSpec>;

export function isClientId(value: string): value is ClientId {
  return Object.hasOwn(CLIENTS, value);
}

export interface DetectionResult {
  detected: boolean;
  reasons: string[];
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

const SKILL_SEGMENTS = ["skills", "orchestrate"];

async function containsOnly(directory: string, segments: readonly string[]): Promise<boolean> {
  for (const entry of await readdir(directory)) {
    if (entry !== segments[0]) return false;
    if (segments.length > 1 && !await containsOnly(join(directory, entry), segments.slice(1))) return false;
  }
  return true;
}

/** True when `directory` holds anything besides our own `skills/orchestrate` (and entries owned by other tools); an empty directory does not count. */
async function hasOwnContent(directory: string, ignoredEntries: readonly string[] = []): Promise<boolean> {
  if (!isDirectory(directory)) return false;
  const ignored = new Set(ignoredEntries);
  try {
    const entries = await readdir(directory);
    // An empty directory is a leftover (for example an emptied `~/.cursor/`), not a configured client.
    for (const entry of entries) {
      if (ignored.has(entry)) continue;
      if (entry !== SKILL_SEGMENTS[0] || !await containsOnly(join(directory, entry), SKILL_SEGMENTS.slice(1))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * A client counts as present when its binary is on PATH or its config file/directory exists (a lone skill copy does not
 * count). A binary whose name collides with another tool (`binaryNeedsConfigDir`) is only evidence next to such config.
 */
export async function detectClient(input: ClientSpec | ClientTarget, ctx: InstallContext): Promise<DetectionResult> {
  const { spec, layout, instance } = toTarget(input, ctx);
  const configReasons: string[] = [];
  for (const file of layout.detectFiles) if (existsSync(file)) configReasons.push(`config ${file}`);
  for (const directory of layout.detectDirs) if (await hasOwnContent(directory, layout.ignoredRootEntries)) configReasons.push(`directory ${directory}`);
  if (await hasOwnContent(layout.rootDir, layout.ignoredRootEntries)) configReasons.push(`directory ${layout.rootDir}`);
  // An instance is its own profile: the client's binary on PATH says nothing about it.
  const binary = instance === undefined ? ctx.pathResolver(spec.binary) : undefined;
  const binaryCounts = binary !== undefined && (!spec.binaryNeedsConfigDir || configReasons.length > 0);
  const reasons = [...(binaryCounts ? [`binary ${binary}`] : []), ...configReasons];
  return { detected: reasons.length > 0, reasons: [...new Set(reasons)] };
}

// ---------------------------------------------------------------------------
// Ownership classification
// ---------------------------------------------------------------------------

export type McpStatus = "current" | "missing" | "stale" | "disabled" | "conflict" | "invalid";

/** A server entry reduced to what ownership checks need. */
export interface EntryView {
  argv: string[];
  disabled: boolean;
  /** Set when the entry cannot be ours for a reason other than its command (for example a foreign plugin). */
  conflict?: string;
}

function realOrResolved(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function sameFile(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  const same = (a: string, b: string) => pathKey(a, platform) === pathKey(b, platform);
  return same(resolve(left), resolve(right)) || same(realOrResolved(left), realOrResolved(right));
}

/** On Windows only a drive path (`C:\x`) or a UNC path (`\\server\share`) is fully qualified; `\x` depends on the current drive. */
const WINDOWS_FULLY_QUALIFIED = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/;

function isAbsoluteFor(ctx: InstallContext, path: string): boolean {
  return ctx.platform === "win32" ? WINDOWS_FULLY_QUALIFIED.test(path) : isAbsolute(path);
}

function stripExtension(name: string): string {
  return name.replace(/\.(?:cmd|exe|bat|ps1|js|mjs)$/i, "");
}

function posixish(path: string): string {
  return path.replace(/\\/g, "/");
}

const PACKAGE_NAME = "agent-router-mcp";
const NODE_EXECUTABLES = new Set(["node", "nodejs"]);
const BUILD_ENTRY = /(?:^|\/)dist\/cli\/(?:main|mcp)\.js$/;
/** A compiled Windows launcher cannot be followed to a script, so its ownership rests on the name alone. */
const OPAQUE_LAUNCHER = /\.exe$/i;
/** Node flags whose next argument is their value, not the script. */
const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions", "--env-file"]);

/** Name in the package.json three levels above `dist/cli/<entry>.js`, when that file exists and is readable. */
function packageNameAbove(entry: string): string | undefined {
  if (!isAbsolute(entry)) return undefined;
  try {
    const name = (JSON.parse(readFileSync(join(dirname(entry), "..", "..", "package.json"), "utf8")) as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

const launcherName = (token: string): string => stripExtension(basename(posixish(token)));

/** The path `command` runs: itself when absolute, otherwise the PATH lookup (undefined when it cannot be found). */
function resolveLauncher(command: string, ctx: InstallContext): string | undefined {
  return isAbsolute(command) ? command : ctx.pathResolver(command);
}

/**
 * A direct launcher (`agrmcp`, `orch`, `orchestrator-mcp`) that can be resolved on disk is ours only when it leads to a
 * `dist/cli/main.js`/`mcp.js` of this package, directly or through an npm `.cmd`/`.ps1`/shell shim. An unresolvable one
 * (or a compiled `.exe`) is judged by its name alone.
 */
function launcherLeadsToThisPackage(command: string, ctx: InstallContext | undefined): boolean {
  const resolved = ctx ? resolveLauncher(command, ctx) : undefined;
  if (resolved === undefined || OPAQUE_LAUNCHER.test(resolved)) return true;
  const entry = resolveLauncherEntry(resolved);
  if (entry === undefined || OPAQUE_LAUNCHER.test(entry)) return true;
  if (ctx && sameFile(entry, ctx.entryPath, ctx.platform)) return true;
  return BUILD_ENTRY.test(posixish(entry)) && (packageNameAbove(entry) ?? PACKAGE_NAME) === PACKAGE_NAME;
}

function isNodeExecutable(token: string): boolean {
  return NODE_EXECUTABLES.has(launcherName(token).toLowerCase());
}

/** Index of the script Node runs within `args`: the first argument that is neither a flag nor a flag's value (-1 when none). */
function nodeScriptIndex(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("-")) return index;
    if (NODE_VALUE_FLAGS.has(args[index])) index += 1;
  }
  return -1;
}

/** Node running this package's `dist/cli/main.js mcp` or `dist/cli/mcp.js`; undefined when Node runs something else. */
function nodeRunsBuildEntry(argv: readonly string[]): boolean | undefined {
  const [executable, ...args] = argv;
  if (executable === undefined || !isNodeExecutable(executable)) return undefined;
  const index = nodeScriptIndex(args);
  if (index < 0) return undefined;
  const script = posixish(args[index]);
  const isBuildEntry = BUILD_ENTRY.test(script) && (!/main\.js$/.test(script) || args[index + 1] === "mcp");
  return isBuildEntry ? (packageNameAbove(args[index]) ?? PACKAGE_NAME) === PACKAGE_NAME : undefined;
}

/** `orchestrator-mcp` run directly, or by Node; any other interpreter (python, bash, env, ...) running a same-named script is foreign. */
function launchesLegacyShim(tokens: readonly string[]): boolean {
  const [executable, script] = tokens;
  if (executable === undefined) return false;
  if (launcherName(executable) === "orchestrator-mcp") return true;
  return isNodeExecutable(executable) && script !== undefined && launcherName(script) === "orchestrator-mcp";
}

/** A direct `<launcher> mcp` command (no interpreter in front), for `agrmcp` and the legacy `orch`. */
function directLauncher(tokens: readonly string[], names: readonly string[]): string | undefined {
  const [executable, mode, ...extra] = tokens;
  if (executable === undefined || mode !== "mcp" || extra.length > 0) return undefined;
  return names.includes(launcherName(executable)) ? executable : undefined;
}

/**
 * The entry launches agent-router-mcp (any location): `agrmcp mcp`, `node dist/cli/main.js mcp`, `node dist/cli/mcp.js`, or a
 * legacy launcher (`orch mcp`, `orchestrator-mcp`, directly or via Node). A build path is only the executed script when Node
 * runs it (`python server.py .../dist/cli/mcp.js` merely passes it as data), and one whose package.json names a different
 * package is someone else's server, however similar its layout. With `ctx`, a launcher found on PATH must also lead to this
 * package (a foreign `orch` binary is not ours).
 */
export function looksOwned(argv: readonly string[], ctx?: InstallContext): boolean {
  const tokens = argv.map(posixish);
  const buildEntry = nodeRunsBuildEntry(argv);
  if (buildEntry !== undefined) return buildEntry;
  const direct = directLauncher(tokens, [CLI_NAME, "orch"]);
  if (direct !== undefined) return launcherLeadsToThisPackage(argv[0], ctx);
  if (launchesLegacyShim(tokens)) return isNodeExecutable(argv[0]) || launcherLeadsToThisPackage(argv[0], ctx);
  return false;
}

export interface ClassifyOptions {
  /** A dry run plans an install before the build exists, so it judges the planned entry as if the built file were there. */
  assumeEntryExists?: boolean;
}

/**
 * The entry already launches exactly this build: the canonical `[node, main.js, "mcp"]`, or `agrmcp mcp` whose PATH binary
 * is this build's `main.js`. Either way the built file must exist. Legacy launchers (`orchestrator-mcp`, `orch mcp`,
 * `node .../mcp.js`) are deliberately absent: they stay owned but are never current, so install and setup migrate them.
 */
export function isCurrent(argv: readonly string[], ctx: InstallContext, options: ClassifyOptions = {}): boolean {
  const entryReal = realIfExists(ctx.entryPath);
  if (entryReal === undefined && !options.assumeEntryExists) return false;
  const [first, second, third] = argv;
  // A relative node or script path resolves against whatever directory the client starts in, so it is never this build.
  if (argv.length === 3 && isAbsoluteFor(ctx, first) && isAbsoluteFor(ctx, second) && sameFile(first, ctx.nodePath, ctx.platform) && sameFile(second, ctx.entryPath, ctx.platform) && third === "mcp") return true;
  if (argv.length === 2 && second === "mcp" && launcherName(posixish(first)) === CLI_NAME) {
    const resolved = resolveLauncher(first, ctx);
    return resolved !== undefined && entryReal !== undefined && pathKey(resolveLauncherEntry(resolved) ?? "", ctx.platform) === pathKey(entryReal, ctx.platform);
  }
  return false;
}

export function classifyEntry(view: EntryView | undefined, ctx: InstallContext, options: ClassifyOptions = {}): McpStatus {
  if (!view) return "missing";
  if (view.conflict || !looksOwned(view.argv, ctx)) return "conflict";
  if (view.disabled) return "disabled";
  return isCurrent(view.argv, ctx, options) ? "current" : "stale";
}

export { DSH_ENTRY_ID, DSH_MCP_PLUGIN };
