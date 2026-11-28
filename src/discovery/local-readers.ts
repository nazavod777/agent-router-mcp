/**
 * Layer 1 of model auto-discovery (NEW in Wave 2): fast OFFLINE readers of each CLI's own local config/cache files.
 *
 * Hard rules of this module:
 * - No subprocesses and no network. Everything environment-dependent comes from `LocalReadInput`.
 * - Only allowlisted model/provider metadata keys are read, field by field. Credentials, headers, env blocks, base URLs and
 *   whole provider objects are never read, copied, or spread into the output.
 * - Every output string is sanitized (control characters, ANSI, length, URL userinfo/query/fragment).
 * - Files are opened through a bounded safe reader (regular files only, size cap, file-count cap, deny-list of secret file names).
 *   A symbolic link (Nix home-manager, stow, chezmoi) is followed to its real path, and the deny-list is applied to both the link
 *   name and the target name; a link to a FIFO, device, or directory is refused like any other non-regular file.
 * - Missing files are silent; unreadable, oversized or invalid files become `source_unreadable` diagnostics that name only the
 *   file's base name and a fixed reason, never file content or parser text.
 *
 * Probe-only drivers (`cursor`, `kiro`, `muse`) keep no readable local model source: they return an empty observation without
 * diagnostics, and only the CLI listing probes of Layer 2 can find their models.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { performance } from "node:perf_hooks";
import { parse as parseToml } from "smol-toml";
import { parseDocument as parseYamlDocument } from "yaml";
import { stripJsoncComments } from "../config/cli-limits.js";
import { getEnvValue } from "../runtime/guard.js";
import type { DriverKind } from "../drivers.js";
import {
  MAX_MODELS_PER_SOURCE, type DiscoveredModel, type DiscoveryDiagnostic, type DiscoveryObservation, type LocalReadInput,
} from "./types.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
/** Files one reader may open (missing files do not count); no driver needs more than a handful. */
const MAX_FILES_PER_READ = 12;
/** Hint mode (doctor, 45 ms for everything) reads less: a parse of a megabyte alone could use the whole budget. */
const HINT_MAX_CONFIG_BYTES = 128 * 1024;
const HINT_MAX_FILES_PER_READ = 3;
/** The clock is read once per this many models added: a clock read per model would dominate the nested loops. */
const DEADLINE_CHECK_INTERVAL = 32;
const MAX_YAML_ALIASES = 50;
const MAX_PATCH_ENTRIES = 1_000;
const MAX_TEXT_LENGTH = 200;
const MAX_BASENAME_LENGTH = 100;
const MAX_EFFORTS = 16;
const MAX_EFFORT_LENGTH = 40;
const MAX_CONTEXT_WINDOW = 1_000_000_000;
const UTF8_BOM = 0xfeff;
const DEFAULT_DSH_PROFILE = "headless";
const DEFAULT_DSH_UPSTREAM_PROVIDER = "deepseek-official";
const SAFE_PROFILE_NAME = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/i;
const EFFORT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DISABLED_EFFORTS = new Set(["none", "off", "false", "disabled"]);
/** Files that may hold credentials; never opened, whatever path points at them (mirrors `src/config/cli-limits.ts`). */
const DENIED_BASENAMES: readonly RegExp[] = [
  /^auth\.json$/i, /credentials/i, /^\.env/i, /\.pem$/i, /\.key$/i, /^\.?claude\.json$/i,
  /^id_/i, /^\.netrc$/i, /token/i, /secret/i, /^hosts\.ya?ml$/i,
];

const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
/** Line breaks and tabs separate words; every other control, zero-width, and bidi character is removed outright so it cannot split a URL. */
const WORD_BREAKS = /[\t\n\r\u2028\u2029]/g;
const INVISIBLE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]*/gi;
/** `user:secret@host`, with or without a scheme: such a value is dropped whole, because rewriting it could keep part of the secret. */
const USERINFO_LIKE = /[^\s/@]*:[^\s/@]*@/;
/** A model or provider identifier is one plain token: it can never start a flag or hold spaces. */
const IDENTIFIER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+#-]*$/;

type Format = "json" | "toml" | "yaml";
type Origin = "config" | "cache";
type StopReason = "cancelled" | "timeout";
type LoadResult = { kind: "ok"; data: unknown } | { kind: "missing" } | { kind: "failed" };
type ReadOutcome = { kind: "ok"; text: string } | { kind: "missing" } | { kind: "skipped"; reason: string };
type PathModule = typeof posix;

/** Raw, unsanitized facts about one model; `addModel` validates and sanitizes every field. */
interface Draft {
  model: unknown;
  provider?: unknown;
  displayName?: unknown;
  context?: unknown;
  reasoning?: unknown;
  efforts?: readonly string[];
  origin?: Origin;
}

interface Context {
  input: LocalReadInput;
  path: PathModule;
  models: Map<string, DiscoveredModel>;
  diagnostics: DiscoveryDiagnostic[];
  readPaths: Set<string>;
  maxFileBytes: number;
  maxFiles: number;
  /** Files opened (or refused after being found) so far; compared with `maxFiles`. */
  filesRead: number;
  /** Models offered to `addModel` so far; paces the deadline check inside the parsing loops. */
  modelsOffered: number;
  truncated: boolean;
  stopped?: StopReason;
}

type Reader = (ctx: Context) => Promise<void>;

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

/** Keeps only `scheme://host`: userinfo, path, query, and fragment can all carry credentials, so none is kept. */
function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.host ? `${url.protocol}//${url.host}` : "";
  } catch {
    return "";
  }
}

/**
 * Strips ANSI and invisible characters first (so they cannot hide a URL), drops values that look like `user:secret@host`,
 * reduces URLs to `scheme://host`, collapses whitespace, and caps the length. Non-strings yield undefined.
 */
function cleanText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== "string") return undefined;
  const plain = value.replace(ANSI_SEQUENCE, "").replace(WORD_BREAKS, " ").replace(INVISIBLE_CHARACTERS, "");
  if (USERINFO_LIKE.test(plain)) return undefined;
  const text = plain
    .replace(URL_LIKE, sanitizeUrl)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
  return text === "" ? undefined : text;
}

/** A model or provider identifier: cleaned like any text and then required to be one plain token. */
function cleanIdentifier(value: unknown): string | undefined {
  const text = cleanText(value);
  return text !== undefined && IDENTIFIER_TOKEN.test(text) ? text : undefined;
}

function contextWindow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_CONTEXT_WINDOW ? value : undefined;
}

/** Effort names are short plain tokens; anything else is dropped. */
function effortToken(value: unknown): string | undefined {
  const text = cleanText(value, MAX_EFFORT_LENGTH);
  return text !== undefined && EFFORT_TOKEN.test(text) ? text : undefined;
}

function uniqueEfforts(values: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const token = effortToken(value);
    if (token !== undefined) seen.add(token);
    if (seen.size >= MAX_EFFORTS) break;
  }
  return [...seen];
}

/** Accepts an array of effort strings or of `{ effort }` objects; anything else yields no efforts. */
function effortList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueEfforts(value.slice(0, MAX_EFFORTS * 4).map((item) => typeof item === "string" ? item : own(item, "effort")));
}

/** A single configured effort: it implies reasoning unless it names "off". */
function singleEffort(value: unknown): Pick<Draft, "efforts" | "reasoning"> {
  const token = effortToken(value);
  if (token === undefined || DISABLED_EFFORTS.has(token.toLowerCase())) return {};
  return { efforts: [token], reasoning: true };
}

// ---------------------------------------------------------------------------
// Safe structure access
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(source: unknown, key: string): unknown {
  return isObject(source) && !UNSAFE_KEYS.has(key) && Object.hasOwn(source, key) ? source[key] : undefined;
}

function at(source: unknown, ...keys: string[]): unknown {
  let current = source;
  for (const key of keys) {
    current = own(current, key);
    if (current === undefined) return undefined;
  }
  return current;
}

function entriesOf(ctx: Context, value: unknown): Array<[string, unknown]> {
  if (!isObject(value)) return [];
  const entries = Object.entries(value).filter(([key]) => !UNSAFE_KEYS.has(key));
  if (entries.length > MAX_MODELS_PER_SOURCE) ctx.truncated = true;
  return entries.slice(0, MAX_MODELS_PER_SOURCE);
}

function listOf(ctx: Context, value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_MODELS_PER_SOURCE) ctx.truncated = true;
  return value.slice(0, MAX_MODELS_PER_SOURCE);
}

function stringsOf(ctx: Context, value: unknown): string[] {
  return listOf(ctx, value).filter((item): item is string => typeof item === "string");
}

/** First numeric value among the given own keys. */
function firstContext(source: unknown, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = contextWindow(own(source, key));
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstBoolean(source: unknown, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = own(source, key);
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

/** Splits a `provider/model` route at the first slash; nested slashes stay in the model part. */
function splitRoute(value: string): { provider?: string; model: string } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return { model: value };
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// Model accumulator
// ---------------------------------------------------------------------------

function modelKey(provider: string | undefined, model: string): string {
  return `${provider ?? ""}\u0000${model}`;
}

/** Sanitizes a draft and merges it into the observation; one entry per (provider, model), capped at MAX_MODELS_PER_SOURCE. */
function addModel(ctx: Context, draft: Draft): void {
  // Nested parsing loops end here too: once the deadline passes or the signal fires, every further model is dropped at once.
  if (ctx.stopped !== undefined) return;
  if (++ctx.modelsOffered % DEADLINE_CHECK_INTERVAL === 0 && isStopped(ctx)) return;
  const model = cleanIdentifier(draft.model);
  if (model === undefined) return;
  const provider = draft.provider === undefined ? undefined : cleanIdentifier(draft.provider);
  const displayName = cleanText(draft.displayName);
  const context = contextWindow(draft.context);
  const reasoning = typeof draft.reasoning === "boolean" ? draft.reasoning : undefined;
  const efforts = draft.efforts && draft.efforts.length > 0 ? uniqueEfforts(draft.efforts) : [];
  const fromCache = draft.origin === "cache";

  const key = modelKey(provider, model);
  const existing = ctx.models.get(key);
  if (!existing) {
    if (ctx.models.size >= MAX_MODELS_PER_SOURCE) {
      ctx.truncated = true;
      return;
    }
    ctx.models.set(key, {
      cli_model: model,
      ...(provider !== undefined ? { cli_provider: provider } : {}),
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      ...(context !== undefined ? { context_window: context, context_precision: "exact" as const } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(efforts.length > 0 ? { native_efforts: efforts } : {}),
      availability: fromCache ? "unknown" : "configured",
      evidence: fromCache ? "local_cache" : "local_config",
    });
    return;
  }
  if (existing.display_name === undefined && displayName !== undefined) existing.display_name = displayName;
  if (existing.context_window === undefined && context !== undefined) {
    existing.context_window = context;
    existing.context_precision = "exact";
  }
  if (reasoning !== undefined && (existing.reasoning === undefined || reasoning)) existing.reasoning = existing.reasoning === true || reasoning;
  if (efforts.length > 0) existing.native_efforts = uniqueEfforts([...(existing.native_efforts ?? []), ...efforts]);
  if (!fromCache && existing.availability !== "configured") {
    existing.availability = "configured";
    existing.evidence = "local_config";
  }
}

// ---------------------------------------------------------------------------
// Cancellation and deadline
// ---------------------------------------------------------------------------

const STOPPED = Symbol("stopped");

function stopReason(ctx: Context): StopReason | undefined {
  if (ctx.stopped) return ctx.stopped;
  if (ctx.input.signal?.aborted) return "cancelled";
  const deadline = ctx.input.deadlineAtMs;
  if (deadline !== undefined && performance.now() >= deadline) return "timeout";
  return undefined;
}

/** Records the stop and reports whether reading must end. */
function isStopped(ctx: Context): boolean {
  const reason = stopReason(ctx);
  if (reason === undefined) return false;
  ctx.stopped = reason;
  ctx.truncated = true;
  return true;
}

/** Resolves with STOPPED as soon as the abort signal fires or the deadline passes, so a stalled mount cannot hang the caller. */
function raceStop<T>(ctx: Context, work: Promise<T>): Promise<T | typeof STOPPED> {
  const { signal, deadlineAtMs } = ctx.input;
  if (signal === undefined && deadlineAtMs === undefined) return work;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<typeof STOPPED>((resolve) => {
    if (deadlineAtMs !== undefined) timer = setTimeout(() => resolve(STOPPED), Math.max(0, deadlineAtMs - performance.now()));
    if (signal !== undefined) {
      onAbort = () => resolve(STOPPED);
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([work, stop]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  });
}

// ---------------------------------------------------------------------------
// Safe file access
// ---------------------------------------------------------------------------

const isDeniedName = (name: string): boolean => DENIED_BASENAMES.some((pattern) => pattern.test(name));

async function readBoundedText(file: string, name: string, platform: NodeJS.Platform, maxBytes: number): Promise<ReadOutcome> {
  if (isDeniedName(name)) return { kind: "skipped", reason: "file name is denied" };
  try {
    let real = file;
    let entry = await lstat(file);
    if (entry.isSymbolicLink()) {
      // Dotfile managers link the real file elsewhere. The link is followed only after the TARGET's name passed the deny-list
      // too, so a link called `settings.json` cannot reach `auth.json`; what it reaches must still be a regular file.
      real = await realpath(file);
      if (isDeniedName(pathModule(platform).basename(real))) return { kind: "skipped", reason: "file name is denied" };
      entry = await lstat(real);
    }
    if (!entry.isFile()) return { kind: "skipped", reason: "not a regular file" };
    if (entry.size > maxBytes) return { kind: "skipped", reason: "file is too large" };
    const noFollow = platform !== "win32" ? constants.O_NOFOLLOW ?? 0 : 0;
    const handle = await open(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > maxBytes) return { kind: "skipped", reason: "not a bounded regular file" };
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

/** Parses YAML without side effects; the thrown error carries no source text. */
function parseYamlText(text: string): unknown {
  const doc = parseYamlDocument(text, { logLevel: "silent" });
  if (doc.errors.length > 0) throw new Error("invalid YAML");
  return doc.toJS({ maxAliasCount: MAX_YAML_ALIASES });
}

function parseText(format: Format, text: string): unknown {
  switch (format) {
    case "json": return JSON.parse(stripJsoncComments(text));
    case "toml": return parseToml(text);
    case "yaml": return parseYamlText(text);
  }
}

function unreadable(ctx: Context, file: string, reason: string): void {
  const name = cleanText(ctx.path.basename(file), MAX_BASENAME_LENGTH) ?? "file";
  ctx.diagnostics.push({ stage: "offline", code: "source_unreadable", message: `${name}: ${reason}` });
}

/** Reads and parses one source file. Never throws; problems become diagnostics, a missing file is silent. */
async function load(ctx: Context, file: string, format: Format): Promise<LoadResult> {
  if (ctx.readPaths.has(file)) return { kind: "failed" };
  ctx.readPaths.add(file);
  if (isStopped(ctx)) return { kind: "failed" };
  if (ctx.filesRead >= ctx.maxFiles) {
    // The file cap is a budget, not a fault: what was gathered stays, and the observation says it is not complete.
    ctx.truncated = true;
    return { kind: "failed" };
  }
  const outcome = await raceStop(ctx, readBoundedText(file, ctx.path.basename(file), ctx.input.platform, ctx.maxFileBytes));
  if (outcome === STOPPED) {
    isStopped(ctx);
    return { kind: "failed" };
  }
  if (outcome.kind === "missing") return { kind: "missing" };
  ctx.filesRead += 1;
  if (outcome.kind === "skipped") {
    unreadable(ctx, file, outcome.reason);
    return { kind: "failed" };
  }
  // An empty (or whitespace-only) file is a valid source that names no models; it is not a broken one.
  if (outcome.text.trim() === "") return { kind: "ok", data: undefined };
  try {
    return { kind: "ok", data: parseText(format, outcome.text) };
  } catch {
    unreadable(ctx, file, "invalid content");
    return { kind: "failed" };
  }
}

async function loadData(ctx: Context, file: string, format: Format): Promise<unknown> {
  const result = await load(ctx, file, format);
  return result.kind === "ok" ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function pathModule(platform: NodeJS.Platform): PathModule {
  return platform === "win32" ? win32 : posix;
}

/** A path named by an environment variable; a relative value resolves against the injected cwd, never the process cwd. */
function envPath(ctx: Context, name: string): string | undefined {
  const value = getEnvValue(ctx.input.env, name, ctx.input.platform);
  if (typeof value !== "string" || value === "") return undefined;
  const { path } = ctx;
  return path.isAbsolute(value) ? path.normalize(value) : path.join(ctx.input.cwd, value);
}

function validProfile(profile: string | undefined): string | undefined {
  return profile !== undefined && SAFE_PROFILE_NAME.test(profile) ? profile : undefined;
}

function rejectedProfile(ctx: Context): void {
  ctx.diagnostics.push({ stage: "offline", code: "source_unreadable", message: "Ignored the harness profile: not a plain file name." });
}

// ---------------------------------------------------------------------------
// Per-driver readers
// ---------------------------------------------------------------------------

/** Fields shared by Pi model entries and model overrides. */
function piModelDraft(model: unknown, provider: string, id: unknown): Draft {
  const levels = at(model, "thinkingLevelMap");
  // A null level marks the level as unsupported.
  const supported = isObject(levels) ? Object.entries(levels).filter(([key, value]) => !UNSAFE_KEYS.has(key) && value !== null).map(([key]) => key) : [];
  return {
    model: id, provider, displayName: own(model, "name"), context: own(model, "contextWindow"),
    reasoning: own(model, "reasoning"), efforts: supported,
  };
}

const readPi: Reader = async (ctx) => {
  const dir = envPath(ctx, "PI_CODING_AGENT_DIR") ?? ctx.path.join(ctx.input.homeDir, ".pi", "agent");
  const models = await loadData(ctx, ctx.path.join(dir, "models.json"), "json");
  for (const [providerId, provider] of entriesOf(ctx, at(models, "providers"))) {
    for (const model of listOf(ctx, own(provider, "models"))) addModel(ctx, piModelDraft(model, providerId, own(model, "id")));
    for (const [modelId, override] of entriesOf(ctx, own(provider, "modelOverrides"))) {
      addModel(ctx, piModelDraft(override, providerId, modelId));
    }
  }
  const settings = await loadData(ctx, ctx.path.join(dir, "settings.json"), "json");
  addModel(ctx, { model: own(settings, "defaultModel"), provider: own(settings, "defaultProvider") });
  for (const entry of stringsOf(ctx, own(settings, "enabledModels"))) {
    if (/[*?]/.test(entry)) continue;
    addModel(ctx, splitRoute(entry));
  }
};

const readOpenCode: Reader = async (ctx) => {
  const { path } = ctx;
  const configHome = envPath(ctx, "XDG_CONFIG_HOME") ?? path.join(ctx.input.homeDir, ".config");
  const pair = (dir: string): string[] => [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
  const configFile = envPath(ctx, "OPENCODE_CONFIG");
  const configDir = envPath(ctx, "OPENCODE_CONFIG_DIR");
  const files = [
    ...(configFile !== undefined ? [configFile] : []),
    ...(configDir !== undefined ? pair(configDir) : []),
    ...pair(path.join(configHome, "opencode")),
  ];
  for (const file of files) {
    const data = await loadData(ctx, file, "json");
    // V2 uses `providers`, V1 uses `provider`; both map provider -> models keyed by model id.
    for (const section of ["providers", "provider"]) {
      for (const [providerId, provider] of entriesOf(ctx, own(data, section))) {
        for (const [modelId, model] of entriesOf(ctx, own(provider, "models"))) {
          addModel(ctx, {
            model: modelId, provider: providerId, displayName: own(model, "name"),
            context: at(model, "limit", "context"), reasoning: own(model, "reasoning"),
          });
        }
      }
    }
    const route = own(data, "model");
    if (typeof route === "string") addModel(ctx, splitRoute(route));
  }
};

/** Effective Codex settings: later sources (profile table, profile file) override earlier ones field by field. */
const CODEX_FIELDS = ["model", "model_provider", "model_reasoning_effort", "model_context_window"] as const;

const readCodex: Reader = async (ctx) => {
  const { path } = ctx;
  const home = envPath(ctx, "CODEX_HOME") ?? path.join(ctx.input.homeDir, ".codex");
  const profileName = ctx.input.harness.profile;
  const profile = validProfile(profileName);
  if (profileName !== undefined && profile === undefined) rejectedProfile(ctx);

  const documents = [await loadData(ctx, path.join(home, "config.toml"), "toml")];
  if (profile !== undefined) documents.push(await loadData(ctx, path.join(home, `${profile}.config.toml`), "toml"));
  const effective: Partial<Record<(typeof CODEX_FIELDS)[number], unknown>> = {};
  for (const document of documents) {
    const layers = [document, ...(profile !== undefined ? [at(document, "profiles", profile)] : [])];
    for (const layer of layers) {
      for (const field of CODEX_FIELDS) {
        const value = own(layer, field);
        if (value !== undefined) effective[field] = value;
      }
    }
  }
  addModel(ctx, {
    model: effective.model, provider: effective.model_provider, context: effective.model_context_window,
    ...singleEffort(effective.model_reasoning_effort),
  });

  const cache = await loadData(ctx, path.join(home, "models_cache.json"), "json");
  for (const model of listOf(ctx, Array.isArray(cache) ? cache : own(cache, "models"))) {
    const levels = own(model, "supported_reasoning_levels") ?? own(model, "supported_reasoning_efforts");
    const efforts = effortList(levels);
    addModel(ctx, {
      model: own(model, "slug"), displayName: own(model, "display_name"), context: own(model, "context_window"),
      ...(efforts.length > 0 ? { efforts, reasoning: true } : {}), origin: "cache",
    });
  }
};

/** DSH patch entries: a list, or an object holding the list under `patches` / `patch`. Disabled entries are inactive. */
function dshPatchEntries(data: unknown): unknown[] {
  const container = Array.isArray(data) ? data : own(data, "patches") ?? own(data, "patch");
  return Array.isArray(container) ? container.slice(0, MAX_PATCH_ENTRIES) : [];
}

const readDsh: Reader = async (ctx) => {
  const { path, input } = ctx;
  const dir = envPath(ctx, "DSH_HOME") ?? path.join(input.homeDir, ".dsh");
  const profile = validProfile(input.harness.profile ?? DEFAULT_DSH_PROFILE);
  const files = [path.join(dir, "cordis.patch.yml")];
  if (profile !== undefined) files.push(path.join(dir, "profiles", profile, "cordis.patch.yml"));
  else rejectedProfile(ctx);

  for (const file of files) {
    for (const entry of dshPatchEntries(await loadData(ctx, file, "yaml"))) {
      if (own(entry, "disabled") === true) continue;
      const id = own(entry, "id");
      const config = own(entry, "config");
      if (id === "agent-default-model") {
        addModel(ctx, {
          model: own(config, "model"),
          provider: own(config, "provider") ?? input.harness.default_upstream_provider ?? DEFAULT_DSH_UPSTREAM_PROVIDER,
          ...singleEffort(own(config, "reasoningEffort")),
        });
      } else if (id === "llm-pi-ai") {
        for (const [providerId, provider] of entriesOf(ctx, at(config, "providers"))) {
          for (const model of listOf(ctx, own(provider, "models"))) {
            const efforts = effortList(own(model, "reasoningEfforts"));
            addModel(ctx, {
              model: own(model, "id"), provider: providerId, displayName: own(model, "name"), context: own(model, "contextWindow"),
              ...(efforts.length > 0 ? { efforts, reasoning: true } : {}),
            });
          }
        }
      }
    }
  }
};

const readClaude: Reader = async (ctx) => {
  const dir = envPath(ctx, "CLAUDE_CONFIG_DIR") ?? ctx.path.join(ctx.input.homeDir, ".claude");
  // Only these keys are read; the `env` block is never touched.
  const settings = await loadData(ctx, ctx.path.join(dir, "settings.json"), "json");
  addModel(ctx, { model: own(settings, "model") });
  for (const model of stringsOf(ctx, own(settings, "availableModels"))) addModel(ctx, { model });
  for (const [from, to] of entriesOf(ctx, own(settings, "modelOverrides"))) {
    addModel(ctx, { model: from });
    addModel(ctx, { model: to });
  }
  for (const option of listOf(ctx, at(settings, "modelPicker", "options"))) {
    addModel(ctx, { model: own(option, "model"), displayName: own(option, "label") });
  }
};

const readGemini: Reader = async (ctx) => {
  const base = envPath(ctx, "GEMINI_CLI_HOME") ?? ctx.input.homeDir;
  const settings = await loadData(ctx, ctx.path.join(base, ".gemini", "settings.json"), "json");
  addModel(ctx, { model: at(settings, "model", "name") });
  for (const section of ["customAliases", "modelDefinitions"]) {
    for (const [name] of entriesOf(ctx, at(settings, "modelConfigs", section))) addModel(ctx, { model: name });
  }
};

const readAntigravity: Reader = async (ctx) => {
  const base = envPath(ctx, "GEMINI_HOME") ?? ctx.path.join(ctx.input.homeDir, ".gemini");
  const settings = await loadData(ctx, ctx.path.join(base, "antigravity-cli", "settings.json"), "json");
  addModel(ctx, { model: own(settings, "model"), provider: own(settings, "modelProvider") });
  for (const custom of listOf(ctx, at(settings, "customModelsConfig", "customModels"))) {
    addModel(ctx, { model: own(custom, "modelName"), displayName: own(custom, "label") });
  }
};

const readGrok: Reader = async (ctx) => {
  const dir = envPath(ctx, "GROK_HOME") ?? ctx.path.join(ctx.input.homeDir, ".grok");
  const config = await loadData(ctx, ctx.path.join(dir, "config.toml"), "toml");
  addModel(ctx, { model: at(config, "models", "default") });
  for (const model of stringsOf(ctx, at(config, "models", "allowed_models"))) addModel(ctx, { model });
  for (const [id, entry] of entriesOf(ctx, own(config, "model"))) {
    addModel(ctx, {
      model: id, displayName: own(entry, "name"), context: own(entry, "context_window"), reasoning: own(entry, "supports_reasoning_effort"),
    });
  }
};

const FX_CONTEXT_KEYS = ["context_window", "contextWindow", "context_length", "contextLength", "max_context_tokens"] as const;
const FX_REASONING_KEYS = ["reasoning", "supports_reasoning", "supportsReasoning"] as const;

const readFx: Reader = async (ctx) => {
  const dir = envPath(ctx, "FX_HOME") ?? ctx.path.join(ctx.input.homeDir, ".fx");
  const settings = await loadData(ctx, ctx.path.join(dir, "settings.json"), "json");
  for (const [providerId, models] of entriesOf(ctx, own(settings, "models"))) {
    const names = typeof models === "string" ? [models] : stringsOf(ctx, models);
    for (const model of names) addModel(ctx, { model, provider: providerId });
  }
  for (const [providerId, provider] of entriesOf(ctx, own(settings, "providers"))) {
    for (const [modelId, metadata] of entriesOf(ctx, own(provider, "model_metadata"))) {
      addModel(ctx, {
        model: modelId, provider: providerId, context: firstContext(metadata, FX_CONTEXT_KEYS), reasoning: firstBoolean(metadata, FX_REASONING_KEYS),
      });
    }
  }
};

const readCopilot: Reader = async (ctx) => {
  const { path } = ctx;
  const home = envPath(ctx, "COPILOT_HOME") ?? path.join(ctx.input.homeDir, ".copilot");
  const file = envPath(ctx, "COPILOT_PROVIDERS_CONFIG") ?? path.join(home, "providers.json");
  const config = await loadData(ctx, file, "json");
  // Strict allowlist: output is built field by field; provider objects are never spread or copied.
  for (const provider of listOf(ctx, own(config, "providers"))) {
    const providerName = own(provider, "name");
    for (const model of listOf(ctx, own(provider, "models"))) {
      const effort = own(model, "reasoning_effort");
      const listed = effortList(effort);
      const effortFacts: Pick<Draft, "efforts" | "reasoning"> = Array.isArray(effort)
        ? { efforts: listed, reasoning: listed.length > 0 ? true : undefined }
        : typeof effort === "boolean" ? { reasoning: effort } : singleEffort(effort);
      addModel(ctx, {
        model: own(model, "id"), provider: own(model, "provider") ?? providerName, displayName: own(model, "name"),
        context: own(model, "maxContextWindowTokens"), ...effortFacts,
      });
    }
  }
};

const readDroid: Reader = async (ctx) => {
  const settings = await loadData(ctx, ctx.path.join(ctx.input.homeDir, ".factory", "settings.json"), "json");
  for (const custom of listOf(ctx, own(settings, "customModels"))) {
    const effort = singleEffort(own(custom, "reasoningEffort"));
    const thinking = own(custom, "enableThinking");
    addModel(ctx, {
      model: own(custom, "model") ?? own(custom, "id"), provider: own(custom, "provider"), displayName: own(custom, "displayName"),
      context: own(custom, "maxContextLimit"), ...effort, reasoning: typeof thinking === "boolean" ? thinking || effort.reasoning === true : effort.reasoning,
    });
  }
};

const readQwen: Reader = async (ctx) => {
  const dir = envPath(ctx, "QWEN_HOME") ?? ctx.path.join(ctx.input.homeDir, ".qwen");
  const settings = await loadData(ctx, ctx.path.join(dir, "settings.json"), "json");
  addModel(ctx, { model: at(settings, "model", "name") });
  // `envKey`, `baseUrl` and `apiKey` of these entries are never read.
  for (const [authType, models] of entriesOf(ctx, own(settings, "modelProviders"))) {
    for (const model of listOf(ctx, models)) {
      addModel(ctx, {
        model: own(model, "id"), provider: authType, displayName: own(model, "name"),
        context: at(model, "generationConfig", "contextWindowSize"),
      });
    }
  }
};

const readKimi: Reader = async (ctx) => {
  const { path, input } = ctx;
  // The same file can be named twice (an env variable that points at the default directory): it is read once, and its
  // second mention must not look like a failed read that ends the search before the later candidates.
  const candidates = [...new Set([
    envPath(ctx, "KIMI_CODE_HOME"), path.join(input.homeDir, ".kimi-code"), envPath(ctx, "KIMI_SHARE_DIR"), path.join(input.homeDir, ".kimi"),
  ].filter((dir): dir is string => dir !== undefined).map((dir) => path.join(dir, "config.toml")))];
  let config: unknown;
  for (const file of candidates) {
    const result = await load(ctx, file, "toml");
    if (result.kind === "missing") continue;
    if (result.kind === "ok") config = result.data;
    break;
  }
  const aliases = new Set<string>();
  // Provider tables (which hold keys) are never read: only the model entries are.
  for (const [alias, entry] of entriesOf(ctx, own(config, "models"))) {
    aliases.add(alias);
    addModel(ctx, {
      model: own(entry, "model") ?? alias, provider: own(entry, "provider"), displayName: own(entry, "display_name"),
      context: own(entry, "max_context_size"),
    });
  }
  const defaultModel = own(config, "default_model");
  if (typeof defaultModel === "string" && !aliases.has(defaultModel)) addModel(ctx, { model: defaultModel });
};

const readVibe: Reader = async (ctx) => {
  const dir = envPath(ctx, "VIBE_HOME") ?? ctx.path.join(ctx.input.homeDir, ".vibe");
  const config = await loadData(ctx, ctx.path.join(dir, "config.toml"), "toml");
  addModel(ctx, { model: own(config, "active_model") });
  for (const model of stringsOf(ctx, own(config, "allowed_models"))) addModel(ctx, { model });
  for (const entry of listOf(ctx, own(config, "models"))) {
    const efforts = effortList(own(entry, "thinking_levels"));
    const thinking = own(entry, "thinking");
    const reasoning = typeof thinking === "boolean" ? thinking : typeof thinking === "string" ? !DISABLED_EFFORTS.has(thinking.toLowerCase()) : undefined;
    addModel(ctx, {
      model: own(entry, "alias") ?? own(entry, "name"), provider: own(entry, "provider"), displayName: own(entry, "display_name"),
      context: own(entry, "max_context_length"), efforts, reasoning: efforts.length > 0 ? true : reasoning,
    });
  }
};

/** Probe-only drivers: no local source exists, so the observation stays empty and silent. */
const readNothing: Reader = async () => undefined;

const READERS: Record<DriverKind, Reader> = {
  claude: readClaude, codex: readCodex, dsh: readDsh, pi: readPi, antigravity: readAntigravity, opencode: readOpenCode,
  gemini: readGemini, cursor: readNothing, grok: readGrok, kiro: readNothing, fx: readFx, muse: readNothing,
  copilot: readCopilot, droid: readDroid, qwen: readQwen, kimi: readKimi, vibe: readVibe,
};

// ---------------------------------------------------------------------------
// Static inspection of extra_args (no files, no processes)
// ---------------------------------------------------------------------------

/** Literal `--model X`, `--model=X` and `-m X` tokens. A value that starts with `-` is another flag and is ignored. */
function modelsFromExtraArgs(args: readonly string[] | undefined): string[] {
  const found: string[] = [];
  const list = (args ?? []).slice(0, MAX_MODELS_PER_SOURCE);
  const accept = (value: string | undefined): void => {
    if (value !== undefined && value !== "" && !value.startsWith("-")) found.push(value);
  };
  list.forEach((token, index) => {
    if (token === "--model" || token === "-m") accept(list[index + 1]);
    else if (token.startsWith("--model=")) accept(token.slice("--model=".length));
  });
  return found;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function addExtraArgModels(ctx: Context): void {
  for (const model of modelsFromExtraArgs(ctx.input.harness.extra_args)) addModel(ctx, { model });
}

async function collect(ctx: Context): Promise<void> {
  const { discovery } = ctx.input;
  if (discovery === "manual") {
    // A custom wrapper never inherits the stock CLI's files: only literal model flags in its own arguments count.
    addExtraArgModels(ctx);
    if (ctx.models.size === 0) {
      ctx.diagnostics.push({ stage: "offline", code: "manual_only", message: "Custom wrapper: models are declared manually." });
    }
    return;
  }
  if (discovery === "wrapper") {
    addExtraArgModels(ctx);
    ctx.diagnostics.push({
      stage: "offline", code: "scope_unknown", message: "Wrapper config scope is unknown: local CLI files were not read.",
    });
    return;
  }
  await READERS[ctx.input.driver](ctx);
  addExtraArgModels(ctx);
}

/**
 * Reads the CLI's own local config/cache files for model facts. Never throws: failures become `offline` diagnostics, and a
 * passed deadline or aborted signal stops further reads and reports `truncated: true` with what was gathered so far.
 */
export async function readLocalModels(input: LocalReadInput): Promise<DiscoveryObservation> {
  const hinting = input.hintMode === true;
  const ctx: Context = {
    input, path: pathModule(input.platform), models: new Map(), diagnostics: [], readPaths: new Set(), truncated: false,
    maxFileBytes: hinting ? HINT_MAX_CONFIG_BYTES : MAX_CONFIG_BYTES,
    maxFiles: hinting ? HINT_MAX_FILES_PER_READ : MAX_FILES_PER_READ,
    filesRead: 0, modelsOffered: 0,
  };
  try {
    await collect(ctx);
  } catch {
    ctx.diagnostics.push({ stage: "offline", code: "source_unreadable", message: "Unexpected error while reading local sources." });
  }
  if (ctx.stopped) {
    ctx.diagnostics.push({
      stage: "offline", code: ctx.stopped === "cancelled" ? "cancelled" : "timeout",
      message: ctx.stopped === "cancelled" ? "Local reading was cancelled." : "Local reading hit its deadline.",
    });
  }
  return { models: [...ctx.models.values()], diagnostics: ctx.diagnostics, truncated: ctx.truncated };
}
