import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findDescendantPidsByJobMarker, findWindowsDescendants, parsePsEnvironmentListing, parseWindowsProcessListing, resolveWindowsSystemBinary,
  sampleProcessGroupCpuMs, spawnDetached, terminateProcessTree,
} from "../../src/runtime/process-tree.js";

const IDLE_ARGS = ["-e", "setInterval(() => {}, 1_000)"];

/** A real process table always lists at least one process; an empty snapshot is unusable, not "no survivors". */
const unrelatedProcessTable = (): string => `4,0,${String((BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n)}`;

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
        spawnedAt: Date.now(), listWindowsProcesses: async () => unrelatedProcessTable(),
      })).resolves.toEqual({ signalSent: "SIGTERM", terminated: true });
      await exited;
      expect(taskkill.calls).toEqual([["/PID", String(pid), "/T"]]);
      expect(negativeKillCalls(kill)).toEqual([]);
    });

    it("does not trust a graceful taskkill /T that exited 0: a descendant that outlived the root keeps the result unconfirmed", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const taskkill = fakeTaskkill(pid, "graceful");
      const spawnedAt = Date.now();
      const filetime = String((BigInt(spawnedAt) + 11_644_473_600_000n) * 10_000n);
      const result = await terminateProcessTree({
        pid, jobId: randomUUID(), graceMs: 2_000, platform: "win32", taskkill: async (args) => {
          // The graceful stop ends the root; a console child that ignores the close request lives on.
          if (args.includes("/F")) return;
          await taskkill.run(args);
        },
        spawnedAt, listWindowsProcesses: async () => `9001,${pid},${filetime}`,
      });
      await exited;
      expect(result).toMatchObject({ signalSent: "SIGTERM", terminated: false, reason: expect.stringContaining("9001") });
    });

    it("escalates to taskkill /T /F when the graceful stop leaves the process alive", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const taskkill = fakeTaskkill(pid, "forced");
      const kill = vi.spyOn(process, "kill");
      await expect(terminateProcessTree({
        pid, jobId: randomUUID(), graceMs: FAKE_TASKKILL_GRACE_MS, platform: "win32", taskkill: taskkill.run, verifyDescendants: false,
      })).resolves.toEqual({ signalSent: "SIGKILL", terminated: true });
      await exited;
      expect(taskkill.calls).toEqual([["/PID", String(pid), "/T"], ["/PID", String(pid), "/T", "/F"]]);
      expect(negativeKillCalls(kill)).toEqual([]);
    });

    it("verifies the descendants after a forced /T /F too, and reports an unreadable process table as not terminated", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const taskkill = fakeTaskkill(pid, "forced");
      const result = await terminateProcessTree({
        pid, jobId: randomUUID(), graceMs: 0, platform: "win32", taskkill: taskkill.run, spawnedAt: Date.now(),
        listWindowsProcesses: async () => undefined,
      });
      await exited;
      expect(result).toMatchObject({ signalSent: "SIGKILL", terminated: false, reason: expect.stringContaining("process table could not be read") });
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
        await exited;
        throw denied;
      };
      const result = await terminateProcessTree({ pid, jobId: randomUUID(), graceMs: 2_000, platform: "win32", taskkill: failing });
      expect(result).toMatchObject({ signalSent: "SIGTERM", terminated: false, reason: expect.stringContaining("access denied") });
    });

    it("escalates to /T /F at once, without waiting the grace period, when the graceful taskkill is refused", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const calls: string[][] = [];
      // A headless console program: `taskkill /T` without /F fails immediately (exit code 1).
      const refusing = async (args: string[]) => {
        calls.push(args);
        if (!args.includes("/F")) throw Object.assign(new Error("taskkill: terminate only forcefully"), { code: 1 });
        process.kill(pid, "SIGKILL");
      };
      const started = performance.now();
      await expect(terminateProcessTree({ pid, jobId: randomUUID(), graceMs: 30_000, platform: "win32", taskkill: refusing, verifyDescendants: false }))
        .resolves.toEqual({ signalSent: "SIGKILL", terminated: true });
      await exited;
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(calls).toEqual([["/PID", String(pid), "/T"], ["/PID", String(pid), "/T", "/F"]]);
    });

    it("goes straight to taskkill /T /F when the grace period is zero", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const taskkill = fakeTaskkill(pid, "forced");
      await expect(terminateProcessTree({ pid, jobId: randomUUID(), graceMs: 0, platform: "win32", taskkill: taskkill.run, verifyDescendants: false }))
        .resolves.toEqual({ signalSent: "SIGKILL", terminated: true });
      await exited;
      expect(taskkill.calls).toEqual([["/PID", String(pid), "/T", "/F"]]);
    });

    it("treats exit code 128 (root not found) as an already-gone root and verifies the descendants instead of failing", async () => {
      const child = spawnIdle();
      const pid = child.pid!;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const notFound = async () => {
        process.kill(pid, "SIGKILL");
        await exited;
        throw Object.assign(new Error("ERROR: The process was not found."), { code: 128 });
      };
      const list = vi.fn(async () => unrelatedProcessTable());
      await expect(terminateProcessTree({
        pid, jobId: randomUUID(), graceMs: 0, platform: "win32", taskkill: notFound, spawnedAt: Date.now(), listWindowsProcesses: list,
      })).resolves.toMatchObject({ terminated: true });
      expect(list).toHaveBeenCalledOnce();
    });

    describe("a root that already exited (a job that finished normally)", () => {
      /** A PID that belonged to a child which has exited and been reaped. */
      async function deadPid(): Promise<number> {
        const child = spawnIdle();
        const exited = new Promise((resolve) => child.once("exit", resolve));
        process.kill(child.pid!, "SIGKILL");
        await exited;
        return child.pid!;
      }

      const FILETIME_NOW = (ms: number) => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);
      const listing = (pid: number, rows: Array<[number, number]>, createdMs: number) =>
        rows.map(([child, parent]) => `${child},${parent},${FILETIME_NOW(createdMs)}`).concat(`${pid + 100000},4,${FILETIME_NOW(createdMs)}`).join("\n");

      it("is terminated: true without running taskkill when no descendant survives", async () => {
        const pid = await deadPid();
        const taskkill = vi.fn(async () => undefined);
        const spawnedAt = Date.now();
        const list = vi.fn(async () => listing(pid, [], spawnedAt));
        await expect(terminateProcessTree({
          pid, jobId: randomUUID(), graceMs: 5_000, platform: "win32", taskkill, spawnedAt, listWindowsProcesses: list,
        })).resolves.toEqual({ signalSent: "SIGTERM", terminated: true });
        expect(taskkill).not.toHaveBeenCalled();
        expect(list).toHaveBeenCalledOnce();
      });

      it("ends surviving descendants with one taskkill /F /T call, re-checks, and then reports success", async () => {
        const pid = await deadPid();
        const spawnedAt = Date.now();
        const taskkill = vi.fn(async () => undefined);
        const snapshots = [listing(pid, [[9001, pid], [9002, 9001]], spawnedAt), listing(pid, [], spawnedAt)];
        const list = vi.fn(async () => snapshots.shift());
        await expect(terminateProcessTree({
          pid, jobId: randomUUID(), platform: "win32", taskkill, spawnedAt, listWindowsProcesses: list,
        })).resolves.toEqual({ signalSent: "SIGTERM", terminated: true });
        expect(taskkill).toHaveBeenCalledExactlyOnceWith(["/F", "/T", "/PID", "9001", "/PID", "9002"]);
        expect(list).toHaveBeenCalledTimes(2);
      });

      it("stays fail-closed, naming the survivors, when a descendant outlives taskkill", async () => {
        const pid = await deadPid();
        const spawnedAt = Date.now();
        const stubborn = vi.fn(async () => listing(pid, [[9001, pid]], spawnedAt));
        const result = await terminateProcessTree({
          pid, jobId: randomUUID(), platform: "win32", taskkill: async () => { throw Object.assign(new Error("denied"), { code: 5 }); },
          spawnedAt, listWindowsProcesses: stubborn,
        });
        expect(result).toMatchObject({ terminated: false, reason: expect.stringContaining("9001") });
      });

      it("stays fail-closed when the process table cannot be read", async () => {
        const pid = await deadPid();
        const result = await terminateProcessTree({
          pid, jobId: randomUUID(), platform: "win32", taskkill: vi.fn(), spawnedAt: Date.now(), listWindowsProcesses: async () => undefined,
        });
        expect(result).toMatchObject({ terminated: false, reason: expect.stringContaining("process table could not be read") });
      });

      it("stays fail-closed when the spawn time is unknown, because PID reuse could not be excluded", async () => {
        const pid = await deadPid();
        const list = vi.fn(async () => "");
        const result = await terminateProcessTree({ pid, jobId: randomUUID(), platform: "win32", taskkill: vi.fn(), listWindowsProcesses: list });
        expect(result).toMatchObject({ terminated: false });
        expect(list).not.toHaveBeenCalled();
      });

      it("reports success without any process-table query when verifyDescendants is false (probes)", async () => {
        const pid = await deadPid();
        const taskkill = vi.fn();
        const list = vi.fn(async () => "");
        await expect(terminateProcessTree({
          pid, jobId: randomUUID(), platform: "win32", taskkill, listWindowsProcesses: list, verifyDescendants: false,
        })).resolves.toEqual({ signalSent: "SIGTERM", terminated: true });
        expect(taskkill).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
      });
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


describe("parseWindowsProcessListing (PowerShell `pid,parentPid,FILETIME` output)", () => {
  const ROOT = 4000;
  const SPAWNED_AT = Date.parse("2026-06-15T12:00:00Z");
  const fileTime = (ms: number) => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);
  const row = (pid: number, parent: number, createdMs = SPAWNED_AT + 500) => `${pid},${parent},${fileTime(createdMs)}`;

  it("walks parent-PID chains from the root, including orphans that kept the dead root as their parent", () => {
    const output = [
      row(4100, ROOT), row(4200, 4100), row(4300, 4200), // child -> grandchild -> great-grandchild
      row(4400, ROOT), // second child
      row(5000, 1), row(5100, 5000), // unrelated tree
    ].join("\r\n");
    expect(parseWindowsProcessListing(output, ROOT, SPAWNED_AT).sort()).toEqual([4100, 4200, 4300, 4400]);
  });

  it("ignores processes created before the spawn (a reused PID's old children), with 50 ms of clock tolerance", () => {
    const output = [
      row(4100, ROOT, SPAWNED_AT - 50), // exactly at the tolerance: kept
      row(4200, ROOT, SPAWNED_AT - 51), // older than the process we spawned: another process's child
      row(4300, 4200, SPAWNED_AT + 10),
    ].join("\n");
    expect(parseWindowsProcessListing(output, ROOT, SPAWNED_AT)).toEqual([4100]);
  });

  it("never returns the root itself or this process, tolerates malformed lines and cycles", () => {
    const output = [
      row(process.pid, ROOT), row(4100, ROOT), row(4100, 4100), row(4200, 4100), row(4100, 4200),
      "", "not,a,row", "1,2", `7,8,notaticket`,
    ].join("\n");
    expect(parseWindowsProcessListing(output, ROOT, SPAWNED_AT).sort()).toEqual([4100, 4200]);
  });

  it("does not adopt the children of an unrelated live process that reused the root's PID, but keeps the real root's older orphans", () => {
    const output = [
      row(ROOT, 4, SPAWNED_AT + 60_000), // The root exited; a stranger now holds its PID.
      row(7000, ROOT, SPAWNED_AT + 61_000), // The stranger's own child.
      row(7100, 7000, SPAWNED_AT + 62_000), // And its grandchild.
      row(4100, ROOT, SPAWNED_AT + 1_000), // Created before the stranger: an orphan of the real root.
      row(4200, 4100, SPAWNED_AT + 2_000),
    ].join("\n");
    expect(parseWindowsProcessListing(output, ROOT, SPAWNED_AT).sort()).toEqual([4100, 4200]);
  });

  it("does not adopt a child that is older than the live process now holding its parent PID (a stale parent link)", () => {
    const output = [
      row(4100, ROOT, SPAWNED_AT + 1_000),
      row(4200, 4100, SPAWNED_AT + 2_000), // Created after its parent: genuine.
      row(4300, 4100, SPAWNED_AT + 500), // Older than the process that holds PID 4100 now: its parent was someone else.
    ].join("\n");
    expect(parseWindowsProcessListing(output, ROOT, SPAWNED_AT).sort()).toEqual([4100, 4200]);
  });

  it("returns nothing for an empty table", () => {
    expect(parseWindowsProcessListing("", ROOT, SPAWNED_AT)).toEqual([]);
  });

  it("findWindowsDescendants parses the injected listing and reports undefined when it is unavailable or throws", async () => {
    expect(await findWindowsDescendants(ROOT, SPAWNED_AT, async () => row(4100, ROOT))).toEqual([4100]);
    expect(await findWindowsDescendants(ROOT, SPAWNED_AT, async () => undefined)).toBeUndefined();
    expect(await findWindowsDescendants(ROOT, SPAWNED_AT, async () => { throw new Error("powershell missing"); })).toBeUndefined();
  });
});

describe("resolveWindowsSystemBinary", () => {
  const exists = (...present: string[]) => (path: string) => present.includes(path);

  it("builds the path under %SystemRoot%\\System32, matching the variable name case-insensitively and falling back to %windir%", () => {
    const taskkill = "C:\\Windows\\System32\\taskkill.exe";
    expect(resolveWindowsSystemBinary(["taskkill.exe"], { SystemRoot: "C:\\Windows" }, exists(taskkill))).toBe(taskkill);
    expect(resolveWindowsSystemBinary(["taskkill.exe"], { SYSTEMROOT: "C:\\Windows" }, exists(taskkill))).toBe(taskkill);
    expect(resolveWindowsSystemBinary(["taskkill.exe"], { windir: "C:\\Windows" }, exists(taskkill))).toBe(taskkill);
    expect(resolveWindowsSystemBinary(["WindowsPowerShell", "v1.0", "powershell.exe"], { SystemRoot: "D:/Win" },
      exists("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"))).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("returns undefined for a relative or missing Windows directory, or a file that does not exist; it never uses PATH", () => {
    expect(resolveWindowsSystemBinary(["taskkill.exe"], { SystemRoot: "Windows" }, () => true)).toBeUndefined();
    expect(resolveWindowsSystemBinary(["taskkill.exe"], { SystemRoot: "\\Windows" }, () => true)).toBeUndefined();
    expect(resolveWindowsSystemBinary(["taskkill.exe"], { PATH: "C:\\Windows\\System32" }, () => true)).toBeUndefined();
    expect(resolveWindowsSystemBinary(["taskkill.exe"], { SystemRoot: "C:\\Windows" }, () => false)).toBeUndefined();
  });
});
