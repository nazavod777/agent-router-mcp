/**
 * Pure, clock-free deadline policy for one running job. The runner re-arms a single timer from the returned `wakeAt`
 * and feeds monotonic millisecond timestamps (`performance.now()`), so nothing here polls or reads a clock.
 */

import type { ProgressToolStep, TimeoutKind } from "../types.js";

export type { TimeoutKind };
export type OutputMode = "streaming" | "buffered";

/** Minimum CPU time (ms) burned since the previous sample for a process group to count as busy. */
export const CPU_ACTIVE_THRESHOLD_MS = 500;
/** This many identical consecutive tool calls (same tool, target and arguments) are treated as a stuck loop, not progress. */
export const TOOL_LOOP_WINDOW = 10;
/** How long before a soft deadline or idle edge the runner samples CPU, so the sample is fresh when evaluated. */
export const CPU_PRESAMPLE_LEAD_MS = 2_000;

export interface DeadlinePolicy {
  outputMode: OutputMode;
  /** Soft limit, seconds. */
  softSec: number;
  /** Absolute cap, seconds; nothing extends past it. */
  hardSec: number;
  /** 0 disables idle detection. */
  idleSec: number;
  autoExtend: boolean;
  strict: boolean;
  /** One extension step, seconds. */
  chunkSec: number;
  /** A job counts as active when it produced output within this window, seconds. */
  windowSec: number;
}

export interface DeadlineState {
  spawnedAt?: number;
  softDeadline: number;
  hardDeadline: number;
  lastOutputAt?: number;
  lastStderrAt?: number;
  /** Last time the parser's semantic progress counter advanced. */
  lastProgressAt?: number;
  /** True when the adapter's parser exposes a semantic progress counter. */
  progressCounterAvailable: boolean;
  /** The most recent tool calls, oldest first, used to spot a stuck loop. */
  toolTrail?: ReadonlyArray<Pick<ProgressToolStep, "tool" | "target" | "variant" | "followedByText">>;
}

export interface DeadlineSample {
  now: number;
  /** CPU ms burned by the job's process group since the previous sample; undefined when unavailable. */
  cpuDeltaMs?: number;
}

export type DeadlineDecision =
  | { action: "kill"; kind: TimeoutKind }
  | { action: "extend"; softDeadline: number }
  | { action: "wait"; wakeAt: number; presampleAt?: number };

/** Upper bound on how many times the soft deadline can move before it hits the hard deadline. */
export function maxExtensions(policy: Pick<DeadlinePolicy, "softSec" | "hardSec" | "chunkSec">): number {
  if (policy.hardSec <= policy.softSec || policy.chunkSec <= 0) return 0;
  return Math.ceil((policy.hardSec - policy.softSec) / policy.chunkSec);
}

function cpuBusy(sample: DeadlineSample): boolean {
  return sample.cpuDeltaMs !== undefined && sample.cpuDeltaMs >= CPU_ACTIVE_THRESHOLD_MS;
}

/**
 * A stuck loop is the same call (tool, target and arguments) repeated with no assistant text after the latest one. Reading
 * one file at ten different offsets is paging, and text after the repeats shows the model went back to real work.
 */
function inToolLoop(trail: DeadlineState["toolTrail"]): boolean {
  if (!trail || trail.length < TOOL_LOOP_WINDOW) return false;
  const recent = trail.slice(-TOOL_LOOP_WINDOW);
  const first = recent[0];
  const identical = recent.every((step) => step.tool === first.tool && step.target === first.target && step.variant === first.variant);
  return identical && recent[recent.length - 1].followedByText !== true;
}

function idleEdge(policy: DeadlinePolicy, state: DeadlineState): number | undefined {
  if (policy.outputMode !== "streaming" || policy.idleSec <= 0 || policy.strict || state.spawnedAt === undefined) return undefined;
  const reference = state.progressCounterAvailable ? state.lastProgressAt : state.lastOutputAt;
  return Math.max(state.spawnedAt, reference ?? 0) + policy.idleSec * 1_000;
}

function isActive(policy: DeadlinePolicy, state: DeadlineState, sample: DeadlineSample): boolean {
  const windowMs = policy.windowSec * 1_000;
  if (policy.outputMode === "streaming") {
    const recentOutput = state.lastOutputAt !== undefined && sample.now - state.lastOutputAt <= windowMs;
    const recentProgress = !state.progressCounterAvailable
      || (state.lastProgressAt !== undefined && sample.now - state.lastProgressAt <= policy.chunkSec * 1_000);
    return recentOutput && recentProgress && !inToolLoop(state.toolTrail);
  }
  const recentStderr = state.lastStderrAt !== undefined && sample.now - state.lastStderrAt <= windowMs;
  return recentStderr || cpuBusy(sample);
}

/**
 * Decides what to do with a job at `sample.now`. Order: hard cap, idle stall, soft deadline (kill or extend), else
 * sleep until the earliest moment any of those can change. An extension returns the new soft deadline; the caller
 * stores it and evaluates again.
 */
export function evaluateDeadline(policy: DeadlinePolicy, state: DeadlineState, sample: DeadlineSample): DeadlineDecision {
  const { now } = sample;
  if (now >= state.hardDeadline) return { action: "kill", kind: "hard" };

  const idleAt = idleEdge(policy, state);
  if (idleAt !== undefined && now >= idleAt && !cpuBusy(sample)) return { action: "kill", kind: "idle" };

  if (now >= state.softDeadline) {
    if (policy.strict || !policy.autoExtend) return { action: "kill", kind: "soft" };
    if (isActive(policy, state, sample) && state.softDeadline < state.hardDeadline) {
      return { action: "extend", softDeadline: Math.min(state.softDeadline + policy.chunkSec * 1_000, state.hardDeadline) };
    }
    return { action: "kill", kind: "soft" };
  }

  // An idle edge that was passed while the CPU was busy is re-checked after one activity window.
  const idleWake = idleAt === undefined ? undefined : idleAt > now ? idleAt : now + policy.windowSec * 1_000;
  const wakeAt = Math.min(state.softDeadline, state.hardDeadline, idleWake ?? Infinity);
  const presampleAt = wakeAt - CPU_PRESAMPLE_LEAD_MS;
  return { action: "wait", wakeAt, ...(presampleAt > now ? { presampleAt } : {}) };
}
