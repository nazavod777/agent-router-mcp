/**
 * Layer 2 of model discovery (NEW in Wave 2): on-demand CLI listing probes.
 *
 * A probe runs one verified, read-only listing command of a built-in CLI without a shell, with a minimal environment,
 * closed stdin, bounded output, and a hard deadline, then parses the text/JSON into `DiscoveredModel` rows. It never
 * reads credentials, never appends `harness.extra_args`, and never throws: every failure is a probe diagnostic.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Readable } from "node:stream";
import { isObject, resolveBinary, tryParseJson, unwrapLauncher, type LaunchCommand } from "../adapters/probe-utils.js";
import { getUserConfigPath } from "../config/paths.js";
import type { DriverKind } from "../drivers.js";
import { logger, redactSecrets } from "../logging.js";
import { terminateProcessTree } from "../runtime/process-tree.js";
import { createDiscoveryScrubber, stripHiddenCharacters } from "./sanitize.js";
import {
  DISCOVERY_STDERR_LIMIT_BYTES,
  DISCOVERY_STDOUT_LIMIT_BYTES,
  MAX_MODELS_PER_SOURCE,
  type CliProbeInput,
  type DiscoveredModel,
  type DiscoveryDiagnostic,
  type DiscoveryDiagnosticCode,
  type DiscoveryObservation,
  type ExecProbe,
  type ProbeRunRequest,
  type ProbeRunResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// Probe environment
// ---------------------------------------------------------------------------

/** Names (compared case-insensitively, as Windows does) that every probe may inherit. */
const COMMON_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "USERPROFILE", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP",
  "TMP", "PATHEXT", "NO_COLOR", "CI",
]);
/**
 * Exact (case-sensitive) names every probe may inherit: the four XDG base directories and the standard locale variables.
 * There is deliberately no `XDG_*` or `LC_*` wildcard: `XDG_ACTIVATION_TOKEN`, `XDG_SESSION_COOKIE`, and the like are secrets.
 */
const COMMON_EXACT_ENV_NAMES: ReadonlySet<string> = new Set([
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "LANG", "LC_ALL", "LC_CTYPE",
]);

const COMMON_EXACT_ENV_NAMES_UPPER: ReadonlySet<string> = new Set([...COMMON_EXACT_ENV_NAMES].map((name) => name.toUpperCase()));

/** Home/config directory variables that move the CLI's own state; only the probed driver's are passed on. */
const DRIVER_ENV_NAMES: Partial<Record<DriverKind, readonly string[]>> = {
  pi: ["PI_CODING_AGENT_DIR"],
  opencode: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"],
  codex: ["CODEX_HOME"],
  gemini: ["GEMINI_CLI_HOME"],
  antigravity: ["GEMINI_HOME"],
  dsh: ["DSH_HOME"],
  grok: ["GROK_HOME"],
  fx: ["FX_HOME"],
  kiro: ["KIRO_HOME"],
  claude: ["CLAUDE_CONFIG_DIR"],
  copilot: ["COPILOT_HOME"],
  qwen: ["QWEN_HOME"],
  kimi: ["KIMI_CODE_HOME", "KIMI_SHARE_DIR"],
  vibe: ["VIBE_HOME"],
};

/** Value of an environment variable; on Windows the name matches regardless of case (`Path` is `PATH`). */
function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (Object.hasOwn(env, name)) return env[name];
  if (!windows) return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * The only environment a listing probe sees: an allowlist, never a copy of the parent environment. API keys, tokens,
 * `NODE_OPTIONS`, `LD_*`, `DYLD_*`, and proxy variables are therefore dropped. The `ORCH_JOB_ID` marker is added by the
 * runner, not here. On Windows every allowlisted name matches regardless of case (`Path`, `SystemRoot`, `Codex_Home`)
 * and a name present in several spellings is kept once, so the child never sees duplicate differently-cased variables.
 */
export function buildProbeEnv(source: NodeJS.ProcessEnv, driver: DriverKind, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const windows = platform === "win32";
  const driverNames = new Set((DRIVER_ENV_NAMES[driver] ?? []).map((name) => (windows ? name.toUpperCase() : name)));
  const env: NodeJS.ProcessEnv = {};
  const keptWindowsNames = new Set<string>();
  // Windows keeps one spelling of a name; like `getEnvValue`, the exact canonical spelling (`PATH`) wins over `Path`.
  const canonicalNames = new Set<string>([...COMMON_ENV_NAMES, ...COMMON_EXACT_ENV_NAMES, ...(DRIVER_ENV_NAMES[driver] ?? [])]);
  const entries = Object.entries(source);
  const ordered = windows ? [...entries.filter(([name]) => canonicalNames.has(name)), ...entries.filter(([name]) => !canonicalNames.has(name))] : entries;
  for (const [name, value] of ordered) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const folded = windows ? upper : name;
    const allowed = COMMON_ENV_NAMES.has(upper)
      || (windows ? COMMON_EXACT_ENV_NAMES_UPPER.has(upper) : COMMON_EXACT_ENV_NAMES.has(name))
      || driverNames.has(folded);
    if (!allowed || (windows && keptWindowsNames.has(upper))) continue;
    keptWindowsNames.add(upper);
    env[name] = value;
  }
  if (windows) {
    for (const name of Object.keys(env)) if (name.toUpperCase() === "NO_COLOR") delete env[name];
  }
  env.NO_COLOR = "1";
  return env;
}

// ---------------------------------------------------------------------------
// Bounded process runner
// ---------------------------------------------------------------------------

/** After the main process exited, how long its output pipes may stay open (a grandchild holding them) before the tree is reaped. */
const PIPE_CLOSE_GRACE_MS = 250;
/** Termination is immediate: no graceful window, then a forced kill of the whole tree. */
const PROBE_TERMINATE_GRACE_MS = 0;
const INCOMPLETE_TRAILING_TOKEN = /\S+$/;

/** Keeps at most `limitBytes` of a stream and remembers whether more arrived. */
class BoundedStream {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  clipped = false;

  constructor(private readonly limitBytes: number) {}

  /** Returns true when this chunk did not fit entirely. */
  push(chunk: Buffer): boolean {
    const room = Math.max(0, this.limitBytes - this.bytes);
    if (chunk.length <= room) {
      this.chunks.push(chunk);
      this.bytes += chunk.length;
      return false;
    }
    this.clipped = true;
    if (room > 0) this.chunks.push(chunk.subarray(0, room));
    this.bytes += room;
    return true;
  }

  /** Clipped output loses its incomplete last token: a cut can split a word, a multi-byte character, or a secret. */
  text(): string {
    const text = Buffer.concat(this.chunks, this.bytes).toString("utf8");
    return this.clipped ? text.replace(INCOMPLETE_TRAILING_TOKEN, "") : text;
  }
}

type StopReason = "timedOut" | "cancelled" | "outputLimitExceeded";
type ProbeChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Real probe runner. Spawns without a shell and with stdin ignored. On every way out (clean exit, closed pipes, error,
 * overflow, timeout, abort) the whole process tree (found through the `ORCH_JOB_ID` marker as well as the process group) is
 * terminated, and the pipes are destroyed before the result is returned, so nothing is left running. A clean exit is no
 * exception: a grandchild that detached into its own session and closed its pipes is invisible to the process group and is
 * found only through the marker. Never rejects.
 */
export const defaultExecProbe: ExecProbe = (request: ProbeRunRequest): Promise<ProbeRunResult> =>
  new Promise<ProbeRunResult>((resolvePromise) => {
    const stdout = new BoundedStream(request.stdoutLimitBytes);
    const stderr = new BoundedStream(request.stderrLimitBytes);
    const flags = { timedOut: false, cancelled: false, outputLimitExceeded: false };
    const jobId = `probe-${randomUUID()}`;
    let child: ProbeChild | undefined;
    let exitCode: number | null = null;
    let settled = false;
    let stopping = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;

    const onAbort = () => stop("cancelled");
    const finish = (extra: Partial<ProbeRunResult> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeGraceTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode, stdout: stdout.text(), stderr: stderr.text(), ...flags, ...extra });
    };

    /** Ends the tree, closes the pipes (a stray grandchild cannot hold them open any more), then reports. */
    const terminateAndFinish = (extra: Partial<ProbeRunResult> = {}) => {
      stopping = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeGraceTimer);
      void terminateTree().then(() => {
        child?.stdout.destroy();
        child?.stderr.destroy();
        finish(extra);
      });
    };
    const terminateTree = async (): Promise<void> => {
      const pid = child?.pid;
      if (pid === undefined) return;
      try {
        await terminateProcessTree({ pid, jobId, graceMs: PROBE_TERMINATE_GRACE_MS, verifyDescendants: false });
      } catch (error) {
        logger.warn("Could not terminate the process tree of a discovery probe.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    function stop(reason: StopReason): void {
      if (settled || stopping) return;
      flags[reason] = true;
      exitCode = null;
      terminateAndFinish();
    }

    if (request.signal?.aborted) {
      flags.cancelled = true;
      finish();
      return;
    }
    try {
      child = spawn(request.command, [...request.args], {
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        // Grandchildren inherit this marker, which lets the process-tree reaper find them.
        env: { ...request.env, ORCH_JOB_ID: jobId },
        cwd: request.cwd,
      });
    } catch {
      finish({ spawnFailed: true });
      return;
    }

    const onData = (target: BoundedStream) => (chunk: Buffer) => {
      if (stopping || settled) return;
      if (target.push(chunk)) stop("outputLimitExceeded");
    };
    child.stdout.on("data", onData(stdout));
    child.stderr.on("data", onData(stderr));
    child.once("error", () => {
      // Spawn failure (ENOENT, EACCES, ...), or a process that cannot be managed any more.
      if (settled || stopping) return;
      exitCode = null;
      terminateAndFinish({ spawnFailed: true });
    });
    child.once("exit", (code) => {
      if (settled || stopping) return;
      exitCode = code;
      // Normally `close` follows at once; a grandchild holding the pipes must not stall the probe.
      closeGraceTimer = setTimeout(() => terminateAndFinish(), PIPE_CLOSE_GRACE_MS);
    });
    child.once("close", (code) => {
      if (settled || stopping) return;
      exitCode = code;
      terminateAndFinish();
    });
    request.signal?.addEventListener("abort", onAbort, { once: true });
    // A zero or negative timeout means "no timeout".
    if (request.timeoutMs > 0) timeoutTimer = setTimeout(() => stop("timedOut"), request.timeoutMs);
  });

// ---------------------------------------------------------------------------
// Output parsing helpers
// ---------------------------------------------------------------------------

const MAX_MODEL_ID_CHARS = 200;
const MAX_DISPLAY_NAME_CHARS = 120;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]*$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Enough to detect that a source overflowed MAX_MODELS_PER_SOURCE without keeping an unbounded list. */
const MODEL_COLLECTION_LIMIT = MAX_MODELS_PER_SOURCE + 1;

const OSC_SEQUENCE = /\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?/g;
const CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const CHARSET_SEQUENCE = /\u001b[()][A-Za-z0-9]/g;
const SHORT_ESCAPE_SEQUENCE = /\u001b[@-Z\\-_]/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** Bullet or number that starts a list item (`*`, `-`, a dot, `1.`, `2)`). */
const LIST_MARKER = /^(?:[*•·●▪-]|\d{1,4}[.)])\s+/;
const ID_LIKE_FRAGMENT = /[\d-]/;

/** Removes ANSI escape sequences (CSI and OSC) and control characters; `\r` redraws become line breaks. */
export function stripTerminalControls(text: string): string {
  return text
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(CHARSET_SEQUENCE, "")
    .replace(SHORT_ESCAPE_SEQUENCE, "")
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARACTERS, "");
}

/** Trimmed lines of cleaned output; blank lines are dropped only when `keepBlank` is false. */
function cleanLines(stdout: string, keepBlank = false): string[] {
  const lines = stripTerminalControls(stdout).split("\n").map((line) => line.trim());
  return keepBlank ? lines : lines.filter((line) => line.length > 0);
}

/** A model id is a bounded token; a trailing `.` or `:` marks prose such as `Loading...` or `Models:`. */
function isValidModelId(id: string): boolean {
  return id.length > 0 && id.length <= MAX_MODEL_ID_CHARS && MODEL_ID_PATTERN.test(id) && !/[.:]$/.test(id);
}

function cleanDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = stripHiddenCharacters(stripTerminalControls(value)).replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= MAX_DISPLAY_NAME_CHARS ? name : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

type ModelFields = Omit<DiscoveredModel, "availability" | "evidence">;

/** De-duplicates by (provider, model), drops undefined fields, and bounds the list. */
class ModelCollector {
  private readonly seen = new Set<string>();
  private readonly scrub = createDiscoveryScrubber();
  readonly models: DiscoveredModel[] = [];

  add(raw: ModelFields): void {
    if (this.models.length >= MODEL_COLLECTION_LIMIT) return;
    // Every string from the CLI is scrubbed. A display name just loses the secret part; an id or provider that contains a
    // secret shape is dropped whole, because a half-masked route (`acme/[REDACTED]`) is not something to import.
    const cliModel = this.scrub(raw.cli_model);
    const cliProvider = raw.cli_provider === undefined ? undefined : this.scrub(raw.cli_provider);
    if (cliModel !== raw.cli_model || cliProvider !== raw.cli_provider) return;
    const fields: ModelFields = {
      ...raw,
      ...(raw.display_name !== undefined ? { display_name: this.scrub(raw.display_name) } : {}),
    };
    if (!isValidModelId(fields.cli_model)) return;
    const key = `${fields.cli_provider ?? ""}\u0000${fields.cli_model}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    this.models.push({ ...(defined as ModelFields), availability: "reported_available", evidence: "cli_listing" });
  }
}

/**
 * The model id of a list line: an optional bullet, the id, then nothing, a parenthesized marker (`(default)`), or a
 * description after two or more spaces or a dash. Plain prose (`Available models`) is rejected.
 */
function extractListedId(line: string): { id: string; rest: string } | undefined {
  const body = line.replace(LIST_MARKER, "");
  const match = /^(\S+)(.*)$/.exec(body);
  if (!match || !isValidModelId(match[1])) return undefined;
  const [, id, rest] = match;
  if (rest.trim() === "" || /^\s+\([^)]*\)/.test(rest) || /^\s{2,}\S/.test(rest)) return { id, rest };
  if (/^\s+[-–—]\s+\S/.test(rest) && ID_LIKE_FRAGMENT.test(id)) return { id, rest };
  return undefined;
}

/** `K`/`M` forms are rounded by the CLI; a plain integer is exact. */
function parseTokenCount(token: string): { tokens: number; precision: "exact" | "rounded" } | undefined {
  const match = /^(\d+(?:\.\d+)?)([KkMm])?$/.exec(token);
  if (!match) return undefined;
  const [, amount, unit] = match;
  if (!unit) {
    return /^\d+$/.test(amount) && positiveInteger(Number(amount)) ? { tokens: Number(amount), precision: "exact" } : undefined;
  }
  const tokens = positiveInteger(Math.round(Number(amount) * (unit.toLowerCase() === "m" ? 1_000_000 : 1_000)));
  return tokens ? { tokens, precision: "rounded" } : undefined;
}

/** The array of rows of a JSON listing: the value itself, or the first present of the given wrapper keys. */
function jsonRows(value: unknown, wrapperKeys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of wrapperKeys) {
    const rows = value[key];
    if (Array.isArray(rows)) return rows;
  }
  return [];
}

function firstString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parsers (pure; exported for tests)
// ---------------------------------------------------------------------------

interface PiColumns { provider: number; model: number; context: number; thinking: number }
const PI_POSITIONAL_COLUMNS: PiColumns = { provider: 0, model: 1, context: 2, thinking: 4 };
const PI_POSITIONAL_MIN_TOKENS = 5;
const PI_HEADER_MAX_COLUMNS = 8;

function piHeaderColumns(line: string): PiColumns | undefined {
  const names = line.toLowerCase().split(/\s+/);
  const provider = names.indexOf("provider");
  const model = names.indexOf("model");
  const context = names.indexOf("context");
  const thinking = names.indexOf("thinking");
  // A header names the table columns; a prose line that merely mentions "model" and "provider" is not one.
  if (provider < 0 || model < 0 || (context < 0 && thinking < 0) || names.length > PI_HEADER_MAX_COLUMNS) return undefined;
  return { provider, model, context, thinking };
}

/** `pi --list-models`: a table headed `provider model context max-out thinking images`. */
export function parsePiOutput(stdout: string): DiscoveredModel[] {
  const lines = cleanLines(stdout);
  const headerIndex = lines.findIndex((line) => piHeaderColumns(line) !== undefined);
  const columns = headerIndex >= 0 ? piHeaderColumns(lines[headerIndex]) ?? PI_POSITIONAL_COLUMNS : PI_POSITIONAL_COLUMNS;
  const positional = headerIndex < 0;
  const collector = new ModelCollector();
  for (const line of lines.slice(headerIndex + 1)) {
    const tokens = line.split(/\s+/);
    const needed = Math.max(columns.provider, columns.model, columns.context, columns.thinking) + 1;
    if (tokens.length < (positional ? PI_POSITIONAL_MIN_TOKENS : Math.max(2, needed))) continue;
    const provider = tokens[columns.provider];
    const model = tokens[columns.model];
    if (!PROVIDER_ID_PATTERN.test(provider)) continue;
    const context = columns.context >= 0 ? parseTokenCount(tokens[columns.context] ?? "") : undefined;
    // Without a header only a row whose context column is a number is trusted to be a table row and not prose.
    if (positional && !context) continue;
    const thinking = columns.thinking >= 0 ? tokens[columns.thinking]?.toLowerCase() : undefined;
    collector.add({
      cli_model: model,
      cli_provider: provider,
      ...(context ? { context_window: context.tokens, context_precision: context.precision } : {}),
      ...(thinking === "yes" || thinking === "no" ? { reasoning: thinking === "yes" } : {}),
    });
  }
  return collector.models;
}

/** `opencode models`: `<provider>/<model>` lines; the model keeps any further slashes and a `[1m]`-style suffix. */
export function parseOpencodeOutput(stdout: string): DiscoveredModel[] {
  const collector = new ModelCollector();
  for (const line of cleanLines(stdout)) {
    const slash = line.indexOf("/");
    if (slash <= 0 || /\s/.test(line)) continue;
    const provider = line.slice(0, slash);
    if (!PROVIDER_ID_PATTERN.test(provider)) continue;
    collector.add({ cli_model: line.slice(slash + 1), cli_provider: provider });
  }
  return collector.models;
}

function geminiContextWindow(row: Record<string, unknown>): number | undefined {
  const limits = row.contextLimits;
  return isObject(limits) ? positiveInteger(limits.inputTokens) : undefined;
}

/** `gemini models list --output-format json`: an array or `{models: [...]}`; only allowlisted keys are read. */
export function parseGeminiOutput(stdout: string): DiscoveredModel[] {
  const collector = new ModelCollector();
  for (const row of jsonRows(tryParseJson(stripTerminalControls(stdout)), ["models"])) {
    if (typeof row === "string") {
      collector.add({ cli_model: row.trim() });
      continue;
    }
    if (!isObject(row)) continue;
    const modelId = firstString(row, ["modelId", "id"]);
    if (!modelId) continue;
    const contextWindow = geminiContextWindow(row);
    collector.add({
      cli_model: modelId,
      display_name: cleanDisplayName(firstString(row, ["displayName", "name"])),
      ...(contextWindow ? { context_window: contextWindow, context_precision: "exact" as const } : {}),
    });
  }
  return collector.models;
}

/** `agy models`: one id per line; effort suffixes such as `-high` are part of the id and kept exactly as printed. */
export function parseAntigravityOutput(stdout: string): DiscoveredModel[] {
  const collector = new ModelCollector();
  for (const line of cleanLines(stdout)) {
    const listed = extractListedId(line);
    if (listed) collector.add({ cli_model: listed.id });
  }
  return collector.models;
}

/** `fx models --json`: `{ ids: string[], models: [{id|name|model, provider?, contextWindow|context_window?}] }`. */
export function parseFxOutput(stdout: string): DiscoveredModel[] {
  const parsed = tryParseJson(stripTerminalControls(stdout));
  const collector = new ModelCollector();
  for (const row of jsonRows(parsed, ["models"])) {
    if (typeof row === "string") {
      collector.add({ cli_model: row.trim() });
      continue;
    }
    if (!isObject(row)) continue;
    const id = firstString(row, ["id", "name", "model"]);
    if (!id) continue;
    const provider = firstString(row, ["provider"]);
    const contextWindow = positiveInteger(row.contextWindow ?? row.context_window);
    collector.add({
      cli_model: id,
      ...(provider && PROVIDER_ID_PATTERN.test(provider) ? { cli_provider: provider } : {}),
      ...(contextWindow ? { context_window: contextWindow, context_precision: "exact" as const } : {}),
    });
  }
  // Bare ids repeat what `models` already described (with its provider and context window); keep only the new ones.
  const described = new Set(collector.models.map((model) => model.cli_model));
  if (isObject(parsed) && Array.isArray(parsed.ids)) {
    for (const id of parsed.ids) {
      if (typeof id === "string" && !described.has(id.trim())) collector.add({ cli_model: id.trim() });
    }
  }
  return collector.models;
}

const GROK_HEADING = /^available models\b:?$/i;

/** `grok models`: lines under `Available models:`; `*` marks the default, which is not part of the id. */
export function parseGrokOutput(stdout: string): DiscoveredModel[] {
  const collector = new ModelCollector();
  let inList = false;
  let listStarted = false;
  for (const line of cleanLines(stdout, true)) {
    if (!inList) {
      inList = GROK_HEADING.test(line);
      continue;
    }
    if (line === "") {
      if (listStarted) break;
      continue;
    }
    const listed = extractListedId(line);
    if (!listed) {
      if (listStarted || line.endsWith(":")) break;
      continue;
    }
    listStarted = true;
    collector.add({ cli_model: listed.id });
  }
  return collector.models;
}

const CURSOR_LINE = /^(?:[*•-]\s+)?([a-z0-9][^\s]*)(?:\s+\((?:current|default)\))?(?:\s+-\s+(.+))?$/;
const CURSOR_STATE_MARKER = /\s*\((?:current|default)\)\s*$/i;

/** `cursor-agent models`: `auto - Auto`, `gpt-5 - GPT-5 (current)`, `* sonnet-4`; headings and tips are skipped. */
export function parseCursorOutput(stdout: string): DiscoveredModel[] {
  const collector = new ModelCollector();
  for (const line of cleanLines(stdout)) {
    const match = CURSOR_LINE.exec(line);
    if (!match) continue;
    collector.add({ cli_model: match[1], display_name: cleanDisplayName(match[2]?.replace(CURSOR_STATE_MARKER, "")) });
  }
  return collector.models;
}

/** `kiro-cli chat --list-models --format json`: rows of `{model_id|id|name}` or strings; plain id lines as a fallback. */
export function parseKiroOutput(stdout: string): DiscoveredModel[] {
  const cleaned = stripTerminalControls(stdout);
  const parsed = tryParseJson(cleaned);
  const collector = new ModelCollector();
  if (parsed === undefined) {
    for (const line of cleanLines(cleaned)) {
      const listed = extractListedId(line);
      if (listed) collector.add({ cli_model: listed.id });
    }
    return collector.models;
  }
  for (const row of jsonRows(parsed, ["models"])) {
    const id = typeof row === "string" ? row.trim() : isObject(row) ? firstString(row, ["model_id", "id", "name"]) : undefined;
    if (id) collector.add({ cli_model: id });
  }
  return collector.models;
}

/** `muse exec --list-models`: one model id per line. */
export function parseMuseOutput(stdout: string): DiscoveredModel[] {
  const collector = new ModelCollector();
  for (const line of cleanLines(stdout)) collector.add({ cli_model: line });
  return collector.models;
}

// ---------------------------------------------------------------------------
// Probe orchestration
// ---------------------------------------------------------------------------

/** What a CLI's help must show before its listing command is run: a subcommand entry, or an option entry. */
type HelpAdvertisement = { kind: "command" | "option"; name: string };

interface ListingSpec {
  /** Exactly the verified arguments; `harness.extra_args` are never appended. */
  args: readonly string[];
  /**
   * Used instead of `args` when the first attempt fails because the CLI does not know one of its (isolation) flags, which
   * older versions lack. Must keep every isolation flag that `args` carries for extensions and MCP servers.
   */
  fallbackArgs?: readonly string[];
  parse: (stdout: string) => DiscoveredModel[];
  /** Vercel fx shares its name with a JSON viewer, so the binary is identified before the listing runs. */
  identify?: { args: readonly string[]; pattern: RegExp; failureMessage: string };
  /**
   * The listing command exists only on some versions, and on others the same words are read as a prompt (the default command
   * of Gemini, Cursor, Grok, OpenCode, ... is `<cli> [prompt..]`, so a missing `models` subcommand would be a billable
   * prompt). The listing runs only when the help output advertises it in its `Commands:` or `Options:` section; otherwise the
   * probe ends with an informational note and no error.
   */
  requiresAdvertised?: { helpArgs: readonly string[]; advertises: HelpAdvertisement; unsupportedMessage: string };
}

/** Pi loads extensions and MCP servers (which can run code and reach the network) unless told not to; discovery never wants them. */
const PI_ISOLATION_ARGS = ["--no-extensions", "--no-mcp"] as const;
const UNKNOWN_OPTION_PATTERN = /unknown (?:option|flag|argument)|unrecognized (?:option|flag|argument)|unexpected argument|invalid option/i;

/** `Commands:` / `Subcommands:` headings (commander, yargs, clap). */
const COMMAND_SECTION_HEADING = /^(?:sub)?commands:?$/i;
/** `Options:` / `Flags:` headings (commander, yargs, clap, argparse). */
const OPTION_SECTION_HEADING = /^(?:global\s+)?(?:options|flags|optional arguments):?$/i;
const DESCRIPTION_GAP = /\s{2,}/;

const leadingSpaces = (line: string): number => line.length - line.trimStart().length;

/**
 * The entries of every help section whose heading matches. A section is the run of more-indented lines under its heading
 * (blank lines allowed); an entry is a line at the section's own entry indentation, so a wrapped description line, a usage
 * line, and prose elsewhere in the help are never entries. One linear pass, so hostile help text costs no more than reading it.
 */
function helpSectionEntries(help: string, heading: RegExp): string[] {
  const entries: string[] = [];
  let section: { headingIndent: number; entryIndent?: number } | undefined;
  for (const line of help.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    const indent = leadingSpaces(line);
    if (section !== undefined && indent > section.headingIndent) {
      section.entryIndent ??= indent;
      if (indent === section.entryIndent) entries.push(text);
      continue;
    }
    section = heading.test(text) ? { headingIndent: indent } : undefined;
  }
  return entries;
}

/** The names a command entry answers to: `models [options]`, `cli models list`, and `status|whoami` all start with their name. */
function commandEntryNames(entry: string, binaryNames: ReadonlySet<string>): string[] {
  const tokens = entry.split(/\s+/);
  // yargs prints the binary in front of every command (`gemini models list`).
  const first = binaryNames.has(tokens[0].toLowerCase()) ? tokens[1] : tokens[0];
  return (first ?? "").split(/[|,]/).filter((name) => name !== "");
}

/** The options an entry declares: `-m, --model <id>  Pick a model` declares `-m` and `--model`. */
function optionEntryNames(entry: string): string[] {
  return entry.split(DESCRIPTION_GAP)[0].split(/[\s,|]+/).map((token) => token.replace(/=.*$/, "")).filter((name) => name.startsWith("-"));
}

/** True when `help` lists the command or option in the matching section; a mention anywhere else does not count. */
function helpAdvertises(help: string, advertises: HelpAdvertisement, binaryNames: ReadonlySet<string>): boolean {
  const text = stripTerminalControls(help);
  if (advertises.kind === "command") {
    return helpSectionEntries(text, COMMAND_SECTION_HEADING).some((entry) => commandEntryNames(entry, binaryNames).includes(advertises.name));
  }
  return helpSectionEntries(text, OPTION_SECTION_HEADING).some((entry) => optionEntryNames(entry).includes(advertises.name));
}

/** A fixed, scrubbed-by-construction note for a CLI whose help does not list the listing command. */
function notAdvertisedMessage(cli: string, advertises: HelpAdvertisement): string {
  return `The installed ${cli} CLI does not list a "${advertises.name}" ${advertises.kind} in its help, so the model listing was not run; declare models manually.`;
}

const LISTING_SPECS: Partial<Record<DriverKind, ListingSpec>> = {
  pi: {
    args: [...PI_ISOLATION_ARGS, "--no-approve", "--offline", "--list-models"],
    fallbackArgs: [...PI_ISOLATION_ARGS, "--list-models"],
    parse: parsePiOutput,
  },
  opencode: {
    args: ["models"],
    parse: parseOpencodeOutput,
    requiresAdvertised: {
      helpArgs: ["--help"], advertises: { kind: "command", name: "models" },
      unsupportedMessage: notAdvertisedMessage("OpenCode", { kind: "command", name: "models" }),
    },
  },
  gemini: {
    args: ["models", "list", "--output-format", "json"],
    parse: parseGeminiOutput,
    requiresAdvertised: {
      helpArgs: ["--help"], advertises: { kind: "command", name: "models" },
      unsupportedMessage:
        "The installed Gemini CLI does not expose a models subcommand, so it was not run; models come from local settings (~/.gemini/settings.json).",
    },
  },
  antigravity: {
    args: ["models"],
    parse: parseAntigravityOutput,
    requiresAdvertised: {
      helpArgs: ["--help"], advertises: { kind: "command", name: "models" },
      unsupportedMessage: notAdvertisedMessage("Antigravity", { kind: "command", name: "models" }),
    },
  },
  fx: {
    args: ["models", "--json"],
    parse: parseFxOutput,
    identify: {
      args: ["--help"],
      pattern: /\bfx\s+ask\b|\bfx\s+acp\b/i,
      failureMessage: "binary is not Vercel fx",
    },
  },
  grok: {
    args: ["models"],
    parse: parseGrokOutput,
    requiresAdvertised: {
      helpArgs: ["--help"], advertises: { kind: "command", name: "models" },
      unsupportedMessage: notAdvertisedMessage("Grok", { kind: "command", name: "models" }),
    },
  },
  cursor: {
    args: ["models"],
    parse: parseCursorOutput,
    requiresAdvertised: {
      helpArgs: ["--help"], advertises: { kind: "command", name: "models" },
      unsupportedMessage: notAdvertisedMessage("Cursor", { kind: "command", name: "models" }),
    },
  },
  kiro: {
    args: ["chat", "--list-models", "--format", "json"],
    parse: parseKiroOutput,
    requiresAdvertised: {
      helpArgs: ["chat", "--help"], advertises: { kind: "option", name: "--list-models" },
      unsupportedMessage: notAdvertisedMessage("Kiro", { kind: "option", name: "--list-models" }),
    },
  },
  muse: {
    args: ["exec", "--list-models"],
    parse: parseMuseOutput,
    requiresAdvertised: {
      helpArgs: ["exec", "--help"], advertises: { kind: "option", name: "--list-models" },
      unsupportedMessage: notAdvertisedMessage("Muse", { kind: "option", name: "--list-models" }),
    },
  },
};

const STDERR_TAIL_CHARS = 200;
const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const PROBE_DIR_PREFIX = "orch-discovery-probe-";

function probeDiagnostic(code: DiscoveryDiagnosticCode, message: string): DiscoveryDiagnostic {
  return { stage: "probe", code, message: createDiscoveryScrubber()(message) };
}

function observation(models: DiscoveredModel[], diagnostics: DiscoveryDiagnostic[], truncated = false): DiscoveryObservation {
  return { models, diagnostics, truncated };
}

/** A short single-line stderr excerpt: redacted first and clipped second, ANSI stripped, URLs removed. */
function stderrTail(stderr: string): string {
  const safe = redactSecrets(stripTerminalControls(stderr)).replace(URL_PATTERN, "<url>").replace(/\s+/g, " ").trim();
  return safe.slice(-STDERR_TAIL_CHARS);
}

function failureDiagnostic(driver: DriverKind, command: string, result: ProbeRunResult): DiscoveryDiagnostic | undefined {
  if (result.spawnFailed) return probeDiagnostic("binary_missing", `${driver} binary could not be started`);
  if (result.cancelled) return probeDiagnostic("cancelled", `${command} was cancelled`);
  if (result.timedOut) return probeDiagnostic("timeout", `${command} timed out`);
  if (result.outputLimitExceeded) return probeDiagnostic("output_limit", `${command} output exceeded the size limit`);
  if (result.exitCode !== 0) {
    const tail = stderrTail(result.stderr);
    const exit = result.exitCode === null ? "was terminated by a signal" : `exited with code ${result.exitCode}`;
    return probeDiagnostic("unsupported_version", `${command} ${exit}${tail ? `: ${tail}` : ""}`);
  }
  return undefined;
}

/**
 * What to spawn for the harness binary, or the diagnostic that says why nothing can be spawned. A relative binary path is
 * anchored at the user config directory and never at the caller's working directory, a Windows npm shim is unwrapped to
 * `node <script>`, and an unresolvable binary is never handed to `spawn` as a raw name.
 */
function resolveProbeLaunch(input: CliProbeInput): LaunchCommand | DiscoveryDiagnostic {
  const { driver } = input;
  const windows = input.platform === "win32";
  const binary = resolveBinary(input.harness.binary, {
    platform: input.platform,
    pathEnv: envValue(input.env, "PATH", windows) ?? input.env.Path ?? "",
    pathExt: envValue(input.env, "PATHEXT", windows),
    baseDir: dirname(getUserConfigPath(input.env, input.homeDir)),
  });
  if (binary === undefined) return probeDiagnostic("binary_missing", `${driver} binary was not found`);
  try {
    return unwrapLauncher(binary, input.platform);
  } catch {
    return probeDiagnostic(
      "binary_missing", `${driver} binary is a .cmd/.bat launcher that cannot be started without a shell; point the harness at the CLI's .exe`,
    );
  }
}

const isDiagnostic = (value: LaunchCommand | DiscoveryDiagnostic): value is DiscoveryDiagnostic => "stage" in value;

/** The names a help text may print in front of a command: the harness binary (without extension) and the driver. */
function helpBinaryNames(input: CliProbeInput): ReadonlySet<string> {
  const file = basename(input.harness.binary.trim().replace(/\\/g, "/"));
  return new Set([input.driver, file.slice(0, file.length - extname(file).length), file].map((name) => name.toLowerCase()));
}

async function runListing(input: CliProbeInput, spec: ListingSpec, launch: LaunchCommand, cwd: string): Promise<DiscoveryObservation> {
  const { driver } = input;
  const execProbe = input.execProbe ?? defaultExecProbe;
  const env = buildProbeEnv(input.env, driver, input.platform);
  const run = (args: readonly string[]): Promise<ProbeRunResult> => execProbe({
    command: launch.command,
    args: [...launch.prefixArgs, ...args],
    env,
    cwd,
    timeoutMs: input.probeTimeoutMs,
    stdoutLimitBytes: DISCOVERY_STDOUT_LIMIT_BYTES,
    stderrLimitBytes: DISCOVERY_STDERR_LIMIT_BYTES,
    signal: input.signal,
  });

  if (spec.identify) {
    const help = await run(spec.identify.args);
    const failure = failureDiagnostic(driver, `${driver} ${spec.identify.args.join(" ")}`, { ...help, exitCode: 0 });
    if (failure) return observation([], [failure]);
    if (!spec.identify.pattern.test(`${help.stdout}\n${help.stderr}`)) {
      return observation([], [probeDiagnostic("unsupported_version", spec.identify.failureMessage)]);
    }
  }

  if (spec.requiresAdvertised) {
    const { helpArgs, advertises, unsupportedMessage } = spec.requiresAdvertised;
    const help = await run(helpArgs);
    const failure = failureDiagnostic(driver, `${driver} ${helpArgs.join(" ")}`, help);
    if (failure) return observation([], [failure]);
    // Not advertised: running the listing could start a prompt session, so it is not run and nothing is reported as broken.
    if (!helpAdvertises(`${help.stdout}\n${help.stderr}`, advertises, helpBinaryNames(input))) {
      return observation([], [probeDiagnostic("scope_unknown", unsupportedMessage)]);
    }
  }

  // Some CLIs (Pi) print `Unknown option` yet exit 0 and still list, so the flag is judged by what stderr says, not the exit code.
  const rejectedFlag = (run1: ProbeRunResult): boolean => spec.fallbackArgs !== undefined && !run1.timedOut && !run1.cancelled &&
    !run1.outputLimitExceeded && !run1.spawnFailed && UNKNOWN_OPTION_PATTERN.test(stripTerminalControls(run1.stderr));
  let args = spec.args;
  let result = await run(args);
  if (spec.fallbackArgs && rejectedFlag(result)) {
    args = spec.fallbackArgs;
    result = await run(args);
  }
  const label = `${driver} ${args.join(" ")}`;
  // A listing printed by a CLI that ignored an isolation flag may have loaded extensions or MCP servers: never accepted.
  const failure = rejectedFlag(result)
    ? probeDiagnostic("unsupported_version", `${label} was rejected by the installed ${driver} (${stderrTail(result.stderr)})`)
    : failureDiagnostic(driver, label, result);
  if (failure) return observation([], [failure]);

  const models = spec.parse(result.stdout);
  if (models.length === 0 && result.stdout.trim() !== "") {
    return observation([], [probeDiagnostic("invalid_output", `${label} produced no recognizable models`)]);
  }
  const truncated = models.length > MAX_MODELS_PER_SOURCE;
  return observation(truncated ? models.slice(0, MAX_MODELS_PER_SOURCE) : models, [], truncated);
}

async function removeProbeDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    logger.warn("Could not remove the scratch directory of a discovery probe.", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function runCliProbe(input: CliProbeInput): Promise<DiscoveryObservation> {
  const { driver } = input;
  const spec = LISTING_SPECS[driver];
  if (!spec) {
    return observation([], [probeDiagnostic("scope_unknown", `${driver} has no verified model-listing command`)]);
  }
  if (input.signal?.aborted) return observation([], [probeDiagnostic("cancelled", `${driver} model listing was cancelled`)]);
  const launch = resolveProbeLaunch(input);
  if (isDiagnostic(launch)) return observation([], [launch]);

  // Every command of this harness runs in its own empty directory: repo-local plugin and config directories (`.opencode/`,
  // `.cursor/`, `.kiro/`, `.gemini/`) of the caller's working directory must not be picked up and executed by the CLI.
  const scratch = await mkdtemp(join(tmpdir(), PROBE_DIR_PREFIX));
  try {
    return await runListing(input, spec, launch, scratch);
  } finally {
    await removeProbeDirectory(scratch);
  }
}

/** Runs the verified listing command of `input.driver` and parses it. Never throws; every failure is a diagnostic. */
export async function probeCliModels(input: CliProbeInput): Promise<DiscoveryObservation> {
  try {
    return await runCliProbe(input);
  } catch (error) {
    const reason = stderrTail(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    return observation([], [probeDiagnostic("invalid_output", `${input.driver} probe failed unexpectedly: ${reason}`)]);
  }
}
