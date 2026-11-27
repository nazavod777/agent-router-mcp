import type { HarnessConfig, ModelConfig } from "../config/schema.js";
import type {
  DriverKind,
  HarnessHealth,
  ProgressCheckpoint,
  RunMode,
  SecurityGuarantee,
  StructuredError,
  UsageStats,
} from "../types.js";

/** Per-job native subagent control; adapters may only lower the CLI's own limits, never raise them. */
export interface NativeSubagentsControl {
  policy: "cli_limit" | "off";
  maxDepth: number;
  discoveredMaxDepth?: number;
  discoveredKeys?: readonly string[];
  /** DSH only: the depth each subagent plugin id (`subagent`, `tool-subagent`, ...) holds in the user's config. */
  discoveredPluginDepths?: Readonly<Record<string, number>>;
}

export interface BuildInvocationInput {
  harnessId: string;
  harness: HarnessConfig;
  modelId: string;
  model: ModelConfig;
  effort: string;
  mode: RunMode;
  prompt: string;
  systemContext?: string;
  cwd: string;
  /** Private 0700 directory for per-job temp files (system prompt, -o file, dsh patch). */
  jobDir: string;
  inheritMcp: boolean;
  /**
   * `defaults.allow_unsandboxed_write`. A write run refuses extra_args that drop the sandbox or approvals unless this is
   * `true`; omitted means "not allowed" (fail closed).
   */
  allowUnsandboxedWrite?: boolean;
  isGitRepo: boolean;
  nativeSubagents?: NativeSubagentsControl;
  /** Aborted when the job is cancelled, times out or the runner shuts down; the runner stops waiting for setup then. */
  signal?: AbortSignal;
}

export interface BuiltInvocation {
  command: string;
  args: string[];
  stdin: string;
  envOverrides?: Record<string, string>;
  /** Optional path where the CLI writes its final message (e.g. codex -o). */
  outputFile?: string;
  /** Per-job temp files created with 0600 permissions; runner removes them after process exit. */
  tempFiles: string[];
  warnings: string[];
  nativeEffort: string;
  /**
   * How the CLI reports progress on stdout. "streaming": it emits incremental NDJSON events during the run, so
   * prolonged silence means a stall. "buffered" (the default when omitted): it prints everything at the end, so silence
   * is normal and must never trigger an idle kill.
   */
  outputMode?: "streaming" | "buffered";
}

export interface FinishParseInput {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  outputFileContent?: string;
  stdoutTruncated: boolean;
  oversizedLinesDropped: number;
}

export interface ParsedAdapterResult {
  ok: boolean;
  summary: string;
  usage?: UsageStats;
  parseDegraded?: boolean;
  error?: StructuredError;
  warnings?: string[];
}

export interface AdapterStreamParser {
  /** Called per LF-delimited stdout line (already length-bounded before JSON.parse). */
  pushLine(line: string): void;
  /** Optional: rewrite a raw stdout line before it is persisted to stdout.log (e.g. drop bulky tool_result bodies). */
  sanitizeLogLine?(line: string): string;
  /** Called after child exits and streams close. */
  finish(input: FinishParseInput): ParsedAdapterResult;
  /** Bounded, not-yet-sanitized snapshot of what the CLI did so far; callable at any time, even after a failed run. */
  checkpoint?(): ProgressCheckpoint;
  /**
   * Monotonic counter of real semantic progress events seen so far (assistant text, turns, tool start/end). CLI
   * keepalives such as `system` or `api_retry` events never count. Only meaningful for `outputMode: "streaming"`.
   */
  progressEvents?(): number;
}

export interface CliAdapter {
  readonly driver: DriverKind;
  readonly securityGuarantees: Record<RunMode, SecurityGuarantee>;
  mapEffort(effort: string): string;
  probe(harnessId: string, harness: HarnessConfig, options?: { timeoutMs?: number }): Promise<HarnessHealth>;
  buildInvocation(input: BuildInvocationInput): Promise<BuiltInvocation>;
  createStreamParser(): AdapterStreamParser;
}

export interface AdapterRegistryLike {
  get(driver: DriverKind): CliAdapter;
  probeHarness(
    harnessId: string,
    harness: HarnessConfig,
    options?: { refresh?: boolean; timeoutMs?: number },
  ): Promise<HarnessHealth>;
  /** Synchronous, probe-free lookup of a non-expired cached health entry. */
  getCachedHealth?(harnessId: string, harness: HarnessConfig): HarnessHealth | undefined;
}
