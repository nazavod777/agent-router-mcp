import type { NativeSubagentsControl } from "../adapters/types.js";
import { DEFAULT_CLI_CONCURRENCY_FALLBACK, type CliLimits } from "../config/cli-limits.js";
import type { DefaultsConfig, HarnessConfig } from "../config/schema.js";
import type { DriverKind } from "../drivers.js";
import type { HarnessConcurrencyInfo } from "../types.js";
import type { ConcurrencyScope } from "./session-key.js";

/** Depth assumed for native subagents when the CLI's own config states none. */
const DEFAULT_NATIVE_DEPTH = 1;
const DEFAULT_HOST_MAX_CONCURRENCY = 24;
const DEFAULT_CONCURRENCY_SCOPE: ConcurrencyScope = "repo";

/** Drivers whose adapter turns `native_subagents = "off"` into per-run flags; every other CLI cannot be told to stay single-agent. */
const POLICY_OFF_ENFORCING_DRIVERS: ReadonlySet<DriverKind> = new Set<DriverKind>(["claude", "codex", "opencode", "dsh"]);

export interface ResolveHarnessConcurrencyInput {
  harnessId: string;
  harness: Pick<HarnessConfig, "max_concurrency">;
  defaults: Pick<DefaultsConfig, "max_concurrency" | "default_harness_concurrency" | "native_subagents" | "native_subagent_depth">
    & Partial<Pick<DefaultsConfig, "host_max_concurrency" | "concurrency_scope">>;
  cliLimits: CliLimits;
}

function unenforcedPolicyWarning(driver: DriverKind, depthZero: boolean): string {
  const setting = depthZero ? "native_subagent_depth = 0" : `native_subagents = "off"`;
  return `${setting} is not enforced for ${driver}: this CLI has no per-run flag to disable native subagents.`;
}

export function resolveHarnessConcurrency(input: ResolveHarnessConcurrencyInput): HarnessConcurrencyInfo {
  const { harness, defaults, cliLimits } = input;
  const globalCap = Math.max(1, Math.floor(defaults.max_concurrency));
  const discovered = cliLimits.max_concurrent >= 1 ? cliLimits.max_concurrent : undefined;
  const fallback = defaults.default_harness_concurrency ?? DEFAULT_CLI_CONCURRENCY_FALLBACK;
  const limitSource: HarnessConcurrencyInfo["limit_source"] = harness.max_concurrency !== undefined ? "harness_override"
    : discovered !== undefined ? "cli_config" : "fallback";
  const harnessCap = harness.max_concurrency ?? discovered ?? fallback;
  // A depth of 0 means "no native subagents": it is enforced like policy "off", even when the CLI's own depth is not discovered.
  const depthZero = defaults.native_subagent_depth === 0;
  const policyOff = defaults.native_subagents === "off" || depthZero;
  const enforcesPolicyOff = POLICY_OFF_ENFORCING_DRIVERS.has(cliLimits.driver);
  const nativeSubagents: HarnessConcurrencyInfo["native_subagents"] = policyOff && enforcesPolicyOff ? "disabled_by_policy" : cliLimits.native_subagents;
  // Pi is always started without subagents, so it needs no warning even though no policy flag exists.
  const warnings = policyOff && !enforcesPolicyOff && cliLimits.driver !== "pi"
    ? [...cliLimits.warnings, unenforcedPolicyWarning(cliLimits.driver, depthZero && defaults.native_subagents !== "off")]
    : cliLimits.warnings;
  const nativeDisabled = nativeSubagents === "disabled_by_policy" || nativeSubagents === "disabled_by_config"
    || nativeSubagents === "disabled_by_invocation";
  return {
    effective_cap: Math.min(globalCap, harnessCap),
    global_cap: globalCap,
    host_cap: Math.max(defaults.host_max_concurrency ?? DEFAULT_HOST_MAX_CONCURRENCY, globalCap),
    scope: defaults.concurrency_scope ?? DEFAULT_CONCURRENCY_SCOPE,
    ...(discovered !== undefined ? { discovered_limit: discovered } : {}),
    limit_source: limitSource,
    fallback_used: limitSource === "fallback",
    native_subagents: nativeSubagents,
    native_max_depth: nativeDisabled ? 0 : Math.min(cliLimits.max_depth ?? DEFAULT_NATIVE_DEPTH, defaults.native_subagent_depth),
    ...(cliLimits.max_depth !== undefined ? { discovered_max_depth: cliLimits.max_depth } : {}),
    ...(cliLimits.config_files.length > 0 ? { config_files: [...cliLimits.config_files] } : {}),
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
  };
}

/** The per-invocation subagent control handed to adapters; adapters only ever lower the CLI's own limits with it. */
export function buildNativeSubagentsControl(
  info: HarnessConcurrencyInfo, cliLimits: CliLimits, policy: DefaultsConfig["native_subagents"],
): NativeSubagentsControl {
  return {
    // A policy-disabled harness (policy "off" or native_subagent_depth = 0) is always told "off", whatever the caller passed.
    policy: info.native_subagents === "disabled_by_policy" ? "off" : policy,
    maxDepth: info.native_max_depth ?? 0,
    ...(cliLimits.max_depth !== undefined ? { discoveredMaxDepth: cliLimits.max_depth } : {}),
    discoveredKeys: [...cliLimits.discovered_keys],
    ...(cliLimits.max_depth_by_plugin !== undefined ? { discoveredPluginDepths: { ...cliLimits.max_depth_by_plugin } } : {}),
  };
}

interface SessionCounts {
  active: number;
  byHarness: Map<string, number>;
}

/** Read-only picture of running jobs: the host total and, per session, its total and per-harness counts. */
export interface ActiveCounts {
  total: number;
  sessions: ReadonlyMap<string, { active: number; byHarness: ReadonlyMap<string, number> }>;
}

/** Counts running jobs per session and harness; empty entries are pruned so the maps stay bounded by what is running. */
export class ConcurrencyLedger {
  private totalActive = 0;
  private readonly sessions = new Map<string, SessionCounts>();

  get total(): number {
    return this.totalActive;
  }

  acquire(sessionKey: string, harnessId: string): void {
    const session = this.sessions.get(sessionKey) ?? { active: 0, byHarness: new Map<string, number>() };
    session.active += 1;
    session.byHarness.set(harnessId, (session.byHarness.get(harnessId) ?? 0) + 1);
    this.sessions.set(sessionKey, session);
    this.totalActive += 1;
  }

  release(sessionKey: string, harnessId: string): void {
    const session = this.sessions.get(sessionKey);
    const harnessCount = session?.byHarness.get(harnessId) ?? 0;
    if (!session || harnessCount < 1) return; // Releasing something never acquired must not corrupt the counts.
    if (harnessCount > 1) session.byHarness.set(harnessId, harnessCount - 1);
    else session.byHarness.delete(harnessId);
    session.active -= 1;
    if (session.active < 1) this.sessions.delete(sessionKey);
    this.totalActive -= 1;
  }

  sessionActive(sessionKey: string): number {
    return this.sessions.get(sessionKey)?.active ?? 0;
  }

  harnessActive(sessionKey: string, harnessId: string): number {
    return this.sessions.get(sessionKey)?.byHarness.get(harnessId) ?? 0;
  }

  /** A detached copy, safe to hand to `planAdmissions` or to keep. */
  view(): ActiveCounts {
    return {
      total: this.totalActive,
      sessions: new Map([...this.sessions].map(([key, counts]) => [key, { active: counts.active, byHarness: new Map(counts.byHarness) }])),
    };
  }
}

export type BlockReason = "host_cap" | "session_cap" | "harness_cap" | "fifo" | "initializing";

/** One waiting job as the admission planner sees it. */
export interface QueuedSlotRequest {
  sessionKey: string;
  harnessId: string;
  /** Parallel jobs the session may run (`max_concurrency`). */
  sessionCap: number;
  /** Parallel jobs of this harness the session may run. */
  harnessCap: number;
  /** False while the job's run directory is still being created. */
  ready: boolean;
}

export interface AdmissionPlan {
  /** Queue indexes to start now, in start order. */
  start: number[];
  /** Why each remaining queue index must keep waiting. */
  blocked: Map<number, BlockReason>;
}

interface Lane {
  sessionKey: string;
  indexes: number[];
  next: number;
  active: number;
}

/**
 * Decides which queued jobs start now. Each (session, harness) pair is a lane that keeps FIFO order; a lane whose head
 * is not ready blocks only that lane. While the host has room, the eligible lane head belonging to the least-loaded
 * session starts first (ties go to the older job), so one busy repository cannot starve another. Pure: no I/O.
 */
export function planAdmissions(queue: readonly QueuedSlotRequest[], active: ActiveCounts, hostCap: number): AdmissionPlan {
  const lanes = new Map<string, Lane>();
  const sessionActive = new Map<string, number>();
  queue.forEach((request, index) => {
    const laneKey = `${request.sessionKey}\0${request.harnessId}`;
    let lane = lanes.get(laneKey);
    if (!lane) {
      const counts = active.sessions.get(request.sessionKey);
      lane = { sessionKey: request.sessionKey, indexes: [], next: 0, active: counts?.byHarness.get(request.harnessId) ?? 0 };
      lanes.set(laneKey, lane);
      sessionActive.set(request.sessionKey, counts?.active ?? 0);
    }
    lane.indexes.push(index);
  });

  const isEligible = (lane: Lane): boolean => {
    const head = queue[lane.indexes[lane.next]];
    return head.ready && (sessionActive.get(lane.sessionKey) ?? 0) < head.sessionCap && lane.active < head.harnessCap;
  };
  const start: number[] = [];
  let total = active.total;
  while (total < hostCap) {
    let best: Lane | undefined;
    for (const lane of lanes.values()) {
      if (lane.next >= lane.indexes.length || !isEligible(lane)) continue;
      const load = sessionActive.get(lane.sessionKey) ?? 0;
      const bestLoad = best ? (sessionActive.get(best.sessionKey) ?? 0) : Infinity;
      if (load < bestLoad || (load === bestLoad && lane.indexes[lane.next] < best!.indexes[best!.next])) best = lane;
    }
    if (!best) break;
    start.push(best.indexes[best.next]);
    best.next += 1;
    best.active += 1;
    sessionActive.set(best.sessionKey, (sessionActive.get(best.sessionKey) ?? 0) + 1);
    total += 1;
  }

  const blocked = new Map<number, BlockReason>();
  for (const lane of lanes.values()) {
    if (lane.next >= lane.indexes.length) continue;
    const head = queue[lane.indexes[lane.next]];
    const headReason: BlockReason = !head.ready ? "initializing"
      : (sessionActive.get(lane.sessionKey) ?? 0) >= head.sessionCap ? "session_cap"
      : lane.active >= head.harnessCap ? "harness_cap" : "host_cap";
    blocked.set(lane.indexes[lane.next], headReason);
    for (const index of lane.indexes.slice(lane.next + 1)) blocked.set(index, headReason === "host_cap" ? "host_cap" : "fifo");
  }
  return { start, blocked };
}
