import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AdapterRegistryLike } from "../adapters/types.js";
import { discoverAllCliLimits } from "../config/cli-limits.js";
import { getRunsDir, getWorktreesDir } from "../config/paths.js";
import { DRIVER_METADATA } from "../drivers.js";
import type { HarnessConfig } from "../config/schema.js";
import { resolveModelAlias, type ConfigManager, type ConfigSnapshot, type ResolvedModel } from "../config/resolver.js";
import { createSecretRedactor, logger, redactSecrets } from "../logging.js";
import {
  buildPlanPreview, delegationAvailability, MAX_SHARDS, PlanPreviewError, suggestRuntimeAlternatives, type DelegationAvailability,
  type PlanLiveConcurrency, type PlanPreviewResult, type PlanSubtaskInput,
} from "../planner/preview.js";
import { ROLES, UNKNOWN_VENDOR, getRoleDefinition, inferVendorFamily, keywordsForRole, resolveRoleId } from "../roles/registry.js";
import { resolveHarnessConcurrency } from "../runtime/concurrency.js";
import { validateCwd, type ValidatedCwd } from "../runtime/guard.js";
import type { LogPart } from "../runtime/job-store.js";
import { truncateUtf8 } from "../runtime/output.js";
import { deriveSessionKey, sessionDisplayId } from "../runtime/session-key.js";
import {
  defaultFailureScope, type JobActivity, type OrchestratorRunner, type QueueExplanation, type RunJobRequest, type WaitForStatusOptions,
  type WaitForStatusResult,
} from "../runtime/runner.js";
import type { ErrorCode, HarnessConcurrencyInfo, HarnessHealth, JobRecord, RunMode, StructuredError } from "../types.js";
import { RunIdempotencyLedger, runFingerprint, type IdempotentRun } from "./idempotency.js";
import {
  invalidInputError, looseEnum, normalizeContextId, optBool, optInt, optNum, optObj, optObjList, optStr, optStrList, pickKnown,
  unknownArgsWarning, type NestedArgs,
} from "./input.js";

export interface ToolDependencies {
  configManager: ConfigManager;
  adapterRegistry: AdapterRegistryLike;
  runner: Pick<OrchestratorRunner<PlanPreviewResult>, "savePlan" | "getPlan" | "getRuntimeDegradations" | "clearRuntimeDegradations" | "run" | "getJob" | "listJobs" |
    "waitForStatus" | "readLogs" | "cancelJob" | "shutdown"> &
    Partial<Pick<OrchestratorRunner<PlanPreviewResult>, "waitForStatusDetailed" | "getJobActivity" | "getConcurrencySnapshot" | "explainQueue">>;
  /** Interval between `notifications/progress` heartbeats while orch_status holds (default 15000). */
  progressIntervalMs?: number;
  /** Hold cap for clients that send no progress token, and the first ramp step for those that do (default 40000). */
  initialHoldCapMs?: number;
  /** Largest hold cap the self-calibrating ramp may reach (default 600000). */
  maxHoldCapMs?: number;
  /** Window for coalescing tightly clustered completions into one `any_terminal` wake (default 1500). */
  settleMs?: number;
  /** Where orchestrator worktrees live, so a job running in one counts against its main repository; default is the state dir. */
  worktreesDir?: string;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const BRIEF_CATALOG_BYTES = 8_000;
const PLAN_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_OUTPUT_BYTES = 24_000;
// Leave room for the SDK's outer JSON-RPC encoding even with an oversized config value.
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_WAIT_MS = 600_000;
const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;
const DEFAULT_INITIAL_HOLD_CAP_MS = 40_000;
const DEFAULT_MAX_HOLD_CAP_MS = 600_000;
const DEFAULT_SETTLE_MS = 1_500;
const INTERMEDIATE_HOLD_CAPS_MS = [90_000, 180_000, 300_000];
/** A dropped hold implies the host limit is somewhere below the elapsed time; stay this far under it. */
const HOLD_SAFETY_MARGIN_MS = 15_000;
const MIN_LEARNED_HOLD_CAP_MS = 15_000;
const CLEAN_STREAK_TO_RAISE_CAP = 2;
const LEARNED_CAP_RECOVERY_FACTOR = 1.5;
const MIN_EXPLICIT_HOLD_CAP_MS = 1_000;
const HEALTH_PROBE_CEILING_MS = 2_000;
const MAX_PROGRESS_RUNNING_JOBS = 3;
/** How long a progress notification may stay unflushed once its hold is over; a stalled stdout reader must not hold the reply. */
const PROGRESS_FLUSH_GRACE_MS = 1_000;
const STATUS_SUMMARY_BYTES = 1_024;
const MAX_LOG_CHUNK_BYTES = 24_000;
const OVERSIZED_ERROR: StructuredError = {
  code: "INTERNAL_ERROR",
  message: "The response exceeds max_mcp_output_bytes. Request fewer items or increase the configured limit.",
  retryable: false,
};
const EXHAUSTED_MESSAGE = "All enabled delegation models are unavailable. Stop all main work, do not run subtasks directly, " +
  "and notify the user with the blocked harnesses and recovery options.";
const EXHAUSTED_SHORT_MESSAGE = "All delegation models are unavailable. Stop all main work and notify the user.";
const MODES = ["readonly", "write"] as const;
const ISOLATIONS = ["shared", "worktree"] as const;
const MODE_ALIASES = { read_only: "readonly", read_write: "write" } as const;
const ISOLATION_ALIASES = { git_worktree: "worktree" } as const;
const UNTIL_VALUES = ["any_change", "any_terminal", "all_terminal"] as const;
const UNTIL_ALIASES = {
  any: "any_terminal", terminal: "any_terminal", all: "all_terminal", change: "any_change", changes: "any_change",
} as const;
const LOG_PARTS = ["summary", "stdout", "stderr", "diff", "files", "checkpoint"] as const;
const LOG_PART_ALIASES = {
  result: "summary", output: "stdout", log: "stdout", err: "stderr", error: "stderr", patch: "diff", meta: "files",
} as const;
const MAX_INVALID_INPUT_ITEMS = 20;
const MAX_INVALID_INPUT_ITEM_CHARS = 120;
const MAX_INVALID_INPUT_EXAMPLE_CHARS = 1_500;
const TIGHT_INVALID_INPUT_EXAMPLE_CHARS = 500;
const MAX_RESUME_CHARS = 1_000;
const PREVIEW_EXAMPLE = {
  cwd: "/abs/project", subtasks: [{ id: "review", title: "Review the change", task_type: "review", mode: "readonly" }],
};
/**
 * Errors raised before any CLI started and caused by provider/model admission: another route is safe.
 * QUEUE_FULL and CONCURRENCY_LIMIT are deliberately absent: they are local capacity limits that follow the caller to any
 * harness, so rerouting only moves the load; the caller should wait for running jobs or lower the parallelism instead.
 */
const REROUTABLE_ADMISSION_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "HARNESS_UNAVAILABLE", "MODEL_UNSUPPORTED", "CLI_NOT_FOUND", "AUTH_REQUIRED", "QUOTA_EXCEEDED", "RATE_LIMITED",
  "PROVIDER_OVERLOADED", "PROMPT_TOO_LARGE",
]);

const CATALOG_SHAPE = {
  detail: looseEnum(["brief", "full"], { compact: "brief", short: "brief", summary: "brief", verbose: "full", detailed: "full" }, "brief"),
  search: optStr(),
  task_type: optStr(),
  preset: optStr().describe("Return only this preset, with its full role map."),
  include_preset_roles: optBool(false).describe("Return full role maps for all presets."),
  harness: optStr(),
  tier: looseEnum(["deep", "standard", "light", "specialist"]),
  include_unavailable: optBool(),
  refresh_health: optBool(false),
  limit: optInt({ min: 1, max: 100, clampMax: 100, default: 20 }),
  offset: optInt({ min: 0, default: 0 }).describe("Skip this many matching models (use next_offset to paginate)."),
};

const OVERRIDE_SHAPE = { harness: optStr(), model: optStr(), effort: optStr() };
const OVERRIDE_KEYS = Object.keys(OVERRIDE_SHAPE);

const SUBTASK_SHAPE = {
  id: optStr({ blank: "keep" }).describe("Unique subtask ID."),
  title: optStr().describe("Subtask title in English for model-to-model orchestration. Defaults to id."),
  task_type: optStr({ blank: "keep" }).describe("Role, for example review, architecture, implementation."),
  mode: looseEnum(MODES, MODE_ALIASES),
  isolation: looseEnum(ISOLATIONS, ISOLATION_ALIASES),
  // The 1..8 range is enforced in toPlanSubtasks so an out-of-range count gets a precise INVALID_INPUT, not a generic schema error.
  shards: optInt().describe(`Split into N independent shards, 1..${MAX_SHARDS} (ids <id>#1..<id>#N). Write shards always run in worktrees.`),
  override: optObj(z.looseObject(OVERRIDE_SHAPE)),
};

/** Loose so a misplaced key (for example `model` instead of `override.model`) is reported in `ignored_arguments`, not dropped silently. */
const SUBTASK_INPUT = z.looseObject(SUBTASK_SHAPE);
const SUBTASK_KEYS = Object.keys(SUBTASK_SHAPE);
const SUBTASK_KEY_HINTS = { harness: "override.harness", model: "override.model", effort: "override.effort" } as const;

const PLAN_PREVIEW_SHAPE = {
  exclude_harnesses: optStrList().describe("Skip these harnesses when selecting models (e.g. after quota/auth failure)."),
  exclude_models: optStrList().describe("Skip these models when selecting models."),
  locale: looseEnum(["en", "ru"], { english: "en", russian: "ru" }).describe("Output language for plan table and warnings (default: en)."),
  host_vendor: optStr().describe('Vendor family of the host agent (e.g. "anthropic", "openai", "google", "deepseek", "zai"); used to warn when advisors share it.'),
  intent: looseEnum(["general", "design_consult"], { design: "design_consult", consult: "design_consult", consultation: "design_consult" })
    .describe('"design_consult" warns when any advisor matches host_vendor or advisors collapse to one vendor. Omitted: a readonly architecture + second_opinion pair counts as a consultation; "general" never does.'),
  subtasks: optObjList(SUBTASK_INPUT).describe("Required. At least one subtask: [{ id, task_type, title? }]."),
  preset: optStr().describe('Routing preset ID. Always defaults to "balanced" when omitted or blank; do not ask the user to choose a preset.'),
  cwd: optStr(),
  refresh_health: optBool(false),
  context_id: optStr({ blank: "keep" })
    .describe("Optional task-scoped context ID shared across plans within one user prompt to allow explicit continue_from_job_id handoffs."),
};

const RUN_SHAPE = {
  harness: optStr(),
  model: optStr().describe("Optional with plan_id and subtask_id; filled from the saved plan."),
  effort: optStr(),
  prompt: optStr({ blank: "keep" }).describe("Write in English for model-to-model orchestration. Required unless continuing a job."),
  system_context: optStr().describe("Write in English for model-to-model orchestration."),
  cwd: optStr({ blank: "keep" }).describe("Working directory; filled from plan_id or continue_from_job_id when omitted."),
  mode: looseEnum(MODES, MODE_ALIASES).describe("Optional with plan_id and subtask_id; filled from the saved plan."),
  isolation: looseEnum(ISOLATIONS, ISOLATION_ALIASES),
  role: optStr(),
  base_ref: optStr(),
  plan_id: optStr(),
  subtask_id: optStr(),
  continue_from_job_id: optStr()
    .describe("Opt-in: continue from a completed/failed/timed-out job in the same plan_id or context_id via a portable compact handoff."),
  fresh: optBool().describe("Discard saved progress of an earlier timed-out attempt of the same plan_id and subtask_id and start over."),
  context_id: optStr({ blank: "keep" })
    .describe("Task-scoped context ID linking multi-plan continuations within a single user prompt."),
  client_request_id: optStr({ blank: "keep" }),
  inherit_mcp: optBool(),
  async: optBool(),
  wait_ms: optInt({ min: 0, clampMax: MAX_WAIT_MS }),
  timeout_sec: optNum({ positive: true })
    .describe("Soft time budget in seconds. Omit it: the server picks one by effort and automatically extends a streaming job that keeps " +
      "making progress (up to the configured maximum), while a stalled job is stopped early as idle. " +
      "After a TIMEOUT with timeout_kind \"soft\" you may retry the SAME harness/model with a larger value."),
  strict_timeout: optBool()
    .describe("Only when an exact wall-clock limit is truly required: disables automatic extension and idle detection so timeout_sec is a hard stop."),
  label: optStr().describe("Write in English for model-to-model orchestration."),
};

const STATUS_SHAPE = {
  job_ids: optStrList(),
  job_id: optStrList().describe("Alias of job_ids: one job ID or a list."),
  plan_id: optStr(),
  since_version: optInt({ min: 0 }),
  wait_ms: optInt({ min: 0 }).describe(`Hold up to this many ms (values above ${MAX_WAIT_MS} are lowered to ${MAX_WAIT_MS}).`),
  until: looseEnum(UNTIL_VALUES, UNTIL_ALIASES, "any_change"),
  cursor: optStr({ blank: "keep" }).describe("Opaque cursor returned by the previous orch_status call."),
};

const LOGS_SHAPE = {
  job_id: optStr(),
  part: looseEnum(LOG_PARTS, LOG_PART_ALIASES, "summary"),
  offset_bytes: optInt({ min: 0 }),
  limit_bytes: optInt({ min: 0 }),
};

const CANCEL_SHAPE = { job_id: optStr(), cleanup_worktree: optBool(false), force_cleanup: optBool(false) };

const CATALOG_INPUT = z.looseObject(CATALOG_SHAPE);
const PLAN_PREVIEW_INPUT = z.looseObject(PLAN_PREVIEW_SHAPE);
const RUN_INPUT = z.looseObject(RUN_SHAPE);
const STATUS_INPUT = z.looseObject(STATUS_SHAPE);
const LOGS_INPUT = z.looseObject(LOGS_SHAPE);
const CANCEL_INPUT = z.looseObject(CANCEL_SHAPE);
const CATALOG_KEYS = Object.keys(CATALOG_SHAPE);
const PLAN_PREVIEW_KEYS = Object.keys(PLAN_PREVIEW_SHAPE);
const RUN_KEYS = Object.keys(RUN_SHAPE);
const STATUS_KEYS = Object.keys(STATUS_SHAPE);
const LOGS_KEYS = Object.keys(LOGS_SHAPE);
const CANCEL_KEYS = Object.keys(CANCEL_SHAPE);

function json(value: unknown): string {
  const redact = createSecretRedactor();
  return JSON.stringify(value, (key, field: unknown) => {
    if (/^authorization$/i.test(key) && field != null) return "[REDACTED]";
    if (typeof field === "string") return redact(field);
    if (!field || typeof field !== "object" || Array.isArray(field)) return field;
    return Object.fromEntries(Object.entries(field).map(([name, entry]) => [redact(name), entry]));
  });
}

function textResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

function asStructuredError(cause: unknown): StructuredError {
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" &&
      "message" in cause && typeof cause.message === "string" &&
      "retryable" in cause && typeof cause.retryable === "boolean") {
    return cause as StructuredError;
  }
  return {
    code: "INTERNAL_ERROR",
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
  };
}

/** The decisive hard-stop fields of an unlaunchable plan; the last payload that must survive any byte budget. */
function exhaustedPlanCore(retryable: boolean, message: string) {
  return {
    plan_id: null,
    launchable: false,
    delegation_status: "exhausted" as const,
    blocked_reason: "DELEGATION_UNAVAILABLE" as const,
    error: {
      code: "DELEGATION_UNAVAILABLE" as const, message, retryable, failure_scope: "harness" as const,
      safe_to_reroute: false, delegation_state: "exhausted" as const,
    } satisfies StructuredError,
  };
}

/** Smallest payload that still tells the host to stop: delegation is exhausted, plus the error code and retry flag. */
function exhaustionStub(code: ErrorCode, retryable: boolean) {
  return { delegation: { state: "exhausted" as const }, error: { code, delegation_state: "exhausted" as const, retryable } };
}

/** The decisive error of a job or run only when its reply carries an exhausted `delegation`; undefined otherwise. */
function exhaustionStubFor(extra: object, error: Pick<StructuredError, "code" | "retryable"> | undefined) {
  const delegation = "delegation" in extra ? extra.delegation : undefined;
  const exhausted = Boolean(delegation && typeof delegation === "object" && "state" in delegation && delegation.state === "exhausted");
  return exhausted && error ? exhaustionStub(error.code, error.retryable) : undefined;
}

class ResponseBudget {
  private readonly maxBytes: number;

  constructor(configuredBytes = DEFAULT_OUTPUT_BYTES) {
    // Reserve room for a valid error, or for the delegation hard stop, even when a config sets an unusably small limit.
    this.maxBytes = Math.max(
      Buffer.byteLength(json({ error: OVERSIZED_ERROR })),
      // The non-retryable form is the longer one ("false" vs "true") and is the last step of every exhausted payload.
      Buffer.byteLength(json(exhaustedPlanCore(false, EXHAUSTED_SHORT_MESSAGE))),
      // Longest error code, non-retryable: the last step of an exhausted job or run reply.
      Buffer.byteLength(json(exhaustionStub("SANDBOX_POLICY_VIOLATION", false))),
      Math.min(Math.floor(configuredBytes), MAX_OUTPUT_BYTES),
    );
  }

  /** Returns the first payload that fits, so a decisive payload can degrade stepwise instead of becoming a generic error. */
  firstFitting(payloads: unknown[], isError = false): CallToolResult {
    for (const payload of payloads) {
      const text = json(payload);
      if (this.fits(text)) return textResult(text, isError);
    }
    return textResult(json({ error: OVERSIZED_ERROR }), true);
  }

  fits(text: string): boolean {
    return Buffer.byteLength(text) <= this.maxBytes;
  }

  result(value: unknown, isError = false): CallToolResult {
    const text = json(value);
    if (this.fits(text)) return textResult(text, isError);
    return textResult(json({ error: OVERSIZED_ERROR }), true);
  }

  /** How many leading items fit in one response built by `payload` (binary search). */
  pageSize<T>(items: T[], payload: (page: T[]) => unknown): number {
    if (this.fits(json(payload(items)))) return items.length;
    let low = 0;
    let high = Math.max(0, items.length - 1);
    while (low < high) {
      const count = Math.ceil((low + high) / 2);
      if (this.fits(json(payload(items.slice(0, count))))) low = count;
      else high = count - 1;
    }
    return low;
  }

  list<T>(items: T[], payload: (page: T[]) => unknown): CallToolResult {
    const full = json(payload(items));
    if (this.fits(full)) return textResult(full, false);
    return this.result(payload(items.slice(0, this.pageSize(items, payload))));
  }

  /** `extra` carries small top-level fields (such as `delegation`) that must survive every compaction step. */
  job(record: JobRecord, isError = false, extra: object = {}): CallToolResult {
    // The session key is derived from a filesystem path; only its short `session_id` label is for callers.
    const { session_key: _internalSessionKey, ...job } = record;
    const full = json({ ...job, ...extra });
    if (this.fits(full)) return textResult(full, isError);

    const compact: JobRecord & object = {
      ...job,
      worktree: worktreeSummary(job.worktree),
      warnings: [],
      error: errorSummary(job.error),
      result: job.result && { ...job.result, summary: "", truncated: true },
    };
    if (!this.fits(json({ ...compact, ...extra }))) {
      // Keep the identifiers needed to retrieve the full result even with a very small budget.
      const base = { job_id: job.job_id, version: job.version, status: job.status, log_path: job.log_path, truncated: true };
      const error = compact.error;
      const core = errorCore(job.error);
      const stub = exhaustionStubFor(extra, job.error);
      return this.firstFitting([
        { ...extra, ...base, worktree: compact.worktree, error },
        { ...extra, ...base, worktree: compact.worktree, error: core },
        { ...slimExtra(extra), ...base, error: core },
        { ...base, error: core },
        ...(stub ? [stub] : []),
      ], isError);
    }
    if (compact.result && job.result) {
      const points = [...redactSecrets(job.result.summary)];
      let low = 0;
      let high = points.length;
      while (low < high) {
        const count = Math.ceil((low + high) / 2);
        compact.result.summary = points.slice(0, count).join("");
        if (this.fits(json({ ...compact, ...extra }))) low = count;
        else high = count - 1;
      }
      compact.result.summary = points.slice(0, low).join("");
    }
    return this.result({ ...compact, ...extra }, isError);
  }
}

async function probeHarnesses(
  config: ConfigSnapshot, registry: AdapterRegistryLike, refresh?: boolean, onlyHarness?: string,
): Promise<Record<string, HarnessHealth>> {
  const entries = Object.entries(config.harnesses).filter(([id]) => onlyHarness === undefined || id === onlyHarness);
  return Object.fromEntries(await Promise.all(entries.map(async ([id, harness]) => {
    const health: HarnessHealth = harness.enabled
      ? await registry.probeHarness(id, harness, { refresh })
      : {
        harness: id,
        driver: harness.driver,
        enabled: false,
        installed: false,
        auth_status: "unknown",
        security_guarantees: registry.get(harness.driver).securityGuarantees,
        contract: DRIVER_METADATA[harness.driver].contract,
        checked_at: new Date().toISOString(),
        note: "Harness is disabled.",
      };
    return [id, health];
  })));
}

function isReady(health: HarnessHealth | undefined): boolean {
  return Boolean(health?.enabled && health.installed && health.auth_status !== "unauthenticated");
}

/** Full health for usable harnesses; a short stub for disabled or missing ones keeps the catalog within budget. */
type CompactHarnessHealth = Pick<HarnessHealth, "harness" | "driver" | "enabled" | "installed" | "auth_status" | "contract" | "runtime_warning">;

/** Effective parallel limits per harness, from the CLIs' own configs (read-only) plus the catalog defaults. */
async function resolveConcurrencyByHarness(
  config: ConfigSnapshot, harnessIds: readonly string[], options: { refresh?: boolean; cwd?: string },
): Promise<Record<string, HarnessConcurrencyInfo>> {
  const harnesses = Object.fromEntries(harnessIds.flatMap((id) => Object.hasOwn(config.harnesses, id) ? [[id, config.harnesses[id]]] : []));
  const limits = await discoverAllCliLimits({ harnesses }, options);
  return Object.fromEntries(Object.entries(limits).map(([id, cliLimits]) => [id,
    resolveHarnessConcurrency({ harnessId: id, harness: harnesses[id], defaults: config.defaults, cliLimits })]));
}

function catalogHarnesses(
  health: Record<string, HarnessHealth>, includeUnavailable: boolean,
): Array<HarnessHealth | CompactHarnessHealth> {
  return Object.values(health).flatMap((entry): Array<HarnessHealth | CompactHarnessHealth> => {
    if (!includeUnavailable && !isReady(entry)) return [];
    if (entry.enabled && entry.installed) return [entry];
    const { harness, driver, enabled, installed, auth_status, contract, runtime_warning } = entry;
    return [{ harness, driver, enabled, installed, auth_status, contract, runtime_warning }];
  });
}

function catalogModelCard(id: string, model: ResolvedModel, harnessReady: boolean, brief: boolean) {
  if (brief) {
    const { harness, tier, cost_tier, default_effort, is_stale } = model;
    return { id, harness, tier, cost_tier, default_effort, ...(is_stale ? { is_stale } : {}), harness_ready: harnessReady };
  }
  const { field_provenance, _base_hash, ...card } = model;
  return { id, ...card, harness_ready: harnessReady };
}

function worktreeSummary(worktree?: JobRecord["worktree"]): JobRecord["worktree"] {
  if (!worktree) return undefined;
  const { path, branch, base_commit, dirty, relative_cwd } = worktree;
  return { path, branch, base_commit, dirty, relative_cwd };
}

/** Keeps what a caller needs to fix a malformed call (missing fields, a working example), bounded so it cannot flood a reply. */
function invalidInputDetails(error: StructuredError, maxExampleChars: number): { details: Record<string, unknown> } | undefined {
  if (error.code !== "INVALID_INPUT" || !error.details) return undefined;
  const { missing, example } = error.details;
  const missingNames = Array.isArray(missing)
    ? missing.filter((name): name is string => typeof name === "string").slice(0, MAX_INVALID_INPUT_ITEMS)
      .map((name) => truncateUtf8(name, MAX_INVALID_INPUT_ITEM_CHARS).text)
    : undefined;
  // The final reply serializer redacts secrets in every string, so only the size is bounded here.
  const keepExample = example !== undefined && (JSON.stringify(example)?.length ?? Infinity) <= maxExampleChars;
  const details = {
    ...(missingNames?.length ? { missing: missingNames } : {}),
    ...(keepExample ? { example } : {}),
  };
  return Object.keys(details).length > 0 ? { details } : undefined;
}

/** The ready-to-send resume call of a failed job with partial progress, dropped when it would be unreasonably large. */
function resumeHint(error: StructuredError): Pick<StructuredError, "resume"> {
  const { resume } = error;
  return resume && JSON.stringify(resume).length <= MAX_RESUME_CHARS ? { resume } : {};
}

function errorSummary(error?: StructuredError): StructuredError | undefined {
  if (!error) return undefined;
  const { code, message, retryable, failure_scope, safe_to_reroute, suggested_alternatives, delegation_state, retry_same_model,
    suggested_timeout_sec, has_partial_progress, timeout_kind } = error;
  const raw = error.raw_error && redactSecrets(error.raw_error);
  const stderr = error.stderr_tail && redactSecrets(error.stderr_tail);
  return {
    code, message: truncateUtf8(redactSecrets(message), 1500).text, retryable, failure_scope, safe_to_reroute,
    raw_error: raw && truncateUtf8(raw, 1500).text,
    stderr_tail: stderr?.trim() && stderr !== raw ? truncateUtf8(stderr, 1000).text : undefined,
    suggested_alternatives, delegation_state, retry_same_model, suggested_timeout_sec,
    ...(timeout_kind === undefined ? {} : { timeout_kind }),
    ...(has_partial_progress === undefined ? {} : { has_partial_progress }),
    ...resumeHint(error),
    ...invalidInputDetails(error, MAX_INVALID_INPUT_EXAMPLE_CHARS),
    ...(error.code === "TIMEOUT" && error.details ? { details: error.details } : {}),
  };
}

/** The decisive error fields only: what the host needs to choose between retry, reroute, and hard stop. */
function errorCore(error?: StructuredError): StructuredError | undefined {
  if (!error) return undefined;
  const { code, retryable, failure_scope, safe_to_reroute, delegation_state, retry_same_model, suggested_timeout_sec,
    has_partial_progress, timeout_kind } = error;
  return {
    code, message: truncateUtf8(redactSecrets(error.message), 200).text, retryable, failure_scope, safe_to_reroute,
    delegation_state, retry_same_model, suggested_timeout_sec,
    ...(timeout_kind === undefined ? {} : { timeout_kind }),
    ...(has_partial_progress === undefined ? {} : { has_partial_progress }),
    ...resumeHint(error),
    ...invalidInputDetails(error, TIGHT_INVALID_INPUT_EXAMPLE_CHARS),
  };
}

/** Drops the potentially huge per-harness map from a top-level `delegation`, keeping its decisive fields. */
function slimExtra(extra: object): object {
  if (!("delegation" in extra) || !extra.delegation || typeof extra.delegation !== "object") return extra;
  const { blocked_by_harness: _dropped, ...rest } = extra.delegation as Record<string, unknown>;
  return { ...extra, delegation: rest };
}

/** Identifiers plus decisive error fields of one job; used when the full summary does not fit the budget. */
function tightJobSummary(job: JobRecord, rendered: object): object {
  const { job_id, version, status, harness, model, plan_id, subtask_id, log_path } = job;
  const error = errorCore(job.error);
  const extras = "last_output_ms_ago" in rendered ? { last_output_ms_ago: rendered.last_output_ms_ago } : {};
  return { job_id, version, status, harness, model, plan_id, subtask_id, log_path, ...extras, ...(error ? { error } : {}) };
}

function isTerminalJob(job: JobRecord): boolean {
  return job.status !== "queued" && job.status !== "running";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** One-line live status for progress heartbeats, e.g. "1/3 done · codex/gpt-6.2-sol running 1m42s (output 4s ago)". */
function describeProgress(jobs: JobRecord[], activity: Record<string, JobActivity>, nowMs: number): string {
  const running = jobs.filter((job) => job.status === "running");
  const queued = jobs.filter((job) => job.status === "queued").length;
  const parts = [`${jobs.filter(isTerminalJob).length}/${jobs.length} done`];
  for (const job of running.slice(0, MAX_PROGRESS_RUNNING_JOBS)) {
    const elapsed = formatDuration(nowMs - Date.parse(job.started_at ?? job.created_at));
    const ago = activity[job.job_id]?.last_output_ms_ago;
    parts.push(`${job.harness}/${job.model} running ${elapsed} (${ago === undefined ? "no output yet" : `output ${formatDuration(ago)} ago`})`);
  }
  if (running.length > MAX_PROGRESS_RUNNING_JOBS) parts.push(`+${running.length - MAX_PROGRESS_RUNNING_JOBS} more running`);
  if (queued > 0) parts.push(`${queued} queued`);
  return redactSecrets(parts.join(" · "));
}

/** Short stand-in for a running job that did not change since the caller's cursor. */
function runningStub(job: JobRecord, activity: Record<string, JobActivity>, queue?: QueueExplanation) {
  const { job_id, version, status, harness, model, subtask_id, plan_id, session_id, timeout } = job;
  return {
    job_id, version, status, harness, model, subtask_id, plan_id, last_output_ms_ago: activity[job_id]?.last_output_ms_ago,
    ...(session_id === undefined ? {} : { session_id }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(queue === undefined ? {} : { queue }),
  };
}

export interface ProgressHeartbeat {
  /** Sends one `notifications/progress` now, or queues the latest frame while an earlier one is still being written (no-op after `stop`). */
  send(): void;
  /** Stops the interval, drops the queued frame, and gives an in-flight write at most the flush grace to finish before the reply. */
  stop(): Promise<void>;
}

/**
 * Single-flight progress notifications: at most one write is in flight, and while it is, further sends collapse into one
 * pending frame that is rendered when it is finally written (so it always carries the freshest status). A reader that stops
 * draining stdout therefore costs one stuck promise, never a growing queue, and `stop` never waits for it beyond the grace.
 */
export function startProgressHeartbeat(
  extra: Pick<ToolExtra, "sendNotification">, progressToken: string | number, intervalMs: number, describe: () => string,
  flushGraceMs = PROGRESS_FLUSH_GRACE_MS,
): ProgressHeartbeat {
  const startedAt = performance.now();
  let lastProgress = 0;
  let closed = false;
  let framePending = false;
  let inFlight: { done: Promise<void>; startedAt: number } | undefined;
  const close = () => {
    closed = true;
    framePending = false;
    clearInterval(timer);
  };
  const dispatch = () => {
    const progress = Math.max(lastProgress + 1, Math.round(performance.now() - startedAt));
    lastProgress = progress;
    let written: Promise<void>;
    try {
      written = extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message: describe() } });
    } catch {
      close();
      return;
    }
    const flight = {
      startedAt: performance.now(),
      done: written.catch(close).finally(() => {
        if (inFlight === flight) inFlight = undefined;
        if (!framePending || closed) return;
        framePending = false;
        dispatch();
      }),
    };
    inFlight = flight;
  };
  const send = () => {
    if (closed) return;
    if (inFlight) framePending = true;
    else dispatch();
  };
  const stop = async () => {
    close();
    const flight = inFlight;
    if (!flight) return;
    const remainingGraceMs = Math.max(0, flushGraceMs - (performance.now() - flight.startedAt));
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([flight.done, new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, remainingGraceMs); })]);
    } finally {
      clearTimeout(graceTimer);
    }
  };
  const timer = setInterval(send, Math.max(1, intervalMs));
  timer.unref();
  return { send, stop };
}

/** The session a plan for `cwd` would run in, with how many jobs of it and of the whole host are running right now. */
function liveConcurrencyFor(
  runner: ToolDependencies["runner"], config: ConfigSnapshot, cwd: ValidatedCwd, contextId: string | undefined, worktreesDir: string,
): PlanLiveConcurrency {
  const sessionKey = deriveSessionKey({ scope: config.defaults.concurrency_scope, contextId, cwd, worktreesDir });
  const snapshot = runner.getConcurrencySnapshot?.(sessionKey);
  return {
    session_id: sessionDisplayId(sessionKey),
    session_active: snapshot?.session_active ?? 0,
    host_active: snapshot?.host_active ?? 0,
    harness_active: snapshot?.by_harness ?? {},
  };
}

function jobSummary(job: JobRecord, queue?: QueueExplanation) {
  const { job_id, version, status, harness, model, effort, mode, isolation, label, result, log_path, error,
    plan_id, subtask_id, started_at, finished_at, context_id, continued_from, session_id, timeout } = job;
  const summary = result && truncateUtf8(redactSecrets(result.summary), STATUS_SUMMARY_BYTES);
  const duration_ms = result?.duration_ms ?? (started_at && finished_at
    ? Date.parse(finished_at) - Date.parse(started_at) : undefined);
  return {
    job_id, version, status, harness, model, effort, mode, isolation, label, plan_id, subtask_id, duration_ms,
    ...(context_id === undefined ? {} : { context_id }),
    ...(continued_from === undefined ? {} : { continued_from }),
    ...(session_id === undefined ? {} : { session_id }),
    ...(timeout === undefined ? {} : { timeout }),
    ...(queue === undefined ? {} : { queue }),
    worktree: worktreeSummary(job.worktree),
    result: result && summary && { ...result, summary: summary.text, truncated: result.truncated || summary.truncated },
    log_path,
    error: errorSummary(error),
  };
}

function taskMatcher(config: ConfigSnapshot, taskType: string) {
  const canonicalRole = resolveRoleId(taskType);
  const keywords = keywordsForRole(taskType);
  const presetModels = new Set<string>();
  for (const preset of Object.values(config.presets)) {
    if (!preset.enabled) continue;
    const roleId = Object.hasOwn(preset.roles, taskType) ? taskType : canonicalRole;
    if (Object.hasOwn(preset.roles, roleId)) presetModels.add(preset.roles[roleId].model);
  }
  return (id: string, model: ResolvedModel) =>
    presetModels.has(id) || model.best_for.some((note) => keywords.some((keyword) => keyword.test(note)));
}

type FailedSelection = Pick<RunJobRequest, "model" | "harness" | "mode" | "role" | "plan_id" | "subtask_id"> &
  Partial<Pick<JobRecord, "exclude_harnesses" | "exclude_models" | "explicit_harnesses" | "explicit_models">>;

/** Compact top-level signal that every enabled delegation model is blocked; only present when exhausted. */
function exhaustedDelegation(delegation: DelegationAvailability) {
  if (delegation.state !== "exhausted") return undefined;
  return {
    state: "exhausted" as const, usable_count: 0, blocked_by_harness: delegation.blocked_by_harness,
    ...(delegation.earliest_retry_at ? { earliest_retry_at: delegation.earliest_retry_at } : {}),
  };
}

function delegationFor(selection: FailedSelection, config: ConfigSnapshot, runner: ToolDependencies["runner"],
  healthByHarness: Record<string, HarnessHealth>): DelegationAvailability {
  const plan = selection.plan_id ? runner.getPlan(selection.plan_id) : undefined;
  return delegationAvailability({
    config, healthByHarness, runtimeDegradations: runner.getRuntimeDegradations(),
    excludeHarnesses: plan?.exclude_harnesses ?? selection.exclude_harnesses,
    excludeModels: plan?.exclude_models ?? selection.exclude_models,
    // Explicitly overridden harnesses/models bypass the exclusions, so a timeout on one is not a delegation hard stop.
    explicitHarnesses: plan?.explicit_harnesses ?? selection.explicit_harnesses,
    explicitModels: plan?.explicit_models ?? selection.explicit_models,
    modes: requiredModes(selection, plan),
  });
}

/** The mode the failed job needed (its own, else its plan item's); unknown means no sandbox constraint, never a guess. */
function requiredModes(selection: FailedSelection, plan: PlanPreviewResult | undefined): RunMode[] | undefined {
  const item = plan?.items.find((entry) => entry.id === selection.subtask_id) ??
    (plan?.items.length === 1 && !selection.subtask_id ? plan.items[0] : undefined);
  const mode = selection.mode ?? item?.mode;
  return mode ? [mode] : undefined;
}

/** Vendor family of the model a stored plan item runs on, or undefined when the model left the catalog. */
function planItemVendor(entry: PlanPreviewResult["items"][number], config: ConfigSnapshot): string | undefined {
  const model = Object.hasOwn(config.models, entry.model) ? config.models[entry.model] : undefined;
  if (!model) return undefined;
  const harness = Object.hasOwn(config.harnesses, model.harness) ? config.harnesses[model.harness] : undefined;
  return inferVendorFamily(model, entry.driver, harness?.default_upstream_provider);
}

/** Vendors a replacement advisor of a design consultation should differ from: the host and the plan's other readonly advisors. */
function consultationVendors(plan: PlanPreviewResult, failedItemId: string | undefined, config: ConfigSnapshot): string[] {
  const advisors = plan.items.flatMap((entry) => {
    if (entry.id === failedItemId || entry.mode !== "readonly" || getRoleDefinition(entry.task_type)?.category === "support") return [];
    return [planItemVendor(entry, config) ?? UNKNOWN_VENDOR];
  });
  return [...advisors, ...(plan.host_vendor ? [plan.host_vendor] : [])];
}

type DelegationScope = { kind: "job" } | { kind: "plan"; planId: string } | { kind: "session" };

function topLevelDelegation(scope: DelegationScope, job: FailedSelection, config: ConfigSnapshot, runner: ToolDependencies["runner"],
  healthByHarness: Record<string, HarnessHealth>): DelegationAvailability {
  if (scope.kind === "session") {
    // No plan exclusions: an old plan that skipped one harness must not mark the whole session exhausted.
    return delegationAvailability({ config, healthByHarness, runtimeDegradations: runner.getRuntimeDegradations() });
  }
  return delegationFor(scope.kind === "plan" ? { ...job, plan_id: scope.planId } : job, config, runner, healthByHarness);
}

function withAlternatives(error: StructuredError, selection: FailedSelection, config: ConfigSnapshot,
  runner: ToolDependencies["runner"], healthByHarness: Record<string, HarnessHealth>): StructuredError {
  const delegation_state = error.delegation_state ?? delegationFor(selection, config, runner, healthByHarness).state;
  const scope = error.failure_scope ?? defaultFailureScope(error.code);
  // A timeout is recovered on the same model (resume, or shard smaller); never suggest another model.
  if (error.code === "TIMEOUT") {
    const { suggested_alternatives: _dropped, ...withoutAlternatives } = error;
    return { ...withoutAlternatives, failure_scope: scope, delegation_state };
  }
  const plan = selection.plan_id ? runner.getPlan(selection.plan_id) : undefined;
  const item = plan?.items.find((entry) => entry.id === selection.subtask_id) ??
    (plan?.items.length === 1 && !selection.subtask_id ? plan.items[0] : undefined);
  const role = selection.role ?? item?.task_type;
  let model = selection.model ?? item?.model;
  try {
    if (model) model = resolveModelAlias(model, config.aliases, config.models);
  } catch {
    // A cyclic alias has no matching candidate.
  }
  const resolved = model && Object.hasOwn(config.models, model) ? config.models[model] : undefined;
  const avoidVendors = getRoleDefinition(role ?? "")?.category === "review" ? plan?.items.flatMap((entry) => {
    if (entry.id === item?.id || (getRoleDefinition(entry.task_type)?.category !== "author" && entry.mode !== "write")) return [];
    const vendor = planItemVendor(entry, config);
    return vendor === undefined ? [] : [vendor];
  }) : undefined;
  // A consultation keeps its independence on failover: a replacement advisor should differ from the host and the other advisors.
  const independentFrom = plan?.intent === "design_consult" ? consultationVendors(plan, item?.id, config) : undefined;
  if (error.suggested_alternatives?.length) return { ...error, failure_scope: scope, delegation_state };
  return { ...error, failure_scope: scope, delegation_state, suggested_alternatives: suggestRuntimeAlternatives({
    config, healthByHarness, failedHarness: selection.harness ?? item?.harness ?? resolved?.harness, failedModel: model,
    role, mode: selection.mode ?? item?.mode ?? "readonly", failureScope: scope, errorCode: error.code,
    avoidVendors, independentFrom, runtimeDegradations: runner.getRuntimeDegradations(),
    excludeHarnesses: plan?.exclude_harnesses ?? selection.exclude_harnesses,
    excludeModels: plan?.exclude_models ?? selection.exclude_models, errorDetails: error.details,
  }) };
}

/** One `NestedArgs` per subtask, so keys the subtask schema does not declare are reported as `subtasks[i].<key>`. */
function subtaskNestedArgs(subtasks: Array<z.infer<typeof SUBTASK_INPUT>> | undefined): NestedArgs[] {
  return (subtasks ?? []).flatMap((subtask, index): NestedArgs[] => [
    { path: `subtasks[${index}].`, raw: subtask, knownKeys: SUBTASK_KEYS, hints: SUBTASK_KEY_HINTS },
    // The override schema is loose so a typo such as `harnes` is reported instead of vanishing.
    ...(subtask.override ? [{ path: `subtasks[${index}].override.`, raw: subtask.override, knownKeys: OVERRIDE_KEYS }] : []),
  ]);
}

/** Validates the lenient subtask list and fills defaults, so the planner always receives complete `PlanSubtaskInput` items. */
function toPlanSubtasks(subtasks: Array<z.infer<typeof SUBTASK_INPUT>> | undefined): PlanSubtaskInput[] {
  if (!subtasks?.length) {
    throw invalidInputError("subtasks is required: pass at least one subtask with id and task_type.", ["subtasks"], PREVIEW_EXAMPLE);
  }
  const missing = subtasks.flatMap((subtask, index) => [
    ...(subtask.id?.trim() ? [] : [`subtasks[${index}].id`]),
    ...(subtask.task_type?.trim() ? [] : [`subtasks[${index}].task_type`]),
  ]);
  if (missing.length > 0) {
    throw invalidInputError("Every subtask needs a non-empty id and task_type.", missing, PREVIEW_EXAMPLE);
  }
  return subtasks.map((subtask, index): PlanSubtaskInput => {
    const { id, title, task_type, mode, isolation, shards, override } = subtask;
    if (shards !== undefined && (shards < 1 || shards > MAX_SHARDS)) {
      throw invalidInputError(`subtasks[${index}].shards must be an integer from 1 to ${MAX_SHARDS}.`, undefined, SHARDS_EXAMPLE);
    }
    // Only declared override keys reach the planner; the loose schema keeps typos solely so they can be reported.
    const overrideFields = Object.fromEntries(Object.entries(pickKnown(override ?? {}, OVERRIDE_KEYS)).filter(([, value]) => value !== undefined));
    return {
      id: id!, title: title?.trim() ? title : id!, task_type: task_type!,
      ...(mode === undefined ? {} : { mode }),
      ...(isolation === undefined ? {} : { isolation }),
      ...(shards === undefined ? {} : { shards }),
      ...(Object.keys(overrideFields).length > 0 ? { override: overrideFields } : {}),
    };
  });
}

const LOG_FILE: Record<LogPart, string> = {
  summary: "result.md", stdout: "stdout.log", stderr: "stderr.log", diff: "diff.patch", files: "meta.json", checkpoint: "checkpoint.json",
};

const SHARDS_EXAMPLE = { subtasks: [{ id: "audit", task_type: "review", shards: 4 }] };
const LOGS_EXAMPLE = { job_id: "<job_id>", part: "summary" };
const CANCEL_EXAMPLE = { job_id: "<job_id>" };
const STATUS_EXAMPLE = { job_ids: ["<job_id>"], until: "any_terminal" };

/** Merges `job_ids` and its `job_id` alias into one canonical list; blank IDs and two different lists are caller mistakes. */
function resolveStatusJobIds(args: { job_ids?: string[]; job_id?: string[] }): string[] | undefined {
  const lists = [args.job_ids, args.job_id].filter((list): list is string[] => list !== undefined);
  if (lists.some((list) => list.some((id) => id.trim() === ""))) {
    throw invalidInputError("Job IDs must not be blank.", ["job_ids"], STATUS_EXAMPLE);
  }
  if (lists.length === 2) {
    const [first, second] = lists.map((list) => new Set(list));
    if (first.size !== second.size || [...first].some((id) => !second.has(id))) {
      throw invalidInputError("job_ids and job_id list different jobs; pass only job_ids.", undefined, STATUS_EXAMPLE);
    }
  }
  return lists[0];
}

function boundedIds(ids: readonly string[]): string[] {
  return ids.slice(0, MAX_INVALID_INPUT_ITEMS).map((id) => truncateUtf8(id, MAX_INVALID_INPUT_ITEM_CHARS).text);
}

/** Every requested job_id is unknown: an empty "terminal" reply would pass for success, so the call is rejected instead. */
function unknownJobIdsError(unknownJobIds: readonly string[]): StructuredError {
  return {
    code: "INVALID_INPUT",
    message: "None of the requested job_ids exist in this session. Check the IDs returned by orch_run.",
    retryable: false,
    failure_scope: "job",
    details: { unknown_job_ids: boundedIds(unknownJobIds), example: STATUS_EXAMPLE },
  };
}

function missingJob(jobId: string): StructuredError {
  return { code: "INTERNAL_ERROR", message: "Job not found.", retryable: false, details: { job_id: jobId } };
}

async function statIfPresent(path: string) {
  try {
    return await stat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    return undefined;
  }
}

async function checkEmptyLog(runner: ToolDependencies["runner"], jobId: string, part: LogPart): Promise<void> {
  const job = runner.getJob(jobId);
  const directory = job?.log_path ?? join(getRunsDir(), jobId);
  const file = await statIfPresent(join(directory, LOG_FILE[part]));
  if (file?.isFile()) return;
  if (!job && !(await statIfPresent(directory))?.isDirectory()) throw missingJob(jobId);
  throw {
    code: "INTERNAL_ERROR",
    message: "Log part not found.",
    retryable: false,
    details: { job_id: jobId, part },
  } satisfies StructuredError;
}

export function registerOrchestratorTools(server: McpServer, deps: ToolDependencies): void {
  const { configManager, adapterRegistry, runner } = deps;

  const progressIntervalMs = deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const initialHoldCapMs = deps.initialHoldCapMs ?? DEFAULT_INITIAL_HOLD_CAP_MS;
  const maxHoldCapMs = Math.max(initialHoldCapMs, deps.maxHoldCapMs ?? DEFAULT_MAX_HOLD_CAP_MS);
  const settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
  const worktreesDir = deps.worktreesDir ?? getWorktreesDir();
  // Outlives the runner's plan cache and its terminal-job pruning, so a retried client_request_id keeps meaning the same job.
  const runLedger = new RunIdempotencyLedger();
  const rampStepsMs = [
    initialHoldCapMs, ...INTERMEDIATE_HOLD_CAPS_MS.filter((step) => step > initialHoldCapMs && step < maxHoldCapMs), maxHoldCapMs,
  ];

  // Session-scoped self-calibration of how long one orch_status call may hold before the host gives up on it.
  interface ActiveHold { startedAt: number; controller: AbortController }
  const activeHolds = new Map<string, ActiveHold>();
  let learnedCapMs: number | undefined;
  let rampIndex = 0;
  let cleanLearnedCapStreak = 0;

  function explicitHoldCapMs(config: ConfigSnapshot): number {
    const fromEnv = Number.parseInt(process.env.ORCH_MCP_MAX_WAIT_MS ?? "", 10);
    const explicit = Number.isSafeInteger(fromEnv) && fromEnv > 0 ? fromEnv : config.defaults.mcp_max_wait_sec * 1_000;
    return explicit > 0 ? Math.min(maxHoldCapMs, Math.max(MIN_EXPLICIT_HOLD_CAP_MS, explicit)) : 0;
  }

  function holdCapMs(config: ConfigSnapshot, hasProgressToken: boolean): number {
    const explicit = explicitHoldCapMs(config);
    if (explicit > 0) return explicit;
    // Without a progress token the host's request timeout cannot be extended, so never exceed the safe default.
    if (!hasProgressToken) return Math.min(learnedCapMs ?? initialHoldCapMs, initialHoldCapMs);
    return Math.min(rampStepsMs[Math.min(rampIndex, rampStepsMs.length - 1)], learnedCapMs ?? maxHoldCapMs);
  }

  /** A hold that the host dropped after `elapsedMs` shows the host limit lies below it. */
  function learnHoldCap(elapsedMs: number): void {
    if (elapsedMs < HOLD_SAFETY_MARGIN_MS) return;
    learnedCapMs = Math.max(MIN_LEARNED_HOLD_CAP_MS,
      Math.min(learnedCapMs ?? maxHoldCapMs, elapsedMs - HOLD_SAFETY_MARGIN_MS));
    cleanLearnedCapStreak = 0;
  }

  /** Repeated clean holds at the learned cap show the host tolerates it, so a single stray cancel cannot pin the cap forever. */
  function noteCleanLearnedCapHold(): void {
    if (learnedCapMs === undefined) return;
    cleanLearnedCapStreak++;
    if (cleanLearnedCapStreak < CLEAN_STREAK_TO_RAISE_CAP) return;
    cleanLearnedCapStreak = 0;
    const raised = Math.floor(learnedCapMs * LEARNED_CAP_RECOVERY_FACTOR);
    learnedCapMs = raised >= maxHoldCapMs ? undefined : raised;
  }

  function beginHold(scopeKey: string): ActiveHold {
    const previous = activeHolds.get(scopeKey);
    if (previous) {
      // A new wait for the same scope means the host dropped the earlier request without cancelling it.
      learnHoldCap(performance.now() - previous.startedAt);
      previous.controller.abort(new Error("The orch_status wait was superseded by a newer request for the same scope."));
    }
    const hold: ActiveHold = { startedAt: performance.now(), controller: new AbortController() };
    activeHolds.set(scopeKey, hold);
    return hold;
  }

  function endHold(scopeKey: string, hold: ActiveHold): void {
    if (activeHolds.get(scopeKey) === hold) activeHolds.delete(scopeKey);
  }

  async function waitDetailed(options: WaitForStatusOptions): Promise<WaitForStatusResult> {
    if (runner.waitForStatusDetailed) return runner.waitForStatusDetailed(options);
    const startedAt = performance.now();
    const jobs = await runner.waitForStatus(options);
    const ids = jobs.map((job) => job.job_id);
    const terminal = jobs.filter(isTerminalJob);
    return {
      jobs, cursor: "", changedJobIds: terminal.map((job) => job.job_id),
      wakeReason: jobs.length > 0 && terminal.length === jobs.length ? "all_terminal" : terminal.length > 0 ? "terminal" : "deadline",
      heldMs: Math.round(performance.now() - startedAt), activity: runner.getJobActivity?.(ids) ?? {},
    };
  }

  /** Serves cached health instantly and probes only uncached harnesses, never waiting longer than the ceiling. */
  async function fallbackHealth(config: ConfigSnapshot): Promise<Record<string, HarnessHealth>> {
    const health: Record<string, HarnessHealth> = {};
    const uncached: Array<[string, HarnessConfig]> = [];
    for (const [id, harness] of Object.entries(config.harnesses)) {
      if (!harness.enabled) continue;
      const cached = adapterRegistry.getCachedHealth?.(id, harness);
      if (cached) health[id] = cached;
      else uncached.push([id, harness]);
    }
    if (uncached.length === 0) return health;
    let expired = false;
    let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ceiling = new Promise<void>((resolve) => { ceilingTimer = setTimeout(resolve, HEALTH_PROBE_CEILING_MS); });
      // Starting each probe inside a promise turns a synchronous adapter throw into an ordinary rejection.
      const probes = uncached.map(([id, harness]) => Promise.resolve().then(() => adapterRegistry.probeHarness(id, harness)).then((probed) => {
        if (!expired) health[id] = probed;
      }, (cause: unknown) => {
        logger.warn("Could not probe harness for alternatives.", { harness: id, error: asStructuredError(cause) });
      }));
      await Promise.race([Promise.all(probes), ceiling]);
    } finally {
      expired = true;
      clearTimeout(ceilingTimer);
    }
    return health;
  }

  /**
   * Adds reroute suggestions and the live delegation state to failed jobs; also reports when delegation is exhausted.
   * `scope` decides which exclusions the top-level `delegation` honours: the first failed job's own plan ("job"),
   * one explicitly requested plan ("plan"), or none at all for a session-wide view ("session"). Each job's own
   * `error.delegation_state` always stays scoped to that job's plan.
   */
  async function enrichJobs(jobs: JobRecord[], config: ConfigSnapshot, scope: DelegationScope = { kind: "job" }): Promise<{
    jobs: JobRecord[]; delegation?: ReturnType<typeof exhaustedDelegation>;
  }> {
    const needsEnrichment = (job: JobRecord) => job.error?.delegation_state === undefined ||
      (job.error.code !== "TIMEOUT" && !job.error.suggested_alternatives?.length);
    const isFailed = (job: JobRecord) => (job.status === "failed" || job.status === "timed_out") && job.error;
    if (!jobs.some(isFailed)) return { jobs };
    const health = await fallbackHealth(config);
    let delegation: ReturnType<typeof exhaustedDelegation>;
    const enriched = jobs.map((job) => {
      if (!isFailed(job)) return job;
      delegation ??= exhaustedDelegation(topLevelDelegation(scope, job, config, runner, health));
      return needsEnrichment(job) ? { ...job, error: withAlternatives(job.error!, job, config, runner, health) } : job;
    });
    return { jobs: enriched, ...(delegation ? { delegation } : {}) };
  }

  /** The live job of a replayed request, held until it finishes unless the caller asked for async or its wait_ms ran out. */
  async function settleReplay(
    jobId: string, request: Pick<RunJobRequest, "async" | "wait_ms">, signal: AbortSignal,
  ): Promise<JobRecord | undefined> {
    const deadline = request.wait_ms === undefined ? undefined : performance.now() + request.wait_ms;
    for (;;) {
      const job = runner.getJob(jobId);
      if (!job || request.async === true || isTerminalJob(job)) return job;
      const remainingMs = deadline === undefined ? MAX_WAIT_MS : deadline - performance.now();
      if (remainingMs <= 0) return job;
      await waitDetailed({ jobIds: [jobId], waitMs: Math.min(remainingMs, MAX_WAIT_MS), until: "all_terminal", signal });
    }
  }

  /** Answers a repeated client_request_id with the original job, never a second run; a pruned job is described by its last snapshot. */
  async function replayRun(
    earlier: IdempotentRun, request: Pick<RunJobRequest, "async" | "wait_ms">, signal: AbortSignal, config: ConfigSnapshot,
    budget: ResponseBudget, ignored: object,
  ): Promise<CallToolResult> {
    const job = await settleReplay(earlier.jobId, request, signal);
    if (!job) {
      const hasError = "error" in earlier.snapshot;
      return budget.result({
        ...ignored, ...earlier.snapshot, job_pruned: true,
        warnings: ["The job record is no longer held in memory; this is its last known state. Read the final output with orch_logs."],
      }, hasError && request.async !== true);
    }
    const { jobs: [enriched], delegation } = await enrichJobs([job], config);
    return budget.job(enriched, Boolean(job.error && (request.async !== true || job.started_at === undefined)),
      { ...ignored, ...(delegation ? { delegation } : {}) });
  }

  /**
   * Runs one tool call. Arguments the tool does not declare are reported back as `ignored_arguments`: the action puts them on
   * its success reply, and a failed reply carries them too because a mistyped argument name is the likely cause of the failure.
   */
  async function respond(
    rawArgs: Record<string, unknown>, knownKeys: readonly string[],
    action: (config: ConfigSnapshot, budget: ResponseBudget, ignored: object) => CallToolResult | Promise<CallToolResult>,
    byteCap = MAX_OUTPUT_BYTES, nestedArgs: readonly NestedArgs[] = [],
  ): Promise<CallToolResult> {
    const ignored = unknownArgsWarning(rawArgs, knownKeys, nestedArgs) ?? {};
    let budget = new ResponseBudget(Math.min(DEFAULT_OUTPUT_BYTES, byteCap));
    try {
      const config = configManager.reloadIfChanged();
      budget = new ResponseBudget(Math.min(config.defaults.max_mcp_output_bytes, byteCap));
      return await action(config, budget, ignored);
    } catch (cause) {
      return budget.result({ ...ignored, error: asStructuredError(cause) }, true);
    }
  }

  server.registerTool("orch_catalog", {
    description: "List and filter model cards, presets, and CLI availability.",
    inputSchema: CATALOG_INPUT,
  }, (args) => respond(args, CATALOG_KEYS, async (config, budget, ignored) => {
    const brief = args.detail === "brief";
    const includeUnavailable = args.include_unavailable ?? !brief;
    // A harness filter only needs that harness probed; an unknown id falls back to probing everything.
    const onlyHarness = args.harness !== undefined && Object.hasOwn(config.harnesses, args.harness) ? args.harness : undefined;
    if (args.refresh_health) runner.clearRuntimeDegradations(onlyHarness);
    const health = await probeHarnesses(config, adapterRegistry, args.refresh_health, onlyHarness);
    // The brief view is capped at BRIEF_CATALOG_BYTES (one more field per harness overflows it), so only the full view carries limits.
    if (!brief) {
      const concurrency = await resolveConcurrencyByHarness(config, Object.keys(health), { refresh: args.refresh_health });
      for (const [id, info] of Object.entries(concurrency)) health[id] = { ...health[id], concurrency: info };
    }
    for (const entry of runner.getRuntimeDegradations()) {
      const probe = health[entry.harness];
      if (!probe) continue;
      const warning = `${entry.model ?? entry.harness}: ${entry.code} (${entry.raw_error.slice(0, 120)}), until ${entry.expires_at}.`;
      health[entry.harness] = { ...probe, runtime_warning: [probe.runtime_warning, warning].filter(Boolean).join(" ") };
    }
    const search = args.search?.trim().toLowerCase();
    const matchesTask = args.task_type?.trim() ? taskMatcher(config, args.task_type) : undefined;
    const models = Object.entries(config.models).flatMap(([id, model]) => {
      const harnessReady = isReady(health[model.harness]);
      if ((args.harness && model.harness !== args.harness) || (args.tier && model.tier !== args.tier) ||
          (!includeUnavailable && (!model.enabled || !harnessReady)) ||
          (matchesTask && !matchesTask(id, model)) ||
          (search && ![id, model.display_name, model.harness, config.harnesses[model.harness]?.display_name ?? "",
            ...model.strengths, ...model.best_for].some((field) => field.toLowerCase().includes(search)))) return [];
      return [catalogModelCard(id, model, harnessReady, brief)];
    });
    const includePresetRoles = args.preset !== undefined || args.include_preset_roles;
    const presets = Object.fromEntries(Object.entries(config.presets)
      .filter(([id]) => args.preset === undefined || args.preset === id)
      .map(([id, { description, enabled, roles }]) => {
        if (includePresetRoles) return [id, { description, enabled, roles }];
        if (brief) return [id, description.split(/(?<=[.!?])\s+/, 1)[0]];
        const roleNames = Object.keys(roles);
        return [id, { description, enabled, role_count: roleNames.length, roles: roleNames, role_names: roleNames }];
      }));
    const harnesses = brief
      ? Object.values(health).filter((entry) => includeUnavailable || isReady(entry))
      : catalogHarnesses(health, includeUnavailable);
    const unavailable = brief && !includeUnavailable
      ? Object.values(health).filter((entry) => !isReady(entry)).map((entry) => entry.harness) : [];
    return budget.list(models.slice(args.offset, args.offset + args.limit), (page) => {
      const omitted = Math.max(0, models.length - args.offset - page.length);
      if (omitted > 0 && page.length === 0) {
        // An unchanged next_offset would make clients fetch the same empty page forever.
        throw { ...OVERSIZED_ERROR, message: brief
          ? 'Filter by harness or preset, or use detail: "full" to fit a model card.'
          : "Filter by harness or preset, or raise max_mcp_output_bytes, to fit a model card." };
      }
      return {
        ...ignored,
        catalog_path: configManager.defaultPath,
        user_config_path: configManager.userPath,
        revision: config.revision,
        config_warnings: config.config_warnings,
        stale_after_days: config.defaults.stale_after_days,
        harnesses,
        ...(brief ? {
          unavailable_harnesses: unavailable,
          total: models.length, returned: page.length, offset: args.offset, truncated: omitted > 0,
          hint: 'Pass detail: "full" for full model cards and provenance, or preset: "<id>" for a preset role map.',
        } : {}),
        models: page,
        omitted_models: omitted,
        ...(omitted > 0 ? { next_offset: args.offset + page.length } : {}),
        presets,
        available_roles: Object.keys(ROLES),
      };
    });
  }, args.detail === "brief" ? BRIEF_CATALOG_BYTES : MAX_OUTPUT_BYTES));

  server.registerTool("orch_plan_preview", {
    description: "Preview a routing plan and save its ID for later runs.",
    inputSchema: PLAN_PREVIEW_INPUT,
  }, (args) => respond(args, PLAN_PREVIEW_KEYS, async (config, budget, ignored) => {
    const contextId = normalizeContextId(args.context_id);
    const subtasks = toPlanSubtasks(args.subtasks);
    try {
      if (args.refresh_health) runner.clearRuntimeDegradations();
      const [healthByHarness, cwd] = await Promise.all([
        probeHarnesses(config, adapterRegistry, args.refresh_health),
        args.cwd === undefined ? undefined : validateCwd(args.cwd),
      ]);
      const concurrencyByHarness = await resolveConcurrencyByHarness(config, Object.keys(config.harnesses),
        { refresh: args.refresh_health, ...(cwd ? { cwd: cwd.realCwd } : {}) });
      const locale = args.locale ?? config.defaults.locale ?? "en";
      const liveConcurrency = cwd ? liveConcurrencyFor(runner, config, cwd, contextId, worktreesDir) : undefined;
      const preview = buildPlanPreview({ config, healthByHarness, subtasks, preset: args.preset, locale, cwdDirty: cwd?.isDirty,
        excludeHarnesses: args.exclude_harnesses, excludeModels: args.exclude_models, runtimeDegradations: runner.getRuntimeDegradations(),
        host_vendor: args.host_vendor, intent: args.intent, concurrencyByHarness,
        ...(liveConcurrency ? { liveConcurrency } : {}) });
      const plan = { ...preview, locale, cwd: cwd?.realCwd ?? null, git_dirty: cwd?.isDirty ?? null,
        ...(contextId === undefined ? {} : { context_id: contextId }),
        expires_at: new Date(Date.parse(preview.created_at) + PLAN_TTL_MS).toISOString() };
      const items = plan.items.map((item) => {
        const { id, title, task_type: role, mode, isolation, harness, harness_installed, model, effort, tier,
          cost_tier, selection_source, warnings, alternatives } = item;
        return { id, title, role, mode, isolation, harness, harness_installed, harness_ready: isReady(healthByHarness[harness]),
          model, effort, tier, cost_tier, selection_source, reason: item.pros, warnings,
          ...(warnings.length ? { alternatives } : {}) };
      });
      if (!preview.launchable) {
        // Never save an unlaunchable plan: a stale plan_id must not tempt the host into running subtasks anyway.
        const retryable = Boolean(preview.earliest_retry_at);
        const retryAt = preview.earliest_retry_at ? { earliest_retry_at: preview.earliest_retry_at } : {};
        const core = exhaustedPlanCore(retryable, EXHAUSTED_MESSAGE);
        const withDetails = (blocked: boolean) => ({
          ...core, error: { ...core.error, details: { ...(blocked ? { blocked_by_harness: preview.blocked_by_harness } : {}), ...retryAt } },
        });
        // Degrade stepwise; the hard-stop fields survive every step so a tight budget never hides the stop signal.
        return budget.firstFitting([
          { ...plan, ...withDetails(true), items },
          { ...core, ...withDetails(true), preset: plan.preset, blocked_by_harness: preview.blocked_by_harness, ...retryAt },
          { ...withDetails(false), ...retryAt },
          exhaustedPlanCore(retryable, EXHAUSTED_SHORT_MESSAGE),
        ], true);
      }
      // A large plan sheds optional detail stepwise instead of failing, so a launchable plan is never lost to its byte budget.
      const { markdown_table: _table, ...withoutTable } = plan;
      const { warnings: _warnings, ...withoutWarnings } = withoutTable;
      const bareItems = items.map(({ alternatives: _alternatives, ...item }) => item);
      const result = budget.firstFitting([
        { ...plan, ...ignored, items },
        { ...withoutTable, ...ignored, items },
        { ...withoutWarnings, ...ignored, items },
        { ...withoutWarnings, ...ignored, items: bareItems },
      ]);
      if (!result.isError) runner.savePlan(plan);
      return result;
    } catch (cause) {
      if (cause instanceof PlanPreviewError && cause.structured.code === "DELEGATION_UNAVAILABLE") {
        // A thrown hard stop must survive any byte budget, so it degrades to the compact core instead of an oversized error.
        return budget.firstFitting([
          { ...ignored, ...exhaustedPlanCore(false, EXHAUSTED_SHORT_MESSAGE), error: cause.structured },
          { ...exhaustedPlanCore(false, EXHAUSTED_SHORT_MESSAGE), error: cause.structured },
          exhaustedPlanCore(false, EXHAUSTED_SHORT_MESSAGE),
        ], true);
      }
      if (cause instanceof PlanPreviewError) return budget.result({ ...ignored, error: cause.structured }, true);
      throw cause;
    }
  }, MAX_OUTPUT_BYTES, subtaskNestedArgs(args.subtasks)));

  server.registerTool("orch_run", {
    description: "Run one planned subtask via a CLI harness. Omit timeout_sec: active streaming jobs are extended automatically and stalled ones " +
      "are stopped as idle. Shard tasks touching more than ~8 files or several subsystems into separate subtasks. " +
      "On TIMEOUT branch on error.timeout_kind (soft | idle | hard) and prefer error.resume.",
    inputSchema: RUN_INPUT,
  }, (args, extra) => respond(args, RUN_KEYS, async (config, budget, ignored) => {
    // The loose input schema keeps unknown keys; only declared arguments may reach the runner.
    const request = pickKnown(args, RUN_KEYS);
    // A blank ID is left for the runner to reject; any other one is answered from the ledger before the plan is even looked up.
    const clientRequestId = request.client_request_id?.trim() ? request.client_request_id : undefined;
    const fingerprint = runFingerprint(request);
    const earlier = clientRequestId === undefined ? undefined : runLedger.find(clientRequestId, fingerprint);
    if (earlier) return replayRun(earlier, request, extra.signal, config, budget, ignored);
    let job: JobRecord;
    try {
      job = await runner.run({ ...request, signal: extra.signal });
    } catch (cause) {
      const original = asStructuredError(cause);
      const scope = original.failure_scope ?? defaultFailureScope(original.code);
      const error = { ...original, failure_scope: scope, safe_to_reroute: !extra.signal.aborted && REROUTABLE_ADMISSION_ERRORS.has(original.code),
        raw_error: original.raw_error || original.stderr_tail?.trim() || original.message };
      if (scope === "job" || error.suggested_alternatives?.length) {
        return budget.result({ ...ignored, error: { ...error, ...errorSummary(error) } }, true);
      }
      const health = await fallbackHealth(config);
      const enriched = withAlternatives(error, request, config, runner, health);
      const delegation = exhaustedDelegation(delegationFor(request, config, runner, health));
      const summary = { ...enriched, ...errorSummary(enriched) };
      const hardStop = delegation ? { delegation } : {};
      return budget.firstFitting([
        { ...ignored, ...hardStop, error: summary },
        { ...slimExtra(hardStop), error: summary },
        { ...slimExtra(hardStop), error: errorCore(summary) },
        ...(delegation ? [exhaustionStub(summary.code, summary.retryable)] : []),
      ], true);
    }
    if (clientRequestId !== undefined) {
      runLedger.remember(clientRequestId, { jobId: job.job_id, fingerprint, snapshot: tightJobSummary(job, {}) });
    }
    const isError = Boolean(job.error && (request.async !== true || job.started_at === undefined));
    const { jobs: [enriched], delegation } = await enrichJobs([job], config);
    return budget.job(enriched, isError, { ...ignored, ...(delegation ? { delegation } : {}) });
  }));

  server.registerTool("orch_status", {
    description: "List compact job summaries, or hold until selected jobs change or finish (until: any_terminal | all_terminal). " +
      "When pending_count > 0 or unseen_count > 0, call again with the returned next.args.",
    inputSchema: STATUS_INPUT,
  }, (args, extra) => respond(args, STATUS_KEYS, async (config, budget, ignored) => {
    const jobIds = resolveStatusJobIds(args);
    const readQueueInfo = () => runner.explainQueue?.() ?? new Map<string, QueueExplanation>();
    // Refreshed when a reply is built, so a reply that followed a long hold never reports the queue as it was before.
    let queueInfo = readQueueInfo();
    const unknownJobIds = jobIds?.length ? jobIds.filter((id) => !runner.getJob(id)) : [];
    if (jobIds?.length && unknownJobIds.length === jobIds.length) throw unknownJobIdsError(unknownJobIds);
    const planId = args.plan_id;
    const requestedWaitMs = args.wait_ms === undefined ? undefined : Math.min(args.wait_ms, MAX_WAIT_MS);
    const notice = {
      ...ignored,
      ...(unknownJobIds.length > 0 ? { unknown_job_ids: boundedIds(unknownJobIds) } : {}),
      ...(args.wait_ms !== undefined && args.wait_ms > MAX_WAIT_MS ? { warnings: [`wait_ms was lowered to the maximum of ${MAX_WAIT_MS}.`] } : {}),
    };
    function snapshot(jobs: JobRecord[]): JobRecord[] {
      const ids = jobIds && new Set(jobIds);
      return jobs.filter((job) => (!ids || ids.has(job.job_id)) && (planId === undefined || job.plan_id === planId));
    }
    async function summarize(
      jobs: JobRecord[], metadata: object | ((omitted: JobRecord[]) => object), render: (job: JobRecord) => object = (job) => jobSummary(job, queueInfo.get(job.job_id)),
    ): Promise<CallToolResult> {
      const scope: DelegationScope = planId !== undefined ? { kind: "plan", planId }
        : jobIds === undefined ? { kind: "session" } : { kind: "job" };
      const { jobs: enriched, delegation } = await enrichJobs(jobs, config, scope);
      const describeMetadata = (omitted: JobRecord[]) => typeof metadata === "function" ? metadata(omitted) : metadata;
      // A huge `blocked_by_harness` must never push the hard-stop signal out of the response.
      const fullDelegation = delegation && budget.fits(json({ ...describeMetadata(jobs), delegation, jobs: [] }))
        ? delegation : delegation && { ...delegation, blocked_by_harness: undefined };
      const payload = (items: object[]) => ({
        ...notice,
        ...describeMetadata(jobs.slice(items.length)),
        ...(fullDelegation ? { delegation: fullDelegation } : {}),
        jobs: items,
        ...(items.length < jobs.length ? { omitted_jobs: jobs.length - items.length } : {}),
      });
      queueInfo = readQueueInfo();
      const rendered = enriched.map(render);
      // Even one job summary may exceed a tiny budget; fall back to the decisive fields so no job vanishes silently.
      const items = jobs.length > 0 && budget.pageSize(rendered, payload) === 0
        ? enriched.map((job, index) => tightJobSummary(job, rendered[index])) : rendered;
      return budget.list(items, payload);
    }
    /** The event an omitted job would be reported for: its last change, or (terminal waits) the moment it finished. */
    function relevantSeq(result: WaitForStatusResult, job: JobRecord): number | undefined {
      const seqs = result.jobSeqs?.[job.job_id];
      return args.until === "any_change" ? seqs?.changeSeq : seqs?.terminalSeq;
    }
    /** Split of the result cursor into its boot prefix and the sequence the caller already acknowledged (-1 when none or foreign). */
    function incomingCursor(result: WaitForStatusResult): { prefix: string; seq: number } | undefined {
      const separator = result.cursor.indexOf(":");
      if (!result.cursor || separator < 0) return undefined;
      const prefix = result.cursor.slice(0, separator + 1);
      const tail = args.cursor?.startsWith(prefix) ? args.cursor.slice(prefix.length) : undefined;
      return { prefix, seq: tail !== undefined && /^\d+$/.test(tail) ? Number(tail) : -1 };
    }
    /** Event sequences of the omitted jobs the caller has not been shown: strictly after its incoming cursor. Undefined without sequence data. */
    function unseenSeqs(result: WaitForStatusResult, omitted: JobRecord[]): number[] | undefined {
      const incoming = incomingCursor(result);
      if (!incoming || !result.jobSeqs) return undefined;
      return omitted.flatMap((job) => {
        const relevant = relevantSeq(result, job);
        return relevant !== undefined && relevant > incoming.seq ? [relevant] : [];
      });
    }
    /** A cursor must never acknowledge a change the caller was not shown, so truncation holds it below omitted jobs. */
    function safeCursor(result: WaitForStatusResult, omitted: JobRecord[]): string {
      if (!result.cursor || omitted.length === 0) return result.cursor;
      const incoming = incomingCursor(result);
      if (!incoming || !result.jobSeqs) return args.cursor ?? "";
      const unseen = unseenSeqs(result, omitted) ?? [];
      return unseen.length === 0 ? result.cursor : `${incoming.prefix}${Math.max(0, Math.min(...unseen) - 1)}`;
    }
    async function summarizeWait(result: WaitForStatusResult): Promise<CallToolResult> {
      const changed = new Set(result.changedJobIds);
      const hasCursor = args.cursor !== undefined && args.cursor !== "";
      const rank = (job: JobRecord) => (isTerminalJob(job) ? (changed.has(job.job_id) ? 0 : 1) : (changed.has(job.job_id) ? 2 : 3));
      // Terminal jobs first, so budget truncation never hides a finished job behind running ones. Within a rank the earliest
      // event comes first: the cursor is held just below the earliest omitted event, so every page must end on a later one.
      const ordered = [...result.jobs].sort((left, right) => rank(left) - rank(right) ||
        (relevantSeq(result, left) ?? 0) - (relevantSeq(result, right) ?? 0));
      const pending = result.jobs.filter((job) => !isTerminalJob(job)).length;
      const render = (job: JobRecord): object => {
        if (isTerminalJob(job)) return jobSummary(job);
        if (hasCursor && !changed.has(job.job_id)) return runningStub(job, result.activity, queueInfo.get(job.job_id));
        return { ...jobSummary(job, queueInfo.get(job.job_id)), last_output_ms_ago: result.activity[job.job_id]?.last_output_ms_ago };
      };
      return summarize(ordered, (omitted) => {
        const cursor = safeCursor(result, omitted);
        const unseenCount = unseenSeqs(result, omitted)?.length ?? omitted.length;
        return {
          ...(cursor ? { cursor } : {}),
          wake_reason: result.wakeReason,
          held_ms: result.heldMs,
          pending_count: pending,
          // Jobs the byte budget cut off stay reachable: the cursor is held below them, so `next` pages through every one.
          // Omitted jobs at or before the caller's own cursor were already shown to it and must not keep the loop alive.
          ...(unseenCount > 0 ? { unseen_count: unseenCount } : {}),
          ...(pending > 0 || unseenCount > 0 ? {
            next: {
              tool: "orch_status",
              args: {
                ...(planId === undefined ? {} : { plan_id: planId }),
                ...(jobIds === undefined ? {} : { job_ids: jobIds }),
                until: args.until,
                ...(cursor ? { cursor } : {}),
                // Keep the caller's wait budget; each continuation applies the current session cap.
                ...(requestedWaitMs ? { wait_ms: requestedWaitMs } : {}),
              },
            },
          } : {}),
        };
      }, render);
    }

    const holdsUntilTerminal = args.until !== "any_change";
    const progressToken = extra._meta?.progressToken;
    // Terminal waits without wait_ms hold for the session cap; plain any_change keeps returning an instant snapshot.
    const shouldHold = requestedWaitMs === undefined ? holdsUntilTerminal : requestedWaitMs > 0;

    if (shouldHold) {
      // Holds with a different `until` are independent waits, so they must not supersede (and mis-calibrate) each other.
      const scopeKey = JSON.stringify([planId, jobIds && [...new Set(jobIds)].sort(), args.until]);
      const hold = beginHold(scopeKey);
      const capMs = holdCapMs(config, progressToken !== undefined);
      const holdRampIndex = rampIndex;
      const waitMs = Math.min(requestedWaitMs ?? capMs, capMs);
      const signal = AbortSignal.any([extra.signal, hold.controller.signal]);
      const describe = () => {
        const jobs = snapshot(runner.listJobs());
        return describeProgress(jobs, runner.getJobActivity?.(jobs.map((job) => job.job_id)) ?? {}, Date.now());
      };
      const heartbeat = progressToken === undefined
        ? undefined : startProgressHeartbeat(extra, progressToken, progressIntervalMs, describe);
      try {
        let result: WaitForStatusResult | undefined;
        try {
          result = await waitDetailed({
            jobIds, planId, sinceVersion: args.since_version, waitMs, until: args.until, cursor: args.cursor, settleMs,
            // Only emit a state-change progress frame while jobs remain active; a terminal "N/N done" frame written in
            // the same stdout chunk as the tool reply races the SDK's microtask notification handler after response cleanup.
            onStateChange: heartbeat && (() => {
              if (snapshot(runner.listJobs()).some((job) => !isTerminalJob(job))) heartbeat.send();
            }),
            signal,
          });
        } catch (cause) {
          if (!signal.aborted) throw cause;
          if (extra.signal.aborted) learnHoldCap(performance.now() - hold.startedAt);
        } finally {
          endHold(scopeKey, hold);
        }
        if (!result) {
          return await summarize(snapshot(runner.listJobs()), {
            cancelled_wait: true, wake_reason: "cancelled", held_ms: Math.round(performance.now() - hold.startedAt),
          });
        }
        // A clean full-length hold proves the next ramp step is safe for this host.
        if (result.wakeReason === "deadline" && waitMs === capMs && explicitHoldCapMs(config) === 0) {
          // Concurrent holds that started on the same step prove it once; they must not skip the following step.
          if (progressToken !== undefined && holdRampIndex === rampIndex) {
            rampIndex = Math.min(rampIndex + 1, rampStepsMs.length - 1);
          }
          if (learnedCapMs !== undefined && capMs === learnedCapMs) noteCleanLearnedCapHold();
        }
        return await summarizeWait(result);
      } finally {
        // Enriching failures can take another probe round. Keep reporting until the reply is ready.
        await heartbeat?.stop();
      }
    }
    if (holdsUntilTerminal) {
      const result = await waitDetailed({
        jobIds, planId, sinceVersion: args.since_version, waitMs: 0, until: args.until, cursor: args.cursor, settleMs,
      });
      return summarizeWait(result);
    }
    const allJobs = runner.listJobs();
    const jobs = snapshot(allJobs);
    // An instant any_change snapshot still hands back a cursor so the caller can continue from it.
    const cursorResult = args.cursor === undefined ? undefined : await waitDetailed({
      jobIds, planId, sinceVersion: args.since_version, waitMs: 0, until: args.until, cursor: args.cursor, settleMs,
    });
    return summarize(jobs, (omitted) => {
      const cursor = cursorResult && safeCursor(cursorResult, omitted);
      return {
        ...(cursor ? { cursor } : {}),
        active_count: allJobs.filter((job) => job.status === "running").length,
        queued_count: allJobs.filter((job) => job.status === "queued").length,
      };
    });
  }));

  server.registerTool("orch_logs", {
    description: "Read a byte range from stored job output.",
    inputSchema: LOGS_INPUT,
  }, (args) => respond(args, LOGS_KEYS, async (_config, budget, ignored) => {
    const jobId = args.job_id;
    if (jobId === undefined) throw invalidInputError("job_id is required.", ["job_id"], LOGS_EXAMPLE);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(jobId)) {
      return budget.result({ ...ignored, error: missingJob(jobId) }, true);
    }
    let limit = args.limit_bytes;
    for (;;) {
      const chunk = await runner.readLogs(jobId, args.part, args.offset_bytes, limit);
      if (chunk.total_bytes === 0) await checkEmptyLog(runner, jobId, args.part);
      const reply = { ...ignored, ...chunk };
      if (budget.fits(json(reply)) || (limit !== undefined && limit <= 1)) return budget.result(reply);
      // Re-read a shorter range so next_offset_bytes still points at the first unread byte.
      limit = Math.max(1, Math.floor(Math.min(limit ?? MAX_LOG_CHUNK_BYTES, chunk.next_offset_bytes - chunk.offset_bytes) / 2));
    }
  }));

  server.registerTool("orch_cancel", {
    description: "Cancel a queued or running job and optionally clean up its worktree.",
    inputSchema: CANCEL_INPUT,
  }, (args) => respond(args, CANCEL_KEYS, async (_config, budget, ignored) => {
    if (args.job_id === undefined) throw invalidInputError("job_id is required.", ["job_id"], CANCEL_EXAMPLE);
    const job = await runner.cancelJob(args.job_id, { cleanupWorktree: args.cleanup_worktree, forceCleanup: args.force_cleanup });
    return job ? budget.job(job, false, ignored) : budget.result({ ...ignored, error: missingJob(args.job_id) }, true);
  }));
}
