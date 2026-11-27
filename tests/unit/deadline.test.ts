import { describe, expect, it } from "vitest";
import {
  CPU_PRESAMPLE_LEAD_MS, evaluateDeadline, maxExtensions, TOOL_LOOP_WINDOW, type DeadlinePolicy, type DeadlineState,
} from "../../src/runtime/deadline.js";

const SECOND = 1_000;
const BASE: DeadlinePolicy = {
  outputMode: "streaming", softSec: 100, hardSec: 1_000, idleSec: 300, autoExtend: true, strict: false, chunkSec: 600, windowSec: 180,
};

function stateAt(overrides: Partial<DeadlineState> = {}): DeadlineState {
  return { spawnedAt: 0, softDeadline: 900 * SECOND, hardDeadline: 1_000 * SECOND, progressCounterAvailable: false, ...overrides };
}

/** A job whose soft deadline is at 100s. */
function softState(overrides: Partial<DeadlineState> = {}): DeadlineState {
  return stateAt({ softDeadline: 100 * SECOND, ...overrides });
}

const policy = (overrides: Partial<DeadlinePolicy> = {}): DeadlinePolicy => ({ ...BASE, ...overrides });
type TrailStep = NonNullable<DeadlineState["toolTrail"]>[number];
const loop = (count: number, target = "src/a.ts"): TrailStep[] => Array.from({ length: count }, () => ({ tool: "Read", target }));

describe("maxExtensions", () => {
  it.each([
    [{ softSec: 100, hardSec: 1_000, chunkSec: 600 }, 2],
    [{ softSec: 100, hardSec: 700, chunkSec: 600 }, 1],
    [{ softSec: 100, hardSec: 100, chunkSec: 600 }, 0],
    [{ softSec: 900, hardSec: 100, chunkSec: 600 }, 0],
    [{ softSec: 1, hardSec: 3_601, chunkSec: 60 }, 60],
  ])("counts %j as %i", (input, expected) => {
    expect(maxExtensions(input)).toBe(expected);
  });
});

describe("evaluateDeadline", () => {
  it("kills at the hard deadline before looking at anything else", () => {
    const state = stateAt({ lastOutputAt: 999 * SECOND, lastProgressAt: 999 * SECOND, progressCounterAvailable: true });
    expect(evaluateDeadline(policy(), state, { now: 1_000 * SECOND })).toEqual({ action: "kill", kind: "hard" });
  });

  it("reports soft==hard as a hard stop", () => {
    expect(evaluateDeadline(policy(), stateAt({ softDeadline: 1_000 * SECOND }), { now: 1_000 * SECOND })).toEqual({ action: "kill", kind: "hard" });
  });

  describe("idle detection", () => {
    it("kills a streaming job whose output stopped for idleSec", () => {
      const state = stateAt({ lastOutputAt: 10 * SECOND });
      expect(evaluateDeadline(policy(), state, { now: 310 * SECOND - 1 }).action).toBe("wait");
      expect(evaluateDeadline(policy(), state, { now: 310 * SECOND })).toEqual({ action: "kill", kind: "idle" });
    });

    it("counts from the spawn time when the job never produced output", () => {
      expect(evaluateDeadline(policy(), stateAt({ spawnedAt: 5 * SECOND }), { now: 304 * SECOND }).action).toBe("wait");
      expect(evaluateDeadline(policy(), stateAt({ spawnedAt: 5 * SECOND }), { now: 305 * SECOND })).toEqual({ action: "kill", kind: "idle" });
    });

    it("uses semantic progress, not raw output, when the parser has a progress counter", () => {
      // Output (keepalives, api_retry) keeps arriving, but no assistant text or tool step has for idleSec.
      const state = stateAt({ lastOutputAt: 299 * SECOND, lastProgressAt: 10 * SECOND, progressCounterAvailable: true });
      expect(evaluateDeadline(policy(), state, { now: 310 * SECOND })).toEqual({ action: "kill", kind: "idle" });
      const withoutCounter = stateAt({ lastOutputAt: 299 * SECOND, progressCounterAvailable: false });
      expect(evaluateDeadline(policy(), withoutCounter, { now: 310 * SECOND }).action).toBe("wait");
    });

    it("spares an idle-looking job whose process group burns CPU", () => {
      const state = stateAt({ lastOutputAt: 10 * SECOND });
      expect(evaluateDeadline(policy(), state, { now: 400 * SECOND, cpuDeltaMs: 499 })).toEqual({ action: "kill", kind: "idle" });
      expect(evaluateDeadline(policy(), state, { now: 400 * SECOND, cpuDeltaMs: 500 }).action).toBe("wait");
    });

    it("rechecks a CPU-busy idle job after one activity window", () => {
      const decision = evaluateDeadline(policy(), stateAt({ lastOutputAt: 10 * SECOND }), { now: 400 * SECOND, cpuDeltaMs: 800 });
      expect(decision).toMatchObject({ action: "wait", wakeAt: 400 * SECOND + 180 * SECOND });
    });

    it.each([
      ["buffered CLIs", { outputMode: "buffered" as const }],
      ["idleSec 0", { idleSec: 0 }],
      ["strict timeouts", { strict: true }],
    ])("never applies to %s", (_name, overrides) => {
      expect(evaluateDeadline(policy(overrides), stateAt({ lastOutputAt: 0 }), { now: 800 * SECOND }).action).toBe("wait");
    });

    it("does not run before the process was spawned", () => {
      expect(evaluateDeadline(policy(), stateAt({ spawnedAt: undefined }), { now: 800 * SECOND }).action).toBe("wait");
    });
  });

  describe("soft deadline", () => {
    const now = 100 * SECOND;

    it("kills when auto-extension is off or the timeout is strict", () => {
      const active = softState({ lastOutputAt: now - SECOND });
      expect(evaluateDeadline(policy({ autoExtend: false }), active, { now })).toEqual({ action: "kill", kind: "soft" });
      expect(evaluateDeadline(policy({ strict: true }), active, { now })).toEqual({ action: "kill", kind: "soft" });
    });

    it("extends a streaming job with recent output by one chunk, capped at the hard deadline", () => {
      const active = softState({ lastOutputAt: now - SECOND });
      expect(evaluateDeadline(policy(), active, { now })).toEqual({ action: "extend", softDeadline: 700 * SECOND });
      const nearCap = softState({ lastOutputAt: 899 * SECOND, softDeadline: 900 * SECOND });
      expect(evaluateDeadline(policy(), nearCap, { now: 900 * SECOND })).toEqual({ action: "extend", softDeadline: 1_000 * SECOND });
    });

    it("kills a streaming job whose last output left the activity window", () => {
      const quiet = softState({ lastOutputAt: now - 181 * SECOND, spawnedAt: now - 190 * SECOND });
      expect(evaluateDeadline(policy({ idleSec: 0 }), quiet, { now })).toEqual({ action: "kill", kind: "soft" });
      const justInside = softState({ lastOutputAt: now - 180 * SECOND });
      expect(evaluateDeadline(policy({ idleSec: 0 }), justInside, { now }).action).toBe("extend");
    });

    it("needs recent semantic progress when the parser reports it", () => {
      const noisy = softState({ lastOutputAt: now - SECOND, lastProgressAt: now - SECOND, progressCounterAvailable: true });
      expect(evaluateDeadline(policy({ idleSec: 0 }), { ...noisy, lastProgressAt: -501 * SECOND }, { now })).toEqual({ action: "kill", kind: "soft" });
      expect(evaluateDeadline(policy({ idleSec: 0 }), { ...noisy, lastProgressAt: 50 * SECOND }, { now }).action).toBe("extend");
      expect(evaluateDeadline(policy({ idleSec: 0 }), { ...noisy, lastProgressAt: undefined }, { now })).toEqual({ action: "kill", kind: "soft" });
    });

    it("refuses to extend a job stuck repeating the same tool call", () => {
      const base = { lastOutputAt: now - SECOND, lastProgressAt: now - SECOND, progressCounterAvailable: true };
      const stuck = softState({ ...base, toolTrail: loop(TOOL_LOOP_WINDOW) });
      expect(evaluateDeadline(policy(), stuck, { now })).toEqual({ action: "kill", kind: "soft" });
      const almost = softState({ ...base, toolTrail: loop(TOOL_LOOP_WINDOW - 1) });
      expect(evaluateDeadline(policy(), almost, { now }).action).toBe("extend");
      const varied = softState({ ...base, toolTrail: [...loop(TOOL_LOOP_WINDOW - 1), { tool: "Read", target: "src/b.ts" }] });
      expect(evaluateDeadline(policy(), varied, { now }).action).toBe("extend");
    });

    describe("stuck-loop detection", () => {
      const base = { lastOutputAt: now - SECOND, lastProgressAt: now - SECOND, progressCounterAvailable: true };
      const paged = (count: number): TrailStep[] => Array.from({ length: count }, (_, index) => ({ tool: "Read", target: "src/a.ts", variant: `limit=200 offset=${index * 200}` }));

      it("does not mistake ten reads of one file at different offsets for a loop", () => {
        const state = softState({ ...base, toolTrail: paged(TOOL_LOOP_WINDOW) });
        expect(evaluateDeadline(policy(), state, { now }).action).toBe("extend");
      });

      it("still flags the same read repeated with the same arguments and no text after it", () => {
        const same: TrailStep[] = loop(TOOL_LOOP_WINDOW).map((step) => ({ ...step, variant: "limit=200 offset=0" }));
        expect(evaluateDeadline(policy(), softState({ ...base, toolTrail: same }), { now })).toEqual({ action: "kill", kind: "soft" });
      });

      it("does not flag identical calls once the assistant produced fresh text after them", () => {
        const repeated = loop(TOOL_LOOP_WINDOW).map((step, index) => (index === TOOL_LOOP_WINDOW - 1 ? { ...step, followedByText: true } : step));
        expect(evaluateDeadline(policy(), softState({ ...base, toolTrail: repeated }), { now }).action).toBe("extend");
      });
    });

    it("extends a buffered job with recent stderr or CPU activity only", () => {
      const buffered = policy({ outputMode: "buffered" });
      expect(evaluateDeadline(buffered, softState({ lastStderrAt: now - 10 * SECOND }), { now }).action).toBe("extend");
      expect(evaluateDeadline(buffered, softState(), { now, cpuDeltaMs: 500 }).action).toBe("extend");
      expect(evaluateDeadline(buffered, softState(), { now, cpuDeltaMs: 499 })).toEqual({ action: "kill", kind: "soft" });
      expect(evaluateDeadline(buffered, softState({ lastStderrAt: now - 181 * SECOND }), { now })).toEqual({ action: "kill", kind: "soft" });
      // Stdout noise does not make a buffered job active: its stdout is only the final answer.
      expect(evaluateDeadline(buffered, softState({ lastOutputAt: now - SECOND }), { now })).toEqual({ action: "kill", kind: "soft" });
    });
  });

  describe("waiting", () => {
    it("wakes at the earliest of soft, hard and idle edges and asks for a CPU sample just before", () => {
      const state = stateAt({ spawnedAt: 0, lastOutputAt: 0 });
      const decision = evaluateDeadline(policy({ idleSec: 50 }), state, { now: 10 * SECOND });
      expect(decision).toEqual({ action: "wait", wakeAt: 50 * SECOND, presampleAt: 50 * SECOND - CPU_PRESAMPLE_LEAD_MS });
    });

    it("wakes at the soft deadline for a buffered job", () => {
      expect(evaluateDeadline(policy({ outputMode: "buffered" }), softState(), { now: 0 }))
        .toEqual({ action: "wait", wakeAt: 100 * SECOND, presampleAt: 100 * SECOND - CPU_PRESAMPLE_LEAD_MS });
    });

    it("skips the presample when the wake is too close", () => {
      const decision = evaluateDeadline(policy({ outputMode: "buffered" }), softState(), { now: 99 * SECOND });
      expect(decision).toEqual({ action: "wait", wakeAt: 100 * SECOND });
    });
  });
});
