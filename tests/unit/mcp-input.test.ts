import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { ConfigManager } from "../../src/config/resolver.js";
import {
  invalidInputError, looseEnum, normalizeContextId, optBool, optInt, optNum, optObj, optObjList, optStr, optStrList,
  pickKnown, unknownArgsWarning,
} from "../../src/mcp/input.js";
import { createOrchestratorMcpServer } from "../../src/mcp/server.js";
import type { JobRecord, StructuredError } from "../../src/types.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const parse = <T extends z.ZodType>(schema: T, value: unknown) => schema.safeParse(value);
const accepted = <T extends z.ZodType>(schema: T, value: unknown): unknown => {
  const result = schema.safeParse(value);
  expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  return result.data;
};

describe("MCP input helpers", () => {
  it("builds the structured INVALID_INPUT error", () => {
    expect(invalidInputError("bad")).toEqual({ code: "INVALID_INPUT", message: "bad", retryable: false, failure_scope: "job", details: {} });
    expect(invalidInputError("bad", ["job_id"], { job_id: "x" }).details).toEqual({ missing: ["job_id"], example: { job_id: "x" } });
  });

  it("optStr turns null into undefined and honours the blank mode", () => {
    expect(accepted(optStr(), null)).toBeUndefined();
    expect(accepted(optStr(), undefined)).toBeUndefined();
    expect(accepted(optStr(), "  ")).toBeUndefined();
    expect(accepted(optStr(), " keep me ")).toBe(" keep me ");
    expect(accepted(optStr({ blank: "keep" }), "  ")).toBe("  ");
    expect(accepted(optStr({ blank: "keep" }), "")).toBe("");
    expect(accepted(optStr(), 42)).toBe("42");
    expect(parse(optStr({ max: 3 }), "abcd").success).toBe(false);
    expect(parse(optStr(), { nested: true }).success).toBe(false);
  });

  it("optInt parses numeric strings, clamps only the upper bound and rejects garbage", () => {
    const wait = optInt({ min: 0, clampMax: 600 });
    expect(accepted(wait, null)).toBeUndefined();
    expect(accepted(wait, "")).toBeUndefined();
    expect(accepted(wait, "600")).toBe(600);
    expect(accepted(wait, " 40 ")).toBe(40);
    expect(accepted(wait, 9_999)).toBe(600);
    expect(accepted(wait, "9999")).toBe(600);
    for (const bad of [-1, "-1", "abc", "1.5", 1.5, Number.NaN, "Infinity", true]) expect(parse(wait, bad).success, String(bad)).toBe(false);
    expect(accepted(optInt({ min: 1, max: 100, clampMax: 100, default: 20 }), null)).toBe(20);
    expect(accepted(optInt({ min: 1, max: 100, clampMax: 100, default: 20 }), "7")).toBe(7);
    expect(parse(optInt({ min: 1 }), 0).success).toBe(false);
  });

  it("optNum parses numeric strings and enforces positivity", () => {
    const seconds = optNum({ positive: true });
    expect(accepted(seconds, null)).toBeUndefined();
    expect(accepted(seconds, "")).toBeUndefined();
    expect(accepted(seconds, "900")).toBe(900);
    expect(accepted(seconds, "12.5")).toBe(12.5);
    expect(accepted(seconds, 3)).toBe(3);
    for (const bad of [0, "0", -2, "abc", "NaN"]) expect(parse(seconds, bad).success, String(bad)).toBe(false);
    expect(parse(optNum({ min: 2 }), "1").success).toBe(false);
  });

  it("optBool maps the string false to false and never guesses", () => {
    const flag = optBool();
    expect(accepted(flag, null)).toBeUndefined();
    expect(accepted(flag, "")).toBeUndefined();
    for (const [input, expected] of [
      [true, true], [false, false], ["true", true], ["false", false], [" FALSE ", false], ["True", true],
      ["1", true], ["0", false], [1, true], [0, false], ["yes", true], [" No ", false], ["YES", true],
    ] as const) expect(accepted(flag, input), String(input)).toBe(expected);
    for (const bad of ["maybe", "y", 2, {}]) expect(parse(flag, bad).success, String(bad)).toBe(false);
    expect(accepted(optBool(false), null)).toBe(false);
    expect(accepted(optBool(false), "false")).toBe(false);
    expect(accepted(optBool(false), "true")).toBe(true);
  });

  it("optStrList accepts a string, a JSON array string or an array and drops null elements", () => {
    const list = optStrList();
    expect(accepted(list, null)).toBeUndefined();
    expect(accepted(list, "")).toBeUndefined();
    expect(accepted(list, "codex")).toEqual(["codex"]);
    expect(accepted(list, ' ["a","b"] ')).toEqual(["a", "b"]);
    expect(accepted(list, ["a", null, "b"])).toEqual(["a", "b"]);
    expect(accepted(list, [""])).toEqual([""]);
    expect(accepted(list, "[not json")).toEqual(["[not json"]);
    expect(accepted(list, "codex,claude")).toEqual(["codex", "claude"]);
    expect(accepted(list, " codex , ,claude, ")).toEqual(["codex", "claude"]);
    expect(accepted(list, " , ")).toBeUndefined();
    expect(accepted(list, "[a,b")).toEqual(["[a,b"]);
    expect(accepted(list, ["a,b"])).toEqual(["a,b"]);
    expect(parse(list, [1]).success).toBe(false);
    expect(parse(list, 5).success).toBe(false);
  });

  it("optObjList accepts a JSON string, one object or an array", () => {
    const list = optObjList(z.object({ id: z.string() }));
    expect(accepted(list, null)).toBeUndefined();
    expect(accepted(list, "")).toBeUndefined();
    expect(accepted(list, { id: "a" })).toEqual([{ id: "a" }]);
    expect(accepted(list, '[{"id":"a"},{"id":"b"}]')).toEqual([{ id: "a" }, { id: "b" }]);
    expect(accepted(list, '{"id":"a"}')).toEqual([{ id: "a" }]);
    expect(accepted(list, [{ id: "a" }, null])).toEqual([{ id: "a" }]);
    expect(accepted(list, [])).toEqual([]);
    expect(parse(list, "not json").success).toBe(false);
    expect(parse(list, [{ id: 1 }]).success).toBe(false);
  });

  it("optObj accepts null, an object or its JSON string", () => {
    const object = optObj(z.object({ model: z.string().optional() }));
    expect(accepted(object, null)).toBeUndefined();
    expect(accepted(object, { model: "m" })).toEqual({ model: "m" });
    expect(accepted(object, '{"model":"m"}')).toEqual({ model: "m" });
    expect(parse(object, "nope").success).toBe(false);
  });

  it("looseEnum trims, lowercases and maps aliases", () => {
    const until = looseEnum(["any_change", "any_terminal", "all_terminal"], { any: "any_terminal", all: "all_terminal", changes: "any_change" }, "any_change");
    expect(accepted(until, null)).toBe("any_change");
    expect(accepted(until, "")).toBe("any_change");
    expect(accepted(until, " ANY ")).toBe("any_terminal");
    expect(accepted(until, "all")).toBe("all_terminal");
    expect(accepted(until, "changes")).toBe("any_change");
    expect(accepted(until, "any-terminal")).toBe("any_terminal");
    expect(parse(until, "sometimes").success).toBe(false);
    const mode = looseEnum(["readonly", "write"], { read_only: "readonly" });
    expect(accepted(mode, "read-only")).toBe("readonly");
    expect(accepted(mode, "Read_Only")).toBe("readonly");
    expect(accepted(mode, "write")).toBe("write");
    expect(accepted(mode, undefined)).toBeUndefined();
    expect(parse(mode, "constructor").success).toBe(false);
  });

  it("emits flat JSON Schema without anyOf or nullable types", () => {
    const schema = z.looseObject({
      text: optStr(), count: optInt({ min: 0, default: 3 }), ratio: optNum({ positive: true }), flag: optBool(false),
      names: optStrList(), items: optObjList(z.object({ id: optStr() })), choice: looseEnum(["a", "b"], { x: "a" }, "a"),
    });
    const json = JSON.stringify(z.toJSONSchema(schema, { target: "draft-7", io: "input" }));
    expect(json).not.toContain("anyOf");
    expect(json).not.toContain("oneOf");
    expect(json).not.toContain('"null"');
    expect(json).not.toContain('"required"');
  });

  it("pickKnown drops undeclared keys", () => {
    expect(pickKnown({ a: 1, b: 2, c: 3 }, ["a", "c"])).toEqual({ a: 1, c: 3 });
  });

  it("unknownArgsWarning names ignored keys with a suggestion and never echoes values", () => {
    const known = ["job_id", "cleanup_worktree", "prompt"];
    expect(unknownArgsWarning({ job_id: "x" }, known)).toBeUndefined();
    const warning = unknownArgsWarning({ jobId: "SECRET-VALUE", cleanupWorktree: true, mystery: "SECRET-VALUE", prompt: "SECRET-VALUE" }, known);
    expect(warning?.ignored_arguments).toEqual([
      'jobId (did you mean "job_id"?)', 'cleanupWorktree (did you mean "cleanup_worktree"?)', "mystery",
    ]);
    expect(JSON.stringify(warning)).not.toContain("SECRET-VALUE");
    const many = Object.fromEntries(Array.from({ length: 14 }, (_unused, index) => [`zz${index}${"x".repeat(80)}`, 1]));
    const capped = unknownArgsWarning(many, known)!.ignored_arguments;
    expect(capped).toHaveLength(11);
    expect(capped.at(-1)).toBe("+4 more");
    expect(capped[0].length).toBeLessThan(60);
  });

  it("unknownArgsWarning gives no suggestion for an oversized key and only counts keys past the display cap", () => {
    const known = ["job_id", "cleanup_worktree", "task_type"];
    // Punctuation-insensitively this equals "task_type"; at this length it is not a typo of any declared key and is not compared.
    expect(unknownArgsWarning({ [`task_type${"-".repeat(200)}`]: 1 }, known)?.ignored_arguments).toEqual([`task_type${"-".repeat(39)}...`]);
    expect(unknownArgsWarning({ "task-type": 1 }, known)?.ignored_arguments).toEqual(['task-type (did you mean "task_type"?)']);
    const flood = Object.fromEntries(Array.from({ length: 5_000 }, (_unused, index) => [`k${index}`, 1]));
    const flooded = unknownArgsWarning(flood, known)!.ignored_arguments;
    expect(flooded).toHaveLength(11);
    expect(flooded.at(-1)).toBe("+4990 more");
  });

  it("unknownArgsWarning also reports unknown keys of nested objects with their path and known misplacements", () => {
    const nested = [
      { path: "subtasks[0].", raw: { id: "a", model: "SECRET-VALUE", taskType: "review" }, knownKeys: ["id", "task_type", "override"],
        hints: { model: "override.model" } },
      { path: "subtasks[1].", raw: { id: "b", constructor: 1 }, knownKeys: ["id", "task_type", "override"], hints: { model: "override.model" } },
    ];
    const warning = unknownArgsWarning({ stray: 1 }, ["subtasks"], nested);
    expect(warning?.ignored_arguments).toEqual([
      "stray", 'subtasks[0].model (did you mean "override.model"?)', 'subtasks[0].taskType (did you mean "task_type"?)', "subtasks[1].constructor",
    ]);
    expect(JSON.stringify(warning)).not.toContain("SECRET-VALUE");
    expect(unknownArgsWarning({}, ["subtasks"], [{ path: "subtasks[0].", raw: { id: "a" }, knownKeys: ["id"] }])).toBeUndefined();
  });

  it("normalizeContextId trims and rejects blank or oversized IDs with INVALID_INPUT", () => {
    expect(normalizeContextId(undefined)).toBeUndefined();
    expect(normalizeContextId(" task-1 ")).toBe("task-1");
    expect(() => normalizeContextId("   ")).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => normalizeContextId("x".repeat(129))).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

describe("orch_* tools accept lenient arguments over MCP", () => {
  const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
    job_id: "job-1", version: 1, status: "completed", harness: "codex", driver: "codex", model: "m", cli_model: "m", effort: "medium",
    mode: "readonly", isolation: "shared", security_guarantee: "os_sandbox", cwd: ROOT, effective_cwd: ROOT, log_path: ROOT,
    warnings: [], created_at: new Date().toISOString(), ...overrides,
  });
  const runner = {
    savePlan: vi.fn(), getPlan: vi.fn(), getRuntimeDegradations: vi.fn(() => []), clearRuntimeDegradations: vi.fn(),
    run: vi.fn(), getJob: vi.fn(), listJobs: vi.fn(() => [] as JobRecord[]), waitForStatus: vi.fn(async () => [] as JobRecord[]),
    readLogs: vi.fn(), cancelJob: vi.fn(), shutdown: vi.fn(),
  };
  let client: Client;
  let configManager: ConfigManager;
  let adapterRegistry: AdapterRegistry;
  let server: ReturnType<typeof createOrchestratorMcpServer>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // orch_status rejects a call whose job_ids are all unknown, so getJob must see the jobs that listJobs returns.
    runner.getJob.mockImplementation((jobId: string) => runner.listJobs().find((entry) => entry.job_id === jobId));
    configManager = new ConfigManager({
      defaultPath: join(ROOT, "defaults", "catalog.toml"), userPath: join(ROOT, "defaults", "test-overrides.toml"),
    });
    const config = configManager.load();
    vi.spyOn(configManager, "reloadIfChanged").mockReturnValue({ ...config, harnesses: {} });
    adapterRegistry = new AdapterRegistry();
    server = createOrchestratorMcpServer({
      configManager, adapterRegistry, runner: runner as never, initialHoldCapMs: 1_000, maxHoldCapMs: 1_000, settleMs: 0,
    });
    client = new Client({ name: "mcp-input-test", version: "1.0.0" });
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
    return { data: JSON.parse(text) as T, text, isError: reply.isError === true };
  }

  it("publishes flat input schemas for all six tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "orch_cancel", "orch_catalog", "orch_logs", "orch_plan_preview", "orch_run", "orch_status",
    ]);
    for (const tool of tools) {
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toContain("anyOf");
      expect(schema, tool.name).not.toContain("oneOf");
      expect(schema, tool.name).not.toMatch(/"type":\s*\[/);
      expect(schema, tool.name).not.toContain('"null"');
      expect(tool.inputSchema.required, tool.name).toBeUndefined();
    }
    const run = tools.find((tool) => tool.name === "orch_run")!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(run)).toEqual(expect.arrayContaining(["fresh", "cwd", "prompt"]));
    expect(Object.keys(run)).not.toContain("prompt_file");
    const logs = tools.find((tool) => tool.name === "orch_logs")!.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(logs.part.enum).toContain("checkpoint");
  });

  it("orch_catalog takes null, blank, numeric-string and string-boolean arguments", async () => {
    const sloppy = await call<{ models: unknown[]; offset: number; returned: number }>("orch_catalog", {
      detail: null, search: "", task_type: " ", preset: "", include_preset_roles: "false", harness: null, tier: "", include_unavailable: "true",
      refresh_health: "false", limit: "3", offset: "0",
    });
    expect(sloppy.isError).toBe(false);
    expect(sloppy.data.returned).toBe(3);
    // Explicit false is preserved: the full view otherwise includes unavailable models, and no harness is ready here.
    const full = await call<{ models: unknown[] }>("orch_catalog", { detail: "FULL", include_unavailable: "false", limit: 100 });
    const defaulted = await call<{ models: unknown[] }>("orch_catalog", { detail: "full", limit: 100 });
    expect(full.data.models).toHaveLength(0);
    expect(defaulted.data.models.length).toBeGreaterThan(0);
    const clamped = await call<{ returned: number }>("orch_catalog", { limit: 5_000 });
    expect(clamped.isError).toBe(false);
  });

  it("orch_catalog fails with a clear error instead of an endless empty page when one full model card exceeds the byte budget", async () => {
    const snapshot = configManager.getSnapshot();
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({
      ...snapshot, defaults: { ...snapshot.defaults, max_mcp_output_bytes: 1 }, harnesses: {},
    });
    for (const detail of ["brief", "full"]) {
      const reply = await call<{ error: StructuredError; models?: unknown[]; next_offset?: number }>(
        "orch_catalog", { detail, limit: 100, include_unavailable: true });
      expect(reply.isError, detail).toBe(true);
      expect(reply.data.error, detail).toMatchObject({ code: "INTERNAL_ERROR", message: expect.stringContaining("to fit a model card") });
      expect(reply.data, detail).not.toHaveProperty("next_offset");
    }
  });

  it("orch_plan_preview answers a missing or empty subtasks list with INVALID_INPUT details", async () => {
    for (const subtasks of [undefined, null, [], "", "[]"]) {
      const reply = await call<{ error: StructuredError }>("orch_plan_preview", subtasks === undefined ? {} : { subtasks });
      expect(reply.isError).toBe(true);
      expect(reply.data.error).toMatchObject({ code: "INVALID_INPUT", retryable: false, details: {
        missing: ["subtasks"], example: { subtasks: [expect.objectContaining({ id: "review", task_type: "review" })] },
      } });
    }
    const partial = await call<{ error: StructuredError }>("orch_plan_preview", { subtasks: [{ title: "x" }, { id: "b", task_type: " " }] });
    expect(partial.data.error).toMatchObject({ code: "INVALID_INPUT", details: {
      missing: ["subtasks[0].id", "subtasks[0].task_type", "subtasks[1].task_type"],
    } });
  });

  it("orch_plan_preview rejects a blank context_id with INVALID_INPUT instead of a protocol error", async () => {
    const reply = await call<{ error: StructuredError }>("orch_plan_preview", {
      context_id: "   ", subtasks: [{ id: "a", task_type: "review" }],
    });
    expect(reply).toMatchObject({ isError: true, data: { error: { code: "INVALID_INPUT", message: expect.stringContaining("context_id") } } });
  });

  it("orch_plan_preview reports unknown subtask keys with their path and where a misplaced key belongs", async () => {
    const misplaced = await call<{ error: StructuredError; ignored_arguments: string[] }>("orch_plan_preview", {
      stray: 1, subtasks: [{ id: "a", task_type: "review", model: "opus", effort: "high" }, { id: "b", taskType: "review" }],
    });
    expect(misplaced.data.ignored_arguments).toEqual([
      "stray", 'subtasks[0].model (did you mean "override.model"?)', 'subtasks[0].effort (did you mean "override.effort"?)',
      'subtasks[1].taskType (did you mean "task_type"?)',
    ]);
    // The typo is also the cause of this failure, so the failed reply must carry the warning.
    expect(misplaced.data.error).toMatchObject({ code: "INVALID_INPUT", details: { missing: ["subtasks[1].task_type"] } });
    expect(misplaced.text).not.toContain("opus");
  });

  it("orch_plan_preview rejects an out-of-range shard count with a precise INVALID_INPUT instead of silently clamping it", async () => {
    // Each shard is a separate paid model run, so a count above the limit is rejected, never lowered.
    for (const shards of [9, "20", 0, -1]) {
      const reply = await call<{ error: StructuredError }>("orch_plan_preview", { subtasks: [{ id: "a", task_type: "review", shards }] });
      expect(reply, String(shards)).toMatchObject({ isError: true, data: { error: {
        code: "INVALID_INPUT", message: expect.stringContaining("subtasks[0].shards must be an integer from 1 to 8"),
        details: { example: { subtasks: [expect.objectContaining({ shards: expect.any(Number) })] } },
      } } });
    }
    // In range it gets past input validation (no harness is available in this fixture, so the preview itself stops later).
    for (const shards of [1, 8, "3"]) {
      const reply = await call<{ error: StructuredError }>("orch_plan_preview", { subtasks: [{ id: "a", task_type: "review", shards }] });
      expect(reply.data.error.code, String(shards)).toBe("DELEGATION_UNAVAILABLE");
    }
  });

  it("orch_plan_preview keeps the delegation hard stop under a minimal byte budget when the preview throws it", async () => {
    const arguments_ = { subtasks: [{ id: "a", task_type: "review" }], stray: 1 };
    const full = await call<{ plan_id: null; error: StructuredError; ignored_arguments: string[] }>("orch_plan_preview", arguments_);
    expect(full).toMatchObject({ isError: true, data: {
      plan_id: null, launchable: false, delegation_status: "exhausted", blocked_reason: "DELEGATION_UNAVAILABLE", ignored_arguments: ["stray"],
      error: { code: "DELEGATION_UNAVAILABLE", retryable: false, safe_to_reroute: false, details: { all_delegation_models_unavailable: true } },
    } });
    const snapshot = configManager.getSnapshot();
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({
      ...snapshot, defaults: { ...snapshot.defaults, max_mcp_output_bytes: 1 }, harnesses: {},
    });
    const tight = await call<{ plan_id: null; error: StructuredError }>("orch_plan_preview", arguments_);
    expect(tight).toMatchObject({ isError: true, data: {
      plan_id: null, launchable: false, delegation_status: "exhausted", blocked_reason: "DELEGATION_UNAVAILABLE",
      error: { code: "DELEGATION_UNAVAILABLE", retryable: false, failure_scope: "harness", safe_to_reroute: false, delegation_state: "exhausted" },
    } });
  });

  it("orch_run passes optional cwd and prompt through untouched and drops undeclared keys", async () => {
    runner.run.mockResolvedValue(job());
    const reply = await call("orch_run", {
      plan_id: "plan_1", subtask_id: "a", cwd: null, prompt: null, mode: "read-only", isolation: "Worktree", async: "true", fresh: "false",
      inherit_mcp: null, wait_ms: "99999999", timeout_sec: "900", client_request_id: null, label: "", system_context: " ", model: null,
      continue_from_job_id: "", promptt: "TOP-SECRET-PROMPT",
    });
    expect(reply.isError).toBe(false);
    expect(runner.run).toHaveBeenCalledTimes(1);
    const request = runner.run.mock.calls[0][0] as Record<string, unknown>;
    expect(request).toMatchObject({
      plan_id: "plan_1", subtask_id: "a", mode: "readonly", isolation: "worktree", async: true, fresh: false, wait_ms: 600_000, timeout_sec: 900,
    });
    for (const key of ["cwd", "prompt", "inherit_mcp", "client_request_id", "label", "system_context", "model", "continue_from_job_id"]) {
      expect(request[key], key).toBeUndefined();
    }
    expect(Object.keys(request)).not.toContain("promptt");
    expect(reply.data).toMatchObject({ job_id: "job-1", ignored_arguments: ['promptt (did you mean "prompt"?)'] });
    expect(reply.text).not.toContain("TOP-SECRET-PROMPT");
  });

  it("orch_run keeps blank prompt, cwd, context_id and client_request_id so the runner can reject them", async () => {
    runner.run.mockResolvedValue(job());
    await call("orch_run", { prompt: "  ", cwd: "", context_id: " ", client_request_id: "" });
    expect(runner.run.mock.calls[0][0]).toMatchObject({ prompt: "  ", cwd: "", context_id: " ", client_request_id: "" });
  });

  it("orch_run delivers INVALID_INPUT details and resume hints from the runner", async () => {
    const invalid = invalidInputError("prompt is required", ["prompt"], { prompt: "Do the task. Reply in English." });
    runner.run.mockRejectedValueOnce(invalid);
    const rejected = await call<{ error: StructuredError }>("orch_run", { plan_id: "plan_1" });
    expect(rejected).toMatchObject({ isError: true, data: { error: {
      code: "INVALID_INPUT", safe_to_reroute: false, details: { missing: ["prompt"], example: { prompt: "Do the task. Reply in English." } },
    } } });

    const timeout: StructuredError = {
      code: "TIMEOUT", message: "Timed out.", retryable: true, retry_same_model: true, suggested_timeout_sec: 1800,
      has_partial_progress: true, resume: { tool: "orch_run", args: { continue_from_job_id: "job-1", timeout_sec: 1800 } },
    };
    runner.run.mockRejectedValueOnce(timeout);
    const timedOut = await call<{ error: StructuredError }>("orch_run", { plan_id: "plan_1", prompt: "x", cwd: ROOT });
    expect(timedOut.data.error).toMatchObject({ code: "TIMEOUT", has_partial_progress: true, resume: timeout.resume });
  });

  it("orch_run keeps resume hints and INVALID_INPUT details when a failed job reply is compacted", async () => {
    const failed = job({
      status: "timed_out", result: { summary: "x".repeat(40_000), truncated: false } as JobRecord["result"],
      error: { code: "TIMEOUT", message: "Timed out.", retryable: true, has_partial_progress: true,
        resume: { tool: "orch_run", args: { continue_from_job_id: "job-1" } } },
    });
    runner.run.mockResolvedValue(failed);
    const reply = await call<JobRecord>("orch_run", { plan_id: "p", subtask_id: "a", prompt: "x", cwd: ROOT });
    expect(reply.data.error).toMatchObject({ has_partial_progress: true, resume: { tool: "orch_run", args: { continue_from_job_id: "job-1" } } });
  });

  it.each([24_000, 4_000, 1_200])(
    "orch_run keeps INVALID_INPUT details.missing and details.example within a %i byte budget when the failed job is oversized",
    async (bytes) => {
      const snapshot = configManager.getSnapshot();
      vi.mocked(configManager.reloadIfChanged).mockReturnValue({ ...snapshot, defaults: { ...snapshot.defaults, max_mcp_output_bytes: bytes }, harnesses: {} });
      const example = { prompt: "Do the task. Reply in English.", cwd: "/abs/project" };
      runner.run.mockResolvedValueOnce(job({
        job_id: "job-invalid", status: "failed", result: { summary: "s".repeat(60_000), truncated: false } as JobRecord["result"],
        error: {
          code: "INVALID_INPUT", message: `bad input ${"m".repeat(40_000)}`, retryable: false, raw_error: "r".repeat(40_000),
          stderr_tail: "e".repeat(40_000), details: { missing: ["prompt", "cwd"], example },
        },
      }));
      const reply = await call<JobRecord>("orch_run", { plan_id: "p", subtask_id: "a", prompt: "x", cwd: ROOT });
      expect(Buffer.byteLength(reply.text), `${bytes} bytes`).toBeLessThanOrEqual(bytes);
      expect(reply.text).not.toContain("exceeds max_mcp_output_bytes");
      expect(reply.data).toMatchObject({ job_id: "job-invalid", status: "failed" });
      expect(reply.data.error).toMatchObject({ code: "INVALID_INPUT", details: { missing: ["prompt", "cwd"], example } });
    },
  );

  it("orch_status merges job_id into job_ids and rejects blank or conflicting IDs", async () => {
    runner.listJobs.mockReturnValue([job({ job_id: "a" }), job({ job_id: "b" })]);
    const single = await call<{ jobs: Array<{ job_id: string }> }>("orch_status", { job_id: "a", job_ids: null, until: "", cursor: null, wait_ms: null });
    expect(single.data.jobs.map((entry) => entry.job_id)).toEqual(["a"]);
    const both = await call<{ jobs: Array<{ job_id: string }> }>("orch_status", { job_id: ["b", "a"], job_ids: '["a","b"]', since_version: "0" });
    expect(both.data.jobs).toHaveLength(2);
    const conflict = await call<{ error: StructuredError }>("orch_status", { job_id: "a", job_ids: ["b"] });
    expect(conflict).toMatchObject({ isError: true, data: { error: { code: "INVALID_INPUT", details: { example: expect.any(Object) } } } });
    const blank = await call<{ error: StructuredError }>("orch_status", { job_ids: ["a", " "] });
    expect(blank).toMatchObject({ isError: true, data: { error: { code: "INVALID_INPUT", details: { missing: ["job_ids"] } } } });
    const blankAlias = await call<{ error: StructuredError }>("orch_status", { job_id: ["", "a"] });
    expect(blankAlias.data.error.code).toBe("INVALID_INPUT");
  });

  it("orch_status canonicalizes ids into next.args, maps until aliases and lowers an oversized wait_ms with a warning", async () => {
    const running = job({ job_id: "a", status: "running" });
    runner.listJobs.mockReturnValue([running]);
    runner.waitForStatus.mockResolvedValue([running]);
    const reply = await call<{ next: { args: Record<string, unknown> }; warnings: string[]; pending_count: number }>("orch_status", {
      job_id: "a", until: "ANY", wait_ms: "9999999",
    });
    expect(reply.isError).toBe(false);
    expect(reply.data.pending_count).toBe(1);
    expect(reply.data.next.args).toMatchObject({ job_ids: ["a"], until: "any_terminal", wait_ms: 600_000 });
    expect(reply.data.next.args).not.toHaveProperty("job_id");
    expect(reply.data.warnings).toEqual([expect.stringContaining("600000")]);
    expect(runner.waitForStatus).toHaveBeenCalledWith(expect.objectContaining({ jobIds: ["a"], until: "any_terminal" }));
    runner.waitForStatus.mockClear();
    await call("orch_status", { job_id: "a", until: "Terminal", wait_ms: "1" });
    expect(runner.waitForStatus).toHaveBeenCalledWith(expect.objectContaining({ jobIds: ["a"], until: "any_terminal" }));
  });

  it("orch_status rejects a call whose job_ids are all unknown instead of reporting an empty terminal result", async () => {
    runner.listJobs.mockReturnValue([job({ job_id: "a" })]);
    for (const args of [{ job_ids: ["ghost"] }, { job_id: "ghost", until: "all_terminal" }, { job_ids: ["ghost", "phantom"], until: "any_change" }]) {
      const reply = await call<{ error: StructuredError; wake_reason?: string; jobs?: unknown[] }>("orch_status", args);
      expect(reply.isError, JSON.stringify(args)).toBe(true);
      expect(reply.data.error).toMatchObject({
        code: "INVALID_INPUT", retryable: false,
        details: { unknown_job_ids: expect.arrayContaining(["ghost"]), example: { job_ids: ["<job_id>"] } },
      });
      expect(reply.data).not.toHaveProperty("wake_reason");
      expect(reply.data).not.toHaveProperty("jobs");
    }
    expect(runner.waitForStatus).not.toHaveBeenCalled();
  });

  it("orch_status keeps serving the known jobs and names the unknown ones in unknown_job_ids", async () => {
    const known = job({ job_id: "a" });
    runner.listJobs.mockReturnValue([known]);
    runner.waitForStatus.mockResolvedValue([known]);
    for (const args of [{ job_ids: ["a", "ghost"], until: "any_change" }, { job_ids: ["a", "ghost"], until: "all_terminal" }]) {
      const reply = await call<{ jobs: Array<{ job_id: string }>; unknown_job_ids: string[] }>("orch_status", args);
      expect(reply.isError, JSON.stringify(args)).toBe(false);
      expect(reply.data.jobs.map((entry) => entry.job_id)).toEqual(["a"]);
      expect(reply.data.unknown_job_ids).toEqual(["ghost"]);
    }
    const allKnown = await call<Record<string, unknown>>("orch_status", { job_ids: ["a"], until: "any_change" });
    expect(allKnown.data).not.toHaveProperty("unknown_job_ids");
    // Without job_ids the call is a session listing, never an unknown-ID error.
    expect((await call("orch_status", { until: "any_change" })).isError).toBe(false);
  });

  it("orch_status offers next and unseen_count when the byte budget cut off terminal jobs", async () => {
    const finished = Array.from({ length: 12 }, (_unused, index) => job({
      job_id: `done-${index}`, status: "completed",
      result: { summary: "S".repeat(900), duration_ms: 5, truncated: false } as JobRecord["result"],
    }));
    runner.listJobs.mockReturnValue(finished);
    runner.waitForStatus.mockResolvedValue(finished);
    const snapshot = configManager.getSnapshot();
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({
      ...snapshot, defaults: { ...snapshot.defaults, max_mcp_output_bytes: 4_000 }, harnesses: {},
    });
    const truncated = await call<{ omitted_jobs: number; unseen_count: number; pending_count: number; jobs: unknown[];
      next: { tool: string; args: Record<string, unknown> } }>("orch_status", { plan_id: "plan", until: "all_terminal", wait_ms: 100 });
    expect(truncated.data.omitted_jobs).toBeGreaterThan(0);
    expect(truncated.data.jobs.length + truncated.data.omitted_jobs).toBe(finished.length);
    expect(truncated.data).toMatchObject({
      pending_count: 0, unseen_count: truncated.data.omitted_jobs,
      next: { tool: "orch_status", args: { plan_id: "plan", until: "all_terminal", wait_ms: 100 } },
    });

    vi.mocked(configManager.reloadIfChanged).mockReturnValue({ ...snapshot, harnesses: {} });
    const complete = await call<Record<string, unknown>>("orch_status", { plan_id: "plan", until: "all_terminal", wait_ms: 100 });
    expect(complete.data).not.toHaveProperty("unseen_count");
    expect(complete.data).not.toHaveProperty("next");
    expect(complete.data).not.toHaveProperty("omitted_jobs");
  });

  it("orch_plan_preview reports unknown keys inside subtasks[].override, including a JSON-string override", async () => {
    const reply = await call<{ ignored_arguments: string[] }>("orch_plan_preview", {
      subtasks: [
        { id: "a", task_type: "review", override: { harnes: "claude", model: "opus", efort: "high" } },
        { id: "b", task_type: "review", override: '{"mdel":"opus"}' },
        { id: "c", task_type: "review", override: { harness: "claude" } },
      ],
    });
    expect(reply.data.ignored_arguments).toEqual([
      'subtasks[0].override.harnes (did you mean "harness"?)', 'subtasks[0].override.efort (did you mean "effort"?)',
      'subtasks[1].override.mdel (did you mean "model"?)',
    ]);
  });

  describe("exhausted delegation under a tiny byte budget", () => {
    const harnessCodes = ["QUOTA_EXCEEDED", "PROVIDER_OVERLOADED", "HARNESS_UNAVAILABLE"] as const;

    function tightBudget(bytes: number): void {
      const snapshot = configManager.getSnapshot();
      vi.mocked(configManager.reloadIfChanged).mockReturnValue({ ...snapshot, defaults: { ...snapshot.defaults, max_mcp_output_bytes: bytes }, harnesses: {} });
    }

    it.each(harnessCodes)("orch_run keeps delegation.state exhausted and the %s code when even the core error does not fit", async (code) => {
      runner.run.mockRejectedValueOnce({ code, message: `Synthetic ${"long ".repeat(80)}failure`, retryable: false });
      const roomy = await call<{ delegation: { state: string }; error: StructuredError }>("orch_run", { plan_id: "plan_1", subtask_id: "a" });
      expect(roomy.data).toMatchObject({ delegation: { state: "exhausted" }, error: { code, delegation_state: "exhausted" } });
      tightBudget(1);
      runner.run.mockRejectedValueOnce({ code, message: `Synthetic ${"long ".repeat(80)}failure`, retryable: false });
      const tight = await call<Record<string, unknown>>("orch_run", { plan_id: "plan_1", subtask_id: "a" });
      expect(tight.isError).toBe(true);
      expect(tight.data).toEqual({ delegation: { state: "exhausted" }, error: { code, delegation_state: "exhausted", retryable: false } });
    });

    it("orch_run keeps it when the failed job itself is too large for the budget", async () => {
      runner.run.mockResolvedValueOnce(job({
        job_id: "job-big-failure", status: "failed",
        error: { code: "QUOTA_EXCEEDED", message: "limit ".repeat(100), retryable: false, raw_error: "raw ".repeat(100) },
      }));
      tightBudget(1);
      const tight = await call<Record<string, unknown>>("orch_run", { plan_id: "plan_1", subtask_id: "a" });
      expect(tight.isError).toBe(true);
      expect(tight.data).toMatchObject({ delegation: { state: "exhausted" }, error: { code: "QUOTA_EXCEEDED", delegation_state: "exhausted" } });
      expect(tight.data).not.toHaveProperty("error.message");
    });

    it("never turns the exhaustion signal into the generic oversized error, whatever the budget", async () => {
      for (const bytes of [1, 50, 120, 200, 300]) {
        tightBudget(bytes);
        runner.run.mockRejectedValueOnce({ code: "QUOTA_EXCEEDED", message: "limit ".repeat(100), retryable: false });
        const reply = await call<{ delegation?: { state: string }; error: StructuredError }>("orch_run", { plan_id: "plan_1", subtask_id: "a" });
        expect(reply.data.delegation, `${bytes} bytes`).toMatchObject({ state: "exhausted" });
        expect(reply.data.error.message ?? "", `${bytes} bytes`).not.toContain("exceeds max_mcp_output_bytes");
      }
    });
  });

  it("orch_run judges delegation by the failed job's own mode when the sandbox policy forbids it", async () => {
    const snapshot = configManager.getSnapshot();
    const codexModels = Object.fromEntries(Object.entries(snapshot.models).map(([id, model]) => [id, { ...model, enabled: id === "gpt-6.2-sol" }]));
    vi.mocked(configManager.reloadIfChanged).mockReturnValue({
      ...snapshot, models: codexModels, harnesses: { codex: { ...snapshot.harnesses.codex, enabled: true } },
      defaults: { ...snapshot.defaults, allow_unsandboxed_write: false },
    });
    vi.spyOn(adapterRegistry, "getCachedHealth").mockReturnValue({
      harness: "codex", driver: "codex", enabled: true, installed: true, auth_status: "ready",
      security_guarantees: { readonly: "os_sandbox", write: "unsandboxed" }, checked_at: new Date().toISOString(),
    });
    const failure = { code: "QUOTA_EXCEEDED", message: "limit reached", retryable: false };
    runner.run.mockRejectedValueOnce(failure);
    const write = await call<{ delegation?: { state: string; blocked_by_harness: Record<string, string> }; error: StructuredError }>(
      "orch_run", { model: "gpt-6.2-sol", mode: "write", prompt: "x" });
    expect(write.data.delegation).toMatchObject({ state: "exhausted", blocked_by_harness: { codex: "sandbox_policy" } });
    expect(write.data.error.delegation_state).toBe("exhausted");
    runner.run.mockRejectedValueOnce(failure);
    const readonly = await call<{ delegation?: unknown; error: StructuredError }>("orch_run", { model: "gpt-6.2-sol", mode: "readonly", prompt: "x" });
    expect(readonly.data).not.toHaveProperty("delegation");
    expect(readonly.data.error.delegation_state).toBe("available");
  });

  it("orch_logs and orch_cancel answer a missing or blank job_id with INVALID_INPUT and an example", async () => {
    for (const name of ["orch_logs", "orch_cancel"]) {
      for (const args of [{}, { job_id: null }, { job_id: "  " }, { jobid: "job-1" }]) {
        const reply = await call<{ error: StructuredError; ignored_arguments?: string[] }>(name, args);
        expect(reply.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
        expect(reply.data.error).toMatchObject({ code: "INVALID_INPUT", details: { missing: ["job_id"], example: { job_id: expect.any(String) } } });
        if ("jobid" in args) expect(reply.data.ignored_arguments).toEqual(['jobid (did you mean "job_id"?)']);
      }
    }
    expect(runner.readLogs).not.toHaveBeenCalled();
    expect(runner.cancelJob).not.toHaveBeenCalled();
  });

  it("orch_logs normalizes part aliases and numeric strings", async () => {
    runner.readLogs.mockResolvedValue({ text: "hi", offset_bytes: 0, next_offset_bytes: 2, total_bytes: 2, eof: true });
    const reply = await call("orch_logs", { job_id: "job-1", part: "Checkpoint", offset_bytes: "0", limit_bytes: null });
    expect(reply.isError).toBe(false);
    expect(runner.readLogs).toHaveBeenCalledWith("job-1", "checkpoint", 0, undefined);
    await call("orch_logs", { job_id: "job-1", part: null });
    expect(runner.readLogs).toHaveBeenLastCalledWith("job-1", "summary", undefined, undefined);
    await call("orch_logs", { job_id: "job-1", part: "result" });
    expect(runner.readLogs).toHaveBeenLastCalledWith("job-1", "summary", undefined, undefined);
  });

  it("orch_cancel cleans a worktree only for an explicit true", async () => {
    runner.cancelJob.mockResolvedValue(job({ status: "cancelled" }));
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{}, false], [{ cleanup_worktree: null }, false], [{ cleanup_worktree: "false" }, false], [{ cleanup_worktree: "" }, false],
      [{ cleanup_worktree: 0 }, false], [{ cleanup_worktree: "TRUE" }, true], [{ cleanup_worktree: true }, true],
    ];
    for (const [flags, expected] of cases) {
      runner.cancelJob.mockClear();
      const reply = await call("orch_cancel", { job_id: "job-1", force_cleanup: null, ...flags });
      expect(reply.isError, JSON.stringify(flags)).toBe(false);
      expect(runner.cancelJob).toHaveBeenCalledWith("job-1", { cleanupWorktree: expected, forceCleanup: false });
    }
    runner.cancelJob.mockClear();
    await call("orch_cancel", { job_id: "job-1", cleanup_worktree: "true", force_cleanup: "false" });
    expect(runner.cancelJob).toHaveBeenCalledWith("job-1", { cleanupWorktree: true, forceCleanup: false });
    runner.cancelJob.mockClear();
    const ambiguous = await client.callTool({ name: "orch_cancel", arguments: { job_id: "job-1", cleanup_worktree: "maybe" } });
    expect(ambiguous.isError).toBe(true);
    expect(runner.cancelJob).not.toHaveBeenCalled();
  });
});
