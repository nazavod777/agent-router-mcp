import type { DefaultsConfig } from "./config/schema.js";
import type { DriverContract, DriverKind, McpIsolation } from "./drivers.js";

export { DRIVER_KINDS, DRIVER_METADATA, isDriverKind } from "./drivers.js";
export type { DriverContract, DriverKind, DriverMetadata, EffortSupport, McpIsolation, PromptDelivery } from "./drivers.js";

export type RunMode = "readonly" | "write";
export type IsolationMode = "shared" | "worktree";
export type ModelTier = "deep" | "standard" | "light" | "specialist";
export type CostTier = "low" | "medium" | "high" | "premium";
export type SecurityGuarantee = "os_sandbox" | "tool_allowlist" | "unsandboxed";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
export type FieldProvenance = "default" | "overridden" | "custom";

export type ErrorCode =
  | "CLI_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "PROVIDER_OVERLOADED"
  | "RECURSION_BLOCKED"
  | "CONCURRENCY_LIMIT"
  | "QUEUE_FULL"
  | "INVALID_CWD"
  | "MODEL_UNSUPPORTED"
  | "HARNESS_UNAVAILABLE"
  | "DELEGATION_UNAVAILABLE"
  | "SANDBOX_POLICY_VIOLATION"
  | "PROMPT_TOO_LARGE"
  | "PLAN_REQUIRED"
  | "PLAN_NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFIG_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "TIMEOUT"
  | "NON_ZERO_EXIT"
  | "PARSE_ERROR"
  | "WORKTREE_ERROR"
  | "CANCELLED"
  | "INTERNAL_ERROR";

export type FailureScope = "model" | "harness" | "job";

/** Why a job was stopped for time: its soft limit, an idle stall, or the absolute hard cap. */
export type TimeoutKind = "soft" | "idle" | "hard";
export type ConcurrencyScope = DefaultsConfig["concurrency_scope"];

export interface SuggestedAlternative {
  harness: string;
  model: string;
  effort?: string;
  tier?: ModelTier;
  cost_tier?: CostTier;
  reason: string;
}

export interface StructuredError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  raw_error?: string;
  failure_scope?: FailureScope;
  safe_to_reroute?: boolean;
  suggested_alternatives?: SuggestedAlternative[];
  /** Whether any enabled delegation model is still usable; "exhausted" means stop main work and notify the user. */
  delegation_state?: "available" | "exhausted" | "unknown";
  /** True when the failure is best recovered by retrying the SAME harness/model (for example a TIMEOUT). */
  retry_same_model?: boolean;
  /** Set on TIMEOUT: "soft" = limit reached, "idle" = the CLI stalled, "hard" = the absolute cap was reached. */
  timeout_kind?: TimeoutKind;
  /** Larger `timeout_sec` to retry the same harness/model with. */
  suggested_timeout_sec?: number;
  details?: Record<string, unknown>;
  stderr_tail?: string;
  /** True when the failed job left saved partial progress (tool steps, text, or file changes). */
  has_partial_progress?: boolean;
  /** Ready-to-send `orch_run` call that continues the failed job from its saved progress. */
  resume?: { tool: "orch_run"; args: Record<string, unknown> };
}

export interface ProgressToolStep {
  tool: string;
  target?: string;
  /**
   * In-memory only (`sanitizeCheckpoint` drops it): the numeric arguments (offset, limit, line range) that tell two calls
   * on the same target apart, so reading one file in pages is not mistaken for repeating one call.
   */
  variant?: string;
  /** In-memory only: assistant text arrived after this step started, so the model was still working after the call. */
  followedByText?: boolean;
  status: "started" | "ok" | "error" | "unknown";
}

/** Bounded, redacted snapshot of what a job did before it stopped; persisted as `checkpoint.json`. */
export interface ProgressCheckpoint {
  partial_text?: string;
  partial_text_truncated?: boolean;
  tool_trail: ProgressToolStep[];
  turns: number;
  changed_files?: string[];
  diff_excerpt?: string;
  pre_existing_dirty?: boolean;
  /** Opaque provider session id; kept inside checkpoint.json only. */
  provider_session_id?: string;
}

export interface JobProgressSummary {
  has_partial_progress: boolean;
  partial_text_bytes: number;
  tool_calls: number;
  turns: number;
  files_touched: number;
  checkpoint_saved: boolean;
}

export interface UsageStats {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cost_usd?: number;
  incomplete?: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  base_commit: string;
  dirty?: boolean;
  diff_stat?: string;
  changed_files?: string[];
  relative_cwd?: string;
}

export interface JobResult {
  summary: string;
  truncated: boolean;
  total_output_bytes: number;
  exit_code: number;
  duration_ms: number;
  usage?: UsageStats;
  parse_degraded?: boolean;
}

/** Live timeout state of a job; `effective_sec` grows when activity-based extensions are granted. */
export interface JobTimeoutInfo {
  /** The limit the job started with, seconds. */
  soft_sec: number;
  /** The current soft limit including extensions, seconds. */
  effective_sec: number;
  /** Absolute cap, seconds. */
  hard_sec: number;
  /** 0 when idle detection is off or does not apply to this CLI. */
  idle_sec: number;
  extensions_used: number;
  max_extensions: number;
  /** Whether this job can be extended or idle-killed at all (streaming CLI, auto_extend_timeout, not strict). */
  auto_extend: boolean;
  strict: boolean;
  output_mode: "streaming" | "buffered";
}

export interface JobRecord {
  job_id: string;
  version: number;
  status: JobStatus;
  harness: string;
  driver: DriverKind;
  model: string;
  cli_model: string;
  effort: string;
  mode: RunMode;
  isolation: IsolationMode;
  security_guarantee: SecurityGuarantee;
  role?: string;
  label?: string;
  plan_id?: string;
  subtask_id?: string;
  /** Task-scoped ID shared by plans of one user prompt; gates opt-in `continue_from_job_id` handoffs. */
  context_id?: string;
  /** Job whose result was handed off to this job as portable context. */
  continued_from?: string;
  /** Exclusions inherited from the plan so reroute suggestions survive plan-cache eviction. */
  exclude_harnesses?: string[];
  exclude_models?: string[];
  /** Harnesses/models named by an explicit subtask override; keep them selectable when judging delegation availability. */
  explicit_harnesses?: string[];
  explicit_models?: string[];
  client_request_id?: string;
  cwd: string;
  effective_cwd: string;
  /** Concurrency session this job counts against; contains local paths, so tool output shows `session_id` instead. */
  session_key?: string;
  /** Short non-reversible label of `session_key`. */
  session_id?: string;
  timeout?: JobTimeoutInfo;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  pid?: number;
  pgid?: number;
  log_path: string;
  warnings: string[];
  worktree?: WorktreeInfo;
  result?: JobResult;
  error?: StructuredError;
  progress?: JobProgressSummary;
}

export type NativeSubagentsState = "enabled" | "disabled_by_config" | "disabled_by_invocation" | "disabled_by_policy" | "unknown";

/** How many jobs one harness may run in parallel and how deep its native subagents may nest. */
export interface HarnessConcurrencyInfo {
  /** Parallel jobs of this harness per session (repository), already limited by the session cap. */
  effective_cap: number;
  /** The per-session cap (`max_concurrency`); kept under this name for compatibility. */
  global_cap: number;
  /** Ceiling on running jobs across all sessions. */
  host_cap?: number;
  scope?: ConcurrencyScope;
  discovered_limit?: number;
  limit_source: "harness_override" | "cli_config" | "fallback";
  fallback_used: boolean;
  native_subagents: NativeSubagentsState;
  native_max_depth?: number;
  discovered_max_depth?: number;
  config_files?: string[];
  warnings?: string[];
}

export interface HarnessHealth {
  harness: string;
  driver: DriverKind;
  enabled: boolean;
  installed: boolean;
  binary_path?: string;
  version?: string;
  auth_status: "ready" | "unauthenticated" | "unknown";
  security_guarantees: Record<RunMode, SecurityGuarantee>;
  contract?: DriverContract;
  version_supported?: boolean;
  mcp_isolation?: McpIsolation;
  checked_at: string;
  note?: string;
  /** Set when the probe could not run (error or full queue); the installed/auth fields are placeholders, not facts. */
  probe_inconclusive?: boolean;
  runtime_warning?: string;
  /** Set by `agrmcp doctor` and the full MCP catalog; the 8000-byte brief catalog omits it. */
  concurrency?: HarnessConcurrencyInfo;
}
