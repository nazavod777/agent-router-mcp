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
/** PowerShell scripts: never started directly (`spawn` cannot run them without a shell) and never an implicit PATHEXT candidate. */
const POWERSHELL_EXTENSION = ".ps1";
/** `C:tool.exe` / `D:sub\\tool.exe`: a drive letter without a separator after the colon is relative to that drive's current directory. */
const DRIVE_RELATIVE_PATH = /^[A-Za-z]:(?![\\/])/;
/** Window for the output pipes of an exited probe to close before its process tree is reaped (matches the discovery probes). */
const PROBE_PIPE_CLOSE_GRACE_MS = 250;
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
 * Windows cannot start. A `.ps1` is never an implicit candidate either. A name that already ends in a launcher extension
 * (`tool.exe`) is looked up as written, even when PATHEXT does not list it.
 */
function candidateNames(name: string, windows: boolean, pathExt: string | undefined): string[] {
  if (!windows) return [name];
  const extensions = (pathExt?.split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean) ?? []);
  const known = (extensions.length > 0 ? extensions : DEFAULT_PATHEXT).filter((ext) => ext !== POWERSHELL_EXTENSION);
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(POWERSHELL_EXTENSION) || [...known, ...DEFAULT_PATHEXT].some((ext) => lowerName.endsWith(ext))) return [name];
  return known.map((ext) => `${name}${ext}`);
}

/** Windows lets a PATH entry that contains spaces or semicolons be wrapped in double quotes: `"C:\\Program Files\\Tool"`. */
function unquotePathEntry(entry: string): string {
  const trimmed = entry.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : entry;
}

/**
 * Splits a Windows PATH on `;`, except inside a pair of double quotes (`"C:\\a;b\\bin"` is one directory). A quote that is
 * never closed keeps the rest of the value as one entry, which then fails the pair check and is skipped.
 */
export function splitWindowsPath(pathEnv: string): string[] {
  const entries: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const char of pathEnv) {
    if (char === '"') inQuotes = !inQuotes;
    if (char === ";" && !inQuotes) {
      entries.push(current);
      current = "";
    } else current += char;
  }
  entries.push(current);
  return entries;
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
  // A drive-relative path depends on the process's per-drive current directory, which must never decide what runs.
  if (windows && DRIVE_RELATIVE_PATH.test(trimmed)) return undefined;
  const hasDirectory = trimmed.includes("/") || (windows && trimmed.includes("\\"));
  if (flavor.isAbsolute(trimmed) || hasDirectory) {
    let base: string;
    if (flavor.isAbsolute(trimmed)) base = resolve(trimmed);
    else if (options.baseDir !== undefined && flavor.isAbsolute(options.baseDir)) base = resolve(options.baseDir, trimmed);
    else return undefined;
    return candidateNames(base, windows, pathExt).find(isExecutableFile);
  }
  const pathValue = options.pathEnv ?? process.env.PATH ?? "";
  for (const entry of windows ? splitWindowsPath(pathValue) : pathValue.split(pathDelimiter)) {
    const dir = windows ? unquotePathEntry(entry) : entry;
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

const WINDOWS_SCRIPT_LAUNCHER = /\.(?:cmd|bat|ps1)$/i;
const JAVASCRIPT_ENTRY = /\.(?:c|m)?js$/i;

/**
 * What to spawn for an executable path. A Windows `.cmd`/`.bat`/`.ps1` cannot be started without a shell (Node refuses
 * with EINVAL), so an npm launcher shim is replaced by `node <its script>`. A script that is not such a shim fails here
 * with an actionable error instead.
 */
export function unwrapLauncher(path: string, platform: NodeJS.Platform = process.platform): LaunchCommand {
  if (platform !== "win32" || !WINDOWS_SCRIPT_LAUNCHER.test(path)) return { command: path, prefixArgs: [] };
  const script = readNpmShimTarget(path);
  if (script === undefined || !JAVASCRIPT_ENTRY.test(script)) {
    throw adapterError("CLI_NOT_FOUND",
      `${path} is a .cmd/.bat/.ps1 launcher that is not a recognizable npm JavaScript shim, so it cannot be started without a shell. ` +
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
 * detaches (setsid) cannot stall the probe or outlive it. After a clean exit the output pipes get a short grace to drain
 * and are then cut, so a grandchild holding them can never turn a success into a timeout. On Windows a probe whose
 * process already exited is not searched for leftover descendants (no process-table query); a running one is ended with
 * `taskkill /T /F`. A Windows npm `.cmd` shim is started as `node <script>`.
 */
export function execProbe(command: string, args: string[], timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeOutput> {
  return new Promise((resolvePromise) => {
    const stdout = new CappedOutput(PROBE_OUTPUT_LIMIT_BYTES);
    const stderr = new CappedOutput(PROBE_OUTPUT_LIMIT_BYTES);
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let closeWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let pipeGraceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (output: Omit<ProbeOutput, "stdout" | "stderr"> & { stderrFallback?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(closeWaitTimer);
      clearTimeout(pipeGraceTimer);
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
          : terminateProcessTree({ pid, jobId: probeId, graceMs: PROBE_TERMINATE_GRACE_MS, verifyDescendants: false }).then(() => undefined, (cause: unknown) => {
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
      /** Ends the tree and reports the exit. The first of `exit` (after its pipe grace) and `close` wins. */
      let exitHandled = false;
      const reportExit = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (exitHandled || settled || spawnFailed) return;
        exitHandled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(pipeGraceTimer);
        // The direct child is gone, but a detached grandchild (setsid) may still hold work: reap it before reporting.
        terminateTree(() => finish({ ok: exitCode === 0 && signal === null && !timedOut, exitCode, timedOut }));
      };
      // A grandchild that inherited the pipes keeps `close` from firing after a clean exit: the exit code is final, so the
      // pipes get a short grace to drain and are then cut instead of letting the timeout turn a success into a failure.
      child.once("exit", (exitCode, signal) => {
        if (settled || spawnFailed) return;
        clearTimeout(timeoutTimer);
        pipeGraceTimer = setTimeout(() => reportExit(exitCode, signal), PROBE_PIPE_CLOSE_GRACE_MS);
      });
      child.once("close", reportExit);
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

const STANDARD_EFFORT_LEVELS: ReadonlySet<string> = new Set([
  "off", "none", "minimal", "low", "medium", "high", "xhigh", "max", DEFAULT_NATIVE_EFFORT,
]);

/**
 * Trims, maps known synonyms (case-insensitively) and lowercases the standard levels. A custom value (a model-specific
 * effort name or a numeric budget) keeps its original case, since a CLI may treat it as case-sensitive.
 */
export function mapEffortWith(synonyms: Record<string, string>, effort: string): string {
  const trimmed = effort.trim();
  const normalized = trimmed.toLowerCase();
  if (Object.hasOwn(synonyms, normalized)) return synonyms[normalized];
  return STANDARD_EFFORT_LEVELS.has(normalized) ? normalized : trimmed;
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
      this.settleAtLimit(chunk);
      return;
    }
    this.value += chunk;
    this.bytes += size;
  }

  /**
   * The text reached the cap. A secret may straddle the cut (its start already kept, its end in `chunk`), so the joined text
   * is redacted before anything is cut, and a trailing run of non-space characters, which could be the start of a secret
   * whose end is dropped, is removed from a truncated result.
   */
  private settleAtLimit(chunk: string): void {
    const joined = redactSecrets(this.value + chunk);
    const cut = truncateUtf8(joined, this.limitBytes);
    if (!cut.truncated) {
      this.value = joined;
      this.bytes = Buffer.byteLength(joined, "utf8");
      return;
    }
    this.overflowed = true;
    this.value = cut.text.replace(/\S{1,512}$/, "");
    this.bytes = Buffer.byteLength(this.value, "utf8");
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

/**
 * Prefix for numeric status codes: JSON fields (`"status":429`, `"code": 503`, `"status_code": 429`) and HTTP
 * protocol strings (`HTTP/2 503`, `HTTP 529`). A bare file position such as `src/a.ts:429:` has no such prefix.
 */
const STATUS_CONTEXT = String.raw`\b(?:http(?:\/\d(?:\.\d)?)?|status(?:_code)?|code|error)["']?[\s:=]+`;

/** HTTP 401 and 403 with status context (`HTTP/2 401`, `API Error: 401`, `"status": 401`, `"code": 403`) or their reason phrase. */
const HTTP_401_PATTERN = new RegExp(`${STATUS_CONTEXT}401\\b|\\b401\\s+unauthori[sz]ed`, "i");
const HTTP_403_PATTERN = new RegExp(`${STATUS_CONTEXT}403\\b|\\b403\\s+forbidden`, "i");

/** The bare word is weak evidence: "403 Unauthorized: model x not found" is a model refusal, not a missing login. */
const BARE_UNAUTHORIZED_PATTERN = /\bunauthori[sz]ed\b/i;

/** Signals that mean "not authenticated" on their own. A bare HTTP 403 is not one: it may be a model permission error. */
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
  BARE_UNAUTHORIZED_PATTERN,
  HTTP_401_PATTERN,
  /\b(?:status|http|code)[\s:=]*401\b/i,
  /\bUNAUTHENTICATED\b/,
  /authentication[_\s](?:failed|error|required)/i,
  /(?:oauth|access)\s+token\s+(?:has\s+)?(?:expired|revoked|invalid)/i,
  /credentials?\s+(?:are\s+|is\s+)?(?:missing|invalid|expired|not\s+found)/i,
  /no\s+credentials/i,
  /failed\s+to\s+authenticate/i,
  /\b(?:oauth|auth)\s+session\s+(?:has\s+)?(?:expired|revoked|invalid)/i,
  /\brefresh\s+token\s+(?:has\s+)?(?:expired|revoked|invalid)/i,
  /\b(?:invalid_grant|token_expired)\b/i,
  /please\s+re-?authenticate/i,
  /\bapi\s+key\s+(?:is\s+)?not\s+valid\b|\bincorrect\s+api\s+key\s+provided\b/i,
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
  /model_not_supported/i,
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

/** Authentication failure other than a bare HTTP 403 (which may be a model permission error). */
function looksLikeStrongAuthFailure(text: string): boolean {
  // A 403 that names a model is judged as a model refusal unless something stronger than the bare word says "not logged in".
  const modelRefusal = looksLikeModelForbidden(text);
  return AUTH_PATTERNS.some((pattern) => !(modelRefusal && pattern === BARE_UNAUTHORIZED_PATTERN) && pattern.test(text));
}

function looksLikeHttp403(text: string): boolean {
  return HTTP_403_PATTERN.test(text) || /\b(?:status|http|code)[\s:=]*403\b/i.test(text);
}

export function looksLikeAuthFailure(text: string): boolean {
  return looksLikeStrongAuthFailure(text) || looksLikeHttp403(text);
}

/** HTTP 403 next to a model error ("HTTP 403 model x not found"): the model is refused, the login is fine. */
function looksLikeModelForbidden(text: string): boolean {
  return (looksLikeHttp403(text) || /\b403\b/.test(text)) && looksLikeModelUnsupported(text);
}

export function looksLikeModelUnsupported(text: string): boolean {
  return MODEL_PATTERNS.some((pattern) => pattern.test(text));
}

const STATUS_429 = `${STATUS_CONTEXT}429\\b`;
const STATUS_OVERLOADED = `${STATUS_CONTEXT}(?:500|502|503|504|529)\\b`;
/** Transient throttle wording, next to RESOURCE_EXHAUSTED it marks a rate limit rather than a spent quota. */
const TRANSIENT_RATE_TERMS = new RegExp(
  `${STATUS_429}|(?:requests|tokens)\\s+per\\s+minute|rate[\\s_-]?limit|too\\s+many\\s+requests|throttl`, "i");
/** Wording that means the account's allowance is spent, even when the provider also answers HTTP 429. */
const HARD_QUOTA_TERMS = /daily\s+(?:limit|quota)|insufficient[\s_-]quota|credit|billing|balance|plan\s+limit|out\s+of\s+credits|spend\s+limit|you['\u2019]?ve\s+hit\s+your\s+(?:usage\s+)?limit|you(?:['\u2019]?ve|\s+have)?\s+exceeded\s+your\s+(?:current\s+)?quota/i;
const RATE_LIMITED_PATTERN = new RegExp(
  `${STATUS_429}|\\b429\\s+too\\s+many|too\\s+many\\s+requests|rate[\\s_-]?limit|(?:requests|tokens)\\s+per\\s+minute|\\bthrottl(?:ed|ing)\\b`, "i");
const PROVIDER_OVERLOADED_PATTERN = new RegExp(
  `${STATUS_OVERLOADED}|\\b(?:500\\s+internal\\s+server\\s+error|502\\s+bad\\s+gateway|503\\s+service\\s+unavailable|504\\s+gateway\\s+time-?out|529\\s+overloaded|503\\s+overloaded)\\b|overloaded_error|\\bserver\\s+is\\s+overloaded\\b|\\boverloaded\\b|\\bat\\s+capacity\\b|\\bhigh\\s+demand\\b|\\bservice\\s+unavailable\\b|\\bbad\\s+gateway\\b|\\btemporar(?:y|ily)\\s+unavailable\\b|\\bserver\\s+is\\s+busy\\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket\\s+hang\\s+up`, "i");

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

const STATUS_402_PATTERN = new RegExp(`${STATUS_CONTEXT}402\\b`, "i");

export function looksLikeQuotaExceeded(text: string): boolean {
  if (isResourceExhaustedThrottle(text) || isTransientThrottle(text)) return false;
  return STATUS_402_PATTERN.test(text) || /quota[ _-]exceeded|you(?:['\u2019]?ve|\s+have)?\s+exceeded\s+your\s+(?:current\s+)?quota|insufficient[ _-]quota|credit balance is too low|insufficient (?:credits?|balance)|balance is not enough|out of credits/i.test(text) ||
    /billing[ _-](?:hard[ _-])?limit|check your plan and billing|spend limit|payment required|\b(?:http|status|code)[\s:=]*402\b/i.test(text) ||
    /resource_exhausted|usage[ _-]limit|hit your (?:usage )?limit|plan limit reached|limit resets/i.test(text);
}

/** Requires HTTP/status/error context for 429 so file line numbers such as `src/a.ts:429:` never match. */
export function looksLikeRateLimited(text: string): boolean {
  if (/resource_exhausted/i.test(text) && hasHardQuotaWording(text)) return false;
  return RATE_LIMITED_PATTERN.test(text) || isResourceExhaustedThrottle(text);
}

/** Requires HTTP/status/error context for 5xx codes so bare numbers never match. */
/** Structured gRPC-style statuses are upper case on purpose: a lower-case "unavailable" is ordinary prose. */
const STRUCTURED_UNAVAILABLE_PATTERN = /\bDEADLINE_EXCEEDED\b|\b(?:status|code)["']?[\s:=]+["']?UNAVAILABLE\b/;

export function looksLikeProviderOverloaded(text: string): boolean {
  return PROVIDER_OVERLOADED_PATTERN.test(text) || STRUCTURED_UNAVAILABLE_PATTERN.test(text);
}

const STATUS_413_PATTERN = new RegExp(`${STATUS_CONTEXT}413\\b`, "i");

export function looksLikePromptTooLarge(text: string): boolean {
  return STATUS_413_PATTERN.test(text) || /payload too large|context_window_exceeded/i.test(text) || /prompt is too long|context[ _-]length[ _-]exceeded|maximum context length|exceeds the (?:model'?s? )?context window|input is too long|request too large|too many tokens|token limit exceeded|exceeds the maximum number of (?:input )?tokens|input token count[^\n]{0,60}exceeds/i.test(text);
}

/** A context overflow wins over the generic status it travels in (RESOURCE_EXHAUSTED), but not over a real throttle. */
function looksLikeContextLimit(text: string): boolean {
  return looksLikePromptTooLarge(text) && !TRANSIENT_RATE_TERMS.test(text);
}

/** Signatures of an OS sandbox that could not be set up (Windows restricted token, ACL setup, logon type); never provider prose. */
const SANDBOX_FAILURE_WORDING = String.raw`(?:fail(?:ed|ure|s)?|error|denied|unavailable|cannot|could\s+not|unable|refused|abort(?:ed)?)`;
const SANDBOX_SETUP_PATTERNS = [
  // The sandbox's name alone is not a failure: it also appears in banners, docs and ordinary answers.
  new RegExp(String.raw`windows\s+sandbox[^\n]{0,80}${SANDBOX_FAILURE_WORDING}`, "i"),
  new RegExp(String.raw`${SANDBOX_FAILURE_WORDING}[^\n]{0,80}windows\s+sandbox`, "i"),
  /codex-windows-sandbox[^\n]{0,80}(?:fail(?:ed|ure)?|error|denied|exit|panic)/i,
  /setup\s+refresh\s+(?:had\s+errors|failed)/i,
  /deny_read_acl/i,
  /os\s+error\s+(?:1314|1385)\b/i,
  /restricted\s+token[^\n]{0,60}(?:failed|error|denied)/i,
  /sandbox\s+(?:initialization|setup|startup)\s+failed/i,
];
/** A bare "access denied" is a file permission error unless the text also names the sandbox machinery. */
const ACCESS_DENIED_PATTERN = /os\s+error\s+5\b|access\s+is\s+denied/i;
const SANDBOX_CONTEXT_PATTERN = /sandbox|setup|restricted[\s-]token|workspace-write|read-only|codex/i;

/** True when the diagnostics show the CLI's OS sandbox could not start, which no retry on the same machine fixes. */
export function looksLikeSandboxUnavailable(text: string, platform: NodeJS.Platform = process.platform): boolean {
  if (SANDBOX_SETUP_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (platform !== "win32" && !/sandbox/i.test(text)) return false;
  return ACCESS_DENIED_PATTERN.test(text) && SANDBOX_CONTEXT_PATTERN.test(text);
}

/** Non-secret next steps attached to a SANDBOX_UNAVAILABLE failure. */
const SANDBOX_UNAVAILABLE_HINTS: readonly string[] = [
  "Run the job from a local path that is not under OneDrive and not a UNC (\\\\server\\share) path, and keep the path shorter than 240 characters.",
  "Make sure TEMP and TMP point to a folder under %USERPROFILE%.",
  "Verify that the account may create restricted tokens and set file ACLs (Windows sandbox permissions), or that the CLI's sandbox is installed.",
  "Reroute the subtask to another enabled harness; this harness is put on cooldown.",
];

const FAILURE_CLASSES: ReadonlyArray<{
  matches: (text: string, platform?: NodeJS.Platform) => boolean; code: ErrorCode; scope: FailureScope; retryable: boolean;
}> = [
  { matches: looksLikeStrongAuthFailure, code: "AUTH_REQUIRED", scope: "harness", retryable: false },
  // A 403 that names a model is a model permission error, not a login problem.
  { matches: looksLikeModelForbidden, code: "MODEL_UNSUPPORTED", scope: "model", retryable: false },
  // Before the bare-403 login check and the generic exit classes, so a sandbox "Access is denied" is never misread.
  { matches: looksLikeSandboxUnavailable, code: "SANDBOX_UNAVAILABLE", scope: "harness", retryable: false },
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
  extra: { details?: Record<string, unknown>; stderrTail?: string; extraSecrets?: readonly string[] } = {},
): StructuredError {
  const secrets = extra.extraSecrets ? [...extra.extraSecrets] : undefined;
  // Redact first, truncate second: a secret straddling the cut would otherwise survive as an unrecognizable prefix.
  const error: StructuredError = {
    code,
    message: tail(redactSecrets(message.trim(), secrets), MESSAGE_LIMIT_CHARS),
    retryable,
  };
  if (extra.details) error.details = extra.details;
  if (extra.stderrTail?.trim()) error.stderr_tail = redactSecrets(extra.stderrTail, secrets);
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
  extra: { details?: Record<string, unknown>; usage?: UsageStats; warnings?: string[]; summary?: string; platform?: NodeJS.Platform } = {},
): ParsedAdapterResult {
  const secrets = input.extraSecrets ? [...input.extraSecrets] : undefined;
  const redact = (text: string): string => redactSecrets(text, secrets);
  const reported = reportedMessage?.trim() ?? "";
  const stderr = input.stderrTail.trim();
  const evidence = reported.includes(stderr) ? reported : stderr.includes(reported) ? stderr : reported + "\n" + stderr;
  const match = FAILURE_CLASSES.find(({ matches }) => matches(evidence, extra.platform));
  const exitPart = input.signal ? `signal ${input.signal}` : `exit code ${input.exitCode ?? "n/a"}`;
  const code = match?.code ?? fallbackCode;
  const description = code === "AUTH_REQUIRED" ? "is not authenticated"
    : code === "MODEL_UNSUPPORTED" ? "rejected the model"
      : code === "SANDBOX_UNAVAILABLE" ? "could not start its OS sandbox"
        : "failed";
  const details = code === "SANDBOX_UNAVAILABLE" ? { ...extra.details, hints: [...SANDBOX_UNAVAILABLE_HINTS] } : extra.details;
  const error = adapterError(code, `${label} ${description} (${exitPart}): ${reported || tail(redact(stderr), 500) || "no error output"}`,
    match?.retryable ?? looksRetryable(evidence), { details, stderrTail: input.stderrTail, extraSecrets: input.extraSecrets });
  error.failure_scope = match?.scope ?? (fallbackCode === "AUTH_REQUIRED" ? "harness" : "job");
  if (evidence) error.raw_error = redact(evidence).slice(0, MESSAGE_LIMIT_CHARS);
  return {
    ok: false,
    summary: redact(extra.summary ?? ""),
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

const MAX_CLI_DIAGNOSTIC_CHARS = 2048;
const MAX_UNPREFIXED_DIAGNOSTIC_CHARS = 256;
const MAX_UNPREFIXED_DIAGNOSTIC_LINES = 2;
/** An explicit CLI error label at the start of the output (`Error:`, `API Error:`, ...). */
const CLI_ERROR_PREFIX = /^(?:error|api\s+error|failed\s+to\s+authenticate|fatal|unauthori[sz]ed)\s*:/i;
/** The few login prompts a CLI prints, unlabelled, when it is not signed in; nothing broader may turn an answer into an error. */
const CLI_LOGIN_PROMPT = /^(?:you\s+are\s+)?not\s+logged\s+in\b|^login\s+required\b|^please\s+(?:sign\s+in|run\s+\/?login|re-?authenticate)\b|^oauth\s+session\s+(?:has\s+)?expired\b|^invalid\s+api[\s_-]?key\b/i;

/**
 * True when exit-0 stdout reads like a CLI error message rather than an answer: short, and either labelled with an error
 * prefix or a one- or two-line login prompt. Prose that merely mentions "rate limit" or "429" never qualifies.
 */
function looksLikeCliDiagnostic(text: string): boolean {
  if (text === "" || text.length > MAX_CLI_DIAGNOSTIC_CHARS) return false;
  if (CLI_ERROR_PREFIX.test(text)) return true;
  if (text.length > MAX_UNPREFIXED_DIAGNOSTIC_CHARS || text.includes("```") || /\n\s*\n/.test(text)) return false;
  return text.split("\n").length <= MAX_UNPREFIXED_DIAGNOSTIC_LINES && CLI_LOGIN_PROMPT.test(text);
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
  options: { allowStdoutErrorClassification?: boolean } = {},
): ParsedAdapterResult {
  const { allowStdoutErrorClassification = true } = options;
  const warnings = streamWarnings(input);
  if (FAILURE_CLASSES.some(({ matches }) => matches(input.stderrTail))) {
    return classifiedFailure(label, input, undefined, "PARSE_ERROR", { warnings });
  }
  const text = rawText.trim();
  // A CLI that exits 0 after printing a short diagnostic ("Error: login required") failed; it did not answer.
  // Not when `rawText` is assistant prose from a typed stream: an answer about rate limits is still an answer.
  if (allowStdoutErrorClassification && looksLikeCliDiagnostic(text) && FAILURE_CLASSES.some(({ matches }) => matches(text))) {
    return classifiedFailure(label, input, text, "PARSE_ERROR", { warnings });
  }
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
