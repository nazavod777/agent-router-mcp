import { redactSecrets } from "../logging.js";
import { ProgressTracker } from "../runtime/checkpoint.js";
import { truncateUtf8 } from "../runtime/output.js";
import type { ProgressCheckpoint, StructuredError, UsageStats } from "../types.js";
import {
  BoundedLines,
  asNumber,
  asString,
  classifiedFailure,
  compactUsage,
  degradedOrParseError,
  exitedCleanly,
  isObject,
  streamWarnings,
  tryParseJson,
  writePrivateFile,
  type JsonObject,
} from "./probe-utils.js";
import type { AdapterStreamParser, FinishParseInput, ParsedAdapterResult } from "./types.js";

/** Stay below Linux MAX_ARG_STRLEN (128 KiB) for single-argument argv prompts. */
export const MAX_ARGV_PROMPT_BYTES = 100 * 1024;

export function assertArgvPromptFits(label: string, prompt: string): void {
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_ARGV_PROMPT_BYTES) {
    const error: StructuredError = {
      code: "PROMPT_TOO_LARGE",
      message: `${label} passes prompts via argv and cannot accept ${bytes} bytes (limit ${MAX_ARGV_PROMPT_BYTES} bytes). Shorten the prompt or choose a stdin/file-capable harness.`,
      retryable: false,
      details: { bytes, limit_bytes: MAX_ARGV_PROMPT_BYTES },
    };
    throw error;
  }
}

/** CreateProcess rejects a command line longer than this many characters in total (program, arguments, quoting). */
export const MAX_WINDOWS_COMMAND_LINE_CHARS = 32_767;

/** Length of one argument after the quoting and escaping Windows' command-line rules apply to it. */
function windowsQuotedLength(arg: string): number {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg.length;
  let length = arg.length + 2;
  let backslashRun = 0;
  for (const char of arg) {
    if (char === "\\") {
      backslashRun += 1;
      continue;
    }
    // A quote needs its own escape, and every backslash right before it is doubled.
    if (char === '"') length += backslashRun + 1;
    backslashRun = 0;
  }
  // Backslashes at the end sit in front of the closing quote, so they are doubled too.
  return length + backslashRun;
}

/**
 * Total command line a Windows spawn would build (program and arguments, quoted, space separated). Linux limits single
 * arguments, Windows limits the whole line, so a prompt that fits the argv limit can still fail to start there.
 */
export function windowsCommandLineLength(command: string, args: readonly string[]): number {
  return [command, ...args].reduce((total, part) => total + windowsQuotedLength(part) + 1, -1);
}

/** Throws PROMPT_TOO_LARGE when the whole command line exceeds the Windows limit (a no-op on other platforms). */
export function assertCommandLineFits(
  label: string, command: string, args: readonly string[], platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  const length = windowsCommandLineLength(command, args);
  if (length <= MAX_WINDOWS_COMMAND_LINE_CHARS) return;
  const error: StructuredError = {
    code: "PROMPT_TOO_LARGE",
    message: `${label} would need a ${length}-character command line, but Windows allows ${MAX_WINDOWS_COMMAND_LINE_CHARS} in total. Shorten the prompt or choose a stdin/file-capable harness.`,
    retryable: false,
    details: { command_line_chars: length, limit_chars: MAX_WINDOWS_COMMAND_LINE_CHARS },
  };
  throw error;
}

/** The wrapper tags of an inlined prompt; untrusted instruction text must not be able to open or close them. */
const INLINE_WRAPPER_TAG = /<[\s\u200b-\u200d\ufeff]*(\/?)[\s\u200b-\u200d\ufeff]*(orchestrator_instructions|task)(?![\w-])/gi;

export function neutralizeInlineWrapperTags(text: string): string {
  return text.replace(INLINE_WRAPPER_TAG, "&lt;$1$2");
}

export function withInlineSystemContext(
  prompt: string,
  systemContext: string | undefined,
  extraInstructions?: string,
): { text: string; inlined: boolean } {
  const parts = [systemContext?.trim(), extraInstructions?.trim()]
    .filter((part): part is string => Boolean(part)).map(neutralizeInlineWrapperTags);
  if (parts.length === 0) return { text: prompt, inlined: false };
  return {
    text: `<orchestrator_instructions>\n${parts.join("\n\n")}\n</orchestrator_instructions>\n\n<task>\n${prompt}\n</task>`,
    inlined: true,
  };
}

export async function writePromptFile(jobDir: string, fileName: string, content: string): Promise<string> {
  return writePrivateFile(jobDir, fileName, content);
}

function readonlyPolicyViolation(label: string, arg: string, readonly = true): StructuredError {
  return {
    code: "SANDBOX_POLICY_VIOLATION",
    message: readonly
      ? `${label} extra_args contains ${JSON.stringify(arg)}, which would weaken readonly restrictions.`
      : `${label} extra_args contains ${JSON.stringify(arg)}, which would weaken the sandbox while allow_unsandboxed_write is false.`,
    retryable: false,
  };
}

/** Throws when any extra argument matches; callers write the regex so both `--flag value` and `--flag=value` hit. */
export function assertNoForbiddenReadonlyArgs(label: string, extraArgs: readonly string[], forbidden: RegExp, readonly = true): void {
  const match = extraArgs.find((arg) => forbidden.test(arg));
  if (match) throw readonlyPolicyViolation(label, match, readonly);
}

/** Values of `key=value` config overrides in every spelling: `-c v`, `-cv`, `-c=v`, `--config v` and `--config=v`. */
function configOverrideValues(args: readonly string[]): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg === "-c" || arg === "--config") {
      const next = args[index + 1];
      if (next !== undefined) values.push(next);
    } else if (arg.startsWith("--config=")) {
      values.push(arg.slice("--config=".length));
    } else if (arg.startsWith("-c") && !arg.startsWith("--")) {
      values.push(arg.slice(2).replace(/^=/, ""));
    }
  });
  return values;
}

/** Throws when a `-c`/`--config` override assigns a key matched by `forbiddenKey` (the regex is tested against `key=value`). */
export function assertNoForbiddenReadonlyConfigOverrides(
  label: string, extraArgs: readonly string[], forbiddenKey: RegExp, readonly = true,
): void {
  const match = configOverrideValues(extraArgs).find((value) => forbiddenKey.test(value));
  if (match !== undefined) throw readonlyPolicyViolation(label, match, readonly);
}

export interface SandboxArgsPolicy {
  mode: "readonly" | "write";
  /** `defaults.allow_unsandboxed_write`; anything but an explicit `true` counts as "not allowed" (fail closed). */
  allowUnsandboxedWrite: boolean | undefined;
  /** Flags that widen a readonly run: tools, MCP, sandbox and approval switches. Always refused in readonly mode. */
  readonlyForbidden: RegExp;
  /** Flags that drop the sandbox or approvals of a write run; refused in write mode unless unsandboxed writes are allowed. */
  writeForbidden?: RegExp;
  /** `-c key=value` overrides refused in the same two situations (the regex is tested against `key=value`). */
  forbiddenConfigKey?: RegExp;
}

/**
 * One gate for user `extra_args` of every adapter: readonly runs refuse anything that widens them, and write runs refuse
 * sandbox- or approval-weakening flags while `allow_unsandboxed_write` is not true, so the setting cannot be bypassed by
 * a flag such as `--yolo` or `-s danger-full-access`.
 */
export function assertSandboxExtraArgs(label: string, extraArgs: readonly string[], policy: SandboxArgsPolicy): void {
  const readonly = policy.mode === "readonly";
  if (!readonly && policy.allowUnsandboxedWrite === true) return;
  const forbidden = readonly ? policy.readonlyForbidden : policy.writeForbidden;
  if (forbidden) assertNoForbiddenReadonlyArgs(label, extraArgs, forbidden, readonly);
  if (policy.forbiddenConfigKey) assertNoForbiddenReadonlyConfigOverrides(label, extraArgs, policy.forbiddenConfigKey, readonly);
}

/** Last value a flag takes in `args`, in either `--flag value` or `--flag=value` spelling; the CLI honors the last one. */
export function lastFlagValue(args: readonly string[], flags: readonly string[]): string | undefined {
  let value: string | undefined;
  args.forEach((arg, index) => {
    if (flags.includes(arg)) value = args[index + 1];
    else {
      const flag = flags.find((candidate) => arg.startsWith(`${candidate}=`));
      if (flag) value = arg.slice(flag.length + 1);
    }
  });
  return value;
}

/** "streaming" only when the final args select the incremental format; any other final format is buffered. */
export function outputModeFor(args: readonly string[], flags: readonly string[], streamingValue: string): "streaming" | "buffered" {
  return lastFlagValue(args, flags) === streamingValue ? "streaming" : "buffered";
}

/** Diagnostic messages are capped so a noisy CLI cannot grow the parser without bound. */
export const MAX_DIAGNOSTIC_ERROR_BYTES = 16 * 1024;

/** Upper bound on kept diagnostic messages, whatever their size: a flood of tiny or empty chunks cannot grow the array. */
export const MAX_DIAGNOSTIC_MESSAGES = 500;

/**
 * Error messages kept for failure classification; later messages are clipped or dropped once the byte cap or the entry
 * cap is reached, and a message that is empty after clipping is not stored.
 */
export class BoundedMessages {
  private readonly messages: string[] = [];
  private bytes = 0;

  constructor(
    private readonly limitBytes = MAX_DIAGNOSTIC_ERROR_BYTES,
    private readonly maxEntries = MAX_DIAGNOSTIC_MESSAGES,
  ) {}

  push(message: string): void {
    const room = this.limitBytes - this.bytes;
    if (room <= 0 || this.messages.length >= this.maxEntries) return;
    const clipped = truncateUtf8(message, room).text;
    if (clipped === "") return;
    this.messages.push(clipped);
    this.bytes += Buffer.byteLength(clipped);
  }

  get length(): number {
    return this.messages.length;
  }

  values(): readonly string[] {
    return this.messages;
  }
}

/** Event types that carry tool traffic or conversation turns, never the final answer of a run. */
const NON_RESULT_EVENT_TYPES: ReadonlySet<string> = new Set(["tool_result", "tool_use", "tool_call", "assistant", "user", "system"]);

/** True for stream events that may hold a `result` field (e.g. a tool_result body) without being the run's final result. */
export function isNonResultEvent(value: unknown): boolean {
  return isObject(value) && typeof value.type === "string" && NON_RESULT_EVENT_TYPES.has(value.type);
}

/** Event types that carry the traffic of a tool call, never assistant text or a CLI error. */
const TOOL_TRAFFIC_EVENT_TYPES: ReadonlySet<string> = new Set([
  "tool_result", "tool_use", "tool_call", "tool_call_result", "tool_output", "tool_execution_start", "tool_execution_end",
  "function_call", "function_call_output", "tool",
]);

/** True for a parsed stream event that is tool traffic; undefined or non-object values are not. */
export function isToolTrafficEvent(value: unknown): boolean {
  return isObject(value) && typeof value.type === "string" && TOOL_TRAFFIC_EVENT_TYPES.has(value.type);
}

export function parseSemverTuple(version: string | undefined): [number, number, number] | undefined {
  if (!version) return undefined;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
}

/** A SemVer prerelease suffix (`-beta.1`) right after the numeric core. */
const SEMVER_PRERELEASE = /^\d+\.\d+(?:\.\d+)?-[0-9A-Za-z]/;

export function versionAtLeast(version: string | undefined, minimum: [number, number, number]): boolean | undefined {
  const parsed = parseSemverTuple(version);
  if (!parsed) return undefined;
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] !== minimum[i]) return parsed[i] > minimum[i];
  }
  // A prerelease sorts before the release it precedes: 1.4.2-beta.1 is older than 1.4.2.
  return !SEMVER_PRERELEASE.test(version!.trim());
}

export interface ExtractedJsonResult {
  text?: string;
  isError?: boolean;
  errorMessage?: string;
  forceAuthError?: boolean;
  usage?: UsageStats;
  details?: Record<string, unknown>;
  warnings?: string[];
}

export interface JsonResultParserSpec {
  label: string;
  /** Return extracted result if the parsed JSON value represents a final result payload, else undefined. */
  extract: (value: unknown) => ExtractedJsonResult | undefined;
  /** Optional exit-code classifier (e.g. Gemini exit 41 → AUTH_REQUIRED). */
  isAuthExitCode?: (exitCode: number | null) => boolean;
}

/** Generic parser for single-object JSON or JSONL-with-final-result CLIs. */
export function createJsonResultParser(spec: JsonResultParserSpec): AdapterStreamParser {
  const lines = new BoundedLines();
  const rawText = new BoundedLines();
  let latest: ExtractedJsonResult | undefined;

  return {
    pushLine(line: string): void {
      if (!line.trim()) {
        if (rawText.length) rawText.push(line);
        return;
      }
      const parsed = tryParseJson(line);
      // Tool traffic (a tool_result body, a tool_use input) is never diagnostics: a tool that prints "rate limit" must not
      // be able to drive failure classification or become the fallback answer.
      if (isToolTrafficEvent(parsed)) return;
      lines.push(line);
      if (parsed === undefined) {
        rawText.push(line);
        return;
      }
      const extracted = spec.extract(parsed);
      if (extracted) latest = extracted;
    },

    finish(input: FinishParseInput): ParsedAdapterResult {
      if (!latest && lines.length > 0) {
        const whole = tryParseJson(lines.text());
        if (whole !== undefined) latest = spec.extract(whole);
      }
      const warnings = [...streamWarnings(input), ...(latest?.warnings ?? [])];

      if (!latest) {
        if (!exitedCleanly(input)) {
          const code = spec.isAuthExitCode?.(input.exitCode) ? "AUTH_REQUIRED" : "NON_ZERO_EXIT";
          return classifiedFailure(spec.label, input, rawText.text().trim() || lines.text().trim() || undefined, code, { warnings });
        }
        return degradedOrParseError(spec.label, input, rawText.text() || lines.text(), "no structured result object");
      }

      const text = latest.text ?? "";
      if (latest.isError || !exitedCleanly(input)) {
        const code = latest.forceAuthError || spec.isAuthExitCode?.(input.exitCode) ? "AUTH_REQUIRED" : "NON_ZERO_EXIT";
        // Answer text only counts as diagnostics when the CLI flagged an error; with a bare non-zero exit it is model
        // prose (a review may mention "quota" or "rate limit") and must not drive failure classification.
        const reported = latest.isError ? latest.errorMessage || text || undefined : latest.errorMessage || undefined;
        return classifiedFailure(spec.label, input, reported, code, {
          usage: latest.usage,
          warnings,
          summary: text,
          details: latest.details,
        });
      }

      return {
        ok: true,
        summary: redactSecrets(text),
        ...(latest.usage ? { usage: latest.usage } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    },
  };
}

export interface NdjsonState<T> {
  data: T;
  structuredEvents: number;
  errors: string[];
  forceAuthError: boolean;
  usage?: UsageStats;
  warnings: string[];
  /** Bounded record of streamed text and tool steps; `onEvent` may feed it so `checkpoint()` has content. */
  tracker: ProgressTracker;
}

export interface NdjsonParserSpec<T> {
  label: string;
  initial: () => T;
  onEvent: (event: JsonObject, state: NdjsonState<T>) => void;
  extractText: (data: T) => string;
  hasFinalOutput?: (data: T) => boolean;
  isAuthExitCode?: (exitCode: number | null) => boolean;
}

/** Generic parser for NDJSON streaming CLIs (OpenCode, Kiro, Muse, Copilot, Kimi, etc.). */
export function createNdjsonParser<T>(
  spec: NdjsonParserSpec<T>,
): AdapterStreamParser & { checkpoint(): ProgressCheckpoint; progressEvents(): number } {
  const rawText = new BoundedLines();
  const state: NdjsonState<T> = {
    data: spec.initial(),
    structuredEvents: 0,
    errors: [],
    forceAuthError: false,
    warnings: [],
    tracker: new ProgressTracker(),
  };

  return {
    checkpoint(): ProgressCheckpoint {
      return state.tracker.snapshot();
    },

    progressEvents(): number {
      return state.tracker.events();
    },

    pushLine(line: string): void {
      if (!line.trim()) {
        if (rawText.length) rawText.push(line);
        return;
      }
      const parsed = tryParseJson(line);
      if (!isObject(parsed)) {
        rawText.push(line);
        return;
      }
      state.structuredEvents += 1;
      spec.onEvent(parsed, state);
    },

    finish(input: FinishParseInput): ParsedAdapterResult {
      const warnings = [...streamWarnings(input), ...state.warnings];
      const text = spec.extractText(state.data);

      if (state.errors.length > 0 || !exitedCleanly(input)) {
        const code = state.forceAuthError || spec.isAuthExitCode?.(input.exitCode) ? "AUTH_REQUIRED" : "NON_ZERO_EXIT";
        return classifiedFailure(spec.label, input, state.errors.join("\n").trim() || rawText.text().trim() || undefined, code, {
          usage: state.usage,
          warnings,
          summary: text,
        });
      }

      if (text || spec.hasFinalOutput?.(state.data)) {
        return {
          ok: true,
          summary: redactSecrets(text),
          ...(state.usage ? { usage: state.usage } : {}),
          ...(warnings.length ? { warnings } : {}),
        };
      }

      if (state.structuredEvents === 0) {
        return degradedOrParseError(spec.label, input, rawText.text(), "no JSONL events");
      }
      return degradedOrParseError(spec.label, input, rawText.text(), "no assistant text in stream");
    },
  };
}

/** Extracts text from string or Claude/OpenAI-style content block arrays. */
export function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (!isObject(block)) return "";
      if (block.type === "text" || block.type === "output_text" || block.type === undefined) {
        return asString(block.text) ?? asString(block.content) ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

/** Extracts common Claude/Cursor/Droid-style `{ type: "result", result, is_error, usage }` objects. */
export function extractClaudeLikeResult(value: unknown): ExtractedJsonResult | undefined {
  let obj: JsonObject | undefined;
  if (isObject(value)) {
    if (isNonResultEvent(value)) return undefined;
    if (value.type === "result" || "result" in value || "is_error" in value || "final_output" in value || "response" in value) {
      obj = value;
    }
  } else if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i -= 1) {
      const item: unknown = value[i];
      if (isObject(item) && !isNonResultEvent(item) && (item.type === "result" || "result" in item)) {
        obj = item;
        break;
      }
    }
  }
  if (!obj) return undefined;

  const usageObj = isObject(obj.usage) ? obj.usage : undefined;
  const usage = usageObj
    ? compactUsage({
      input_tokens: asNumber(usageObj.input_tokens) ?? asNumber(usageObj.input) ?? asNumber(usageObj.prompt_tokens),
      output_tokens: asNumber(usageObj.output_tokens) ?? asNumber(usageObj.output) ?? asNumber(usageObj.completion_tokens),
      cached_input_tokens: asNumber(usageObj.cache_read_input_tokens) ?? asNumber(usageObj.cached_input_tokens) ?? asNumber(usageObj.cache_read_tokens),
      cost_usd: asNumber(obj.total_cost_usd) ?? asNumber(obj.cost_usd) ?? asNumber(usageObj.cost_usd),
    })
    : undefined;

  const text = asString(obj.result) ?? asString(obj.final_output) ?? asString(obj.response) ?? asString(obj.output) ?? asString(obj.text) ?? "";
  const subtype = asString(obj.subtype) ?? "";
  const status = asString(obj.status)?.toUpperCase();
  const errorField = isObject(obj.error) ? asString(obj.error.message) ?? JSON.stringify(obj.error) : asString(obj.error);
  const isError = obj.is_error === true || subtype.startsWith("error") || status === "ERROR" || Boolean(errorField);

  return {
    text,
    isError,
    errorMessage: errorField || (isError ? (text || (subtype ? `result subtype ${subtype}` : undefined)) : undefined),
    usage,
    details: subtype ? { subtype, is_error: isError } : undefined,
  };
}
