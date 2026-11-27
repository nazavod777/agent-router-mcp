import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ProgressCallback, RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { stringify } from "smol-toml";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { ConfigManager, parseDefaultCatalog } from "../../src/config/resolver.js";
import type { PresetRole } from "../../src/config/schema.js";
import type { LogChunk } from "../../src/runtime/job-store.js";
import type { PlanPreviewResult } from "../../src/planner/preview.js";
import { createOrchestratorMcpServer } from "../../src/mcp/server.js";
import { OrchestratorRunner, type WaitForStatusOptions, type WaitForStatusResult } from "../../src/runtime/runner.js";
import type { HarnessHealth, JobRecord, StructuredError } from "../../src/types.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ROOT, "dist", "cli", "main.js");
const DEFAULT_CATALOG = parseDefaultCatalog(readFileSync(join(ROOT, "defaults", "catalog.toml"), "utf8"));
const MODEL = "gpt-6.2-sol";
const REQUEST_TIMEOUT = 8_000;
const TOKEN = "smoke-placeholder-token";
const LOG_PAYLOAD = "\\\tЖ".repeat(8_000);
const CATALOG_ROLES = [
  "architecture", "research", "codebase_qa", "repo_recon", "ui_review", "root_cause", "review",
  "second_opinion", "security", "test_strategy", "performance", "data_sql", "long_context",
  "implementation", "frontend", "ui", "ui_design", "deep_refactor", "debugging", "testing", "devops",
  "writing", "quick",
];

const MOCK_CODEX = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 1.2.3");
} else if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in via test fixture");
} else {
  const prompt = fs.readFileSync(0, "utf8");
  const send = (event) => console.log(JSON.stringify(event));
  const finish = () => {
    send({ type: "item.completed", item: { type: "agent_message", text: "mock answer: " + process.env.ORCH_SMOKE_TOKEN } });
    send({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } });
  };
  if (prompt === "hold" || prompt === "hold-fail") {
    const fail = prompt === "hold-fail";
    const suffix = fail ? ".fail" : "";
    const release = process.env.ORCH_SMOKE_RELEASE + suffix;
    fs.writeFileSync(process.env.ORCH_SMOKE_PID + suffix, String(process.pid));
    fs.watchFile(release, { interval: 20 }, () => {
      if (!fs.existsSync(release)) return;
      fs.unwatchFile(release);
      if (fail) {
        send({ type: "turn.failed", error: { message: "Error: You've hit your usage limit · resets 8pm" } });
        process.exitCode = 3;
      } else {
        finish();
      }
    });
  } else if (prompt === "fail") {
    send({ type: "turn.failed", error: { message: "synthetic terminal failure" } });
    process.exitCode = 3;
  } else if (prompt === "large") {
    send({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(LOG_PAYLOAD)} } });
    send({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } });
  } else if (prompt === "report developer instructions") {
    const prefix = "developer_instructions=";
    const instructions = args.find((arg) => arg.startsWith(prefix));
    send({ type: "item.completed", item: { type: "agent_message", text: instructions ? JSON.parse(instructions.slice(prefix.length)) : "" } });
    send({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } });
  } else {
    finish();
  }
}
`;

interface Response<T> {
  data: T;
  text: string;
  isError: boolean;
}

interface CatalogResponse {
  harnesses: HarnessHealth[];
  models: Array<{ id: string; provenance: string; default_changed: boolean; is_stale: boolean; harness_ready: boolean }>;
  presets: Record<string, {
    description: string;
    enabled: boolean;
    roles: string[] | Record<string, PresetRole>;
    role_count?: number;
    role_names?: string[];
  }>;
  available_roles: string[];
  omitted_models: number;
}

interface StatusResponse {
  active_count?: number;
  queued_count?: number;
  jobs: Array<Pick<JobRecord, "job_id" | "status" | "version" | "result">>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

describe("agrmcp mcp over real stdio", () => {
  let directory: string;
  let configPath: string;
  let stateDir: string;
  let mockPidPath: string;
  let releasePath: string;
  let client: Client | undefined;
  let protocolErrors: string[];
  let diagnostics: string;

  beforeAll(() => {
    if (!existsSync(CLI)) execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "pipe", timeout: 30_000 });
  }, 35_000);

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), "orch-mcp-stdio-")));
    configPath = join(directory, "models.toml");
    stateDir = join(directory, "state");
    mockPidPath = join(directory, "mock.pid");
    releasePath = join(directory, "release");
    protocolErrors = [];
    diagnostics = "";
    const mock = join(directory, "mock-codex.cjs");
    await writeFile(mock, MOCK_CODEX, { mode: 0o700 });
    const harnesses = Object.fromEntries(Object.keys(DEFAULT_CATALOG.harnesses).map((id) => [
      id, id === "codex" ? { binary: mock } : { enabled: false },
    ]));
    await writeFile(configPath, stringify({ defaults: { max_concurrency: 1 }, harnesses }));
  });

  afterEach(async () => {
    try {
      await client?.close();
      expect(protocolErrors, diagnostics).toEqual([]);
    } finally {
      client = undefined;
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function connect(options: {
    depth?: string; observeExit?: boolean; progressIntervalMs?: number; savedPlanLog?: string;
  } = {}): Promise<StdioClientTransport> {
    const args = [CLI, "mcp"];
    const env: Record<string, string> = {
      ORCH_MODELS_PATH: configPath, ORCH_STATE_DIR: stateDir, ORCH_ALLOWED_ROOTS: directory,
      ORCH_SMOKE_PID: mockPidPath, ORCH_SMOKE_RELEASE: releasePath, ORCH_SMOKE_TOKEN: TOKEN,
      // Keeps CLI limit discovery away from the developer's real Codex config.
      CODEX_HOME: join(directory, "codex-home"),
    };
    if (options.depth !== undefined) env.ORCH_DEPTH = options.depth;
    if (options.progressIntervalMs !== undefined) {
      const server = pathToFileURL(join(ROOT, "dist", "mcp", "server.js")).href;
      const entry = `import { runStdioMcpServer } from ${JSON.stringify(server)};
await runStdioMcpServer({ progressIntervalMs: ${options.progressIntervalMs} });`;
      args.splice(0, args.length, "--input-type=module", "--eval", entry);
    }
    if (options.observeExit) {
      // The SDK sends SIGTERM if stdin EOF fails to stop the server. Record that fallback separately.
      const preload = `
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => writeFileSync(${JSON.stringify(join(directory, "server.sigterm"))}, "SIGTERM"));
process.on("exit", (code) => writeFileSync(${JSON.stringify(join(directory, "server.exit"))}, String(code)));
`;
      args.unshift("--import", `data:text/javascript,${encodeURIComponent(preload)}`);
    }
    if (options.savedPlanLog) {
      // The plan cache lives inside the stdio subprocess. Observe writes without replacing the cache.
      const runner = pathToFileURL(join(ROOT, "dist", "runtime", "runner.js")).href;
      const preload = `
import { appendFileSync } from "node:fs";
import { OrchestratorRunner } from ${JSON.stringify(runner)};
const savePlan = OrchestratorRunner.prototype.savePlan;
OrchestratorRunner.prototype.savePlan = function (plan) {
  appendFileSync(${JSON.stringify(options.savedPlanLog)}, plan.plan_id + "\\n");
  return savePlan.call(this, plan);
};
`;
      args.unshift("--import", `data:text/javascript,${encodeURIComponent(preload)}`);
    }
    const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: "pipe" });
    transport.stderr?.on("data", (chunk) => { diagnostics += chunk.toString(); });
    const connection = new Client({ name: "orch-stdio-smoke", version: "1.0.0" });
    client = connection;
    // The SDK reports anything other than a valid JSON-RPC frame through onerror.
    connection.onerror = (error) => { protocolErrors.push(error.message); };
    await connection.connect(transport, { timeout: REQUEST_TIMEOUT });
    return transport;
  }

  async function call<T>(name: string, args: Record<string, unknown> = {}, options?: RequestOptions): Promise<Response<T>> {
    const reply = await client!.callTool({ name, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT, ...options });
    expect(reply.content).toEqual([expect.objectContaining({ type: "text", text: expect.any(String) })]);
    const text = (reply.content as Array<{ text: string }>)[0].text;
    return { data: JSON.parse(text) as T, text, isError: reply.isError === true };
  }

  function run(prompt: string, options: Record<string, unknown> = {}) {
    return call<JobRecord>("orch_run", { cwd: directory, model: MODEL, mode: "readonly", prompt, ...options });
  }

  async function mockPid(path = mockPidPath): Promise<number> {
    return vi.waitFor(async () => {
      const pid = Number(await readFile(path, "utf8"));
      expect(pid).toBeGreaterThan(1);
      expect(isAlive(pid)).toBe(true);
      return pid;
    }, { timeout: 3_000 });
  }

  it("lists exactly six tools, probes the mock, saves a plan, runs it and reads paged logs", async () => {
    await connect();
    const instructions = client!.getInstructions();
    expect(instructions).toMatch(/STRICT OPT-IN.*NEVER call any orch_\* tool unless the user explicitly asks/i);
    expect(instructions).toMatch(/orch_plan_preview[^\n]*design_consult/);
    expect(instructions).toMatch(/continue_from_job_id[^\n]*context_id/);
    expect(instructions).toMatch(/Keep all model-to-model orchestration payloads \(subtasks\[\]\.title, label, prompt, system_context, and worker replies\) in English, and tell every worker in its prompt to reply in English[^\n]*; communicate with the user in the user's conversation language/);
    expect(instructions).toMatch(/On TIMEOUT, do NOT fail over to another model: retry or continue the SAME harness and model with a larger timeout_sec/);
    expect(instructions).toMatch(/HARD STOP on DELEGATION_UNAVAILABLE[^\n]*launchable:false[^\n]*delegation_status:'exhausted'[^\n]*delegation_state:'exhausted'[^\n]*STOP all main work/);
    expect(instructions).toMatch(/subtasks\[\]\.shards[^\n]*effective_cap[^\n]*native_subagents[^\n]*never pass inherit_mcp:true/);
    expect(instructions).toMatch(/orch_run\(\{continue_from_job_id,timeout_sec\}\)[^\n]*fresh:true[^\n]*part:"checkpoint"/);
    expect(instructions).toMatch(/INVALID_INPUT error lists details\.missing and details\.example/);
    expect(instructions).toMatch(/shards:1 equals omitting it[^\n]*claude, codex, opencode and dsh[^\n]*gemini[^\n]*unknown with a warning/);
    expect(instructions).toMatch(/pending_count > 0 or unseen_count > 0[^\n]*_meta\.progressToken/);
    expect(instructions).toMatch(/safe_to_reroute:false and no error\.resume[^\n]*poisoned checkout[^\n]*error\.resume\.args[^\n]*plan_id and subtask_id[^\n]*require_plan_id/);
    expect(instructions).toMatch(/untracked files by name only[^\n]*force_cleanup:true only after confirming/);
    const bannedPhrase = /finish\s+(directly|yourself)|do it yourself/i;
    for (const [name, text] of [
      ["server instructions", instructions ?? ""],
      ...["skills/orchestrate/SKILL.md", "docs/AI_AGENT_GUIDE.md", "README.md"].map((file): [string, string] => [file, readFileSync(join(ROOT, file), "utf8")]),
    ]) expect(text, `${name} must not tell the host to do delegated work itself`).not.toMatch(bannedPhrase);
    const { tools } = await client!.listTools(undefined, { timeout: REQUEST_TIMEOUT });
    expect(tools.map(({ name }) => name).sort()).toEqual([
      "orch_cancel", "orch_catalog", "orch_logs", "orch_plan_preview", "orch_run", "orch_status",
    ]);
    // Model-to-model payload parameters must be described in English only.
    const properties = (name: string) => (tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {}) as
      Record<string, { description?: string; items?: { properties?: Record<string, { description?: string }> } }>;
    const descriptions = [
      properties("orch_plan_preview").subtasks?.items?.properties?.title?.description,
      ...["prompt", "system_context", "label"].map((key) => properties("orch_run")[key]?.description),
    ];
    for (const description of descriptions) {
      expect(description).toMatch(/English/);
      expect(description).toMatch(/^[\x20-\x7E]+$/);
    }

    const catalog = await call<CatalogResponse>("orch_catalog", { detail: "full", search: "GPT-6.2 Sol", include_unavailable: false });
    expect(catalog.isError).toBe(false);
    expect(catalog.data.harnesses).toContainEqual(expect.objectContaining({
      harness: "codex", installed: true, version: "1.2.3", auth_status: "ready",
      security_guarantees: { readonly: "os_sandbox", write: "os_sandbox" },
    }));
    expect(catalog.data.models).toMatchObject([
      { id: MODEL, provenance: "default", default_changed: false, is_stale: expect.any(Boolean), harness_ready: true },
    ]);
    expect(catalog.data.presets).toHaveProperty("balanced");
    const limited = await call<CatalogResponse>("orch_catalog", { harness: "codex", limit: 1 });
    expect(limited.data.models).toHaveLength(1);
    expect(limited.data.omitted_models).toBeGreaterThan(0);

    const plan = await call<PlanPreviewResult>("orch_plan_preview", {
      cwd: directory, subtasks: [{ id: "review", title: "Review", task_type: "review", override: { model: MODEL } }],
    });
    expect(plan.isError).toBe(false);
    expect(plan.data.plan_id).toMatch(/^plan_/);
    expect(plan.data).toMatchObject({ locale: "en", cwd: directory, expires_at: expect.any(String) });
    const item = plan.data.items[0];
    expect(item).toMatchObject({ id: "review", role: "review", model: MODEL, harness_installed: true,
      harness_ready: true, reason: expect.any(String) });
    const itemKeys = ["id", "title", "role", "mode", "isolation", "harness", "harness_installed", "harness_ready",
      "model", "effort", "tier", "cost_tier", "selection_source", "reason", "warnings"];
    if (item.warnings.length > 0) itemKeys.push("alternatives");
    expect(Object.keys(item).sort()).toEqual(itemKeys.sort());
    expect(plan.data.markdown_table).toContain(MODEL);

    execFileSync("git", ["init", "-q", directory], { stdio: "pipe", timeout: REQUEST_TIMEOUT });
    const dirtyPlan = await call<PlanPreviewResult>("orch_plan_preview", {
      cwd: directory,
      subtasks: ["one", "two"].map((id) => ({
        id, title: id, task_type: "implementation", override: { model: MODEL },
      })),
    });
    expect(dirtyPlan.data).toMatchObject({ parallel_write_detected: true, git_dirty: true,
      items: [expect.objectContaining({ alternatives: expect.any(Array) }), expect.objectContaining({ alternatives: expect.any(Array) })] });
    expect(dirtyPlan.data.items.map((item) => item.isolation)).toEqual(["worktree", "worktree"]);
    expect(dirtyPlan.data.warnings.join("\n")).toContain("dirty git tree");

    const russianPlan = await call<PlanPreviewResult>("orch_plan_preview", {
      locale: "ru", subtasks: [{ id: "review", title: "Review", task_type: "review", override: { model: MODEL } }],
    });
    expect(russianPlan.data.markdown_table).toContain("| # | Подзадача |");

    const result = await call<JobRecord>("orch_run", {
      plan_id: plan.data.plan_id, subtask_id: "review", prompt: "complete", cwd: directory, client_request_id: "review-once",
    });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      harness: "codex", model: MODEL, effort: plan.data.items[0].effort, mode: "readonly", isolation: "shared",
      status: "completed", plan_id: plan.data.plan_id, subtask_id: "review",
      result: { summary: "mock answer: [REDACTED]", usage: { input_tokens: 7, output_tokens: 3 } },
    });
    const { job_id, log_path } = result.data;
    expect(log_path).toBe(join(stateDir, "runs", job_id));
    expect(result.text).not.toContain(TOKEN);

    const first = await call<LogChunk>("orch_logs", { job_id, limit_bytes: 4 });
    expect(first.data).toMatchObject({ text: "mock", offset_bytes: 0, next_offset_bytes: 4, eof: false });
    const last = await call<LogChunk>("orch_logs", { job_id, offset_bytes: first.data.next_offset_bytes });
    expect(last.data).toMatchObject({ text: " answer: [REDACTED]", offset_bytes: 4, eof: true });
    const empty = await call<LogChunk>("orch_logs", { job_id, part: "stderr" });
    expect(empty).toMatchObject({ isError: false, data: { text: "", eof: true } });
    const missing = await call<{ error: StructuredError }>("orch_logs", { job_id, part: "diff" });
    expect(missing).toMatchObject({ isError: true, data: { error: { message: "Log part not found." } } });
  });

  it("continues across plans with the same context and rejects a different context over stdio", async () => {
    await connect();
    const preview = (context_id: string, id: string) => call<PlanPreviewResult>("orch_plan_preview", {
      cwd: directory, context_id,
      subtasks: [{ id, title: id, task_type: "review", override: { model: MODEL } }],
    });
    const parentPlan = await preview("prompt-1", "initial-review");
    expect(parentPlan).toMatchObject({ isError: false, data: { plan_id: expect.any(String), context_id: "prompt-1" } });
    const parent = await call<JobRecord>("orch_run", {
      cwd: directory, plan_id: parentPlan.data.plan_id, subtask_id: "initial-review", prompt: "Review the initial artifact",
    });
    expect(parent).toMatchObject({ isError: false, data: {
      status: "completed", context_id: "prompt-1", result: { summary: "mock answer: [REDACTED]" },
    } });

    const childPlan = await preview(" prompt-1 ", "follow-up");
    expect(childPlan).toMatchObject({ isError: false, data: { plan_id: expect.any(String), context_id: "prompt-1" } });
    expect(childPlan.data.plan_id).not.toBe(parentPlan.data.plan_id);
    const child = await call<JobRecord>("orch_run", {
      cwd: directory, plan_id: childPlan.data.plan_id, subtask_id: "follow-up", prompt: "report developer instructions",
      continue_from_job_id: parent.data.job_id,
    });
    const continuation = { status: "completed", context_id: "prompt-1", continued_from: parent.data.job_id };
    expect(child).toMatchObject({ isError: false, data: continuation });
    const status = await call<StatusResponse>("orch_status", { job_ids: [child.data.job_id] });
    expect(status).toMatchObject({ isError: false, data: { jobs: [{ job_id: child.data.job_id, ...continuation }] } });

    const received = child.data.result?.summary;
    expect(received).toMatch(/^<prior_job_context untrusted="true"[^>]*>[\s\S]*<\/prior_job_context>$/);
    expect(received).toContain(`job ${parent.data.job_id}`);
    expect(received).toContain("Goal: Review the initial artifact");
    expect(received).toContain("Result: mock answer: [REDACTED]");

    const blankPlan = await client!.callTool({
      name: "orch_plan_preview",
      arguments: { cwd: directory, context_id: "   ", subtasks: [{ id: "blank-context", title: "blank", task_type: "review", override: { model: MODEL } }] },
    }, undefined, { timeout: REQUEST_TIMEOUT });
    expect(blankPlan.isError).toBe(true);
    expect((blankPlan.content as Array<{ text: string }>)[0].text).toMatch(/context_id/i);
    const blankRun = await client!.callTool({
      name: "orch_run",
      arguments: { cwd: directory, plan_id: childPlan.data.plan_id, subtask_id: "follow-up", prompt: "blank context", context_id: "   " },
    }, undefined, { timeout: REQUEST_TIMEOUT });
    expect(blankRun.isError).toBe(true);
    expect((blankRun.content as Array<{ text: string }>)[0].text).toMatch(/context_id/i);

    const unrelatedPlan = await preview("prompt-2", "unrelated-review");
    expect(unrelatedPlan).toMatchObject({ isError: false, data: { plan_id: expect.any(String), context_id: "prompt-2" } });
    const rejected = await call<{ error: StructuredError }>("orch_run", {
      cwd: directory, plan_id: unrelatedPlan.data.plan_id, subtask_id: "unrelated-review", prompt: "unrelated review",
      continue_from_job_id: parent.data.job_id,
    });
    expect(rejected).toMatchObject({
      isError: true, data: { error: { code: "INVALID_INPUT", message: expect.stringContaining("different context_id") } },
    });
  });

  it("warns over stdio when a design consultation's sole advisor shares the host vendor", async () => {
    await connect();
    const plan = await call<PlanPreviewResult>("orch_plan_preview", {
      intent: "design_consult", host_vendor: "openai",
      subtasks: [{ id: "advisor", title: "Research the design", task_type: "research", override: { model: MODEL } }],
    });
    expect(plan.isError).toBe(false);
    expect(plan.data.items[0].warnings).toContainEqual(expect.stringMatching(/same vendor \(openai\) as the host agent/));
  });

  it("returns a brief default catalog within 8000 bytes", async () => {
    await connect();
    const reply = await call<{
      harnesses: HarnessHealth[]; unavailable_harnesses: string[]; presets: Record<string, string>;
      models: Array<Record<string, unknown>>; returned: number; total: number;
    }>("orch_catalog");
    expect(reply.isError).toBe(false);
    expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(8000);
    expect(reply.data.harnesses.map((entry) => entry.harness)).toEqual(["codex"]);
    // The brief view stays within its byte budget, so limits are only in the full view.
    expect(reply.data.harnesses[0]).not.toHaveProperty("concurrency");
    expect(reply.data.unavailable_harnesses).toContain("cursor");
    expect(reply.data.models.length).toBeGreaterThan(0);
    expect(reply.data.returned).toBe(reply.data.models.length);
    for (const card of reply.data.models) {
      const keys = ["id", "harness", "tier", "cost_tier", "default_effort", "harness_ready"];
      if (card.is_stale === true) keys.push("is_stale");
      expect(Object.keys(card).sort()).toEqual(keys.sort());
    }
    expect(reply.data.presets.balanced).toEqual(expect.any(String));
    for (const description of Object.values(reply.data.presets)) expect(typeof description).toBe("string");
  });

  it("waits for every planned job through queue transitions over stdio", async () => {
    await connect();
    const plan = await call<PlanPreviewResult>("orch_plan_preview", {
      cwd: directory, subtasks: ["one", "two"].map((id) => ({
        id, title: id, task_type: "research", override: { model: MODEL },
      })),
    });
    const plan_id = plan.data.plan_id;
    const first = await run("hold", { plan_id, subtask_id: "one", async: true });
    await mockPid();
    const second = await run("complete", { plan_id, subtask_id: "two", async: true });
    expect(second.data.status).toBe("queued");
    const wait = call<StatusResponse>("orch_status", { plan_id, wait_ms: 5000, until: "all_terminal" });
    await client!.ping({ timeout: REQUEST_TIMEOUT });
    await writeFile(releasePath, "");
    expect((await wait).data.jobs).toMatchObject([
      { job_id: first.data.job_id, status: "completed" }, { job_id: second.data.job_id, status: "completed" },
    ]);
  });

  it("keeps a real SDK request alive with increasing progress and stops notifications on result", async () => {
    const progressIntervalMs = 250;
    await connect({ progressIntervalMs });
    const active = await run("hold", { async: true });
    await mockPid();

    const progress: Parameters<ProgressCallback>[0][] = [];
    const timeout = 1_200;
    const release = new AbortController();
    const startedAt = performance.now();
    const wait = call<StatusResponse>("orch_status", { job_ids: [active.data.job_id], until: "any_terminal" }, {
      timeout, maxTotalTimeout: 5_000, resetTimeoutOnProgress: true,
      onprogress: (event) => { progress.push(event); },
    });
    try {
      const [reply] = await Promise.all([
        wait,
        delay(2_500, undefined, { signal: release.signal }).then(() => writeFile(releasePath, "")),
      ]);
      expect(performance.now() - startedAt).toBeGreaterThan(timeout);
      expect(reply).toMatchObject({ isError: false, data: {
        wake_reason: "all_terminal", pending_count: 0, jobs: [{ job_id: active.data.job_id, status: "completed" }],
      } });
      expect(progress.length).toBeGreaterThan(2);
      for (const [index, event] of progress.entries()) {
        expect(event.progress).toBeGreaterThan(progress[index - 1]?.progress ?? 0);
      }
      expect(progress.map(({ message }) => message)).toContainEqual(expect.stringContaining(`0/1 done · codex/${MODEL} running`));

      const progressCount = progress.length;
      // A late frame would be reported as an unknown progress token by the SDK.
      await delay(2 * progressIntervalMs);
      expect(progress).toHaveLength(progressCount);
      expect(protocolErrors, diagnostics).toEqual([]);
    } finally {
      release.abort();
    }
  }, 10_000);

  it("returns the first failure before an uncached health probe finishes without a progress token", async () => {
    const healthyBinary = join(directory, "mock-claude.cjs");
    await writeFile(healthyBinary, `#!${process.execPath}
if (process.argv.includes("--version")) console.log("2.1.332");
else if (process.argv.includes("auth")) console.log(JSON.stringify({ loggedIn: true }));
`, { mode: 0o700 });
    const slowBinary = join(directory, "mock-agy.cjs");
    const probeStarted = join(directory, "probe-started");
    const probeRelease = join(directory, "probe-release");
    await writeFile(slowBinary, `#!${process.execPath}
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  const release = ${JSON.stringify(probeRelease)};
  const finish = () => {
    clearTimeout(timer);
    fs.unwatchFile(release);
    console.log("1.5.12");
  };
  const timer = setTimeout(finish, 10_000);
  fs.watchFile(release, { interval: 20 }, () => {
    if (fs.existsSync(release)) finish();
  });
  fs.writeFileSync(${JSON.stringify(probeStarted)}, "started");
  if (fs.existsSync(release)) finish();
} else {
  console.log("mock models");
}
`, { mode: 0o700 });
    const harnesses = Object.fromEntries(Object.keys(DEFAULT_CATALOG.harnesses).map((id) => [id, { enabled: false }]));
    const config = {
      defaults: { max_concurrency: 2 },
      harnesses: { ...harnesses, codex: { binary: join(directory, "mock-codex.cjs") }, claude: { binary: healthyBinary } },
    };
    await writeFile(configPath, stringify(config));
    await connect();
    const health = await call<CatalogResponse>("orch_catalog", { harness: "claude", detail: "full" });
    expect(health.data.harnesses).toContainEqual(expect.objectContaining({ harness: "claude", auth_status: "ready" }));
    const active = await run("hold", { async: true });
    const activePid = await mockPid();
    const failing = await run("hold-fail", { async: true, role: "research" });
    await mockPid(`${mockPidPath}.fail`);
    expect(existsSync(probeStarted)).toBe(false);
    await writeFile(configPath, stringify({ ...config, harnesses: { ...config.harnesses, antigravity: { binary: slowBinary } } }));

    const args = { job_ids: [active.data.job_id, failing.data.job_id], until: "any_terminal" };
    const firstFailure = expect.objectContaining({
      job_id: failing.data.job_id, status: "failed", error: expect.objectContaining({
        code: "QUOTA_EXCEEDED", suggested_alternatives: expect.arrayContaining([expect.objectContaining({ harness: "claude" })]),
      }),
    });
    try {
      const wait = call<StatusResponse>("orch_status", args, { timeout: 5_500 });
      const pending = Symbol("pending");
      expect(await Promise.race([wait, client!.ping({ timeout: REQUEST_TIMEOUT }).then(() => pending)])).toBe(pending);
      await writeFile(`${releasePath}.fail`, "");
      expect(await wait).toMatchObject({ isError: false, data: {
        wake_reason: "terminal", pending_count: 1,
        jobs: [firstFailure, expect.objectContaining({ job_id: active.data.job_id, status: "running" })],
      } });
      expect(await readFile(probeStarted, "utf8")).toBe("started");
      expect(isAlive(activePid)).toBe(true);

      await writeFile(configPath, stringify(config));
      expect(await call<StatusResponse>("orch_status", args, { timeout: 1_500 })).toMatchObject({ isError: false, data: {
        wake_reason: "terminal", pending_count: 1,
        jobs: [firstFailure, expect.objectContaining({ job_id: active.data.job_id, status: "running" })],
      } });
    } finally {
      await writeFile(probeRelease, "");
    }
  }, 12_000);

  it("keeps eight expanded presets compact at the catalog byte limit and expands them on request", async () => {
    const defaultModelCount = Object.keys(DEFAULT_CATALOG.models).length;
    const defaultPresetCount = Object.keys(DEFAULT_CATALOG.presets).length;
    const modelCount = Math.max(28, defaultModelCount);
    const presetCount = Math.max(8, defaultPresetCount);
    const models = Object.fromEntries(Array.from({ length: modelCount - defaultModelCount }, (_, index) => [
      `smoke-model-${index}`, { ...DEFAULT_CATALOG.models[MODEL], display_name: `Smoke Model ${index}` },
    ]));
    const balanced = DEFAULT_CATALOG.presets.balanced;
    const presetEntries = [...Object.entries(DEFAULT_CATALOG.presets),
      ...Array.from({ length: presetCount - defaultPresetCount }, (_, index) => [`smoke-preset-${index}`, balanced] as const)];
    const presets = Object.fromEntries(presetEntries.map(([id, preset]) => [
      id, {
        ...preset,
        roles: {
          ...Object.fromEntries(CATALOG_ROLES.map((role) => [role, balanced.roles.implementation])),
          ...preset.roles,
        },
      },
    ]));
    await writeFile(configPath, `${await readFile(configPath, "utf8")}\n${stringify({ models, presets })}`);
    await connect();

    const compact = await call<CatalogResponse>("orch_catalog", { detail: "full", limit: modelCount });
    expect(compact.isError).toBe(false);
    expect(Buffer.byteLength(compact.text)).toBeLessThan(24_000);
    expect(Buffer.byteLength(JSON.stringify(compact.data.presets))).toBeLessThan(8_000);
    expect(compact.data.available_roles.toSorted()).toEqual(CATALOG_ROLES.toSorted());
    expect(compact.data.models.length + compact.data.omitted_models).toBe(modelCount);
    expect(Object.keys(compact.data.presets).toSorted()).toEqual(Object.keys(presets).toSorted());
    for (const preset of Object.values(compact.data.presets)) {
      expect(preset).toMatchObject({
        description: expect.any(String), enabled: expect.any(Boolean), role_count: CATALOG_ROLES.length,
      });
      expect(preset.roles).toEqual(expect.arrayContaining(CATALOG_ROLES));
      expect(preset.role_names).toEqual(preset.roles);
    }

    const full = await call<CatalogResponse>("orch_catalog", { preset: "balanced" });
    expect(full.isError).toBe(false);
    expect(Object.keys(full.data.presets)).toEqual(["balanced"]);
    expect(full.data.presets.balanced.roles).toEqual(presets.balanced.roles);

    const all = await call<CatalogResponse>("orch_catalog", { detail: "full", include_preset_roles: true, limit: modelCount });
    expect(all.isError).toBe(false);
    expect(Object.keys(all.data.presets)).toHaveLength(presetCount);
    expect(all.data.presets.balanced.roles).toEqual(presets.balanced.roles);
    expect(compact.data.models.length).toBeGreaterThan(all.data.models.length);
    expect(Buffer.byteLength(all.text)).toBeLessThanOrEqual(24_000);
  });

  it("pages every catalog model within the byte limit and keeps unavailable harnesses compact", async () => {
    await connect();
    const modelIds = Object.keys(DEFAULT_CATALOG.models);
    expect(Object.keys(DEFAULT_CATALOG.harnesses)).toHaveLength(17);
    expect(modelIds.length).toBeGreaterThanOrEqual(43);

    const seen: string[] = [];
    let offset = 0;
    for (let page = 0; page < modelIds.length; page += 1) {
      const reply = await call<CatalogResponse & { next_offset?: number }>("orch_catalog", { detail: "full", limit: 100, offset });
      expect(reply.isError).toBe(false);
      expect(Buffer.byteLength(reply.text)).toBeLessThanOrEqual(24_000);
      expect(reply.data.models.length).toBeGreaterThan(0);
      expect(reply.data.harnesses).toHaveLength(17);
      seen.push(...reply.data.models.map((model) => model.id));
      expect(reply.data.omitted_models).toBe(modelIds.length - seen.length);
      if (reply.data.next_offset === undefined) break;
      expect(reply.data.next_offset).toBe(seen.length);
      offset = reply.data.next_offset;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(modelIds);

    const first = await call<CatalogResponse>("orch_catalog", { detail: "full", limit: 100 });
    const disabled = first.data.harnesses.find((entry) => entry.harness === "cursor");
    expect(disabled).toEqual({
      harness: "cursor", driver: "cursor", enabled: false, installed: false, auth_status: "unknown", contract: "experimental",
    });
    expect(first.data.harnesses.find((entry) => entry.harness === "codex")).toHaveProperty("security_guarantees");
    expect(first.data.harnesses.find((entry) => entry.harness === "codex")?.concurrency)
      .toMatchObject({ effective_cap: 1, global_cap: 1, limit_source: "fallback", fallback_used: true, native_subagents: "unknown" });

    const ready = await call<CatalogResponse>("orch_catalog", { include_unavailable: false, limit: 1 });
    expect(ready.data.harnesses.map((entry) => entry.harness)).toEqual(["codex"]);
    const filtered = await call<CatalogResponse>("orch_catalog", { harness: "codex", limit: 1 });
    expect(filtered.data.harnesses.map((entry) => entry.harness)).toEqual(["codex"]);
    const beyond = await call<CatalogResponse>("orch_catalog", { offset: modelIds.length });
    expect(beyond.data).toMatchObject({ models: [], omitted_models: 0 });
  });

  it("matches a catalog task alias as its canonical role", async () => {
    await connect();
    const canonical = await call<CatalogResponse>("orch_catalog", { include_unavailable: true, task_type: "architecture" });
    const alias = await call<CatalogResponse>("orch_catalog", { include_unavailable: true, task_type: " Planning " });
    expect(canonical.isError).toBe(false);
    expect(canonical.data.models).not.toHaveLength(0);
    expect(alias.isError).toBe(false);
    expect(alias.data.models).toEqual(canonical.data.models);
  });

  it("wakes long-poll on async completion and leaves the job alive when a wait is cancelled", async () => {
    await connect();
    const reply = await run("hold", { async: true });
    expect(reply.isError).toBe(false);
    expect(reply.data.status).toBe("running");
    const pid = await mockPid();
    const job_ids = [reply.data.job_id];
    const current = await call<StatusResponse>("orch_status", { job_ids });
    expect(current.data).toMatchObject({ active_count: 1, queued_count: 0, jobs: [{ status: "running" }] });
    const waitArgs = { job_ids, since_version: current.data.jobs[0].version, wait_ms: 5_000 };
    const controller = new AbortController();
    const cancelled = call<StatusResponse>("orch_status", waitArgs, { signal: controller.signal });
    const rejection = expect(cancelled).rejects.toThrow();
    await client!.ping({ timeout: REQUEST_TIMEOUT });
    controller.abort();
    await rejection;
    expect(isAlive(pid)).toBe(true);

    const wait = call<StatusResponse>("orch_status", waitArgs);
    const pending = Symbol("pending");
    expect(await Promise.race([wait, client!.ping({ timeout: REQUEST_TIMEOUT }).then(() => pending)])).toBe(pending);
    await writeFile(releasePath, "");
    const completed = await wait;
    expect(completed.data.jobs).toMatchObject([{
      job_id: reply.data.job_id, status: "completed",
      result: { summary: "mock answer: [REDACTED]", usage: { input_tokens: 7, output_tokens: 3 } },
    }]);
  });

  it("reroutes a planned job after a verbatim quota failure and completes the replacement", async () => {
    const raw = "Error: You've hit your usage limit · resets 8pm";
    const binary = join(directory, "mock-claude.cjs");
    await writeFile(binary, `#!${process.execPath}
if (process.argv.includes("--version")) console.log("2.1.332");
else if (process.argv.includes("auth")) console.log(JSON.stringify({ loggedIn: true }));
else { console.log(${JSON.stringify(raw)}); process.exitCode = 1; }
`, { mode: 0o700 });
    const harnesses = Object.fromEntries(Object.keys(DEFAULT_CATALOG.harnesses).map((id) => [
      id, id === "codex" ? { binary: join(directory, "mock-codex.cjs") } : id === "claude" ? { binary } : { enabled: false },
    ]));
    await writeFile(configPath, stringify({ harnesses }));
    await connect();
    const preview = (options = {}) => call<PlanPreviewResult>("orch_plan_preview", {
      cwd: directory, subtasks: [{ id: "a", title: "Design", task_type: "architecture" }], ...options,
    });
    const launch = (plan: PlanPreviewResult) => call<JobRecord>("orch_run", {
      plan_id: plan.plan_id, subtask_id: "a", cwd: directory, prompt: "design", client_request_id: plan.plan_id,
    });
    const first = await preview();
    expect(first.data.items[0].harness).toBe("claude");
    const failed = await launch(first.data);
    const status = await call<{ jobs: JobRecord[] }>("orch_status", { job_ids: [failed.data.job_id] });
    for (const job of [failed.data, status.data.jobs[0]]) {
      expect(job.error).toMatchObject({ code: "QUOTA_EXCEEDED", raw_error: raw, failure_scope: "harness", safe_to_reroute: true });
      expect(job.error?.suggested_alternatives?.[0]).toMatchObject({ harness: "codex", reason: expect.stringContaining("architecture") });
    }
    const catalog = () => call<CatalogResponse>("orch_catalog", { harness: "claude" });
    expect((await catalog()).data.harnesses[0].runtime_warning).toContain(raw);
    const automatic = await preview();
    expect(automatic.data.items[0].harness).toBe("codex");
    expect(automatic.data.warnings.join(" ")).toContain(raw);
    const replacement = await preview({ exclude_harnesses: ["claude"] });
    expect(replacement.data.items[0].harness).toBe("codex");
    expect(await launch(replacement.data)).toMatchObject({ data: { status: "completed", result: { summary: expect.stringContaining("mock answer") } } });
    expect((await preview({ refresh_health: true })).data.items[0].harness).toBe("claude");
    expect((await catalog()).data.harnesses[0].runtime_warning).toBeUndefined();

    // Codex was offered for the identical failure above and is still healthy.
    const restricted = await preview({ exclude_harnesses: ["codex"] });
    expect(restricted.data.exclude_harnesses).toEqual(["codex"]);
    const rejected = await launch(restricted.data);
    const exhausted = { state: "exhausted", usable_count: 0, blocked_by_harness: { claude: "cooldown", codex: "excluded" } };
    expect(rejected.data).toMatchObject({
      delegation: exhausted,
      error: { code: "QUOTA_EXCEEDED", delegation_state: "exhausted" },
    });
    const restrictedStatus = await call<{ jobs: JobRecord[] }>("orch_status", { plan_id: restricted.data.plan_id });
    expect(restrictedStatus.data).toMatchObject({
      delegation: exhausted,
      jobs: [{ job_id: rejected.data.job_id, harness: "claude",
        error: { code: "QUOTA_EXCEEDED", delegation_state: "exhausted", suggested_alternatives: [] } }],
    });

    // An unfiltered status is session-wide: an older plan that excluded healthy codex must not report exhaustion.
    const unfiltered = await call<{ jobs: JobRecord[] }>("orch_status", {});
    expect(unfiltered.data.jobs.some((job) => job.job_id === rejected.data.job_id)).toBe(true);
    expect(unfiltered.data).not.toHaveProperty("delegation");

    // The job keeps its plan's exclusions after the plan itself is evicted from the bounded plan cache.
    for (let index = 0; index < 205; index++) await preview();
    expect(await call<JobRecord>("orch_run", {
      plan_id: restricted.data.plan_id, subtask_id: "a", cwd: directory, prompt: "design", client_request_id: "eviction-check",
    })).toMatchObject({ isError: true, data: { error: { code: "PLAN_NOT_FOUND" } } });
    const evicted = await call<{ jobs: JobRecord[] }>("orch_status", { job_ids: [rejected.data.job_id] });
    expect(evicted.data).toMatchObject({
      delegation: exhausted,
      jobs: [{ job_id: rejected.data.job_id, error: { delegation_state: "exhausted", suggested_alternatives: [] } }],
    });
  }, 60_000);

  it("rejects an exhausted preview over stdio without saving a plan", async () => {
    const savedPlanLog = join(directory, "saved-plans");
    const binary = join(directory, "mock-codex.cjs");
    await rm(binary);
    await connect({ savedPlanLog });
    const preview = () => call<PlanPreviewResult & { error?: StructuredError }>("orch_plan_preview", {
      cwd: directory, refresh_health: true,
      subtasks: [{ id: "review", title: "Review changes", task_type: "review", override: { model: MODEL } }],
    });

    expect(await preview()).toMatchObject({
      isError: true, data: {
        plan_id: null, launchable: false, delegation_status: "exhausted",
        blocked_by_harness: { codex: "not_installed" },
        error: { code: "DELEGATION_UNAVAILABLE" },
      },
    });
    expect(existsSync(savedPlanLog)).toBe(false);

    await writeFile(binary, MOCK_CODEX, { mode: 0o700 });
    const ready = await preview();
    expect(ready).toMatchObject({ isError: false, data: { launchable: true, plan_id: expect.any(String) } });
    expect(await readFile(savedPlanLog, "utf8")).toBe(`${ready.data.plan_id}\n`);
  });

  it("keeps delegation available after a timeout on an explicitly overridden model that exclude_harnesses lists", async () => {
    await connect();
    const preview = await call<PlanPreviewResult & { ignored_arguments?: string[] }>("orch_plan_preview", {
      cwd: directory, exclude_harnesses: ["codex"],
      // The misplaced top-level `harness` inside the subtask must be reported, not dropped silently.
      subtasks: [{ id: "a", title: "Hold", task_type: "review", override: { model: MODEL }, harness: "codex" }],
    });
    expect(preview).toMatchObject({ isError: false, data: {
      launchable: true, exclude_harnesses: ["codex"], explicit_models: [MODEL],
      ignored_arguments: ['subtasks[0].harness (did you mean "override.harness"?)'],
    } });
    const timedOut = await call<JobRecord>("orch_run", {
      plan_id: preview.data.plan_id, subtask_id: "a", cwd: directory, prompt: "hold", timeout_sec: 1,
    });
    expect(timedOut).toMatchObject({ isError: true, data: { status: "timed_out", error: { code: "TIMEOUT", delegation_state: "available" } } });
    expect(timedOut.data).not.toHaveProperty("delegation");
  });

  it("marks QUEUE_FULL as not safe to reroute and warns about it in the preview when the queue is disabled", async () => {
    const harnesses = Object.fromEntries(Object.keys(DEFAULT_CATALOG.harnesses).map((id) => [
      id, id === "codex" ? { binary: join(directory, "mock-codex.cjs") } : { enabled: false },
    ]));
    await writeFile(configPath, stringify({ defaults: { max_concurrency: 1, max_queue_size: 0 }, harnesses }));
    await connect();
    const preview = await call<PlanPreviewResult>("orch_plan_preview", {
      cwd: directory, subtasks: [{ id: "a", title: "Audit", task_type: "review", shards: 2 }],
    });
    expect(preview.data.warnings.join("\n")).toMatch(/will hit QUEUE_FULL/);
    expect(preview.data.warnings.join("\n")).not.toMatch(/will queue/);
    await run("hold", { async: true });
    await mockPid();
    const rejected = await run("complete", { async: true });
    expect(rejected).toMatchObject({ isError: true, data: { error: { code: "QUEUE_FULL", safe_to_reroute: false } } });
  });

  it("reports same-model retry and no failover alternatives for a timeout over stdio", async () => {
    await connect();
    const result = await run("hold", { timeout_sec: 1 });
    expect(result).toMatchObject({ isError: true, data: { status: "timed_out", job_id: expect.any(String) } });
    const status = await call<{ jobs: JobRecord[] }>("orch_status", { job_ids: [result.data.job_id] });
    expect(status).toMatchObject({ isError: false, data: { jobs: [{ job_id: result.data.job_id, status: "timed_out" }] } });
    for (const job of [result.data, status.data.jobs[0]]) {
      expect(job.error).toMatchObject({
        code: "TIMEOUT", retry_same_model: true, suggested_timeout_sec: 2, timeout_kind: "soft",
        details: { timeout_kind: "soft", soft_timeout_sec: 1, effective_timeout_sec: 1, extensions_used: 0 },
      });
      expect(job.error).not.toHaveProperty("suggested_alternatives");
    }
  });

  it("stops a job at an exact limit over stdio when strict_timeout is set", async () => {
    await connect();
    const result = await run("hold", { timeout_sec: 1, strict_timeout: true });
    expect(result).toMatchObject({ isError: true, data: {
      status: "timed_out", timeout: { strict: true, auto_extend: false, soft_sec: 1 }, error: { timeout_kind: "soft" },
    } });
    const { tools } = await client!.listTools(undefined, { timeout: REQUEST_TIMEOUT });
    const properties = tools.find((tool) => tool.name === "orch_run")?.inputSchema.properties ?? {};
    expect(properties).toHaveProperty("strict_timeout");
    expect(JSON.stringify(properties.timeout_sec)).toMatch(/Omit it/);
  });

  it("shows the per-session concurrency picture and timeout policy in plan previews, run results and orch_status", async () => {
    await connect();
    const subtasks = [{ id: "a", title: "Audit", task_type: "review" }];
    const before = await call<PlanPreviewResult>("orch_plan_preview", { cwd: directory, subtasks });
    expect(before.data.concurrency).toMatchObject({
      global_max_concurrency: 1, session_max_concurrency: 1, host_max_concurrency: 24, concurrency_scope: "repo",
      session_id: expect.stringMatching(/^[0-9a-f]{12}$/), session_active: 0, host_active: 0,
    });
    expect(before.data.timeouts).toEqual({
      default_timeout_sec: 900, high_effort_timeout_sec: 1800, max_timeout_sec: 3600, auto_extend_timeout: true,
      idle_timeout_sec: 900, timeout_extension_sec: 600, activity_window_sec: 180,
    });
    const withoutCwd = await call<PlanPreviewResult>("orch_plan_preview", { subtasks });
    expect(withoutCwd.data.concurrency).not.toHaveProperty("session_id");

    const held = await run("hold", { async: true });
    await mockPid();
    const queued = await run("complete", { async: true });
    expect(queued.data.status).toBe("queued");
    const after = await call<PlanPreviewResult>("orch_plan_preview", { cwd: directory, subtasks });
    expect(after.data.concurrency).toMatchObject({
      session_id: before.data.concurrency.session_id, session_active: 1, host_active: 1,
      per_harness: { codex: { session_active: 1 } },
    });

    const status = await call<{ jobs: Array<Record<string, unknown>> }>("orch_status", { job_ids: [held.data.job_id, queued.data.job_id] });
    expect(status.data.jobs).toMatchObject([
      { job_id: held.data.job_id, status: "running", session_id: before.data.concurrency.session_id,
        timeout: { soft_sec: expect.any(Number), hard_sec: 3600, output_mode: expect.stringMatching(/^(streaming|buffered)$/) } },
      { job_id: queued.data.job_id, status: "queued", session_id: before.data.concurrency.session_id,
        queue: { position: 1, blocked_by: "session_cap" } },
    ]);
    // The raw session key holds local paths; only the short session_id may reach the model.
    expect(JSON.stringify(status.data)).not.toContain("session_key");
    for (const job of [held, queued]) {
      expect(JSON.stringify(job.data)).not.toContain("session_key");
      const cancelled = await call("orch_cancel", { job_id: job.data.job_id });
      expect(JSON.stringify(cancelled.data)).not.toContain("session_key");
    }
  });

  it("returns structured planning and admission errors and retains failed job IDs", async () => {
    await connect();
    const plan = await call<{ error: StructuredError }>("orch_plan_preview", {
      preset: "missing", subtasks: [{ id: "a", title: "A", task_type: "review" }],
    });
    expect(plan).toMatchObject({ isError: true, data: { error: { code: "PLAN_NOT_FOUND" } } });
    const empty = await call<{ error: StructuredError }>("orch_plan_preview", { subtasks: [] });
    expect(empty).toMatchObject({ isError: true, data: { error: { code: "INVALID_INPUT", details: {
      missing: ["subtasks"], example: { subtasks: [expect.objectContaining({ id: expect.any(String), task_type: expect.any(String) })] },
    } } } });

    const unsupported = await call<{ error: StructuredError }>("orch_run", {
      cwd: directory, model: "missing", mode: "readonly", prompt: "unused", harness: "codex",
    });
    expect(unsupported).toMatchObject({ isError: true, data: { error: { code: "MODEL_UNSUPPORTED" } } });
    expect(unsupported.data.error.suggested_alternatives).toHaveLength(3);
    expect(unsupported.data.error.suggested_alternatives).toEqual(
      expect.arrayContaining([expect.objectContaining({ harness: "codex" })]),
    );

    const failed = await run("fail");
    expect(failed).toMatchObject({
      isError: true, data: {
        status: "failed", job_id: expect.any(String), log_path: expect.any(String), error: { code: "NON_ZERO_EXIT" },
      },
    });
    const queued = await run("hold", { async: true });
    const pid = await mockPid();
    const cancelled = await call<JobRecord>("orch_cancel", { job_id: queued.data.job_id });
    expect(cancelled).toMatchObject({ isError: false, data: { status: "cancelled", error: { code: "CANCELLED" } } });
    expect(isAlive(pid)).toBe(false);
    const missing = await call<{ error: StructuredError }>("orch_cancel", { job_id: "missing" });
    expect(missing).toMatchObject({ isError: true, data: { error: { message: "Job not found." } } });
  });

  it("accepts null, blank, aliased and string-boolean arguments on all six tools without a protocol error", async () => {
    await connect();
    const catalog = await call<CatalogResponse>("orch_catalog", {
      detail: null, search: "", task_type: null, preset: " ", include_preset_roles: "false", harness: "", tier: null,
      include_unavailable: "false", refresh_health: "false", limit: "2", offset: null,
    });
    expect(catalog).toMatchObject({ isError: false, data: { models: [expect.anything(), expect.anything()] } });
    expect(catalog.data.harnesses.map((entry) => entry.harness)).toEqual(["codex"]);

    const plan = await call<PlanPreviewResult>("orch_plan_preview", {
      cwd: directory, locale: " EN ", intent: null, preset: "", host_vendor: null, exclude_harnesses: null, exclude_models: "",
      refresh_health: "false", context_id: null,
      subtasks: JSON.stringify([{ id: "review", task_type: "review", mode: "read-only", shards: "1", override: { model: MODEL, effort: null } }]),
    });
    expect(plan).toMatchObject({ isError: false, data: { plan_id: expect.any(String), locale: "en",
      items: [expect.objectContaining({ id: "review", title: "review", mode: "readonly", model: MODEL })] } });
    const single = await call<PlanPreviewResult>("orch_plan_preview", {
      cwd: directory, subtasks: { id: "solo", title: "Solo", task_type: "review", override: { model: MODEL } },
    });
    expect(single).toMatchObject({ isError: false, data: { items: [expect.objectContaining({ id: "solo" })] } });

    const job = await call<JobRecord>("orch_run", {
      plan_id: plan.data.plan_id, subtask_id: "review", prompt: "complete", cwd: directory, mode: null, isolation: "", async: "false",
      inherit_mcp: null, fresh: null, wait_ms: null, timeout_sec: "60", client_request_id: null, label: null, system_context: "", labell: "typo",
    });
    expect(job).toMatchObject({ isError: false, data: { status: "completed", ignored_arguments: ['labell (did you mean "label"?)'] } });
    expect(job.text).not.toContain("typo");

    const status = await call<StatusResponse>("orch_status", {
      job_id: job.data.job_id, job_ids: null, plan_id: "", since_version: "0", wait_ms: "0", until: "ALL", cursor: null,
    });
    expect(status).toMatchObject({ isError: false, data: { jobs: [{ job_id: job.data.job_id, status: "completed" }] } });
    const logs = await call<LogChunk>("orch_logs", { job_id: job.data.job_id, part: "Result", offset_bytes: "0", limit_bytes: null });
    expect(logs).toMatchObject({ isError: false, data: { text: "mock answer: [REDACTED]", offset_bytes: 0 } });
    const cancelled = await call<JobRecord>("orch_cancel", { job_id: job.data.job_id, cleanup_worktree: null, force_cleanup: "false" });
    expect(cancelled).toMatchObject({ isError: false, data: { job_id: job.data.job_id, status: "completed" } });
  });

  it("returns INVALID_INPUT details and ignored-argument hints for malformed calls over stdio", async () => {
    await connect();
    const example = { job_id: expect.any(String) };
    for (const name of ["orch_logs", "orch_cancel"]) {
      const reply = await call<{ error: StructuredError; ignored_arguments?: string[] }>(name, { jobid: "x" });
      expect(reply).toMatchObject({ isError: true, data: {
        ignored_arguments: ['jobid (did you mean "job_id"?)'],
        error: { code: "INVALID_INPUT", retryable: false, details: { missing: ["job_id"], example } },
      } });
    }
    const blankContext = await call<{ error: StructuredError }>("orch_plan_preview", {
      context_id: " ", subtasks: [{ id: "a", task_type: "review" }],
    });
    expect(blankContext).toMatchObject({ isError: true, data: { error: { code: "INVALID_INPUT", details: { missing: ["context_id"] } } } });
    const conflicting = await call<{ error: StructuredError }>("orch_status", { job_id: "a", job_ids: ["b"] });
    expect(conflicting).toMatchObject({ isError: true, data: { error: { code: "INVALID_INPUT" } } });
    const noPrompt = await call<{ error: StructuredError }>("orch_run", { cwd: directory, model: MODEL, mode: "readonly", prompt: "   " });
    expect(noPrompt).toMatchObject({ isError: true, data: { error: { code: "INVALID_INPUT" } } });
  });

  it("rejects orch_status for job_ids that exist nowhere and flags unknown ones next to real jobs", async () => {
    await connect();
    const ghost = await call<{ error: StructuredError; jobs?: unknown }>("orch_status", { job_ids: ["ghost-job"], until: "all_terminal" });
    expect(ghost).toMatchObject({ isError: true, data: { error: { code: "INVALID_INPUT", details: { unknown_job_ids: ["ghost-job"] } } } });
    expect(ghost.data).not.toHaveProperty("jobs");
    const done = await run("complete");
    const mixed = await call<StatusResponse & { unknown_job_ids?: string[] }>("orch_status", {
      job_ids: [done.data.job_id, "ghost-job"], until: "any_change",
    });
    expect(mixed).toMatchObject({ isError: false, data: { unknown_job_ids: ["ghost-job"], jobs: [{ job_id: done.data.job_id }] } });
    const exact = await call<StatusResponse>("orch_status", { job_ids: [done.data.job_id], until: "any_change" });
    expect(exact.data).not.toHaveProperty("unknown_job_ids");
  });

  it("degrades a large launchable orch_plan_preview stepwise and saves the plan whenever a step fits", async () => {
    // Parallel shared writes make every item carry a warning, and with it its alternatives.
    const subtasks = Array.from({ length: 6 }, (_unused, index) => ({
      id: `t${index}`, title: `Task ${index}`, task_type: "implementation", mode: "write", isolation: "shared",
    }));
    const harnesses = Object.fromEntries(Object.keys(DEFAULT_CATALOG.harnesses).map((id) => [
      id, id === "codex" ? { binary: join(directory, "mock-codex.cjs") } : { enabled: false },
    ]));
    const preview = async (maxBytes: number | undefined) => {
      await client?.close();
      await writeFile(configPath, stringify({ defaults: { max_concurrency: 1, ...(maxBytes === undefined ? {} : { max_mcp_output_bytes: maxBytes }) }, harnesses }));
      const savedPlanLog = join(directory, `saved-${++previews}.log`);
      await connect({ savedPlanLog });
      const reply = await call<PlanPreviewResult & { error?: StructuredError }>("orch_plan_preview", { cwd: directory, subtasks });
      const saved = existsSync(savedPlanLog) ? (await readFile(savedPlanLog, "utf8")).split("\n").filter(Boolean) : [];
      return { ...reply, saved };
    };
    let previews = 0;
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    const full = (await preview(undefined)).data as unknown as Record<string, any>;
    expect(full.launchable).toBe(true);
    expect(full.markdown_table).toEqual(expect.any(String));
    expect(full.items.some((item: { alternatives?: unknown }) => item.alternatives !== undefined)).toBe(true);

    const { markdown_table: _table, ...noTable } = full;
    const { warnings: _warnings, ...noWarnings } = noTable;
    const bareItems = full.items.map(({ alternatives: _alternatives, ...item }: Record<string, unknown>) => item);
    const steps = [
      { name: "full", payload: full },
      { name: "no markdown_table", payload: noTable },
      { name: "no warnings", payload: noWarnings },
      { name: "no alternatives", payload: { ...noWarnings, items: bareItems } },
    ];
    expect(steps.map((step) => bytes(step.payload))).toEqual([...steps.map((step) => bytes(step.payload))].sort((a, b) => b - a));
    expect(new Set(steps.map((step) => bytes(step.payload))).size).toBe(steps.length);

    const savedPlans = new Set<string>();
    for (const [index, step] of steps.entries()) {
      const reply = await preview(bytes(step.payload));
      expect(reply.isError, step.name).toBe(false);
      const data = reply.data as unknown as Record<string, any>;
      expect(data.launchable, step.name).toBe(true);
      expect(data.plan_id, step.name).toMatch(/^plan_/);
      expect(Object.hasOwn(data, "markdown_table"), step.name).toBe(index === 0);
      expect(Object.hasOwn(data, "warnings"), step.name).toBe(index <= 1);
      expect(data.items.some((item: Record<string, unknown>) => Object.hasOwn(item, "alternatives")), step.name).toBe(index <= 2);
      expect(data.items, step.name).toHaveLength(subtasks.length);
      // A degraded plan is still saved, so its plan_id can be launched.
      const launched = await call<JobRecord>("orch_run", { plan_id: data.plan_id, subtask_id: "t0", cwd: directory, prompt: "complete" });
      expect(launched, step.name).toMatchObject({ isError: false, data: { status: "completed" } });
      // The plan is saved in the server's cache exactly once, under the ID that was returned.
      expect(reply.saved, step.name).toEqual([data.plan_id]);
      savedPlans.add(data.plan_id);
    }
    expect(savedPlans.size).toBe(steps.length);

    // Below the smallest step the generic error is returned and the plan is not saved.
    const tooSmall = await preview(bytes(steps[3].payload) - 1);
    expect(tooSmall).toMatchObject({ isError: true, data: { error: { code: "INTERNAL_ERROR", message: expect.stringContaining("max_mcp_output_bytes") } } });
    // An oversized reply must not leave behind a plan_id the host never received.
    expect(tooSmall.saved).toEqual([]);
  }, 60_000);

  it("marks an idempotency conflict unsafe to reroute and preserves the original job", async () => {
    await connect();
    const client_request_id = "same-request";
    const original = await run("complete", { client_request_id });
    expect(original.data.status).toBe("completed");
    const conflict = await run("changed", { client_request_id });
    expect(conflict).toMatchObject({ isError: true, data: { error: { code: "IDEMPOTENCY_CONFLICT", safe_to_reroute: false } } });
    const status = await call<StatusResponse>("orch_status");
    expect(status.data.jobs).toMatchObject([{ job_id: original.data.job_id, status: "completed" }]);
  });

  it("limits the serialized bytes of job and log replies while preserving UTF-8 and offsets", async () => {
    await connect();
    const output = await run("large");
    expect(output).toMatchObject({
      isError: false, data: { status: "completed", result: { truncated: true } },
    });
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(24_000);
    const first = await call<LogChunk>("orch_logs", { job_id: output.data.job_id });
    expect(first).toMatchObject({ isError: false, data: { eof: false, offset_bytes: 0 } });
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(24_000);
    const log = Buffer.from(LOG_PAYLOAD);
    expect(first.data.text).toBe(log.subarray(0, first.data.next_offset_bytes).toString("utf8"));
    const next = await call<LogChunk>("orch_logs", {
      job_id: output.data.job_id, offset_bytes: first.data.next_offset_bytes, limit_bytes: 8,
    });
    expect(next.data.text).toBe(log.subarray(next.data.offset_bytes, next.data.next_offset_bytes).toString("utf8"));
  });

  it("blocks recursion at ORCH_DEPTH=1 before creating a job", async () => {
    await connect({ depth: "1" });
    const reply = await call<{ error: StructuredError }>("orch_run", {
      cwd: directory, model: MODEL, mode: "readonly", prompt: "unused",
    });
    expect(reply).toMatchObject({ isError: true, data: { error: { code: "RECURSION_BLOCKED" } } });
    expect((await call<StatusResponse>("orch_status")).data).toEqual({ active_count: 0, queued_count: 0, jobs: [] });
    expect(existsSync(stateDir)).toBe(false);
  });

  it("cancels and reaps active jobs and stops queued jobs on stdin EOF", async () => {
    const transport = await connect({ observeExit: true });
    const serverPid = transport.pid!;
    const active = await run("hold", { async: true });
    const childPid = await mockPid();
    const queued = await run("complete", { async: true });
    expect(queued.data.status).toBe("queued");
    expect(isAlive(serverPid)).toBe(true);

    try {
      await client!.close();
      expect(await readFile(join(directory, "server.exit"), "utf8")).toBe("0");
      expect(existsSync(join(directory, "server.sigterm"))).toBe(false);
      expect(isAlive(serverPid)).toBe(false);
      expect(isAlive(childPid)).toBe(false);
      for (const { data: job } of [active, queued]) {
        const meta = JSON.parse(await readFile(join(job.log_path, "meta.json"), "utf8"));
        expect(meta).toMatchObject({ status: "cancelled", error: { code: "CANCELLED" } });
      }
    } finally {
      // Reap any orphan from a failing EOF test without disturbing other processes.
      if (isAlive(childPid)) process.kill(childPid, "SIGKILL");
    }
  }, 10_000);
});

describe("orch_status hold calibration over in-memory MCP", () => {
  const initialCap = 40_000;
  const hostLimit = 35_000;
  const learnedCap = 20_000;
  const progressInterval = 250;
  const waitArgs = { job_ids: ["live"], until: "any_terminal", wait_ms: 600_000 };
  let client: Client;
  let server: ReturnType<typeof createOrchestratorMcpServer>;
  let protocolErrors: string[];
  let progressFrames: unknown[];
  let configManager: ConfigManager;
  let adapterRegistry: AdapterRegistry;
  let runner: OrchestratorRunner<PlanPreviewResult>;
  let liveJob: JobRecord;
  let waitDetailed: ReturnType<typeof vi.fn<(options: WaitForStatusOptions) => Promise<WaitForStatusResult>>>;

  beforeEach(async () => {
    vi.stubEnv("ORCH_MCP_MAX_WAIT_MS", undefined);
    configManager = new ConfigManager({
      defaultPath: join(ROOT, "defaults", "catalog.toml"), userPath: join(ROOT, "defaults", "test-overrides.toml"),
    });
    const config = configManager.load();
    adapterRegistry = new AdapterRegistry();
    runner = new OrchestratorRunner<PlanPreviewResult>({ configManager, adapterRegistry });
    liveJob = {
      job_id: "live", version: 2, status: "running", harness: "codex", driver: "codex",
      model: MODEL, cli_model: MODEL, effort: "medium", mode: "readonly", isolation: "shared",
      security_guarantee: "os_sandbox", cwd: ROOT, effective_cwd: ROOT, log_path: ROOT, warnings: [],
      created_at: new Date().toISOString(),
    };
    vi.spyOn(configManager, "reloadIfChanged").mockReturnValue({
      ...config, defaults: { ...config.defaults, mcp_max_wait_sec: 0 }, harnesses: {},
    });
    vi.spyOn(runner, "listJobs").mockReturnValue([liveJob]);
    // orch_status rejects a call whose job_ids are all unknown, so the fixture IDs it waits on must exist.
    vi.spyOn(runner, "getJob").mockImplementation((jobId) => runner.listJobs().find((entry) => entry.job_id === jobId) ??
      (["other", "failed"].includes(jobId) ? { ...liveJob, job_id: jobId } : undefined));
    waitDetailed = vi.fn(({ waitMs = 0, signal }) => new Promise<WaitForStatusResult>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve({
          jobs: [liveJob], cursor: "opaque-fixture-cursor", wakeReason: "deadline",
          heldMs: waitMs, changedJobIds: [], activity: {},
        });
      }, waitMs);
      signal?.addEventListener("abort", onAbort, { once: true });
    }));
    vi.spyOn(runner, "waitForStatusDetailed").mockImplementation(waitDetailed);

    client = new Client({ name: "orch-calibration-smoke", version: "1.0.0" });
    protocolErrors = [];
    progressFrames = [];
    client.onerror = (error) => { protocolErrors.push(error.message); };
    server = createOrchestratorMcpServer({
      configManager, adapterRegistry, runner,
      initialHoldCapMs: initialCap, maxHoldCapMs: 180_000, progressIntervalMs: progressInterval, settleMs: 100,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const send = serverTransport.send.bind(serverTransport);
    vi.spyOn(serverTransport, "send").mockImplementation((message, options) => {
      if ("method" in message && message.method === "notifications/progress") progressFrames.push(message);
      return send(message, options);
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  });

  afterEach(async () => {
    try {
      await client?.close();
      await server?.close();
      expect(protocolErrors).toEqual([]);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  async function hold(args: Record<string, unknown> = waitArgs, options: RequestOptions = {}) {
    const reply = await client.callTool({ name: "orch_status", arguments: args }, undefined, { timeout: 600_000, ...options });
    expect(reply.isError).toBeFalsy();
    const content = (reply.content as Array<{ text: string }>)[0];
    return JSON.parse(content.text) as {
      wake_reason: string;
      held_ms: number;
      cursor?: string;
      jobs: Array<{ job_id: string; status: string }>;
      omitted_jobs?: number;
      next?: { args: Record<string, unknown> };
    };
  }

  it("clamps a hold without a progress token and sends no progress frames", async () => {
    const reply = hold();
    await vi.advanceTimersByTimeAsync(initialCap);
    expect(await reply).toMatchObject({ wake_reason: "deadline", held_ms: initialCap });
    expect(waitDetailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ waitMs: initialCap }));
    expect(progressFrames).toEqual([]);
  });

  it.each(["abort", "timeout"] as const)("learns a shorter cap from an SDK %s", async (reason) => {
    const controller = new AbortController();
    const pending = hold(waitArgs, reason === "abort" ? { signal: controller.signal } : { timeout: hostLimit });
    const rejected = expect(pending).rejects.toThrow(reason === "abort" ? "host stopped waiting" : "Request timed out");
    await vi.advanceTimersByTimeAsync(hostLimit);
    if (reason === "abort") controller.abort(new Error("host stopped waiting"));
    await rejected;
    expect(waitDetailed.mock.calls[0][0].signal?.aborted).toBe(true);

    const next = hold();
    await vi.advanceTimersByTimeAsync(learnedCap);
    expect(await next).toMatchObject({ wake_reason: "deadline", held_ms: learnedCap });
    expect(waitDetailed.mock.calls[1][0].waitMs).toBe(learnedCap);
  });

  it("ramps every continuation with progress and retains the conservative tokenless ceiling", async () => {
    let args: Record<string, unknown> = waitArgs;
    for (const cap of [initialCap, 90_000, 180_000]) {
      const pending = hold(args, { onprogress() {} });
      await vi.advanceTimersByTimeAsync(cap);
      const reply = await pending;
      expect(reply).toMatchObject({ wake_reason: "deadline", held_ms: cap, next: { args: { cursor: expect.any(String) } } });
      args = reply.next!.args;
    }
    expect(progressFrames.length).toBeGreaterThan(0);
    progressFrames.length = 0;
    const tokenless = hold();
    await vi.advanceTimersByTimeAsync(initialCap);
    expect(await tokenless).toMatchObject({ wake_reason: "deadline", held_ms: initialCap });
    expect(progressFrames).toEqual([]);
  });

  it("applies a learned cap immediately when a same-scope hold replaces an abandoned one", async () => {
    const abandoned = hold();
    await vi.advanceTimersByTimeAsync(hostLimit);
    const replacement = hold();
    await vi.advanceTimersByTimeAsync(initialCap);
    expect(await abandoned).toMatchObject({ wake_reason: "cancelled" });
    expect(await replacement).toMatchObject({ wake_reason: "deadline", held_ms: learnedCap });
    expect(waitDetailed.mock.calls[1][0].waitMs).toBe(learnedCap);
  });

  it("continues filtered waits within the same plan independently", async () => {
    const first = { ...waitArgs, plan_id: "plan", job_ids: ["live"], wait_ms: 100 };
    const second = { ...first, job_ids: ["other"] };
    const results = Promise.all([hold(first), hold(second)]);
    const [replies] = await Promise.all([results, vi.advanceTimersByTimeAsync(100)]);
    expect(replies).toMatchObject([first, second].map((args) => ({
      wake_reason: "deadline", next: { args },
    })));
  });

  it("advances the ramp one step when concurrent holds finish on the same step", async () => {
    const withProgress = { onprogress() {} };
    const holds = Promise.all([
      hold({ ...waitArgs, job_ids: ["live"] }, withProgress), hold({ ...waitArgs, job_ids: ["other"] }, withProgress),
    ]);
    await Promise.all([holds, vi.advanceTimersByTimeAsync(initialCap)]);
    const third = hold(waitArgs, withProgress);
    await vi.advanceTimersByTimeAsync(90_000);
    await third;
    expect(waitDetailed.mock.calls.map(([options]) => options.waitMs)).toEqual([initialCap, initialCap, 90_000]);
  });

  it("keeps holds with a different until mode independent and does not shrink the cap", async () => {
    const first = hold({ ...waitArgs, until: "any_terminal" });
    await vi.advanceTimersByTimeAsync(20_000);
    const second = hold({ ...waitArgs, until: "all_terminal" });
    await vi.advanceTimersByTimeAsync(initialCap);
    expect(await first).toMatchObject({ wake_reason: "deadline", held_ms: initialCap });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await second).toMatchObject({ wake_reason: "deadline", held_ms: initialCap });
    expect(waitDetailed.mock.calls.map(([options]) => options.waitMs)).toEqual([initialCap, initialCap]);
  });

  it("raises a learned cap after two clean holds at that cap", async () => {
    const controller = new AbortController();
    const pending = hold(waitArgs, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("host stopped waiting");
    await vi.advanceTimersByTimeAsync(hostLimit);
    controller.abort(new Error("host stopped waiting"));
    await rejected;

    for (let clean = 0; clean < 2; clean++) {
      const next = hold();
      await vi.advanceTimersByTimeAsync(learnedCap);
      await next;
    }
    const recovered = hold();
    await vi.advanceTimersByTimeAsync(30_000);
    await recovered;
    expect(waitDetailed.mock.calls.map(([options]) => options.waitMs)).toEqual([initialCap, learnedCap, learnedCap, 30_000]);
  });

  it("does not move the cursor past terminal jobs omitted by the byte budget", async () => {
    const jobs = Array.from({ length: 40 }, (_, index): JobRecord => ({
      ...liveJob, job_id: `done-${index}`, status: "completed", version: 3,
    }));
    const firstSeq = 10;
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({
      ...configManager.getSnapshot(), defaults: { ...configManager.getSnapshot().defaults, mcp_max_wait_sec: 0, max_mcp_output_bytes: 2_000 },
      harnesses: {},
    });
    waitDetailed.mockResolvedValue({
      jobs, cursor: "boot:500", wakeReason: "terminal", heldMs: 0, activity: {},
      changedJobIds: jobs.map((job) => job.job_id),
      jobSeqs: Object.fromEntries(jobs.map((job, index) => [job.job_id, { changeSeq: firstSeq + index, terminalSeq: firstSeq + index }])),
    });
    const reply = await hold({ until: "any_terminal", wait_ms: 100, plan_id: "plan" });
    expect(reply.omitted_jobs).toBeGreaterThan(0);
    expect(reply.jobs.length + reply.omitted_jobs!).toBe(jobs.length);
    // The first omitted job has terminalSeq firstSeq + shown, so the cursor stops just before it.
    expect(reply.cursor).toBe(`boot:${firstSeq + reply.jobs.length - 1}`);
  });

  it("pages through every terminal job the byte budget omitted by following next, without skipping a result", async () => {
    const jobs = Array.from({ length: 30 }, (_, index): JobRecord => ({
      ...liveJob, job_id: `page-${index}`, status: "completed", version: 3,
      result: { summary: `answer ${index}`, duration_ms: 1, truncated: false } as JobRecord["result"],
    }));
    const firstSeq = 10;
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({
      ...configManager.getSnapshot(), defaults: { ...configManager.getSnapshot().defaults, mcp_max_wait_sec: 0, max_mcp_output_bytes: 2_500 },
      harnesses: {},
    });
    vi.spyOn(runner, "getJob").mockImplementation((jobId) => jobs.find((entry) => entry.job_id === jobId));
    // Serves only the jobs whose terminal sequence is above the caller's cursor, like the real runner.
    waitDetailed.mockImplementation(async ({ cursor }) => {
      const seen = cursor?.startsWith("boot:") ? Number(cursor.slice("boot:".length)) : -1;
      const unseen = jobs.filter((_job, index) => firstSeq + index > seen);
      return {
        jobs: unseen, cursor: `boot:${firstSeq + jobs.length - 1}`, wakeReason: "terminal", heldMs: 0, activity: {},
        changedJobIds: unseen.map((job) => job.job_id),
        jobSeqs: Object.fromEntries(jobs.map((job, index) => [job.job_id, { changeSeq: firstSeq + index, terminalSeq: firstSeq + index }])),
      };
    });
    const collected: string[] = [];
    let args: Record<string, unknown> = { until: "any_terminal", wait_ms: 100, plan_id: "plan" };
    let rounds = 0;
    for (; rounds < jobs.length + 1; rounds++) {
      const reply = await hold(args) as Awaited<ReturnType<typeof hold>> & { pending_count: number; unseen_count?: number };
      collected.push(...reply.jobs.map((job) => job.job_id));
      expect(reply.pending_count).toBe(0);
      if (reply.omitted_jobs === undefined) {
        expect(reply).not.toHaveProperty("unseen_count");
        expect(reply).not.toHaveProperty("next");
        break;
      }
      expect(reply.unseen_count).toBe(reply.omitted_jobs);
      expect(reply.next).toMatchObject({ args: { plan_id: "plan", until: "any_terminal", wait_ms: 100, cursor: reply.cursor } });
      args = reply.next!.args;
    }
    expect(rounds).toBeGreaterThan(0);
    expect(collected).toEqual(jobs.map((job) => job.job_id));
  });

  it("waits for any_change without plan_id or job_ids when wait_ms is positive and returns a cursor", async () => {
    const waiting = hold({ until: "any_change", wait_ms: 100, cursor: "boot:5" });
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toMatchObject({ wake_reason: "deadline", cursor: "opaque-fixture-cursor" });
    expect(waitDetailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      until: "any_change", waitMs: 100, cursor: "boot:5", jobIds: undefined, planId: undefined,
    }));

    waitDetailed.mockClear();
    const [instant] = await Promise.all([hold({ until: "any_change", cursor: "boot:5" }), vi.advanceTimersByTimeAsync(1)]);
    expect(instant).toMatchObject({ cursor: "opaque-fixture-cursor" });
    expect(waitDetailed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ waitMs: 0 }));
  });

  it("survives a synchronous probeHarness throw without leaking the health ceiling timer", async () => {
    const config = configManager.getSnapshot();
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({ ...config, harnesses: { codex: config.harnesses.codex } });
    vi.spyOn(adapterRegistry, "probeHarness").mockImplementation(() => { throw new Error("synchronous adapter failure"); });
    const failed: JobRecord = {
      ...liveJob, job_id: "failed", status: "failed", role: "research",
      error: { code: "QUOTA_EXCEEDED", message: "Synthetic quota failure", retryable: false },
    };
    waitDetailed.mockResolvedValue({
      jobs: [failed], cursor: "opaque-fixture-cursor", wakeReason: "terminal", heldMs: 0, changedJobIds: ["failed"], activity: {},
    });
    const baseline = vi.getTimerCount();
    const reply = await hold({ ...waitArgs, job_ids: ["failed"] });
    expect(reply.jobs).toMatchObject([{ job_id: "failed", status: "failed" }]);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("keeps progress alive through the health ceiling and probes only uncached harnesses", async () => {
    const config = configManager.getSnapshot();
    const { codex, claude } = config.harnesses;
    const health = (id: "codex" | "claude"): HarnessHealth => ({
      harness: id, driver: id, enabled: true, installed: true, auth_status: "ready",
      security_guarantees: adapterRegistry.get(id).securityGuarantees, checked_at: new Date().toISOString(),
    });
    vi.spyOn(adapterRegistry.get("claude"), "probe").mockResolvedValue(health("claude"));
    await adapterRegistry.probeHarness("claude", claude);
    vi.spyOn(adapterRegistry.get("codex"), "probe").mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve(health("codex")), 10_000)));
    const probeHarness = vi.spyOn(adapterRegistry, "probeHarness");
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({ ...config, harnesses: { codex, claude } });
    const failed: JobRecord = {
      ...liveJob, job_id: "failed", status: "failed", role: "research",
      error: { code: "QUOTA_EXCEEDED", message: "Synthetic quota failure", retryable: false },
    };
    waitDetailed.mockResolvedValue({
      jobs: [liveJob, failed], cursor: "opaque-fixture-cursor", wakeReason: "terminal",
      heldMs: 0, changedJobIds: [failed.job_id], activity: {},
    });
    const args = { ...waitArgs, job_ids: [liveJob.job_id, failed.job_id] };
    const expected = {
      wake_reason: "terminal",
      jobs: [{ job_id: "failed", status: "failed", error: {
        suggested_alternatives: expect.arrayContaining([expect.objectContaining({ harness: "claude" })]),
      } }, { job_id: "live", status: "running" }],
    };
    const pending = hold(args, { timeout: 1_500, resetTimeoutOnProgress: true, onprogress() {} });
    const [reply] = await Promise.all([pending, vi.advanceTimersByTimeAsync(2_000)]);
    expect(reply).toMatchObject(expected);
    expect(progressFrames.length).toBeGreaterThan(1);
    expect(probeHarness.mock.calls.map(([id]) => id)).toEqual(["codex"]);

    const framesAtResult = progressFrames.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(progressFrames).toHaveLength(framesAtResult);
    // With both entries cached, no timer needs to run to produce the next response.
    await expect(hold(args)).resolves.toMatchObject(expected);
    expect(probeHarness).toHaveBeenCalledTimes(1);
  });

  it("does not let an older plan's exclusions mark an unfiltered status exhausted while another harness is healthy", async () => {
    const config = configManager.getSnapshot();
    const { codex, claude } = config.harnesses;
    vi.spyOn(adapterRegistry, "probeHarness").mockImplementation(async (harnessId) => ({
      harness: harnessId, driver: harnessId as "codex" | "claude", enabled: true, installed: true, auth_status: "ready",
      security_guarantees: adapterRegistry.get(harnessId as "codex" | "claude").securityGuarantees, checked_at: new Date().toISOString(),
    }));
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({ ...config, harnesses: { codex, claude } });
    // Claude is cooling down after the failure and the old plan excluded codex, which is still healthy.
    vi.spyOn(runner, "getRuntimeDegradations").mockReturnValue([{
      harness: "claude", code: "QUOTA_EXCEEDED", raw_error: "usage limit", scope: "harness",
      failed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(),
    }]);
    vi.spyOn(runner, "getPlan").mockImplementation((id) => (id === "old-plan"
      ? { plan_id: "old-plan", items: [], exclude_harnesses: ["codex"] } as unknown as PlanPreviewResult : undefined));
    const failed: JobRecord = {
      ...liveJob, job_id: "failed", status: "failed", harness: "claude", driver: "claude", model: "claude-opus-5-5",
      plan_id: "old-plan", exclude_harnesses: ["codex"],
      error: { code: "QUOTA_EXCEEDED", message: "Synthetic quota failure", retryable: false },
    };
    vi.mocked(runner.listJobs).mockReturnValue([failed]);
    const status = async (args: Record<string, unknown>) => {
      const reply = await client.callTool({ name: "orch_status", arguments: args }, undefined, { timeout: 600_000 });
      return JSON.parse((reply.content as Array<{ text: string }>)[0].text) as { delegation?: { state: string }; jobs: JobRecord[] };
    };

    const unfiltered = await status({});
    expect(unfiltered.delegation).toBeUndefined();
    // The job's own error stays scoped to its plan, and an explicit plan_id evaluates that plan's exclusions.
    expect(unfiltered.jobs[0].error?.delegation_state).toBe("exhausted");
    expect((await status({ plan_id: "old-plan" })).delegation).toMatchObject({ state: "exhausted", usable_count: 0 });
  });
});
