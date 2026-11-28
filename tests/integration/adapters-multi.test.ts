import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ARGV_PROMPT_BYTES } from "../../src/adapters/parsers.js";
import { AdapterRegistry, createBuiltinAdapters } from "../../src/adapters/registry.js";
import type { BuildInvocationInput } from "../../src/adapters/types.js";
import { DRIVER_KINDS, DRIVER_METADATA, type DriverKind } from "../../src/drivers.js";
import { isolateCliHomes } from "../unit/helpers/stub-clis.js";

const registry = new AdapterRegistry();
let jobDir: string;

let savedOpencodeConfigContent: string | undefined;

let restoreCliHomes: () => void = () => undefined;

beforeEach(() => {
  jobDir = mkdtempSync(join(tmpdir(), "orch-cli-adapters-"));
  // The real user's CLI configuration (MCP servers of Codex, DSH, OpenCode, Copilot) must never reach an assertion.
  restoreCliHomes = isolateCliHomes(jobDir);
  // The host's inline OpenCode config must never leak into adapter assertions: save it, clear it, restore it after.
  savedOpencodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
  delete process.env.OPENCODE_CONFIG_CONTENT;
});
afterEach(() => {
  restoreCliHomes();
  vi.unstubAllEnvs();
  if (savedOpencodeConfigContent === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
  else process.env.OPENCODE_CONFIG_CONTENT = savedOpencodeConfigContent;
  rmSync(jobDir, { force: true, recursive: true });
});

/** Stands in for a CLI: answers `--help` the way Vercel fx does (its identity is checked before it is run), else prints nothing. */
const STUB_BODY = 'const args = process.argv.slice(2); if (args.length === 1 && args[0] === "--help") console.log("Usage: fx ask | fx acp");';

function input(driver: DriverKind): BuildInvocationInput {
  // An adapter refuses a binary it cannot resolve, so the harness always points at an existing executable.
  const binary = join(jobDir, DRIVER_METADATA[driver].defaultBinary);
  if (!existsSync(binary)) mock(binary, STUB_BODY);
  return {
    harnessId: driver,
    harness: { driver, display_name: driver, binary, enabled: true },
    modelId: "test",
    model: {
      display_name: "Test", harness: driver, cli_model: "demo", cli_provider: "test-provider",
      tier: "standard", efforts: ["medium", "high"], default_effort: "medium", cost_tier: "low", cost_note: "",
      speed_note: "", context_window: 1000, strengths: [], weaknesses: [], best_for: [], avoid_for: [],
      checked_at: "2026-11-25", enabled: true,
    },
    effort: "high", mode: "readonly", prompt: "--help\nA quoted 'question'?", systemContext: "Answer briefly.",
    cwd: jobDir, jobDir, inheritMcp: false, isGitRepo: false,
  };
}

type NewDriver = Exclude<DriverKind, "claude" | "codex" | "pi" | "dsh">;
const flags = {
  antigravity: { read: ["--mode", "plan", "--settings", '{"allowNonWorkspaceAccess":false}'], write: ["--mode", "accept-edits"], deny: ["--dangerously-skip-permissions", "--mode=auto", "--disable-slash-commands", "--settings"] },
  opencode: { read: ["--agent", "orch-readonly"], write: ["--agent", "orch-write", "--auto"], deny: ["--agent", "--auto"] },
  gemini: { read: ["--approval-mode", "plan"], write: ["--approval-mode", "auto_edit", "--skip-trust"], deny: ["--approval-mode", "-y", "--yolo", "--allowed-tools"] },
  qwen: { read: ["--approval-mode", "plan"], write: ["--approval-mode", "auto-edit"], deny: ["--approval-mode", "-y", "--yolo", "--allowed-tools"] },
  cursor: { read: ["--mode", "plan"], write: ["--force", "--trust"], deny: ["--force", "--yolo", "--approve-mcps", "--mode"] },
  grok: { read: ["--sandbox", "read-only"], write: ["--sandbox", "workspace", "--always-approve"], deny: ["--always-approve", "--sandbox"] },
  kiro: { read: ["--trust-tools=fs_read"], write: ["--trust-all-tools"], deny: ["--trust-all-tools", "--trust-tools=anything"] },
  fx: { read: [], write: ["--provider", "test-provider", "--effort", "high"], deny: [] },
  muse: { read: ["--read-only"], write: ["--trust-workspace", "--disable-approval"], deny: ["--yolo", "--disable-sandbox", "--disable-approval"] },
  copilot: { read: ["--deny-tool", "write", "--deny-tool", "shell"], write: ["--allow-all-tools"], deny: ["--yolo", "--allow-all", "--allow-all-tools", "--allow-tool"] },
  droid: { read: ["--reasoning-effort", "high"], write: ["--auto", "medium"], deny: ["--auto", "--skip-permissions-unsafe"] },
  kimi: { read: ["--agent-file"], write: ["--print", "--output-format", "stream-json"], deny: ["--agent-file", "--yolo", "--auto"] },
  vibe: { read: ["--enabled-tools", "read_file,grep,list_dir"], write: ["--auto-approve"], deny: ["--auto-approve", "--enabled-tools", "--agent"] },
} satisfies Record<NewDriver, { read: string[]; write: string[]; deny: string[] }>;
const drivers = Object.keys(flags) as NewDriver[];

function mock(path: string, body: string): void {
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
}

function containsSequence(args: string[], sequence: string[]): void {
  const index = args.indexOf(sequence[0]);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(args.slice(index, index + sequence.length)).toEqual(sequence);
}

describe("built-in registry", () => {
  it("covers the entire driver contract once", () => {
    expect(DRIVER_KINDS).toHaveLength(17);
    expect(createBuiltinAdapters().map((adapter) => adapter.driver).sort()).toEqual([...DRIVER_KINDS].sort());
    for (const driver of DRIVER_KINDS) expect(registry.get(driver).driver).toBe(driver);
  });

  it("limits parallel diagnostics and releases slots even on probe failure", async () => {
    let active = 0;
    let peak = 0;
    const timeouts = new Map<string, number | undefined>();
    const pool = new AdapterRegistry();
    for (const adapter of createBuiltinAdapters()) {
      vi.spyOn(adapter, "probe").mockImplementation(async (id, harness, options) => {
        active++;
        peak = Math.max(active, peak);
        timeouts.set(id, options?.timeoutMs);
        await setImmediate();
        active--;
        if (id === "codex") throw new Error("mock probe failed");
        return {
          harness: id, driver: harness.driver, installed: true, enabled: true, auth_status: "unknown",
          checked_at: new Date().toISOString(), security_guarantees: adapter.securityGuarantees,
        };
      });
      pool.register(adapter);
    }
    const health = await Promise.all(DRIVER_KINDS.map((driver) =>
      pool.probeHarness(driver, input(driver).harness, driver === "pi" ? { timeoutMs: 321 } : {})));
    expect(peak).toBe(4);
    expect(health.find((item) => item.driver === "codex")?.note).toContain("mock probe failed");
    for (const driver of DRIVER_KINDS) expect(timeouts.get(driver)).toBe(driver === "pi" ? 321 : DRIVER_METADATA[driver].probeTimeoutMs);
  });
});

describe.each(drivers)("%s invocation", (driver) => {
  it("delivers the prompt to a mock executable and selects the requested access mode", async () => {
    const request = input(driver);
    const adapter = registry.get(driver);
    mock(request.harness.binary, `
      const fs = require("node:fs");
      const args = process.argv.slice(2);
      if (args.length === 1 && args[0] === "--help") { console.log("Usage: fx ask | fx acp"); process.exit(0); }
      const stdin = fs.readFileSync(0, "utf8");
      const i = args.findIndex(arg => arg === "-f" || arg === "--prompt-file");
      const file = i >= 0 ? fs.readFileSync(args[i + 1], "utf8") : undefined;
      console.log(JSON.stringify({ args, stdin, file }));
    `);
    expect(adapter.securityGuarantees).toEqual({ readonly: driver === "fx" ? "unsandboxed" : "tool_allowlist", write: "unsandboxed" });
    for (const mode of ["readonly", "write"] as const) {
      if (mode === "readonly" && driver === "fx") {
        await expect(adapter.buildInvocation(request)).rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
        continue;
      }
      const invocation = await adapter.buildInvocation({ ...request, mode });
      const child = spawnSync(invocation.command, invocation.args, {
        input: invocation.stdin, encoding: "utf8", timeout: 3000, cwd: jobDir, env: { ...process.env, ...invocation.envOverrides },
      });
      expect(child.status, child.stderr).toBe(0);
      const { args, stdin, file } = JSON.parse(child.stdout);
      containsSequence(args, flags[driver][mode === "readonly" ? "read" : "write"]);
      const delivery = DRIVER_METADATA[driver].promptDelivery;
      if (delivery === "stdin") {
        expect(stdin).toContain(request.prompt);
        expect(args.join(" ")).not.toContain(request.prompt);
      } else {
        expect(stdin).toBe("");
        expect(delivery === "file" ? file : args.at(-1)).toContain(request.prompt);
      }
      if (mode === "write") expect(invocation.warnings.join(" ")).toContain("unsandboxed");
      if (mode === "readonly" && driver === "droid") expect(args).not.toContain("--auto");
      if (driver === "cursor" || driver === "kiro" || driver === "fx") expect(args.at(-2)).toBe("--");
      if (driver === "kimi" || driver === "vibe") expect(args.at(-1)).toMatch(/^--prompt=/);
      if (driver === "copilot") {
        expect(args.at(-1)).toMatch(/^-p=/);
        expect(args).toContain("--disable-builtin-mcps");
      }
      if (driver === "grok") {
        expect(args.at(-1)).toBe(`--single=${request.prompt}`);
        const [path] = invocation.tempFiles;
        containsSequence(args, ["--system-prompt-file", path]);
        expect(readFileSync(path, "utf8")).toBe(request.systemContext);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    }
  });

  if (flags[driver].deny.length) {
    it("rejects configured readonly overrides", async () => {
      for (const flag of flags[driver].deny) {
        const request = input(driver);
        request.harness.extra_args = [flag];
        await expect(registry.get(driver).buildInvocation(request)).rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
      }
    });
  }

  if (DRIVER_METADATA[driver].promptDelivery === "argv") {
    it("rejects oversized UTF-8 argv before spawn", async () => {
      const request = { ...input(driver), mode: "write" as const, prompt: "é".repeat(MAX_ARGV_PROMPT_BYTES / 2 + 1) };
      await expect(registry.get(driver).buildInvocation(request)).rejects.toMatchObject({
        code: "PROMPT_TOO_LARGE", details: { limit_bytes: MAX_ARGV_PROMPT_BYTES },
      });
    });
  }
});

describe("driver-specific contracts", () => {
  it("keeps the Antigravity prompt attached and never combines two effort selectors", async () => {
    const request = input("antigravity");
    const adapter = registry.get("antigravity");
    request.harness.extra_args = ["--verbose"];
    const run = await adapter.buildInvocation(request);
    expect(run.stdin).toBe("");
    expect(run.args.at(-2)).toBe("--verbose");
    expect(run.args.at(-1)).toMatch(/^--print=/);
    expect(run.args.at(-1)).toContain("do not ask for plan confirmation");
    expect(run.args.at(-1)).toContain(request.systemContext);
    containsSequence(run.args, ["--effort", "high"]);
    expect(run.args).not.toContain("--disable-slash-commands");
    expect(run.warnings.join(" ")).toContain("MCP");
    request.model.cli_model = "demo-xhigh";
    request.harness.write_permission_mode = "acceptEdits";
    request.mode = "write";
    const suffixed = await adapter.buildInvocation(request);
    containsSequence(suffixed.args, ["--model", "demo-xhigh"]);
    containsSequence(suffixed.args, ["--mode", "accept-edits"]);
    expect(suffixed.args).not.toContain("--effort");
    expect(suffixed.warnings.join(" ")).toContain("effort");
  });

  it("selects the OpenCode standalone agent and its v2 permissions", async () => {
    const request = input("opencode");
    const adapter = registry.get("opencode");
    const run = await adapter.buildInvocation(request);
    expect(run.args.slice(0, 4)).toEqual(["run", "--standalone", "--format", "json"]);
    expect(run.args).not.toContain("--auto");
    expect(run.stdin).toBe(request.prompt);
    containsSequence(run.args, ["--model", "test-provider/demo#high"]);
    const config = JSON.parse(run.envOverrides!.OPENCODE_CONFIG_CONTENT);
    expect(config.agents["orch-readonly"]).toEqual({
      mode: "primary", system: request.systemContext,
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        ...["read", "grep", "glob", "list"].map((action) => ({ action, resource: "*", effect: "allow" })),
      ],
    });
    request.model.efforts = ["default"];
    request.effort = "default";
    request.mode = "write";
    const write = await adapter.buildInvocation(request);
    containsSequence(write.args, ["--model", "test-provider/demo"]);
    expect(JSON.parse(write.envOverrides!.OPENCODE_CONFIG_CONTENT).agents).toEqual({ "orch-write": { mode: "primary", system: request.systemContext } });
  });

  it.each(["gemini", "qwen"] as const)("%s reads headless input and restricts MCP in readonly", async (driver) => {
    const request = input(driver);
    request.inheritMcp = true;
    const run = await registry.get(driver).buildInvocation(request);
    expect(run.args.slice(-2)).toEqual(["-p", " "]);
    expect(run.stdin).toContain(request.systemContext);
    containsSequence(run.args, ["--allowed-mcp-server-names", "__orch_none__"]);
    // Readonly never forces workspace trust.
    expect(run.args).not.toContain("--skip-trust");
    if (driver === "gemini") containsSequence(run.args, ["-e", "none"]);
    expect(run.envOverrides?.GEMINI_SYSTEM_MD).toBeUndefined();
    expect(run.warnings.join(" ")).toContain("--effort");
    request.mode = "write";
    const write = await registry.get(driver).buildInvocation(request);
    expect(write.args).not.toContain("--allowed-mcp-server-names");
    // Only write mode needs a trusted workspace for its edit approvals.
    expect(write.args.includes("--skip-trust")).toBe(driver === "gemini");
  });

  it.each(["muse", "droid"] as const)("%s accepts large prompts via a private file", async (driver) => {
    const request = input(driver);
    request.prompt = "z".repeat(MAX_ARGV_PROMPT_BYTES + 1);
    const run = await registry.get(driver).buildInvocation(request);
    const [path] = run.tempFiles;
    expect(basename(path)).toBe(`${driver}-prompt.txt`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain(request.prompt);
    expect(readFileSync(path, "utf8")).toContain(request.systemContext);
    expect(run.args.join(" ")).not.toContain(request.prompt);
  });

  it("uses a private Kimi agent with only the three read tools", async () => {
    const run = await registry.get("kimi").buildInvocation(input("kimi"));
    const [path] = run.tempFiles;
    containsSequence(run.args, ["--agent-file", path]);
    expect(basename(path)).toBe("kimi-readonly-agent.yaml");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const { agent } = parseYaml(readFileSync(path, "utf8"));
    expect(agent.tools).toEqual(["ReadFile", "Glob", "Grep"].map((tool) => "kimi_cli.tools.file:" + tool));
    expect(agent.allowed_tools).toEqual(["ReadFile", "Glob", "Grep"]);
    expect(agent.subagents).toEqual({});
  });
});

type Response = [stdout: string, exit?: number];
async function probe(driver: DriverKind, responses: Record<string, Response>, name = DRIVER_METADATA[driver].defaultBinary) {
  const harness = input(driver).harness;
  const log = join(jobDir, "probes.jsonl");
  harness.binary = join(jobDir, name);
  mock(harness.binary, `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
    const response = ${JSON.stringify(responses)}[args.join(" ")];
    if (!response) process.exit(98);
    console.log(response[0]);
    process.exitCode = response[1] || 0;
  `);
  const health = await registry.get(driver).probe(driver, harness, { timeoutMs: 2000 });
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { health, calls };
}

describe("identity, version, and authentication diagnostics", () => {
  it.each([
    ["{}", "fx - interactive JSON viewer", false],
    ["[]", "usage: fx ask", true],
    ['{"auth":"ready","version":"1.4.0"}', "", true],
    ['{"auth":"missing","provider":"demo"}', "", true],
  ] as const)("recognizes fx from status %s and help %s", async (status, help, installed) => {
    const { health, calls } = await probe("fx", { "status --json": [status], "--help": [help], "--version": ["1.4.0"] });
    expect(calls[0]).toEqual(["status", "--json"]);
    expect(health.installed).toBe(installed);
    if (!installed) expect(health.note).toContain("JSON viewer collision");
    if (status.includes("ready")) expect(health).toMatchObject({ version: "1.4.0", auth_status: "ready" });
    if (status.includes("missing")) expect(health.auth_status).toBe("unauthenticated");
  });

  it.each([
    ["1.0.0", "Generic agent service", false],
    ["1.0.0", "Cursor Agent CLI", true],
    ["2026.09.25-ab12ef", "", true],
  ] as const)("checks a generic agent reporting %s and %s", async (version, help, installed) => {
    const { health } = await probe("cursor", { "--version": [version], "--help": [help] }, "agent");
    expect(health.installed).toBe(installed);
    if (!installed) expect(health.note).toContain("not Cursor CLI");
  });

  it.each([
    ["1.5.17", "gemini-pro\ngemini-flash", "ready", true],
    ["1.5.11", "Please sign in to list models", "unauthenticated", false],
    ["1.5.12", "", "unknown", true],
  ] as const)("uses agy models with version %s", async (version, models, auth, supported) => {
    const { health, calls } = await probe("antigravity", { "--version": [version], models: [models] });
    expect(calls).toEqual([["--version"], ["models"]]);
    expect(health).toMatchObject({ auth_status: auth, version_supported: supported });
  });

  it.each([
    ["1.9.1", "stored", "ready", false],
    ["2.2.1", "", "unauthenticated", true],
    ["2.0.18", "provider information", "unknown", true],
  ] as const)("checks OpenCode %s without exporting credentials", async (version, authList, auth, supported) => {
    const { health, calls } = await probe("opencode", { "--version": [version], "auth list --standalone": [authList] });
    expect(calls).toEqual([["--version"], ["auth", "list", "--standalone"]]);
    expect(health).toMatchObject({ auth_status: auth, version_supported: supported });
    if (!supported) expect(health.note).toContain("v2.0.18+");
  });

  it.each([
    ['\n{"account":"demo"}\nother output', 0, "ready"],
    ['{"account":null}', 0, "unauthenticated"],
    ["no account", 1, "unauthenticated"],
    ["not json", 0, "unknown"],
  ] as const)("interprets Kiro account response %s", async (result, exit, auth) => {
    const { health, calls } = await probe("kiro", { "--version": ["2.0.0"], "whoami --format json": [result, exit] });
    expect(calls).toContainEqual(["whoami", "--format", "json"]);
    expect(health.auth_status).toBe(auth);
  });

  it.each([["grok", "XAI_API_KEY"], ["droid", "FACTORY_API_KEY"], ["kimi", "MOONSHOT_API_KEY"], ["qwen", "QWEN_API_KEY"], ["vibe", "MISTRAL_API_KEY"]] as const)(
    "checks %s auth without exposing the value", async (driver, key) => {
      vi.stubEnv(key, "fixture-only-value");
      const { health } = await probe(driver, { "--version": ["2.0.0"] });
      expect(health.auth_status).toBe("ready");
      expect(JSON.stringify(health)).not.toContain("fixture-only-value");
    },
  );

  it("reads Gemini auth selection from the user's settings", async () => {
    vi.stubEnv("HOME", jobDir);
    for (const key of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA"]) vi.stubEnv(key, undefined);
    const { health: missing } = await probe("gemini", { "--version": ["0.55.1"] });
    expect(missing.auth_status).toBe("unknown");
    mkdirSync(join(jobDir, ".gemini"));
    writeFileSync(join(jobDir, ".gemini", "settings.json"), '{"security":{"auth":{"selectedType":"oauth-personal"}}}');
    const { health } = await probe("gemini", { "--version": ["0.55.1"] });
    expect(health.auth_status).toBe("ready");
  });

  it.each([["1.4.1", false], ["1.4.2", true]] as const)("checks Muse %s", async (version, supported) => {
    const { health } = await probe("muse", { "--version": [version] });
    expect(health.version_supported).toBe(supported);
  });
});

function parse(driver: DriverKind, events: unknown[], exitCode = 0) {
  const parser = registry.get(driver).createStreamParser();
  for (const event of events) parser.pushLine(typeof event === "string" ? event : JSON.stringify(event));
  return parser.finish({ exitCode, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0 });
}

describe("result streams", () => {
  const agy = { status: "SUCCESS", response: "done", usage: { input_tokens: 12, output_tokens: 5, cache_read_tokens: 3 } };
  it.each([agy, { event: "result", result: agy }])("accepts direct and wrapped Antigravity results", (event) => {
    expect(parse("antigravity", [event])).toMatchObject({ ok: true, summary: "done", usage: { input_tokens: 12, output_tokens: 5, cached_input_tokens: 3 } });
  });

  it.each(["ERROR", "CANCELLED"])("treats Antigravity status %s at clean exit as failure", (status) => {
    expect(parse("antigravity", [{ status, error: { message: "failed" } }])).toMatchObject({ ok: false, error: { code: "NON_ZERO_EXIT" } });
  });

  it("collects OpenCode text separately per message and totals step usage", () => {
    expect(parse("opencode", [
      { type: "text", part: { messageID: "previous", text: "working" } },
      { type: "step_finish", part: { tokens: { input: 2, output: 1, cache: { read: 1 } }, cost: 0.25 } },
      { type: "text", part: { messageID: "final", text: "all " } },
      { type: "message", part: { messageID: "previous", text: "..." } },
      { type: "text", part: { messageID: "final", text: "done" } },
      { type: "step_finish", part: { tokens: { input: 3, output: 2 }, cost: 0.5 } },
    ])).toMatchObject({ ok: true, summary: "all done", usage: { input_tokens: 5, output_tokens: 3, cached_input_tokens: 1, cost_usd: 0.75 } });
  });

  it("classifies explicit OpenCode provider.auth without relying on English text", () => {
    expect(parse("opencode", [{ type: "error", error: { type: "provider.auth", message: "model not found" } }]))
      .toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
  });

  it.each(["gemini", "qwen"] as const)("extracts %s JSON and model token totals", (driver) => {
    expect(parse(driver, [{
      response: "answer", stats: { models: {
        a: { tokens: { prompt: 9, candidates: 2, cached: 3 } },
        b: { tokens: { input: 4, output: 3 } },
      } },
    }])).toMatchObject({ ok: true, summary: "answer", usage: { input_tokens: 13, output_tokens: 5, cached_input_tokens: 3 } });
    expect(parse(driver, [{ type: "result", result: "stream result" }])).toMatchObject({ ok: true, summary: "stream result" });
    expect(parse(driver, [{ error: { message: "session ended" } }], 41)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(parse(driver, [], 41)).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(parse(driver, [{ error: { message: "model not found for this account" } }], 41))
      .toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
  });

  it.each(["cursor", "droid", "grok", "fx", "vibe"] as const)("%s accepts a whole pretty-printed JSON result", (driver) => {
    const event = driver === "fx" ? { final_output: "done" } : { type: "result", result: "done" };
    const lines = JSON.stringify({ ...event, usage: { output_tokens: 3 } }, null, 2).split("\n");
    expect(parse(driver, lines)).toMatchObject({ ok: true, summary: "done", usage: { output_tokens: 3 } });
  });

  it.each(["kiro", "muse", "copilot", "kimi"] as const)("%s handles NDJSON, errors and degraded text", (driver) => {
    expect(parse(driver, [
      { type: "message", role: "user", content: "input" },
      { type: "text", text: "one" }, { type: "delta", delta: { text: " two" } },
    ])).toMatchObject({ ok: true, summary: "one two" });
    expect(parse(driver, [{ type: "result", result: "done" }])).toMatchObject({ ok: true, summary: "done" });
    expect(parse(driver, [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }]))
      .toMatchObject({ ok: true, summary: "done" });
    expect(parse(driver, [{ type: "error", error: { message: "failed" } }])).toMatchObject({ ok: false, error: { code: "NON_ZERO_EXIT" } });
    expect(parse(driver, ["raw", "text"])).toMatchObject({ ok: true, summary: "raw\ntext", parseDegraded: true });
  });

  it("keeps Muse run usage alongside output deltas", () => {
    expect(parse("muse", [
      { type: "RunOutputDelta", delta: "d" }, { type: "RunOutputDelta", data: { delta: "one" } },
      { type: "run.usage", usage: { input_tokens: 7, output_tokens: 3 } },
    ])).toMatchObject({ ok: true, summary: "done", usage: { input_tokens: 7, output_tokens: 3 } });
  });

  it("extracts a single pretty-printed Copilot result", () => {
    expect(parse("copilot", JSON.stringify({ content: "answer" }, null, 2).split("\n")))
      .toEqual({ ok: true, summary: "answer" });
  });
});
