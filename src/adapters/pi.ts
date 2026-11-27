import type { HarnessConfig, ModelConfig } from "../config/schema.js";
import { redactSecrets } from "../logging.js";
import { ProgressTracker } from "../runtime/checkpoint.js";
import type { HarnessHealth, ProgressCheckpoint, RunMode, SecurityGuarantee, UsageStats } from "../types.js";
import { BoundedMessages, assertNoForbiddenReadonlyArgs, outputModeFor } from "./parsers.js";
import {
  BoundedLines,
  BoundedText,
  DEFAULT_PROBE_TIMEOUT_MS,
  asNumber,
  asString,
  classifiedFailure,
  degradedOrParseError,
  execProbe,
  exitedCleanly,
  healthNow,
  isExplicitEffort,
  isObject,
  mapEffortWith,
  probeBinaryAndVersion,
  requireLaunch,
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

const LABEL = "Pi";
const SYSTEM_PROMPT_FILE = "pi-system.txt";
const READONLY_TOOLS = "read,grep,find,ls";
/** Tool, extension and MCP switches widen the tool set; `--export` writes the session to a file. */
const FORBIDDEN_READONLY_ARGS = /^(?:--tools|-t|--extension|-e|--mcp|--export)(?:=|$)/;
export const PI_UNSANDBOXED_WRITE_WARNING =
  "Pi write mode runs without an OS filesystem sandbox (unsandboxed). Prefer isolation='worktree'.";
const FAILED_STOP_REASONS = new Set(["error", "aborted", "failed"]);
const EFFORT_SYNONYMS: Record<string, string> = {
  none: "off",
  "extra-high": "xhigh",
  "x-high": "xhigh",
  maximum: "max",
};

/**
 * Pi auth and model routing are per upstream provider; the probe and the invocation must name the same one.
 * A model's own `cli_provider` wins over the harness default; the probe has no model and uses the default alone.
 */
function resolveUpstreamProvider(harness: HarnessConfig, model?: ModelConfig): string | undefined {
  return model?.cli_provider ?? harness.default_upstream_provider;
}

function mapAuthCheck(stdout: string): { status: HarnessHealth["auth_status"]; note?: string } {
  const parsed = tryParseJson(stdout);
  const status = isObject(parsed) ? asString(parsed.status) : undefined;
  switch (status) {
    case "ready":
      return { status: "ready" };
    case "not_ready":
      return { status: "unauthenticated", note: "Pi has no credentials for the upstream provider; run `pi auth login`." };
    case "invalid":
      return { status: "unauthenticated", note: "Pi reports invalid credentials for the upstream provider." };
    default:
      return { status: "unknown", note: "Could not parse `pi auth check` output." };
  }
}

interface AssistantMessage {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is JsonObject => isObject(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

class PiStreamParser implements AdapterStreamParser {
  private readonly tracker = new ProgressTracker();
  private readonly rawText = new BoundedLines();
  private structuredEvents = 0;
  private lastAssistant?: AssistantMessage;
  /** Streamed text of the turn in progress: kept so a run cut off before `message_end` still returns what was received. */
  private readonly partialText = new BoundedText();
  private aborted = false;
  private readonly errors = new BoundedMessages();
  private usage?: UsageStats;

  pushLine(line: string): void {
    if (!line.trim()) {
      if (this.rawText.length) this.rawText.push(line);
      return;
    }
    const event = tryParseJson(line);
    if (!isObject(event) || typeof event.type !== "string") {
      this.rawText.push(line);
      return;
    }
    this.structuredEvents += 1;
    switch (event.type) {
      case "session":
        this.tracker.setSessionId(asString(event.sessionId) ?? asString(event.id));
        break;
      case "message_update":
        this.trackPartialText(event);
        break;
      case "tool_execution_start":
        this.tracker.recordToolStart(
          asString(event.toolName) ?? "tool", safeToolTarget(event.args), asString(event.toolCallId), safeToolVariant(event.args),
        );
        break;
      case "tool_execution_end":
        this.tracker.recordToolEnd(asString(event.toolCallId) ?? asString(event.toolName) ?? "tool", event.isError !== true);
        break;
      case "message_end":
        // Only finalized messages count; message_update carries partial usage snapshots.
        if (isObject(event.message) && event.message.role === "assistant") {
          this.recordAssistant(event.message);
          this.partialText.clear();
          // The finalized text replaces the streamed partial of this turn, so no delta is counted twice.
          this.tracker.setText(textOf(event.message.content));
          this.tracker.noteTurn();
        }
        break;
      case "agent_settled":
        if (event.aborted === true) this.aborted = true;
        break;
      case "error":
        this.errors.push(asString(event.message) ?? asString(event.errorMessage) ?? "unknown error");
        break;
      default:
        break;
    }
  }

  /** Streamed text for the checkpoint only; the final answer still comes from the finalized message_end. */
  private trackPartialText(event: JsonObject): void {
    const snapshot = isObject(event.message) && event.message.role === "assistant" ? textOf(event.message.content) : "";
    if (snapshot) {
      this.tracker.setText(snapshot);
      this.partialText.replace(snapshot);
      return;
    }
    const streamed = isObject(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
    const delta = streamed?.type === "text_delta" ? asString(streamed.delta) : undefined;
    if (delta) {
      this.tracker.appendText(delta);
      this.partialText.append(delta);
    }
    // Reasoning leaves nothing for the checkpoint, but a model that is only thinking is working, not idle.
    if (streamed?.type === "thinking_delta" && asString(streamed.delta)) this.tracker.noteActivity();
  }

  checkpoint(): ProgressCheckpoint {
    return this.tracker.snapshot();
  }

  progressEvents(): number {
    return this.tracker.events();
  }

  private recordAssistant(message: JsonObject): void {
    this.lastAssistant = {
      // An empty finalized message keeps the text that was streamed for the turn.
      text: textOf(message.content) || this.partialText.text(),
      stopReason: asString(message.stopReason),
      errorMessage: asString(message.errorMessage),
    };
    if (!isObject(message.usage)) return;
    const usage = message.usage;
    const cost = isObject(usage.cost) ? asNumber(usage.cost.total) : undefined;
    const total = this.usage ?? {};
    this.usage = {
      input_tokens: (total.input_tokens ?? 0) + (asNumber(usage.input) ?? 0),
      output_tokens: (total.output_tokens ?? 0) + (asNumber(usage.output) ?? 0),
      cached_input_tokens: (total.cached_input_tokens ?? 0) + (asNumber(usage.cacheRead) ?? 0),
      ...(cost !== undefined || total.cost_usd !== undefined ? { cost_usd: (total.cost_usd ?? 0) + (cost ?? 0) } : {}),
    };
  }

  finish(input: FinishParseInput): ParsedAdapterResult {
    const warnings = streamWarnings(input);
    const last = this.lastAssistant;
    // A run cut off mid-turn has streamed text but no finalized message.
    const summary = last?.text ?? this.partialText.text();
    const stopReason = last?.stopReason;
    const failedStop = stopReason !== undefined && FAILED_STOP_REASONS.has(stopReason);

    // Pi exits 0 on provider/model errors in --mode json, so event state decides.
    if (this.aborted || failedStop || last?.errorMessage || this.errors.length > 0) {
      const message = [last?.errorMessage, ...this.errors.values()].filter(Boolean).join("\n") ||
        (this.aborted ? "run was aborted" : `stopReason ${JSON.stringify(stopReason)}`);
      return classifiedFailure(LABEL, input, message, "NON_ZERO_EXIT", {
        usage: this.usage,
        warnings,
        summary,
        details: { stop_reason: stopReason, aborted: this.aborted },
      });
    }
    if (!exitedCleanly(input)) {
      return classifiedFailure(LABEL, input, this.rawText.text().trim() || undefined, "NON_ZERO_EXIT", { usage: this.usage, warnings, summary });
    }
    if (last) {
      if (stopReason === "length") warnings.push("Pi stopped at the output length limit; the answer may be cut off.");
      return {
        ok: true,
        summary: redactSecrets(last.text),
        ...(this.usage ? { usage: this.usage } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    }
    if (this.structuredEvents === 0) return degradedOrParseError(LABEL, input, this.rawText.text(), "no JSONL events");
    return degradedOrParseError(LABEL, input, this.partialText.text(), "no finalized assistant message");
  }
}

export class PiAdapter implements CliAdapter {
  readonly driver = "pi" as const;
  readonly securityGuarantees: Record<RunMode, SecurityGuarantee> = {
    readonly: "tool_allowlist",
    write: "unsandboxed",
  };

  mapEffort(effort: string): string {
    return mapEffortWith(EFFORT_SYNONYMS, effort);
  }

  async probe(harnessId: string, harness: HarnessConfig, options: { timeoutMs?: number } = {}): Promise<HarnessHealth> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const base = { harnessId, harness, driver: this.driver, securityGuarantees: this.securityGuarantees };
    const binary = await probeBinaryAndVersion(base, timeoutMs);
    if (binary.health) return binary.health;

    const provider = resolveUpstreamProvider(harness);
    let auth: { status: HarnessHealth["auth_status"]; note?: string };
    if (provider) {
      // Never pass --credentials: the probe must not print secrets.
      const check = await execProbe(
        binary.binaryPath!,
        ["auth", "check", "--provider", provider, "--json", "--no-refresh"],
        timeoutMs,
      );
      auth = check.timedOut ? { status: "unknown", note: "`pi auth check` timed out." } : mapAuthCheck(check.stdout);
      // A failed command cannot vouch for the credentials, even if it printed a ready-looking status.
      if (!check.ok && !check.timedOut && auth.status === "ready") {
        auth = { status: "unknown", note: `\`pi auth check\` exited with ${check.exitCode ?? "no exit code"}, so its "ready" status is not trusted.` };
      }
    } else {
      auth = {
        status: "unknown",
        note: "Pi auth is per upstream provider; set harness.default_upstream_provider to enable an auth check.",
      };
    }

    return healthNow(base, {
      installed: true,
      binary_path: binary.binaryPath,
      version: binary.version,
      auth_status: auth.status,
      ...(auth.note ? { note: auth.note } : {}),
    });
  }

  async buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation> {
    const nativeEffort = this.mapEffort(input.effort);
    const launch = requireLaunch(input.harness.binary);
    const provider = resolveUpstreamProvider(input.harness, input.model);
    // A "provider/model" cli_model already names its provider; only the harness-wide default must not stack on top of it.
    const alreadyQualified = input.model.cli_provider === undefined && input.model.cli_model.includes("/");
    const modelSpec = provider && !alreadyQualified ? `${provider}/${input.model.cli_model}` : input.model.cli_model;
    const tempFiles: string[] = [];
    const warnings: string[] = [];
    const args = [
      "-p",
      "--mode", "json",
      "--no-session",
      "--model", modelSpec,
      ...(isExplicitEffort(nativeEffort) ? ["--thinking", nativeEffort] : []),
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
    ];
    if (!input.inheritMcp || input.mode === "readonly") args.push("--no-mcp");

    if (input.systemContext) {
      // Pi treats --append-system-prompt values as paths when they match a file, so always pass a file.
      const systemFile = await writePrivateFile(input.jobDir, SYSTEM_PROMPT_FILE, input.systemContext);
      tempFiles.push(systemFile);
      args.push("--append-system-prompt", systemFile);
    }

    const extraArgs = input.harness.extra_args ?? [];
    if (input.mode === "readonly") {
      assertNoForbiddenReadonlyArgs(LABEL, extraArgs, FORBIDDEN_READONLY_ARGS);
      args.push("--tools", READONLY_TOOLS);
    } else {
      warnings.push(PI_UNSANDBOXED_WRITE_WARNING);
    }

    args.push(...extraArgs);

    return {
      command: launch.command,
      args: [...launch.prefixArgs, ...args],
      // The prompt goes through stdin only, so Pi's @file argv expansion can never trigger.
      stdin: input.prompt,
      // extra_args may switch Pi to a non-JSON mode; only the final args decide whether events stream.
      outputMode: outputModeFor(args, ["--mode"], "json"),
      tempFiles,
      warnings,
      nativeEffort,
    };
  }

  createStreamParser(): AdapterStreamParser {
    return new PiStreamParser();
  }
}
