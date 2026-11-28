import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { nodeToValue, parseJsonc } from "../cli/jsonc-edit.js";
import type { HarnessConfig } from "../config/schema.js";
import { DRIVER_METADATA } from "../drivers.js";
import type { ProgressTracker } from "../runtime/checkpoint.js";
import { getEnvValue } from "../runtime/guard.js";
import { assertSandboxExtraArgs, createNdjsonParser, outputModeFor, versionAtLeast } from "./parsers.js";
import { adapterError, asNumber, asString, compactUsage, execProbe, healthNow, isExplicitEffort, isObject, mapEffortWith, PARSER_BUFFER_LIMIT_BYTES, probeBinaryAndVersion, readOptionalConfigText, requireLaunch, safeToolTarget, safeToolVariant } from "./probe-utils.js";
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
/** Per project directory: the config next to the code and the one in its `.opencode/` folder. */
const PROJECT_CONFIG_FILES = [
  ["opencode.json"], ["opencode.jsonc"], [".opencode", "opencode.json"], [".opencode", "opencode.jsonc"],
] as const;
/** Parent directories searched above the working directory, so a nested folder still sees its project's config. */
const MAX_PROJECT_ANCESTORS = 64;

/**
 * Project config candidates from `cwd` up to the git root (inclusive); without a git root the walk ends at the home
 * directory or the file system root. Bounded and deduplicated by resolved path.
 */
function projectConfigPaths(cwd: string, home: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const homeDir = resolve(home);
  let dir = resolve(cwd);
  for (let level = 0; level <= MAX_PROJECT_ANCESTORS; level += 1) {
    for (const parts of PROJECT_CONFIG_FILES) {
      const path = join(dir, ...parts);
      if (!seen.has(path)) { seen.add(path); paths.push(path); }
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || dir === homeDir || parent === dir) return paths;
    dir = parent;
  }
  // Fail closed: a git-root config above this depth would otherwise be skipped silently.
  throw refuseMcpConfig(dir, "exceeds the maximum directory depth while searching for project configs");
}

/** MCP servers of one OpenCode config: V1 keeps them directly under `mcp.<name>`, V2 under `mcp.servers.<name>`. */
export interface ConfiguredMcpServers {
  v1: string[];
  v2: string[];
}

function mcpServersOf(config: Record<string, unknown>): ConfiguredMcpServers {
  const mcp = isObject(config.mcp) ? config.mcp : {};
  const servers = isObject(mcp.servers) ? mcp.servers : undefined;
  return {
    v1: Object.keys(mcp).filter((name) => !(servers !== undefined && name === "servers")),
    v2: servers ? Object.keys(servers) : [],
  };
}

/**
 * Parses JSONC (comments, trailing commas) with the strict offset-tracking parser, so commas and comment markers inside
 * string literals are never touched and an unterminated block comment fails. A blank document is an empty config.
 * Undefined when it is not a JSON object.
 */
function parseJsoncObject(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = nodeToValue(parseJsonc(text));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads one existing config file for its MCP servers. A missing file contributes none; a file that cannot be read safely
 * (not a regular file, oversized, unreadable, invalid JSONC) fails closed: switching MCP off would otherwise silently
 * leave its servers running. The parser's own message is never quoted, since it may echo file content.
 */
async function readMcpServers(path: string): Promise<ConfiguredMcpServers> {
  let text: string | undefined;
  try {
    text = await readOptionalConfigText(path, MAX_OPENCODE_CONFIG_BYTES);
  } catch (error) {
    // A parent that is a file (not a directory) holds no config either.
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return { v1: [], v2: [] };
    throw refuseMcpConfig(path, `could not be read safely (${error instanceof Error ? error.message : "unknown error"})`);
  }
  if (text === undefined) return { v1: [], v2: [] };
  const config = parseJsoncObject(text);
  if (config === undefined) throw refuseMcpConfig(path, "is not a valid JSON or JSONC object");
  return mcpServersOf(config);
}

function refuseMcpConfig(path: string, reason: string) {
  return adapterError("SANDBOX_POLICY_VIOLATION",
    `MCP servers must be switched off, but the OpenCode config ${path} ${reason}, so its MCP servers cannot all be disabled. ` +
    `Repair the file (valid JSON or JSONC, under ${MAX_OPENCODE_CONFIG_BYTES} bytes, at most ${MAX_DISABLED_MCP_SERVERS} MCP servers) ` +
    "or set inherit_mcp = true for this harness or run.", false);
}

/**
 * MCP servers the user's OpenCode configuration defines (global config directory, `OPENCODE_CONFIG`, and the project's
 * own config), split by schema generation. A missing file contributes none; an unreadable or invalid file, or more than
 * `MAX_DISABLED_MCP_SERVERS` distinct servers, fails closed with SANDBOX_POLICY_VIOLATION.
 */
export async function readConfiguredMcpServers(
  cwd: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(),
): Promise<ConfiguredMcpServers> {
  const configDir = getEnvValue(env, "OPENCODE_CONFIG_DIR");
  const xdgHome = getEnvValue(env, "XDG_CONFIG_HOME");
  const globalDir = configDir || join(xdgHome || join(home, ".config"), "opencode");
  const explicitFile = getEnvValue(env, "OPENCODE_CONFIG");
  const paths = [
    ...CONFIG_FILE_NAMES.map((name) => join(globalDir, name)),
    ...(explicitFile ? [resolve(cwd, explicitFile)] : []),
    ...projectConfigPaths(cwd, home),
  ];
  const v1 = new Set<string>();
  const v2 = new Set<string>();
  for (const path of paths) {
    const found = await readMcpServers(path);
    found.v1.forEach((name) => v1.add(name));
    found.v2.forEach((name) => v2.add(name));
    const total = new Set([...v1, ...v2]).size;
    if (total > MAX_DISABLED_MCP_SERVERS) throw refuseMcpConfig(path, `adds up to ${total} MCP servers`);
  }
  return { v1: [...v1], v2: [...v2] };
}

/** Names of all MCP servers (V1 and V2) the user's OpenCode configuration defines; see `readConfiguredMcpServers`. */
export async function readConfiguredMcpServerNames(
  cwd: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir(),
): Promise<string[]> {
  const { v1, v2 } = await readConfiguredMcpServers(cwd, env, home);
  return [...new Set([...v1, ...v2])];
}

const SECRET_KEY = /^(?:api[_-]?key|token)$/i;
const MIN_SECRET_CHARS = 8;
const MAX_SECRET_SCAN_DEPTH = 12;
const MAX_INLINE_SECRETS = 64;
/** `{env:NAME}` and `{file:path}` are references OpenCode resolves itself, not credentials. */
const CONFIG_REFERENCE = /^\{(?:env|file):[^}]*\}$/;

/** Inline credential strings (`apiKey`, `api_key`, `token`) of a parsed config, so the runner can redact them. */
function inlineSecrets(value: unknown, found: Set<string> = new Set(), depth = 0): string[] {
  if (depth > MAX_SECRET_SCAN_DEPTH || found.size >= MAX_INLINE_SECRETS) return [...found];
  const children = Array.isArray(value) ? value.map((item) => [undefined, item] as const)
    : isObject(value) ? Object.entries(value) : [];
  for (const [key, child] of children) {
    if (typeof child === "string" && key !== undefined && SECRET_KEY.test(key)) {
      if (child.length >= MIN_SECRET_CHARS && !CONFIG_REFERENCE.test(child.trim())) found.add(child);
    } else {
      inlineSecrets(child, found, depth + 1);
    }
  }
  return [...found];
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

/**
 * Entry of a server table switched off, keeping the entry's other fields. V1 uses `enabled: false`; V2 additionally
 * carries `disabled: true`, so either schema generation turns the server off. Entries found only in user files start
 * from an empty object: nothing (least of all credentials) is copied from those files into the inline config.
 */
function disabledEntry(table: Record<string, unknown>, name: string, v2: boolean): Record<string, unknown> {
  return { ...(isObject(table[name]) ? table[name] : {}), enabled: false, ...(v2 ? { disabled: true } : {}) };
}

/**
 * Turns every V1 (`mcp.<name>`) and V2 (`mcp.servers.<name>`) server of the inline config and of the user's files off.
 * Inline entries keep their other fields; a V2 table is only written where one already exists or a V2 server was found,
 * so a V1-only setup never gains a stray `servers` entry.
 */
function disableMcpServers(inlineMcp: Record<string, unknown>, disabled: ConfiguredMcpServers): Record<string, unknown> {
  const inlineServers = isObject(inlineMcp.servers) ? inlineMcp.servers : undefined;
  const inlineV1 = Object.fromEntries(Object.entries(inlineMcp).filter(([name]) => !(inlineServers !== undefined && name === "servers")));
  const v1Names = new Set([...Object.keys(inlineV1), ...disabled.v1]);
  const v2Names = new Set([...Object.keys(inlineServers ?? {}), ...disabled.v2]);
  const mcp: Record<string, unknown> = Object.fromEntries([...v1Names].map((name) => [name, disabledEntry(inlineV1, name, false)]));
  if (inlineServers !== undefined || v2Names.size > 0) {
    mcp.servers = { ...inlineServers, ...Object.fromEntries([...v2Names].map((name) => [name, disabledEntry(inlineServers ?? {}, name, true)])) };
  }
  return mcp;
}

/**
 * Builds the inline config: whatever the environment already carries (JSON or JSONC) is kept, only this job's agent and
 * depth are set. Also returns the inline credentials found in it, which the runner must redact.
 */
function mergeInlineConfig(
  existingRaw: string | undefined,
  agentName: string,
  agent: Record<string, unknown>,
  limit: ReturnType<typeof nativeDepthLimit>,
  warnings: string[],
  /** MCP servers of the user's files to switch off; undefined leaves MCP as the user configured it. */
  disabledMcpServers?: ConfiguredMcpServers,
): { config: Record<string, unknown>; secrets: string[] } {
  let existing: Record<string, unknown> = {};
  if (existingRaw?.trim()) {
    const parsed = parseJsoncObject(existingRaw);
    if (parsed) existing = parsed;
    else warnings.push("OPENCODE_CONFIG_CONTENT is not valid JSON/JSONC (an object is required); it was replaced for this job.");
  }
  const merged: Record<string, unknown> = {
    ...existing,
    agents: { ...(isObject(existing.agents) ? existing.agents : {}), [agentName]: agent },
  };
  if (disabledMcpServers) merged.mcp = disableMcpServers(isObject(existing.mcp) ? existing.mcp : {}, disabledMcpServers);
  if (limit?.topLevel) merged[DEPTH_KEY] = lowerDepth(existing[DEPTH_KEY], limit.depth);
  if (limit?.experimental) {
    const experimental = isObject(existing.experimental) ? existing.experimental : {};
    merged.experimental = { ...experimental, [DEPTH_KEY]: lowerDepth(experimental[DEPTH_KEY], limit.depth) };
  }
  return { config: merged, secrets: inlineSecrets(existing) };
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
    // A variant the user already pinned in cli_model (`model#high`) is never overridden by a second `#<effort>`. A model
    // that lists a single effort, which is also its default, has no variant to choose, so none is appended; an effort
    // that differs from that default is an explicit choice and is honored.
    const defaultNative = this.mapEffort(input.model.default_effort);
    const variant = !base.includes("#") && isExplicitEffort(nativeEffort) && nativeEffort !== "none"
      && (input.model.efforts.length > 1 || nativeEffort !== defaultNative);
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
    const env = input.env ?? process.env;
    const disabledMcp = !input.inheritMcp || readonly ? await readConfiguredMcpServers(input.cwd, env) : undefined;
    const { config: inlineConfig, secrets } = mergeInlineConfig(
      getEnvValue(env, "OPENCODE_CONFIG_CONTENT"), name, agent, nativeDepthLimit(input.nativeSubagents), warnings, disabledMcp);
    return {
      command: launch.command, args: [...launch.prefixArgs, ...args], stdin: input.prompt,
      envOverrides: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig) },
      ...(secrets.length > 0 ? { secrets } : {}),
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
        } else if (event.type === "error" || isObject(event.error)) {
          const error = isObject(event.error) ? event.error : {};
          if (error.type === "provider.auth") state.forceAuthError = true;
          // Structured OpenCode errors keep their text in `error.data.message`.
          const dataMessage = isObject(error.data) ? asString(error.data.message) : undefined;
          const message = asString(error.message) ?? dataMessage ?? asString(event.message) ?? "OpenCode reported an error.";
          state.errors[0] = state.forceAuthError ? `Authentication required: ${message}` : message;
        }
      },
    });
  }
}
