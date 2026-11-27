import type { HarnessConfig } from "../config/schema.js";
import { redactSecrets } from "../logging.js";
import { ProgressTracker } from "../runtime/checkpoint.js";
import { truncateUtf8 } from "../runtime/output.js";
import type { HarnessHealth, ProgressCheckpoint, RunMode, SecurityGuarantee, StructuredError, UsageStats } from "../types.js";
import { MAX_DIAGNOSTIC_ERROR_BYTES, assertSandboxExtraArgs, isNonResultEvent, outputModeFor } from "./parsers.js";
import {
  BoundedLines,
  BoundedText,
  DEFAULT_PROBE_TIMEOUT_MS,
  asNumber,
  asString,
  classifiedFailure,
  compactUsage,
  degradedOrParseError,
  execProbe,
  exitedCleanly,
  healthNow,
  isObject,
  isExplicitEffort,
  mapEffortWith,
  probeBinaryAndVersion,
  requireLaunch,
  safeDetailLabel,
  safeToolTarget,
  safeToolVariant,
  streamWarnings,
  tryParseJson,
  writePrivateFile,
  type JsonObject,
} from "./probe-utils.js";
import type {
  AdapterStreamParser,
  BuildInvocationInput,
  BuiltInvocation,
  CliAdapter,
  FinishParseInput,
  ParsedAdapterResult,
} from "./types.js";

const LABEL = "Claude Code";
const SYSTEM_PROMPT_FILE = "claude-system.txt";
const SETTINGS_FILE = "claude-settings.json";
const SUBAGENT_DEPTH_ENV = "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH";
const NATIVE_SUBAGENT_TOOLS = "Task,Agent";
const TOOL_RESULT_OMITTED = "[tool_result omitted from log]";
const READONLY_TOOLS = "Read,Glob,Grep";
const DISALLOWED_TOOLS_FLAGS = ["--disallowed-tools", "--disallowedTools"] as const;
/** Flags that would widen tools, permissions, MCP servers or settings beyond the readonly profile built below. */
const FORBIDDEN_READONLY_ARGS = new RegExp(`^(?:${[
  "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode", "--tools",
  "--allowedTools", "--allowed-tools", "--mcp-config", "--settings", ...DISALLOWED_TOOLS_FLAGS,
].join("|")})(?:=|$)`);
/**
 * Flags that drop Claude's permission checks or widen what a write run may touch beyond the edit-only profile built below
 * (a tool grant such as `--allowedTools Bash`, an extra writable directory); refused in write mode too unless unsandboxed
 * writes are allowed.
 */
const FORBIDDEN_WRITE_BYPASS_ARGS = new RegExp(`^(?:${[
  "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode", "--settings",
  "--tools", "--allowedTools", "--allowed-tools", "--add-dir",
].join("|")})(?:=|$)`);
/** `--mcp-config` loads MCP servers, and a stdio server is an arbitrary local process started with the user's privileges. */
const MCP_CONFIG_ARG = /^--mcp-config(?:=|$)/;
const EFFORT_SYNONYMS: Record<string, string> = {
  minimal: "low",
  "extra-high": "xhigh",
  "x-high": "xhigh",
  maximum: "max",
};

/**
 * Refuses `--mcp-config` in a write run whenever MCP isolation was requested (`inherit_mcp` is false) or the sandbox must hold
 * (`allow_unsandboxed_write` is not true): the flag would launch an MCP server process the run's policy never saw. The
 * readonly profile refuses it separately, whatever the settings.
 */
function assertNoWriteMcpConfig(input: BuildInvocationInput, userArgs: readonly string[]): void {
  if (input.mode !== "write" || (input.inheritMcp && input.allowUnsandboxedWrite === true)) return;
  const arg = userArgs.find((candidate) => MCP_CONFIG_ARG.test(candidate));
  if (arg === undefined) return;
  const error: StructuredError = {
    code: "SANDBOX_POLICY_VIOLATION",
    message: `${LABEL} extra_args contains ${JSON.stringify(arg)}, which can start an arbitrary local MCP server process with your privileges. ` +
      "It is refused in write mode unless inherit_mcp is true and allow_unsandboxed_write is true.",
    retryable: false,
  };
  throw error;
}

/** Adds the native subagent tools to every user-provided deny list, so the user's own denials stay and the tools go too. */
function denyNativeSubagentTools(args: readonly string[]): { args: string[]; merged: boolean } {
  const withTools = (value: string): string => {
    const tools = value.split(",").map((tool) => tool.trim()).filter(Boolean);
    return [...new Set([...tools, ...NATIVE_SUBAGENT_TOOLS.split(",")])].join(",");
  };
  let merged = false;
  const result: string[] = [];
  args.forEach((arg, index) => {
    const inline = DISALLOWED_TOOLS_FLAGS.find((flag) => arg.startsWith(`${flag}=`));
    if (inline) {
      merged = true;
      result.push(`${inline}=${withTools(arg.slice(inline.length + 1))}`);
      return;
    }
    const isFlag = (DISALLOWED_TOOLS_FLAGS as readonly string[]).includes(arg);
    const isFlagValue = index > 0 && (DISALLOWED_TOOLS_FLAGS as readonly string[]).includes(args[index - 1]) && !arg.startsWith("-");
    if (isFlag) merged = true;
    // The flag's first value carries the merged list; a flag without any value gets one.
    if (isFlagValue) result.push(withTools(arg));
    else {
      result.push(arg);
      const next = args[index + 1];
      if (isFlag && (next === undefined || next.startsWith("-"))) result.push(NATIVE_SUBAGENT_TOOLS);
    }
  });
  return { args: result, merged };
}

function parseAuthStatus(stdout: string): boolean | undefined {
  const parsed = tryParseJson(stdout);
  if (!isObject(parsed)) return undefined;
  for (const key of ["loggedIn", "authenticated", "logged_in"]) {
    if (typeof parsed[key] === "boolean") return parsed[key];
  }
  return undefined;
}

function claudeUsage(result: JsonObject): UsageStats | undefined {
  const usage = isObject(result.usage) ? result.usage : {};
  return compactUsage({
    input_tokens: asNumber(usage.input_tokens),
    output_tokens: asNumber(usage.output_tokens),
    cached_input_tokens: asNumber(usage.cache_read_input_tokens),
    cost_usd: asNumber(result.total_cost_usd) ?? asNumber(result.cost_usd),
  });
}

function describeDenials(denials: unknown[]): string {
  const tools = denials.map((denial) => (isObject(denial) ? asString(denial.tool_name) : undefined) ?? "unknown");
  return `Claude denied ${denials.length} tool call(s): ${[...new Set(tools)].join(", ")}.`;
}

/** Finds the `type: "result"` object in a JSON value (object or array of messages). */
function findResult(value: unknown): JsonObject | undefined {
  if (isObject(value)) {
    // A tool_result (or any other stream event) may carry a `result` field; it is never the run's final result.
    if (isNonResultEvent(value)) return undefined;
    return value.type === "result" || "result" in value || "is_error" in value ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item: unknown = value[index];
      if (isObject(item) && item.type === "result") return item;
    }
  }
  return undefined;
}

/** Event types that only `--output-format stream-json` emits; a lone `result` object is also valid legacy output. */
const STREAM_EVENT_TYPES: ReadonlySet<string> = new Set(["system", "assistant", "user"]);
const MAX_ASSISTANT_ERROR_BYTES = 2_048;

/** Messages of the `errors` array a result event carries (strings or `{ message }` objects), clipped to a byte budget. */
function resultErrorMessages(result: JsonObject): string {
  if (!Array.isArray(result.errors)) return "";
  const messages = (result.errors as unknown[])
    .map((entry) => (isObject(entry) ? asString(entry.message) : asString(entry)))
    .filter((message): message is string => message !== undefined && message.trim() !== "");
  return truncateUtf8(messages.join("\n"), MAX_DIAGNOSTIC_ERROR_BYTES).text;
}

function contentBlocks(event: JsonObject): JsonObject[] {
  const message = isObject(event.message) ? event.message : undefined;
  return Array.isArray(message?.content) ? message.content.filter(isObject) : [];
}

class ClaudeStreamParser implements AdapterStreamParser {
  private readonly lines = new BoundedLines();
  private readonly rawText = new BoundedLines();
  private readonly tracker = new ProgressTracker();
  private result?: JsonObject;
  private streamEvents = 0;
  private lastMessageId?: string;
  /** Text of the latest assistant message: its content blocks arrive as separate events and are joined here, bounded. */
  private readonly lastAssistantText = new BoundedText();
  private readonly assistantErrors: string[] = [];
  private assistantErrorBytes = 0;

  pushLine(line: string): void {
    if (!line.trim()) {
      if (this.rawText.length) this.rawText.push(line);
      return;
    }
    // Once stream-json events flow, every line is one event; keeping the raw lines would only copy tool output.
    if (this.streamEvents === 0) this.lines.push(line);
    const parsed = tryParseJson(line);
    if (parsed === undefined) {
      this.rawText.push(line);
      return;
    }
    if (isObject(parsed) && typeof parsed.type === "string") this.handleEvent(parsed);
    const found = findResult(parsed);
    if (found) this.result = found;
  }

  checkpoint(): ProgressCheckpoint {
    return this.tracker.snapshot();
  }

  progressEvents(): number {
    return this.tracker.events();
  }

  /** Drops tool_result bodies (file contents, command output) from stdout.log; every other line is kept verbatim. */
  sanitizeLogLine(line: string): string {
    if (!line.includes('"tool_result"') && !line.includes('"tool_use_result"')) return line;
    const event = tryParseJson(line);
    if (!isObject(event) || event.type !== "user") return line;
    const message = isObject(event.message) ? event.message : undefined;
    if (!message || !Array.isArray(message.content)) return line;
    let changed = false;
    const content = message.content.map((block: unknown) => {
      if (!isObject(block) || block.type !== "tool_result") return block;
      changed = true;
      return {
        type: "tool_result",
        ...(block.tool_use_id !== undefined ? { tool_use_id: block.tool_use_id } : {}),
        ...(block.is_error !== undefined ? { is_error: block.is_error } : {}),
        content: TOOL_RESULT_OMITTED,
      };
    });
    if (!changed) return line;
    // `tool_use_result` mirrors the same body at the event top level.
    const { tool_use_result: _omitted, ...rest } = event;
    return JSON.stringify({ ...rest, message: { ...message, content } });
  }

  private handleEvent(event: JsonObject): void {
    const type = event.type as string;
    if (STREAM_EVENT_TYPES.has(type)) this.streamEvents += 1;
    if (type === "system" && event.subtype === "init") {
      this.tracker.setSessionId(asString(event.session_id));
    } else if (type === "assistant") {
      this.handleAssistant(event);
    } else if (type === "user") {
      // Tool results only update the step status; their content is never stored or classified.
      for (const block of contentBlocks(event)) {
        const id = block.type === "tool_result" ? asString(block.tool_use_id) : undefined;
        if (id) this.tracker.recordToolEnd(id, block.is_error !== true);
      }
    } else if (type === "result") {
      this.tracker.setSessionId(asString(event.session_id));
    }
  }

  private handleAssistant(event: JsonObject): void {
    const message = isObject(event.message) ? event.message : {};
    const messageId = asString(message.id);
    // stream-json emits one assistant event per content block, all sharing one message id.
    const newMessage = messageId === undefined || messageId !== this.lastMessageId;
    if (newMessage) this.tracker.noteTurn();
    this.lastMessageId = messageId;
    const texts: string[] = [];
    for (const block of contentBlocks(event)) {
      if (block.type === "text" && typeof block.text === "string") {
        texts.push(block.text);
        this.tracker.appendText(block.text);
      } else if (block.type === "tool_use") {
        const name = asString(block.name) ?? "tool";
        this.tracker.recordToolStart(name, safeToolTarget(block.input), asString(block.id), safeToolVariant(block.input));
      }
    }
    if (texts.length > 0) {
      // Blocks of one message share its id and are concatenated; a new message replaces the previous one's text.
      if (newMessage) this.lastAssistantText.clear();
      this.lastAssistantText.append(texts.join(""));
    }
    const errorKind = asString(event.error);
    if (errorKind && this.assistantErrorBytes < MAX_ASSISTANT_ERROR_BYTES) {
      const detail = `${errorKind}${texts.length ? `: ${texts.join("")}` : ""}`;
      const clipped = truncateUtf8(detail, MAX_ASSISTANT_ERROR_BYTES - this.assistantErrorBytes).text;
      this.assistantErrors.push(clipped);
      this.assistantErrorBytes += Buffer.byteLength(clipped);
    }
  }

  finish(input: FinishParseInput): ParsedAdapterResult {
    const streamMode = this.streamEvents > 0;
    // Pretty-printed or multi-line single JSON payload.
    if (!this.result && !streamMode && this.lines.length > 1) this.result = findResult(tryParseJson(this.lines.text()));
    const warnings = streamWarnings(input);
    const result = this.result;

    if (!result) {
      if (!exitedCleanly(input)) {
        // In stream-json mode the raw lines carry tool output (file contents), so only explicit CLI/assistant errors
        // and stderr may reach the classifier; otherwise a file that mentions "rate limit" would trigger a cooldown.
        const reported = streamMode
          ? this.assistantErrors.join("\n").trim() || this.rawText.text().trim() || undefined
          : this.rawText.text().trim() || this.lines.text().trim() || undefined;
        return classifiedFailure(LABEL, input, reported, "NON_ZERO_EXIT", { warnings, summary: streamMode ? this.lastAssistantText.text() : undefined });
      }
      return degradedOrParseError(LABEL, input, streamMode ? this.lastAssistantText.text() : this.rawText.text(), "no result object");
    }

    const usage = claudeUsage(result);
    // An empty or missing final result must not discard the assistant text already streamed.
    const resultText = asString(result.result) ?? "";
    const text = resultText || this.lastAssistantText.text();
    const subtype = asString(result.subtype) ?? "";
    const denials = Array.isArray(result.permission_denials) ? result.permission_denials : [];
    if (denials.length > 0) warnings.push(describeDenials(denials));
    const isError = result.is_error === true || subtype.startsWith("error");

    if (isError || !exitedCleanly(input)) {
      // The answer text is only diagnostic evidence when the CLI itself flagged an error; with a bare non-zero exit
      // it is model prose (a review may mention "quota" or "rate limit") and must not drive failure classification.
      const assistantErrors = this.assistantErrors.join("\n").trim();
      // error_during_execution carries its reasons in `errors[]` with an empty `result`; earlier assistant errors are the last resort.
      const message = isError
        ? resultText || resultErrorMessages(result) || assistantErrors || (subtype ? `result subtype ${subtype}` : undefined)
        : assistantErrors || undefined;
      return classifiedFailure(LABEL, input, message, "NON_ZERO_EXIT", {
        usage,
        warnings,
        summary: text,
        details: {
          subtype: safeDetailLabel(subtype),
          is_error: result.is_error === true,
          ...(denials.length > 0 ? { permission_denials: denials.length } : {}),
        },
      });
    }

    return {
      ok: true,
      summary: redactSecrets(text),
      ...(usage ? { usage } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }
}

export class ClaudeAdapter implements CliAdapter {
  readonly driver = "claude" as const;
  readonly securityGuarantees: Record<RunMode, SecurityGuarantee> = {
    readonly: "tool_allowlist",
    write: "tool_allowlist",
  };

  mapEffort(effort: string): string {
    return mapEffortWith(EFFORT_SYNONYMS, effort);
  }

  async probe(harnessId: string, harness: HarnessConfig, options: { timeoutMs?: number } = {}): Promise<HarnessHealth> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const base = { harnessId, harness, driver: this.driver, securityGuarantees: this.securityGuarantees };
    const binary = await probeBinaryAndVersion(base, timeoutMs);
    if (binary.health) return binary.health;

    const auth = await execProbe(binary.binaryPath!, ["auth", "status", "--json"], timeoutMs);
    const loggedIn = parseAuthStatus(auth.stdout);
    let authStatus: HarnessHealth["auth_status"] = "unknown";
    let note: string | undefined;
    if (loggedIn === true && auth.ok) authStatus = "ready";
    else if (loggedIn === false) {
      authStatus = "unauthenticated";
      note = "Run `claude auth login` (or `claude /login`) to authenticate.";
    } else if (auth.timedOut) note = "`claude auth status --json` timed out.";
    else note = `Could not determine auth status (exit ${auth.exitCode ?? "n/a"}).`;

    return healthNow(base, {
      installed: true,
      binary_path: binary.binaryPath,
      version: binary.version,
      auth_status: authStatus,
      ...(note ? { note } : {}),
    });
  }

  async buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation> {
    const nativeEffort = this.mapEffort(input.effort);
    const tempFiles: string[] = [];
    const userArgs = input.harness.extra_args ?? [];
    assertSandboxExtraArgs(LABEL, userArgs, {
      mode: input.mode,
      allowUnsandboxedWrite: input.allowUnsandboxedWrite,
      readonlyForbidden: FORBIDDEN_READONLY_ARGS,
      writeForbidden: FORBIDDEN_WRITE_BYPASS_ARGS,
    });
    assertNoWriteMcpConfig(input, userArgs);
    const launch = requireLaunch(input.harness.binary);
    // stream-json lets a timed-out job keep its partial progress; extra_args may still pick another format.
    const formatChosen = userArgs.some((arg) => arg === "--output-format" || arg.startsWith("--output-format="));
    const args = [
      "-p",
      ...(formatChosen ? [] : ["--output-format", "stream-json", "--verbose"]),
      "--no-session-persistence",
      "--model", input.model.cli_model,
      ...(isExplicitEffort(nativeEffort) ? ["--effort", nativeEffort] : []),
    ];

    if (input.systemContext) {
      const systemFile = await writePrivateFile(input.jobDir, SYSTEM_PROMPT_FILE, input.systemContext);
      tempFiles.push(systemFile);
      args.push("--append-system-prompt-file", systemFile);
    }

    if (input.mode === "readonly") {
      args.push(
        "--tools", READONLY_TOOLS,
        "--restricted",
        "--permission-mode", "plan",
        "--permission-prompts", "none",
        "--strict-mcp-config",
        "--disallowed-tools", "mcp__*",
      );
    } else {
      args.push(
        "--permission-mode", input.harness.write_permission_mode ?? "acceptEdits",
        "--permission-prompts", "none",
      );
      if (!input.inheritMcp) args.push("--strict-mcp-config");
    }

    let extraArgs = userArgs;
    const control = input.nativeSubagents;
    const lowersDepth = control !== undefined && control.discoveredMaxDepth !== undefined && control.maxDepth < control.discoveredMaxDepth;
    // Depth 0 means no native subagents at all, whether the policy or the configured depth limit asks for it.
    const disablesSubagents = control !== undefined && (control.policy === "off" || control.maxDepth === 0);
    const clampDepth = input.mode === "write" && control !== undefined && (disablesSubagents || lowersDepth);
    let envOverrides: Record<string, string> | undefined;
    if (clampDepth) {
      const depth = String(disablesSubagents ? 0 : control.maxDepth);
      // The env block of the user's settings.json outranks the process environment, so the clamp also goes through
      // a per-job `--settings` file; the environment variable stays as a second layer.
      const settingsFile = await writePrivateFile(input.jobDir, SETTINGS_FILE, JSON.stringify({ env: { [SUBAGENT_DEPTH_ENV]: depth } }));
      tempFiles.push(settingsFile);
      args.push("--settings", settingsFile);
      if (disablesSubagents) {
        const denied = denyNativeSubagentTools(userArgs);
        extraArgs = denied.args;
        if (!denied.merged) args.push("--disallowed-tools", NATIVE_SUBAGENT_TOOLS);
      }
      envOverrides = { [SUBAGENT_DEPTH_ENV]: depth };
    }
    args.push(...extraArgs);

    return {
      command: launch.command,
      args: [...launch.prefixArgs, ...args],
      stdin: input.prompt,
      // extra_args may force buffered `json` output; only the final args decide whether events stream.
      outputMode: outputModeFor(args, ["--output-format"], "stream-json"),
      ...(envOverrides ? { envOverrides } : {}),
      tempFiles,
      warnings: [],
      nativeEffort,
    };
  }

  createStreamParser(): AdapterStreamParser {
    return new ClaudeStreamParser();
  }
}
