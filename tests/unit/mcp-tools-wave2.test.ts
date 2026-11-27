import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliAdapter } from "../../src/adapters/types.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { ConfigManager } from "../../src/config/resolver.js";
import { MAX_IDEMPOTENT_RUNS, RunIdempotencyLedger, runFingerprint } from "../../src/mcp/idempotency.js";
import { createOrchestratorMcpServer } from "../../src/mcp/server.js";
import { startProgressHeartbeat } from "../../src/mcp/tools.js";
import { OrchestratorRunner } from "../../src/runtime/runner.js";
import type { JobRecord, StructuredError } from "../../src/types.js";

const CATALOG_PATH = join(import.meta.dirname, "../../defaults/catalog.toml");
const JOB_COUNT = 8;
const SUMMARY_CHARS = 700;
const SLOWEST_JOB_MS = 600;
const JOB_STEP_MS = 60;
const TIGHT_OUTPUT_BYTES = 3_500;
const MAX_PAGES = JOB_COUNT * 3;

interface StatusPage {
  jobs: Array<{ job_id: string }>;
  cursor?: string;
  omitted_jobs?: number;
  unseen_count?: number;
  pending_count: number;
  next?: { tool: string; args: Record<string, unknown> };
}

describe("orch_status paging over a real runner", () => {
  let root: string;
  let runner: OrchestratorRunner;
  let client: Client;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-status-paging-"));
    const configPath = join(root, "override.toml");
    await writeFile(configPath, `[defaults]\nmax_mcp_output_bytes = ${TIGHT_OUTPUT_BYTES}\nmax_concurrency = 16\nhost_max_concurrency = 16\n`);
    const adapter: CliAdapter = {
      driver: "claude",
      securityGuarantees: { readonly: "tool_allowlist", write: "unsandboxed" },
      mapEffort: (effort) => effort,
      async probe() { throw new Error("No live probe expected"); },
      async buildInvocation(input) {
        return { command: process.execPath, args: ["-e", input.prompt], stdin: "", nativeEffort: input.effort, tempFiles: [], warnings: [] };
      },
      createStreamParser() {
        const lines: string[] = [];
        return {
          pushLine(line) { if (line) lines.push(JSON.parse(line) as string); },
          finish: () => ({ ok: true, summary: lines.join("\n") }),
          checkpoint: () => ({ tool_trail: [], turns: 0 }),
        };
      },
    };
    const configManager = new ConfigManager({ userPath: configPath });
    runner = new OrchestratorRunner({
      configManager,
      adapterRegistry: { get: () => adapter, async probeHarness() { throw new Error("No live probe expected"); } },
      runsDir: join(root, "runs"), worktreesDir: join(root, "worktrees"), locksDir: join(root, "locks"),
      allowedCwdRoots: [root], env: {}, terminateGraceMs: 80, cliLimits: { home: join(root, "home"), cacheTtlMs: 0 },
    });
    const server = createOrchestratorMcpServer({ configManager, adapterRegistry: new AdapterRegistry(), runner, settleMs: 0 });
    client = new Client({ name: "wave2-paging", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeServer = async () => {
      await client.close();
      await server.close();
    };
  });

  afterEach(async () => {
    try {
      await closeServer();
      await runner.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function status(args: Record<string, unknown>): Promise<StatusPage> {
    const reply = await client.callTool({ name: "orch_status", arguments: args });
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    return JSON.parse((reply.content as Array<{ text: string }>)[0].text) as StatusPage;
  }

  it("ends the next.args loop once every completed job was returned, even when the list order differs from the finish order", async () => {
    // The first job started finishes last, so list order and completion order are opposite.
    const launched: string[] = [];
    for (let index = 0; index < JOB_COUNT; index++) {
      const delay = SLOWEST_JOB_MS - index * JOB_STEP_MS;
      const job = await runner.run({
        cwd: root, model: "claude-sonnet", mode: "readonly", async: true,
        prompt: `setTimeout(() => console.log(JSON.stringify("S".repeat(${SUMMARY_CHARS}))), ${delay})`,
      });
      launched.push(job.job_id);
    }
    await runner.waitForStatus({ jobIds: launched, until: "all_terminal", waitMs: 20_000 });

    const seen: string[] = [];
    let args: Record<string, unknown> = { job_ids: launched, until: "all_terminal", wait_ms: 1_000 };
    let pages = 0;
    for (;;) {
      expect(++pages, "paging never terminated").toBeLessThanOrEqual(MAX_PAGES);
      const page = await status(args);
      seen.push(...page.jobs.map((job) => job.job_id));
      if (!page.next) {
        expect(page.unseen_count).toBeUndefined();
        break;
      }
      expect(page.next.tool).toBe("orch_status");
      args = page.next.args;
    }
    // More than one page proves the byte budget really cut the list; every job was reported at least once.
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set(launched));
  });
});

describe("RunIdempotencyLedger", () => {
  const run = (jobId: string, fingerprint = "fp") => ({ jobId, fingerprint, snapshot: { job_id: jobId } });

  it("keeps the newest entries within its capacity and drops the oldest first", () => {
    const ledger = new RunIdempotencyLedger(3);
    for (const id of ["a", "b", "c", "d"]) ledger.remember(id, run(id));
    expect(ledger.size).toBe(3);
    expect(ledger.find("a", "fp")).toBeUndefined();
    for (const id of ["b", "c", "d"]) expect(ledger.find(id, "fp")?.jobId).toBe(id);
  });

  it("refreshes an entry on a hit so an actively retried ID outlives idle ones", () => {
    const ledger = new RunIdempotencyLedger(2);
    ledger.remember("a", run("a"));
    ledger.remember("b", run("b"));
    expect(ledger.find("a", "fp")).toBeDefined();
    ledger.remember("c", run("c"));
    expect(ledger.find("a", "fp")).toBeDefined();
    expect(ledger.find("b", "fp")).toBeUndefined();
  });

  it("answers only an identical call; a different payload is left to the runner", () => {
    const ledger = new RunIdempotencyLedger();
    ledger.remember("a", run("a", runFingerprint({ prompt: "one", plan_id: "p" })));
    expect(ledger.find("a", runFingerprint({ plan_id: "p", prompt: "one", async: true, wait_ms: 5, client_request_id: "a", label: undefined })))
      .toBeDefined();
    expect(ledger.find("a", runFingerprint({ prompt: "two", plan_id: "p" }))).toBeUndefined();
  });

  it("defaults to a fixed bound of 1000 entries", () => {
    expect(MAX_IDEMPOTENT_RUNS).toBe(1_000);
    const ledger = new RunIdempotencyLedger();
    for (let index = 0; index < MAX_IDEMPOTENT_RUNS + 5; index++) ledger.remember(`id-${index}`, run(`job-${index}`));
    expect(ledger.size).toBe(MAX_IDEMPOTENT_RUNS);
  });
});

describe("startProgressHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const frame = (call: unknown[]) => (call[0] as { params: { progress: number; message: string } }).params;

  it("keeps at most one write in flight and collapses the backlog of a stalled reader into one latest frame", async () => {
    const releases: Array<() => void> = [];
    const sendNotification = vi.fn(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    let status = 0;
    const heartbeat = startProgressHeartbeat({ sendNotification } as never, "tok", 1_000, () => `status ${++status}`);

    await vi.advanceTimersByTimeAsync(10_000);
    // Ten ticks passed, but the first write never completed: nothing else was started.
    expect(sendNotification).toHaveBeenCalledTimes(1);

    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    // Exactly one collapsed frame follows, rendered when it is written (the latest status), not ten queued ones.
    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(frame(sendNotification.mock.calls[1]).message).toBe("status 2");
    expect(frame(sendNotification.mock.calls[1]).progress).toBeGreaterThan(frame(sendNotification.mock.calls[0]).progress);

    const stopped = heartbeat.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    await stopped;
    releases[1]();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("does not hold stop() past the flush grace when the reader never drains", async () => {
    const sendNotification = vi.fn(() => new Promise<void>(() => undefined));
    const heartbeat = startProgressHeartbeat({ sendNotification } as never, 7, 1_000, () => "x", 500);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    // The write has been stuck for 3s, longer than the grace, so stop() must settle without any further waiting.
    await vi.advanceTimersByTimeAsync(3_000);
    let settled = false;
    void heartbeat.stop().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("gives a fresh in-flight write only the remaining grace before the reply", async () => {
    const sendNotification = vi.fn(() => new Promise<void>(() => undefined));
    const heartbeat = startProgressHeartbeat({ sendNotification } as never, 7, 1_000, () => "x", 500);
    await vi.advanceTimersByTimeAsync(1_000);
    let settled = false;
    void heartbeat.stop().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("stops sending after a failed write", async () => {
    const sendNotification = vi.fn(async () => { throw new Error("closed"); });
    startProgressHeartbeat({ sendNotification } as never, 7, 1_000, () => "x");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });
});

// Kept from the stub-runner scaffold of mcp-input.test.ts: the runner here is a spy so replays can be observed.
describe("orch_run client_request_id replay across plan eviction", () => {
  const stored = (jobId: string, overrides: Partial<JobRecord> = {}): JobRecord => ({
    job_id: jobId, version: 3, status: "completed", harness: "codex", driver: "codex", model: "gpt-6.2-sol", cli_model: "m", effort: "medium",
    mode: "readonly", isolation: "shared", security_guarantee: "os_sandbox", cwd: "/tmp", effective_cwd: "/tmp", log_path: "/tmp/run",
    warnings: [], created_at: new Date().toISOString(), plan_id: "plan_1", subtask_id: "a", ...overrides,
  });
  const runner = {
    savePlan: vi.fn(), getPlan: vi.fn(), getRuntimeDegradations: vi.fn(() => []), clearRuntimeDegradations: vi.fn(),
    run: vi.fn(), getJob: vi.fn(), listJobs: vi.fn(() => [] as JobRecord[]), waitForStatus: vi.fn(async () => [] as JobRecord[]),
    readLogs: vi.fn(), cancelJob: vi.fn(), shutdown: vi.fn(),
  };
  let client: Client;
  let server: ReturnType<typeof createOrchestratorMcpServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const configManager = new ConfigManager({ defaultPath: CATALOG_PATH, userPath: join(import.meta.dirname, "__no_user_config__.toml") });
    const config = configManager.load();
    vi.spyOn(configManager, "reloadIfChanged").mockReturnValue({ ...config, harnesses: {} });
    server = createOrchestratorMcpServer({ configManager, adapterRegistry: new AdapterRegistry(), runner: runner as never, settleMs: 0 });
    client = new Client({ name: "wave2-idempotency", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
    const reply = await client.callTool({ name, arguments: args });
    const text = (reply.content as Array<{ text: string }>)[0].text;
    return { data: JSON.parse(text) as T, isError: reply.isError === true };
  }

  const RUN = { plan_id: "plan_1", subtask_id: "a", prompt: "go", cwd: "/tmp", client_request_id: "once" };

  it("returns the original job for a retry after the plan was evicted, without asking the runner to run it again", async () => {
    runner.run.mockResolvedValueOnce(stored("job-1"));
    runner.getJob.mockImplementation((jobId: string) => (jobId === "job-1" ? stored("job-1") : undefined));
    const first = await call<JobRecord>("orch_run", RUN);
    expect(first.data.job_id).toBe("job-1");

    // The runner would now answer PLAN_NOT_FOUND for this plan_id; the retry must never reach it.
    runner.run.mockRejectedValue({ code: "PLAN_NOT_FOUND", message: "The plan could not be found.", retryable: false });
    const retry = await call<JobRecord>("orch_run", { ...RUN, async: true, wait_ms: 10 });
    expect(retry).toMatchObject({ isError: false, data: { job_id: "job-1", status: "completed" } });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("still names the original job after the runner pruned it, and flags the reply as a last known state", async () => {
    runner.run.mockResolvedValueOnce(stored("job-2", { status: "failed", error: { code: "QUOTA_EXCEEDED", message: "limit", retryable: false } }));
    await call("orch_run", { ...RUN, client_request_id: "pruned" });
    runner.getJob.mockReturnValue(undefined);
    runner.run.mockRejectedValue({ code: "PLAN_NOT_FOUND", message: "The plan could not be found.", retryable: false });
    const retry = await call<{ job_id: string; job_pruned: boolean; warnings: string[]; error: StructuredError }>(
      "orch_run", { ...RUN, client_request_id: "pruned" });
    expect(retry.data).toMatchObject({ job_id: "job-2", status: "failed", job_pruned: true, error: { code: "QUOTA_EXCEEDED" } });
    expect(retry.data.warnings[0]).toContain("orch_logs");
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("hands a changed payload to the runner so it can report the idempotency conflict", async () => {
    runner.run.mockResolvedValueOnce(stored("job-3"));
    await call("orch_run", { ...RUN, client_request_id: "conflict" });
    runner.run.mockRejectedValueOnce({ code: "IDEMPOTENCY_CONFLICT", message: "different payload", retryable: false });
    const changed = await call<{ error: StructuredError }>("orch_run", { ...RUN, client_request_id: "conflict", prompt: "other" });
    expect(changed).toMatchObject({ isError: true, data: { error: { code: "IDEMPOTENCY_CONFLICT", safe_to_reroute: false } } });
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it("does not remember a call the runner rejected", async () => {
    runner.run.mockRejectedValueOnce({ code: "PLAN_NOT_FOUND", message: "The plan could not be found.", retryable: false });
    await call("orch_run", { ...RUN, client_request_id: "never-started" });
    runner.run.mockResolvedValueOnce(stored("job-4"));
    const retry = await call<JobRecord>("orch_run", { ...RUN, client_request_id: "never-started" });
    expect(retry.data.job_id).toBe("job-4");
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});

describe("failover of a design-consult advisor", () => {
  const runner = {
    savePlan: vi.fn(), getPlan: vi.fn(), getRuntimeDegradations: vi.fn(() => []), clearRuntimeDegradations: vi.fn(),
    run: vi.fn(), getJob: vi.fn(), listJobs: vi.fn(() => [] as JobRecord[]), waitForStatus: vi.fn(async () => [] as JobRecord[]),
    readLogs: vi.fn(), cancelJob: vi.fn(), shutdown: vi.fn(),
  };
  let client: Client;
  let server: ReturnType<typeof createOrchestratorMcpServer>;

  const item = (id: string, task_type: string, harness: string, model: string) => ({
    id, title: id, task_type, harness, driver: harness, model, effort: "high", mode: "readonly", isolation: "shared",
  });
  const plan = (extra: object) => ({
    plan_id: "plan_c", items: [item("arch", "architecture", "claude", "claude-opus-5-5"), item("second", "second_opinion", "codex", "gpt-6.2-sol")], ...extra,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const configManager = new ConfigManager({ defaultPath: CATALOG_PATH, userPath: join(import.meta.dirname, "__no_user_config__.toml") });
    const config = configManager.load();
    const enabled = ["claude-opus-5-5", "gpt-6.2-sol", "agy-gemini-4-argon"];
    vi.spyOn(configManager, "reloadIfChanged").mockReturnValue({
      ...config, models: Object.fromEntries(Object.entries(config.models).map(([id, model]) => [id, { ...model, enabled: enabled.includes(id) }])),
    });
    const adapterRegistry = new AdapterRegistry();
    vi.spyOn(adapterRegistry, "getCachedHealth").mockImplementation((id) => ({
      harness: id, driver: config.harnesses[id].driver, enabled: true, installed: true, auth_status: "ready" as const,
      security_guarantees: { readonly: "os_sandbox" as const, write: "os_sandbox" as const }, checked_at: new Date().toISOString(),
    }));
    server = createOrchestratorMcpServer({ configManager, adapterRegistry, runner: runner as never, settleMs: 0 });
    client = new Client({ name: "wave2-failover", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  async function reroutes(savedPlan: object): Promise<string[]> {
    runner.getPlan.mockReturnValue(savedPlan);
    runner.run.mockRejectedValueOnce({ code: "QUOTA_EXCEEDED", message: "limit reached", retryable: false, failure_scope: "harness" });
    const reply = await client.callTool({ name: "orch_run", arguments: { plan_id: "plan_c", subtask_id: "second", prompt: "x", cwd: "/tmp" } });
    const data = JSON.parse((reply.content as Array<{ text: string }>)[0].text) as { error: StructuredError };
    return (data.error.suggested_alternatives ?? []).map((alternative) => alternative.model);
  }

  it("ranks the replacement from a vendor other than the host and the remaining advisor ahead of one that repeats them", async () => {
    const withoutIntent = await reroutes(plan({}));
    expect(withoutIntent).toEqual(expect.arrayContaining(["claude-opus-5-5", "agy-gemini-4-argon"]));
    const consult = await reroutes(plan({ intent: "design_consult", host_vendor: "anthropic" }));
    // Both candidates are ready and outside the failed vendor; only the independence constraint puts Google first.
    expect(consult[0]).toBe("agy-gemini-4-argon");
    expect(consult).toContain("claude-opus-5-5");
  });
});
