import type { TimeoutKind } from "../types.js";
import {
  CPU_PRESAMPLE_LEAD_MS, evaluateDeadline, maxExtensions, type DeadlinePolicy, type DeadlineState, type OutputMode,
} from "./deadline.js";
import { sampleProcessGroupCpuMs } from "./process-tree.js";

const MS_PER_SECOND = 1_000;
const MAX_TIMER_MS = 2_147_483_647;
const RETRY_AFTER_ERROR_MS = 1_000;
/** A CPU sample older than this is too stale to say anything about "right now"; its delta is scaled down to a lead window. */
const CPU_WINDOW_MS = CPU_PRESAMPLE_LEAD_MS;
/** A wake that lands this close before its target (timers may fire a little early) is treated as the target itself. */
const EARLY_WAKE_SLACK_MS = 5;
/** Two CPU samples closer than this say nothing about busyness; the previous window's answer is reused instead. */
const MIN_CPU_SAMPLE_GAP_MS = 250;
/** A CPU sample that has not answered after this long is abandoned for this wake; it can never hold back a deadline. */
const MAX_CPU_SAMPLE_WAIT_MS = 1_000;

/** What the runner needs to describe a timeout to the caller. All durations are seconds unless the name says ms. */
export interface TimeoutProgress {
  softSec: number;
  /** The soft limit including extensions. */
  effectiveSec: number;
  hardSec: number;
  idleSec: number;
  extensionsUsed: number;
  maxExtensions: number;
  lastActivityMsAgo?: number;
}

export interface DeadlineTimerOptions {
  policy: DeadlinePolicy;
  /** Monotonic ms (performance.now()) at which the job's clock started. */
  startedAt: number;
  now?: () => number;
  sampleCpu?: (pgid: number) => Promise<number | undefined>;
  /** Recent tool steps of the job; read only when a soft deadline is reached on a streaming job. */
  toolTrail?: () => DeadlineState["toolTrail"];
  onExtend: (progress: TimeoutProgress) => void;
  onKill: (kind: TimeoutKind, progress: TimeoutProgress) => void;
}

/**
 * Drives `evaluateDeadline` for one job with a single re-armed timer: no polling, one wake-up per deadline edge. Once
 * `freeze()` has been called (the child exited, or the job ended) it never fires a kill again, so a job that already
 * finished is never reported as timed out while its output streams drain. The one exception is a hard deadline, or a soft
 * deadline that cannot be extended (strict, or `auto_extend_timeout = false`), that had already passed when the job was
 * frozen: that is still reported, once.
 */
export class DeadlineTimer {
  private readonly policy: DeadlinePolicy;
  private readonly state: DeadlineState;
  private readonly now: () => number;
  private readonly sampleCpu: (pgid: number) => Promise<number | undefined>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private extensions = 0;
  private pgid?: number;
  private cpuBaseline?: { cpuMs: number; at: number };
  /** The busyness of the last full CPU window, reused when a wake comes right after a sample. */
  private lastCpuDeltaMs?: number;
  private wakeTarget?: number;
  private lastProgressCount = 0;
  private ticking = false;

  constructor(private readonly options: DeadlineTimerOptions) {
    this.policy = { ...options.policy };
    this.now = options.now ?? (() => performance.now());
    this.sampleCpu = options.sampleCpu ?? sampleProcessGroupCpuMs;
    this.state = {
      softDeadline: options.startedAt + this.policy.softSec * MS_PER_SECOND,
      hardDeadline: options.startedAt + this.policy.hardSec * MS_PER_SECOND,
      progressCounterAvailable: false,
    };
    // The first wake is measured from the job's own start, not from "now", so the delay is exactly the configured limit.
    this.arm(options.startedAt);
  }

  /** The child process exists: idle detection starts from this moment and CPU can be sampled. */
  markSpawned(info: { pgid?: number; outputMode: OutputMode; progressCounterAvailable: boolean }): void {
    if (this.stopped) return;
    const now = this.now();
    this.policy.outputMode = info.outputMode;
    this.pgid = info.pgid;
    this.state.spawnedAt = now;
    this.state.progressCounterAvailable = info.progressCounterAvailable;
    void this.refreshCpuBaseline();
    this.arm(now);
  }

  noteStdout(): void {
    this.state.lastOutputAt = this.now();
  }

  noteStderr(): void {
    this.state.lastStderrAt = this.now();
  }

  /** Pass the parser's monotonic semantic-progress counter; only an increase counts as progress. */
  noteProgressCounter(count: number): void {
    if (count <= this.lastProgressCount) return;
    this.lastProgressCount = count;
    this.state.lastProgressAt = this.now();
  }

  /**
   * Stops all future kills and extensions and releases the timer. Safe to call repeatedly. A deadline that needs no
   * activity check (the hard cap, a strict limit, or a soft limit without auto-extension) and has already passed is
   * reported first, so a late wake-up can never turn it into a normal finish.
   */
  freeze(): void {
    if (this.stopped) return;
    const elapsed = this.elapsedUnconditionalDeadline(this.now());
    const progress = elapsed === undefined ? undefined : this.progress();
    this.stop();
    if (elapsed !== undefined && progress) this.options.onKill(elapsed, progress);
  }

  progress(): TimeoutProgress {
    const now = this.now();
    const lastSignal = this.latestSignalAt();
    return {
      softSec: this.policy.softSec,
      effectiveSec: Math.round((this.state.softDeadline - this.options.startedAt) / MS_PER_SECOND),
      hardSec: this.policy.hardSec,
      idleSec: this.idleSec(),
      extensionsUsed: this.extensions,
      maxExtensions: maxExtensions(this.policy),
      ...(lastSignal === undefined ? {} : { lastActivityMsAgo: Math.max(0, Math.round(now - lastSignal)) }),
    };
  }

  /** Idle seconds that actually apply to this job (0 when idle detection is off or does not fit the CLI). */
  idleSec(): number {
    return this.policy.outputMode === "streaming" && !this.policy.strict ? this.policy.idleSec : 0;
  }

  private latestSignalAt(): number | undefined {
    const signals = [this.state.lastOutputAt, this.state.lastStderrAt, this.state.lastProgressAt].filter((at): at is number => at !== undefined);
    return signals.length === 0 ? undefined : Math.max(...signals);
  }

  private stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The kind of a deadline that has passed and whose kill does not depend on CPU or output activity. */
  private elapsedUnconditionalDeadline(now: number): TimeoutKind | undefined {
    if (now >= this.state.hardDeadline) return "hard";
    // A strict limit, or a soft limit that nothing may extend, is a plain wall-clock limit whatever the CPU or output did.
    const softIsUnconditional = this.policy.strict || !this.policy.autoExtend;
    return softIsUnconditional && now >= this.state.softDeadline ? "soft" : undefined;
  }

  private arm(now: number, wakeAt?: number): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const decision = wakeAt === undefined ? evaluateDeadline(this.policy, this.state, { now }) : undefined;
    const target = wakeAt ?? (decision?.action === "wait" ? this.nextWake(decision, now) : now);
    this.wakeTarget = target;
    this.timer = setTimeout(() => void this.tick(), Math.max(0, Math.min(MAX_TIMER_MS, Math.round(target - now))));
  }

  /** Samples the CPU only once the child exists; before that the first wake is simply the soft/hard edge. */
  private nextWake(decision: { wakeAt: number; presampleAt?: number }, now: number): number {
    // A strict job is stopped at its limit whatever its CPU does, so there is nothing to sample for.
    const sampling = !this.policy.strict && this.pgid !== undefined && decision.presampleAt !== undefined && decision.presampleAt > now;
    return sampling ? decision.presampleAt! : decision.wakeAt;
  }

  private async refreshCpuBaseline(): Promise<number> {
    const at = this.now();
    const cpuMs = this.pgid === undefined ? undefined : await this.sampleCpu(this.pgid).catch(() => undefined);
    if (cpuMs !== undefined) this.cpuBaseline = { cpuMs, at };
    return at;
  }

  /** CPU burned since the previous sample, scaled to a lead-sized window so an old baseline cannot overstate activity. */
  private async takeCpuDelta(): Promise<number | undefined> {
    const previous = this.cpuBaseline;
    if (this.pgid === undefined) return undefined;
    const cpuMs = await this.sampleCpu(this.pgid).catch(() => undefined);
    const at = this.now();
    if (cpuMs === undefined) return undefined;
    if (!previous) {
      this.cpuBaseline = { cpuMs, at };
      return undefined;
    }
    const elapsed = at - previous.at;
    // A wake right after a sample (an early timer, or a re-check) must not shrink the window to a few ms of CPU.
    if (elapsed < MIN_CPU_SAMPLE_GAP_MS) return this.lastCpuDeltaMs;
    this.cpuBaseline = { cpuMs, at };
    const delta = Math.max(0, cpuMs - previous.cpuMs);
    this.lastCpuDeltaMs = elapsed > CPU_WINDOW_MS ? delta * (CPU_WINDOW_MS / elapsed) : delta;
    return this.lastCpuDeltaMs;
  }

  /** The current time, with a wake that landed within the timer slack before its target counted as the target itself. */
  private wakeTime(): number {
    const rawNow = this.now();
    return this.wakeTarget !== undefined && this.wakeTarget - rawNow <= EARLY_WAKE_SLACK_MS ? Math.max(rawNow, this.wakeTarget) : rawNow;
  }

  /** How long this wake may wait for a CPU sample: none for a strict job or past the hard cap, and never beyond the hard cap. */
  private cpuSampleBudgetMs(now: number): number {
    if (this.policy.strict) return 0;
    return Math.max(0, Math.min(MAX_CPU_SAMPLE_WAIT_MS, this.state.hardDeadline - now));
  }

  /** The CPU delta, or undefined when sampling failed or did not answer within `budgetMs`. */
  private async takeCpuDeltaWithin(budgetMs: number): Promise<number | undefined> {
    if (budgetMs <= 0) return undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const unanswered = new Promise<undefined>((resolve) => { giveUp = setTimeout(() => resolve(undefined), budgetMs); });
    try {
      return await Promise.race([this.takeCpuDelta(), unanswered]);
    } finally {
      clearTimeout(giveUp);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const cpuDeltaMs = await this.takeCpuDeltaWithin(this.cpuSampleBudgetMs(this.wakeTime()));
      if (this.stopped) return;
      const now = this.wakeTime();
      for (;;) {
        if (this.policy.outputMode === "streaming" && now >= this.state.softDeadline) this.state.toolTrail = this.readToolTrail();
        const decision = evaluateDeadline(this.policy, this.state, { now, cpuDeltaMs });
        if (decision.action === "extend") {
          this.state.softDeadline = decision.softDeadline;
          this.extensions += 1;
          this.options.onExtend(this.progress());
          continue;
        }
        if (decision.action === "kill") {
          const progress = this.progress();
          this.stop();
          this.options.onKill(decision.kind, progress);
          return;
        }
        this.arm(now, this.nextWake(decision, now));
        return;
      }
    } catch {
      // A failing callback must not become an unhandled rejection; try again shortly (never in a tight loop).
      if (!this.stopped) this.arm(this.now(), this.now() + RETRY_AFTER_ERROR_MS);
    } finally {
      this.ticking = false;
    }
  }

  /** The parser's checkpoint is best-effort evidence; a parser that throws just means "no loop detected". */
  private readToolTrail(): DeadlineState["toolTrail"] {
    try {
      return this.options.toolTrail?.();
    } catch {
      return undefined;
    }
  }
}
