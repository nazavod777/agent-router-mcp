import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter, codexWindowsWarnings } from "../../src/adapters/codex.js";
import { DshAdapter, readConfiguredMcpPluginIds } from "../../src/adapters/dsh.js";
import { GeminiAdapter, hasGeminiAuthSetting } from "../../src/adapters/gemini.js";
import { OpenCodeAdapter, readConfiguredMcpServerNames } from "../../src/adapters/opencode.js";
import { PiAdapter, effectivePiModelProvider } from "../../src/adapters/pi.js";
import { classifiedFailure, looksLikeSandboxUnavailable } from "../../src/adapters/probe-utils.js";
import type { BuildInvocationInput, BuiltInvocation, CliAdapter, FinishParseInput } from "../../src/adapters/types.js";
import { ConfigManager, type ConfigSnapshot } from "../../src/config/resolver.js";
import { suggestRuntimeAlternatives } from "../../src/planner/preview.js";
import { OrchestratorRunner, defaultFailureScope, type RunJobRequest } from "../../src/runtime/runner.js";
import type { DriverKind, HarnessHealth, StructuredError } from "../../src/types.js";
import { installStubClis, type StubCliEnvironment } from "./helpers/stub-clis.js";

function finishInput(overrides: Partial<FinishParseInput> = {}): FinishParseInput {
  return { exitCode: 1, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0, ...overrides };
}

/** Rejection of an async call as the structured error the adapter threw (adapters throw plain `StructuredError` objects). */
async function rejection(promise: Promise<unknown>): Promise<StructuredError> {
  try {
    await promise;
  } catch (error) {
    return error as StructuredError;
  }
  throw new Error("expected the call to be rejected");
}

// ---------------------------------------------------------------------------
// 1. SANDBOX_UNAVAILABLE detection and classification
// ---------------------------------------------------------------------------
describe("looksLikeSandboxUnavailable", () => {
  it.each([
    "Windows sandbox could not be started",
    "windows  sandbox: setup failed",
    "codex-windows-sandbox: refresh error",
    "sandbox setup refresh had errors",
    "setup refresh failed for the workspace",
    "deny_read_acl step failed",
    "CreateProcessAsUser failed (os error 1314)",
    "LogonUser failed: OS Error 1385",
    "restricted token creation failed",
    "failed to build restricted token: access denied",
    "sandbox initialization failed",
    "Sandbox Setup Failed: see log",
    "sandbox startup failed (exit 3)",
  ])("recognizes the setup failure %j on any platform", (text) => {
    expect(looksLikeSandboxUnavailable(text, "linux")).toBe(true);
    expect(looksLikeSandboxUnavailable(text, "win32")).toBe(true);
  });

  it.each([
    ["codex windows sandbox: Access is denied (os error 5)", "linux"],
    ["sandbox refresh: Access is denied.", "linux"],
    ["Access is denied (os error 5) while preparing workspace-write sandbox", "win32"],
    ["os error 5 in codex setup", "win32"],
    ["read-only sandbox: os error 5", "win32"],
    ["restricted-token ACL step: Access is denied", "win32"],
  ] as const)("recognizes access denied with sandbox context: %j on %s", (text, platform) => {
    expect(looksLikeSandboxUnavailable(text, platform)).toBe(true);
  });

  it.each([
    "Here is how a sandbox works: it isolates untrusted code from the host.",
    "I reviewed the sandbox settings and they look fine.",
    "The sandbox_mode key is read-only in this profile.",
    "error: unauthorized",
    "HTTP 429 Too Many Requests",
    "src/windows.ts:1314: unexpected token",
    "Failed with exit code 1385",
  ])("does not flag ordinary text %j", (text) => {
    expect(looksLikeSandboxUnavailable(text, "win32")).toBe(false);
    expect(looksLikeSandboxUnavailable(text, "linux")).toBe(false);
  });

  it("does not flag a plain file access error without sandbox context", () => {
    expect(looksLikeSandboxUnavailable("C:\\data\\report.docx: Access is denied.", "win32")).toBe(false);
    expect(looksLikeSandboxUnavailable("cannot open file (os error 5)", "win32")).toBe(false);
    // Off Windows a bare access error needs the word "sandbox" itself.
    expect(looksLikeSandboxUnavailable("setup.log: Access is denied (os error 5)", "linux")).toBe(false);
    expect(looksLikeSandboxUnavailable("setup.log: Access is denied (os error 5)", "win32")).toBe(true);
  });
});

describe("SANDBOX_UNAVAILABLE classification", () => {
  it("classifies as a non-retryable harness failure and attaches actionable hints", () => {
    const result = classifiedFailure("Codex CLI", finishInput({ stderrTail: "codex windows sandbox: Access is denied (os error 5)" }),
      undefined, "NON_ZERO_EXIT", { details: { turn_completed: false }, platform: "win32" });
    expect(result.error).toMatchObject({
      code: "SANDBOX_UNAVAILABLE", retryable: false, failure_scope: "harness",
      details: { turn_completed: false },
    });
    expect(result.error?.message).toContain("could not start its OS sandbox");
    const hints = (result.error?.details as { hints: string[] }).hints;
    expect(hints.length).toBeGreaterThanOrEqual(3);
    expect(hints.join("\n")).toMatch(/OneDrive/);
    expect(hints.join("\n")).toMatch(/UNC/);
    expect(hints.join("\n")).toMatch(/240/);
    expect(hints.join("\n")).toMatch(/TEMP/);
    expect(hints.join("\n")).toMatch(/another enabled harness/);
  });

  it("is never misclassified as a login or generic failure when Windows says access is denied", () => {
    const result = classifiedFailure("Codex CLI", finishInput(), "windows sandbox setup refresh failed: Access is denied (os error 5)", "NON_ZERO_EXIT");
    expect(result.error?.code).toBe("SANDBOX_UNAVAILABLE");
    // The platform decides the weak "access denied" rule: a bare error on Windows with sandbox context still matches.
    const weak = classifiedFailure("Codex CLI", finishInput(), "Access is denied (os error 5) in the workspace-write sandbox", "NON_ZERO_EXIT", { platform: "win32" });
    expect(weak.error?.code).toBe("SANDBOX_UNAVAILABLE");
  });

  it("keeps provider failures ahead of nothing: quota and auth wording keep their own classes", () => {
    expect(classifiedFailure("X", finishInput(), "out of credits", "NON_ZERO_EXIT").error?.code).toBe("QUOTA_EXCEEDED");
    expect(classifiedFailure("X", finishInput(), "not logged in", "NON_ZERO_EXIT").error?.code).toBe("AUTH_REQUIRED");
    expect(classifiedFailure("X", finishInput(), "file access denied", "NON_ZERO_EXIT", { platform: "win32" }).error?.code).toBe("NON_ZERO_EXIT");
    // No hints for any other class.
    expect(classifiedFailure("X", finishInput(), "rate limit exceeded", "NON_ZERO_EXIT").error?.details).toBeUndefined();
  });

  it("is a harness-scoped failure by default", () => {
    expect(defaultFailureScope("SANDBOX_UNAVAILABLE")).toBe("harness");
  });
});

// ---------------------------------------------------------------------------
// 1b. Runner: cooldown, scope and rerouting
// ---------------------------------------------------------------------------
describe("runner handling of SANDBOX_UNAVAILABLE", () => {
  let root: string;
  let runner: OrchestratorRunner | undefined;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orch-b2-runner-")));
  });

  afterEach(async () => {
    try {
      await runner?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function configure(): Promise<RunJobRequest> {
    const configPath = join(root, "override.toml");
    await writeFile(configPath, "[defaults]\nallow_unsandboxed_write = true\n");
    const adapter: CliAdapter = {
      driver: "claude",
      securityGuarantees: { readonly: "tool_allowlist", write: "unsandboxed" },
      mapEffort: (effort) => effort,
      async probe() { throw new Error("No live probe expected"); },
      async buildInvocation(input): Promise<BuiltInvocation> {
        return { command: process.execPath, args: ["-e", input.prompt], stdin: "", nativeEffort: input.effort, tempFiles: [], warnings: [] };
      },
      createStreamParser() {
        return {
          pushLine() {},
          finish(input) {
            if (input.exitCode) return classifiedFailure("Mock", input, undefined, "NON_ZERO_EXIT");
            return { ok: true, summary: "ok" };
          },
        };
      },
    };
    runner = new OrchestratorRunner({
      configManager: new ConfigManager({ userPath: configPath }),
      adapterRegistry: { get: () => adapter, async probeHarness() { throw new Error("No live probe expected"); } },
      runsDir: join(root, "runs"),
      worktreesDir: join(root, "worktrees"),
      locksDir: join(root, "locks"),
      allowedCwdRoots: [root],
      env: {},
      terminateGraceMs: 80,
      cliLimits: { home: join(root, "home"), cacheTtlMs: 0 },
    });
    return { cwd: root, prompt: "", model: "claude-sonnet", mode: "readonly" };
  }

  const FAIL_SCRIPT = `process.stderr.write("codex windows sandbox: Access is denied (os error 5)"); process.exitCode = 1`;

  async function createRepo(): Promise<string> {
    const cwd = join(root, "repo");
    await mkdir(cwd);
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
    git("init", "-q");
    await writeFile(join(cwd, "tracked"), "initial");
    git("add", "tracked");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial");
    return cwd;
  }

  it("records a 600 s harness cooldown and marks the failure safe to reroute", async () => {
    const request = await configure();
    const job = await runner!.run({ ...request, prompt: FAIL_SCRIPT });
    expect(job).toMatchObject({
      status: "failed",
      error: { code: "SANDBOX_UNAVAILABLE", failure_scope: "harness", retryable: false, safe_to_reroute: true },
    });
    const hints = (job.error?.details as { hints?: string[] } | undefined)?.hints;
    expect(hints?.length).toBeGreaterThan(0);
    const [cooldown, ...rest] = runner!.getRuntimeDegradations();
    expect(rest).toEqual([]);
    expect(cooldown).toMatchObject({ harness: "claude", code: "SANDBOX_UNAVAILABLE", scope: "harness" });
    expect(cooldown.model).toBeUndefined();
    expect(Date.parse(cooldown.expires_at) - Date.parse(cooldown.failed_at)).toBe(600_000);
  });

  it("allows rerouting a shared write with an unchanged git tree, but not after a tracked file changed", async () => {
    const request = await configure();
    const cwd = await createRepo();
    const clean = await runner!.run({ ...request, cwd, mode: "write", isolation: "shared", prompt: FAIL_SCRIPT });
    expect(clean).toMatchObject({ status: "failed", error: { code: "SANDBOX_UNAVAILABLE", safe_to_reroute: true } });
    runner!.clearRuntimeDegradations();

    const edited = await runner!.run({
      ...request, cwd, mode: "write", isolation: "shared",
      prompt: `require("node:fs").writeFileSync("tracked", "changed"); ${FAIL_SCRIPT}`,
    });
    expect(edited).toMatchObject({ status: "failed", error: { code: "SANDBOX_UNAVAILABLE", safe_to_reroute: false } });
  });
});

describe("failover candidates after SANDBOX_UNAVAILABLE", () => {
  function health(harness: string, extra: Partial<HarnessHealth> = {}): HarnessHealth {
    return {
      harness, driver: harness as DriverKind, enabled: true, installed: true, auth_status: "ready",
      security_guarantees: { readonly: "os_sandbox", write: "os_sandbox" }, contract: "stable", mcp_isolation: "none",
      checked_at: "2026-11-26T00:00:00Z", ...extra,
    } as HarnessHealth;
  }

  function loadConfig(): ConfigSnapshot {
    return structuredClone(new ConfigManager({
      defaultPath: join(import.meta.dirname, "../../defaults/catalog.toml"),
      userPath: join(import.meta.dirname, "__no_user_config__.toml"),
      now: () => new Date("2026-11-26T00:00:00Z"),
    }).load());
  }

  it("suggests models of other enabled harnesses only and never the sandbox-less harness", () => {
    const config = loadConfig();
    const failedModel = Object.keys(config.models).find((id) => config.models[id].harness === "codex")!;
    const alternatives = suggestRuntimeAlternatives({
      config, healthByHarness: Object.fromEntries(Object.keys(config.harnesses).map((id) => [id, health(id)])),
      failedHarness: "codex", failedModel, mode: "readonly", failureScope: "harness", errorCode: "SANDBOX_UNAVAILABLE",
    });
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.every((alternative) => config.models[alternative.model].harness !== "codex")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared adapter fixture
// ---------------------------------------------------------------------------
let stubClis: StubCliEnvironment;
let workDir: string;

beforeEach(() => {
  stubClis = installStubClis(["codex", "opencode", "dsh", "pi", "gemini"]);
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "orch-b2-work-")));
});

afterEach(() => {
  stubClis.restore();
  rmSync(workDir, { recursive: true, force: true });
});

function adapterInput(driver: DriverKind, overrides: Partial<BuildInvocationInput> = {}): BuildInvocationInput {
  const jobDir = join(workDir, "job");
  mkdirSync(jobDir, { recursive: true });
  return {
    harnessId: driver,
    harness: { driver, display_name: driver, binary: driver, enabled: true },
    modelId: "test",
    model: {
      display_name: "Test", harness: driver, cli_model: "demo", cli_provider: "test-provider",
      tier: "standard", efforts: ["medium", "high"], default_effort: "medium", cost_tier: "low", cost_note: "",
      speed_note: "", context_window: 1000, strengths: [], weaknesses: [], best_for: [], avoid_for: [],
      checked_at: "2026-11-25", enabled: true,
    },
    effort: "high", mode: "readonly", prompt: "question", systemContext: undefined,
    cwd: workDir, jobDir, inheritMcp: false, isGitRepo: false,
    ...overrides,
  } as BuildInvocationInput;
}

function writeConfig(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

// ---------------------------------------------------------------------------
// 1c. Codex: extra_args hardening, Windows warnings, env snapshot
// ---------------------------------------------------------------------------
describe("Codex extra_args cannot move the working root or change the Windows sandbox", () => {
  const harnessWith = (extra: string[]) => ({ driver: "codex" as const, display_name: "codex", binary: "codex", enabled: true, extra_args: extra });

  it.each([
    [["-C", "/elsewhere"]],
    [["-C/elsewhere"]],
    [["--cd", "/elsewhere"]],
    [["--cd=/elsewhere"]],
    [["-c", "windows.sandbox=\"unelevated\""]],
    [["-c", "windows.sandbox=\"elevated\""]],
    [["-c", "windows={sandbox=\"unelevated\"}"]],
    [["-c", "windows = { sandbox = \"unelevated\" }"]],
    [["--config", "profiles.x.windows.sandbox=\"unelevated\""]],
    [["-c", "profiles={x={windows={sandbox=\"unelevated\"}}}"]],
  ])("refuses %j in readonly and in write mode", async (extra) => {
    for (const mode of ["readonly", "write"] as const) {
      const error = await rejection(new CodexAdapter().buildInvocation(
        adapterInput("codex", { harness: harnessWith(extra), mode, allowUnsandboxedWrite: false })));
      expect(error).toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
    }
  });

  it("still accepts unrelated -c overrides, a lowercase -c, and other windows keys", async () => {
    for (const extra of [["-c", "model_verbosity=\"low\""], ["-c", "windows.other=1"], ["-ctui.notifications=true"]]) {
      const invocation = await new CodexAdapter().buildInvocation(adapterInput("codex", { harness: harnessWith(extra) }));
      expect(invocation.args).toEqual(expect.arrayContaining(extra));
    }
  });

  it("passes the job's own -C <cwd> exactly once", async () => {
    const invocation = await new CodexAdapter().buildInvocation(adapterInput("codex"));
    expect(invocation.args.filter((arg) => arg === "-C")).toHaveLength(1);
    expect(invocation.args[invocation.args.indexOf("-C") + 1]).toBe(workDir);
    // The sandbox flags this wave must never weaken stay intact (even when a Windows .cmd shim adds a prefix script arg).
    const approvalIndex = invocation.args.indexOf("-a");
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    expect(invocation.args[approvalIndex + 1]).toBe("never");
    expect(approvalIndex).toBeLessThan(invocation.args.indexOf("exec"));
    expect(invocation.args[invocation.args.indexOf("-s") + 1]).toBe("read-only");
  });
});

describe("codexWindowsWarnings", () => {
  const profile = "C:\\Users\\tester";
  const goodEnv = { USERPROFILE: profile, TEMP: `${profile}\\AppData\\Local\\Temp`, TMP: `${profile}\\AppData\\Local\\Temp` };

  it("is silent on non-Windows platforms whatever the paths are", () => {
    const longCwd = `//server/share/OneDrive/${"x".repeat(300)}`;
    for (const platform of ["linux", "darwin"] as const) {
      expect(codexWindowsWarnings(longCwd, { USERPROFILE: profile, TEMP: "D:\\Temp" }, platform)).toEqual([]);
    }
  });

  it("is silent for a short local path with TEMP under the profile", () => {
    expect(codexWindowsWarnings("C:\\work\\project", goodEnv, "win32")).toEqual([]);
    expect(codexWindowsWarnings("C:\\work\\project", { TEMP: "D:\\Temp" }, "win32")).toEqual([]);
  });

  it.each(["\\\\server\\share\\repo", "//server/share/repo"])("warns about the UNC working directory %j", (cwd) => {
    const warnings = codexWindowsWarnings(cwd, goodEnv, "win32");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/UNC/);
  });

  it.each(["C:\\Users\\tester\\OneDrive\\repo", "C:\\Users\\tester\\OneDrive - Contoso Ltd\\repo", "C:/Users/tester/onedrive/repo"])(
    "warns about the OneDrive working directory %j", (cwd) => {
      const warnings = codexWindowsWarnings(cwd, goodEnv, "win32");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/OneDrive/);
    });

  it("warns about a working directory over 240 characters, but not at exactly 240", () => {
    const at = `C:\\${"a".repeat(240 - 3)}`;
    expect(at).toHaveLength(240);
    expect(codexWindowsWarnings(at, goodEnv, "win32")).toEqual([]);
    const warnings = codexWindowsWarnings(`${at}b`, goodEnv, "win32");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/241 characters/);
  });

  it("warns separately for TEMP and TMP outside USERPROFILE, matching names and prefixes case-insensitively", () => {
    expect(codexWindowsWarnings("C:\\work", { ...goodEnv, TEMP: "D:\\Temp" }, "win32")).toEqual([expect.stringMatching(/^TEMP /)]);
    expect(codexWindowsWarnings("C:\\work", { ...goodEnv, TMP: "D:\\Tmp" }, "win32")).toEqual([expect.stringMatching(/^TMP /)]);
    expect(codexWindowsWarnings("C:\\work", { ...goodEnv, TEMP: "D:\\Temp", TMP: "D:\\Temp" }, "win32")).toHaveLength(2);
    // Lower-case variable names and a differently cased path are the same locations on Windows.
    expect(codexWindowsWarnings("C:\\work", { userprofile: profile, temp: profile.toUpperCase() + "\\appdata\\local\\temp" }, "win32")).toEqual([]);
    expect(codexWindowsWarnings("C:\\work", { userprofile: profile, tmp: "E:\\scratch" }, "win32")).toEqual([expect.stringMatching(/^TMP /)]);
    // A sibling folder that merely starts with the profile's name is outside it.
    expect(codexWindowsWarnings("C:\\work", { USERPROFILE: profile, TEMP: "C:\\Users\\tester2\\Temp" }, "win32")).toHaveLength(1);
    // The profile folder itself, with a trailing separator, counts as inside.
    expect(codexWindowsWarnings("C:\\work", { USERPROFILE: `${profile}\\`, TEMP: profile }, "win32")).toEqual([]);
  });

  it("collects every applicable warning and never echoes the paths", () => {
    const cwd = `\\\\server\\OneDrive\\${"d".repeat(260)}`;
    const warnings = codexWindowsWarnings(cwd, { USERPROFILE: profile, TEMP: "D:\\Secret-Temp-Dir" }, "win32");
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).not.toContain("server");
    expect(warnings.join("\n")).not.toContain("Secret-Temp-Dir");
    expect(warnings.join("\n")).not.toContain(profile);
  });

  it("adds nothing to a clean Codex invocation", async () => {
    const invocation = await new CodexAdapter().buildInvocation(adapterInput("codex"));
    expect(invocation.warnings).toEqual([]);
  });
});

describe("Codex reads its config from the job's environment snapshot", () => {
  it("honors CODEX_HOME of input.env, not of process.env, when switching MCP servers off", async () => {
    const home = join(workDir, "codex-home");
    writeConfig(home, "config.toml", "[mcp_servers.alpha]\ncommand = \"a\"\n\n[mcp_servers.beta]\ncommand = \"b\"\n");
    // process.env.CODEX_HOME points at an empty directory (stub environment): only the snapshot has servers.
    const fromSnapshot = await new CodexAdapter().buildInvocation(adapterInput("codex", { env: { CODEX_HOME: home } }));
    expect(fromSnapshot.args).toContain("mcp_servers={alpha={enabled=false},beta={enabled=false}}");
    const fromProcess = await new CodexAdapter().buildInvocation(adapterInput("codex"));
    expect(fromProcess.args).toContain("mcp_servers={}");
  });

  it("fails closed on a broken config in the snapshot's CODEX_HOME", async () => {
    const home = join(workDir, "codex-home");
    writeConfig(home, "config.toml", "[mcp_servers\nbroken");
    const error = await rejection(new CodexAdapter().buildInvocation(adapterInput("codex", { env: { CODEX_HOME: home } })));
    expect(error).toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
  });
});

// ---------------------------------------------------------------------------
// 2. OpenCode
// ---------------------------------------------------------------------------
describe("OpenCode adapter", () => {
  let configDir: string;
  const adapter = new OpenCodeAdapter();

  beforeEach(() => {
    configDir = join(workDir, "opencode-config");
    mkdirSync(configDir, { recursive: true });
  });

  /** A snapshot whose OpenCode config lives in the test directory; the real user's configuration is never read. */
  const envWith = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ OPENCODE_CONFIG_DIR: configDir, ...extra });
  const inlineConfig = (invocation: BuiltInvocation) => JSON.parse(invocation.envOverrides!.OPENCODE_CONFIG_CONTENT) as Record<string, any>;

  describe("OPENCODE_CONFIG_CONTENT as JSONC", () => {
    it("keeps the fields of a commented config with trailing commas and disables its servers", async () => {
      const content = `{
        // the user's inline config
        "theme": "dark", /* block comment */
        "mcp": {
          "docs": { "type": "remote", "url": "https://docs.example.test/mcp", },
        },
      }`;
      const invocation = await adapter.buildInvocation(adapterInput("opencode", { env: envWith({ OPENCODE_CONFIG_CONTENT: content }) }));
      const config = inlineConfig(invocation);
      expect(config.theme).toBe("dark");
      expect(config.mcp).toEqual({ docs: { type: "remote", url: "https://docs.example.test/mcp", enabled: false } });
      expect(invocation.warnings.join(" ")).not.toContain("OPENCODE_CONFIG_CONTENT");
    });

    it("does not strip comment-like text inside strings", async () => {
      const content = '{ "provider": { "p": { "options": { "baseURL": "https://host.example.test/a//b/*c*/" } } } }';
      const config = inlineConfig(await adapter.buildInvocation(adapterInput("opencode", { env: envWith({ OPENCODE_CONFIG_CONTENT: content }) })));
      expect(config.provider.p.options.baseURL).toBe("https://host.example.test/a//b/*c*/");
    });

    it("reads OPENCODE_CONFIG_CONTENT from the snapshot, not from process.env", async () => {
      const previous = process.env.OPENCODE_CONFIG_CONTENT;
      process.env.OPENCODE_CONFIG_CONTENT = '{ "from": "process" }';
      try {
        const config = inlineConfig(await adapter.buildInvocation(adapterInput("opencode", { env: envWith({ OPENCODE_CONFIG_CONTENT: '{ "from": "snapshot" }' }) })));
        expect(config.from).toBe("snapshot");
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
        else process.env.OPENCODE_CONFIG_CONTENT = previous;
      }
    });

    it.each(["{not json", "[1, 2]", "42"])("replaces the invalid inline config %j with a warning", async (content) => {
      const invocation = await adapter.buildInvocation(adapterInput("opencode", { env: envWith({ OPENCODE_CONFIG_CONTENT: content }) }));
      expect(invocation.warnings.join(" ")).toContain("OPENCODE_CONFIG_CONTENT is not valid JSON");
      expect(inlineConfig(invocation).agents).toHaveProperty("orch-readonly");
    });
  });

  describe("MCP servers of schema V1 and V2", () => {
    it("reads names from both mcp.<name> and mcp.servers.<name>, without a bogus 'servers' name", async () => {
      writeConfig(configDir, "opencode.json", JSON.stringify({
        mcp: { legacy: { type: "local", command: ["x"] }, servers: { modern: { type: "remote", url: "https://m.example.test" } } },
      }));
      writeConfig(workDir, "opencode.jsonc", '{ // project\n "mcp": { "project": { "type": "local", "command": ["y"], }, }, }');
      const names = await readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"));
      expect(names.sort()).toEqual(["legacy", "modern", "project"]);
    });

    it("treats a 'servers' entry that is not an object as a V1 server name", async () => {
      writeConfig(configDir, "opencode.json", JSON.stringify({ mcp: { servers: "oops" } }));
      expect(await readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"))).toEqual(["servers"]);
    });

    it("disables V1 and V2 servers of the files and of the inline config without clobbering sibling keys", async () => {
      writeConfig(configDir, "opencode.json", JSON.stringify({
        mcp: { legacy: { type: "local", command: ["x"] }, servers: { modern: { type: "remote", url: "https://m.example.test" } } },
      }));
      const inline = JSON.stringify({
        keep: { me: true },
        mcp: {
          inlineV1: { type: "remote", url: "https://v1.example.test" },
          servers: { inlineV2: { type: "remote", url: "https://v2.example.test", headers: { a: "b" } } },
        },
      });
      const config = inlineConfig(await adapter.buildInvocation(adapterInput("opencode", { env: envWith({ OPENCODE_CONFIG_CONTENT: inline }) })));
      expect(config.keep).toEqual({ me: true });
      expect(config.mcp.legacy).toEqual({ enabled: false });
      expect(config.mcp.inlineV1).toEqual({ type: "remote", url: "https://v1.example.test", enabled: false });
      expect(config.mcp.enabled).toBeUndefined();
      // V2 gets both spellings of "off"; nothing is copied from the file.
      expect(config.mcp.servers.modern).toEqual({ enabled: false, disabled: true });
      expect(config.mcp.servers.inlineV2).toEqual({ type: "remote", url: "https://v2.example.test", headers: { a: "b" }, enabled: false, disabled: true });
      // `servers` is the V2 table, never a V1 server of its own.
      expect(config.mcp.servers.enabled).toBeUndefined();
      expect(Object.keys(config.mcp.servers).sort()).toEqual(["inlineV2", "modern"]);
    });

    it("does not add a V2 'servers' table to a V1-only setup", async () => {
      writeConfig(configDir, "opencode.json", JSON.stringify({ mcp: { legacy: { type: "local", command: ["x"] } } }));
      const config = inlineConfig(await adapter.buildInvocation(adapterInput("opencode", { env: envWith() })));
      expect(config.mcp).toEqual({ legacy: { enabled: false } });
    });

    it("leaves MCP alone when it is inherited in write mode", async () => {
      writeConfig(configDir, "opencode.json", "{ not even json");
      const invocation = await adapter.buildInvocation(adapterInput("opencode", { env: envWith(), mode: "write", inheritMcp: true, allowUnsandboxedWrite: true }));
      expect(inlineConfig(invocation).mcp).toBeUndefined();
    });

    it("reads OPENCODE_CONFIG and the global directory from the snapshot", async () => {
      const explicit = writeConfig(join(workDir, "explicit"), "custom.json", JSON.stringify({ mcp: { fromExplicit: { type: "local", command: ["z"] } } }));
      const names = await readConfiguredMcpServerNames(workDir, { OPENCODE_CONFIG_DIR: configDir, OPENCODE_CONFIG: explicit }, join(workDir, "no-home"));
      expect(names).toEqual(["fromExplicit"]);
      const xdg = join(workDir, "xdg");
      writeConfig(join(xdg, "opencode"), "opencode.json", JSON.stringify({ mcp: { fromXdg: {} } }));
      expect(await readConfiguredMcpServerNames(workDir, { XDG_CONFIG_HOME: xdg }, join(workDir, "no-home"))).toEqual(["fromXdg"]);
    });
  });

  describe("fails closed when an existing config cannot be trusted", () => {
    it("returns no servers for missing files, a blank file and a config without mcp", async () => {
      expect(await readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"))).toEqual([]);
      writeConfig(configDir, "opencode.json", "  \n");
      writeConfig(configDir, "opencode.jsonc", '{ "theme": "dark" }');
      expect(await readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"))).toEqual([]);
      const invocation = await adapter.buildInvocation(adapterInput("opencode", { env: envWith() }));
      expect(inlineConfig(invocation).mcp).toEqual({});
    });

    it.each([
      ["malformed JSON", "{ \"mcp\": { \"a\": ", "opencode.json"],
      ["a JSON array", "[]", "opencode.json"],
      ["a bare scalar", "true", "opencode.jsonc"],
      ["an oversized file", `{ "pad": "${"x".repeat(1024 * 1024)}" }`, "opencode.json"],
    ])("refuses %s in the global config, in readonly and in inherit_mcp = false write mode", async (_label, content, name) => {
      writeConfig(configDir, name, content);
      await expect(readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"))).rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
      for (const extra of [{ mode: "readonly" as const }, { mode: "write" as const, allowUnsandboxedWrite: true }]) {
        const error = await rejection(adapter.buildInvocation(adapterInput("opencode", { env: envWith(), ...extra })));
        expect(error).toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
        expect(error.message).toContain(name);
      }
    });

    it("refuses a project config that cannot be read safely and does not quote parser output", async () => {
      writeConfig(workDir, "opencode.json", '{ "mcp": { "leak-canary-9f3": ');
      const error = await rejection(adapter.buildInvocation(adapterInput("opencode", { env: envWith() })));
      expect(error).toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
      expect(error.message).not.toContain("leak-canary-9f3");
    });

    it("refuses a config path that is not a regular file", async () => {
      mkdirSync(join(configDir, "opencode.json"));
      await expect(readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"))).rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
    });

    it("treats a config directory that is really a file as holding no config", async () => {
      const notADirectory = writeConfig(workDir, "afile", "x");
      expect(await readConfiguredMcpServerNames(workDir, { OPENCODE_CONFIG_DIR: notADirectory }, join(workDir, "no-home"))).toEqual([]);
    });

    it("accepts exactly 64 distinct servers and refuses 65, counting V1 and V2 together and across files", async () => {
      const names = (count: number, prefix: string) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}${index}`, { type: "local", command: ["x"] }]));
      writeConfig(configDir, "opencode.json", JSON.stringify({ mcp: { ...names(32, "a"), servers: names(32, "b") } }));
      expect(await readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"))).toHaveLength(64);
      const config = inlineConfig(await adapter.buildInvocation(adapterInput("opencode", { env: envWith() })));
      expect(Object.keys(config.mcp.servers)).toHaveLength(32);
      writeConfig(workDir, "opencode.json", JSON.stringify({ mcp: { extra: {} } }));
      await expect(readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"))).rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
      // The same server named in two files is one server.
      writeConfig(workDir, "opencode.json", JSON.stringify({ mcp: { a0: {} } }));
      expect(await readConfiguredMcpServerNames(workDir, envWith(), join(workDir, "no-home"))).toHaveLength(64);
    });
  });

  describe("inline credentials", () => {
    it("reports apiKey, api_key and token strings of at least 8 characters as secrets", async () => {
      const inline = JSON.stringify({
        apiKey: "top-level-key-1111",
        provider: {
          one: { options: { apiKey: "provider-key-2222", baseURL: "https://x.example.test" } },
          two: { options: { api_key: "provider-key-3333" } },
        },
        mcp: { remote: { type: "remote", url: "https://r.example.test", headers: { Authorization: "Bearer abc" }, token: "mcp-token-4444" } },
        list: [{ token: "array-token-5555" }],
        short: { apiKey: "short", token: "1234567" },
        refs: { apiKey: "{env:SOME_API_KEY}", token: "{file:~/.token}" },
        notSecret: { name: "an-ordinary-string" },
      });
      const invocation = await adapter.buildInvocation(adapterInput("opencode", { env: envWith({ OPENCODE_CONFIG_CONTENT: inline }) }));
      expect([...invocation.secrets!].sort()).toEqual([
        "array-token-5555", "mcp-token-4444", "provider-key-2222", "provider-key-3333", "top-level-key-1111",
      ]);
    });

    it("reports no secrets field when the inline config has none", async () => {
      const plain = await adapter.buildInvocation(adapterInput("opencode", { env: envWith() }));
      expect(plain.secrets).toBeUndefined();
      const withoutKeys = await adapter.buildInvocation(adapterInput("opencode", { env: envWith({ OPENCODE_CONFIG_CONTENT: '{ "theme": "dark" }' }) }));
      expect(withoutKeys.secrets).toBeUndefined();
    });

    it("finds credentials in a JSONC inline config as well", async () => {
      const content = '{ /* c */ "provider": { "p": { "options": { "apiKey": "jsonc-key-6666", }, }, }, }';
      const invocation = await adapter.buildInvocation(adapterInput("opencode", { env: envWith({ OPENCODE_CONFIG_CONTENT: content }) }));
      expect(invocation.secrets).toEqual(["jsonc-key-6666"]);
    });
  });

  describe("model variant", () => {
    const modelArg = (invocation: BuiltInvocation) => invocation.args[invocation.args.indexOf("--model") + 1];
    const withModel = (cliModel: string, efforts: string[], effort: string) => {
      const input = adapterInput("opencode", { env: envWith(), effort });
      input.model = { ...input.model, cli_model: cliModel, efforts, default_effort: efforts[0] };
      return input;
    };

    it("appends the effort once for a model with several efforts", async () => {
      expect(modelArg(await adapter.buildInvocation(withModel("demo", ["medium", "high"], "high")))).toBe("test-provider/demo#high");
    });

    it("never stacks a second variant on one the user already pinned in cli_model", async () => {
      expect(modelArg(await adapter.buildInvocation(withModel("demo#low", ["medium", "high"], "high")))).toBe("test-provider/demo#low");
      const bare = withModel("test-provider/demo#low", ["medium", "high"], "high");
      bare.model.cli_provider = undefined;
      expect(modelArg(await adapter.buildInvocation(bare))).toBe("test-provider/demo#low");
    });

    it("adds no variant when the model lists a single effort and that is the one used", async () => {
      expect(modelArg(await adapter.buildInvocation(withModel("demo", ["high"], "high")))).toBe("test-provider/demo");
      expect(modelArg(await adapter.buildInvocation(withModel("demo", ["xhigh"], "extra-high")))).toBe("test-provider/demo");
    });

    it("honors an explicit effort that differs from the default of a single-effort model", async () => {
      const input = withModel("demo", ["high"], "xhigh");
      expect(modelArg(await adapter.buildInvocation(input))).toBe("test-provider/demo#xhigh");
    });

    it.each(["default", "none", "off"])("adds no variant for the effort %j", async (effort) => {
      expect(modelArg(await adapter.buildInvocation(withModel("demo", ["default", "none", "high"], effort)))).toBe("test-provider/demo");
    });
  });

  describe("error events", () => {
    function failureOf(events: unknown[]) {
      const parser = adapter.createStreamParser();
      for (const event of events) parser.pushLine(JSON.stringify(event));
      return parser.finish(finishInput({ exitCode: 1 }));
    }

    it("keeps the message of a structured error.data.message payload", () => {
      const result = failureOf([{ type: "error", sessionID: "s1", error: { name: "APIError", data: { message: "HTTP 429 Too Many Requests: slow down" } } }]);
      expect(result.error).toMatchObject({ code: "RATE_LIMITED" });
      expect(result.error?.message).toContain("slow down");
    });

    it("prefers error.message, then error.data.message, then event.message", () => {
      expect(failureOf([{ type: "error", error: { message: "plain boom", data: { message: "data boom" } } }]).error?.message).toContain("plain boom");
      expect(failureOf([{ type: "error", message: "event boom", error: { name: "X", data: {} } }]).error?.message).toContain("event boom");
    });

    it("reads an error object carried by an unrecognized event type", () => {
      const result = failureOf([{ type: "session.error", error: { data: { message: "insufficient_quota: credit balance is too low" } } }]);
      expect(result.error).toMatchObject({ code: "QUOTA_EXCEEDED" });
    });

    it("still forces an authentication error for provider.auth", () => {
      const result = failureOf([{ type: "error", error: { type: "provider.auth", data: { message: "key rejected" } } }]);
      expect(result.error?.code).toBe("AUTH_REQUIRED");
    });
  });
});

// ---------------------------------------------------------------------------
// 3. DSH
// ---------------------------------------------------------------------------
describe("DSH home patch", () => {
  let dshHome: string;
  const adapter = new DshAdapter();

  beforeEach(() => {
    dshHome = join(workDir, "dsh-home");
    mkdirSync(dshHome, { recursive: true });
  });

  const patchOf = (invocation: BuiltInvocation) => readFileSync(invocation.args[invocation.args.indexOf("--patch") + 1], "utf8");
  const pluginList = (count: number, prefix = "mcp-p") => Array.from({ length: count }, (_, index) => `- id: ${prefix}${index}`).join("\n");

  it("returns no plugins when the patch file is missing", async () => {
    expect(await readConfiguredMcpPluginIds({ DSH_HOME: dshHome })).toEqual([]);
    const patch = patchOf(await adapter.buildInvocation(adapterInput("dsh", { env: { DSH_HOME: dshHome } })));
    expect(patch).toContain("id: mcp-resources");
    expect(patch).toContain("id: mcp-orchestrator");
  });

  it("finds top-level and inserted mcp-* plugins and ignores other ids", async () => {
    writeConfig(dshHome, "cordis.patch.yml", "- id: mcp-github\n- id: tool-subagent\n- id: group\n  insert:\n    - id: mcp-nested.v1\n    - id: not-mcp\n");
    expect((await readConfiguredMcpPluginIds({ DSH_HOME: dshHome })).sort()).toEqual(["mcp-github", "mcp-nested.v1"]);
  });

  it("reads DSH_HOME from input.env, not from process.env", async () => {
    // process.env.DSH_HOME points at an empty directory in the stub environment.
    writeConfig(dshHome, "cordis.patch.yml", "- id: mcp-from-snapshot\n");
    const snapshot = patchOf(await adapter.buildInvocation(adapterInput("dsh", { env: { DSH_HOME: dshHome } })));
    expect(snapshot).toMatch(/id: mcp-from-snapshot\n\s+disabled: true/);
    const processEnv = patchOf(await adapter.buildInvocation(adapterInput("dsh")));
    expect(processEnv).not.toContain("mcp-from-snapshot");
  });

  it.each([
    ["invalid YAML", "- id: [unclosed\n  other: {"],
    ["an alias (aliases are not allowed)", "- &a\n  id: mcp-x\n- *a\n"],
    ["an oversized file", `# ${"x".repeat(1024 * 1024)}\n- id: mcp-a\n`],
    ["more than 64 distinct mcp-* plugins", pluginList(65)],
  ])("fails closed on %s", async (_label, content) => {
    writeConfig(dshHome, "cordis.patch.yml", content);
    const env = { DSH_HOME: dshHome };
    await expect(readConfiguredMcpPluginIds(env)).rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
    const error = await rejection(adapter.buildInvocation(adapterInput("dsh", { env })));
    expect(error).toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
    expect(error.message).toContain("cordis.patch.yml");
  });

  it("fails closed when the patch path is not a regular file", async () => {
    mkdirSync(join(dshHome, "cordis.patch.yml"));
    await expect(readConfiguredMcpPluginIds({ DSH_HOME: dshHome })).rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
  });

  it("does not quote parser output in the refusal", async () => {
    writeConfig(dshHome, "cordis.patch.yml", "- id: [leak-canary-77x\n");
    const error = await rejection(readConfiguredMcpPluginIds({ DSH_HOME: dshHome }));
    expect(error.message).not.toContain("leak-canary-77x");
  });

  it("accepts exactly 64 distinct plugins, counting a repeated id once", async () => {
    writeConfig(dshHome, "cordis.patch.yml", `${pluginList(64)}\n- id: mcp-p0\n`);
    expect(await readConfiguredMcpPluginIds({ DSH_HOME: dshHome })).toHaveLength(64);
  });

  it("does not read the patch when MCP is inherited", async () => {
    writeConfig(dshHome, "cordis.patch.yml", "- id: [broken");
    const invocation = await adapter.buildInvocation(adapterInput("dsh", { env: { DSH_HOME: dshHome }, inheritMcp: true }));
    expect(patchOf(invocation)).not.toContain("mcp-resources");
  });
});

// ---------------------------------------------------------------------------
// 4. Gemini
// ---------------------------------------------------------------------------
describe("Gemini auth settings and GEMINI_CLI_HOME", () => {
  const AUTH_KEYS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA", "GEMINI_CLI_HOME"];
  const settings = (selectedType?: string) => JSON.stringify({ security: { auth: selectedType ? { selectedType } : {} } });

  it("finds the auth type under $GEMINI_CLI_HOME/.gemini/settings.json", async () => {
    const home = join(workDir, "gemini-home");
    writeConfig(join(home, ".gemini"), "settings.json", settings("oauth-personal"));
    expect(await hasGeminiAuthSetting({ GEMINI_CLI_HOME: home })).toBe(true);
  });

  it("is false for an empty selection, unreadable JSON, a missing file and an oversized file", async () => {
    const home = join(workDir, "gemini-home");
    writeConfig(join(home, ".gemini"), "settings.json", settings());
    expect(await hasGeminiAuthSetting({ GEMINI_CLI_HOME: home })).toBe(false);
    writeConfig(join(home, ".gemini"), "settings.json", "{ nope");
    expect(await hasGeminiAuthSetting({ GEMINI_CLI_HOME: home })).toBe(false);
    expect(await hasGeminiAuthSetting({ GEMINI_CLI_HOME: join(workDir, "nowhere") })).toBe(false);
    writeConfig(join(home, ".gemini"), "settings.json", JSON.stringify({ pad: "x".repeat(1024 * 1024) }));
    expect(await hasGeminiAuthSetting({ GEMINI_CLI_HOME: home })).toBe(false);
  });

  it("resolves a relative GEMINI_CLI_HOME against the given working directory", async () => {
    writeConfig(join(workDir, "rel-home", ".gemini"), "settings.json", settings("gemini-api-key"));
    expect(await hasGeminiAuthSetting({ GEMINI_CLI_HOME: "rel-home" }, workDir)).toBe(true);
    expect(await hasGeminiAuthSetting({ GEMINI_CLI_HOME: "rel-home" }, join(workDir, "elsewhere"))).toBe(false);
  });

  it("ignores a blank GEMINI_CLI_HOME instead of reading the working directory", async () => {
    writeConfig(join(workDir, ".gemini"), "settings.json", settings("gemini-api-key"));
    // A blank value falls back to the user's home (never the cwd), so the planted settings.json is not found there.
    const blank = await hasGeminiAuthSetting({ GEMINI_CLI_HOME: "   " }, workDir);
    const unset = await hasGeminiAuthSetting({}, workDir);
    expect(blank).toBe(unset);
  });

  it("makes the probe report ready from the settings under GEMINI_CLI_HOME", async () => {
    const saved = new Map(AUTH_KEYS.map((key) => [key, process.env[key]]));
    for (const key of AUTH_KEYS) delete process.env[key];
    try {
      const home = join(workDir, "gemini-home");
      process.env.GEMINI_CLI_HOME = home;
      const harness = { driver: "gemini" as const, display_name: "gemini", binary: "gemini", enabled: true };
      const before = await new GeminiAdapter().probe("gemini", harness);
      expect(before).toMatchObject({ installed: true, auth_status: "unknown" });
      writeConfig(join(home, ".gemini"), "settings.json", settings("oauth-personal"));
      const after = await new GeminiAdapter().probe("gemini", harness);
      expect(after).toMatchObject({ installed: true, auth_status: "ready" });
      // An API key in the environment still counts, and an "off" switch still does not.
      process.env.GEMINI_CLI_HOME = join(workDir, "nowhere");
      process.env.GOOGLE_GENAI_USE_VERTEXAI = "false";
      expect((await new GeminiAdapter().probe("gemini", harness)).auth_status).toBe("unknown");
      process.env.GEMINI_API_KEY = "test-key-value";
      expect((await new GeminiAdapter().probe("gemini", harness)).auth_status).toBe("ready");
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Pi provider parity
// ---------------------------------------------------------------------------
describe("effectivePiModelProvider", () => {
  it.each([
    [{ cli_model: "claude-x", cli_provider: "anthropic" }, "anthropic"],
    [{ cli_model: "other/model", cli_provider: "acme" }, "acme"],
    [{ cli_model: "anthropic/claude-x" }, "anthropic"],
    [{ cli_model: "openrouter/anthropic/claude-x" }, "openrouter"],
    [{ cli_model: "claude-x" }, undefined],
    [{ cli_model: "/leading-slash" }, undefined],
  ] as const)("%j routes to %j", (model, expected) => {
    expect(effectivePiModelProvider(model)).toBe(expected);
  });

  it("agrees with the model argument Pi is started with", async () => {
    const invocation = await new PiAdapter().buildInvocation(adapterInput("pi", {
      harness: { driver: "pi", display_name: "pi", binary: "pi", enabled: true, default_upstream_provider: "deepseek-official" },
      model: { ...adapterInput("pi").model, cli_provider: undefined, cli_model: "other/model" },
    }));
    expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("other/model");
  });
});

describe("planner health for a Pi model routed by its cli_model prefix", () => {
  function configWithPiModel(cliModel: string, defaultProvider: string): ConfigSnapshot {
    const config = structuredClone(new ConfigManager({
      defaultPath: join(import.meta.dirname, "../../defaults/catalog.toml"),
      userPath: join(import.meta.dirname, "__no_user_config__.toml"),
      now: () => new Date("2026-11-26T00:00:00Z"),
    }).load());
    for (const model of Object.values(config.models)) model.enabled = false;
    config.models["claude-opus-5-5"] = { ...structuredClone(config.models["claude-opus-5-5"]), enabled: true };
    config.models["pi-candidate"] = {
      ...structuredClone(config.models["pi-deepseek-v4-pro"]), cli_model: cliModel, cli_provider: undefined, vendor_family: undefined, enabled: true,
    };
    config.harnesses.pi.default_upstream_provider = defaultProvider;
    return config;
  }

  const health = (harness: string, auth: HarnessHealth["auth_status"]): HarnessHealth => ({
    harness, driver: harness as DriverKind, enabled: true, installed: true, auth_status: auth,
    security_guarantees: { readonly: "os_sandbox", write: "os_sandbox" }, checked_at: "2026-11-26T00:00:00Z",
  } as HarnessHealth);

  const alternativesFor = (config: ConfigSnapshot) => suggestRuntimeAlternatives({
    config, healthByHarness: { claude: health("claude", "ready"), pi: health("pi", "unauthenticated") },
    failedHarness: "claude", failedModel: "claude-opus-5-5", mode: "readonly", failureScope: "harness", errorCode: "QUOTA_EXCEEDED",
  }).map((alternative) => alternative.model);

  it("does not let a model routed to another provider inherit the default provider's missing login", () => {
    expect(alternativesFor(configWithPiModel("other/model", "deepseek-official"))).toEqual(["pi-candidate"]);
  });

  it("still blocks a model that really uses the unauthenticated default provider (negative controls)", () => {
    // No prefix: it inherits the default provider, whose login is missing.
    expect(alternativesFor(configWithPiModel("plain-model", "deepseek-official"))).toEqual([]);
    // A prefix equal to the default provider is the same provider.
    expect(alternativesFor(configWithPiModel("deepseek-official/model", "deepseek-official"))).toEqual([]);
  });
});
