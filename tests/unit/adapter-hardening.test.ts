import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { DshAdapter } from "../../src/adapters/dsh.js";
import { CopilotAdapter, KimiAdapter } from "../../src/adapters/ecosystem.js";
import { GeminiAdapter } from "../../src/adapters/gemini.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import { MAX_DIAGNOSTIC_ERROR_BYTES, BoundedMessages } from "../../src/adapters/parsers.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import type { BuildInvocationInput, CliAdapter, NativeSubagentsControl, ParsedAdapterResult } from "../../src/adapters/types.js";
import { CursorAdapter, FxAdapter, KiroAdapter, MuseAdapter } from "../../src/adapters/vendor-clis.js";
import type { HarnessConfig } from "../../src/config/schema.js";
import { DRIVER_KINDS } from "../../src/drivers.js";
import { installStubClis, type StubCliEnvironment } from "./helpers/stub-clis.js";
import type { DriverKind, RunMode } from "../../src/types.js";

let root: string;
let jobCounter = 0;
let stubClis: StubCliEnvironment;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-adapter-hardening-"));
  // Adapters refuse a binary they cannot resolve, and must never read the real user's CLI configuration.
  stubClis = installStubClis(DRIVER_KINDS);
});

afterAll(() => {
  stubClis.restore();
  rmSync(root, { recursive: true, force: true });
});

function request(
  driver: DriverKind, mode: RunMode, extraArgs: string[] = [], nativeSubagents?: NativeSubagentsControl,
): BuildInvocationInput {
  jobCounter += 1;
  const jobDir = join(root, `job-${jobCounter}`);
  return {
    harnessId: driver,
    harness: { driver, display_name: driver, binary: driver, enabled: true, extra_args: extraArgs },
    modelId: "test",
    model: {
      display_name: "Test", harness: driver, cli_model: "demo", tier: "standard", efforts: ["medium", "high"],
      default_effort: "medium", cost_tier: "low", cost_note: "", speed_note: "", context_window: 1000, strengths: [],
      weaknesses: [], best_for: [], avoid_for: [], checked_at: "2026-11-25", enabled: true,
    },
    effort: "high", mode, prompt: "question", cwd: root, jobDir, inheritMcp: false, isGitRepo: true,
    ...(nativeSubagents ? { nativeSubagents } : {}),
  };
}

/** The job dir is created here so every invocation starts from an empty private directory. */
async function build(adapter: CliAdapter, input: BuildInvocationInput) {
  mkdirSync(input.jobDir, { mode: 0o700, recursive: true });
  return adapter.buildInvocation(input);
}

function parseLines(adapter: CliAdapter, lines: unknown[], exitCode: number | null = 0, stderrTail = ""): ParsedAdapterResult {
  const parser = adapter.createStreamParser();
  for (const line of lines) parser.pushLine(typeof line === "string" ? line : JSON.stringify(line));
  return parser.finish({ exitCode, signal: null, stderrTail, stdoutTruncated: false, oversizedLinesDropped: 0 });
}

const VIOLATION = { code: "SANDBOX_POLICY_VIOLATION" };

describe("readonly extra_args hardening", () => {
  const cases: Array<[string, CliAdapter, string[][]]> = [
    ["claude", new ClaudeAdapter(), [
      ["--dangerously-skip-permissions"], ["--allow-dangerously-skip-permissions"], ["--permission-mode", "bypassPermissions"],
      ["--permission-mode=acceptEdits"], ["--tools", "Bash"], ["--allowedTools", "Bash"], ["--allowed-tools=Bash"],
      ["--mcp-config", "servers.json"], ["--settings", "{}"], ["--disallowed-tools", "Read"], ["--disallowedTools=Read"],
    ]],
    ["codex", new CodexAdapter(), [
      ["-s", "danger-full-access"], ["-sdanger-full-access"], ["--sandbox=workspace-write"], ["--dangerously-bypass-approvals-and-sandbox"],
      ["--yolo"], ["--full-auto"], ["-a", "on-request"], ["--ask-for-approval", "never"], ["--approve-for-me"],
      ["-c", 'sandbox_mode="danger-full-access"'], ["-csandbox_mode=\"danger-full-access\""], ["--config", 'approval_policy="never"'],
      ["--config=approval_policy=\"never\""], ["-c", 'profiles.work.sandbox_mode="danger-full-access"'],
    ]],
    ["dsh", new DshAdapter(), [["--permission-mode", "workspace-write"], ["--approval-policy=never"], ["--patch", "mine.yml"]]],
    ["pi", new PiAdapter(), [["--export", "session.html"], ["--export=session.html"], ["--tools", "bash"]]],
  ];

  for (const [name, adapter, forbidden] of cases) {
    it(`${name} rejects policy-weakening extra_args in readonly mode only`, async () => {
      for (const args of forbidden) {
        await expect(build(adapter, request(adapter.driver, "readonly", args)), args.join(" ")).rejects.toMatchObject(VIOLATION);
      }
      // Write mode leaves the user's own arguments alone once unsandboxed writes are explicitly allowed.
      const allowed = { ...request(adapter.driver, "write", forbidden[0]), allowUnsandboxedWrite: true };
      await expect(build(adapter, allowed)).resolves.toMatchObject({ args: expect.arrayContaining(forbidden[0]) });
    });
  }

  it("codex keeps ordinary -c overrides that merely mention the sandbox settings in a value", async () => {
    const harmless = ["-c", 'model_verbosity="low"', "-c", 'developer_instructions="keep sandbox_mode=read-only"', "--skip-git-repo-check"];
    const invocation = await build(new CodexAdapter(), request("codex", "readonly", harmless));
    expect(invocation.args).toEqual(expect.arrayContaining(harmless));
  });

  it("claude does not mistake a longer flag for a forbidden one", async () => {
    const invocation = await build(new ClaudeAdapter(), request("claude", "readonly", ["--tools-note", "--max-turns=3"]));
    expect(invocation.args).toEqual(expect.arrayContaining(["--tools-note", "--max-turns=3"]));
  });
});

describe("claude native subagent denial", () => {
  const off: NativeSubagentsControl = { policy: "off", maxDepth: 0 };
  const argsFor = async (extra: string[], control: NativeSubagentsControl = off) =>
    (await build(new ClaudeAdapter(), request("claude", "write", extra, control))).args;

  it.each([
    [["--disallowed-tools", "Bash"], ["--disallowed-tools", "Bash,Task,Agent"]],
    [["--disallowedTools=Bash,Edit"], ["--disallowedTools=Bash,Edit,Task,Agent"]],
    [["--disallowed-tools", "Task", "Edit"], ["--disallowed-tools", "Task,Agent", "Edit"]],
    [["--disallowed-tools"], ["--disallowed-tools", "Task,Agent"]],
  ])("merges Task,Agent into the user's deny list %j", async (own, merged) => {
    const args = await argsFor(own);
    expect(args.slice(-merged.length)).toEqual(merged);
    expect(args.filter((arg) => arg.startsWith("--disallowed"))).toHaveLength(1);
  });

  it("adds its own deny list when the user has none", async () => {
    const args = await argsFor(["--max-turns", "3"]);
    expect(args).toEqual(expect.arrayContaining(["--disallowed-tools", "Task,Agent"]));
  });

  it("treats a configured depth of 0 like the off policy even when the CLI config states no depth", async () => {
    const zero: NativeSubagentsControl = { policy: "cli_limit", maxDepth: 0 };
    const input = request("claude", "write", [], zero);
    const invocation = await build(new ClaudeAdapter(), input);
    expect(invocation.envOverrides).toEqual({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "0" });
    expect(JSON.parse(readFileSync(join(input.jobDir, "claude-settings.json"), "utf8"))).toEqual({ env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "0" } });
    expect(invocation.args).toEqual(expect.arrayContaining(["--disallowed-tools", "Task,Agent"]));

    // A positive depth with nothing discovered stays untouched: adapters only ever lower limits.
    const positive = await build(new ClaudeAdapter(), request("claude", "write", [], { policy: "cli_limit", maxDepth: 1 }));
    expect(positive.envOverrides).toBeUndefined();
    expect(positive.args).not.toContain("--settings");
  });
});

describe("codex and dsh native subagent control", () => {
  it("codex switches multi-agent off for a configured depth of 0 without a discovered depth", async () => {
    const zero = await build(new CodexAdapter(), request("codex", "write", [], { policy: "cli_limit", maxDepth: 0 }));
    expect(zero.args).toEqual(expect.arrayContaining(["-c", "features.multi_agent=false"]));
    const one = await build(new CodexAdapter(), request("codex", "write", [], { policy: "cli_limit", maxDepth: 1 }));
    expect(one.args.join(" ")).not.toContain("multi_agent");
  });

  it("dsh lowers only the plugins whose own depth exceeds the limit and never raises one", async () => {
    const input = request("dsh", "write", [], {
      policy: "cli_limit", maxDepth: 2, discoveredMaxDepth: 3,
      discoveredPluginDepths: { subagent: 1, "subagent-spawn-in-process": 3, "tool-subagent": 2 },
    });
    await build(new DshAdapter(), input);
    const patch = parseYaml(readFileSync(join(input.jobDir, "dsh-patch.yml"), "utf8")) as Array<{ id: string; config?: unknown }>;
    expect(patch.filter((entry) => /subagent/.test(entry.id))).toEqual([{ id: "subagent-spawn-in-process", config: { maxDepth: 2 } }]);
  });
});

describe("stream result classification", () => {
  it("codex classifies the terminal turn.failed alone, so an earlier 429 does not put the harness on cooldown", () => {
    const result = parseLines(new CodexAdapter(), [
      { type: "error", message: "stream error: exceeded retry limit, last status: 429 Too Many Requests" },
      { type: "turn.failed", error: { message: "The 'demo' model is not supported when using Codex with a ChatGPT account" } },
    ], 1);
    expect(result.error).toMatchObject({ code: "MODEL_UNSUPPORTED", failure_scope: "model" });
    expect(result.warnings?.join(" ")).toContain("429 Too Many Requests");
  });

  it("codex still reports a rate limit when the terminal failure itself says so", () => {
    const result = parseLines(new CodexAdapter(), [
      { type: "error", message: "reconnecting" },
      { type: "turn.failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } },
    ], 1);
    expect(result.error).toMatchObject({ code: "RATE_LIMITED" });
  });

  it("codex bounds the transient error text it keeps", () => {
    const lines = Array.from({ length: 100 }, (_, index) => ({ type: "error", message: `${index} ${"x".repeat(1_000)}` }));
    const result = parseLines(new CodexAdapter(), [
      ...lines,
      { type: "item.completed", item: { type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.warnings!.join("\n"))).toBeLessThan(MAX_DIAGNOSTIC_ERROR_BYTES + 256);
  });

  it("claude reads the errors array of an error_during_execution result", () => {
    const result = parseLines(new ClaudeAdapter(), [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "result", subtype: "error_during_execution", is_error: true, result: "", errors: ["API Error: 429 Too Many Requests", { message: "retry later" }] },
    ], 1);
    expect(result.error).toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(result.error?.message).toContain("retry later");
  });

  it("claude falls back to the earlier assistant error when the result carries no text", () => {
    const result = parseLines(new ClaudeAdapter(), [
      { type: "assistant", error: "authentication_failed", message: { id: "m1", content: [{ type: "text", text: "Invalid API key · Please run /login" }] } },
      { type: "result", subtype: "error_during_execution", is_error: true, result: "" },
    ], 1);
    expect(result.error).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(result.error?.message).toContain("authentication_failed");
  });

  it("claude never lets a tool_result carrying a result field replace the final answer", () => {
    const result = parseLines(new ClaudeAdapter(), [
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: false, result: "final answer" },
      { type: "tool_result", result: "quota exceeded", is_error: true },
    ]);
    expect(result).toMatchObject({ ok: true, summary: "final answer" });
  });

  it.each(["tool_result", "tool_use", "tool_call", "assistant", "user", "system"])(
    "a %s event with a result field is not a final result for Claude-like CLIs",
    (type) => {
      const result = parseLines(new CursorAdapter(), [
        { type: "result", result: "real answer" },
        { type, result: "usage limit reached", is_error: true },
      ]);
      expect(result).toMatchObject({ ok: true, summary: "real answer" });
    },
  );

  it("gemini keeps the structured status and code of an error so 503 and RESOURCE_EXHAUSTED classify", () => {
    const unavailable = parseLines(new GeminiAdapter(), [
      { error: { code: 503, status: "UNAVAILABLE", message: "Please try again later." } },
    ], 1);
    expect(unavailable.error).toMatchObject({ code: "PROVIDER_OVERLOADED", retryable: true });
    const exhausted = parseLines(new GeminiAdapter(), [
      { error: { status: "RESOURCE_EXHAUSTED", message: "Out of capacity for this key." } },
    ], 1);
    expect(exhausted.error).toMatchObject({ code: "QUOTA_EXCEEDED" });
    // A message-only error is reported unchanged.
    expect(parseLines(new GeminiAdapter(), [{ error: { message: "plain failure" } }], 1).error?.message).toContain("plain failure");
  });

  it("pi and dsh keep classifying from their first error while bounding the kept text", () => {
    const noise = { type: "error", message: "x".repeat(2_000) };
    const pi = parseLines(new PiAdapter(), [{ type: "error", message: "401 Unauthorized" }, ...Array(50).fill(noise)], 0);
    expect(pi.error).toMatchObject({ code: "AUTH_REQUIRED" });
    const dsh = parseLines(new DshAdapter(), [{ type: "error", message: "401 Unauthorized" }, ...Array(50).fill(noise)], 1);
    expect(dsh.error).toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("BoundedMessages", () => {
  it("keeps the first messages whole, clips the one that crosses the cap and drops the rest", () => {
    const messages = new BoundedMessages(100);
    messages.push("a".repeat(60));
    messages.push("b".repeat(60));
    messages.push("c");
    expect(messages.values()).toEqual(["a".repeat(60), "b".repeat(40)]);
    expect(messages.length).toBe(2);
  });

  it("never exceeds the default 16 KB cap", () => {
    const messages = new BoundedMessages();
    for (let index = 0; index < 100; index += 1) messages.push("é".repeat(500));
    expect(Buffer.byteLength(messages.values().join(""))).toBeLessThanOrEqual(MAX_DIAGNOSTIC_ERROR_BYTES);
  });
});

describe("progress capture", () => {
  it.each([
    ["kiro", new KiroAdapter()], ["muse", new MuseAdapter()], ["kimi", new KimiAdapter()], ["copilot", new CopilotAdapter()],
  ] as const)("%s exposes streamed partial text through checkpoint()", (_name, adapter) => {
    const parser = adapter.createStreamParser();
    parser.pushLine(JSON.stringify({ type: "text", text: "partial " }));
    parser.pushLine(JSON.stringify({ type: "delta", delta: { text: "answer" } }));
    expect(parser.checkpoint?.().partial_text).toBe("partial answer");
    // A final snapshot replaces the deltas instead of doubling them.
    parser.pushLine(JSON.stringify({ type: "result", result: "final answer" }));
    expect(parser.checkpoint?.().partial_text).toBe("final answer");
  });
});

describe("OpenCode stream tracking", () => {
  const events = (...parts: unknown[]) => parts.map((part) => ({ type: "tool_use", part }));
  const toolPart = (status: string, input?: unknown) => ({ callID: "call-1", tool: "read", state: { status, ...(input ? { input } : {}) } });

  it("updates one step in place, keeps the target from running and ignores a repeated completion", () => {
    const parser = new OpenCodeAdapter().createStreamParser();
    for (const event of events(
      toolPart("pending"), toolPart("running", { filePath: "src/a.ts" }), toolPart("completed", { filePath: "src/a.ts" }),
      toolPart("completed", { filePath: "src/a.ts" }),
    )) parser.pushLine(JSON.stringify(event));
    expect(parser.checkpoint?.().tool_trail).toEqual([{ tool: "read", target: "src/a.ts", status: "ok" }]);
  });

  it("records a failed call once", () => {
    const parser = new OpenCodeAdapter().createStreamParser();
    for (const event of events(toolPart("running", { filePath: "b.ts" }), toolPart("error"), toolPart("error"))) parser.pushLine(JSON.stringify(event));
    expect(parser.checkpoint?.().tool_trail).toEqual([{ tool: "read", target: "b.ts", status: "error" }]);
  });

  it("does not count a turn for a late chunk of an earlier message", () => {
    const parser = new OpenCodeAdapter().createStreamParser();
    const text = (messageID: string, value: string) => parser.pushLine(JSON.stringify({ type: "text", part: { messageID, text: value } }));
    text("a", "first");
    text("b", "second");
    text("a", "late");
    text("b", " tail");
    expect(parser.checkpoint?.().turns).toBe(1);
    expect(parser.finish({ exitCode: 0, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0 }))
      .toMatchObject({ ok: true, summary: "second tail" });
  });
});

describe("inconclusive probes", () => {
  let binDir: string;
  const TIMEOUT_MS = 1_000;

  beforeAll(() => {
    binDir = join(root, "bin");
    mkdirSync(binDir);
  });

  function mock(name: string, body: string): HarnessConfig {
    const path = join(binDir, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return { driver: "codex", display_name: name, binary: path, enabled: true };
  }

  const HANG = "setInterval(() => {}, 1000);";

  it("codex reports a timed-out login status as inconclusive, not unauthenticated", async () => {
    const harness = mock("codex", `
      const a = process.argv.slice(2);
      if (a[0] === "--version") { console.log("codex-cli 0.172.0"); process.exit(0); }
      ${HANG}`);
    const health = await new CodexAdapter().probe("codex", harness, { timeoutMs: TIMEOUT_MS });
    expect(health).toMatchObject({ installed: true, auth_status: "unknown", probe_inconclusive: true });
  });

  it("codex reports an unreadable config as inconclusive, not unauthenticated", async () => {
    const harness = mock("codex-config", `
      const a = process.argv.slice(2);
      if (a[0] === "--version") { console.log("codex-cli 0.172.0"); process.exit(0); }
      console.error("Error loading config.toml: invalid TOML at line 3");
      process.exit(1);`);
    const health = await new CodexAdapter().probe("codex", harness, { timeoutMs: TIMEOUT_MS });
    expect(health).toMatchObject({ installed: true, auth_status: "unknown", probe_inconclusive: true });
    expect(health.note).toContain("config");
  });

  it("codex still reports a plain non-zero login status as unauthenticated and conclusive", async () => {
    const harness = mock("codex-plain", `
      const a = process.argv.slice(2);
      if (a[0] === "--version") { console.log("codex-cli 0.172.0"); process.exit(0); }
      console.error("something else went wrong");
      process.exit(1);`);
    const health = await new CodexAdapter().probe("codex", harness, { timeoutMs: TIMEOUT_MS });
    expect(health).toMatchObject({ auth_status: "unauthenticated" });
    expect(health.probe_inconclusive).toBeUndefined();
  });

  it("cursor does not call a silent generic agent binary a different tool", async () => {
    const harness = { ...mock("agent", `
      const a = process.argv.slice(2);
      if (a[0] === "--version") { console.log("1.2.3"); process.exit(0); }
      ${HANG}`), driver: "cursor" as const };
    const health = await new CursorAdapter().probe("cursor", harness, { timeoutMs: TIMEOUT_MS });
    expect(health).toMatchObject({ installed: true, auth_status: "unknown", probe_inconclusive: true });
  });

  it("cursor still rejects a generic agent binary that answers without mentioning Cursor", async () => {
    const harness = { ...mock("agent", `
      const a = process.argv.slice(2);
      if (a[0] === "--version") { console.log("1.2.3"); process.exit(0); }
      console.log("Usage: agent [options]"); process.exit(0);`), driver: "cursor" as const };
    const health = await new CursorAdapter().probe("cursor", harness, { timeoutMs: TIMEOUT_MS });
    expect(health).toMatchObject({ installed: false });
    expect(health.probe_inconclusive).toBeUndefined();
  });

  it("fx does not report a missing tool when its identification command times out", async () => {
    const harness = { ...mock("fx", HANG), driver: "fx" as const };
    const health = await new FxAdapter().probe("fx", harness, { timeoutMs: 300 });
    expect(health).toMatchObject({ installed: true, auth_status: "unknown", probe_inconclusive: true });
  });
});

describe("invocation outputMode", () => {
  const cases: Array<[string, CliAdapter, string[], "streaming" | "buffered" | undefined]> = [
    ["claude (default stream-json)", new ClaudeAdapter(), [], "streaming"],
    ["claude (extra_args force json)", new ClaudeAdapter(), ["--output-format=json"], "buffered"],
    ["codex (--json)", new CodexAdapter(), [], "streaming"],
    ["dsh (--json)", new DshAdapter(), [], "streaming"],
    ["pi (--mode json)", new PiAdapter(), [], "streaming"],
    ["pi (extra_args pick text mode)", new PiAdapter(), ["--mode", "text"], "buffered"],
    ["pi (extra_args repeat json mode)", new PiAdapter(), ["--mode=json"], "streaming"],
    ["opencode (--format json)", new OpenCodeAdapter(), [], "streaming"],
    ["opencode (extra_args pick default format)", new OpenCodeAdapter(), ["--format", "default"], "buffered"],
    ["gemini (-o json)", new GeminiAdapter(), [], "buffered"],
    ["cursor", new CursorAdapter(), [], "buffered"],
    ["kiro (stream-json)", new KiroAdapter(), [], "streaming"],
    ["kiro (extra_args force json)", new KiroAdapter(), ["--output-format=json"], "buffered"],
    ["kimi (stream-json)", new KimiAdapter(), [], "streaming"],
    ["kimi (extra_args force json)", new KimiAdapter(), ["--output-format", "json"], "buffered"],
    ["muse", new MuseAdapter(), [], "buffered"],
    ["copilot", new CopilotAdapter(), [], "buffered"],
  ];

  it.each(cases)("%s", async (_label, adapter, extraArgs, expected) => {
    const driver = adapter.driver;
    const invocation = await build(adapter, request(driver, "write", extraArgs));
    // Omitted means buffered; never let a buffered CLI be mistaken for a stalled stream.
    expect(invocation.outputMode ?? "buffered").toBe(expected);
  });
});
