import type { HarnessConfig } from "../config/schema.js";
import { DRIVER_METADATA } from "../drivers.js";
import { assertArgvPromptFits, assertCommandLineFits, assertSandboxExtraArgs, createJsonResultParser, extractContentText, versionAtLeast, withInlineSystemContext } from "./parsers.js";
import { asNumber, asString, compactUsage, execProbe, healthNow, isExplicitEffort, isObject, mapEffortWith, probeBinaryAndVersion, requireLaunch } from "./probe-utils.js";
import type { BuildInvocationInput, BuiltInvocation, CliAdapter } from "./types.js";

const LABEL = DRIVER_METADATA.antigravity.label;
const READONLY_INSTRUCTION = "Read-only analysis task: do not modify files and do not ask for plan confirmation; output the final answer directly.";

export class AntigravityAdapter implements CliAdapter {
  readonly driver = "antigravity" as const;
  readonly securityGuarantees = { readonly: "tool_allowlist", write: "unsandboxed" } as const;

  mapEffort(effort: string): string {
    return mapEffortWith({ minimal: "low", off: "low", none: "low", "extra-high": "xhigh", "x-high": "xhigh", maximum: "max" }, effort);
  }

  async probe(harnessId: string, harness: HarnessConfig, { timeoutMs = DRIVER_METADATA.antigravity.probeTimeoutMs } = {}) {
    const base = { harnessId, harness, driver: this.driver, securityGuarantees: this.securityGuarantees };
    const binary = await probeBinaryAndVersion(base, timeoutMs);
    if (binary.health) return binary.health;
    const models = await execProbe(binary.binaryPath!, ["models"], timeoutMs);
    const needsLogin = /please\s+sign\s+in|not\s+logged\s+in|unauthori[sz]ed/i.test(models.stdout + "\n" + models.stderr);
    return healthNow(base, {
      installed: true, binary_path: binary.binaryPath, version: binary.version,
      version_supported: versionAtLeast(binary.version, [1, 5, 12]),
      auth_status: needsLogin ? "unauthenticated" : models.ok && models.stdout.trim() ? "ready" : "unknown",
      ...(needsLogin ? { note: "Run `agy` interactively to sign in." } : {}),
    });
  }

  async buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation> {
    const readonly = input.mode === "readonly";
    const prompt = withInlineSystemContext(input.prompt, input.systemContext, readonly ? READONLY_INSTRUCTION : undefined).text;
    assertArgvPromptFits(LABEL, prompt);
    const extra = input.harness.extra_args ?? [];
    assertSandboxExtraArgs(LABEL, extra, {
      mode: input.mode,
      allowUnsandboxedWrite: input.allowUnsandboxedWrite,
      readonlyForbidden: /^(--dangerously-skip-permissions|--mode|--disable-slash-commands|--settings)(=|$)/,
      writeForbidden: /^--dangerously-skip-permissions(=|$)/,
    });
    const launch = requireLaunch(input.harness.binary);
    const model = input.model.cli_model;
    const suffix = /-(low|medium|high|xhigh|max)$/.exec(model);
    const nativeEffort = suffix?.[1] ?? this.mapEffort(input.effort);
    const args = ["--model", model];
    const warnings: string[] = [];
    if (suffix) warnings.push("Antigravity uses the effort suffix in the model name; omitting the conflicting --effort flag.");
    else if (isExplicitEffort(nativeEffort)) args.push("--effort", nativeEffort);
    args.push("--output-format", "json");
    if (readonly) {
      args.push("--mode", "plan", "--settings", '{"allowNonWorkspaceAccess":false}');
    } else {
      const mode = input.harness.write_permission_mode ?? "accept-edits";
      args.push("--mode", mode === "acceptEdits" ? "accept-edits" : mode);
      warnings.push("Antigravity write mode runs without an OS filesystem sandbox (unsandboxed). Prefer isolation='worktree'.");
    }
    if (!input.inheritMcp || readonly) warnings.push("Antigravity CLI has no per-run MCP disable flag; configured MCP servers may remain loaded.");
    args.push(...extra, `--print=${prompt}`);
    const finalArgs = [...launch.prefixArgs, ...args];
    assertCommandLineFits(LABEL, launch.command, finalArgs);
    return { command: launch.command, args: finalArgs, stdin: "", tempFiles: [], warnings, nativeEffort };
  }

  createStreamParser() {
    return createJsonResultParser({ label: LABEL, extract(value) {
      if (!isObject(value)) return;
      const result = value.event === "result" ? value.result : value;
      if (!isObject(result) || !("status" in result || "response" in result || "error" in result)) return;
      const usage = isObject(result.usage) ? result.usage : {};
      return {
        text: extractContentText(result.response),
        isError: ("status" in result && result.status !== "SUCCESS") || Boolean(result.error),
        errorMessage: isObject(result.error) ? asString(result.error.message) : asString(result.error),
        usage: compactUsage({
          input_tokens: asNumber(usage.input_tokens), output_tokens: asNumber(usage.output_tokens),
          cached_input_tokens: asNumber(usage.cache_read_tokens),
        }),
      };
    } });
  }
}
