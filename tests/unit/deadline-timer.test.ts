import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeadlinePolicy } from "../../src/runtime/deadline.js";
import { DeadlineTimer, type TimeoutProgress } from "../../src/runtime/deadline-timer.js";
import type { TimeoutKind } from "../../src/types.js";

const SECOND = 1_000;
const STREAMING: DeadlinePolicy = {
  outputMode: "streaming", softSec: 10, hardSec: 40, idleSec: 20, autoExtend: true, strict: false, chunkSec: 10, windowSec: 30,
};

describe("DeadlineTimer", () => {
  let clock: number;
  let cpu: number;
  let kills: Array<{ kind: TimeoutKind; progress: TimeoutProgress }>;
  let extensions: TimeoutProgress[];

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000;
    cpu = 0;
    kills = [];
    extensions = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function create(policy: Partial<DeadlinePolicy> = {}): DeadlineTimer {
    return new DeadlineTimer({
      policy: { ...STREAMING, ...policy },
      startedAt: clock,
      now: () => clock,
      sampleCpu: async () => cpu,
      onExtend: (progress) => extensions.push(progress),
      onKill: (kind, progress) => kills.push({ kind, progress }),
    });
  }

  /** Moves the fake clock and the fake timers together, one second at a time, burning `cpuPerSecond` CPU ms per second. */
  async function advance(seconds: number, activity?: (second: number) => void, cpuPerSecond = 0): Promise<void> {
    for (let second = 0; second < seconds; second++) {
      clock += SECOND;
      cpu += cpuPerSecond;
      activity?.(second);
      await vi.advanceTimersByTimeAsync(SECOND);
    }
  }

  it("arms its first wake exactly at the configured limit, measured from the job's start", () => {
    const schedule = vi.spyOn(globalThis, "setTimeout");
    create({ outputMode: "buffered", softSec: 11, hardSec: 23 });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 11_000);
  });

  it("kills a buffered job without activity at its soft deadline", async () => {
    const timer = create({ outputMode: "buffered" });
    timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
    await advance(11);
    expect(kills.map(({ kind }) => kind)).toEqual(["soft"]);
    expect(kills[0].progress).toMatchObject({ softSec: 10, effectiveSec: 10, extensionsUsed: 0 });
  });

  it("extends a streaming job that keeps producing output, then stops it at the hard deadline", async () => {
    const timer = create({ idleSec: 0 });
    timer.markSpawned({ pgid: 4242, outputMode: "streaming", progressCounterAvailable: false });
    await advance(45, () => timer.noteStdout());
    expect(extensions.map(({ extensionsUsed, effectiveSec }) => [extensionsUsed, effectiveSec])).toEqual([[1, 20], [2, 30], [3, 40]]);
    expect(kills.map(({ kind }) => kind)).toEqual(["hard"]);
    expect(kills[0].progress).toMatchObject({ extensionsUsed: 3, effectiveSec: 40, hardSec: 40 });
  });

  it("stops a streaming job that went silent as idle, long before its soft deadline", async () => {
    const timer = create({ softSec: 100, hardSec: 200 });
    timer.markSpawned({ pgid: 4242, outputMode: "streaming", progressCounterAvailable: false });
    await advance(5, () => timer.noteStdout());
    await advance(30);
    expect(kills.map(({ kind }) => kind)).toEqual(["idle"]);
    expect(kills[0].progress.lastActivityMsAgo).toBeGreaterThanOrEqual(19_000);
  });

  it("counts only parser progress, not raw output, toward idleness when the parser reports it", async () => {
    const timer = create({ softSec: 100, hardSec: 200 });
    timer.markSpawned({ pgid: 4242, outputMode: "streaming", progressCounterAvailable: true });
    await advance(30, () => timer.noteStdout()); // Chatter only: the progress counter never moves.
    expect(kills.map(({ kind }) => kind)).toEqual(["idle"]);
  });

  it("keeps a job alive while its progress counter moves", async () => {
    const timer = create({ softSec: 100, hardSec: 200 });
    timer.markSpawned({ pgid: 4242, outputMode: "streaming", progressCounterAvailable: true });
    let count = 0;
    await advance(60, () => { timer.noteStdout(); timer.noteProgressCounter(++count); });
    expect(kills).toEqual([]);
  });

  it("does not stop an idle-looking streaming job whose process group burns CPU", async () => {
    const timer = create({ softSec: 100, hardSec: 200 });
    timer.markSpawned({ pgid: 4242, outputMode: "streaming", progressCounterAvailable: false });
    await advance(60, undefined, 1_000);
    expect(kills).toEqual([]);
  });

  it("never idle-stops a buffered job", async () => {
    const timer = create({ outputMode: "buffered", softSec: 100, hardSec: 200 });
    timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
    await advance(90);
    expect(kills).toEqual([]);
  });

  it("samples the CPU shortly before a decision that depends on it", async () => {
    const samples: number[] = [];
    const timer = new DeadlineTimer({
      policy: { ...STREAMING, outputMode: "buffered", softSec: 30, hardSec: 60 },
      startedAt: clock, now: () => clock, sampleCpu: async () => { samples.push(clock); return 0; },
      onExtend: () => undefined, onKill: (kind) => kills.push({ kind, progress: timer.progress() }),
    });
    timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
    await advance(31);
    // One baseline at spawn, one presample two seconds before the soft deadline, one at the deadline.
    expect(samples.filter((at) => at >= 1_000 + 27 * SECOND)).toHaveLength(2);
    expect(kills.map(({ kind }) => kind)).toEqual(["soft"]);
  });

  describe("when the timer fires before its target", () => {
    /** Runs a CPU-busy buffered job up to its soft deadline; the final wake arrives `earlyMs` before the clock reaches it. */
    async function runBusyJobWithEarlyFinalWake(earlyMs: number): Promise<void> {
      const timer = create({ outputMode: "buffered", softSec: 30, hardSec: 60 });
      timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
      await advance(29, undefined, 1_000); // includes the presample two seconds before the deadline
      cpu += 1_000;
      clock += SECOND - earlyMs;
      await vi.advanceTimersByTimeAsync(SECOND);
    }

    it("still sees the busy CPU when it wakes within the timer slack", async () => {
      await runBusyJobWithEarlyFinalWake(2);
      expect(kills).toEqual([]);
      expect(extensions).toHaveLength(1);
    });

    it("keeps the previous CPU window when it has to re-check a few moments later", async () => {
      await runBusyJobWithEarlyFinalWake(80);
      clock += 80;
      await vi.advanceTimersByTimeAsync(80);
      expect(kills).toEqual([]);
      expect(extensions).toHaveLength(1);
    });
  });

  it("never fires a kill once frozen, even long past every deadline", async () => {
    const timer = create({ outputMode: "buffered" });
    timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
    await advance(5);
    timer.freeze();
    await advance(100);
    expect(kills).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a kill decision that was waiting on a CPU sample when the job froze", async () => {
    let releaseSample!: () => void;
    const pending = new Promise<void>((resolve) => { releaseSample = resolve; });
    const timer = new DeadlineTimer({
      policy: { ...STREAMING, outputMode: "buffered" }, startedAt: clock, now: () => clock,
      sampleCpu: async () => { await pending; return 0; }, onExtend: () => undefined,
      onKill: (kind) => kills.push({ kind, progress: timer.progress() }),
    });
    timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
    await advance(10);
    timer.freeze();
    releaseSample();
    await advance(5);
    expect(kills).toEqual([]);
  });

  describe("when the CPU sampler never answers", () => {
    function createWithHungSampler(policy: Partial<DeadlinePolicy>): DeadlineTimer {
      const timer = new DeadlineTimer({
        policy: { ...STREAMING, ...policy }, startedAt: clock, now: () => clock,
        sampleCpu: () => new Promise<number | undefined>(() => undefined),
        onExtend: (progress) => extensions.push(progress),
        onKill: (kind, progress) => kills.push({ kind, progress }),
      });
      timer.markSpawned({ pgid: 4242, outputMode: policy.outputMode ?? "streaming", progressCounterAvailable: false });
      return timer;
    }

    it("still stops a strict job exactly at its limit", async () => {
      createWithHungSampler({ outputMode: "buffered", strict: true });
      await advance(11);
      expect(kills.map(({ kind }) => kind)).toEqual(["soft"]);
    });

    it("still stops an extended job at the hard deadline", async () => {
      const timer = createWithHungSampler({ idleSec: 0 });
      await advance(45, () => timer.noteStdout());
      expect(kills.map(({ kind }) => kind)).toEqual(["hard"]);
    });
  });

  describe("freeze() after a deadline that already passed", () => {
    it("reports the hard deadline instead of silently dropping it", () => {
      const timer = create({ outputMode: "buffered" });
      timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
      clock += 41 * SECOND;
      timer.freeze();
      expect(kills.map(({ kind }) => kind)).toEqual(["hard"]);
      timer.freeze();
      expect(kills).toHaveLength(1);
    });

    it("reports the strict limit instead of silently dropping it", () => {
      const timer = create({ outputMode: "buffered", strict: true });
      timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
      clock += 11 * SECOND;
      timer.freeze();
      expect(kills.map(({ kind }) => kind)).toEqual(["soft"]);
    });

    it("reports the soft deadline of a job whose timeout cannot be extended, even when it is not strict", () => {
      const timer = create({ outputMode: "streaming", autoExtend: false, strict: false });
      timer.markSpawned({ pgid: 4242, outputMode: "streaming", progressCounterAvailable: false });
      timer.noteStdout();
      clock += 11 * SECOND;
      timer.freeze();
      expect(kills.map(({ kind }) => kind)).toEqual(["soft"]);
    });

    it("leaves a soft deadline of a non-strict job alone, because only activity can decide it", () => {
      const timer = create({ outputMode: "buffered" });
      timer.markSpawned({ pgid: 4242, outputMode: "buffered", progressCounterAvailable: false });
      clock += 11 * SECOND;
      timer.freeze();
      expect(kills).toEqual([]);
    });
  });

  it("treats a failing tool-trail reader as no evidence of a loop instead of crashing", async () => {
    const timer = new DeadlineTimer({
      policy: { ...STREAMING, idleSec: 0, hardSec: 15 }, startedAt: clock, now: () => clock, sampleCpu: async () => cpu,
      toolTrail: () => { throw new Error("parser exploded"); },
      onExtend: (progress) => extensions.push(progress), onKill: (kind, progress) => kills.push({ kind, progress }),
    });
    timer.markSpawned({ pgid: 4242, outputMode: "streaming", progressCounterAvailable: true });
    let count = 0;
    await advance(16, () => { timer.noteStdout(); timer.noteProgressCounter(++count); });
    expect(extensions).toHaveLength(1);
    expect(kills.map(({ kind }) => kind)).toEqual(["hard"]);
  });

  it("does not sample the CPU or idle-stop before the process exists", async () => {
    create({ softSec: 100, hardSec: 200 });
    await advance(50);
    expect(kills).toEqual([]);
  });
});
