import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../../src/adapters/antigravity.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { DshAdapter } from "../../src/adapters/dsh.js";
import { CopilotAdapter, KimiAdapter } from "../../src/adapters/ecosystem.js";
import { GeminiAdapter } from "../../src/adapters/gemini.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import {
  BoundedMessages, MAX_DIAGNOSTIC_MESSAGES, assertCommandLineFits, versionAtLeast, windowsCommandLineLength,
} from "../../src/adapters/parsers.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import {
  binaryStem, classifiedFailure, execProbe, resolveBinary, requireLaunch, safeDetailLabel, unwrapLauncher, verifyBinaryIdentity,
} from "../../src/adapters/probe-utils.js";
import type { BuildInvocationInput, CliAdapter, ParsedAdapterResult } from "../../src/adapters/types.js";
import { CursorAdapter, FxAdapter, KiroAdapter, MuseAdapter } from "../../src/adapters/vendor-clis.js";
import { ConfigManager } from "../../src/config/resolver.js";
import { DRIVER_KINDS, DRIVER_METADATA } from "../../src/drivers.js";
import { buildPlanPreview } from "../../src/planner/preview.js";
import type { DriverKind, HarnessHealth, RunMode } from "../../src/types.js";
import { installStubClis, type StubCliEnvironment } from "./helpers/stub-clis.js";

let root: string;
let jobCounter = 0;
let stubClis: StubCliEnvironment;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-adapter-wave3-"));
  stubClis = installStubClis(DRIVER_KINDS);
});

afterAll(() => {
  stubClis.restore();
  rmSync(root, { recursive: true, force: true });
});

interface RequestOptions {
  extraArgs?: string[];
  inheritMcp?: boolean;
  allowUnsandboxedWrite?: boolean;
  binary?: string;
  cwd?: string;
}

function request(driver: DriverKind, mode: RunMode, options: RequestOptions = {}): BuildInvocationInput {
  jobCounter += 1;
  const jobDir = join(root, `job-${jobCounter}`);
  return {
    harnessId: driver,
    harness: { driver, display_name: driver, binary: options.binary ?? driver, enabled: true, extra_args: options.extraArgs ?? [] },
    modelId: "test",
    model: {
      display_name: "Test", harness: driver, cli_model: "demo", tier: "standard", efforts: ["medium", "high"],
      default_effort: "medium", cost_tier: "low", cost_note: "", speed_note: "", context_window: 1000, strengths: [],
      weaknesses: [], best_for: [], avoid_for: [], checked_at: "2026-11-25", enabled: true,
    },
    effort: "high", mode, prompt: "question", cwd: options.cwd ?? root, jobDir, inheritMcp: options.inheritMcp ?? false, isGitRepo: true,
    ...(options.allowUnsandboxedWrite === undefined ? {} : { allowUnsandboxedWrite: options.allowUnsandboxedWrite }),
  };
}

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

// ---------------------------------------------------------------------------
// 1. Sandbox-weakening extra_args are refused in write mode too
// ---------------------------------------------------------------------------

describe("write mode refuses sandbox-weakening extra_args unless allow_unsandboxed_write is true", () => {
  const cases: Array<[string, CliAdapter, string[][]]> = [
    ["codex", new CodexAdapter(), [
      ["--dangerously-bypass-approvals-and-sandbox"], ["--yolo"], ["-s", "danger-full-access"], ["--sandbox", "danger-full-access"],
      ["--sandbox=danger-full-access"], ["-c", 'sandbox_mode="danger-full-access"'], ["--config=approval_policy=\"never\""],
      // Widening the writable area or the permission profile is the same bypass by another route.
      ["--add-dir", "/"], ["--add-dir=/"], ["-c", 'sandbox_permissions=["disk-full-write-access"]'],
      ["-c", "profiles={x={sandbox_workspace_write={network_access=true}}}", "-c", 'profile="x"'], ["-c", 'default_permissions="full"'],
    ]],
    ["claude", new ClaudeAdapter(), [
      ["--dangerously-skip-permissions"], ["--permission-mode", "bypassPermissions"],
      ["--allowedTools", "Bash"], ["--allowed-tools=Bash(*)"], ["--tools", "Bash"], ["--add-dir", "/"],
    ]],
    ["dsh", new DshAdapter(), [["--permission-mode", "danger-full-access"], ["--approval-policy=never"]]],
    ["gemini", new GeminiAdapter(), [["--yolo"], ["-y"], ["--approval-mode", "yolo"]]],
    ["antigravity", new AntigravityAdapter(), [["--dangerously-skip-permissions"]]],
    ["copilot", new CopilotAdapter(), [["--yolo"], ["--allow-all"]]],
  ];

  for (const [name, adapter, forbidden] of cases) {
    it(`${name} refuses them by default and accepts them only with an explicit true`, async () => {
      for (const args of forbidden) {
        const label = `${name} ${args.join(" ")}`;
        await expect(build(adapter, request(adapter.driver, "write", { extraArgs: args })), label).rejects.toMatchObject(VIOLATION);
        await expect(build(adapter, request(adapter.driver, "write", { extraArgs: args, allowUnsandboxedWrite: false })), label)
          .rejects.toMatchObject(VIOLATION);
        const allowed = await build(adapter, request(adapter.driver, "write", { extraArgs: args, allowUnsandboxedWrite: true }));
        expect(allowed.args, label).toEqual(expect.arrayContaining(args.slice(0, 1)));
      }
    });
  }

  it.each([["--mcp-config", "servers.json"], ["--mcp-config=servers.json"]])(
    "claude refuses %s in write mode while MCP isolation or the sandbox is required, and allows it only when both are waived", async (...args) => {
      const claude = new ClaudeAdapter();
      // inherit_mcp = false: refused even though unsandboxed writes are allowed.
      await expect(build(claude, request("claude", "write", { extraArgs: args, allowUnsandboxedWrite: true, inheritMcp: false })))
        .rejects.toMatchObject({ ...VIOLATION, message: expect.stringContaining("MCP server process") });
      // allow_unsandboxed_write false or unset: refused even though MCP is inherited.
      await expect(build(claude, request("claude", "write", { extraArgs: args, allowUnsandboxedWrite: false, inheritMcp: true }))).rejects.toMatchObject(VIOLATION);
      await expect(build(claude, request("claude", "write", { extraArgs: args, inheritMcp: true }))).rejects.toMatchObject(VIOLATION);
      // Both waived explicitly: the user's own argument passes through.
      const allowed = await build(claude, request("claude", "write", { extraArgs: args, allowUnsandboxedWrite: true, inheritMcp: true }));
      expect(allowed.args).toEqual(expect.arrayContaining(args));
      // Unrelated flags that merely start with the same letters are not touched.
      const other = await build(claude, request("claude", "write", { extraArgs: ["--mcp-configuration-note"], allowUnsandboxedWrite: true }));
      expect(other.args).toContain("--mcp-configuration-note");
    });

  it("does not refuse harmless codex extra_args in write mode", async () => {
    const invocation = await build(new CodexAdapter(), request("codex", "write", { extraArgs: ["--color", "never", "-c", "model_verbosity=\"low\""] }));
    expect(invocation.args).toEqual(expect.arrayContaining(["--color", "never"]));
  });
});

// ---------------------------------------------------------------------------
// 2. Copilot readonly
// ---------------------------------------------------------------------------

describe("copilot readonly invocation", () => {
  let copilotHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    copilotHome = mkdtempSync(join(root, "copilot-home-"));
    previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = copilotHome;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousHome;
  });

  it("grants nothing, denies write and shell, and denies each configured MCP server by its own name", async () => {
    writeFileSync(join(copilotHome, "mcp-config.json"), JSON.stringify({ mcpServers: { github: {}, "my-db": {} } }));
    const invocation = await build(new CopilotAdapter(), request("copilot", "readonly"));
    for (const flag of ["--yolo", "--allow-all", "--allow-all-tools", "--allow-all-paths", "--allow-all-urls", "--allow-tool"]) {
      expect(invocation.args).not.toContain(flag);
    }
    const denied = invocation.args.flatMap((arg, index) => (invocation.args[index - 1] === "--deny-tool" ? [arg] : []));
    expect(denied).toEqual(expect.arrayContaining(["write", "shell", "github", "my-db"]));
    expect(denied).not.toContain("mcp");
    expect(invocation.args).toContain("--disable-builtin-mcps");
  });

  it("runs without an MCP config file (nothing to deny) and denies nothing extra for a config without servers", async () => {
    const missing = await build(new CopilotAdapter(), request("copilot", "readonly"));
    expect(missing.args.filter((arg, index) => missing.args[index - 1] === "--deny-tool")).toEqual(["write", "shell"]);
    writeFileSync(join(copilotHome, "mcp-config.json"), JSON.stringify({ somethingElse: true }));
    const empty = await build(new CopilotAdapter(), request("copilot", "readonly"));
    expect(empty.args.filter((arg, index) => empty.args[index - 1] === "--deny-tool")).toEqual(["write", "shell"]);
  });

  it.each([
    ["oversized", () => `{"mcpServers":{"a":{}},"pad":"${"x".repeat(1024 * 1024)}"}`],
    ["invalid JSON", () => '{"mcpServers": {'],
    ["not an object", () => "[1, 2]"],
    ["a servers entry that is not an object", () => JSON.stringify({ mcpServers: ["a"] })],
    ["too many servers", () => JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`s${i}`, {}])) })],
    ["an overlong server name", () => JSON.stringify({ mcpServers: { [`n${"x".repeat(128)}`]: {} } })],
    ["a dash-prefixed server name", () => JSON.stringify({ mcpServers: { "--allow-all": {}, ok: {} } })],
    ["an empty server name", () => JSON.stringify({ mcpServers: { "": {} } })],
  ])("refuses the run when the MCP config is %s and its servers cannot be denied", async (_label, content) => {
    writeFileSync(join(copilotHome, "mcp-config.json"), content());
    for (const [mode, inheritMcp] of [["readonly", true], ["readonly", false], ["write", false]] as const) {
      await expect(build(new CopilotAdapter(), request("copilot", mode, { inheritMcp, allowUnsandboxedWrite: true })))
        .rejects.toMatchObject({ ...VIOLATION, retryable: false, message: expect.stringContaining("mcp-config.json") });
    }
  });

  it("refuses an MCP config that cannot be read as a file, but never looks at it when MCP is inherited in a write run", async () => {
    mkdirSync(join(copilotHome, "mcp-config.json"));
    await expect(build(new CopilotAdapter(), request("copilot", "write", { allowUnsandboxedWrite: true }))).rejects.toMatchObject(VIOLATION);
    const inherited = await build(new CopilotAdapter(), request("copilot", "write", { allowUnsandboxedWrite: true, inheritMcp: true }));
    expect(inherited.args).not.toContain("--disable-builtin-mcps");
  });

  it("does not claim MCP isolation in the driver metadata, since Copilot cannot disable user servers", () => {
    expect(DRIVER_METADATA.copilot.mcpIsolation).toBe("none");
    expect(DRIVER_METADATA.cursor.mcpIsolation).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// 3. Unresolved binaries are never spawned from the job's working directory
// ---------------------------------------------------------------------------

describe("unresolved binaries", () => {
  it.each(DRIVER_KINDS.map((driver) => [driver]))("%s throws CLI_NOT_FOUND for a binary that exists nowhere", async (driver) => {
    const adapter = adapterFor(driver);
    await expect(build(adapter, request(driver, "write", { binary: "orch-definitely-missing-binary", allowUnsandboxedWrite: true })))
      .rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
  });

  it("never picks a same-named executable that sits in the job's working directory", async () => {
    const jobCwd = mkdtempSync(join(root, "hostile-cwd-"));
    writeFileSync(join(jobCwd, "orch-only-in-cwd"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await expect(build(new CodexAdapter(), request("codex", "readonly", { binary: "orch-only-in-cwd", cwd: jobCwd })))
      .rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
    await expect(build(new CodexAdapter(), request("codex", "readonly", { binary: "./orch-only-in-cwd", cwd: jobCwd })))
      .rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
  });

  it("skips relative PATH entries and resolves a relative binary against baseDir only", () => {
    const dir = mkdtempSync(join(root, "lookup-"));
    const tool = join(dir, "tool");
    writeFileSync(tool, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(resolveBinary("tool", { pathEnv: `.${":"}${dir}` })).toBe(tool);
    expect(resolveBinary("tool", { pathEnv: ".:./bin::relative" })).toBeUndefined();
    expect(resolveBinary("./tool", {})).toBeUndefined();
    expect(resolveBinary("./tool", { baseDir: dir })).toBe(tool);
    expect(() => requireLaunch("./tool", { baseDir: join(dir, "elsewhere") })).toThrowError(expect.objectContaining({ code: "CLI_NOT_FOUND" }));
  });
});

function adapterFor(driver: DriverKind): CliAdapter {
  return new AdapterRegistry().get(driver);
}

// ---------------------------------------------------------------------------
// 4. MCP isolation
// ---------------------------------------------------------------------------

describe("MCP isolation", () => {
  it("codex disables every server of the user's config by name, quoting awkward names", async () => {
    writeFileSync(join(stubClis.emptyHome, "config.toml"), [
      "[mcp_servers.github]", 'command = "gh"', "", '[mcp_servers."my server"]', 'command = "x"',
    ].join("\n"));
    try {
      const closed = await build(new CodexAdapter(), request("codex", "readonly"));
      // ONE inline table: Codex splits dotted `-c` keys on every dot and ignores quotes, so per-server keys would break it.
      const overrides = closed.args.filter((arg) => arg.startsWith("mcp_servers"));
      expect(overrides).toEqual(['mcp_servers={github={enabled=false},"my server"={enabled=false}}']);
      const inherited = await build(new CodexAdapter(), request("codex", "readonly", { inheritMcp: true }));
      expect(inherited.args.join(" ")).not.toContain("mcp_servers");
    } finally {
      rmSync(join(stubClis.emptyHome, "config.toml"), { force: true });
    }
  });

  it("codex addresses a server whose name holds a dot in a way Codex can load", async () => {
    writeFileSync(join(stubClis.emptyHome, "config.toml"), ['[mcp_servers."a.b"]', 'command = "x"'].join("\n"));
    try {
      const invocation = await build(new CodexAdapter(), request("codex", "readonly"));
      expect(invocation.args.filter((arg) => arg.startsWith("mcp_servers"))).toEqual(['mcp_servers={"a.b"={enabled=false}}']);
    } finally {
      rmSync(join(stubClis.emptyHome, "config.toml"), { force: true });
    }
  });

  it("codex runs with inherit_mcp = false when there is no config file (nothing to disable)", async () => {
    rmSync(join(stubClis.emptyHome, "config.toml"), { force: true });
    const invocation = await build(new CodexAdapter(), request("codex", "readonly"));
    expect(invocation.args.filter((arg) => arg.startsWith("mcp_servers"))).toEqual(["mcp_servers={}"]);
  });

  it.each([
    ["oversized", () => `# ${"x".repeat(1024 * 1024)}\n[mcp_servers.a]\ncommand = "x"\n`],
    ["invalid TOML", () => "[mcp_servers.a\ncommand ="],
    ["more than 64 servers", () => Array.from({ length: 65 }, (_, i) => `[mcp_servers.s${i}]\ncommand = "x"\n`).join("\n")],
    ["an overlong server name", () => `[mcp_servers."${"n".repeat(200)}"]\ncommand = "y"\n`],
    ["an empty server name", () => '[mcp_servers.""]\ncommand = "y"\n'],
    ["an mcp_servers entry that is not a table", () => 'mcp_servers = "none"\n'],
  ])("codex refuses the run when inherit_mcp is false and the config is %s", async (_label, content) => {
    writeFileSync(join(stubClis.emptyHome, "config.toml"), content());
    try {
      await expect(build(new CodexAdapter(), request("codex", "readonly")))
        .rejects.toMatchObject({ ...VIOLATION, retryable: false, message: expect.stringContaining("config.toml") });
      await expect(build(new CodexAdapter(), request("codex", "write"))).rejects.toMatchObject(VIOLATION);
      // With inherit_mcp = true the file is never consulted, so the same config runs.
      const inherited = await build(new CodexAdapter(), request("codex", "readonly", { inheritMcp: true }));
      expect(inherited.args.join(" ")).not.toContain("mcp_servers");
    } finally {
      rmSync(join(stubClis.emptyHome, "config.toml"), { force: true });
    }
  });

  it("codex refuses the run when config.toml exists but is not a regular file", async () => {
    mkdirSync(join(stubClis.emptyHome, "config.toml"));
    try {
      await expect(build(new CodexAdapter(), request("codex", "readonly"))).rejects.toMatchObject(VIOLATION);
    } finally {
      rmSync(join(stubClis.emptyHome, "config.toml"), { force: true, recursive: true });
    }
  });

  it("dsh switches off mcp-orchestrator and every configured mcp-* plugin, including nested inserts", async () => {
    writeFileSync(join(stubClis.emptyHome, "cordis.patch.yml"), [
      "- id: mcp-github", "- id: base", "  insert:", "    - id: mcp-nested", "    - id: not-mcp",
    ].join("\n"));
    try {
      const input = request("dsh", "readonly");
      await build(new DshAdapter(), input);
      const patch = parseYaml(readFileSync(join(input.jobDir, "dsh-patch.yml"), "utf8")) as Array<{ id: string; disabled?: boolean }>;
      const disabled = patch.filter((entry) => entry.disabled === true).map((entry) => entry.id);
      expect(disabled).toEqual(expect.arrayContaining(["mcp-orchestrator", "mcp-resources", "mcp-github", "mcp-nested"]));
      expect(disabled).not.toContain("not-mcp");

      const keep = request("dsh", "readonly", { inheritMcp: true });
      await build(new DshAdapter(), keep);
      const kept = parseYaml(readFileSync(join(keep.jobDir, "dsh-patch.yml"), "utf8")) as Array<{ id: string }>;
      expect(kept.map((entry) => entry.id)).not.toContain("mcp-orchestrator");
    } finally {
      rmSync(join(stubClis.emptyHome, "cordis.patch.yml"), { force: true });
    }
  });

  it("opencode disables servers of the user's config files and of the inline config", async () => {
    writeFileSync(join(stubClis.emptyHome, "opencode.json"), JSON.stringify({ mcp: { files: { type: "local", command: ["x"] } } }));
    const previousInline = process.env.OPENCODE_CONFIG_CONTENT;
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { inline: { type: "remote", url: "https://example.test" } } });
    try {
      const closed = await build(new OpenCodeAdapter(), request("opencode", "readonly"));
      const config = JSON.parse(closed.envOverrides!.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, { enabled: boolean; url?: string }> };
      expect(config.mcp.files).toMatchObject({ enabled: false });
      expect(config.mcp.inline).toMatchObject({ enabled: false, url: "https://example.test" });

      // A readonly run always closes MCP; only a write run may inherit it.
      const inherited = await build(new OpenCodeAdapter(), request("opencode", "write", { inheritMcp: true }));
      const inheritedConfig = JSON.parse(inherited.envOverrides!.OPENCODE_CONFIG_CONTENT) as { mcp: Record<string, { enabled?: boolean }> };
      expect(inheritedConfig.mcp.inline.enabled).not.toBe(false);
      expect(inheritedConfig.mcp.files).toBeUndefined();
    } finally {
      if (previousInline === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
      else process.env.OPENCODE_CONFIG_CONTENT = previousInline;
      rmSync(join(stubClis.emptyHome, "opencode.json"), { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5 & 6. error.details sanitizing; tool traffic never becomes the answer or an error
// ---------------------------------------------------------------------------

describe("error details and tool traffic", () => {
  it("sanitizes the claude result subtype before it reaches error.details", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const result = parseLines(new ClaudeAdapter(), [
      { type: "result", subtype: `error ${secret}\nline two`, is_error: true, result: "failed" },
    ], 1);
    const details = JSON.stringify(result.error?.details);
    expect(details).not.toContain(secret);
    expect(details).not.toMatch(/\\n|\s{2,}/);
  });

  it("sanitizes the dsh reason kind before it reaches error.details", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
    const result = parseLines(new DshAdapter(), [
      { type: "completed", text: "partial", reason: { kind: `weird ${secret}\nsecond line`, message: "stopped" } },
    ], 1);
    // The parser must reach the failure branch, otherwise "no secret in details" would hold trivially.
    expect(result.error).toMatchObject({ details: { reason_kind: expect.any(String) } });
    const kind = (result.error?.details as { reason_kind: string }).reason_kind;
    expect(kind).not.toContain("sk-abcdefghij");
    expect(kind).toMatch(/^[\w.:-]+$/);
  });

  it("keeps safeDetailLabel short, redacted and free of control characters", () => {
    expect(safeDetailLabel("")).toBeUndefined();
    expect(safeDetailLabel("a b\nc")).toBe("a_b_c");
    expect(safeDetailLabel("x".repeat(500))!.length).toBe(64);
  });

  it.each([
    ["kiro", new KiroAdapter()], ["muse", new MuseAdapter()], ["copilot", new CopilotAdapter()], ["kimi", new KimiAdapter()],
  ] as Array<[string, CliAdapter]>)("%s: a tool_result is neither the final answer nor an error", (_name, adapter) => {
    const result = parseLines(adapter, [
      { type: "result", result: "real answer" },
      { type: "tool_result", is_error: true, result: "usage limit reached", error: "rate limit 429", content: "401 unauthorized" },
      { type: "tool_use", name: "bash", is_error: true, error: "quota exceeded" },
    ]);
    expect(result).toMatchObject({ ok: true, summary: "real answer" });
  });
});

// ---------------------------------------------------------------------------
// 7. BoundedMessages
// ---------------------------------------------------------------------------

describe("BoundedMessages entry cap", () => {
  it("stops storing after the entry cap and never stores an empty string", () => {
    const messages = new BoundedMessages(10 * 1024 * 1024);
    messages.push("");
    expect(messages.length).toBe(0);
    for (let index = 0; index < MAX_DIAGNOSTIC_MESSAGES + 200; index += 1) messages.push(`m${index}`);
    expect(messages.length).toBe(MAX_DIAGNOSTIC_MESSAGES);
    expect(messages.values()[MAX_DIAGNOSTIC_MESSAGES - 1]).toBe(`m${MAX_DIAGNOSTIC_MESSAGES - 1}`);
  });
});

// ---------------------------------------------------------------------------
// 8. fx / agent identity
// ---------------------------------------------------------------------------

describe("binary identity", () => {
  it("treats agent.exe and AGENT like agent, and only strips known launcher extensions", () => {
    expect(binaryStem("C:\\tools\\agent.exe")).toBe("agent");
    expect(binaryStem("/usr/bin/AGENT")).toBe("agent");
    expect(binaryStem("/usr/bin/agent.sh")).toBe("agent.sh");
  });

  it("refuses to run an unrelated fx on the run path", async () => {
    const dir = mkdtempSync(join(root, "bad-fx-"));
    writeFileSync(join(dir, "fx"), "#!/bin/sh\necho 'JSON viewer'\nexit 0\n", { mode: 0o755 });
    await expect(build(new FxAdapter(), request("fx", "write", { binary: join(dir, "fx"), allowUnsandboxedWrite: true })))
      .rejects.toMatchObject({ code: "CLI_NOT_FOUND" });
  });

  it("caches a verdict by path, mtime and size, runs the check again after the file changed, never caches inconclusive", async () => {
    const dir = mkdtempSync(join(root, "identity-"));
    const path = join(dir, "bin");
    writeFileSync(path, "one");
    let checks = 0;
    const check = async () => { checks += 1; return "verified" as const; };
    await verifyBinaryIdentity("fx", path, check);
    await verifyBinaryIdentity("fx", path, check);
    expect(checks).toBe(1);
    writeFileSync(path, "changed contents");
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    await verifyBinaryIdentity("fx", path, check);
    expect(checks).toBe(2);

    // A different file of the same size with the old mtime restored (touch -r) must not reuse the cached verdict.
    const swapped = join(dir, "swapped");
    writeFileSync(swapped, "changed CONTENTS");
    const before = statSync(path);
    utimesSync(swapped, before.atime, before.mtime);
    renameSync(swapped, path);
    await verifyBinaryIdentity("fx", path, check);
    expect(checks).toBe(3);

    let inconclusiveChecks = 0;
    const inconclusive = async () => { inconclusiveChecks += 1; return "inconclusive" as const; };
    await verifyBinaryIdentity("fx-inconclusive", path, inconclusive);
    await verifyBinaryIdentity("fx-inconclusive", path, inconclusive);
    await verifyBinaryIdentity("fx-inconclusive", path, inconclusive);
    expect(inconclusiveChecks).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 9. Windows shims, PATHEXT, command-line length
// ---------------------------------------------------------------------------

describe("windows launch rules", () => {
  it("resolves through PATHEXT in order and never picks an extensionless POSIX shim", () => {
    const dir = mkdtempSync(join(root, "win-"));
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    expect(resolveBinary("tool", { platform: "win32", pathEnv: dir, pathExt: ".EXE;.CMD" })).toBeUndefined();
    writeFileSync(join(dir, "tool.cmd"), "@echo off\n", { mode: 0o755 });
    writeFileSync(join(dir, "tool.exe"), "MZ", { mode: 0o755 });
    // On a case-sensitive file system the lowercase names are looked up from the lowercased extension list.
    expect(resolveBinary("tool", { platform: "win32", pathEnv: dir, pathExt: ".EXE;.CMD" })).toBe(join(dir, "tool.exe"));
    expect(resolveBinary("tool", { platform: "win32", pathEnv: dir, pathExt: ".CMD;.EXE" })).toBe(join(dir, "tool.cmd"));
  });

  it("turns an npm .cmd shim into node plus its script, and refuses any other .cmd", () => {
    const dir = mkdtempSync(join(root, "shim-"));
    const script = join(dir, "node_modules", "pkg", "bin", "cli.js");
    mkdirSync(join(dir, "node_modules", "pkg", "bin"), { recursive: true });
    writeFileSync(script, "console.log(1)\n");
    const shim = join(dir, "pkg.cmd");
    writeFileSync(shim, [
      "@ECHO off", "SETLOCAL", 'SET "_prog=node"',
      '"%_prog%"  "%dp0%\\node_modules\\pkg\\bin\\cli.js" %*',
    ].join("\r\n"));
    const launch = unwrapLauncher(shim, "win32");
    expect(launch.command).toBe(process.execPath);
    expect(launch.prefixArgs).toHaveLength(1);

    const plain = join(dir, "plain.cmd");
    writeFileSync(plain, "@echo off\r\necho hi\r\n");
    expect(() => unwrapLauncher(plain, "win32")).toThrowError(expect.objectContaining({ code: "CLI_NOT_FOUND" }));
    // Other platforms never unwrap anything.
    expect(unwrapLauncher(plain, "linux")).toEqual({ command: plain, prefixArgs: [] });
  });

  it("rejects a command line over 32,767 characters on win32 only", () => {
    const longPrompt = "x".repeat(40_000);
    expect(() => assertCommandLineFits("Tool", "tool.exe", ["-p", longPrompt], "win32")).toThrowError(
      expect.objectContaining({ code: "PROMPT_TOO_LARGE" }));
    expect(() => assertCommandLineFits("Tool", "tool", ["-p", longPrompt], "linux")).not.toThrow();
    expect(() => assertCommandLineFits("Tool", "tool.exe", ["-p", "short"], "win32")).not.toThrow();
    // Quotes and trailing backslashes grow the line.
    expect(windowsCommandLineLength("a", ['say "hi"'])).toBeGreaterThan("a".length + 1 + 'say "hi"'.length);
  });
});

// ---------------------------------------------------------------------------
// 10. Classification, partial-output fallbacks, probes, auth accuracy
// ---------------------------------------------------------------------------

describe("failure classification priorities", () => {
  const classify = (text: string) => classifiedFailure("Tool", { exitCode: 1, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0 }, text, "NON_ZERO_EXIT").error;

  it("treats a per-minute quota message as a rate limit, not an exhausted quota", () => {
    expect(classify("429 Quota exceeded for metric requests per minute")).toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });

  it("treats a hard quota message as QUOTA_EXCEEDED even with a 429 status", () => {
    expect(classify("HTTP 429: you exceeded your current quota, check your plan and billing")).toMatchObject({ code: "QUOTA_EXCEEDED" });
  });

  it("lets a context overflow win over RESOURCE_EXHAUSTED", () => {
    expect(classify("RESOURCE_EXHAUSTED: input token count 2000000 exceeds the maximum number of tokens allowed")).toMatchObject({ code: "PROMPT_TOO_LARGE" });
  });

  it("classifies 401 and 403 as AUTH_REQUIRED", () => {
    expect(classify("HTTP 401 from the provider")).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(classify("status: 403 forbidden")).toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("streaming partial output fallbacks", () => {
  it("claude concatenates the blocks of one message when the final result text is empty", () => {
    const result = parseLines(new ClaudeAdapter(), [
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Hello, " }] } },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "world" }] } },
      { type: "result", subtype: "success", is_error: false, result: "" },
    ]);
    expect(result).toMatchObject({ ok: true, summary: "Hello, world" });
  });

  it("pi keeps streamed text when the run ends before message_end", () => {
    const result = parseLines(new PiAdapter(), [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial " } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } },
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } },
    ]);
    expect(result.summary).toBe("partial answer");
  });

  it("dsh joins streamed deltas without inserting newlines", () => {
    const result = parseLines(new DshAdapter(), [
      { type: "text", text: "ab" }, { type: "text", text: "cd" }, { type: "completed", reason: { kind: "completed" } },
    ], 0);
    expect(result).toMatchObject({ ok: true, summary: "abcd" });
  });

  it("kiro and kimi report streaming output so a stall is detectable", async () => {
    expect((await build(new KiroAdapter(), request("kiro", "readonly"))).outputMode).toBe("streaming");
    expect((await build(new KimiAdapter(), request("kimi", "readonly"))).outputMode).toBe("streaming");
  });
});

describe("probe hygiene", () => {
  const sh = spawnSync("sh", ["-c", "command -v setsid"], { encoding: "utf8" });
  const hasSetsid = sh.status === 0;

  it.skipIf(!hasSetsid || process.platform === "win32")("reaps a detached grandchild when the probe ends normally", async () => {
    const dir = mkdtempSync(join(root, "reap-"));
    const pidFile = join(dir, "pid");
    const script = join(dir, "spawner.sh");
    writeFileSync(script, `#!/bin/sh\nsetsid sh -c 'echo $$ > "${pidFile}"; exec sleep 30' >/dev/null 2>&1 &\nsleep 0.3\nexit 0\n`, { mode: 0o755 });
    chmodSync(script, 0o755);
    const output = await execProbe(script, [], 5_000);
    expect(output.ok).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt += 1) {
      try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) await new Promise((done) => setTimeout(done, 50));
    }
    expect(alive).toBe(false);
  });

  it("scrubs secrets before clipping the --version failure note", async () => {
    const dir = mkdtempSync(join(root, "version-note-"));
    const script = join(dir, "orch-version-fail");
    // The secret starts just before the 300-char clip, so clip-then-scrub would leave a recognizable prefix.
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    writeFileSync(script, `#!/bin/sh\necho "${"x".repeat(285)} ${secret}" >&2\nexit 3\n`, { mode: 0o755 });
    const health = await new CodexAdapter().probe("codex", { driver: "codex", display_name: "c", binary: script, enabled: true, extra_args: [] });
    expect(JSON.stringify(health)).not.toContain("sk-abcdefghijkl");
    expect(JSON.stringify(health)).not.toContain(secret.slice(0, 12));
  });
});

describe("auth accuracy", () => {
  it("gemini does not count an empty-string key as a credential", async () => {
    const home = mkdtempSync(join(root, "gemini-home-"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GEMINI_API_KEY: process.env.GEMINI_API_KEY, GOOGLE_API_KEY: process.env.GOOGLE_API_KEY };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.GEMINI_API_KEY = "";
    process.env.GOOGLE_API_KEY = "";
    try {
      const health = await new GeminiAdapter().probe("gemini", { driver: "gemini", display_name: "g", binary: "gemini", enabled: true, extra_args: [] });
      expect(health.auth_status).not.toBe("ready");
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("pi reports unknown rather than ready when its probe exits non-zero", async () => {
    const dir = mkdtempSync(join(root, "pi-probe-"));
    const script = join(dir, "pi");
    writeFileSync(script, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi 1.0.0"; exit 0; fi\necho ready\nexit 2\n', { mode: 0o755 });
    const health = await new PiAdapter().probe("pi", { driver: "pi", display_name: "p", binary: script, enabled: true, extra_args: [] });
    expect(health.auth_status).not.toBe("ready");
  });
});

describe("versionAtLeast", () => {
  it("sorts a prerelease before the release it precedes", () => {
    expect(versionAtLeast("1.4.2-beta.1", [1, 4, 2])).toBe(false);
    expect(versionAtLeast("1.4.2", [1, 4, 2])).toBe(true);
    expect(versionAtLeast("1.5.0-rc.1", [1, 4, 2])).toBe(true);
    expect(versionAtLeast("not-a-version", [1, 0, 0])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Planner: Pi authenticates per upstream provider
// ---------------------------------------------------------------------------

describe("planner: pi per-model provider auth", () => {
  function piHealth(): HarnessHealth {
    return {
      harness: "pi", driver: "pi", enabled: true, installed: true, auth_status: "unauthenticated",
      security_guarantees: { readonly: "os_sandbox", write: "os_sandbox" }, checked_at: new Date("2026-11-26T00:00:00Z").toISOString(),
    };
  }

  it("does not apply the default provider's auth result to a model routed to another provider", () => {
    const config = structuredClone(new ConfigManager({
      defaultPath: join(import.meta.dirname, "../../defaults/catalog.toml"),
      userPath: join(import.meta.dirname, "__no_user_config__.toml"),
      now: () => new Date("2026-11-26T00:00:00Z"),
    }).load());
    config.harnesses.pi.default_upstream_provider = "deepseek";
    const plan = buildPlanPreview({
      config, healthByHarness: { pi: piHealth() },
      subtasks: [
        { id: "same", title: "Same provider", task_type: "implementation", override: { model: "pi-deepseek-v4-pro" } },
        { id: "other", title: "Other provider", task_type: "implementation", override: { model: "pi-glm-5.3" } },
      ],
    });
    expect(plan.items[0].harness_auth_status).toBe("unauthenticated");
    expect(plan.items[1].harness_auth_status).toBe("unknown");
    expect(plan.items[1].warnings.join(" ")).not.toContain("not authenticated");
  });
});
