import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifiedFailure } from "../../src/adapters/probe-utils.js";
import type { BuildInvocationInput, CliAdapter } from "../../src/adapters/types.js";
import { ConfigManager } from "../../src/config/resolver.js";
import { OrchestratorRunner, type RunJobRequest } from "../../src/runtime/runner.js";
import type { ProgressCheckpoint } from "../../src/types.js";

const IDLE_SCRIPT = "setInterval(() => {}, 1_000)";
const OK_SCRIPT = 'console.log(JSON.stringify("done"))';
const SECRET = "sk-progress-secret-0123456789";
const CHECKPOINT: ProgressCheckpoint = {
  partial_text: `Drafted the parser. Using key ${SECRET} for the API.`,
  tool_trail: [
    { tool: "Read", target: "src/a.ts", status: "ok" },
    { tool: "Edit", target: "src/a.ts", status: "ok" },
    { tool: "Bash", target: "npm test", status: "started" },
  ],
  turns: 3,
};
const ITEM = {
  id: "one", title: "Build it", task_type: "implementation", harness: "claude", model: "claude-sonnet-5-5", effort: "low",
  mode: "readonly", isolation: "shared",
} as const;

describe("progress-preserving retries", () => {
  let root: string;
  let runner: OrchestratorRunner;
  let invocations: BuildInvocationInput[];
  let checkpoint: ProgressCheckpoint | undefined;
  let failWith: string | undefined;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orch-progress-")));
    invocations = [];
    checkpoint = CHECKPOINT;
    failWith = undefined;
    const configPath = join(root, "override.toml");
    await writeFile(configPath, "[defaults]\nallow_unsandboxed_write = true\nmax_timeout_sec = 4\n");
    const adapter: CliAdapter = {
      driver: "claude",
      securityGuarantees: { readonly: "tool_allowlist", write: "unsandboxed" },
      mapEffort: (effort) => effort,
      async probe() { throw new Error("No live probe expected"); },
      async buildInvocation(input) {
        invocations.push(input);
        return { command: process.execPath, args: ["-e", input.prompt.startsWith("Continue the task") ? OK_SCRIPT : input.prompt], stdin: "", nativeEffort: input.effort, tempFiles: [], warnings: [] };
      },
      createStreamParser() {
        const lines: string[] = [];
        return {
          pushLine(line) { if (line) lines.push(JSON.parse(line) as string); },
          finish(input) {
            if (input.exitCode) return classifiedFailure("Mock", input, failWith, "NON_ZERO_EXIT");
            return { ok: true, summary: lines.join("\n") };
          },
          checkpoint: () => checkpoint ?? { tool_trail: [], turns: 0 },
        };
      },
    };
    runner = new OrchestratorRunner({
      configManager: new ConfigManager({ userPath: configPath }),
      adapterRegistry: {
        get: () => adapter,
        async probeHarness() { throw new Error("No live probe expected"); },
      },
      runsDir: join(root, "runs"),
      worktreesDir: join(root, "worktrees"),
      locksDir: join(root, "locks"),
      allowedCwdRoots: [root],
      env: { MOCK_API_KEY: SECRET },
      terminateGraceMs: 80,
      cliLimits: { home: join(root, "home"), cacheTtlMs: 0 },
    });
  });

  afterEach(async () => {
    try {
      await runner.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const base = (): RunJobRequest => ({ cwd: root, prompt: OK_SCRIPT, model: "claude-sonnet", mode: "readonly" });

  async function createRepo(): Promise<string> {
    const cwd = join(root, "repo");
    await mkdir(cwd);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore" });
    git("init", "-q");
    await writeFile(join(cwd, "tracked.txt"), "one\n");
    await writeFile(join(cwd, "dirty.txt"), "clean\n");
    git("add", ".");
    git("commit", "-qm", "Initial");
    return cwd;
  }

  it("saves a redacted checkpoint on timeout and returns a ready resume call", async () => {
    const job = await runner.run({ ...base(), prompt: IDLE_SCRIPT, timeout_sec: 1 });
    expect(job).toMatchObject({
      status: "timed_out",
      progress: { has_partial_progress: true, tool_calls: 3, turns: 3, checkpoint_saved: true },
      error: {
        code: "TIMEOUT", has_partial_progress: true,
        resume: { tool: "orch_run", args: { continue_from_job_id: job.job_id, timeout_sec: 2 } },
      },
    });
    const saved = await runner.readLogs(job.job_id, "checkpoint");
    expect(saved.text).not.toContain(SECRET);
    expect(JSON.parse(saved.text)).toMatchObject({ tool_trail: CHECKPOINT.tool_trail, turns: 3 });
    expect((await stat(join(job.log_path, "checkpoint.json"))).mode & 0o777).toBe(0o600);
  });

  it("flags an empty timeout and suggests no larger timeout_sec when no larger limit is allowed", async () => {
    checkpoint = undefined;
    const job = await runner.run({ ...base(), prompt: IDLE_SCRIPT, timeout_sec: 4 });
    expect(job.error).toMatchObject({ code: "TIMEOUT", has_partial_progress: false, resume: { args: { continue_from_job_id: job.job_id } } });
    expect(job.error).not.toHaveProperty("suggested_timeout_sec");
    // The continuation keeps the caller's own 4s budget rather than raising or resetting it.
    expect(job.error?.resume?.args).toEqual({ continue_from_job_id: job.job_id, timeout_sec: 4 });
  }, 10_000);

  it("keeps no checkpoint for a plain completed job but records one for a completed job with tools", async () => {
    checkpoint = undefined;
    expect((await runner.run(base())).progress).toBeUndefined();
    checkpoint = CHECKPOINT;
    const job = await runner.run(base());
    expect(job).toMatchObject({ status: "completed", progress: { tool_calls: 3, checkpoint_saved: true } });
  });

  it("auto-continues a timed-out plan subtask with its progress and honors fresh", async () => {
    runner.savePlan({ plan_id: "plan-a", cwd: root, items: [{ ...ITEM }] });
    const retry = { plan_id: "plan-a", subtask_id: "one", prompt: IDLE_SCRIPT, timeout_sec: 1 };
    const first = await runner.run(retry);
    expect(first.status).toBe("timed_out");
    const second = await runner.run({ plan_id: "plan-a", subtask_id: "one", prompt: OK_SCRIPT });
    expect(second).toMatchObject({ status: "completed", continued_from: first.job_id });
    expect(second.warnings.join("\n")).toContain("fresh: true");
    const context = invocations[1].systemContext ?? "";
    expect(context).toContain("Progress before stop");
    expect(context).toContain("Edit src/a.ts");
    expect(context).toContain("Drafted the parser");
    expect(context).toContain("do not redo already completed steps");
    expect(context).not.toContain(SECRET);
    expect(context).toContain(`Goal: ${IDLE_SCRIPT}`);

    const third = await runner.run({ plan_id: "plan-a", subtask_id: "one", prompt: OK_SCRIPT });
    expect(third.continued_from).toBeUndefined(); // The latest finished job completed, nothing to resume.

    const timedOut = await runner.run(retry);
    expect(timedOut.status).toBe("timed_out");
    const fresh = await runner.run({ plan_id: "plan-a", subtask_id: "one", prompt: OK_SCRIPT, fresh: true });
    expect(fresh.continued_from).toBeUndefined();
  }, 15_000);

  it("refuses a second retry while an earlier continuation of the same job is still active, unless it starts fresh", async () => {
    runner.savePlan({ plan_id: "plan-g", cwd: root, items: [{ ...ITEM }] });
    const timedOut = await runner.run({ plan_id: "plan-g", subtask_id: "one", prompt: IDLE_SCRIPT, timeout_sec: 1 });
    expect(timedOut.status).toBe("timed_out");
    const active = await runner.run({ plan_id: "plan-g", subtask_id: "one", prompt: IDLE_SCRIPT, async: true });
    expect(active.continued_from).toBe(timedOut.job_id);
    await expect(runner.run({ plan_id: "plan-g", subtask_id: "one", prompt: OK_SCRIPT }))
      .rejects.toMatchObject({ code: "CONCURRENCY_LIMIT", retryable: true });
    const parallel = await runner.run({ plan_id: "plan-g", subtask_id: "one", prompt: OK_SCRIPT, fresh: true });
    expect(parallel).toMatchObject({ status: "completed" });
    expect(parallel.continued_from).toBeUndefined();
    await runner.cancelJob(active.job_id);
  }, 15_000);

  it("names the plan and subtask in the resume call so a strict deployment accepts it", async () => {
    await writeFile(join(root, "override.toml"), "[defaults]\nrequire_plan_id = true\nmax_timeout_sec = 4\n");
    runner.savePlan({ plan_id: "plan-h", cwd: root, items: [{ ...ITEM }] });
    const timedOut = await runner.run({ plan_id: "plan-h", subtask_id: "one", prompt: IDLE_SCRIPT, timeout_sec: 1 });
    expect(timedOut.error?.resume).toEqual({
      tool: "orch_run",
      args: { continue_from_job_id: timedOut.job_id, plan_id: "plan-h", subtask_id: "one", timeout_sec: 2 },
    });
    const resumed = await runner.run(timedOut.error!.resume!.args as RunJobRequest);
    expect(resumed).toMatchObject({ status: "completed", continued_from: timedOut.job_id, plan_id: "plan-h", subtask_id: "one" });
  }, 15_000);

  it("does not auto-continue after a plain failure, in another context or in another cwd", async () => {
    runner.savePlan({ plan_id: "plan-b", cwd: root, items: [{ ...ITEM }] });
    const failed = await runner.run({ plan_id: "plan-b", subtask_id: "one", prompt: "process.exitCode = 1" });
    expect(failed.status).toBe("failed");
    expect((await runner.run({ plan_id: "plan-b", subtask_id: "one", prompt: OK_SCRIPT })).continued_from).toBeUndefined();

    // A plan without a saved directory, so the same subtask can be retried in another directory.
    runner.savePlan({ plan_id: "plan-c", context_id: "task-1", items: [{ ...ITEM }] });
    const timedOut = await runner.run({ plan_id: "plan-c", subtask_id: "one", cwd: root, prompt: IDLE_SCRIPT, timeout_sec: 1 });
    expect(timedOut.status).toBe("timed_out");
    const other = join(root, "other");
    await mkdir(other);
    const elsewhere = await runner.run({ plan_id: "plan-c", subtask_id: "one", cwd: other, prompt: OK_SCRIPT });
    expect(elsewhere.continued_from).toBeUndefined();
  }, 15_000);

  it("replays an auto-continued call with the same client_request_id", async () => {
    runner.savePlan({ plan_id: "plan-d", cwd: root, items: [{ ...ITEM }] });
    const first = await runner.run({ plan_id: "plan-d", subtask_id: "one", prompt: IDLE_SCRIPT, timeout_sec: 1 });
    const request = { plan_id: "plan-d", subtask_id: "one", prompt: IDLE_SCRIPT, timeout_sec: 1, client_request_id: "same" };
    const second = await runner.run(request);
    expect(second.continued_from).toBe(first.job_id);
    expect((await runner.run(request)).job_id).toBe(second.job_id);
  }, 15_000);

  it("hydrates cwd from the plan, and cwd, prompt and routing from the continued job", async () => {
    runner.savePlan({ plan_id: "plan-e", cwd: root, items: [{ ...ITEM }] });
    const planned = await runner.run({ plan_id: "plan-e", subtask_id: "one", prompt: OK_SCRIPT });
    expect(planned).toMatchObject({ status: "completed", cwd: root });

    const parent = await runner.run({ ...base(), model: "claude-sonnet", effort: "low" });
    const child = await runner.run({ continue_from_job_id: parent.job_id });
    expect(child).toMatchObject({
      status: "completed", continued_from: parent.job_id, cwd: root, model: parent.model, harness: parent.harness,
      effort: "low", mode: "readonly", isolation: "shared",
    });
    expect(invocations.at(-1)?.prompt).toBe(
      "Continue the task described in <prior_job_context>. Inspect the current workspace files first, verify any partial " +
      "progress, do not redo already completed work, finish the remaining steps, and report your changes. Reply in English.");
    // An unscoped continuation of a plan job joins that plan instead of failing the scope check.
    const scoped = await runner.run({ ...base(), plan_id: "plan-e", subtask_id: "one" });
    expect(scoped.status).toBe("completed");
    expect((await runner.run({ continue_from_job_id: scoped.job_id })).plan_id).toBe("plan-e");
  });

  it("fingerprints explicit and hydrated requests identically", async () => {
    runner.savePlan({ plan_id: "plan-f", cwd: root, items: [{ ...ITEM }] });
    const explicit = await runner.run({ plan_id: "plan-f", subtask_id: "one", cwd: root, prompt: OK_SCRIPT, client_request_id: "dup" });
    const hydrated = await runner.run({ plan_id: "plan-f", subtask_id: "one", prompt: OK_SCRIPT, client_request_id: "dup" });
    expect(hydrated.job_id).toBe(explicit.job_id);
  });

  it("rejects missing cwd, missing prompt and blank ids with structured INVALID_INPUT", async () => {
    await expect(runner.run({ prompt: OK_SCRIPT, model: "claude-sonnet", mode: "readonly" })).rejects.toMatchObject({
      code: "INVALID_INPUT", retryable: false, details: { missing: ["cwd"], example: expect.any(Object) },
    });
    await expect(runner.run({ cwd: "   ", prompt: OK_SCRIPT, model: "claude-sonnet", mode: "readonly" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT", details: { missing: ["cwd"] } });
    await expect(runner.run({ cwd: root, model: "claude-sonnet", mode: "readonly" })).rejects.toMatchObject({
      code: "INVALID_INPUT", details: { missing: ["prompt"], example: expect.any(Object) },
    });
    await expect(runner.run({ ...base(), prompt: "  " })).rejects.toMatchObject({ code: "INVALID_INPUT", details: { missing: ["prompt"] } });
    await expect(runner.run({ ...base(), client_request_id: "   " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(runner.run({ ...base(), context_id: "  " })).rejects.toMatchObject({ code: "INVALID_INPUT", message: "context_id must not be blank." });
    expect(invocations).toHaveLength(0);
  });

  it("does not leak the continued job's cwd to a request outside its context", async () => {
    const parent = await runner.run({ ...base(), context_id: "task-1" });
    await expect(runner.run({ continue_from_job_id: parent.job_id, context_id: "task-2", model: "claude-sonnet", mode: "readonly" }))
      .rejects.toMatchObject({ code: "INVALID_INPUT", message: expect.stringContaining("different context_id") });
  });

  it("keeps the full prompt for an interrupted step in the handoff", async () => {
    const goal = `${"requirement; ".repeat(200)}FINAL-REQUIREMENT`;
    const prompt = `/* ${goal} */ ${IDLE_SCRIPT}`;
    const parent = await runner.run({ ...base(), prompt, timeout_sec: 1 });
    expect(parent.status).toBe("timed_out");
    await runner.run({ ...base(), prompt: OK_SCRIPT, continue_from_job_id: parent.job_id });
    expect(invocations[1].systemContext).toContain("FINAL-REQUIREMENT");
  }, 10_000);

  it("reads the saved checkpoint of the parent from disk first, falling back to memory when the file is gone", async () => {
    const parent = await runner.run({ ...base(), prompt: IDLE_SCRIPT, timeout_sec: 1 });
    const file = join(parent.log_path, "checkpoint.json");
    // Plant a distinct marker on disk; the in-memory copy (CHECKPOINT) never contains it.
    const onDisk = JSON.parse(await readFile(file, "utf8")) as ProgressCheckpoint;
    await writeFile(file, JSON.stringify({ ...onDisk, partial_text: "DISK-ONLY-MARKER partial text" }));

    await runner.run({ ...base(), continue_from_job_id: parent.job_id });
    expect(invocations[0].systemContext).toBeUndefined();
    expect(invocations[1].systemContext).toContain("DISK-ONLY-MARKER");
    expect(invocations[1].systemContext).not.toContain("Drafted the parser");

    await rm(file);
    await runner.run({ ...base(), continue_from_job_id: parent.job_id });
    expect(invocations[2].systemContext).toContain("Edit src/a.ts");
    expect(invocations[2].systemContext).toContain("Drafted the parser");
    expect(invocations[2].systemContext).not.toContain("DISK-ONLY-MARKER");
  }, 10_000);

  it("reports files a shared write job changed, labelling pre-existing dirty ones", async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, "dirty.txt"), "dirty before the job\n");
    await writeFile(join(cwd, "untouched.txt"), "stays dirty\n");
    checkpoint = { tool_trail: [{ tool: "Edit", target: "tracked.txt", status: "started" }], turns: 1 };
    const prompt = `
      const fs = require("node:fs");
      fs.writeFileSync("tracked.txt", "two\\n");
      fs.writeFileSync("created.txt", "new\\n");
      fs.writeFileSync("dirty.txt", "changed again by the job\\n");
      setInterval(() => {}, 1_000);`;
    const job = await runner.run({ ...base(), cwd, mode: "write", prompt, timeout_sec: 1 });
    expect(job.status).toBe("timed_out");
    const saved = JSON.parse((await runner.readLogs(job.job_id, "checkpoint")).text) as ProgressCheckpoint;
    expect(saved.changed_files?.slice().sort()).toEqual(["created.txt", "dirty.txt", "tracked.txt"]);
    expect(saved.pre_existing_dirty).toBe(true);
    expect(saved.diff_excerpt).toContain("+two");
    expect(saved.diff_excerpt).toContain("new untracked file: created.txt");
    expect(job.progress).toMatchObject({ files_touched: 3, has_partial_progress: true });
  }, 10_000);

  it("keeps the checkpoint of a shared write inside its working directory in a monorepo", async () => {
    const cwd = await createRepo();
    for (const dir of ["pkg-a", "pkg-b"]) {
      await mkdir(join(cwd, dir));
      await writeFile(join(cwd, dir, "file.txt"), "original\n");
    }
    execFileSync("git", ["add", "."], { cwd, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "Add packages"], { cwd, stdio: "ignore" });
    await writeFile(join(cwd, "pkg-b", "dirty.txt"), "dirty before the job\n");
    checkpoint = { tool_trail: [{ tool: "Edit", target: "file.txt", status: "started" }], turns: 1 };
    const prompt = `
      const fs = require("node:fs");
      // Built at run time so the prompt itself (kept as the handoff goal) never spells the sibling names.
      const sibling = "../pkg-" + "b/";
      const marker = "SIBLING-" + "LEAK\\n";
      fs.writeFileSync("file.txt", "edited inside\\n");
      fs.writeFileSync("created.txt", "new\\n");
      fs.writeFileSync(sibling + "file.txt", marker);
      fs.writeFileSync(sibling + "dirty.txt", marker);
      fs.writeFileSync(sibling + "sibling-new.txt", marker);
      setInterval(() => {}, 1_000);`;
    const job = await runner.run({ ...base(), cwd: join(cwd, "pkg-a"), mode: "write", prompt, timeout_sec: 1 });
    expect(job.status).toBe("timed_out");
    const raw = (await runner.readLogs(job.job_id, "checkpoint")).text;
    const saved = JSON.parse(raw) as ProgressCheckpoint;
    expect(saved.changed_files?.slice().sort()).toEqual(["pkg-a/created.txt", "pkg-a/file.txt"]);
    expect(saved.diff_excerpt).toContain("+edited inside");
    expect(raw).not.toMatch(/pkg-b|SIBLING-LEAK/);
    expect(job.progress).toMatchObject({ files_touched: 2 });
    expect(saved.pre_existing_dirty).toBeUndefined();
    await expect(runner.run({ ...base(), cwd: join(cwd, "pkg-a"), mode: "write", continue_from_job_id: job.job_id })).resolves.toMatchObject({ status: "completed" });
    expect(invocations.at(-1)?.systemContext).not.toMatch(/pkg-b|SIBLING-LEAK/);
  }, 10_000);

  it("does not report pre-existing dirt as progress and never reroutes a shared write after tool activity", async () => {
    const cwd = await createRepo();
    await writeFile(join(cwd, "dirty.txt"), "dirty before the job\n");
    checkpoint = undefined;
    failWith = "429 rate limit exceeded";
    const quiet = await runner.run({ ...base(), cwd, mode: "write", prompt: 'process.stderr.write("429 rate limit exceeded"); process.exitCode = 1' });
    expect(quiet).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED", safe_to_reroute: true } });
    expect(quiet.progress).toMatchObject({ files_touched: 0, has_partial_progress: false });

    checkpoint = CHECKPOINT;
    const active = await runner.run({ ...base(), cwd, mode: "write", prompt: 'process.stderr.write("429 rate limit exceeded"); process.exitCode = 1' });
    expect(active).toMatchObject({ status: "failed", error: { code: "RATE_LIMITED", safe_to_reroute: false } });
  }, 10_000);

  it("never lets a throwing adapter checkpoint change the job outcome", async () => {
    checkpoint = undefined;
    const original = runner as unknown as { options: { adapterRegistry: { get: () => CliAdapter } } };
    const adapter = original.options.adapterRegistry.get();
    const broken: CliAdapter = {
      ...adapter,
      createStreamParser: () => ({ ...adapter.createStreamParser(), checkpoint() { throw new Error("boom"); } }),
    };
    original.options.adapterRegistry.get = () => broken;
    const job = await runner.run({ ...base(), prompt: IDLE_SCRIPT, timeout_sec: 1 });
    expect(job).toMatchObject({ status: "timed_out", error: { code: "TIMEOUT", has_partial_progress: false } });
    expect(job.warnings.join("\n")).toContain("Could not read the adapter progress");
    expect(JSON.parse(await readFile(join(job.log_path, "checkpoint.json"), "utf8"))).toMatchObject({ tool_trail: [] });
  }, 10_000);

  it("lets only one of two concurrent retries auto-continue the same timed-out job", async () => {
    runner.savePlan({ plan_id: "plan-race", cwd: root, items: [{ ...ITEM }] });
    const timedOut = await runner.run({ plan_id: "plan-race", subtask_id: "one", prompt: IDLE_SCRIPT, timeout_sec: 1 });
    expect(timedOut.status).toBe("timed_out");
    const retry = { plan_id: "plan-race", subtask_id: "one", prompt: IDLE_SCRIPT, async: true } as const;
    // Both retries check for a running continuation before either has been admitted.
    const outcomes = await Promise.allSettled([runner.run(retry), runner.run(retry)]);
    const admitted = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof runner.run>>> =>
      outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    try {
      expect(admitted).toHaveLength(1);
      expect(admitted[0].value.continued_from).toBe(timedOut.job_id);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONCURRENCY_LIMIT", retryable: true });
    } finally {
      for (const outcome of admitted) await runner.cancelJob(outcome.value.job_id);
    }
  }, 15_000);

  describe("plan expiry", () => {
    const expire = (planId: string) => runner.savePlan({ plan_id: planId, cwd: root, items: [{ ...ITEM }], expires_at: new Date(0).toISOString() });

    it("still lets a continuation of a recent job of the same plan through, but nothing else", async () => {
      runner.savePlan({ plan_id: "plan-expired", cwd: root, items: [{ ...ITEM }] });
      const first = await runner.run({ plan_id: "plan-expired", subtask_id: "one", prompt: IDLE_SCRIPT, timeout_sec: 1 });
      expect(first.status).toBe("timed_out");
      expire("plan-expired");

      const explicit = await runner.run({ plan_id: "plan-expired", subtask_id: "one", prompt: OK_SCRIPT, continue_from_job_id: first.job_id });
      expect(explicit).toMatchObject({ status: "completed", continued_from: first.job_id });

      // A job that is not part of this plan does not keep the expired plan alive. The job above started and renewed it.
      expect(Date.parse(runner.getPlan("plan-expired")!.expires_at!)).toBeGreaterThan(Date.now());
      expire("plan-expired");
      const other = await runner.run({ ...base(), plan_id: undefined });
      await expect(runner.run({ plan_id: "plan-expired", subtask_id: "one", prompt: OK_SCRIPT, continue_from_job_id: other.job_id }))
        .rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
      await expect(runner.run({ plan_id: "plan-expired", subtask_id: "one", prompt: OK_SCRIPT }))
        .rejects.toMatchObject({ code: "PLAN_NOT_FOUND" });
    }, 15_000);

    it("keeps the automatic continuation of a timed-out subtask working after the plan expired", async () => {
      runner.savePlan({ plan_id: "plan-auto", cwd: root, items: [{ ...ITEM }] });
      const first = await runner.run({ plan_id: "plan-auto", subtask_id: "one", prompt: IDLE_SCRIPT, timeout_sec: 1 });
      expire("plan-auto");
      const retry = await runner.run({ plan_id: "plan-auto", subtask_id: "one", prompt: OK_SCRIPT });
      expect(retry).toMatchObject({ status: "completed", continued_from: first.job_id });
    }, 15_000);

    it("extends the plan's lifetime when a job of that plan starts", async () => {
      const soon = Date.now() + 1_000;
      runner.savePlan({ plan_id: "plan-extended", cwd: root, items: [{ ...ITEM }], expires_at: new Date(soon).toISOString() });
      await runner.run({ plan_id: "plan-extended", subtask_id: "one", prompt: OK_SCRIPT });
      const extended = Date.parse(runner.getPlan("plan-extended")!.expires_at!);
      expect(extended - soon).toBeGreaterThan(30 * 60_000);
    });

    it("does not give a plan without an expiry one", async () => {
      runner.savePlan({ plan_id: "plan-forever", cwd: root, items: [{ ...ITEM }] });
      await runner.run({ plan_id: "plan-forever", subtask_id: "one", prompt: OK_SCRIPT });
      expect(runner.getPlan("plan-forever")).not.toHaveProperty("expires_at");
    });
  });
});
