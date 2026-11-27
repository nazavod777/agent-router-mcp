import { describe, expect, it } from "vitest";
import { emptyCliLimits } from "../../src/config/cli-limits.js";
import {
  ConcurrencyLedger, buildNativeSubagentsControl, planAdmissions, resolveHarnessConcurrency, type ActiveCounts, type QueuedSlotRequest,
} from "../../src/runtime/concurrency.js";

const NONE: ActiveCounts = { total: 0, sessions: new Map() };

function request(sessionKey: string, harnessId = "claude", overrides: Partial<QueuedSlotRequest> = {}): QueuedSlotRequest {
  return { sessionKey, harnessId, sessionCap: 2, harnessCap: 2, ready: true, ...overrides };
}

function active(entries: Array<[string, string, number]>): ActiveCounts {
  const sessions = new Map<string, { active: number; byHarness: Map<string, number> }>();
  let total = 0;
  for (const [session, harness, count] of entries) {
    const counts = sessions.get(session) ?? { active: 0, byHarness: new Map() };
    counts.active += count;
    counts.byHarness.set(harness, (counts.byHarness.get(harness) ?? 0) + count);
    sessions.set(session, counts);
    total += count;
  }
  return { total, sessions };
}

describe("ConcurrencyLedger", () => {
  it("counts per session and harness and prunes empty entries", () => {
    const ledger = new ConcurrencyLedger();
    ledger.acquire("repo:a", "claude");
    ledger.acquire("repo:a", "claude");
    ledger.acquire("repo:a", "codex");
    ledger.acquire("repo:b", "claude");
    expect(ledger.total).toBe(4);
    expect(ledger.sessionActive("repo:a")).toBe(3);
    expect(ledger.harnessActive("repo:a", "claude")).toBe(2);
    expect(ledger.harnessActive("repo:b", "codex")).toBe(0);

    ledger.release("repo:b", "claude");
    expect(ledger.view().sessions.has("repo:b")).toBe(false);
    ledger.release("repo:a", "codex");
    expect([...ledger.view().sessions.get("repo:a")!.byHarness]).toEqual([["claude", 2]]);
    ledger.release("repo:a", "claude");
    ledger.release("repo:a", "claude");
    expect(ledger.total).toBe(0);
    expect(ledger.view().sessions.size).toBe(0);
  });

  it("ignores a release that never had a matching acquire", () => {
    const ledger = new ConcurrencyLedger();
    ledger.acquire("repo:a", "claude");
    ledger.release("repo:a", "codex");
    ledger.release("repo:zzz", "claude");
    expect(ledger.total).toBe(1);
    expect(ledger.sessionActive("repo:a")).toBe(1);
  });

  it("hands out a detached view", () => {
    const ledger = new ConcurrencyLedger();
    ledger.acquire("repo:a", "claude");
    const view = ledger.view();
    ledger.acquire("repo:a", "claude");
    expect(view.total).toBe(1);
    expect(view.sessions.get("repo:a")?.active).toBe(1);
  });
});

describe("planAdmissions", () => {
  it("starts everything that fits and reports an empty block map", () => {
    const plan = planAdmissions([request("a"), request("b")], NONE, 10);
    expect(plan.start).toEqual([0, 1]);
    expect(plan.blocked.size).toBe(0);
  });

  it("stops a session at its own cap without touching other sessions", () => {
    const queue = [request("a"), request("a"), request("a"), request("b")];
    const plan = planAdmissions(queue, NONE, 10);
    expect(plan.start).toEqual([0, 3, 1].sort((left, right) => plan.start.indexOf(left) - plan.start.indexOf(right)));
    expect(new Set(plan.start)).toEqual(new Set([0, 1, 3]));
    expect(plan.blocked.get(2)).toBe("session_cap");
  });

  it("stops a harness lane at its cap and blocks later jobs of that lane as fifo", () => {
    const queue = [request("a", "claude", { harnessCap: 1 }), request("a", "claude", { harnessCap: 1 }), request("a", "claude", { harnessCap: 1 })];
    const plan = planAdmissions(queue, NONE, 10);
    expect(plan.start).toEqual([0]);
    expect(plan.blocked.get(1)).toBe("harness_cap");
    expect(plan.blocked.get(2)).toBe("fifo");
  });

  it("lets another harness of the same session start while one lane is full", () => {
    const roomy = { sessionCap: 5, harnessCap: 1 };
    const queue = [request("a", "claude", roomy), request("a", "claude", roomy), request("a", "codex", { sessionCap: 5 })];
    const plan = planAdmissions(queue, active([["a", "claude", 1]]), 10);
    expect(plan.start).toEqual([2]);
    expect(plan.blocked.get(0)).toBe("harness_cap");
    expect(plan.blocked.get(1)).toBe("fifo");
  });

  it("counts jobs that already run toward the caps", () => {
    const plan = planAdmissions([request("a"), request("a")], active([["a", "claude", 1]]), 10);
    expect(plan.start).toEqual([0]);
    expect(plan.blocked.get(1)).toBe("session_cap");
  });

  it("blocks only the lane of a job that is still initializing", () => {
    const queue = [request("a", "claude", { ready: false }), request("a", "claude"), request("b", "claude"), request("a", "codex")];
    const plan = planAdmissions(queue, NONE, 10);
    expect(new Set(plan.start)).toEqual(new Set([2, 3]));
    expect(plan.blocked.get(0)).toBe("initializing");
    expect(plan.blocked.get(1)).toBe("fifo");
  });

  it("never exceeds the host cap and reports host_cap for what is left", () => {
    const queue = [request("a"), request("b"), request("c"), request("a")];
    const plan = planAdmissions(queue, active([["z", "claude", 1]]), 3);
    expect(plan.start).toHaveLength(2);
    const waiting = [0, 1, 2, 3].filter((index) => !plan.start.includes(index));
    for (const index of waiting) expect(plan.blocked.get(index)).toBe("host_cap");
  });

  it("starts nothing when the host is already full", () => {
    const plan = planAdmissions([request("a")], active([["z", "claude", 4]]), 4);
    expect(plan.start).toEqual([]);
    expect(plan.blocked.get(0)).toBe("host_cap");
  });

  it("serves the least-loaded session first so a busy repository cannot starve a quiet one", () => {
    // Session a already runs 1 and has two older jobs queued; session b is idle with one younger job. One host slot is free.
    const queue = [request("a"), request("a"), request("b")];
    const plan = planAdmissions(queue, active([["a", "claude", 1]]), 2);
    expect(plan.start).toEqual([2]);
    expect(plan.blocked.get(0)).toBe("host_cap");
  });

  it("alternates between sessions with equal load, older job first", () => {
    const queue = [request("a"), request("a"), request("b"), request("b")];
    const plan = planAdmissions(queue, NONE, 4);
    expect(plan.start).toEqual([0, 2, 1, 3]);
    const capped = planAdmissions(queue, NONE, 3);
    expect(capped.start).toEqual([0, 2, 1]);
    expect(capped.blocked.get(3)).toBe("host_cap");
  });
});

describe("resolveHarnessConcurrency host cap and scope", () => {
  const defaults = {
    max_concurrency: 8, default_harness_concurrency: 5, native_subagents: "cli_limit", native_subagent_depth: 2,
  } as const;
  const resolve = (overrides: Record<string, unknown>) => resolveHarnessConcurrency({
    harnessId: "claude", harness: {}, defaults: { ...defaults, ...overrides }, cliLimits: emptyCliLimits("claude"),
  });

  it("reports the configured host cap and scope", () => {
    expect(resolve({ host_max_concurrency: 40, concurrency_scope: "context" })).toMatchObject({ host_cap: 40, scope: "context", global_cap: 8 });
  });

  it("never lets the host cap fall below the per-session cap", () => {
    expect(resolve({ host_max_concurrency: 3 }).host_cap).toBe(8);
  });

  it("treats native_subagent_depth = 0 as policy off even when the CLI's own depth is not discovered", () => {
    for (const driver of ["claude", "codex", "opencode", "dsh"] as const) {
      const cliLimits = emptyCliLimits(driver);
      expect(cliLimits.max_depth).toBeUndefined();
      const info = resolveHarnessConcurrency({ harnessId: driver, harness: {}, defaults: { ...defaults, native_subagent_depth: 0 }, cliLimits });
      expect(info, driver).toMatchObject({ native_subagents: "disabled_by_policy", native_max_depth: 0 });
      expect(buildNativeSubagentsControl(info, cliLimits, "cli_limit"), driver).toMatchObject({ policy: "off", maxDepth: 0 });
    }
    // A non-zero depth keeps the CLI's own limit in charge.
    const normal = resolveHarnessConcurrency({ harnessId: "claude", harness: {}, defaults, cliLimits: emptyCliLimits("claude") });
    expect(buildNativeSubagentsControl(normal, emptyCliLimits("claude"), "cli_limit")).toMatchObject({ policy: "cli_limit" });
  });

  it("warns about depth 0 for a CLI that cannot be told to stay single-agent", () => {
    const info = resolveHarnessConcurrency({
      harnessId: "gemini", harness: {}, defaults: { ...defaults, native_subagent_depth: 0 }, cliLimits: emptyCliLimits("gemini"),
    });
    expect(info.warnings).toEqual([expect.stringContaining("native_subagent_depth = 0 is not enforced for gemini")]);
  });

  it("falls back to 24 and the repo scope for callers without the new keys", () => {
    expect(resolve({})).toMatchObject({ host_cap: 24, scope: "repo" });
  });
});
