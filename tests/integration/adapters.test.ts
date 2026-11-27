import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { DshAdapter } from "../../src/adapters/dsh.js";
import { GeminiAdapter } from "../../src/adapters/gemini.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import { PI_UNSANDBOXED_WRITE_WARNING, PiAdapter } from "../../src/adapters/pi.js";
import { createJsonResultParser, createNdjsonParser } from "../../src/adapters/parsers.js";
import { execProbe, looksLikeProviderOverloaded, looksLikeQuotaExceeded, looksLikeRateLimited, resolveBinary, safeToolTarget, safeToolVariant } from "../../src/adapters/probe-utils.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type { BuildInvocationInput, BuiltInvocation, CliAdapter, ParsedAdapterResult } from "../../src/adapters/types.js";
import type { HarnessConfig, ModelConfig } from "../../src/config/schema.js";
import type { DriverKind, RunMode } from "../../src/types.js";
import { isolateCliHomes } from "../unit/helpers/stub-clis.js";

const PROMPT_MARKER = "@secret-file.txt please";

/**
 * One mock CLI per driver. Behavior is chosen by a `SCENARIO:<name>` token in stdin,
 * every invocation is appended to calls.jsonl, and nothing touches the network.
 */
const MOCK_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const DRIVER = path.basename(__filename);
const argv = process.argv.slice(2);
const record = (extra) => fs.appendFileSync(path.join(__dirname, "calls.jsonl"),
  JSON.stringify({ driver: DRIVER, argv, ...extra }) + "\n");
const out = (value) => process.stdout.write((typeof value === "string" ? value : JSON.stringify(value)) + "\n");
const VERSIONS = { claude: "2.1.332 (Claude Code)", codex: "codex-cli 0.172.0", dsh: "0.2.2-rc.1", pi: "1.6.0" };

if (argv[0] === "--version") {
  record({ probe: "version" });
  setTimeout(() => { out(VERSIONS[DRIVER]); process.exit(0); }, 50);
  return;
}
if (DRIVER === "claude" && argv[0] === "auth") { record({ probe: "auth" }); out({ loggedIn: true, authMethod: "oauth_token" }); process.exit(0); }
if (DRIVER === "codex" && argv[0] === "login") { record({ probe: "auth" }); process.stderr.write("Logged in using ChatGPT\n"); process.exit(0); }
if (DRIVER === "pi" && argv[0] === "auth") { record({ probe: "auth" }); out({ status: "not_ready", provider: argv[3] }); process.exit(0); }
if (DRIVER === "hang") { setTimeout(() => {}, 60000); return; }

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  record({ stdin });
  const scenario = (/SCENARIO:(\w+)/.exec(stdin) || [])[1] || "success";
  const argAfter = (flag) => argv[argv.indexOf(flag) + 1];
  const handlers = {
    claude: {
      success: () => {
        out("");
        out("diagnostic noise line");
        out({ type: "result", subtype: "success", is_error: false, result: "claude done", total_cost_usd: 0.12,
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 }, permission_denials: [] });
      },
      denied: () => out({ type: "result", subtype: "success", is_error: false, result: "partial",
        permission_denials: [{ tool_name: "Write", tool_use_id: "t1", tool_input: {} }, { tool_name: "Bash" }] }),
      auth: () => {
        out({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" });
        process.exitCode = 1;
      },
      plain: () => out("plain text answer from a future version"),
    },
    codex: {
      success: () => {
        out({ type: "thread.started", thread_id: "t" });
        out("warning: not json");
        out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "from events" } });
        out({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } });
        fs.writeFileSync(argAfter("-o"), "final from file");
      },
      failed: () => {
        out({ type: "turn.started" });
        out({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
      },
      events_only: () => {
        out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "fallback text" } });
        out({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
      },
    },
    dsh: {
      success: () => {
        out({ type: "session", sessionId: "s1", cwd: process.cwd() });
        out({ type: "status", phase: "step_start", turn: 1, step: 1 });
        out({ type: "text", text: "streamed" });
        out({ type: "status", phase: "step_end", turn: 1, step: 1 });
        out({ type: "final", sessionId: "s1", reason: { kind: "completed" }, text: "dsh final answer" });
      },
      usage: () => {
        out({ type: "status", phase: "step_end", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 } });
        out({ type: "status", phase: "step_end", usage: { inputTokens: 5, outputTokens: 1 } });
        out({ type: "final", reason: { kind: "completed" }, text: "ok" });
      },
      reason_error: () => {
        out({ type: "final", reason: { kind: "error", error: { code: "provider", message: "401 Unauthorized" } }, text: "" });
      },
    },
    pi: {
      success: () => {
        out({ type: "agent_start" });
        out({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "par" }],
          usage: { input: 999, output: 999, cacheRead: 999, cost: { total: 9 } } } });
        out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "prompt" }] } });
        out({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "thinking aloud" }],
          usage: { input: 20, output: 4, cacheRead: 5, cost: { total: 0.01 } } } });
        out({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "pi " }, { type: "text", text: "answer" }],
          usage: { input: 30, output: 6, cacheRead: 10, cost: { total: 0.02 } } } });
        out({ type: "agent_end", messages: [], willRetry: false });
        out({ type: "agent_settled", aborted: false });
      },
      model_error: () => {
        out({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [],
          errorMessage: "Provider returned 503 overloaded", usage: { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } } } });
        out({ type: "agent_settled", aborted: false });
      },
    },
  };
  const handler = (handlers[DRIVER] || {})[scenario];
  if (!handler) { process.stderr.write("unknown scenario " + scenario + "\n"); process.exitCode = 2; return; }
  handler();
});
`;

let root: string;
let binDir: string;

function writeMock(name: string): string {
  const path = join(binDir, name);
  writeFileSync(path, `#!${process.execPath}\n${MOCK_SOURCE}`);
  chmodSync(path, 0o755);
  return path;
}

function readCalls(): Array<{ driver: string; argv: string[]; stdin?: string; probe?: string }> {
  try {
    return readFileSync(join(binDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function harness(driver: DriverKind, fields: Partial<HarnessConfig> = {}): HarnessConfig {
  return { driver, display_name: driver, binary: join(binDir, driver), enabled: true, extra_args: [], ...fields };
}

function model(fields: Partial<ModelConfig> & { harness: string; cli_model: string }): ModelConfig {
  return {
    display_name: fields.cli_model,
    tier: "standard",
    efforts: ["low", "medium", "high"],
    default_effort: "medium",
    cost_tier: "low",
    cost_note: "",
    speed_note: "",
    context_window: 1000,
    strengths: [],
    weaknesses: [],
    best_for: [],
    avoid_for: [],
    checked_at: "2026-11-25",
    enabled: true,
    ...fields,
  };
}

let jobCounter = 0;

function makeInput(
  driver: DriverKind,
  options: {
    mode?: RunMode;
    prompt?: string;
    systemContext?: string;
    harness?: Partial<HarnessConfig>;
    model?: Partial<ModelConfig>;
    inheritMcp?: boolean;
    isGitRepo?: boolean;
    effort?: string;
  } = {},
): BuildInvocationInput {
  jobCounter += 1;
  const jobDir = join(root, `job-${jobCounter}`);
  mkdirSync(jobDir, { mode: 0o700 });
  return {
    harnessId: driver,
    harness: harness(driver, options.harness),
    modelId: `${driver}-model`,
    model: model({ harness: driver, cli_model: `${driver}-cli-model`, ...options.model }),
    effort: options.effort ?? "high",
    mode: options.mode ?? "readonly",
    prompt: options.prompt ?? "SCENARIO:success",
    ...(options.systemContext ? { systemContext: options.systemContext } : {}),
    cwd: root,
    jobDir,
    inheritMcp: options.inheritMcp ?? false,
    isGitRepo: options.isGitRepo ?? true,
  };
}

async function execute(adapter: CliAdapter, invocation: BuiltInvocation, cwd: string): Promise<ParsedAdapterResult> {
  const child = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const parser = adapter.createStreamParser();
  let pending = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      parser.pushLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(invocation.stdin);
  const [exitCode, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  if (pending) parser.pushLine(pending);
  let outputFileContent: string | undefined;
  if (invocation.outputFile) {
    try {
      outputFileContent = readFileSync(invocation.outputFile, "utf8");
    } catch {
      outputFileContent = undefined;
    }
  }
  return parser.finish({ exitCode, signal, stderrTail: stderr, outputFileContent, stdoutTruncated: false, oversizedLinesDropped: 0 });
}

async function run(adapter: CliAdapter, input: BuildInvocationInput): Promise<{ invocation: BuiltInvocation; result: ParsedAdapterResult }> {
  const invocation = await adapter.buildInvocation(input);
  return { invocation, result: await execute(adapter, invocation, input.cwd) };
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

let restoreCliHomes: () => void = () => undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-adapters-"));
  binDir = join(root, "bin");
  mkdirSync(binDir);
  for (const name of ["claude", "codex", "dsh", "pi", "opencode", "hang"]) writeMock(name);
  // The real user's Codex / DSH / OpenCode configuration must never reach an assertion.
  const emptyHome = join(root, "home");
  mkdirSync(emptyHome);
  restoreCliHomes = isolateCliHomes(emptyHome);
});

afterAll(() => {
  restoreCliHomes();
  rmSync(root, { recursive: true, force: true });
});

/** The host's inline OpenCode config must never leak into adapter assertions: save it, clear it per test, restore it after. */
let savedOpencodeConfigContent: string | undefined;

beforeEach(() => {
  rmSync(join(binDir, "calls.jsonl"), { force: true });
  savedOpencodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
  delete process.env.OPENCODE_CONFIG_CONTENT;
});

afterEach(() => {
  if (savedOpencodeConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
  else process.env.OPENCODE_CONFIG_CONTENT = savedOpencodeConfigContent;
});

describe("probe utilities", () => {
  it("resolves binaries by absolute path and via PATH", () => {
    expect(resolveBinary(join(binDir, "claude"))).toBe(join(binDir, "claude"));
    expect(resolveBinary(join(binDir, "missing"))).toBeUndefined();
    const previous = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${previous ?? ""}`;
    try {
      expect(resolveBinary("codex")).toBe(join(binDir, "codex"));
      expect(resolveBinary("definitely-not-installed-xyz")).toBeUndefined();
    } finally {
      process.env.PATH = previous;
    }
    const plain = join(root, "not-executable");
    writeFileSync(plain, "x", { mode: 0o644 });
    expect(resolveBinary(plain)).toBeUndefined();
  });

  it("kills probes on timeout", async () => {
    const started = Date.now();
    const result = await execProbe(join(binDir, "hang"), [], 300);
    expect(result).toMatchObject({ ok: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("reports missing commands without throwing", async () => {
    const result = await execProbe(join(root, "nope"), ["--version"]);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(false);
  });
});

describe("Claude adapter", () => {
  const adapter = new ClaudeAdapter();

  it("builds readonly argv with tool allowlist and a 0600 system prompt file", async () => {
    const input = makeInput("claude", { systemContext: "be careful", harness: { extra_args: ["--verbose-x"] } });
    const invocation = await adapter.buildInvocation(input);
    const systemFile = join(input.jobDir, "claude-system.txt");
    expect(invocation.args).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
      "--model", "claude-cli-model", "--effort", "high",
      "--append-system-prompt-file", systemFile,
      "--tools", "Read,Glob,Grep", "--restricted", "--permission-mode", "plan", "--permission-prompts", "none",
      "--strict-mcp-config", "--disallowed-tools", "mcp__*",
      "--verbose-x",
    ]);
    expect(invocation.tempFiles).toEqual([systemFile]);
    expect(readFileSync(systemFile, "utf8")).toBe("be careful");
    expect(fileMode(systemFile)).toBe(0o600);
    expect(invocation.stdin).toBe("SCENARIO:success");
  });

  it("builds write argv with permission mode and optional MCP inheritance", async () => {
    const strict = await adapter.buildInvocation(makeInput("claude", { mode: "write", harness: { write_permission_mode: "auto" } }));
    expect(strict.args.slice(9)).toEqual(["--permission-mode", "auto", "--permission-prompts", "none", "--strict-mcp-config"]);
    const inherit = await adapter.buildInvocation(makeInput("claude", { mode: "write", inheritMcp: true }));
    expect(inherit.args.slice(9)).toEqual(["--permission-mode", "acceptEdits", "--permission-prompts", "none"]);
    expect(inherit.args).not.toContain("--tools");
  });

  it("parses a successful run with usage and ignores noise", async () => {
    const { result } = await run(adapter, makeInput("claude"));
    expect(result).toMatchObject({
      ok: true,
      summary: "claude done",
      usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 3, cost_usd: 0.12 },
    });
    expect(result.parseDegraded).toBeUndefined();
  });

  it("surfaces permission_denials as a warning", async () => {
    const { result } = await run(adapter, makeInput("claude", { prompt: "SCENARIO:denied" }));
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("Claude denied 2 tool call(s): Write, Bash.");
  });

  it("maps is_error auth failures to AUTH_REQUIRED", async () => {
    const { result } = await run(adapter, makeInput("claude", { prompt: "SCENARIO:auth" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "AUTH_REQUIRED", retryable: false });
  });

  it("degrades gracefully on plain text output", async () => {
    const { result } = await run(adapter, makeInput("claude", { prompt: "SCENARIO:plain" }));
    expect(result).toMatchObject({ ok: true, parseDegraded: true, summary: "plain text answer from a future version" });
  });

  it("maps effort synonyms and passes unknown values through", () => {
    expect(adapter.mapEffort("Maximum")).toBe("max");
    expect(adapter.mapEffort("xhigh")).toBe("xhigh");
    expect(adapter.mapEffort("turbo")).toBe("turbo");
  });
});

describe("Codex adapter", () => {
  const adapter = new CodexAdapter();

  it("puts top-level flags before exec and reads the prompt from stdin", async () => {
    const input = makeInput("codex", {
      harness: { profile: "work", extra_args: ["--foo"] },
      systemContext: "line1\n\"quoted\"",
      isGitRepo: false,
    });
    const invocation = await adapter.buildInvocation(input);
    const outputFile = join(input.jobDir, "codex-last-message.txt");
    expect(invocation.args).toEqual([
      "-a", "never", "-p", "work", "exec",
      "--json", "--ephemeral", "--color", "never",
      "-C", input.cwd, "-m", "codex-cli-model", "-s", "read-only",
      "-c", 'model_reasoning_effort="high"',
      "-o", outputFile,
      "-c", "mcp_servers={}",
      "--skip-git-repo-check",
      "-c", 'developer_instructions="line1\\n\\"quoted\\""',
      "--foo",
      "-",
    ]);
    expect(invocation.outputFile).toBe(outputFile);
    expect(invocation.tempFiles).toContain(outputFile);
    expect(fileMode(outputFile)).toBe(0o600);

    const write = await adapter.buildInvocation(makeInput("codex", { mode: "write" }));
    expect(write.args.slice(0, 3)).toEqual(["-a", "never", "exec"]);
    expect(write.args[write.args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(write.args).not.toContain("--skip-git-repo-check");
  });

  it("prefers the -o file and extracts turn usage", async () => {
    const { result } = await run(adapter, makeInput("codex"));
    expect(result).toMatchObject({
      ok: true,
      summary: "final from file",
      usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 },
    });
  });

  it("falls back to the last agent_message when the -o file is empty", async () => {
    const { result } = await run(adapter, makeInput("codex", { prompt: "SCENARIO:events_only" }));
    expect(result).toMatchObject({ ok: true, summary: "fallback text" });
  });

  it("fails on turn.failed even when the exit code is 0", async () => {
    const { result } = await run(adapter, makeInput("codex", { prompt: "SCENARIO:failed" }));
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NON_ZERO_EXIT");
    expect(result.error?.message).toContain("stream disconnected");
  });

  it("succeeds with a warning after a transient error followed by turn.completed", () => {
    const parser = adapter.createStreamParser();
    parser.pushLine(JSON.stringify({ type: "error", message: "reconnecting..." }));
    parser.pushLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "recovered answer" } }));
    parser.pushLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } }));
    const parsed = parser.finish({
      exitCode: 0, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).toBe("recovered answer");
    expect(parsed.warnings?.join(" ")).toContain("reconnecting...");
  });
});

describe("DSH adapter", () => {
  const adapter = new DshAdapter();

  it("writes an allowlisted YAML patch with 0600 mode", async () => {
    const input = makeInput("dsh", {
      systemContext: "persona: x\n- injected: true",
      harness: { profile: "headless", default_upstream_provider: "fallback-provider" },
      model: { cli_provider: "deepseek-official" },
      mode: "write",
    });
    const invocation = await adapter.buildInvocation(input);
    const patchPath = join(input.jobDir, "dsh-patch.yml");
    expect(invocation.args).toEqual([
      "--profile", "headless", "--patch", patchPath, "--json",
      "--permission-mode", "workspace-write", "--approval-policy", "never", "-",
    ]);
    expect(invocation.tempFiles).toEqual([patchPath]);
    expect(fileMode(patchPath)).toBe(0o600);
    expect(parseYaml(readFileSync(patchPath, "utf8"))).toEqual([
      { id: "agent-default-model", config: { provider: "deepseek-official", model: "dsh-cli-model", reasoningEffort: "high" } },
      {
        id: "system-prompt",
        config: {
          personaPrefix: "You are a coding agent powered by the {{model}} model.",
          personaSuffix: "persona: x\n- injected: true",
        },
      },
      { id: "mcp-resources", disabled: true },
      { id: "mcp-orchestrator", disabled: true },
    ]);

    const readonly = await adapter.buildInvocation(makeInput("dsh", { harness: { default_upstream_provider: "fallback-provider" } }));
    expect(readonly.args[readonly.args.indexOf("--permission-mode") + 1]).toBe("read-only");
    expect(parseYaml(readFileSync(readonly.tempFiles[0], "utf8"))).toEqual([
      { id: "agent-default-model", config: { provider: "fallback-provider", model: "dsh-cli-model", reasoningEffort: "high" } },
      { id: "mcp-resources", disabled: true },
      { id: "mcp-orchestrator", disabled: true },
    ]);
  });

  it("returns final.text and marks missing usage as incomplete", async () => {
    const { result } = await run(adapter, makeInput("dsh"));
    expect(result).toMatchObject({ ok: true, summary: "dsh final answer", usage: { incomplete: true } });
  });

  it("sums per-step usage", async () => {
    const { result } = await run(adapter, makeInput("dsh", { prompt: "SCENARIO:usage" }));
    expect(result.usage).toEqual({ input_tokens: 15, output_tokens: 3, cached_input_tokens: 4 });
  });

  it("fails on a non-completed final reason even with exit code 0", async () => {
    const { result } = await run(adapter, makeInput("dsh", { prompt: "SCENARIO:reason_error" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "AUTH_REQUIRED", retryable: false });
  });
});

describe("native subagent clamping", () => {
  const lowered = { policy: "cli_limit", maxDepth: 1, discoveredMaxDepth: 3, discoveredKeys: ["agents.max_depth"] } as const;
  const unchanged = { policy: "cli_limit", maxDepth: 2, discoveredMaxDepth: 2, discoveredKeys: ["agents.max_depth"] } as const;
  const off = { policy: "off", maxDepth: 0 } as const;
  const withControl = (driver: DriverKind, nativeSubagents: BuildInvocationInput["nativeSubagents"], mode: RunMode = "write") =>
    ({ ...makeInput(driver, { mode }), nativeSubagents });

  it("codex only lowers agents.max_depth when the user's config already sets it, and switches multi-agent off for policy off", async () => {
    const adapter = new CodexAdapter();
    expect((await adapter.buildInvocation(withControl("codex", lowered))).args).toEqual(expect.arrayContaining(["-c", "agents.max_depth=1"]));
    expect((await adapter.buildInvocation(withControl("codex", { ...lowered, discoveredKeys: [] }))).args.join(" ")).not.toContain("agents.max_depth");
    expect((await adapter.buildInvocation(withControl("codex", unchanged))).args.join(" ")).not.toContain("agents.max_depth");
    expect((await adapter.buildInvocation(withControl("codex", off))).args).toEqual(expect.arrayContaining(["-c", "features.multi_agent=false"]));
    expect((await adapter.buildInvocation(makeInput("codex"))).args.join(" ")).not.toContain("multi_agent");
    // The sandbox flag is never touched.
    expect((await adapter.buildInvocation(withControl("codex", off, "readonly"))).args).toEqual(expect.arrayContaining(["-s", "read-only"]));
  });

  it("codex also switches multi_agent_v2 off for policy off, but only when the user's config carries that table", async () => {
    const adapter = new CodexAdapter();
    const v2Key = "features.multi_agent_v2.enabled";
    expect((await adapter.buildInvocation(withControl("codex", { ...off, discoveredKeys: [v2Key] }))).args)
      .toEqual(expect.arrayContaining(["-c", "features.multi_agent=false", "-c", "features.multi_agent_v2.enabled=false"]));
    expect((await adapter.buildInvocation(withControl("codex", off))).args.join(" ")).not.toContain("multi_agent_v2");
    expect((await adapter.buildInvocation(withControl("codex", { ...lowered, discoveredKeys: [v2Key] }))).args.join(" ")).not.toContain("multi_agent_v2");
  });

  it("claude clamps the spawn depth through a private --settings file (the user's settings env would win) plus the environment, only in write mode and only to lower it", async () => {
    const adapter = new ClaudeAdapter();
    const clamp = async (control: BuildInvocationInput["nativeSubagents"], extraArgs: string[] = [], mode: RunMode = "write") => {
      const input = { ...makeInput("claude", { mode, harness: { extra_args: extraArgs } }), nativeSubagents: control };
      return { input, invocation: await adapter.buildInvocation(input) };
    };
    const settingsOf = (input: BuildInvocationInput) => join(input.jobDir, "claude-settings.json");

    const lower = await clamp(lowered);
    expect(lower.invocation.envOverrides).toEqual({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" });
    expect(lower.invocation.args).toEqual(expect.arrayContaining(["--settings", settingsOf(lower.input)]));
    expect(JSON.parse(readFileSync(settingsOf(lower.input), "utf8"))).toEqual({ env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1" } });
    expect(fileMode(settingsOf(lower.input))).toBe(0o600);
    expect(lower.invocation.tempFiles).toContain(settingsOf(lower.input));
    // Lowering the depth keeps subagents on, so their tools stay available.
    expect(lower.invocation.args).not.toContain("--disallowed-tools");

    const disabled = await clamp(off);
    expect(disabled.invocation.envOverrides).toEqual({ CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "0" });
    expect(JSON.parse(readFileSync(settingsOf(disabled.input), "utf8"))).toEqual({ env: { CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "0" } });
    const flag = disabled.invocation.args.indexOf("--disallowed-tools");
    expect(disabled.invocation.args.slice(flag, flag + 2)).toEqual(["--disallowed-tools", "Task,Agent"]);

    // The user's own tool deny list is kept and extended in place, never doubled up and never replacing the Task,Agent denial.
    for (const [own, merged] of [
      [["--disallowed-tools", "Bash"], ["--disallowed-tools", "Bash,Task,Agent"]],
      [["--disallowedTools=Bash"], ["--disallowedTools=Bash,Task,Agent"]],
    ] as const) {
      const custom = await clamp(off, [...own]);
      expect(custom.invocation.args.filter((arg) => arg.startsWith("--disallowed"))).toHaveLength(1);
      expect(custom.invocation.args.slice(-merged.length)).toEqual(merged);
    }

    for (const noClamp of [await clamp(unchanged), await clamp(undefined), await clamp(off, [], "readonly")]) {
      expect(noClamp.invocation.envOverrides).toBeUndefined();
      expect(noClamp.invocation.args).not.toContain("--settings");
      expect(noClamp.invocation.tempFiles.some((file) => file.endsWith("claude-settings.json"))).toBe(false);
    }
    // Readonly keeps its own fixed deny list.
    expect((await clamp(off, [], "readonly")).invocation.args.filter((arg) => arg === "--disallowed-tools")).toHaveLength(1);
  });

  it("opencode writes a depth key only where the user's config already has one, and merges the inherited inline config", async () => {
    const adapter = new OpenCodeAdapter();
    const config = async (control: BuildInvocationInput["nativeSubagents"]) =>
      JSON.parse((await adapter.buildInvocation(withControl("opencode", control))).envOverrides!.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
    const lowerWith = (...discoveredKeys: string[]) => ({ ...lowered, discoveredKeys });

    expect(await config(lowerWith("experimental.subagent_depth"))).toMatchObject({ experimental: { subagent_depth: 1 } });
    const topLevel = await config(lowerWith("subagent_depth"));
    expect(topLevel).toMatchObject({ subagent_depth: 1 });
    expect(topLevel).not.toHaveProperty("experimental");
    expect(await config(lowerWith("subagent_depth", "experimental.subagent_depth")))
      .toMatchObject({ subagent_depth: 1, experimental: { subagent_depth: 1 } });
    // A key list without any depth key (e.g. a stale or foreign one) must not invent a limit.
    expect(await config(lowered)).not.toHaveProperty("experimental");
    expect(await config(lowerWith())).not.toHaveProperty("experimental");
    // Policy off lowers to zero even with no key, because zero can never raise a limit.
    expect(await config(off)).toMatchObject({ experimental: { subagent_depth: 0 } });
    expect(await config(unchanged)).not.toHaveProperty("experimental");
    expect(await config(undefined)).not.toHaveProperty("experimental");

    const previous = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      theme: "dark", agents: { mine: { mode: "primary" } }, experimental: { other: true, subagent_depth: 0 },
    });
    try {
      const merged = await config(lowerWith("experimental.subagent_depth"));
      expect(merged).toMatchObject({
        theme: "dark",
        agents: { mine: { mode: "primary" }, "orch-write": { mode: "primary" } },
        // The inherited depth was already lower and stays.
        experimental: { other: true, subagent_depth: 0 },
      });
      process.env.OPENCODE_CONFIG_CONTENT = "{not json";
      const invocation = await adapter.buildInvocation(withControl("opencode", undefined));
      expect(JSON.parse(invocation.envOverrides!.OPENCODE_CONFIG_CONTENT)).toHaveProperty("agents.orch-write");
      expect(invocation.warnings.join(" ")).toContain("OPENCODE_CONFIG_CONTENT is not valid JSON");
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previous;
    }
  });

  it("dsh disables every standard subagent patch for policy off and patches maxDepth where the user holds it when lowering", async () => {
    const adapter = new DshAdapter();
    const patchOf = async (control: BuildInvocationInput["nativeSubagents"]) => {
      const input = withControl("dsh", control);
      await adapter.buildInvocation(input);
      return parseYaml(readFileSync(join(input.jobDir, "dsh-patch.yml"), "utf8")) as Array<{ id: string; disabled?: boolean; config?: unknown }>;
    };
    const off3 = await patchOf(off);
    for (const id of ["tool-subagent", "subagent", "subagent-spawn-in-process"]) expect(off3).toContainEqual({ id, disabled: true });

    const subagentIds = (patch: Array<{ id: string }>) => patch.map((entry) => entry.id).filter((id) => /subagent/.test(id));
    const depths = { subagent: 3 };
    expect(await patchOf({ ...lowered, discoveredPluginDepths: depths })).toContainEqual({ id: "subagent", config: { maxDepth: 1 } });
    expect(await patchOf({ ...lowered, discoveredPluginDepths: { "subagent-spawn-in-process": 3 } }))
      .toContainEqual({ id: "subagent-spawn-in-process", config: { maxDepth: 1 } });
    expect(subagentIds(await patchOf({ ...lowered, discoveredPluginDepths: { "subagent-spawn-in-process": 3 } }))).toEqual(["subagent-spawn-in-process"]);
    // Without a per-plugin depth nothing is known to exceed the limit, so nothing is written.
    expect(subagentIds(await patchOf(lowered))).toEqual([]);
    expect(subagentIds(await patchOf(unchanged))).toEqual([]);
    expect(subagentIds(await patchOf(undefined))).toEqual([]);
  });
});

describe("Pi adapter", () => {
  const adapter = new PiAdapter();

  it("builds readonly argv with tool allowlist, system prompt file, and stdin-only prompt", async () => {
    const input = makeInput("pi", {
      prompt: `SCENARIO:success ${PROMPT_MARKER}`,
      systemContext: "system rules",
      model: { cli_provider: "opencode-go" },
    });
    const invocation = await adapter.buildInvocation(input);
    const systemFile = join(input.jobDir, "pi-system.txt");
    expect(invocation.args).toEqual([
      "-p", "--mode", "json", "--no-session", "--model", "opencode-go/pi-cli-model", "--thinking", "high",
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
      "--append-system-prompt", systemFile,
      "--tools", "read,grep,find,ls",
    ]);
    expect(fileMode(systemFile)).toBe(0o600);
    expect(readFileSync(systemFile, "utf8")).toBe("system rules");
    expect(invocation.args.some((arg) => arg.includes(PROMPT_MARKER))).toBe(false);
    expect(invocation.warnings).toEqual([]);

    const result = await execute(adapter, invocation, input.cwd);
    expect(result.ok).toBe(true);
    const call = readCalls().find((entry) => entry.driver === "pi" && entry.stdin !== undefined);
    expect(call?.stdin).toBe(`SCENARIO:success ${PROMPT_MARKER}`);
    expect(call?.argv.join(" ")).not.toContain(PROMPT_MARKER);
  });

  it("warns about unsandboxed write mode and honours inheritMcp", async () => {
    const invocation = await adapter.buildInvocation(makeInput("pi", { mode: "write", inheritMcp: true }));
    expect(invocation.warnings).toEqual([PI_UNSANDBOXED_WRITE_WARNING]);
    expect(invocation.args).not.toContain("--tools");
    expect(invocation.args).not.toContain("--no-mcp");
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("pi-cli-model");
  });

  it("extracts the final assistant text and sums usage from finalized messages only", async () => {
    const { result } = await run(adapter, makeInput("pi"));
    expect(result).toMatchObject({ ok: true, summary: "pi answer" });
    expect(result.usage).toEqual({ input_tokens: 50, output_tokens: 10, cached_input_tokens: 15, cost_usd: 0.03 });
  });

  it("fails cleanly on stopReason error despite exit code 0", async () => {
    const { result } = await run(adapter, makeInput("pi", { prompt: "SCENARIO:model_error" }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "PROVIDER_OVERLOADED", retryable: true, failure_scope: "harness",
      raw_error: expect.stringContaining("Provider returned 503 overloaded") });
    expect(result.error?.message).toContain("Provider returned 503 overloaded");
  });

  it("degrades on plain text when exit code is 0", () => {
    const parser = adapter.createStreamParser();
    parser.pushLine("");
    parser.pushLine("hello from an old pi");
    parser.pushLine("{truncated json");
    const result = parser.finish({ exitCode: 0, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0 });
    expect(result).toMatchObject({ ok: true, parseDegraded: true });
    expect(result.summary).toContain("hello from an old pi");
  });

  it("does not degrade when stderr reports an auth failure", () => {
    const parser = adapter.createStreamParser();
    parser.pushLine("some text");
    const result = parser.finish({
      exitCode: 0, signal: null, stderrTail: "Error: No API key found for provider", stdoutTruncated: false, oversizedLinesDropped: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("AUTH_REQUIRED");
  });
});

describe("AdapterRegistry probes", () => {
  it("probes every built-in driver against mock CLIs", async () => {
    const registry = new AdapterRegistry();
    const [claude, codex, dsh, pi, piNoProvider] = await Promise.all([
      registry.probeHarness("claude", harness("claude")),
      registry.probeHarness("codex", harness("codex")),
      registry.probeHarness("dsh", harness("dsh")),
      registry.probeHarness("pi", harness("pi", { default_upstream_provider: "deepseek" })),
      registry.probeHarness("pi-bare", harness("pi")),
    ]);
    expect(claude).toMatchObject({ installed: true, version: "2.1.332", auth_status: "ready", binary_path: join(binDir, "claude") });
    expect(codex).toMatchObject({ installed: true, version: "0.172.0", auth_status: "ready" });
    expect(dsh).toMatchObject({ installed: true, version: "0.2.2-rc.1", auth_status: "unknown" });
    expect(dsh.note).toMatch(/no standalone auth-status/);
    expect(pi).toMatchObject({ installed: true, auth_status: "unauthenticated", security_guarantees: { readonly: "tool_allowlist", write: "unsandboxed" } });
    expect(piNoProvider.auth_status).toBe("unknown");

    const piAuth = readCalls().find((call) => call.driver === "pi" && call.probe === "auth");
    expect(piAuth?.argv).toEqual(["auth", "check", "--provider", "deepseek", "--json", "--no-refresh"]);
    expect(piAuth?.argv).not.toContain("--credentials");
  });

  it("reports a missing binary as not installed", async () => {
    const health = await new AdapterRegistry().probeHarness("claude", harness("claude", { binary: join(root, "missing-claude") }));
    expect(health).toMatchObject({ installed: false, auth_status: "unknown" });
    expect(health.note).toContain("CLI_NOT_FOUND");
  });

  it("deduplicates parallel probes, caches by TTL, and refreshes on demand", async () => {
    let now = 1_000_000;
    const registry = new AdapterRegistry({ ttlMs: 1000, now: () => now });
    const config = harness("claude");
    const countProbes = () => readCalls().filter((call) => call.probe === "version").length;

    const results = await Promise.all(Array.from({ length: 5 }, () => registry.probeHarness("claude", config)));
    expect(countProbes()).toBe(1);
    expect(new Set(results.map((result) => result.checked_at)).size).toBe(1);

    await registry.probeHarness("claude", config);
    expect(countProbes()).toBe(1);

    await registry.probeHarness("claude", config, { refresh: true });
    expect(countProbes()).toBe(2);

    now += 2000;
    await registry.probeHarness("claude", config);
    expect(countProbes()).toBe(3);

    registry.clearCache();
    await registry.probeHarness("claude", config);
    expect(countProbes()).toBe(4);

    const disabled = await registry.probeHarness("claude", { ...config, enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(countProbes()).toBe(4);
  });

  it("accepts injected adapters", async () => {
    const fake: CliAdapter = {
      driver: "dsh",
      securityGuarantees: { readonly: "os_sandbox", write: "os_sandbox" },
      mapEffort: (effort) => effort,
      probe: async (harnessId, config) => ({
        harness: harnessId,
        driver: "dsh",
        enabled: config.enabled,
        installed: true,
        auth_status: "ready",
        security_guarantees: { readonly: "os_sandbox", write: "os_sandbox" },
        checked_at: new Date(0).toISOString(),
        note: "fake",
      }),
      buildInvocation: async () => { throw new Error("unused"); },
      createStreamParser: () => { throw new Error("unused"); },
    };
    const registry = new AdapterRegistry({ adapters: [fake] });
    expect(registry.get("dsh")).toBe(fake);
    expect((await registry.probeHarness("dsh", harness("dsh"))).note).toBe("fake");
    expect(registry.get("claude")).toBeInstanceOf(ClaudeAdapter);
  });
});

describe("verbatim provider failures", () => {
  const finish = { exitCode: 1, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0 };

  it.each([
    ["You've hit your usage limit", "QUOTA_EXCEEDED", "harness", false],
    ["insufficient_quota", "QUOTA_EXCEEDED", "harness", false],
    ["credit balance is too low", "QUOTA_EXCEEDED", "harness", false],
    ["RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED", "harness", false],
    ["429 Too Many Requests", "RATE_LIMITED", "harness", true],
    ["529 overloaded_error", "PROVIDER_OVERLOADED", "harness", true],
    ["maximum context length exceeded", "PROMPT_TOO_LARGE", "model", false],
    ["account does not have access to model", "MODEL_UNSUPPORTED", "model", false],
  ])("classifies %s in stdout or stderr", (message, code, failure_scope, retryable) => {
    for (const exitCode of [0, 1]) {
      const parser = new PiAdapter().createStreamParser();
      parser.pushLine(exitCode ? message as string : "unstructured output");
      expect(parser.finish({ ...finish, exitCode, stderrTail: exitCode ? "" : message as string }).error)
        .toMatchObject({ code, failure_scope, retryable, raw_error: message });
    }
  });

  it("does not mistake file line numbers or bare status-like numbers for provider failures", () => {
    const stderr = "src/fixture.ts:429: parse error near 503 items";
    const parser = new PiAdapter().createStreamParser();
    parser.pushLine("some failure output");
    const failed = parser.finish({ ...finish, stderrTail: stderr });
    expect(failed.error).toMatchObject({ code: "NON_ZERO_EXIT", failure_scope: "job" });

    const degraded = new PiAdapter().createStreamParser();
    degraded.pushLine("plain answer");
    expect(degraded.finish({ ...finish, exitCode: 0, stderrTail: stderr })).toMatchObject({ ok: true, parseDegraded: true });
    expect(looksLikeRateLimited(stderr)).toBe(false);
    expect(looksLikeProviderOverloaded(stderr)).toBe(false);
  });

  it.each([
    ["HTTP 429 from upstream", "RATE_LIMITED"],
    ["status: 503", "PROVIDER_OVERLOADED"],
    ["Provider returned 503 overloaded", "PROVIDER_OVERLOADED"],
    ["RESOURCE_EXHAUSTED: Quota exceeded for metric requests per minute (429)", "RATE_LIMITED"],
    ["RESOURCE_EXHAUSTED: rate limit reached for tokens per minute", "RATE_LIMITED"],
    ["RESOURCE_EXHAUSTED: quota exceeded for this project", "QUOTA_EXCEEDED"],
  ])("classifies %s as %s", (message, code) => {
    const parser = new PiAdapter().createStreamParser();
    parser.pushLine(message);
    expect(parser.finish(finish).error).toMatchObject({ code, raw_error: message });
    expect(looksLikeQuotaExceeded(message)).toBe(code === "QUOTA_EXCEEDED");
  });

  it.each([
    ["HTTP 500 Internal Server Error"],
    ["fetch failed: ETIMEDOUT while refreshing credentials"],
    ["GaxiosError 429 Too Many Requests"],
  ])("forces a non-retryable harness-scoped AUTH_REQUIRED on Gemini exit 41 even for retryable text %j", (message) => {
    const parser = new GeminiAdapter().createStreamParser();
    parser.pushLine(message);
    const error = parser.finish({ ...finish, exitCode: 41, stderrTail: message }).error;
    expect(error).toMatchObject({ code: "AUTH_REQUIRED", retryable: false, failure_scope: "harness",
      raw_error: expect.stringContaining(message), stderr_tail: message });
  });

  it.each([
    ['{"error":{"status":429,"message":"slow down"}}', "RATE_LIMITED"],
    ['{"error": {"code": 503, "message": "busy"}}', "PROVIDER_OVERLOADED"],
    ['{"status_code": 429}', "RATE_LIMITED"],
    ["HTTP/2 503", "PROVIDER_OVERLOADED"],
    ["HTTP/1.1 429", "RATE_LIMITED"],
    ["HTTP 529", "PROVIDER_OVERLOADED"],
    ['RESOURCE_EXHAUSTED HTTP 429 daily quota exceeded', "QUOTA_EXCEEDED"],
    ["RESOURCE_EXHAUSTED: HTTP 429 billing account out of credits", "QUOTA_EXCEEDED"],
    ["RESOURCE_EXHAUSTED: HTTP 429 requests per minute", "RATE_LIMITED"],
  ])("classifies JSON and HTTP protocol status %s as %s, from stdout and from stderr with exit 0", (message, code) => {
    const stdoutParser = new PiAdapter().createStreamParser();
    stdoutParser.pushLine(message);
    expect(stdoutParser.finish(finish).error).toMatchObject({ code });
    const stderrParser = new PiAdapter().createStreamParser();
    stderrParser.pushLine("plain answer");
    expect(stderrParser.finish({ ...finish, exitCode: 0, stderrTail: message }).error).toMatchObject({ code });
    expect(looksLikeRateLimited(message)).toBe(code === "RATE_LIMITED");
    expect(looksLikeProviderOverloaded(message)).toBe(code === "PROVIDER_OVERLOADED");
  });

  it("keeps the provider raw_error when Gemini exit code 41 forces AUTH_REQUIRED", () => {
    const message = "Quota exceeded for quota metric 'Requests per minute' (RPM)";
    const parser = new GeminiAdapter().createStreamParser();
    parser.pushLine(message);
    const error = parser.finish({ ...finish, exitCode: 41 }).error;
    expect(error).toMatchObject({ code: "AUTH_REQUIRED", retryable: false, failure_scope: "harness",
      raw_error: expect.stringContaining(message) });
    expect(error?.message).toContain("exit code 41");
    expect(error?.message).toContain(message);
  });

  const parsers = [
    ...[new ClaudeAdapter(), new CodexAdapter(), new DshAdapter(), new PiAdapter()]
      .map((adapter) => [adapter.driver, () => adapter.createStreamParser()] as const),
    ["JSON", () => createJsonResultParser({ label: "JSON", extract: () => undefined })],
    ["NDJSON", () => createNdjsonParser({ label: "NDJSON", initial: () => null, onEvent() {}, extractText: () => "" })],
  ] as const;
  it.each(parsers)("preserves stdout from %s and deduplicates overlapping stderr", (_label, create) => {
    const message = "Error: You've hit your usage limit\n\n  resets 8pm";
    for (const stderrTail of ["", message, message + "\nmore detail", "separate detail"]) {
      const parser = create();
      for (const line of message.split("\n")) parser.pushLine(line);
      const raw = stderrTail.includes(message) ? stderrTail : [message, stderrTail].filter(Boolean).join("\n");
      expect(parser.finish({ ...finish, stderrTail }).error).toMatchObject({ code: "QUOTA_EXCEEDED", raw_error: raw });
    }
  });
});

describe("stream parser hardening", () => {
  const clean = { exitCode: 0, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0 };
  const failedExit = { ...clean, exitCode: 1 };
  const line = (value: unknown) => JSON.stringify(value);

  describe("Claude sanitizeLogLine", () => {
    const parser = new ClaudeAdapter().createStreamParser();
    const sanitize = (raw: string) => parser.sanitizeLogLine!(raw);

    it("replaces tool_result bodies but keeps tool_use_id and is_error", () => {
      const raw = line({
        type: "user",
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "FILE BODY with secret text", is_error: true },
          { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "more body" }] },
          { type: "text", text: "kept as is" },
        ] },
        tool_use_result: { stdout: "FILE BODY with secret text" },
      });
      const sanitized = sanitize(raw);
      expect(sanitized).not.toContain("FILE BODY");
      expect(sanitized).not.toContain("more body");
      expect(JSON.parse(sanitized)).toEqual({
        type: "user",
        message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "[tool_result omitted from log]" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "[tool_result omitted from log]" },
          { type: "text", text: "kept as is" },
        ] },
      });
    });

    it("returns other and invalid lines unchanged", () => {
      const untouched = [
        line({ type: "assistant", message: { content: [{ type: "text", text: "mentions tool_result in prose" }] } }),
        line({ type: "user", message: { content: [{ type: "text", text: "no tool result block" }] } }),
        line({ type: "result", result: "done" }),
        '{"type":"user","message":{"content":[{"type":"tool_result"',
        "plain text mentioning \"tool_result\"",
        "",
      ];
      for (const raw of untouched) expect(sanitize(raw)).toBe(raw);
    });
  });

  it("redacts a tool target before clipping it, so a secret cut by the byte limit cannot leave a readable prefix", () => {
    const secret = "supersecretvalue1234567890";
    const previous = process.env.ORCH_TEST_API_TOKEN;
    process.env.ORCH_TEST_API_TOKEN = secret;
    try {
      for (const input of [{ path: `${"a".repeat(170)}${secret}` }, { command: `${"b".repeat(110)} ${secret}` }]) {
        const target = safeToolTarget(input)!;
        expect(target).not.toContain("supersecre");
        expect(target).toContain("[REDACTED]".slice(0, 5));
      }
      expect(safeToolTarget({ file_path: "src/index.ts" })).toBe("src/index.ts");
    } finally {
      if (previous === undefined) delete process.env.ORCH_TEST_API_TOKEN;
      else process.env.ORCH_TEST_API_TOKEN = previous;
    }
  });

  it("keeps only numeric positions of a tool call as its variant, never text", () => {
    expect(safeToolVariant({ file_path: "src/a.ts", offset: 200, limit: 100 })).toBe("limit=100 offset=200");
    expect(safeToolVariant({ path: "a.ts", view_range: [10, 20], startLine: "30-40" })).toBe("startLine=30-40 view_range=[10,20]");
    expect(safeToolVariant({ file_path: "a.ts" })).toBeUndefined();
    // Free text, ids and numeric-looking strings under a non-position name carry no position and are never kept.
    expect(safeToolVariant({ command: "cat 1234", token: "123456", content: "BODY", flag: true, offset: Number.NaN })).toBeUndefined();
    expect(safeToolVariant([{ offset: 1 }])).toBeUndefined();
    expect(safeToolVariant(undefined)).toBeUndefined();
  });

  it.each([
    ["Claude", () => new ClaudeAdapter().createStreamParser(), (parser: ReturnType<CliAdapter["createStreamParser"]>) =>
      parser.pushLine(line({ type: "result", subtype: "success", is_error: false, result: "Review: the provider hit a quota exceeded error and a rate limit." }))],
    ["generic JSON", () => createJsonResultParser({ label: "JSON", extract: () => ({ text: "Review: quota exceeded, rate limit hit, insufficient_quota.", isError: false }) }),
      (parser: ReturnType<CliAdapter["createStreamParser"]>) => parser.pushLine(line({ any: "result" }))],
  ])("%s: model answer text never drives failure classification when only the exit code is non-zero", (_label, create, feed) => {
    const parser = create();
    feed(parser);
    const result = parser.finish(failedExit);
    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: "NON_ZERO_EXIT", failure_scope: "job" });
    expect(result.error?.raw_error ?? "").not.toMatch(/quota|rate limit/i);
    expect(result.summary).toContain("quota");
  });

  it("Claude still classifies a flagged error result and real stderr evidence", () => {
    const flagged = new ClaudeAdapter().createStreamParser();
    flagged.pushLine(line({ type: "result", subtype: "success", is_error: true, result: "429 Too Many Requests" }));
    expect(flagged.finish(failedExit).error).toMatchObject({ code: "RATE_LIMITED" });

    const stderrOnly = new ClaudeAdapter().createStreamParser();
    stderrOnly.pushLine(line({ type: "result", subtype: "success", is_error: false, result: "answer" }));
    expect(stderrOnly.finish({ ...failedExit, stderrTail: "HTTP 429 Too Many Requests" }).error).toMatchObject({ code: "RATE_LIMITED" });
  });

  describe("Codex item tracking", () => {
    const fileChange = (type: "item.started" | "item.completed", id: string, status = "completed") =>
      line({ type, item: { id, type: "file_change", status, changes: [{ kind: "update", path: `${id}/a.ts` }, { kind: "add", path: `${id}/b.ts` }] } });
    const command = (type: "item.started" | "item.completed", id: string) =>
      line({ type, item: { id, type: "command_execution", command: "npm test", exit_code: type === "item.completed" ? 0 : undefined } });

    it("ends every step of a multi-file change on completion without duplicating them", () => {
      const parser = new CodexAdapter().createStreamParser();
      parser.pushLine(fileChange("item.started", "fc1"));
      expect(parser.checkpoint!().tool_trail.map((step) => step.status)).toEqual(["started", "started"]);
      parser.pushLine(fileChange("item.completed", "fc1"));
      expect(parser.checkpoint!().tool_trail).toEqual([
        { tool: "file_update", target: "fc1/a.ts", status: "ok" },
        { tool: "file_add", target: "fc1/b.ts", status: "ok" },
      ]);

      parser.pushLine(fileChange("item.started", "fc2"));
      parser.pushLine(fileChange("item.completed", "fc2", "failed"));
      expect(parser.checkpoint!().tool_trail.slice(-2).map((step) => step.status)).toEqual(["error", "error"]);
    });

    it("does not let finished multi-file items exhaust the open-item set", () => {
      const parser = new CodexAdapter().createStreamParser();
      for (let index = 0; index < 150; index += 1) {
        parser.pushLine(fileChange("item.started", `fc${index}`));
        parser.pushLine(fileChange("item.completed", `fc${index}`));
      }
      parser.pushLine(command("item.started", "cmd1"));
      expect(parser.checkpoint!().tool_trail.at(-1)).toMatchObject({ tool: "shell", target: "npm test", status: "started" });
      parser.pushLine(command("item.completed", "cmd1"));
      const trail = parser.checkpoint!().tool_trail;
      expect(trail.at(-1)).toMatchObject({ tool: "shell", status: "ok" });
      expect(trail.filter((step) => step.status === "started")).toEqual([]);
      expect(trail.filter((step) => step.tool === "shell")).toHaveLength(1);
    });
  });

  it("DSH accepts callId on tool start and tool result events", () => {
    const parser = new DshAdapter().createStreamParser();
    parser.pushLine(line({ type: "tool_call", callId: "c1", name: "read", input: { path: "a.ts" } }));
    parser.pushLine(line({ type: "tool_call", callId: "c2", name: "read", input: { path: "b.ts" } }));
    parser.pushLine(line({ type: "tool_result", callId: "c1", name: "read" }));
    parser.pushLine(line({ type: "tool_result", callId: "c2", name: "read", isError: true }));
    expect(parser.checkpoint!().tool_trail).toEqual([
      { tool: "read", target: "a.ts", status: "ok" },
      { tool: "read", target: "b.ts", status: "error" },
    ]);
  });
});
