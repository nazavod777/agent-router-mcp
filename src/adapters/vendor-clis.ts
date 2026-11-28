import type { HarnessConfig } from "../config/schema.js";
import { DRIVER_METADATA, type DriverKind } from "../drivers.js";
import type { HarnessHealth, ProgressCheckpoint, RunMode, SecurityGuarantee } from "../types.js";
import {
  BoundedMessages, assertArgvPromptFits, assertCommandLineFits, assertSandboxExtraArgs, createJsonResultParser, createNdjsonParser,
  extractClaudeLikeResult, extractContentText, isToolTrafficEvent, outputModeFor, versionAtLeast, withInlineSystemContext,
  writePromptFile, type SandboxArgsPolicy,
} from "./parsers.js";
import {
  adapterError, asNumber, asString, binaryStem, compactUsage, execProbe, harnessLookup, healthNow, isExplicitEffort, isObject,
  mapEffortWith, PARSER_BUFFER_LIMIT_BYTES, probeBinaryAndVersion, requireLaunch, resolveBinary, tryParseJson,
  verifyBinaryIdentity, type IdentityVerdict, type JsonObject,
} from "./probe-utils.js";
import type { AdapterStreamParser, BuildInvocationInput, BuiltInvocation, CliAdapter } from "./types.js";

/** Cursor's own build ids look like `2025.09.18-7ae6800`; a generic `agent` binary does not print one. */
const CURSOR_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}-[a-f0-9]+$/;
const FX_HELP_PATTERN = /\bfx\s+ask\b|\bfx\s+acp\b/i;
/** Names shared with unrelated programs (a JSON viewer `fx`, any `agent`): they are verified before anything is run. */
const AMBIGUOUS_CURSOR_STEM = "agent";
const AMBIGUOUS_FX_STEM = "fx";
/** A failed read of the credential store says nothing about whether the account is logged in. */
const STORAGE_ERROR_PATTERN = /keyring|keychain|credential\s+store|permission\s+denied|EACCES|EPERM|EIO|ENOENT|ENOSPC|I\/O\s+error|database\s+is\s+locked|(?:failed|unable|cannot|could\s+not)\s+(?:to\s+)?(?:read|load|open|access|decrypt)/i;

/** Decides from `--help` output (and a timeout) whether a binary is the expected program. */
async function identifyByHelp(path: string, timeoutMs: number, matches: (help: string) => boolean): Promise<IdentityVerdict> {
  const help = await execProbe(path, ["--help"], timeoutMs);
  // No answer at all (timeout, spawn failure) cannot tell the program from another one with the same name.
  if (help.timedOut || help.exitCode === null) return "inconclusive";
  return matches(`${help.stdout}\n${help.stderr}`) ? "verified" : "mismatch";
}

async function identifyCursor(path: string, version: string | undefined, timeoutMs: number): Promise<IdentityVerdict> {
  if (CURSOR_VERSION_PATTERN.test(version ?? "")) return "verified";
  return identifyByHelp(path, timeoutMs, (help) => /\bcursor\b/i.test(help));
}

async function identifyFx(path: string, timeoutMs: number): Promise<IdentityVerdict> {
  return identifyByHelp(path, timeoutMs, (help) => FX_HELP_PATTERN.test(help));
}

/** Shared lifecycle for the experimental CLIs. Each driver owns its actual command and access policy. */
export abstract class ExperimentalAdapter implements CliAdapter {
  abstract readonly driver: DriverKind;
  readonly securityGuarantees: Record<RunMode, SecurityGuarantee> = { readonly: "tool_allowlist", write: "unsandboxed" };
  protected get label(): string { return DRIVER_METADATA[this.driver].label; }
  protected readonly authEnv: readonly string[] = [];

  mapEffort(_effort: string): string { return "default"; }

  protected async probeDetails(_path: string, _version: string | undefined, _timeoutMs: number): Promise<Partial<HarnessHealth>> {
    // An empty or blank value is not a credential.
    return { auth_status: this.authEnv.some((key) => Boolean(process.env[key]?.trim())) ? "ready" : "unknown" };
  }

  async probe(harnessId: string, harness: HarnessConfig, { timeoutMs = DRIVER_METADATA[this.driver].probeTimeoutMs } = {}) {
    const base = { harnessId, harness, driver: this.driver, securityGuarantees: this.securityGuarantees };
    const binary = await probeBinaryAndVersion(base, timeoutMs);
    if (binary.health && (!binary.health.installed || this.driver !== "cursor")) return binary.health;
    // A generic "agent" must still prove its identity if its version command failed.
    const path = (binary.binaryPath ?? binary.health?.binary_path)!;
    return healthNow(base, {
      ...binary.health, installed: true, binary_path: path, version: binary.version,
      ...await this.probeDetails(path, binary.version, timeoutMs),
    });
  }

  protected invocation(input: BuildInvocationInput, args: string[]): BuiltInvocation {
    // An unresolvable binary is a CLI_NOT_FOUND failure here: the raw string is never spawned in the job's directory.
    const launch = requireLaunch(input.harness.binary);
    return {
      command: launch.command, args: [...launch.prefixArgs, ...args],
      stdin: "", tempFiles: [], warnings: [], nativeEffort: this.mapEffort(input.effort),
    };
  }

  /** Runs the readonly / write extra_args gate with this adapter's flag lists. */
  protected assertExtraArgs(input: BuildInvocationInput, readonlyForbidden: RegExp, writeForbidden?: RegExp): void {
    const policy: SandboxArgsPolicy = {
      mode: input.mode, allowUnsandboxedWrite: input.allowUnsandboxedWrite, readonlyForbidden, writeForbidden,
    };
    assertSandboxExtraArgs(this.label, input.harness.extra_args ?? [], policy);
  }

  /** The finished invocation, after the platform's total command-line limit was checked. */
  protected finalize(result: BuiltInvocation): BuiltInvocation {
    assertCommandLineFits(this.label, result.command, result.args);
    return result;
  }

  /**
   * Verifies, on the run path too, that an ambiguous binary name is the program it should be. The verdict is bound to the
   * resolved absolute path and cached by path, mtime and size; an unrelated or unverifiable binary is never executed.
   */
  protected async assertBinaryIdentity(
    input: BuildInvocationInput, stem: string, kind: string, identify: (path: string, timeoutMs: number) => Promise<IdentityVerdict>,
  ): Promise<void> {
    const path = resolveBinary(input.harness.binary, harnessLookup());
    if (path === undefined || binaryStem(path) !== stem) return;
    const timeoutMs = DRIVER_METADATA[this.driver].probeTimeoutMs;
    const verdict = await verifyBinaryIdentity(kind, path, () => identify(path, timeoutMs));
    if (verdict === "verified") return;
    throw adapterError("CLI_NOT_FOUND", verdict === "mismatch"
      ? `Binary ${JSON.stringify(path)} is not ${this.label}, so it was not run; set harness.binary to the absolute path of ${this.label}.`
      : `Binary ${JSON.stringify(path)} did not answer \`--help\`, so it could not be verified as ${this.label} and was not run.`, false);
  }

  protected warnUnsandboxed(result: BuiltInvocation): void {
    result.warnings.push(`${this.label} write mode runs without an OS filesystem sandbox (unsandboxed). Prefer isolation='worktree'.`);
  }

  protected argvPrompt(input: BuildInvocationInput): string {
    const prompt = withInlineSystemContext(input.prompt, input.systemContext).text;
    assertArgvPromptFits(this.label, prompt);
    return prompt;
  }

  abstract buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation>;

  createStreamParser(): AdapterStreamParser {
    return createJsonResultParser({ label: this.label, extract: extractClaudeLikeResult });
  }
}

function eventText(value: unknown): string {
  if (isObject(value)) return extractContentText(value.text) || extractContentText(value.content) || extractContentText(value.delta);
  return extractContentText(value);
}

function streamUsage(event: JsonObject, type: string | undefined) {
  const run = isObject(event.run) ? event.run : {};
  const usage = event.usage ?? run.usage ?? (type === "run.usage" ? event.data ?? event : undefined);
  if (!isObject(usage)) return;
  return compactUsage({
    input_tokens: asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens) ?? asNumber(usage.input),
    output_tokens: asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens) ?? asNumber(usage.output),
    cached_input_tokens: asNumber(usage.cached_input_tokens) ?? asNumber(usage.cache_read_tokens),
    cost_usd: asNumber(usage.cost_usd),
  });
}

/** The message of an error value: a plain string, `{ message }`, or the nested `{ data: { message } }` some CLIs wrap it in. */
function structuredErrorMessage(error: unknown): string | undefined {
  if (!isObject(error)) return asString(error);
  return asString(error.message) ?? (isObject(error.data) ? asString(error.data.message) : undefined);
}

export function createAssistantEventParser(
  label: string,
): AdapterStreamParser & { checkpoint(): ProgressCheckpoint; progressEvents(): number } {
  return createNdjsonParser({
    label,
    initial: () => ({ text: "", bytes: 0, errors: new BoundedMessages() }),
    extractText: (data) => data.text,
    onEvent(event, state) {
      const type = asString(event.type) ?? asString(event.event);
      const message = isObject(event.message) ? event.message : {};
      const payload = isObject(event.data) ? event.data : event;
      // Tool traffic (a tool_result body, a failed tool's is_error) is neither the answer nor an error of the run itself.
      if (isToolTrafficEvent(event)) return;
      const role = event.role ?? message.role;
      if (role !== undefined && role !== "assistant") return;
      state.usage = streamUsage(event, type) ?? state.usage;
      if (type === "error" || event.error || event.is_error === true) {
        const error = event.error ?? payload.error;
        // Every error event is kept (bounded), so a later generic one cannot hide the message that names the cause.
        state.data.errors.push(structuredErrorMessage(error) ?? asString(event.message) ?? `${label} reported an error.`);
        state.errors = [...state.data.errors.values()];
        return;
      }

      // Final snapshots replace deltas already received for the answer.
      // Only an explicit result/message event (or a typeless snapshot) is final; a `result` key on any other typed event is not.
      const final = type === "result" || type === "message" || type === "assistant.message"
        || (!type && (role === "assistant" || event.result !== undefined || event.text !== undefined || event.content !== undefined));
      let text: string;
      if (final && event.delta === undefined) {
        text = eventText(event.result) || eventText(message) || eventText(payload) || eventText(event.message);
        if (!text) return;
        state.tracker.setText(text);
        state.data.text = "";
        state.data.bytes = 0;
      } else if (["text", "delta", "content", "RunOutputDelta", "assistant", "assistant.message_delta"].includes(type ?? "") || event.delta !== undefined) {
        text = eventText(payload.delta) || eventText(payload.deltaContent) || eventText(payload) || eventText(event.data);
        state.tracker.appendText(text);
      } else return;

      const bytes = Buffer.byteLength(text);
      if (state.data.bytes + bytes > PARSER_BUFFER_LIMIT_BYTES) {
        if (!state.warnings.length) state.warnings.push(`${label} text exceeded the parser buffer limit; output was truncated.`);
        return;
      }
      state.data.text += text;
      state.data.bytes += bytes;
    },
  });
}

export class CursorAdapter extends ExperimentalAdapter {
  readonly driver = "cursor" as const;

  protected override async probeDetails(path: string, version: string | undefined, timeoutMs: number): Promise<Partial<HarnessHealth>> {
    if (binaryStem(path) !== AMBIGUOUS_CURSOR_STEM) return {};
    const verdict = await identifyCursor(path, version, timeoutMs);
    // No output at all (timeout or spawn failure) cannot tell Cursor from another `agent`; do not call it a different tool.
    if (verdict === "inconclusive") {
      return { auth_status: "unknown", probe_inconclusive: true, note: "`agent --help` did not answer, so the binary could not be identified as Cursor CLI." };
    }
    if (verdict === "verified") return {};
    return { installed: false, note: "Found generic 'agent' binary, not Cursor CLI; set harness.binary to 'cursor-agent'." };
  }

  async buildInvocation(input: BuildInvocationInput) {
    const prompt = this.argvPrompt(input);
    this.assertExtraArgs(input, /^(--force|--yolo|--approve-mcps|--mode)(=|$)/, /^(--yolo|--approve-mcps)(=|$)/);
    await this.assertBinaryIdentity(input, AMBIGUOUS_CURSOR_STEM, "cursor", async (path, timeoutMs) => {
      const version = await execProbe(path, ["--version"], timeoutMs);
      return identifyCursor(path, version.ok ? `${version.stdout} ${version.stderr}`.trim().split(/\s+/)[0] : undefined, timeoutMs);
    });
    const result = this.invocation(input, ["-p", "--output-format", "json", "--model", input.model.cli_model, "--workspace", input.cwd]);
    if (input.mode === "readonly") {
      result.args.push("--mode", "plan");
    } else {
      result.args.push("--force", "--trust");
      this.warnUnsandboxed(result);
    }
    if (!input.inheritMcp || input.mode === "readonly") {
      result.warnings.push("Cursor CLI has no per-run MCP disable flag; configured MCP servers may remain loaded.");
    }
    result.args.push(...(input.harness.extra_args ?? []), "--", prompt);
    return this.finalize(result);
  }
}

export class GrokAdapter extends ExperimentalAdapter {
  readonly driver = "grok" as const;
  protected override readonly authEnv = ["XAI_API_KEY"];

  async buildInvocation(input: BuildInvocationInput) {
    assertArgvPromptFits(this.label, input.prompt);
    this.assertExtraArgs(input, /^(--always-approve|--sandbox)(=|$)/, /^(--always-approve|--sandbox)(=|$)/);
    const result = this.invocation(input, ["--no-alt-screen", "--no-auto-update", "--output-format", "json", "-m", input.model.cli_model]);
    const extra = input.harness.extra_args ?? [];
    if (input.mode === "readonly") {
      result.args.push("--sandbox", "read-only");
    } else {
      result.args.push("--sandbox", "workspace", "--always-approve");
      this.warnUnsandboxed(result);
    }
    if (!input.inheritMcp || input.mode === "readonly") result.warnings.push("Grok CLI may discover configured Claude or Cursor MCP servers.");
    if (input.systemContext) {
      const file = await writePromptFile(input.jobDir, "grok-system.txt", input.systemContext);
      result.tempFiles.push(file);
      result.args.push("--system-prompt-file", file);
    }
    result.args.push(...extra, `--single=${input.prompt}`);
    return this.finalize(result);
  }
}

export class KiroAdapter extends ExperimentalAdapter {
  readonly driver = "kiro" as const;

  protected override async probeDetails(path: string, _version: string | undefined, timeoutMs: number): Promise<Partial<HarnessHealth>> {
    const who = await execProbe(path, ["whoami", "--format", "json"], timeoutMs);
    const line = who.stdout.split(/\r?\n/).find((line) => line.trim());
    const account = line ? tryParseJson(line) : undefined;
    // A failure to read the credential store is an I/O problem, not proof of a logged-out account.
    if (!who.ok && STORAGE_ERROR_PATTERN.test(`${who.stdout}\n${who.stderr}`)) {
      return { auth_status: "unknown", probe_inconclusive: true, note: "`kiro-cli whoami` could not read the stored credentials." };
    }
    if ((!who.ok && who.exitCode === 1) || (isObject(account) && account.account === null)) return { auth_status: "unauthenticated" };
    return { auth_status: isObject(account) && account.account != null ? "ready" : "unknown" };
  }

  async buildInvocation(input: BuildInvocationInput) {
    const prompt = this.argvPrompt(input);
    this.assertExtraArgs(input, /^(--trust-all-tools|--trust-tools)(=|$)/);
    const result = this.invocation(input, ["chat", "--v3", "--no-interactive", "--output-format", "stream-json"]);
    if (input.model.cli_model !== "default") result.args.push("--model", input.model.cli_model);
    if (input.mode === "readonly") {
      result.args.push("--trust-tools=fs_read");
    } else {
      result.args.push("--trust-all-tools");
      this.warnUnsandboxed(result);
    }
    result.args.push(...(input.harness.extra_args ?? []), "--", prompt);
    // stream-json emits incremental events: silence means a stall, unlike buffered output (extra_args may change the format).
    result.outputMode = outputModeFor(result.args, ["--output-format"], "stream-json");
    return this.finalize(result);
  }

  override createStreamParser() { return createAssistantEventParser(this.label); }
}

export class FxAdapter extends ExperimentalAdapter {
  readonly driver = "fx" as const;
  override readonly securityGuarantees = { readonly: "unsandboxed", write: "unsandboxed" } as const;

  override mapEffort(effort: string) {
    return mapEffortWith({ minimal: "low", off: "low", none: "low", "extra-high": "xhigh", "x-high": "xhigh", maximum: "max" }, effort);
  }

  override async probe(harnessId: string, harness: HarnessConfig, { timeoutMs = DRIVER_METADATA.fx.probeTimeoutMs } = {}) {
    const base = { harnessId, harness, driver: this.driver, securityGuarantees: this.securityGuarantees };
    const path = resolveBinary(harness.binary, harnessLookup());
    if (!path) return healthNow(base, { note: `Binary ${JSON.stringify(harness.binary)} was not found on PATH (CLI_NOT_FOUND).` });
    const status = await execProbe(path, ["status", "--json"], timeoutMs);
    const data = tryParseJson(status.stdout);
    if (isObject(data) && ["auth", "provider", "version"].some((key) => Object.hasOwn(data, key))) {
      const auth = asString(data.auth);
      return healthNow(base, {
        installed: true, binary_path: path, version: asString(data.version),
        auth_status: auth === "missing" ? "unauthenticated" : auth && auth !== "unknown" && status.ok ? "ready" : "unknown",
      });
    }
    const help = await execProbe(path, ["--help"], timeoutMs);
    if (help.timedOut || help.exitCode === null) {
      // The binary exists but did not identify itself, so neither "not installed" nor any auth state is a fact.
      return healthNow(base, {
        installed: true, binary_path: path, auth_status: "unknown", probe_inconclusive: true,
        note: `\`${harness.binary} --help\` did not answer, so the binary could not be identified as Vercel Labs fx coding CLI.`,
      });
    }
    if (!FX_HELP_PATTERN.test(help.stdout + "\n" + help.stderr)) {
      return healthNow(base, { installed: false, note: `Binary ${JSON.stringify(harness.binary)} on PATH is not Vercel Labs fx coding CLI (possible JSON viewer collision).` });
    }
    return super.probe(harnessId, harness, { timeoutMs });
  }

  async buildInvocation(input: BuildInvocationInput) {
    if (input.mode === "readonly") {
      throw { code: "SANDBOX_POLICY_VIOLATION", message: "Vercel fx has no verified readonly profile.", retryable: false };
    }
    const prompt = this.argvPrompt(input);
    // A bare `fx` is also a JSON viewer: prove it is Vercel fx before running it with a prompt.
    await this.assertBinaryIdentity(input, AMBIGUOUS_FX_STEM, "fx", identifyFx);
    const result = this.invocation(input, ["ask", "--json", "--no-save"]);
    if (input.model.cli_model !== "default") result.args.push("--model", input.model.cli_model);
    if (input.model.cli_provider) result.args.push("--provider", input.model.cli_provider);
    if (isExplicitEffort(result.nativeEffort)) result.args.push("--effort", result.nativeEffort);
    this.warnUnsandboxed(result);
    result.args.push(...(input.harness.extra_args ?? []), "--", prompt);
    return this.finalize(result);
  }
}

export class MuseAdapter extends ExperimentalAdapter {
  readonly driver = "muse" as const;

  protected override async probeDetails(_path: string, version: string | undefined): Promise<Partial<HarnessHealth>> {
    return { version_supported: versionAtLeast(version, [1, 4, 2]) };
  }

  async buildInvocation(input: BuildInvocationInput) {
    const extra = input.harness.extra_args ?? [];
    this.assertExtraArgs(input, /^(--yolo|--disable-sandbox|--disable-approval)(=|$)/, /^(--yolo|--disable-sandbox)(=|$)/);
    const file = await writePromptFile(input.jobDir, "muse-prompt.txt", withInlineSystemContext(input.prompt, input.systemContext).text);
    const result = this.invocation(input, ["exec", "--json", "--prompt-file", file]);
    result.tempFiles.push(file);
    if (input.model.cli_model !== "default") result.args.push("--model", input.model.cli_model);
    if (input.mode === "readonly") result.args.push("--read-only");
    else {
      result.args.push("--trust-workspace", "--disable-approval");
      this.warnUnsandboxed(result);
    }
    result.args.push(...extra);
    return this.finalize(result);
  }

  override createStreamParser() { return createAssistantEventParser(this.label); }
}
