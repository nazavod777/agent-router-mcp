import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import { DRIVER_METADATA } from "../drivers.js";
import { getEnvValue } from "../runtime/guard.js";
import type { UsageStats } from "../types.js";
import { assertSandboxExtraArgs, createJsonResultParser, extractClaudeLikeResult, extractContentText, isNonResultEvent, withInlineSystemContext } from "./parsers.js";
import { adapterError, asNumber, asString, compactUsage, healthNow, isObject, probeBinaryAndVersion, requireLaunch, tryParseJson } from "./probe-utils.js";
import type { AdapterStreamParser, BuildInvocationInput, BuiltInvocation, CliAdapter } from "./types.js";

const AUTH_ENV = {
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA"],
  qwen: ["DASHSCOPE_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY"],
};
const MAX_SETTINGS_BYTES = 1024 * 1024;
/** Env switches whose value says "off" (`GOOGLE_GENAI_USE_VERTEXAI=false`) do not configure anything. */
const OFF_VALUES = new Set(["false", "0", "no", "off"]);

/** A key counts only with a real value: an empty or blank string (or an "off" switch) is not a credential. */
function hasAuthEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = getEnvValue(env, key)?.trim();
  if (!value) return false;
  return !(key.startsWith("GOOGLE_GENAI_USE_") && OFF_VALUES.has(value.toLowerCase()));
}

/** `$GEMINI_CLI_HOME/.gemini/settings.json` (a relative home is resolved against `cwd`), else `~/.gemini/settings.json`. */
function geminiSettingsPath(env: NodeJS.ProcessEnv, cwd: string): string {
  const configured = getEnvValue(env, "GEMINI_CLI_HOME")?.trim();
  const home = configured ? (isAbsolute(configured) ? configured : resolve(cwd, configured)) : homedir();
  return join(home, ".gemini", "settings.json");
}

export async function hasGeminiAuthSetting(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<boolean> {
  let file;
  try {
    file = await open(geminiSettingsPath(env, cwd), constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return false;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(buffer);
    const settings = tryParseJson(buffer.toString("utf8", 0, bytesRead));
    return isObject(settings) && isObject(settings.security) && isObject(settings.security.auth)
      && Boolean(asString(settings.security.auth.selectedType));
  } catch {
    return false;
  } finally {
    await file?.close();
  }
}

/** Message plus the structured `status` (e.g. UNAVAILABLE) and `code` (e.g. 503) so the failure classifiers see them. */
function describeGeminiError(error: unknown): string | undefined {
  if (!isObject(error)) return asString(error);
  const message = asString(error.message);
  const status = asString(error.status);
  const code = typeof error.code === "number" || typeof error.code === "string" ? String(error.code) : undefined;
  const details = [status ? `status: ${status}` : undefined, code ? `code: ${code}` : undefined].filter(Boolean).join(", ");
  if (!details) return message;
  return message ? `${message} (${details})` : details;
}

function extractResult(value: unknown) {
  if (isNonResultEvent(value)) return undefined;
  if (!isObject(value) || !("response" in value || "error" in value || "stats" in value)) return extractClaudeLikeResult(value);
  const usage: UsageStats = {};
  if (isObject(value.stats) && isObject(value.stats.models)) {
    for (const model of Object.values(value.stats.models)) {
      if (!isObject(model) || !isObject(model.tokens)) continue;
      const tokens = model.tokens;
      const input = asNumber(tokens.input) ?? asNumber(tokens.prompt);
      const output = asNumber(tokens.output) ?? asNumber(tokens.candidates);
      const cached = asNumber(tokens.cached);
      if (input !== undefined) usage.input_tokens = (usage.input_tokens ?? 0) + input;
      if (output !== undefined) usage.output_tokens = (usage.output_tokens ?? 0) + output;
      if (cached !== undefined) usage.cached_input_tokens = (usage.cached_input_tokens ?? 0) + cached;
    }
  }
  const fallback = extractClaudeLikeResult(value);
  return {
    text: extractContentText(value.response) || fallback?.text,
    usage: compactUsage(usage) ?? fallback?.usage,
    isError: Boolean(value.error) || fallback?.isError,
    errorMessage: describeGeminiError(value.error) ?? fallback?.errorMessage,
  };
}

abstract class GeminiFamilyAdapter implements CliAdapter {
  abstract readonly driver: "gemini" | "qwen";
  readonly securityGuarantees = { readonly: "tool_allowlist", write: "unsandboxed" } as const;

  mapEffort(_effort: string): string { return "default"; }

  async probe(harnessId: string, harness: HarnessConfig, { timeoutMs = DRIVER_METADATA[this.driver].probeTimeoutMs } = {}) {
    const base = { harnessId, harness, driver: this.driver, securityGuarantees: this.securityGuarantees };
    const binary = await probeBinaryAndVersion(base, timeoutMs);
    if (binary.health) return binary.health;
    const configured = AUTH_ENV[this.driver].some((key) => hasAuthEnv(process.env, key))
      || (this.driver === "gemini" && await hasGeminiAuthSetting());
    return healthNow(base, {
      installed: true, binary_path: binary.binaryPath, version: binary.version, auth_status: configured ? "ready" : "unknown",
      ...(!configured ? { note: `Use ${this.driver} interactively to configure authentication or set a supported API key.` } : {}),
    });
  }

  async buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation> {
    const gemini = this.driver === "gemini";
    const label = DRIVER_METADATA[this.driver].label;
    const readonly = input.mode === "readonly";
    const args = ["-m", input.model.cli_model, "-o", "json"];
    const warnings: string[] = [];
    const extra = input.harness.extra_args ?? [];
    if (!["default", "medium"].includes(input.effort.trim().toLowerCase())) {
      warnings.push(`${label} ignores --effort and uses the model default.`);
    }
    assertSandboxExtraArgs(label, extra, {
      mode: input.mode,
      allowUnsandboxedWrite: input.allowUnsandboxedWrite,
      readonlyForbidden: /^(--approval-mode|-y|--yolo|--allowed-tools|--allowed-mcp-server-names)(=|$)/,
      writeForbidden: /^(--approval-mode|-y|--yolo)(=|$)/,
    });
    const launch = requireLaunch(input.harness.binary);
    if (readonly) {
      args.push("--approval-mode", "plan");
    } else {
      args.push("--approval-mode", input.harness.write_permission_mode ?? (gemini ? "auto_edit" : "auto-edit"));
      warnings.push(`${label} write mode runs without an OS filesystem sandbox (unsandboxed). Prefer isolation='worktree'.`);
    }
    // Trusting the workspace is only needed for write mode; a readonly run must not widen what the CLI loads from the folder.
    if (gemini && !readonly) args.push("--skip-trust");
    if (!input.inheritMcp || readonly) {
      args.push("--allowed-mcp-server-names", "__orch_none__");
      if (gemini) args.push("-e", "none");
    }
    args.push(...extra, "-p", " ");
    return {
      command: launch.command, args: [...launch.prefixArgs, ...args],
      stdin: withInlineSystemContext(input.prompt, input.systemContext).text,
      tempFiles: [], warnings, nativeEffort: this.mapEffort(input.effort),
    };
  }

  createStreamParser(): AdapterStreamParser {
    const label = DRIVER_METADATA[this.driver].label;
    const parser = createJsonResultParser({ label, extract: extractResult, isAuthExitCode: (code) => code === 41 });
    return {
      pushLine: parser.pushLine,
      finish(input) {
        const result = parser.finish(input);
        // Exit 41 is authoritative even when provider prose matches a different (possibly retryable) classifier.
        if (input.exitCode === 41 && result.error) {
          const original = result.error;
          const alreadyAuth = original.code === "AUTH_REQUIRED";
          const forced = adapterError("AUTH_REQUIRED",
            alreadyAuth ? original.message : `${label} requires authentication (exit code 41): ${original.message}`, false, {
              details: original.details, stderrTail: original.stderr_tail ?? input.stderrTail,
            });
          forced.failure_scope = "harness";
          // Keep the provider's original diagnostics so the caller can read them verbatim.
          const rawError = original.raw_error ?? original.message;
          if (rawError) forced.raw_error = rawError;
          result.error = forced;
        }
        return result;
      },
    };
  }
}

export class GeminiAdapter extends GeminiFamilyAdapter { readonly driver = "gemini" as const; }
export class QwenAdapter extends GeminiFamilyAdapter { readonly driver = "qwen" as const; }
