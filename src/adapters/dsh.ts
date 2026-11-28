import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import type { HarnessConfig } from "../config/schema.js";
import { redactSecrets } from "../logging.js";
import { ProgressTracker } from "../runtime/checkpoint.js";
import { getEnvValue } from "../runtime/guard.js";
import type { HarnessHealth, ProgressCheckpoint, RunMode, SecurityGuarantee, UsageStats } from "../types.js";
import { BoundedMessages, assertSandboxExtraArgs } from "./parsers.js";
import {
  BoundedLines,
  BoundedText,
  DEFAULT_PROBE_TIMEOUT_MS,
  asNumber,
  adapterError,
  asString,
  classifiedFailure,
  degradedOrParseError,
  exitedCleanly,
  healthNow,
  isObject,
  isExplicitEffort,
  mapEffortWith,
  probeBinaryAndVersion,
  readOptionalConfigText,
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

const LABEL = "DeepSeek Harness";
const PATCH_FILE = "dsh-patch.yml";
const DEFAULT_PROFILE = "headless";
const DEFAULT_UPSTREAM_PROVIDER = "deepseek-official";
const COMPLETED_REASON = "completed";
/**
 * A user patch or profile switch could undo the sandbox and approval settings of the profile; the flags are refused in
 * readonly mode always and in write mode unless unsandboxed writes are allowed.
 */
const FORBIDDEN_SANDBOX_ARGS = /^(?:--permission-mode|--approval-policy|--patch)(?:=|$)/;
/** DSH keeps its home-level patch layer here; its `mcp-*` plugin entries are the user's MCP servers. */
const HOME_PATCH_FILE = "cordis.patch.yml";
const MAX_HOME_PATCH_BYTES = 1024 * 1024;
const MCP_PLUGIN_ID = /^mcp-[A-Za-z0-9._-]{1,100}$/;
const MAX_DISABLED_MCP_PLUGINS = 64;
/** Built-in MCP plugins that are switched off whenever MCP is not inherited, whatever the home patch holds. */
const ALWAYS_DISABLED_MCP_PLUGINS = ["mcp-resources", "mcp-orchestrator"] as const;
const EFFORT_SYNONYMS: Record<string, string> = {
  minimal: "low",
  "extra-high": "xhigh",
  "x-high": "xhigh",
  maximum: "max",
};

/** Reads one step's usage; DSH reports camelCase, older/other builds may use snake_case. */
function readUsage(usage: JsonObject): UsageStats | undefined {
  const input = asNumber(usage.inputTokens) ?? asNumber(usage.input_tokens);
  const output = asNumber(usage.outputTokens) ?? asNumber(usage.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const cached = asNumber(usage.cacheReadTokens) ?? asNumber(usage.cached_input_tokens) ?? asNumber(usage.cache_read_tokens);
  const cost = asNumber(usage.costUsd) ?? asNumber(usage.cost_usd);
  return {
    input_tokens: input,
    output_tokens: output,
    ...(cached !== undefined ? { cached_input_tokens: cached } : {}),
    ...(cost !== undefined ? { cost_usd: cost } : {}),
  };
}

interface FinalEvent {
  text: string;
  /** undefined: field absent (version drift); null: no terminal turn. */
  reasonKind: string | null | undefined;
  reasonMessage?: string;
}

function readFinal(event: JsonObject): FinalEvent {
  const nested = isObject(event.final) ? event.final : event;
  const text = asString(nested.text) ?? asString(event.text) ?? "";
  const reason = "reason" in nested ? nested.reason : event.reason;
  if (reason === undefined) return { text, reasonKind: undefined };
  if (reason === null) return { text, reasonKind: null };
  if (typeof reason === "string") return { text, reasonKind: reason };
  if (!isObject(reason)) return { text, reasonKind: undefined };
  const error = isObject(reason.error) ? reason.error : undefined;
  const code = error ? asString(error.code) : undefined;
  const message = error ? asString(error.message) : asString(reason.message);
  return {
    text,
    reasonKind: asString(reason.kind) ?? null,
    reasonMessage: [code, message].filter(Boolean).join(": ") || undefined,
  };
}

/** Call id of a tool event; DSH builds name it `id`, `toolCallId`, `callId` or `tool_use_id`. */
function toolCallIdOf(event: JsonObject): string | undefined {
  return asString(event.id) ?? asString(event.toolCallId) ?? asString(event.callId) ?? asString(event.tool_use_id);
}

const TOOL_START_TYPES: ReadonlySet<string> = new Set(["tool_call", "tool_start", "tool_use"]);
const TOOL_END_TYPES: ReadonlySet<string> = new Set(["tool_result", "tool_end"]);

class DshStreamParser implements AdapterStreamParser {
  private readonly tracker = new ProgressTracker();
  private readonly rawText = new BoundedLines();
  private structuredEvents = 0;
  private final?: FinalEvent;
  private readonly errors = new BoundedMessages();
  private readonly streamedText = new BoundedText();
  private usageTotal?: UsageStats;
  private usageComplete = true;

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
    const phase = asString(event.phase);
    if (event.type === "final" || event.type === "completed") {
      this.final = readFinal(event);
    } else if (event.type === "error") {
      this.errors.push(asString(event.message) ?? (isObject(event.error) ? asString(event.error.message) : undefined) ?? "unknown error");
    } else if (event.type === "text") {
      const text = asString(event.text);
      if (text) {
        this.streamedText.append(text);
        this.tracker.appendText(text);
      }
    } else if (event.type === "step_end" || (event.type === "status" && phase === "step_end")) {
      this.recordStepUsage(event.usage);
      this.tracker.noteTurn();
    } else if (event.type === "session") {
      this.tracker.setSessionId(asString(event.sessionId) ?? asString(event.session_id));
    } else if (TOOL_START_TYPES.has(event.type)) {
      const id = toolCallIdOf(event);
      const input = event.input ?? event.args ?? event.arguments;
      this.tracker.recordToolStart(asString(event.name) ?? asString(event.tool) ?? asString(event.toolName) ?? "tool",
        safeToolTarget(input), id, safeToolVariant(input));
    } else if (TOOL_END_TYPES.has(event.type)) {
      const id = toolCallIdOf(event)
        ?? asString(event.name) ?? asString(event.tool) ?? asString(event.toolName);
      if (id) this.tracker.recordToolEnd(id, event.isError !== true && event.is_error !== true && asString(event.status) !== "error");
    }
  }

  checkpoint(): ProgressCheckpoint {
    return this.tracker.snapshot();
  }

  progressEvents(): number {
    return this.tracker.events();
  }

  private recordStepUsage(raw: unknown): void {
    const step = isObject(raw) ? readUsage(raw) : undefined;
    if (!step) {
      // DSH omits usage for a step whose total is unknowable.
      this.usageComplete = false;
      return;
    }
    const total = this.usageTotal ?? {};
    this.usageTotal = {
      input_tokens: (total.input_tokens ?? 0) + (step.input_tokens ?? 0),
      output_tokens: (total.output_tokens ?? 0) + (step.output_tokens ?? 0),
      ...(step.cached_input_tokens !== undefined || total.cached_input_tokens !== undefined
        ? { cached_input_tokens: (total.cached_input_tokens ?? 0) + (step.cached_input_tokens ?? 0) }
        : {}),
      ...(step.cost_usd !== undefined || total.cost_usd !== undefined
        ? { cost_usd: (total.cost_usd ?? 0) + (step.cost_usd ?? 0) }
        : {}),
    };
  }

  private usage(): UsageStats {
    if (!this.usageTotal) return { incomplete: true };
    return this.usageComplete ? this.usageTotal : { ...this.usageTotal, incomplete: true };
  }

  finish(input: FinishParseInput): ParsedAdapterResult {
    const warnings = streamWarnings(input);
    const final = this.final;
    const summary = final?.text || this.streamedText.text();

    if (this.errors.length > 0) {
      return classifiedFailure(LABEL, input, this.errors.values().join("\n"), "NON_ZERO_EXIT", {
        usage: this.usage(),
        warnings,
        summary,
      });
    }

    if (final) {
      const failedReason = final.reasonKind === null || (final.reasonKind !== undefined && final.reasonKind !== COMPLETED_REASON);
      if (failedReason || !exitedCleanly(input)) {
        const kind = final.reasonKind ?? "none";
        const message = final.reasonMessage ?? `run ended with reason ${JSON.stringify(kind)}`;
        return classifiedFailure(LABEL, input, message, "NON_ZERO_EXIT", {
          usage: this.usage(),
          warnings,
          summary,
          details: { reason_kind: safeDetailLabel(kind) },
        });
      }
      return { ok: true, summary: redactSecrets(summary), usage: this.usage(), ...(warnings.length ? { warnings } : {}) };
    }

    if (!exitedCleanly(input)) {
      return classifiedFailure(LABEL, input, this.rawText.text().trim() || undefined, "NON_ZERO_EXIT", { warnings, summary });
    }
    if (this.structuredEvents === 0) return degradedOrParseError(LABEL, input, this.rawText.text(), "no JSONL events");
    return degradedOrParseError(LABEL, input, this.streamedText.text(), "no final event");
  }
}

/** Standard DSH patch ids that switch native subagents on; all of them go off together for policy "off". */
const SUBAGENT_PATCH_IDS = ["tool-subagent", "subagent", "subagent-spawn-in-process"] as const;

/**
 * Patch entries that only ever lower the native subagent limits of this job. A depth patch is written only for a
 * plugin whose own discovered depth exceeds the limit, so no plugin is ever raised (e.g. from 1 to 2).
 */
function nativeSubagentPatches(control: BuildInvocationInput["nativeSubagents"]): Array<Record<string, unknown>> {
  if (!control) return [];
  if (control.policy === "off") return SUBAGENT_PATCH_IDS.map((id) => ({ id, disabled: true }));
  const discovered = control.discoveredPluginDepths ?? {};
  return SUBAGENT_PATCH_IDS
    .filter((id) => discovered[id] !== undefined && discovered[id] > control.maxDepth)
    .map((id) => ({ id, config: { maxDepth: control.maxDepth } }));
}

/** Specifier fields through which a DSH plugin entry names the package it loads. */
const PLUGIN_SPECIFIER_FIELDS = ["name", "plugin", "use", "package", "module"] as const;
const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
const MCP_SPECIFIER = /dsh-mcp|mcp-client/i;
const MAX_PLUGIN_ID_CHARS = 128;
/** Keys under which a patch or profile document nests further plugin lists. */
const NESTED_PLUGIN_LIST_KEYS = ["insert", "plugins", "patches", "patch"] as const;
const MAX_PLUGIN_NESTING = 8;
/** Profile names that are plain, non-reserved file names; anything else is never joined into a path. */
const SAFE_PROFILE_FILE = /^(?!(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/i;

function namesMcpClient(entry: Record<string, unknown>): boolean {
  return PLUGIN_SPECIFIER_FIELDS.some((field) => {
    const value = entry[field];
    return typeof value === "string" && (value === MCP_CLIENT_PACKAGE || MCP_SPECIFIER.test(value));
  });
}

/**
 * Ids of the MCP plugins a patch or profile document defines, at its top level (an array, or an object holding
 * `patches` / `patch` / `plugins`) or inside nested `insert` lists (bounded). An entry is an MCP plugin when its id
 * starts with `mcp-` or when a specifier field (`name`, `plugin`, `use`, `package`, `module`) names the MCP client
 * package, whatever its id. Such an entry without a usable id cannot be switched off, which `onAnonymous` reports.
 */
function collectMcpPluginIds(document: unknown, found: Set<string>, limit: number, onAnonymous: () => never, depth = 0): void {
  if (depth > MAX_PLUGIN_NESTING || found.size >= limit) return;
  if (Array.isArray(document)) {
    for (const entry of document) {
      if (found.size >= limit) return;
      if (!isObject(entry)) continue;
      const id = asString(entry.id);
      const validId = id !== undefined && id.length > 0 && id.length <= MAX_PLUGIN_ID_CHARS;
      if (id !== undefined && MCP_PLUGIN_ID.test(id)) found.add(id);
      else if (namesMcpClient(entry)) {
        if (!validId) onAnonymous();
        found.add(id!);
      }
      collectMcpPluginIds(entry.insert, found, limit, onAnonymous, depth + 1);
      collectNestedPluginContainers(entry, found, limit, onAnonymous, depth + 1);
    }
  } else if (isObject(document)) {
    collectNestedPluginContainers(document, found, limit, onAnonymous, depth);
  }
}

/** Follows the nested plugin lists of one object, and its `config` (a group's plugins live under `group.config`). */
function collectNestedPluginContainers(
  container: Record<string, unknown>, found: Set<string>, limit: number, onAnonymous: () => never, depth: number,
): void {
  for (const key of NESTED_PLUGIN_LIST_KEYS) collectMcpPluginIds(container[key], found, limit, onAnonymous, depth + 1);
  if (isObject(container.config) || Array.isArray(container.config)) {
    collectMcpPluginIds(container.config, found, limit, onAnonymous, depth + 1);
  }
}

/**
 * The MCP plugin ids the user's DSH configuration defines: the profile files `$DSH_HOME/profiles/<profile>.yml|.yaml`
 * and the home patch `$DSH_HOME/cordis.patch.yml` (`$DSH_HOME` defaults to `~/.dsh`). A missing file means none. A file
 * that exists but cannot be read safely (not a regular file, oversized, unreadable, invalid YAML), an MCP plugin entry
 * without an id, an unsafe profile name, or more than `MAX_DISABLED_MCP_PLUGINS` distinct MCP plugins fails closed:
 * running with `inherit_mcp = false` while some plugins stay enabled would break the isolation the caller asked for.
 */
export async function readConfiguredMcpPluginIds(env: NodeJS.ProcessEnv = process.env, profile: string = DEFAULT_PROFILE): Promise<string[]> {
  const home = getEnvValue(env, "DSH_HOME") || join(homedir(), ".dsh");
  const refuseAt = (path: string, reason: string) => adapterError("SANDBOX_POLICY_VIOLATION",
    `inherit_mcp is false, but the DSH config ${path} ${reason}, so its MCP plugins cannot all be switched off. ` +
    `Repair the file (valid YAML, at most ${MAX_DISABLED_MCP_PLUGINS} MCP plugins, each with an id) or set inherit_mcp = true for this harness or run.`, false);
  if (!SAFE_PROFILE_FILE.test(profile)) {
    throw adapterError("SANDBOX_POLICY_VIOLATION",
      "inherit_mcp is false, but the DSH profile name is not a plain file name, so the MCP plugins of that profile cannot all be switched off. " +
      "Use a simple profile name (letters, digits, dot, dash, underscore) or set inherit_mcp = true for this harness or run.", false);
  }
  const paths = [
    join(home, "profiles", `${profile}.yml`),
    join(home, "profiles", `${profile}.yaml`),
    join(home, "profiles", profile, HOME_PATCH_FILE),
    join(home, HOME_PATCH_FILE),
  ];
  const found = new Set<string>();
  for (const path of paths) {
    const refuse = (reason: string) => refuseAt(path, reason);
    let text: string | undefined;
    try {
      text = await readOptionalConfigText(path, MAX_HOME_PATCH_BYTES);
    } catch (error) {
      throw refuse(`could not be read safely (${error instanceof Error ? error.message : "unknown error"})`);
    }
    if (text === undefined) continue;
    let document: unknown;
    try {
      document = parseYaml(text, { maxAliasCount: 0 });
    } catch {
      // The parser's message may quote file content, so it is not repeated.
      throw refuse("is not valid YAML");
    }
    collectMcpPluginIds(document, found, MAX_DISABLED_MCP_PLUGINS + 1, () => { throw refuse("defines an MCP plugin without a usable id"); });
    if (found.size > MAX_DISABLED_MCP_PLUGINS) throw refuse(`defines more than ${MAX_DISABLED_MCP_PLUGINS} MCP plugins`);
  }
  return [...found];
}

export class DshAdapter implements CliAdapter {
  readonly driver = "dsh" as const;
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
    return healthNow(base, {
      installed: true,
      binary_path: binary.binaryPath,
      version: binary.version,
      auth_status: "unknown",
      note: "DeepSeek Harness has no standalone auth-status command; credentials are validated when a job runs.",
    });
  }

  async buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation> {
    const nativeEffort = this.mapEffort(input.effort);
    const userArgs = input.harness.extra_args ?? [];
    assertSandboxExtraArgs(LABEL, userArgs, {
      mode: input.mode,
      allowUnsandboxedWrite: input.allowUnsandboxedWrite,
      readonlyForbidden: FORBIDDEN_SANDBOX_ARGS,
      writeForbidden: FORBIDDEN_SANDBOX_ARGS,
    });
    const launch = requireLaunch(input.harness.binary);
    // Only fixed, allowlisted patch entries are emitted; values are serialized by the YAML library.
    const patchEntries: Array<Record<string, unknown>> = [
      {
        id: "agent-default-model",
        config: {
          provider: input.model.cli_provider ?? input.harness.default_upstream_provider ?? DEFAULT_UPSTREAM_PROVIDER,
          model: input.model.cli_model,
          ...(isExplicitEffort(nativeEffort) ? { reasoningEffort: nativeEffort } : {}),
        },
      },
    ];
    if (input.systemContext) {
      patchEntries.push({
        id: "system-prompt",
        config: {
          personaPrefix: "You are a coding agent powered by the {{model}} model.",
          personaSuffix: input.systemContext,
        },
      });
    }
    if (!input.inheritMcp) {
      // Every MCP plugin goes off: the built-in ones and each `mcp-*` server the user's home patch adds.
      const mcpIds = new Set<string>([...ALWAYS_DISABLED_MCP_PLUGINS, ...await readConfiguredMcpPluginIds(input.env, input.harness.profile ?? DEFAULT_PROFILE)]);
      for (const id of mcpIds) patchEntries.push({ id, disabled: true });
    }
    patchEntries.push(...nativeSubagentPatches(input.nativeSubagents));
    const patchPath = await writePrivateFile(input.jobDir, PATCH_FILE, stringify(patchEntries));

    const args = [
      "--profile", input.harness.profile ?? DEFAULT_PROFILE,
      "--patch", patchPath,
      "--json",
      "--permission-mode", input.mode === "readonly" ? "read-only" : "workspace-write",
      "--approval-policy", "never",
      ...userArgs,
      "-",
    ];

    return {
      command: launch.command,
      args: [...launch.prefixArgs, ...args],
      stdin: input.prompt,
      outputMode: args.includes("--json") ? "streaming" : "buffered",
      tempFiles: [patchPath],
      warnings: [],
      nativeEffort,
    };
  }

  createStreamParser(): AdapterStreamParser {
    return new DshStreamParser();
  }
}
