import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findDescendantPidsByJobMarker, parsePsEnvironmentListing, sampleProcessGroupCpuMs, spawnDetached, terminateProcessTree } from "../../src/runtime/process-tree.js";

const IDLE_ARGS = ["-e", "setInterval(() => {}, 1_000)"];

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("terminateProcessTree", () => {
  const children: ReturnType<typeof spawnDetached>[] = [];

  function spawnIdle() {
    const child = spawnDetached(process.execPath, IDLE_ARGS, { cwd: process.cwd(), env: process.env });
    children.push(child);
    return child;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  it("ends a normal process group cleanly with SIGTERM", async () => {
    const child = spawnIdle();
    const pid = child.pid!;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    await expect(terminateProcessTree({ pid, jobId: randomUUID(), graceMs: 2_000 })).resolves.toEqual({ signalSent: "SIGTERM", terminated: true });
    await exited;
    expect(isRunning(pid)).toBe(false);
  });

  it("throws when the group is still alive after SIGKILL instead of reporting success", async () => {
    const child = spawnIdle();
    // Every signal is swallowed, so the group survives both SIGTERM and SIGKILL.
    vi.spyOn(process, "kill").mockImplementation(() => true);
    await expect(terminateProcessTree({ pid: child.pid!, jobId: randomUUID(), graceMs: 0 }))
      .rejects.toThrow(/still alive .*after SIGKILL/);
  }, 10_000);

  describe("on Windows", () => {
    const FAKE_TASKKILL_GRACE_MS = 150;

    /** A taskkill stand-in: ends the real child with the signal the test allows, and records every call. */
    function fakeTaskkill(pid: number, endsOn: "graceful" | "forced") {
      const calls: string[][] = [];
      const run = async (args: string[]) => {
        calls.push(args);
        const forced = args.includes("/F");
        if (endsOn === "forced" && !forced) return;
        process.kill(pid, forced ? "SIGKILL" : "SIGTERM");
      };
      return { calls, run };
    }

    function negativeKillCalls(kill: { mock: { calls: unknown[][] } }): unknown[][] {
      return kill.mock.calls.filter(([pid]) => (pid as number) < 0);
    }

    it("ends the tree with taskkill /T and never signals a negative process group", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const taskkill = fakeTaskkill(pid, "graceful");
      const kill = vi.spyOn(process, "kill");
      await expect(terminateProcessTree({
        pid, jobId: randomUUID(), graceMs: 2_000, platform: "win32", taskkill: taskkill.run,
      })).resolves.toEqual({ signalSent: "SIGTERM", terminated: true });
      await exited;
      expect(taskkill.calls).toEqual([["/PID", String(pid), "/T"]]);
      expect(negativeKillCalls(kill)).toEqual([]);
    });

    it("escalates to taskkill /T /F when the graceful stop leaves the process alive", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const taskkill = fakeTaskkill(pid, "forced");
      const kill = vi.spyOn(process, "kill");
      await expect(terminateProcessTree({
        pid, jobId: randomUUID(), graceMs: FAKE_TASKKILL_GRACE_MS, platform: "win32", taskkill: taskkill.run,
      })).resolves.toEqual({ signalSent: "SIGKILL", terminated: true });
      await exited;
      expect(taskkill.calls).toEqual([["/PID", String(pid), "/T"], ["/PID", String(pid), "/T", "/F"]]);
      expect(negativeKillCalls(kill)).toEqual([]);
    });

    it("falls back to signalling the process itself when taskkill is not installed", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const missing = Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" });
      const kill = vi.spyOn(process, "kill");
      await expect(terminateProcessTree({
        pid, jobId: randomUUID(), graceMs: 2_000, platform: "win32", taskkill: () => Promise.reject(missing),
      })).resolves.toMatchObject({
        signalSent: "SIGTERM", terminated: false, reason: expect.stringContaining("taskkill is not available"),
      });
      await exited;
      expect(kill).toHaveBeenCalledWith(pid, "SIGTERM");
      expect(negativeKillCalls(kill)).toEqual([]);
    });

    it("does not claim success when taskkill /T fails and only the parent PID disappeared", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const denied = Object.assign(new Error("taskkill: access denied"), { code: 1 });
      // The parent exits on its own while every tree kill fails: children may still be running.
      const failing = async () => {
        process.kill(pid, "SIGTERM");
        throw denied;
      };
      const result = await terminateProcessTree({ pid, jobId: randomUUID(), graceMs: 2_000, platform: "win32", taskkill: failing });
      await exited;
      expect(result).toMatchObject({ signalSent: "SIGTERM", terminated: false, reason: expect.stringContaining("access denied") });
    });

    it("throws, naming the taskkill failure, when the process survives a forced taskkill", async () => {
      const child = spawnIdle();
      const failure = Object.assign(new Error("taskkill: access denied"), { code: 1 });
      await expect(terminateProcessTree({
        pid: child.pid!, jobId: randomUUID(), graceMs: 0, platform: "win32", taskkill: () => Promise.reject(failure),
      })).rejects.toThrow(/still alive .*forced taskkill.*access denied/);
    }, 10_000);
  });

  describe.skipIf(process.platform !== "linux")("job markers", () => {
    function spawnMarked(env: Record<string, string>) {
      const child = spawnDetached(process.execPath, IDLE_ARGS, { cwd: process.cwd(), env: { ...process.env, ...env } });
      children.push(child);
      return child.pid!;
    }

    it("matches a process by ORCH_JOB_ID or by a whole token of ORCH_JOB_CHAIN, never by a substring", () => {
      const outer = `outer-${randomUUID()}`;
      const own = spawnMarked({ ORCH_JOB_ID: outer });
      const nested = spawnMarked({ ORCH_JOB_ID: "inner-a", ORCH_JOB_CHAIN: `${outer},inner-a` });
      const lookalike = spawnMarked({ ORCH_JOB_ID: "inner-b", ORCH_JOB_CHAIN: `${outer}-2,${outer}x,inner-b` });
      const unrelated = spawnMarked({ ORCH_JOB_ID: "inner-c", ORCH_JOB_CHAIN: "other,inner-c" });
      const found = findDescendantPidsByJobMarker(outer);
      expect(found).toEqual(expect.arrayContaining([own, nested]));
      expect(found).not.toContain(lookalike);
      expect(found).not.toContain(unrelated);
      expect(findDescendantPidsByJobMarker("inner-a")).toContain(nested);
    });

    it("reaps an escaped process of a nested orchestrator that only carries the outer job in its chain", async () => {
      const outer = `outer-${randomUUID()}`;
      const root = spawnIdle();
      const escaped = spawnMarked({ ORCH_JOB_ID: "nested-job", ORCH_JOB_CHAIN: `${outer},nested-job` });
      const escapedExit = new Promise((resolve) => children.at(-1)!.once("exit", resolve));
      await terminateProcessTree({ pid: root.pid!, jobId: outer, graceMs: 2_000 });
      await escapedExit;
      expect(isRunning(escaped)).toBe(false);
    });
  });
});

describe("parsePsEnvironmentListing (macOS `ps -eww -o pid=,command=` output)", () => {
  const job = "job-123";
  const listing = [
    `  501 /usr/bin/node -e setTimeout(()=>{},60000) HOME=/Users/me ORCH_JOB_ID=${job} PATH=/usr/bin:/bin`,
    "  502 /usr/bin/node worker.js HOME=/Users/me ORCH_JOB_ID=job-1234 PATH=/usr/bin",
    `  503 /bin/sh -c sleep 60 ORCH_JOB_ID=inner ORCH_JOB_CHAIN=outer,${job},inner`,
    `  504 /bin/sh -c sleep 60 ORCH_JOB_CHAIN=outer,${job}x,inner-${job}`,
    `  505 /usr/bin/grep XORCH_JOB_ID=${job}`,
    `  506 ORCH_JOB_ID=${job}`,
    `\t507 /usr/bin/true ORCH_JOB_ID=${job}`,
    "  not-a-pid ORCH_JOB_ID=job-123",
    "",
  ].join("\n");

  it("returns PIDs whose environment holds the job marker or lists the job in its chain, as whole tokens", () => {
    expect(parsePsEnvironmentListing(listing, job)).toEqual([501, 503, 506, 507]);
  });

  it("skips excluded PIDs and this process", () => {
    const withSelf = `${listing}\n  ${process.pid} node ORCH_JOB_ID=${job}`;
    expect(parsePsEnvironmentListing(withSelf, job, new Set([501, 506]))).toEqual([503, 507]);
  });

  it("returns nothing for empty output or an unknown job", () => {
    expect(parsePsEnvironmentListing("", job)).toEqual([]);
    expect(parsePsEnvironmentListing(listing, "other-job")).toEqual([]);
  });
});

describe.skipIf(process.platform !== "linux")("sampleProcessGroupCpuMs", () => {
  const BUSY_ARGS = ["-e", "for (;;) {}"];

  it("grows while a process of the group burns CPU and stays flat for an idle group", async () => {
    const busy = spawnDetached(process.execPath, BUSY_ARGS, { cwd: process.cwd(), env: process.env });
    const idle = spawnDetached(process.execPath, IDLE_ARGS, { cwd: process.cwd(), env: process.env });
    try {
      const [busyBefore, idleBefore] = [await sampleProcessGroupCpuMs(busy.pid!), await sampleProcessGroupCpuMs(idle.pid!)];
      await new Promise((resolve) => setTimeout(resolve, 600));
      const [busyAfter, idleAfter] = [await sampleProcessGroupCpuMs(busy.pid!), await sampleProcessGroupCpuMs(idle.pid!)];
      expect(busyAfter! - busyBefore!).toBeGreaterThanOrEqual(300);
      expect(idleAfter! - idleBefore!).toBeLessThan(300);
    } finally {
      for (const child of [busy, idle]) process.kill(-child.pid!, "SIGKILL");
    }
  });

  it("counts CPU of children the group member already waited for", async () => {
    const script = "require('node:child_process').execFileSync(process.execPath, ['-e', 'const end = Date.now() + 600; while (Date.now() < end) {}']);"
      + "console.log('reaped'); setInterval(() => {}, 1_000);";
    const parent = spawnDetached(process.execPath, ["-e", script], { cwd: process.cwd(), env: process.env });
    try {
      await new Promise<void>((resolve) => parent.stdout!.once("data", () => resolve()));
      // The busy child is gone; only the parent's cutime still remembers its CPU.
      expect(await sampleProcessGroupCpuMs(parent.pid!)).toBeGreaterThanOrEqual(400);
    } finally {
      process.kill(-parent.pid!, "SIGKILL");
    }
  });

  it("returns undefined for a group without members and for invalid ids", async () => {
    expect(await sampleProcessGroupCpuMs(0x3fffffff)).toBeUndefined();
    expect(await sampleProcessGroupCpuMs(1)).toBeUndefined();
    expect(await sampleProcessGroupCpuMs(Number.NaN)).toBeUndefined();
  });
});
