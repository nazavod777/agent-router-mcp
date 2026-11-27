import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import { DRIVER_METADATA } from "../drivers.js";
import type { ProgressTracker } from "../runtime/checkpoint.js";
import { assertSandboxExtraArgs, createNdjsonParser, outputModeFor, versionAtLeast } from "./parsers.js";
import { asNumber, asString, compactUsage, execProbe, healthNow, isObject, mapEffortWith, PARSER_BUFFER_LIMIT_BYTES, probeBinaryAndVersion, requireLaunch, safeToolTarget, safeToolVariant, tryParseJson } from "./probe-utils.js";
import type { BuildInvocationInput, BuiltInvocation, CliAdapter } from "./types.js";

const LABEL = DRIVER_METADATA.opencode.label;
const permissions = [
  { action: "*", resource: "*", effect: "deny" },
  ...["read", "grep", "glob", "list"].map((action) => ({ action, resource: "*", effect: "allow" })),
];

/** OpenCode config files are small JSON(C); anything bigger is not read. */
const MAX_OPENCODE_CONFIG_BYTES = 1024 * 1024;
const MAX_DISABLED_MCP_SERVERS = 64;
const CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc", "config.json"] as const;
const PROJECT_CONFIG_FILE_NAMES = ["opencode.json", "opencode.jsonc"] as const;

/** Removes `//` and `/* *\/` comments (outside strings) and trailing commas so JSONC parses as JSON. */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === "\\") { out += next ?? ""; index += 1; } else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 1;
    } else out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

async function readMcpNames(path: string): Promise<string[]> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_OPENCODE_CONFIG_BYTES) return [];
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(buffer, 0, info.size, 0);
    const config = tryParseJson(stripJsonc(buffer.toString("utf8", 0, bytesRead)));
    return isObject(config) && isObject(config.mcp) ? Object.keys(config.mcp) : [];
  } catch {
    return [];
  } finally {
    await file?.close();
  }
}

/**
 * Names of the MCP servers the user's OpenCode configuration defines (global config directory, `OPENCODE_CONFIG`, and the
 * project's own config), bounded. An unreadable or invalid file contributes none.
 */
export async function readConfiguredMcpServerNames(
  cwd: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(),
): Promise<string[]> {
  const globalDir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  const paths = [
    ...CONFIG_FILE_NAMES.map((name) => join(globalDir, name)),
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...PROJECT_CONFIG_FILE_NAMES.map((name) => join(cwd, name)),
  ];
  const names = new Set<string>();
  for (const path of paths) for (const name of await readMcpNames(path)) names.add(name);
  return [...names].slice(0, MAX_DISABLED_MCP_SERVERS);
}

const DEPTH_KEY = "subagent_depth";
const EXPERIMENTAL_DEPTH_KEY = `experimental.${DEPTH_KEY}`;

/**
 * Depth to enforce, or undefined when the CLI's own limit stays untouched. A depth key is only written where the user's
 * config already holds one; with policy off and no such key, `experimental.subagent_depth: 0` is still safe because it
 * can only lower the limit.
 */
function nativeDepthLimit(control: BuildInvocationInput["nativeSubagents"]): { depth: number; topLevel: boolean; experimental: boolean } | undefined {
  if (!control) return undefined;
  const lowersDepth = control.discoveredMaxDepth !== undefined && control.maxDepth < control.discoveredMaxDepth;
  if (control.policy !== "off" && !lowersDepth) return undefined;
  const depth = control.policy === "off" ? 0 : control.maxDepth;
  const keys = control.discoveredKeys;
  const topLevel = keys?.includes(DEPTH_KEY) === true;
  const experimental = keys?.includes(EXPERIMENTAL_DEPTH_KEY) === true;
  if (topLevel || experimental) return { depth, topLevel, experimental };
  if (control.policy === "off" || keys === undefined) return { depth, topLevel: false, experimental: true };
  return undefined;
}

/** Keeps the lower of an inherited depth and ours, so merging never raises a limit the caller already set. */
function lowerDepth(existing: unknown, depth: number): number {
  return typeof existing === "number" && Number.isFinite(existing) && existing < depth ? existing : depth;
}

/** Builds the inline config: whatever the environment already carries is kept, only this job's agent and depth are set. */
function mergeInlineConfig(
  existingRaw: string | undefined,
  agentName: string,
  agent: Record<string, unknown>,
  limit: ReturnType<typeof nativeDepthLimit>,
  warnings: string[],
  /** Names of user-configured MCP servers to switch off; undefined leaves MCP as the user configured it. */
  disabledMcpServers?: readonly string[],
): Record<string, unknown> {
  let existing: Record<string, unknown> = {};
  if (existingRaw?.trim()) {
    try {
      const parsed: unknown = JSON.parse(existingRaw);
      if (isObject(parsed)) existing = parsed;
      else warnings.push("OPENCODE_CONFIG_CONTENT is not a JSON object; it was replaced for this job.");
    } catch {
      warnings.push("OPENCODE_CONFIG_CONTENT is not valid JSON; it was replaced for this job.");
    }
  }
  const merged: Record<string, unknown> = {
    ...existing,
    agents: { ...(isObject(existing.agents) ? existing.agents : {}), [agentName]: agent },
  };
  if (disabledMcpServers) {
    // Every server named by the inline config or the user's files is disabled; the inline entry keeps its other fields.
    const inline = isObject(existing.mcp) ? existing.mcp : {};
    const names = new Set([...Object.keys(inline), ...disabledMcpServers]);
    merged.mcp = Object.fromEntries([...names].map((name) => [name, { ...(isObject(inline[name]) ? inline[name] : {}), enabled: false }]));
  }
  if (limit?.topLevel) merged[DEPTH_KEY] = lowerDepth(existing[DEPTH_KEY], limit.depth);
  if (limit?.experimental) {
    const experimental = isObject(existing.experimental) ? existing.experimental : {};
    merged.experimental = { ...experimental, [DEPTH_KEY]: lowerDepth(experimental[DEPTH_KEY], limit.depth) };
  }
  return merged;
}

function addNumber(total: number | undefined, value: unknown): number | undefined {
  const number = asNumber(value);
  return number === undefined ? total : (total ?? 0) + number;
}

/** Finished call ids kept so a repeated or late event for a completed call cannot add a second step. */
const MAX_FINISHED_CALLS = 256;

/**
 * Records one OpenCode tool part: name and a safe target only, never the tool's input body or output. A call is one
 * step that every later event of the same call id updates in place. A `pending` part has no input yet, so the step
 * starts at the first later event, which already carries the target.
 */
function trackTool(tracker: ProgressTracker, finished: Set<string>, part: Record<string, unknown>): void {
  const state = isObject(part.state) ? part.state : {};
  const callId = asString(part.callID) ?? asString(part.id);
  const name = asString(part.tool) ?? "tool";
  const status = asString(state.status);
  const terminal = status === "completed" || status === "error";
  if (callId !== undefined && finished.has(callId)) return;
  if (callId === undefined) {
    // Without an id events of one call cannot be told apart, so only the final one counts.
    if (terminal) {
      tracker.recordToolStart(name, safeToolTarget(state.input), undefined, safeToolVariant(state.input));
      tracker.recordToolEnd(name, status === "completed");
    }
    return;
  }
  if (status === "pending" && !tracker.isOpen(callId)) return;
  if (!tracker.isOpen(callId)) tracker.recordToolStart(name, safeToolTarget(state.input), callId, safeToolVariant(state.input));
  if (!terminal) return;
  tracker.recordToolEnd(callId, status === "completed");
  if (finished.size >= MAX_FINISHED_CALLS) finished.delete(finished.values().next().value!);
  finished.add(callId);
}

export class OpenCodeAdapter implements CliAdapter {
  readonly driver = "opencode" as const;
  readonly securityGuarantees = { readonly: "tool_allowlist", write: "unsandboxed" } as const;

  mapEffort(effort: string): string {
    return mapEffortWith({ off: "none", minimal: "low", "extra-high": "xhigh", "x-high": "xhigh", maximum: "max" }, effort);
  }

  async probe(harnessId: string, harness: HarnessConfig, { timeoutMs = DRIVER_METADATA.opencode.probeTimeoutMs } = {}) {
    const base = { harnessId, harness, driver: this.driver, securityGuarantees: this.securityGuarantees };
    const binary = await probeBinaryAndVersion(base, timeoutMs);
    if (binary.health) return binary.health;
    const supported = versionAtLeast(binary.version, [2, 0, 18]);
    const auth = await execProbe(binary.binaryPath!, ["auth", "list", "--standalone"], timeoutMs);
    const notes = [];
    if (supported === false) notes.push("OpenCode v2.0.18+ is required for v2 standalone config schema.");
    const empty = auth.ok && !auth.stdout.trim();
    if (empty) notes.push("Run `opencode auth login` to connect a provider.");
    return healthNow(base, {
      installed: true, binary_path: binary.binaryPath, version: binary.version, version_supported: supported,
      auth_status: empty ? "unauthenticated" : auth.ok && /\bstored\b/i.test(auth.stdout) ? "ready" : "unknown",
      ...(notes.length ? { note: notes.join(" ") } : {}),
    });
  }

  async buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation> {
    const nativeEffort = this.mapEffort(input.effort);
    const model = input.model.cli_model;
    const base = input.model.cli_provider ? `${input.model.cli_provider}/${model}` : model;
    const variant = !["default", "none"].includes(nativeEffort) && input.model.efforts.length > 1;
    const args = ["run", "--standalone", "--format", "json", "--model", variant ? `${base}#${nativeEffort}` : base];
    const readonly = input.mode === "readonly";
    const name = readonly ? "orch-readonly" : "orch-write";
    const extra = input.harness.extra_args ?? [];
    const warnings: string[] = [];
    const agent = { mode: "primary", ...(input.systemContext ? { system: input.systemContext } : {}), ...(readonly ? { permissions } : {}) };
    args.push("--agent", name);
    assertSandboxExtraArgs(LABEL, extra, {
      mode: input.mode,
      allowUnsandboxedWrite: input.allowUnsandboxedWrite,
      readonlyForbidden: /^(--agent|--auto)(=|$)/,
    });
    const launch = requireLaunch(input.harness.binary);
    if (!readonly) {
      args.push("--auto");
      warnings.push("OpenCode write mode runs without an OS filesystem sandbox (unsandboxed). Prefer isolation='worktree'.");
    }
    args.push(...extra);
    const disabledMcp = !input.inheritMcp || readonly ? await readConfiguredMcpServerNames(input.cwd) : undefined;
    const inlineConfig = mergeInlineConfig(process.env.OPENCODE_CONFIG_CONTENT, name, agent, nativeDepthLimit(input.nativeSubagents), warnings, disabledMcp);
    return {
      command: launch.command, args: [...launch.prefixArgs, ...args], stdin: input.prompt,
      envOverrides: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig) },
      outputMode: outputModeFor(args, ["--format"], "json"),
      tempFiles: [], warnings, nativeEffort,
    };
  }

  createStreamParser() {
    return createNdjsonParser({
      label: LABEL,
      initial: () => ({ seen: new Set<string>(), finishedCalls: new Set<string>(), idBytes: 0, last: "", text: "", textBytes: 0 }),
      extractText: (data) => data.text,
      onEvent(event, state) {
        const part = isObject(event.part) ? event.part : {};
        state.tracker.setSessionId(asString(event.sessionID));
        if (event.type === "tool_use" || event.type === "tool") {
          trackTool(state.tracker, state.data.finishedCalls, part);
          return;
        }
        if (event.type === "text" || event.type === "message") {
          const text = asString(part.text);
          if (!text) return;
          const id = asString(part.messageID) ?? "default";
          const data = state.data;
          if (id !== data.last) {
            // Late chunks from an earlier assistant message do not belong to the final answer and end no turn.
            if (data.seen.has(id)) return;
            if (data.last) state.tracker.noteTurn();
            const idBytes = Buffer.byteLength(id) + 64;
            if (data.idBytes + idBytes > PARSER_BUFFER_LIMIT_BYTES) {
              data.seen.clear();
              data.idBytes = 0;
            }
            data.seen.add(id);
            data.idBytes += idBytes;
            data.last = id;
            data.text = "";
            data.textBytes = 0;
          }
          state.tracker.appendText(text);
          const bytes = Buffer.byteLength(text);
          if (data.textBytes + bytes > PARSER_BUFFER_LIMIT_BYTES) {
            if (!state.warnings.length) state.warnings.push("OpenCode text exceeded the parser buffer limit; output was truncated.");
            return;
          }
          data.textBytes += bytes;
          data.text += text;
        } else if (event.type === "step_finish") {
          const tokens = isObject(part.tokens) ? part.tokens : {};
          state.usage = compactUsage({
            input_tokens: addNumber(state.usage?.input_tokens, tokens.input),
            output_tokens: addNumber(state.usage?.output_tokens, tokens.output),
            cached_input_tokens: addNumber(state.usage?.cached_input_tokens, isObject(tokens.cache) ? tokens.cache.read : undefined),
            cost_usd: addNumber(state.usage?.cost_usd, part.cost),
          });
        } else if (event.type === "error") {
          const error = isObject(event.error) ? event.error : {};
          if (error.type === "provider.auth") state.forceAuthError = true;
          const message = asString(error.message) ?? asString(event.message) ?? "OpenCode reported an error.";
          state.errors[0] = state.forceAuthError ? `Authentication required: ${message}` : message;
        }
      },
    });
  }
}
