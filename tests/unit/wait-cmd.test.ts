import { watch, type FSWatcher } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWaitCommand, waitForJobsOnDisk, type WaitCliOptions } from "../../src/cli/wait-cmd.js";
import type { JobStatus } from "../../src/types.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: vi.fn((path: string, listener: (event: string, filename: string | null) => void) => {
      const watcher = actual.watch(path, listener);
      vi.spyOn(watcher, "close");
      return watcher;
    }),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe("agrmcp wait", () => {
  let stateDir: string;
  let controller: AbortController;
  let activeWait: ReturnType<typeof waitForJobsOnDisk> | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    stateDir = await mkdtemp(join(tmpdir(), "orch-wait-"));
    controller = new AbortController();
    activeWait = undefined;
  });

  afterEach(async () => {
    try {
      controller.abort();
      await activeWait;
      for (const watcher of openedWatchers()) expect(watcher.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  function jobDir(id: string): string {
    return join(stateDir, "runs", id);
  }

  async function persist(id: string, status: JobStatus): Promise<void> {
    const dir = jobDir(id);
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, "meta.json.tmp");
    await writeFile(temporary, JSON.stringify({
      job_id: id,
      status,
      harness: "mock-harness",
      model: "mock-model",
      subtask_id: "check",
      plan_id: "plan",
      result: status === "completed" ? { exit_code: 0 } : undefined,
      error: status === "failed" ? { code: "NON_ZERO_EXIT" } : undefined,
    }));
    await rename(temporary, join(dir, "meta.json"));
  }

  function startWait(jobIds: string[], options: Partial<WaitCliOptions> = {}) {
    activeWait = waitForJobsOnDisk({ jobIds, stateDir, signal: controller.signal, timeoutSec: 2, ...options });
    return activeWait;
  }

  function openedWatchers(path?: string): FSWatcher[] {
    const { calls, results } = vi.mocked(watch).mock;
    return results.flatMap((result, index) => result.type === "return" && (path === undefined || calls[index]?.[0] === path)
      ? [result.value] : []);
  }

  async function waitForWatcher(path: string): Promise<void> {
    await vi.waitFor(() => expect(openedWatchers(path)).not.toHaveLength(0), { interval: 5 });
  }

  async function waitForRead(id: string, status: JobStatus | "pending", times = 1): Promise<void> {
    const path = join(jobDir(id), "meta.json");
    await vi.waitFor(async () => {
      const { calls, results } = vi.mocked(readFile).mock;
      let matches = 0;
      for (const [index, [filename]] of calls.entries()) {
        const observation = results[index];
        if (filename !== path || observation?.type !== "return") continue;
        const text = await observation.value.catch(() => undefined);
        const observed = text ? JSON.parse(text.toString()).status : "pending";
        if (observed === status && ++matches === times) return;
      }
      throw new Error(`Did not observe ${id} in ${status} state.`);
    }, { interval: 5 });
  }

  it("returns a terminal disk snapshot without opening watchers or settling", async () => {
    await persist("done", "completed");
    const result = await startWait(["done", "missing"]);

    expect(result).toMatchObject({
      wake_reason: "terminal",
      until: "any",
      pending_count: 1,
      jobs: [
        { job_id: "done", status: "completed", harness: "mock-harness", model: "mock-model", subtask_id: "check", plan_id: "plan", exit_code: 0 },
        { job_id: "missing", status: "pending" },
      ],
    });
    expect(result.held_ms).toBeLessThan(500);
    expect(watch).not.toHaveBeenCalled();
  });

  it("skips the settle window when all jobs are already terminal", async () => {
    await Promise.all([persist("done", "completed"), persist("failed", "failed")]);
    const result = await startWait(["done", "failed", "done"], { settleMs: 10_000 });

    expect(result).toMatchObject({
      wake_reason: "all_terminal",
      pending_count: 0,
      jobs: [{ job_id: "done", status: "completed" }, { job_id: "failed", status: "failed", error_code: "NON_ZERO_EXIT" }],
    });
    expect(result.held_ms).toBeLessThan(500);
    expect(watch).not.toHaveBeenCalled();
  });

  it.each(["existing job directory", "late-created job directory"])("wakes within 500 ms via fs.watch for an %s", async (scenario) => {
    const existing = scenario === "existing job directory";
    if (existing) await persist("job", "running");
    const result = startWait(["job"], { settleMs: 0, timeoutSec: 6 });
    await waitForWatcher(existing ? jobDir("job") : stateDir);
    await waitForRead("job", existing ? "running" : "pending", 2);

    const start = performance.now();
    await persist("job", "completed");
    expect(await result).toMatchObject({ wake_reason: "all_terminal", jobs: [{ job_id: "job", status: "completed" }] });
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("coalesces close completions in any mode while another job remains pending", async () => {
    await Promise.all([persist("first", "running"), persist("second", "running"), persist("third", "queued")]);
    const result = startWait(["first", "second", "third"], { settleMs: 400 });
    await waitForWatcher(jobDir("first"));

    await persist("first", "completed");
    await waitForRead("first", "completed");
    await persist("second", "failed");
    expect(await result).toMatchObject({
      wake_reason: "terminal",
      pending_count: 1,
      jobs: [{ status: "completed" }, { status: "failed" }, { status: "queued" }],
    });
  });

  it("keeps waiting after the first completion in all mode", async () => {
    await Promise.all([persist("first", "running"), persist("second", "running")]);
    const result = startWait(["first", "second"], { until: "all", settleMs: 0 });
    await waitForWatcher(jobDir("first"));

    await persist("first", "completed");
    await waitForRead("first", "completed");
    await persist("second", "cancelled");
    expect(await result).toMatchObject({
      wake_reason: "all_terminal",
      until: "all",
      pending_count: 0,
      jobs: [{ status: "completed" }, { status: "cancelled" }],
    });
  });

  it("ignores log writes inside a watched job directory and still wakes on meta.json", async () => {
    await persist("job", "running");
    const result = startWait(["job"], { settleMs: 0, timeoutSec: 6 });
    await waitForWatcher(jobDir("job"));
    await waitForRead("job", "running", 2);
    const metaReads = () => vi.mocked(readFile).mock.calls.filter(([file]) => file === join(jobDir("job"), "meta.json")).length;
    const before = metaReads();

    for (let write = 0; write < 10; write++) {
      await appendFile(join(jobDir("job"), "stdout.log"), "noisy worker output\n");
      await delay(20);
    }
    expect(metaReads()).toBe(before);

    await persist("job", "completed");
    expect(await result).toMatchObject({ wake_reason: "all_terminal", jobs: [{ job_id: "job", status: "completed" }] });
  });

  it("does not re-read an unchanged meta.json when a watcher event replays (macOS FSEvents)", async () => {
    await persist("job", "running");
    const result = startWait(["job"], { settleMs: 0, timeoutSec: 6 });
    await waitForWatcher(jobDir("job"));
    await waitForRead("job", "running", 2);
    const metaReads = () => vi.mocked(readFile).mock.calls.filter(([file]) => file === join(jobDir("job"), "meta.json")).length;
    const before = metaReads();

    // A leftover `meta.json.<id>.tmp` name passes the event filter, like a replayed event for meta.json itself.
    await writeFile(join(jobDir("job"), "meta.json.replayed.tmp"), "");
    await delay(150);
    expect(metaReads()).toBe(before);

    await persist("job", "completed");
    expect(await result).toMatchObject({ wake_reason: "all_terminal", jobs: [{ job_id: "job", status: "completed" }] });
  });

  it("keeps a terminal snapshot when a later read of its meta.json fails", async () => {
    await Promise.all([persist("done", "completed"), persist("late", "running")]);
    const result = startWait(["done", "late"], { until: "all", settleMs: 0, timeoutSec: 6 });
    await waitForWatcher(jobDir("done"));
    await waitForRead("late", "running", 2);

    await rm(join(jobDir("done"), "meta.json"));
    await waitForRead("done", "pending");
    await persist("late", "failed");
    expect(await result).toMatchObject({
      wake_reason: "all_terminal", pending_count: 0, jobs: [{ job_id: "done", status: "completed" }, { job_id: "late", status: "failed" }],
    });
  });

  it("returns a timeout and closes every watcher", async () => {
    await persist("job", "running");
    const result = startWait(["job"], { timeoutSec: 1 });
    await waitForWatcher(jobDir("job"));

    expect(await result).toMatchObject({ wake_reason: "timeout", pending_count: 1, jobs: [{ status: "running" }] });
    expect(openedWatchers(jobDir("job"))[0].close).toHaveBeenCalledTimes(1);
  });

  it("responds to abort and closes every watcher", async () => {
    await persist("job", "running");
    const result = startWait(["job", "missing"]);
    await waitForWatcher(jobDir("job"));
    await waitForWatcher(join(stateDir, "runs"));

    controller.abort();
    expect(await result).toMatchObject({ wake_reason: "cancelled", pending_count: 2 });
    expect(openedWatchers()).toHaveLength(2);
    for (const watcher of openedWatchers()) expect(watcher.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { args: [], error: "Specify at least one job ID." },
    { args: ["--job="], error: "Invalid job ID" },
    { args: ["--job", "../outside"], error: "Invalid job ID" },
    { args: ["--job", "path/to/job"], error: "Invalid job ID" },
    { args: ["job", "--timeout", "2.5"], error: "--timeout must be an integer" },
    { args: ["job", "--timeout", "0"], error: "--timeout must be an integer" },
    { args: ["job", "--timeout", "7201"], error: "--timeout must be an integer between 1 and 7200." },
    { args: ["job", "--until", "first"], error: "--until must be any or all." },
  ])("rejects invalid arguments $args before opening watchers", async ({ args, error }) => {
    await expect(runWaitCommand(args)).rejects.toThrow(error);
    expect(watch).not.toHaveBeenCalled();
  });

  it("accepts the 7200-second timeout without waiting for already finished jobs", async () => {
    await persist("done", "completed");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runWaitCommand(["done", "--timeout", "7200", "--state-dir", stateDir])).toBe(0);
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ wake_reason: "all_terminal", pending_count: 0 });
    expect(watch).not.toHaveBeenCalled();
  });

  it("documents the 1800-second timeout default in the usage text", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runWaitCommand(["--help"])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringMatching(/Defaults:.*--timeout 1800\b/));
  });

  it("documents the distinct exit codes in the usage text", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runWaitCommand(["-h"]);
    const usage = String(stdout.mock.calls[0][0]);
    expect(usage).toMatch(/0\s+a job finished/);
    expect(usage).toMatch(/2\s+--timeout elapsed/);
    expect(usage).toMatch(/130\s+interrupted by SIGINT or SIGTERM/);
  });

  describe("exit codes", () => {
    it("returns 0 when a job reached a terminal state (any and all)", async () => {
      await persist("a", "completed");
      await persist("b", "failed");
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runWaitCommand(["a", "--state-dir", stateDir])).toBe(0);
      expect(await runWaitCommand(["a", "b", "--until", "all", "--state-dir", stateDir])).toBe(0);
    });

    it("returns 2 when the timeout elapses with jobs still pending, so `wait && next` does not continue", async () => {
      await persist("slow", "running");
      const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
      expect(await runWaitCommand(["slow", "--timeout", "1", "--settle-ms", "0", "--state-dir", stateDir])).toBe(2);
      expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ wake_reason: "timeout", pending_count: 1 });
    });

    it.each(["SIGINT", "SIGTERM"] as const)("returns 130 after %s and still prints the result", async (signal) => {
      await persist("slow", "running");
      const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const subscribe = vi.spyOn(process, "on");
      const finished = runWaitCommand(["slow", "--state-dir", stateDir]);
      await vi.waitFor(() => expect(subscribe.mock.calls.some(([name]) => name === signal)).toBe(true));
      const handler = subscribe.mock.calls.find(([name]) => name === signal)?.[1] as () => void;
      handler();
      expect(await finished).toBe(130);
      expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({ wake_reason: "cancelled" });
    });
  });

  it("emits JSON and keeps job order across positional, repeated and comma-separated arguments", async () => {
    await Promise.all(["first", "second", "third", "fourth"].map((id) => persist(id, "completed")));
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runWaitCommand(["first", "--job", "second,third", "--job", "fourth,first", "--state-dir", stateDir]);

    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls[0][0])).toMatchObject({
      wake_reason: "all_terminal",
      jobs: ["first", "second", "third", "fourth"].map((id) => ({ job_id: id, status: "completed" })),
    });
  });
});
