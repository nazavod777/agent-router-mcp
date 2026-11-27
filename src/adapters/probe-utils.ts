import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { chmod, open, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { readNpmShimTarget } from "../cli/npm-shim.js";
import { getUserConfigPath } from "../config/paths.js";
import { DRIVER_METADATA } from "../drivers.js";
import type { HarnessConfig } from "../config/schema.js";
import { logger, redactSecrets } from "../logging.js";
import type {
  DriverKind,
  ErrorCode,
  FailureScope,
  HarnessHealth,
  RunMode,
  SecurityGuarantee,
  StructuredError,
  UsageStats,
} from "../types.js";
import type { FinishParseInput, ParsedAdapterResult } from "./types.js";
import { truncateUtf8 } from "../runtime/output.js";
import { terminateProcessTree } from "../runtime/process-tree.js";

/** Maximum bytes kept per probe output stream. */
export const PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_PROBE_TIMEOUT_MS = 4000;
/** Upper bound for text buffered in memory by stream parsers. */
export const PARSER_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
const MESSAGE_LIMIT_CHARS = 2000;
const TARGET_KEYS = ["file_path", "filePath", "path", "pattern"] as const;
const MAX_COMMAND_TARGET_BYTES = 120;
const MAX_VARIANT_FIELDS = 6;
const MAX_VARIANT_KEY_CHARS = 24;
const MAX_VARIANT_ARRAY_ITEMS = 4;
/** A string argument counts as a position only when it is made of numbers and range punctuation, so it can never hold content. */
const NUMERIC_RANGE_PATTERN = /^[\d\s,:.\-]{1,24}$/;
/** Names of arguments that hold a position; a numeric-looking string under any other name (a PIN, an id) is not kept. */
const POSITION_KEY_PATTERN = /^(?:\w*(?:line|offset|limit|range|page)s?|start|end|from|to)$/i;
const MAX_PATH_TARGET_BYTES = 180;
const PRIVATE_FILE_MODE = 0o600;
/** Window for a timed-out probe's output pipes to close after its process tree was terminated. */
const PROBE_CLOSE_WAIT_MS = 500;
/** A timed-out probe is ended at once: no graceful window, then a forced kill of the whole tree. */
const PROBE_TERMINATE_GRACE_MS = 0;
const DEFAULT_PATHEXT = [".exe", ".com", ".cmd", ".bat"];
const MAX_VERSION_NOTE_CHARS = 300;
const INCOMPLETE_TRAILING_TOKEN = /\S+$/;

// ---------------------------------------------------------------------------
// Binary lookup and bounded probes
// ---------------------------------------------------------------------------

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a small user config file for a fail-closed check. A missing file is `undefined` (there is nothing to read); a file
 * that exists but is not a regular file, is larger than `maxBytes` or cannot be read throws, so a caller never mistakes
 * "could not look" for "nothing configured".
 */
export async function readOptionalConfigText(path: string, maxBytes: number): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("it is not a regular file");
    if (info.size > maxBytes) throw new Error(`it is larger than ${maxBytes} bytes`);
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(buffer, 0, info.size, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await file.close();
  }
}

export interface BinaryLookupOptions {
  /** Platform whose lookup rules apply (defaults to the running one); tests use it to exercise Windows rules. */
  platform?: NodeJS.Platform;
  /** PATH value to search (defaults to `process.env.PATH`). */
  pathEnv?: string;
  /** Windows `PATHEXT` value (defaults to `process.env.PATHEXT`, then `.exe;.com;.cmd;.bat`). */
  pathExt?: string;
  /**
   * Absolute directory a relative binary path (`./wrapper`, `bin/tool`) is anchored at. Without it such a path is not
   * resolved at all: the working directory of the process or of a job must never decide which program runs.
   */
  baseDir?: string;
}

/**
 * Windows resolves a bare name through PATHEXT, so `tool` may be `tool.exe`, `tool.cmd`, ... The extension list is tried
 * in order and the extensionless name is never a candidate there: it is an npm POSIX shim (a shell script) that
 * Windows cannot start.
 */
function candidateNames(name: string, windows: boolean, pathExt: string | undefined): string[] {
  if (!windows) return [name];
  const extensions = (pathExt?.split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean) ?? []);
  const known = extensions.length > 0 ? extensions : DEFAULT_PATHEXT;
  const lowerName = name.toLowerCase();
  if (known.some((ext) => lowerName.endsWith(ext))) return [name];
  return known.map((ext) => `${name}${ext}`);
}

/** Lookup options for a harness's configured binary: a relative path is anchored at the user config directory. */
export function harnessLookup(options: BinaryLookupOptions = {}): BinaryLookupOptions {
  return { baseDir: dirname(getUserConfigPath()), ...options };
}

/**
 * Resolves a binary name or path to an absolute executable path, or undefined when not found. Relative PATH entries
 * (`.`, empty, `./bin`) are skipped, so a file inside the working repository can never hijack a command name; a relative
 * binary path is resolved against `options.baseDir` only.
 */
export function resolveBinary(binary: string, options: BinaryLookupOptions = {}): string | undefined {
  const trimmed = binary.trim();
  if (!trimmed) return undefined;
  const windows = (options.platform ?? process.platform) === "win32";
  const flavor = windows ? win32 : posix;
  const pathDelimiter = flavor.delimiter;
  const pathExt = options.pathExt ?? process.env.PATHEXT;
  const hasDirectory = trimmed.includes("/") || (windows && trimmed.includes("\\"));
  if (flavor.isAbsolute(trimmed) || hasDirectory) {
    let base: string;
    if (flavor.isAbsolute(trimmed)) base = resolve(trimmed);
    else if (options.baseDir !== undefined && flavor.isAbsolute(options.baseDir)) base = resolve(options.baseDir, trimmed);
    else return undefined;
    return candidateNames(base, windows, pathExt).find(isExecutableFile);
  }
  for (const dir of (options.pathEnv ?? process.env.PATH ?? "").split(pathDelimiter)) {
    if (!dir || !flavor.isAbsolute(dir)) continue;
    for (const name of candidateNames(trimmed, windows, pathExt)) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** A program plus the arguments that must precede the caller's own, ready for `spawn(..., { shell: false })`. */
export interface LaunchCommand {
  command: string;
  prefixArgs: string[];
}

const WINDOWS_SCRIPT_LAUNCHER = /\.(?:cmd|bat)$/i;
const JAVASCRIPT_ENTRY = /\.(?:c|m)?js$/i;

/**
 * What to spawn for an executable path. A Windows `.cmd`/`.bat` cannot be started without a shell (Node refuses with
 * EINVAL), so an npm launcher shim is replaced by `node <its script>`. A `.cmd`/`.bat` that is not such a shim fails here
 * with an actionable error instead.
 */
export function unwrapLauncher(path: string, platform: NodeJS.Platform = process.platform): LaunchCommand {
  if (platform !== "win32" || !WINDOWS_SCRIPT_LAUNCHER.test(path)) return { command: path, prefixArgs: [] };
  const script = readNpmShimTarget(path);
  if (script === undefined || !JAVASCRIPT_ENTRY.test(script)) {
    throw adapterError("CLI_NOT_FOUND",
      `${path} is a .cmd/.bat launcher that is not a recognizable npm JavaScript shim, so it cannot be started without a shell. ` +
      "Set the harness binary to the CLI's .exe, or to a wrapper that is an .exe.", false);
  }
  return { command: process.execPath, prefixArgs: [script] };
}

/** Resolves a binary and unwraps a Windows npm shim; undefined when the binary is not found. */
export function resolveLaunch(binary: string, options: BinaryLookupOptions = {}): LaunchCommand | undefined {
  const path = resolveBinary(binary, options);
  return path === undefined ? undefined : unwrapLauncher(path, options.platform);
}

/**
 * The launch command of a harness binary for a job. A binary that cannot be resolved is a CLI_NOT_FOUND failure: the raw
 * configured string is never handed to `spawn` (it would be looked up in the job's working directory).
 */
export function requireLaunch(binary: string, options: BinaryLookupOptions = {}): LaunchCommand {
  const launch = resolveLaunch(binary, harnessLookup(options));
  if (!launch) throw adapterError("CLI_NOT_FOUND", `Binary ${JSON.stringify(binary)} was not found on PATH or at the configured path.`, false);
  return launch;
}

export interface ProbeOutput {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Keeps at most `limitBytes` of a stream and remembers whether more arrived. */
class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  overflowed = false;

  constructor(private readonly limitBytes: number) {}

  push(chunk: Buffer): void {
    const room = this.limitBytes - this.bytes;
    if (chunk.length > room) this.overflowed = true;
    if (room <= 0) return;
    this.chunks.push(chunk.subarray(0, room));
    this.bytes += Math.min(chunk.length, room);
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf8");
  }
}

/**
 * Redacts first and clips second, so a cut can never leave a recognizable secret prefix. `clipped` marks output that
 * the byte cap already cut: its incomplete last token may be part of a secret and is dropped.
 */
function redactAndCap(text: string, limitBytes: number, clipped: boolean): string {
  const complete = clipped ? text.replace(INCOMPLETE_TRAILING_TOKEN, "") : text;
  return truncateUtf8(redactSecrets(complete), limitBytes).text;
}

/**
 * Runs a short diagnostic command without a shell. Output is redacted and capped, stdin is closed immediately, and on
 * every way out (clean exit, error, timeout, output overflow) the whole process tree (not only the direct child) is
 * terminated within a bounded wait before the result is returned, so a grandchild that keeps the output pipes open or
 * detaches (setsid) cannot stall the probe or outlive it. A Windows npm `.cmd` shim is started as `node <script>`.
 */
export function execProbe(command: string, args: string[], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeOutput> {
  return new Promise((resolvePromise) => {
    const stdout = new CappedOutput(PROBE_OUTPUT_LIMIT_BYTES);
    const stderr = new CappedOutput(PROBE_OUTPUT_LIMIT_BYTES);
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let closeWaitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (output: Omit<ProbeOutput, "stdout" | "stderr"> & { stderrFallback?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeWaitTimer);
      const { stderrFallback, ...result } = output;
      resolvePromise({
        ...result,
        stdout: redactAndCap(stdout.text(), PROBE_OUTPUT_LIMIT_BYTES, stdout.overflowed),
        stderr: redactAndCap(stderr.text() || stderrFallback || "", PROBE_OUTPUT_LIMIT_BYTES, stderr.overflowed),
      });
    };
    try {
      const launch = unwrapLauncher(command);
      // Grandchildren inherit this marker, which lets the process-tree reaper find them after the probe ended.
      const probeId = `probe-${randomUUID()}`;
      const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", CI: process.env.CI ?? "1", ORCH_JOB_ID: probeId },
      });
      /** Ends the probe's tree; the output pipes are closed afterwards so `close` cannot be held by a stray grandchild. */
      const terminateTree = (onDone: () => void) => {
        const { pid } = child;
        const terminated = pid === undefined
          ? Promise.resolve()
          : terminateProcessTree({ pid, jobId: probeId, graceMs: PROBE_TERMINATE_GRACE_MS }).then(() => undefined, (cause: unknown) => {
            logger.warn("Could not terminate the process tree of a probe.", {
              command, error: cause instanceof Error ? cause.message : String(cause),
            });
          });
        void terminated.then(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          onDone();
        });
      };
      const onChunk = (target: CappedOutput) => (chunk: Buffer) => {
        target.push(chunk);
        if (!target.overflowed || settled) return;
        // Too much output: report what was kept, as a failed probe, and stop the tree.
        finish({ ok: false, exitCode: null, timedOut: false });
        terminateTree(() => undefined);
      };
      child.stdout.on("data", onChunk(stdout));
      child.stderr.on("data", onChunk(stderr));
      let spawnFailed = false;
      child.once("error", (error: NodeJS.ErrnoException) => {
        spawnFailed = true;
        const stderrFallback = typeof error.code === "string" ? `${error.code}: ${error.message}` : error.message;
        terminateTree(() => finish({ ok: false, exitCode: null, timedOut: false, stderrFallback }));
      });
      child.once("close", (exitCode, signal) => {
        if (settled || spawnFailed) return;
        clearTimeout(timeoutTimer);
        // The direct child is gone, but a detached grandchild (setsid) may still hold work: reap it before reporting.
        terminateTree(() => finish({ ok: exitCode === 0 && signal === null && !timedOut, exitCode, timedOut }));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end();
      // A zero or negative timeout means "no timeout".
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          terminateTree(() => {
            if (settled) return;
            // `close` normally follows at once; a stuck child must not hold the probe past this bound.
            closeWaitTimer = setTimeout(() => finish({ ok: false, exitCode: null, timedOut: true }), PROBE_CLOSE_WAIT_MS);
          });
        }, timeoutMs);
      }
    } catch (error) {
      finish({ ok: false, exitCode: null, timedOut: false, stderrFallback: (error as Error).message });
    }
  });
}

/** Extracts a semver-like version from `--version` output. */
export function parseVersion(text: string): string | undefined {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?/.exec(text);
  return match?.[0];
}

export interface HealthBase {
  harnessId: string;
  harness: HarnessConfig;
  driver: DriverKind;
  securityGuarantees: Record<RunMode, SecurityGuarantee>;
}

export function healthNow(base: HealthBase, fields: Partial<HarnessHealth>): HarnessHealth {
  const meta = DRIVER_METADATA[base.driver];
  return {
    harness: base.harnessId,
    driver: base.driver,
    enabled: base.harness.enabled,
    installed: false,
    auth_status: "unknown",
    security_guarantees: { ...base.securityGuarantees },
    contract: meta.contract,
    mcp_isolation: meta.mcpIsolation,
    checked_at: new Date().toISOString(),
    ...fields,
  };
}

const URL_IN_PROBE_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** Redacts secrets and URLs first and clips second, so the cut can never leave a recognizable secret or URL prefix. */
function versionFailureDetail(text: string): string {
  const scrubbed = redactSecrets(text).replace(URL_IN_PROBE_TEXT, "<url>").replace(/\s+/g, " ").trim();
  return tail(scrubbed, MAX_VERSION_NOTE_CHARS);
}

/** Common first probe step: binary lookup plus `<binary> --version`. */
export async function probeBinaryAndVersion(
  base: HealthBase,
  timeoutMs: number,
): Promise<{ health?: HarnessHealth; binaryPath?: string; version?: string }> {
  const binaryPath = resolveBinary(base.harness.binary, harnessLookup());
  if (!binaryPath) {
    return {
      health: healthNow(base, {
        installed: false,
        note: `Binary ${JSON.stringify(base.harness.binary)} was not found on PATH (CLI_NOT_FOUND).`,
      }),
    };
  }
  const versionRun = await execProbe(binaryPath, ["--version"], timeoutMs);
  if (!versionRun.ok) {
    const reason = versionRun.timedOut ? "timed out" : `failed (exit ${versionRun.exitCode ?? "n/a"})`;
    return {
      health: healthNow(base, {
        installed: true,
        binary_path: binaryPath,
        note: `\`${base.harness.binary} --version\` ${reason}: ${versionFailureDetail(versionRun.stderr || versionRun.stdout)}`.trim(),
      }),
    };
  }
  return { binaryPath, version: parseVersion(`${versionRun.stdout}\n${versionRun.stderr}`) };
}

// ---------------------------------------------------------------------------
// Private temp files
// ---------------------------------------------------------------------------

/** Writes a per-job temp file with 0600 permissions (chmod enforces the mode if the file pre-existed). */
export async function writePrivateFile(dir: string, name: string, content: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, content, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE);
  return path;
}

// ---------------------------------------------------------------------------
// Effort mapping
// ---------------------------------------------------------------------------

/** The native effort value that means "let the CLI pick": no effort flag is passed for it. */
export const DEFAULT_NATIVE_EFFORT = "default";

/** True when the mapped native effort is an explicit level that must be passed to the CLI. */
export function isExplicitEffort(nativeEffort: string): boolean {
  return nativeEffort !== DEFAULT_NATIVE_EFFORT;
}

/** Normalizes case/whitespace, maps known synonyms, and passes unknown values through unchanged. */
export function mapEffortWith(synonyms: Record<string, string>, effort: string): string {
  const normalized = effort.trim().toLowerCase();
  return Object.hasOwn(synonyms, normalized) ? synonyms[normalized] : normalized;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses JSON without throwing; returns undefined for non-JSON input. */
export function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(-maxChars);
}

/** Drops undefined fields; returns undefined when nothing is left. */
export function compactUsage(usage: UsageStats): UsageStats | undefined {
  const entries = Object.entries(usage).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as UsageStats) : undefined;
}

/** Appends lines to a bounded in-memory buffer; returns false once the cap is reached. */
export class BoundedLines {
  private readonly lines: string[] = [];
  private bytes = 0;
  overflowed = false;

  constructor(private readonly limitBytes = PARSER_BUFFER_LIMIT_BYTES) {}

  push(line: string): void {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (this.bytes + size > this.limitBytes) {
      this.overflowed = true;
      return;
    }
    this.lines.push(line);
    this.bytes += size;
  }

  get length(): number {
    return this.lines.length;
  }

  text(): string {
    return this.lines.join("\n");
  }
}

/** Concatenates streamed text chunks (deltas) up to a byte cap; once full, later chunks are dropped. */
export class BoundedText {
  private value = "";
  private bytes = 0;
  overflowed = false;

  constructor(private readonly limitBytes = PARSER_BUFFER_LIMIT_BYTES) {}

  append(chunk: string): void {
    if (chunk === "" || this.overflowed) return;
    const size = Buffer.byteLength(chunk, "utf8");
    if (this.bytes + size > this.limitBytes) {
      this.overflowed = true;
      return;
    }
    this.value += chunk;
    this.bytes += size;
  }

  /** Replaces everything kept so far (a snapshot supersedes the deltas that led to it). */
  replace(text: string): void {
    this.value = "";
    this.bytes = 0;
    this.overflowed = false;
    this.append(text);
  }

  clear(): void {
    this.replace("");
  }

  text(): string {
    return this.value;
  }
}

const MAX_DETAIL_LABEL_CHARS = 64;

/** A CLI-supplied label (a result subtype, a stop reason) made safe for `error.details`: redacted, plain characters, short. */
export function safeDetailLabel(value: string): string | undefined {
  const label = redactSecrets(value).replace(/[^\w.:-]+/g, "_").slice(0, MAX_DETAIL_LABEL_CHARS);
  return label === "" ? undefined : label;
}

// ---------------------------------------------------------------------------
// Binary identity on the run path
// ---------------------------------------------------------------------------

export type IdentityVerdict = "verified" | "mismatch" | "inconclusive";

const MAX_IDENTITY_CACHE_ENTRIES = 64;
const identityCache = new Map<string, IdentityVerdict>();

/** `agent.exe` and `AGENT` both have the stem `agent`; only a known launcher extension is dropped. */
export function binaryStem(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  return name.replace(/\.(?:exe|cmd|bat|com)$/, "");
}

/**
 * Runs an identity check for an ambiguous binary name (`fx`, `agent`) at most once per file version: the verdict is
 * cached by resolved path, device, inode, mtime, ctime and size (ctime cannot be set back, unlike mtime), so a replaced binary is checked again. An inconclusive verdict is never cached.
 */
export async function verifyBinaryIdentity(
  kind: string, path: string, check: () => Promise<IdentityVerdict>,
): Promise<IdentityVerdict> {
  let key: string | undefined;
  try {
    const info = statSync(path);
    key = `${kind}\0${path}\0${info.dev}\0${info.ino}\0${info.mtimeMs}\0${info.ctimeMs}\0${info.size}`;
  } catch {
    key = undefined;
  }
  const cached = key === undefined ? undefined : identityCache.get(key);
  if (cached !== undefined) return cached;
  const verdict = await check();
  if (key !== undefined && verdict !== "inconclusive") {
    identityCache.delete(key);
    identityCache.set(key, verdict);
    while (identityCache.size > MAX_IDENTITY_CACHE_ENTRIES) identityCache.delete(identityCache.keys().next().value!);
  }
  return verdict;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const AUTH_PATTERNS = [
  /not\s+logged\s+in/i,
  /please\s+(?:run\s+)?(?:\/)?login/i,
  /please\s+sign\s+in/i,
  /set\s+an\s+auth\s+method/i,
  /reconnect\s+.+\s+to\s+continue/i,
  /\blogin\s+required\b/i,
  /invalid\s+api[\s_-]?key/i,
  /missing\s+api[\s_-]?key/i,
  /no\s+api[\s_-]?key/i,
  /\bunauthori[sz]ed\b/i,
  /\b(?:status|http|code)[\s:=]*40[13]\b|\b40[13]\s+(?:unauthori[sz]ed|forbidden)/i,
  /\bUNAUTHENTICATED\b/,
  /authentication[_\s](?:failed|error|required)/i,
  /(?:oauth|access)\s+token\s+(?:has\s+)?(?:expired|revoked|invalid)/i,
  /credentials?\s+(?:are\s+|is\s+)?(?:missing|invalid|expired|not\s+found)/i,
  /no\s+credentials/i,
];

const MODEL_PATTERNS = [
  /does not have access to[^\n]*model/i,
  /model[^\n]{0,80}\b(?:deprecated|retired|access denied|not enabled|not allowed|unavailable)\b/i,
  /permission denied[^\n]{0,60}model|404[^\n]{0,60}model/i,
  /model[^\n]{0,80}\b(?:not\s+found|does\s+not\s+exist|not\s+supported|unsupported|unknown|not\s+available|invalid)\b/i,
  /(?:unknown|unsupported|invalid)\s+model/i,
  /model_not_found/i,
  /issue\s+with\s+the\s+selected\s+model/i,
  /no\s+such\s+model/i,
];

const RETRYABLE_PATTERNS = [
  /\b(?:http|status|code|error)[\s:=]*429\b|too\s+many\s+requests/i,
  /rate[\s_-]?limit/i,
  /overloaded/i,
  /\b(?:status|http|code)[\s:=]*5\d\d\b|\b5\d\d\s+(?:internal|bad\s+gateway|service\s+unavailable|gateway)/i,
  /timed?\s?out/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket\s+hang\s+up/i,
  /temporar(?:y|ily)\s+unavailable/i,
];

export function looksLikeAuthFailure(text: string): boolean {
  return AUTH_PATTERNS.some((pattern) => pattern.test(text));
}

export function looksLikeModelUnsupported(text: string): boolean {
  return MODEL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Prefix for numeric status codes: JSON fields (`"status":429`, `"code": 503`, `"status_code": 429`) and HTTP
 * protocol strings (`HTTP/2 503`, `HTTP 529`). A bare file position such as `src/a.ts:429:` has no such prefix.
 */
const STATUS_CONTEXT = String.raw`\b(?:http(?:\/\d(?:\.\d)?)?|status(?:_code)?|code|error)["']?[\s:=]+`;
const STATUS_429 = `${STATUS_CONTEXT}429\\b`;
const STATUS_OVERLOADED = `${STATUS_CONTEXT}(?:502|503|529)\\b`;
/** Transient throttle wording, next to RESOURCE_EXHAUSTED it marks a rate limit rather than a spent quota. */
const TRANSIENT_RATE_TERMS = new RegExp(
  `${STATUS_429}|(?:requests|tokens)\\s+per\\s+minute|rate[\\s_-]?limit|too\\s+many\\s+requests|throttl`, "i");
/** Wording that means the account's allowance is spent, even when the provider also answers HTTP 429. */
const HARD_QUOTA_TERMS = /daily\s+(?:limit|quota)|insufficient[\s_-]quota|credit|billing|balance|plan\s+limit|out\s+of\s+credits|spend\s+limit|you['\u2019]?ve\s+hit\s+your\s+(?:usage\s+)?limit/i;
const RATE_LIMITED_PATTERN = new RegExp(
  `${STATUS_429}|\\b429\\s+too\\s+many|too\\s+many\\s+requests|rate[\\s_-]?limit|(?:requests|tokens)\\s+per\\s+minute|\\bthrottl(?:ed|ing)\\b`, "i");
const PROVIDER_OVERLOADED_PATTERN = new RegExp(
  `${STATUS_OVERLOADED}|\\b(?:502\\s+bad\\s+gateway|503\\s+service\\s+unavailable|529\\s+overloaded|503\\s+overloaded)\\b|overloaded_error|\\bserver\\s+is\\s+overloaded\\b|\\boverloaded\\b|\\bat\\s+capacity\\b|\\bhigh\\s+demand\\b|\\bservice\\s+unavailable\\b|\\bbad\\s+gateway\\b|\\btemporar(?:y|ily)\\s+unavailable\\b|\\bserver\\s+is\\s+busy\\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket\\s+hang\\s+up`, "i");

function hasHardQuotaWording(text: string): boolean {
  if (HARD_QUOTA_TERMS.test(text)) return true;
  // "Quota exceeded for metric ... requests per minute" is the provider's wording for a transient throttle.
  return /quota\s+exceeded/i.test(text) && !/per\s+minute/i.test(text);
}

function isResourceExhaustedThrottle(text: string): boolean {
  return /resource_exhausted/i.test(text) && TRANSIENT_RATE_TERMS.test(text) && !hasHardQuotaWording(text);
}

/** A rate-limit wording with no hard-quota wording next to it: a transient throttle, whatever the provider's status name. */
function isTransientThrottle(text: string): boolean {
  return TRANSIENT_RATE_TERMS.test(text) && !hasHardQuotaWording(text);
}

export function looksLikeQuotaExceeded(text: string): boolean {
  if (isResourceExhaustedThrottle(text) || isTransientThrottle(text)) return false;
  return /quota[ _-]exceeded|insufficient[ _-]quota|credit balance is too low|insufficient (?:credits?|balance)|balance is not enough|out of credits/i.test(text) ||
    /billing[ _-](?:hard[ _-])?limit|check your plan and billing|spend limit|payment required|\b(?:http|status|code)[\s:=]*402\b/i.test(text) ||
    /resource_exhausted|usage[ _-]limit|hit your (?:usage )?limit|plan limit reached|limit resets/i.test(text);
}

/** Requires HTTP/status/error context for 429 so file line numbers such as `src/a.ts:429:` never match. */
export function looksLikeRateLimited(text: string): boolean {
  if (/resource_exhausted/i.test(text) && hasHardQuotaWording(text)) return false;
  return RATE_LIMITED_PATTERN.test(text) || isResourceExhaustedThrottle(text);
}

/** Requires HTTP/status/error context for 5xx codes so bare numbers never match. */
export function looksLikeProviderOverloaded(text: string): boolean {
  return PROVIDER_OVERLOADED_PATTERN.test(text);
}

export function looksLikePromptTooLarge(text: string): boolean {
  return /prompt is too long|context[ _-]length[ _-]exceeded|maximum context length|exceeds the (?:model'?s? )?context window|input is too long|request too large|too many tokens|token limit exceeded|exceeds the maximum number of (?:input )?tokens|input token count[^\n]{0,60}exceeds/i.test(text);
}

/** A context overflow wins over the generic status it travels in (RESOURCE_EXHAUSTED), but not over a real throttle. */
function looksLikeContextLimit(text: string): boolean {
  return looksLikePromptTooLarge(text) && !TRANSIENT_RATE_TERMS.test(text);
}

const FAILURE_CLASSES: ReadonlyArray<{
  matches: (text: string) => boolean; code: ErrorCode; scope: FailureScope; retryable: boolean;
}> = [
  { matches: looksLikeAuthFailure, code: "AUTH_REQUIRED", scope: "harness", retryable: false },
  { matches: looksLikeContextLimit, code: "PROMPT_TOO_LARGE", scope: "model", retryable: false },
  { matches: looksLikeQuotaExceeded, code: "QUOTA_EXCEEDED", scope: "harness", retryable: false },
  { matches: looksLikeRateLimited, code: "RATE_LIMITED", scope: "harness", retryable: true },
  { matches: looksLikeProviderOverloaded, code: "PROVIDER_OVERLOADED", scope: "harness", retryable: true },
  { matches: looksLikePromptTooLarge, code: "PROMPT_TOO_LARGE", scope: "model", retryable: false },
  { matches: looksLikeModelUnsupported, code: "MODEL_UNSUPPORTED", scope: "model", retryable: false },
];

function looksRetryable(text: string): boolean {
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(text));
}

export function adapterError(
  code: ErrorCode,
  message: string,
  retryable: boolean,
  extra: { details?: Record<string, unknown>; stderrTail?: string } = {},
): StructuredError {
  const error: StructuredError = {
    code,
    message: tail(redactSecrets(message.trim()), MESSAGE_LIMIT_CHARS),
    retryable,
  };
  if (extra.details) error.details = extra.details;
  if (extra.stderrTail?.trim()) error.stderr_tail = redactSecrets(extra.stderrTail);
  return error;
}

/**
 * Classifies the combined provider diagnostics before applying display limits.
 */
export function classifiedFailure(
  label: string,
  input: FinishParseInput,
  reportedMessage: string | undefined,
  fallbackCode: ErrorCode,
  extra: { details?: Record<string, unknown>; usage?: UsageStats; warnings?: string[]; summary?: string } = {},
): ParsedAdapterResult {
  const reported = reportedMessage?.trim() ?? "";
  const stderr = input.stderrTail.trim();
  const evidence = reported.includes(stderr) ? reported : stderr.includes(reported) ? stderr : reported + "\n" + stderr;
  const match = FAILURE_CLASSES.find(({ matches }) => matches(evidence));
  const exitPart = input.signal ? `signal ${input.signal}` : `exit code ${input.exitCode ?? "n/a"}`;
  const code = match?.code ?? fallbackCode;
  const description = code === "AUTH_REQUIRED" ? "is not authenticated" : code === "MODEL_UNSUPPORTED" ? "rejected the model" : "failed";
  const error = adapterError(code, `${label} ${description} (${exitPart}): ${reported || tail(stderr, 500) || "no error output"}`,
    match?.retryable ?? looksRetryable(evidence), { details: extra.details, stderrTail: input.stderrTail });
  error.failure_scope = match?.scope ?? (fallbackCode === "AUTH_REQUIRED" ? "harness" : "job");
  if (evidence) error.raw_error = redactSecrets(evidence).slice(0, MESSAGE_LIMIT_CHARS);
  return {
    ok: false,
    summary: redactSecrets(extra.summary ?? ""),
    error,
    ...(extra.usage ? { usage: extra.usage } : {}),
    ...(extra.warnings?.length ? { warnings: extra.warnings } : {}),
  };
}

export function exitedCleanly(input: FinishParseInput): boolean {
  return input.exitCode === 0 && input.signal === null;
}

/** Notes about stream truncation, attached as warnings when relevant. */
export function streamWarnings(input: FinishParseInput): string[] {
  const warnings: string[] = [];
  if (input.stdoutTruncated) warnings.push("The on-disk stdout.log hit its byte cap; the stream parser kept processing events, but the saved log is incomplete.");
  if (input.oversizedLinesDropped > 0) {
    warnings.push(`${input.oversizedLinesDropped} oversized stdout line(s) were dropped before parsing.`);
  }
  return warnings;
}

/**
 * Exit code 0 but no structured result: degrade to the raw non-JSON text when
 * there is any, unless stderr reports a recognized provider failure.
 */
export function degradedOrParseError(
  label: string,
  input: FinishParseInput,
  rawText: string,
  reason: string,
): ParsedAdapterResult {
  const warnings = streamWarnings(input);
  if (FAILURE_CLASSES.some(({ matches }) => matches(input.stderrTail))) {
    return classifiedFailure(label, input, undefined, "PARSE_ERROR", { warnings });
  }
  const text = rawText.trim();
  if (text) {
    return {
      ok: true,
      summary: redactSecrets(text),
      parseDegraded: true,
      warnings: [`${label} output could not be parsed as structured JSON (${reason}); returning raw text.`, ...warnings],
    };
  }
  return {
    ok: false,
    summary: "",
    error: adapterError("PARSE_ERROR", `${label} exited 0 but produced no parsable result (${reason}).`, false, {
      stderrTail: input.stderrTail,
      details: { stdout_truncated: input.stdoutTruncated, oversized_lines_dropped: input.oversizedLinesDropped },
    }),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * A safe, short description of what a tool call works on (a path, a pattern or the start of a command).
 * Never file contents and never the full tool input, so checkpoints cannot carry file bodies.
 */
export function safeToolTarget(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  // Redact first, truncate second: a secret straddling the cut would otherwise survive as an unrecognizable prefix.
  const clip = (value: string, maxBytes: number): string => truncateUtf8(redactSecrets(value), maxBytes).text;
  for (const key of TARGET_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.trim()) return clip(value, MAX_PATH_TARGET_BYTES);
  }
  const command = fields.command;
  return typeof command === "string" && command.trim() ? clip(command, MAX_COMMAND_TARGET_BYTES) : undefined;
}

/** One numeric argument (a number, a short numeric array or a numeric range string) rendered as text, else undefined. */
function numericArgument(key: string, value: unknown): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "string") {
    return POSITION_KEY_PATTERN.test(key) && NUMERIC_RANGE_PATTERN.test(value) && /\d/.test(value) ? value.trim() : undefined;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_VARIANT_ARRAY_ITEMS) return undefined;
  return value.every((item) => typeof item === "number" && Number.isFinite(item)) ? `[${value.join(",")}]` : undefined;
}

/**
 * The positional arguments of a tool call (offset, limit, a line range) as a short stable string, so two reads of the
 * same file at different offsets differ for stuck-loop detection. Only numbers and numeric ranges are kept: never text,
 * so it can carry neither file contents nor secrets.
 */
export function safeToolVariant(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const fields = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(fields).sort()) {
    const value = numericArgument(key, fields[key]);
    if (value !== undefined) parts.push(`${key.slice(0, MAX_VARIANT_KEY_CHARS)}=${value}`);
    if (parts.length >= MAX_VARIANT_FIELDS) break;
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
