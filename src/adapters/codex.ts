import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { HarnessConfig } from "../config/schema.js";
import { redactSecrets } from "../logging.js";
import { ProgressTracker } from "../runtime/checkpoint.js";
import { getEnvValue } from "../runtime/guard.js";
import { truncateUtf8 } from "../runtime/output.js";
import type { HarnessHealth, ProgressCheckpoint, RunMode, SecurityGuarantee, UsageStats } from "../types.js";
import { BoundedMessages, assertSandboxExtraArgs } from "./parsers.js";
import {
  BoundedLines,
  DEFAULT_PROBE_TIMEOUT_MS,
  adapterError,
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
  PARSER_BUFFER_LIMIT_BYTES,
  probeBinaryAndVersion,
  readOptionalConfigText,
  requireLaunch,
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

const LABEL = "Codex CLI";
const LAST_MESSAGE_FILE = "codex-last-message.txt";
const EFFORT_SYNONYMS: Record<string, string> = {
  off: "none",
  "extra-high": "xhigh",
  "x-high": "xhigh",
  maximum: "max",
};
const AGENT_MESSAGE_TYPES = new Set(["agent_message", "assistant_message"]);
/** Sandbox and approval flags (refused in readonly mode always, in write mode unless unsandboxed writes are allowed), long and short (`-s`, `-a`, `-C` also take an attached value); `-c` overrides are checked separately. */
const FORBIDDEN_SANDBOX_ARGS = new RegExp(`^(?:${[
  "--sandbox", "--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto", "--ask-for-approval", "--approve-for-me",
  // Extra writable directories widen the sandbox just as much as a weaker sandbox mode.
  "--add-dir",
  // The working root is the job's cwd or worktree; a second `-C`/`--cd` would move the sandbox root out of it.
  "--cd",
].join("|")})(?:=|$)|^-[saC]`);
const SANDBOX_CONFIG_KEYS = "sandbox_mode|approval_policy|sandbox_workspace_write|sandbox_permissions|default_permissions|permissions";
/** `windows.sandbox` picks the Windows sandbox implementation; as a dotted key or inside an inline `windows = { ... }` table. */
const WINDOWS_SANDBOX_KEY = "windows\\.sandbox";
const WINDOWS_SANDBOX_TABLE = "windows[\"']?\\s*=\\s*\\{[^]*sandbox";
/**
 * A `-c key=value` override of the sandbox, permission or approval setting: either the key itself (optionally nested under
 * a table such as `profiles.x`), or an inline table assigned to `profile(s)` that carries one of those keys.
 */
const FORBIDDEN_SANDBOX_CONFIG_KEY = new RegExp(
  `^\\s*["']?(?:[\\w-]+\\.)*(?:${SANDBOX_CONFIG_KEYS}|${WINDOWS_SANDBOX_KEY})["']?\\s*[=.]` +
  `|^\\s*["']?(?:[\\w-]+\\.)*${WINDOWS_SANDBOX_TABLE}` +
  `|^\\s*["']?profiles?["']?\\s*=\\s*\\{[^]*(?:${SANDBOX_CONFIG_KEYS}|windows[^]*sandbox)`);
const SANDBOX_CONFIG_KEY_SET: ReadonlySet<string> = new Set(SANDBOX_CONFIG_KEYS.split("|"));
const PROFILE_TABLE_NAMES: ReadonlySet<string> = new Set(["profiles", "profile"]);

/** True when a parsed TOML table sets a sandbox, permission or approval key, or `windows.sandbox`, directly in it. */
function tableSetsSandboxKey(table: Record<string, unknown>): boolean {
  if (Object.keys(table).some((key) => SANDBOX_CONFIG_KEY_SET.has(key))) return true;
  const windows = table.windows;
  return typeof windows === "object" && windows !== null && !Array.isArray(windows) && "sandbox" in windows;
}

/**
 * True when a `-c` override (`key=value`, parsed as TOML so dotted, quoted and inline-table spellings all normalize to the
 * same key path) assigns a sandbox or permission setting at the top level or under any `profiles.<name>` / `profile.<name>`.
 * A value that is not valid TOML (Codex also accepts a bare word such as `sandbox_mode=danger-full-access`) falls back to
 * the textual check, which every override passes through first.
 */
export function isForbiddenSandboxConfigOverride(value: string): boolean {
  if (FORBIDDEN_SANDBOX_CONFIG_KEY.test(value)) return true;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(value) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (tableSetsSandboxKey(parsed)) return true;
  const isTable = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  return Object.entries(parsed).some(([name, table]) => PROFILE_TABLE_NAMES.has(name) && isTable(table)
    && (tableSetsSandboxKey(table) || Object.values(table).some((profile) => isTable(profile) && tableSetsSandboxKey(profile))));
}

/** The Codex config is a small TOML file; anything bigger is not read. */
const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;
const MAX_DISABLED_MCP_SERVERS = 64;
const MAX_MCP_SERVER_NAME_CHARS = 128;
const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;
/** Failures to read the credential store say nothing about whether the user is logged in. */
const STORAGE_ERROR_PATTERN = /keyring|keychain|credential\s+store|auth\.json|permission\s+denied|EACCES|EPERM|EIO|ENOENT|ENOSPC|I\/O\s+error|(?:failed|unable|cannot|could\s+not)\s+(?:to\s+)?(?:read|load|open|access|decrypt)/i;
/** Earlier transient errors are context only; their summary in a warning stays short. */
const MAX_TRANSIENT_WARNING_BYTES = 2_048;
/** Config-load failures say nothing about the login; the status command could not even read its settings. */
const UNREADABLE_CONFIG_PATTERN = /config\.toml|error\s+(?:loading|reading|parsing)\s+config|(?:failed|unable)\s+to\s+(?:load|read|parse)\s+config|invalid\s+(?:config|toml)/i;

function codexUsage(usage: JsonObject): UsageStats | undefined {
  return compactUsage({
    input_tokens: asNumber(usage.input_tokens),
    cached_input_tokens: asNumber(usage.cached_input_tokens),
    output_tokens: asNumber(usage.output_tokens),
  });
}

function errorMessageOf(event: JsonObject): string {
  if (isObject(event.error)) return asString(event.error.message) ?? JSON.stringify(event.error);
  return asString(event.message) ?? asString(event.error) ?? "unknown error";
}

const MAX_FILE_CHANGES_PER_EVENT = 10;
const MAX_OPEN_ITEMS = 128;
/** Codex items that are real model work but neither a tool call nor an assistant message. */
const NON_TOOL_ACTIVITY_TYPES: ReadonlySet<string> = new Set(["reasoning", "web_search", "todo_list"]);

/** Name and safe target of a tool-like Codex item; command output and file contents are never read. */
function toolOfItem(item: JsonObject, itemType: string): Array<{ tool: string; target?: string }> {
  if (itemType === "command_execution") return [{ tool: "shell", target: asString(item.command) }];
  if (itemType === "mcp_tool_call") {
    const server = asString(item.server);
    const tool = asString(item.tool) ?? "mcp_tool";
    return [{ tool: server ? `${server}.${tool}` : tool }];
  }
  if (itemType === "file_change" && Array.isArray(item.changes)) {
    return item.changes.filter(isObject).slice(0, MAX_FILE_CHANGES_PER_EVENT)
      .map((change) => ({ tool: asString(change.kind) ? `file_${asString(change.kind)}` : "file_change", target: asString(change.path) }));
  }
  return [];
}

/** A single-step item is correlated by its id; the steps of a multi-file change get an index suffix. */
function stepCorrelationId(itemId: string, index: number, stepCount: number): string {
  return stepCount === 1 ? itemId : `${itemId}#${index}`;
}

function itemSucceeded(item: JsonObject, itemType: string): boolean {
  if (itemType === "command_execution" && typeof item.exit_code === "number") return item.exit_code === 0;
  return asString(item.status) !== "failed";
}

class CodexStreamParser implements AdapterStreamParser {
  private readonly tracker = new ProgressTracker();
  /** Item id -> number of steps recorded at start, so a completion ends those steps instead of adding new ones. */
  private readonly openItems = new Map<string, number>();
  private readonly rawText = new BoundedLines();
  private structuredEvents = 0;
  private turnCompleted = false;
  private usage?: UsageStats;
  private lastAgentMessage = "";
  private readonly terminalErrors = new BoundedMessages();
  private readonly transientErrors = new BoundedMessages();

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
      case "thread.started":
        this.tracker.setSessionId(asString(event.thread_id));
        break;
      case "item.started":
        this.trackItem(event, false);
        break;
      case "turn.completed":
        this.turnCompleted = true;
        if (isObject(event.usage)) this.usage = codexUsage(event.usage);
        break;
      case "turn.failed":
        this.terminalErrors.push(errorMessageOf(event));
        break;
      case "error":
        this.transientErrors.push(errorMessageOf(event));
        break;
      case "item.completed": {
        const item = isObject(event.item) ? event.item : undefined;
        const itemType = item ? asString(item.type) ?? asString(item.item_type) : undefined;
        const text = item ? asString(item.text) : undefined;
        if (itemType && AGENT_MESSAGE_TYPES.has(itemType) && text) {
          // Kept as the answer fallback when the -o file is empty or missing; bounded like every parser buffer.
          // Redacted before it is cut, so a secret straddling the cut cannot leave a recognizable prefix behind.
          this.lastAgentMessage = truncateUtf8(redactSecrets(text), PARSER_BUFFER_LIMIT_BYTES).text;
          this.tracker.appendText(text);
          this.tracker.noteTurn();
        } else {
          this.trackItem(event, true);
        }
        break;
      }
      default:
        break;
    }
  }

  checkpoint(): ProgressCheckpoint {
    return this.tracker.snapshot();
  }

  progressEvents(): number {
    return this.tracker.events();
  }

  private trackItem(event: JsonObject, completed: boolean): void {
    const item = isObject(event.item) ? event.item : undefined;
    const itemType = item ? asString(item.type) ?? asString(item.item_type) : undefined;
    if (!item || !itemType) return;
    const steps = toolOfItem(item, itemType);
    const id = asString(item.id);
    if (steps.length === 0 && NON_TOOL_ACTIVITY_TYPES.has(itemType)) {
      this.tracker.noteActivity();
      return;
    }
    if (!completed) {
      if (steps.length === 0) return;
      const tracked = id !== undefined && this.openItems.size < MAX_OPEN_ITEMS;
      if (tracked) this.openItems.set(id, steps.length);
      steps.forEach((step, index) => this.tracker.recordToolStart(step.tool, step.target, tracked ? stepCorrelationId(id, index, steps.length) : undefined));
      return;
    }
    const ok = itemSucceeded(item, itemType);
    // The id leaves the open set on every completion, so a multi-step item can never pin a slot forever.
    const startedSteps = id === undefined ? undefined : this.openItems.get(id);
    if (id !== undefined) this.openItems.delete(id);
    if (id !== undefined && startedSteps !== undefined) {
      for (let index = 0; index < startedSteps; index += 1) this.tracker.recordToolEnd(stepCorrelationId(id, index, startedSteps), ok);
      return;
    }
    for (const step of steps) {
      this.tracker.recordToolStart(step.tool, step.target);
      this.tracker.recordToolEnd(step.tool, ok);
    }
  }

  finish(input: FinishParseInput): ParsedAdapterResult {
    const warnings = streamWarnings(input);
    const fileText = input.outputFileContent?.trim() ? input.outputFileContent : "";
    const summary = fileText || this.lastAgentMessage;
    const transient = this.transientErrors.values();
    // The terminal turn.failed decides the failure class: an earlier transient error (say a 429 on a retried request)
    // must not turn a model-specific failure into a rate limit for the whole harness.
    const fatalErrors = this.terminalErrors.length > 0
      ? this.terminalErrors.values()
      : (!this.turnCompleted || !exitedCleanly(input))
        ? transient
        : [];

    if (fatalErrors.length > 0) {
      if (this.terminalErrors.length > 0 && transient.length > 0) {
        warnings.push(`Codex reported earlier transient error(s): ${truncateUtf8(redactSecrets(transient.join("; ")), MAX_TRANSIENT_WARNING_BYTES).text}`);
      }
      return classifiedFailure(LABEL, input, fatalErrors.join("\n"), "NON_ZERO_EXIT", {
        usage: this.usage,
        warnings,
        summary,
        details: { turn_completed: this.turnCompleted, error_events: fatalErrors.length },
      });
    }
    if (transient.length > 0) {
      warnings.push(`Codex recovered after transient error(s): ${transient.join("; ")}`);
    }
    if (!exitedCleanly(input)) {
      return classifiedFailure(LABEL, input, this.rawText.text().trim() || undefined, "NON_ZERO_EXIT", { usage: this.usage, warnings, summary });
    }
    if (this.turnCompleted || fileText) {
      return {
        ok: true,
        summary: redactSecrets(summary),
        ...(this.usage ? { usage: this.usage } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    }
    if (this.structuredEvents === 0) {
      return degradedOrParseError(LABEL, input, this.rawText.text(), "no JSONL events");
    }
    return degradedOrParseError(LABEL, input, this.lastAgentMessage, "no turn.completed event");
  }
}

/** Where Codex keeps its user config: `$CODEX_HOME/config.toml`, by default `~/.codex/config.toml`. */
function codexConfigPath(env: NodeJS.ProcessEnv): string {
  return join(getEnvValue(env, "CODEX_HOME") || join(homedir(), ".codex"), "config.toml");
}

/** A working directory longer than this risks Windows path-length failures inside the Codex sandbox setup. */
const MAX_SAFE_WINDOWS_CWD_CHARS = 240;

/** Lower-cased, backslash-separated, without trailing separators: enough to compare two Windows paths by prefix. */
function comparableWindowsPath(path: string, platform: NodeJS.Platform): string {
  let resolved = path;
  // Expand Windows 8.3 short names (e.g. RUNNER~1 -> runneradmin) when running on real Windows so TEMP under USERPROFILE matches.
  if (platform === "win32" && process.platform === "win32") {
    try {
      resolved = realpathSync.native(path);
    } catch {
      resolved = path;
    }
  }
  return resolved.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/**
 * Non-secret warnings about Windows conditions in which the Codex sandbox setup is known to fail (UNC or OneDrive working
 * directory, a very long path, TEMP/TMP outside the user profile). Empty on other platforms. Paths are never echoed.
 */
export function codexWindowsWarnings(
  cwd: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32") return [];
  const warnings: string[] = [];
  if (cwd.startsWith("\\\\") || cwd.startsWith("//")) {
    warnings.push("The working directory is a UNC (network share) path; the Codex Windows sandbox may fail to set up there. Use a local path.");
  }
  if (cwd.split(/[\\/]/).some((segment) => /onedrive/i.test(segment))) {
    warnings.push("The working directory is inside OneDrive; synced folders can make the Codex Windows sandbox ACL setup fail. Use a local non-synced path.");
  }
  if (cwd.length > MAX_SAFE_WINDOWS_CWD_CHARS) {
    warnings.push(`The working directory path is ${cwd.length} characters long (over ${MAX_SAFE_WINDOWS_CWD_CHARS}); the Codex Windows sandbox may fail. Use a shorter path.`);
  }
  const profile = getEnvValue(env, "USERPROFILE", platform)?.trim();
  if (profile) {
    const root = comparableWindowsPath(profile, platform);
    for (const name of ["TEMP", "TMP"]) {
      const value = getEnvValue(env, name, platform)?.trim();
      if (!value) continue;
      const temp = comparableWindowsPath(value, platform);
      if (temp !== root && !temp.startsWith(`${root}\\`)) {
        warnings.push(`${name} is outside the user profile (USERPROFILE); the Codex Windows sandbox may fail to create its temporary files. Point ${name} under USERPROFILE.`);
      }
    }
  }
  return warnings;
}

/**
 * Names of the MCP servers the user's Codex config defines (`[mcp_servers.<name>]`), to be switched off by name:
 * `-c mcp_servers={}` merges into the user's table instead of replacing it. A missing config file means no servers. A
 * config that exists but cannot be read safely (not a regular file, oversized, unreadable, invalid TOML), or that holds
 * more servers than can be named (too many, empty or overlong names), fails closed: running with `inherit_mcp = false`
 * while some servers stay enabled would break the isolation the caller asked for.
 */
export async function readConfiguredMcpServerNames(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const path = codexConfigPath(env);
  const refuse = (reason: string) => adapterError("SANDBOX_POLICY_VIOLATION",
    `inherit_mcp is false, but the Codex config ${path} ${reason}, so its MCP servers cannot all be switched off. ` +
    `Repair the file (valid TOML, at most ${MAX_DISABLED_MCP_SERVERS} MCP servers, names of 1-${MAX_MCP_SERVER_NAME_CHARS} characters) ` +
    "or set inherit_mcp = true for this harness or run.", false);
  let text: string | undefined;
  try {
    text = await readOptionalConfigText(path, MAX_CODEX_CONFIG_BYTES);
  } catch (error) {
    throw refuse(`could not be read safely (${error instanceof Error ? error.message : "unknown error"})`);
  }
  if (text === undefined) return [];
  let config: unknown;
  try {
    config = parseToml(text);
  } catch {
    throw refuse("is not valid TOML");
  }
  const servers = isObject(config) ? config.mcp_servers : undefined;
  if (servers === undefined) return [];
  if (!isObject(servers)) throw refuse("has an mcp_servers entry that is not a table");
  const names = Object.keys(servers);
  if (names.length > MAX_DISABLED_MCP_SERVERS) throw refuse(`defines ${names.length} MCP servers`);
  if (names.some((name) => name === "" || name.length > MAX_MCP_SERVER_NAME_CHARS)) {
    throw refuse("has an MCP server whose name is empty or too long");
  }
  return names;
}

/**
 * The `-c mcp_servers=...` override that switches the given servers off. Codex splits dotted `-c` keys on every dot and
 * ignores quotes (`mcp_servers."a.b".enabled=false` fails to load), so the servers go into ONE inline table whose keys
 * may be quoted; the table merges with the user's own `[mcp_servers.<name>]` entries instead of replacing them.
 */
function disabledMcpServersOverride(names: readonly string[]): string {
  const entries = names.map((name) => `${BARE_TOML_KEY.test(name) ? name : JSON.stringify(name)}={enabled=false}`);
  return `mcp_servers={${entries.join(",")}}`;
}

const MULTI_AGENT_V2_KEY = "features.multi_agent_v2";

/** True when the user's config already holds the v2 table (discovery records its leaf keys, e.g. `.enabled`). */
function hasMultiAgentV2(keys: readonly string[] | undefined): boolean {
  return keys?.some((key) => key === MULTI_AGENT_V2_KEY || key.startsWith(`${MULTI_AGENT_V2_KEY}.`)) === true;
}

/** Only lowers native subagent limits for this job; the user's config file is never touched. */
function nativeSubagentArgs(control: BuildInvocationInput["nativeSubagents"]): string[] {
  if (!control) return [];
  // A depth of 0 means no subagents at all, so it is enforced like the "off" policy even when the user's config states no depth.
  if (control.policy === "off" || control.maxDepth === 0) {
    return [
      "-c", "features.multi_agent=false",
      ...(hasMultiAgentV2(control.discoveredKeys) ? ["-c", "features.multi_agent_v2.enabled=false"] : []),
    ];
  }
  const lowersDepth = control.discoveredMaxDepth !== undefined && control.maxDepth < control.discoveredMaxDepth;
  return lowersDepth && control.discoveredKeys?.includes("agents.max_depth") ? ["-c", `agents.max_depth=${control.maxDepth}`] : [];
}

export class CodexAdapter implements CliAdapter {
  readonly driver = "codex" as const;
  readonly securityGuarantees: Record<RunMode, SecurityGuarantee> = {
    readonly: "os_sandbox",
    write: "os_sandbox",
  };

  mapEffort(effort: string): string {
    return mapEffortWith(EFFORT_SYNONYMS, effort);
  }

  async probe(harnessId: string, harness: HarnessConfig, options: { timeoutMs?: number } = {}): Promise<HarnessHealth> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    const base = { harnessId, harness, driver: this.driver, securityGuarantees: this.securityGuarantees };
    const binary = await probeBinaryAndVersion(base, timeoutMs);
    if (binary.health) return binary.health;

    const login = await execProbe(binary.binaryPath!, ["login", "status"], timeoutMs);
    const output = `${login.stdout}\n${login.stderr}`;
    let authStatus: HarnessHealth["auth_status"] = "unknown";
    let note: string | undefined;
    let inconclusive = false;
    if (/not\s+logged\s+in/i.test(output)) {
      authStatus = "unauthenticated";
      note = "Run `codex login` to authenticate.";
    } else if (login.ok && /logged\s+in/i.test(output)) {
      authStatus = "ready";
    } else if (login.timedOut) {
      inconclusive = true;
      note = "`codex login status` timed out.";
    } else if (!login.ok && UNREADABLE_CONFIG_PATTERN.test(output)) {
      // The command failed before it could look at the login, so it says nothing about authentication.
      inconclusive = true;
      note = "`codex login status` could not read the Codex config; fix ~/.codex/config.toml and retry.";
    } else if (!login.ok && STORAGE_ERROR_PATTERN.test(output)) {
      // The credential store could not be read: that is an I/O problem, not proof that the user is logged out.
      inconclusive = true;
      note = "`codex login status` could not read the stored credentials; check ~/.codex permissions and retry.";
    } else if (!login.ok && login.exitCode !== null) {
      authStatus = "unauthenticated";
      note = "`codex login status` exited non-zero; run `codex login`.";
    } else {
      note = "Could not determine Codex login status.";
    }

    return healthNow(base, {
      installed: true,
      binary_path: binary.binaryPath,
      version: binary.version,
      auth_status: authStatus,
      ...(inconclusive ? { probe_inconclusive: true } : {}),
      ...(note ? { note } : {}),
    });
  }

  async buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation> {
    const nativeEffort = this.mapEffort(input.effort);
    const userArgs = input.harness.extra_args ?? [];
    // The sandbox and approval switches are refused in write mode too unless unsandboxed writes are allowed.
    assertSandboxExtraArgs(LABEL, userArgs, {
      mode: input.mode,
      allowUnsandboxedWrite: input.allowUnsandboxedWrite,
      readonlyForbidden: FORBIDDEN_SANDBOX_ARGS,
      writeForbidden: FORBIDDEN_SANDBOX_ARGS,
      forbiddenConfigKey: isForbiddenSandboxConfigOverride,
    });
    const launch = requireLaunch(input.harness.binary);
    // Pre-create the -o file with 0600 so Codex overwrites it without widening permissions.
    const outputFile = await writePrivateFile(input.jobDir, LAST_MESSAGE_FILE, "");

    // Top-level flags must precede the `exec` subcommand (verified on codex 0.172.0).
    const args = ["-a", "never"];
    if (input.harness.profile) args.push("-p", input.harness.profile);
    args.push(
      "exec",
      "--json",
      "--ephemeral",
      "--color", "never",
      "-C", input.cwd,
      "-m", input.model.cli_model,
      "-s", input.mode === "readonly" ? "read-only" : "workspace-write",
      ...(isExplicitEffort(nativeEffort) ? ["-c", `model_reasoning_effort=${JSON.stringify(nativeEffort)}`] : []),
      "-o", outputFile,
    );
    const warnings: string[] = codexWindowsWarnings(input.cwd, input.env ?? process.env);
    if (!input.inheritMcp) {
      args.push("-c", disabledMcpServersOverride(await readConfiguredMcpServerNames(input.env)));
    }
    if (!input.isGitRepo) args.push("--skip-git-repo-check");
    if (input.systemContext) args.push("-c", `developer_instructions=${JSON.stringify(input.systemContext)}`);
    args.push(...nativeSubagentArgs(input.nativeSubagents));
    args.push(...userArgs, "-");

    return {
      command: launch.command,
      args: [...launch.prefixArgs, ...args],
      stdin: input.prompt,
      outputFile,
      outputMode: args.includes("--json") ? "streaming" : "buffered",
      tempFiles: [outputFile],
      warnings,
      nativeEffort,
    };
  }

  createStreamParser(): AdapterStreamParser {
    return new CodexStreamParser();
  }
}
