/**
 * Contracts of the model auto-discovery service (NEW in Wave 2).
 *
 * Discovery only observes: it never reads credentials, never writes config, and is never used by `orch_plan_preview`
 * or `orch_run`. Layer 1 (local config/cache readers) is offline; Layer 2 (CLI listing probes) runs only on demand.
 */
import type { MODEL_DISCOVERY_MODES } from "../config/schema.js";
import type { HarnessConfig, ModelPatch } from "../config/schema.js";
import type { DriverKind } from "../drivers.js";

export type ModelDiscoveryMode = (typeof MODEL_DISCOVERY_MODES)[number];

export interface DiscoveredModel {
  cli_model: string;
  cli_provider?: string;
  display_name?: string;
  context_window?: number;
  context_precision?: "exact" | "rounded";
  reasoning?: boolean;
  native_efforts?: readonly string[];
  availability: "reported_available" | "configured" | "unknown" | "unconnected";
  evidence: "local_config" | "local_cache" | "cli_listing";
}

export type DiscoveryDiagnosticCode =
  | "manual_only"
  | "scope_unknown"
  | "binary_missing"
  | "unsupported_version"
  | "timeout"
  | "cancelled"
  | "busy"
  | "output_limit"
  | "invalid_output"
  | "source_unreadable";

export interface DiscoveryDiagnostic {
  stage: "offline" | "probe";
  code: DiscoveryDiagnosticCode;
  /** Never contains secrets, URLs with userinfo/query, or raw provider objects. */
  message?: string;
}

export interface DiscoverModelsOptions {
  /** Exact configured harness ID (a harness literally named "all" included); omit to scan every enabled harness. */
  harness?: string;
  mode: "offline" | "on_demand";
  providers: "configured" | "all";
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Per-probe timeout; default 5000. */
  probeTimeoutMs?: number;
  /** Total deadline of all probes; default 15000. */
  overallTimeoutMs?: number;
  /**
   * Budget of the whole offline stage, measured once for all harnesses (doctor / startup hint mode uses 45); also switches the
   * readers to their smaller hint-mode caps. Unset = only the normal file-size and file-count bounds apply.
   */
  offlineDeadlineMs?: number;
}

export interface HarnessDiscoveryResult {
  harness: string;
  driver: DriverKind;
  observed_at: string;
  status: "ok" | "partial" | "unsupported" | "unavailable";
  models: readonly DiscoveredModel[];
  diagnostics: readonly DiscoveryDiagnostic[];
  truncated: boolean;
}

export interface DiscoveryCandidate {
  /** Deterministic content hash bound to action + harness + normalized route + proposed_id + material metadata (not the timestamp). */
  key: string;
  harness: string;
  driver: DriverKind;
  status: "new" | "disabled_in_catalog" | "already_configured" | "ambiguous";
  action: "import" | "enable" | "none";
  existing_model_id?: string;
  /** Valid per `entityIdProblem`, unique across existing models, aliases, disabled cards, and the batch. */
  proposed_id: string;
  discovered: DiscoveredModel;
  /** Complete valid model entry for `ConfigWriter.importModels` when `action === "import"`. */
  proposed_model?: ModelPatch;
  metadata_quality: "curated" | "template" | "baseline";
  template_id?: string;
}

export interface DiscoveryPreviewResult {
  /** Config revision at preview time. */
  revision: string;
  mode: "offline" | "on_demand";
  providers: "configured" | "all";
  harnesses: readonly HarnessDiscoveryResult[];
  candidates: readonly DiscoveryCandidate[];
  total_candidates: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Internal contracts shared by the discovery modules
// ---------------------------------------------------------------------------

/** Everything environment-dependent is injected, so tests never touch the real home directory or process env. */
export interface DiscoveryEnvironment {
  cwd: string;
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
}

/** What one source (a local reader or a CLI probe) saw for one harness. */
export interface DiscoveryObservation {
  models: DiscoveredModel[];
  diagnostics: DiscoveryDiagnostic[];
  truncated: boolean;
}

export interface LocalReadInput extends DiscoveryEnvironment {
  harnessId: string;
  harness: HarnessConfig;
  driver: DriverKind;
  /** Effective discovery mode of the harness (custom wrappers default to "manual"). */
  discovery: ModelDiscoveryMode;
  signal?: AbortSignal;
  /** Absolute `performance.now()` deadline; readers stop and report `partial` data once it passes. */
  deadlineAtMs?: number;
  /**
   * Hint mode (doctor): the caller wants a quick lower bound inside a tiny budget, so readers open fewer files and refuse
   * larger ones than in a normal offline read.
   */
  hintMode?: boolean;
}

export interface ProbeRunRequest {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
  signal?: AbortSignal;
}

export interface ProbeRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** stdout or stderr exceeded its byte cap and the process tree was terminated. */
  outputLimitExceeded: boolean;
  /** The command could not be started (ENOENT, EACCES, ...). */
  spawnFailed?: boolean;
}

/** Injectable seam for tests; the default implementation spawns without a shell and cleans up the process tree. */
export type ExecProbe = (request: ProbeRunRequest) => Promise<ProbeRunResult>;

export interface CliProbeInput extends DiscoveryEnvironment {
  harnessId: string;
  harness: HarnessConfig;
  driver: DriverKind;
  /** `native` on a verified built-in executable, or `wrapper` when the user opted in explicitly. */
  discovery: "native" | "wrapper";
  execProbe?: ExecProbe;
  signal?: AbortSignal;
  probeTimeoutMs: number;
}

export const DISCOVERY_STDOUT_LIMIT_BYTES = 512 * 1024;
export const DISCOVERY_STDERR_LIMIT_BYTES = 32 * 1024;
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_OVERALL_TIMEOUT_MS = 15_000;
export const MAX_CONCURRENT_PROBES = 2;
/** Upper bound on models one source may return for one harness. */
export const MAX_MODELS_PER_SOURCE = 2_000;
export const MAX_PREVIEW_CANDIDATES = 1_000;
export const MAX_APPLY_BATCH = 50;
