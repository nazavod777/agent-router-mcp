import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectClaudeReadonlyForwardedEnv } from "../../src/adapters/claude-settings-env.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { isForbiddenSandboxConfigOverride } from "../../src/adapters/codex.js";
import { DshAdapter, readConfiguredMcpPluginIds } from "../../src/adapters/dsh.js";
import { OpenCodeAdapter, readConfiguredMcpServers } from "../../src/adapters/opencode.js";
import { windowsCommandLineLength } from "../../src/adapters/parsers.js";
import {
  BoundedText, classifiedFailure, degradedOrParseError, looksLikeSandboxUnavailable, resolveBinary, splitWindowsPath,
} from "../../src/adapters/probe-utils.js";
import type { BuildInvocationInput, FinishParseInput } from "../../src/adapters/types.js";
import { CLIENTS, fixTargetId, inspectClient, installMcpClient, resolveTargets } from "../../src/cli/mcp-install.js";
import { isCurrent } from "../../src/cli/mcp-clients.js";
import { readNpmShimTarget } from "../../src/cli/npm-shim.js";
import { runSkillCommand } from "../../src/cli/skill-cmd.js";
import { buildProbeEnv } from "../../src/discovery/cli-probes.js";
import { clearRegisteredSecretValues, registerSecretValues } from "../../src/logging.js";
import { JobStore, LogBudget } from "../../src/runtime/job-store.js";
import {
  findWindowsDescendants, parseWindowsProcessListing, terminateProcessTree, type TaskkillRunner,
} from "../../src/runtime/process-tree.js";
import { applyEnvOverrides, consumeLog, redactParsedResult } from "../../src/runtime/runner.js";
import { reportedStderr } from "../../src/runtime/worktree.js";
import { openInBrowser } from "../../src/settings-ui/server.js";
import type { DriverKind, StructuredError } from "../../src/types.js";
import { captureIo, makeFixture, read, write, type Fixture } from "./helpers/mcp-fixture.js";
import { installStubClis, type StubCliEnvironment } from "./helpers/stub-clis.js";

const REAL = { dryRun: false, force: false };
const SYNTHETIC_SECRET = "synthetic-secret-value-0123456789";

function finishInput(overrides: Partial<FinishParseInput> = {}): FinishParseInput {
  return { exitCode: 1, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0, ...overrides };
}

async function rejection(promise: Promise<unknown>): Promise<StructuredError> {
  try {
    await promise;
  } catch (error) {
    return error as StructuredError;
  }
  throw new Error("expected the call to be rejected");
}

let workDir: string;
let stubClis: StubCliEnvironment;

beforeEach(() => {
  stubClis = installStubClis(["opencode", "dsh", "claude"]);
  workDir = realpathSync(mkdtempSync(join(tmpdir(), "orch-review-fixes-")));
});

afterEach(() => {
  stubClis.restore();
  vi.restoreAllMocks();
  clearRegisteredSecretValues();
  rmSync(workDir, { recursive: true, force: true });
});

function putFile(path: string, content: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

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

// ---------------------------------------------------------------------------
// 1. OpenCode
// ---------------------------------------------------------------------------
describe("OpenCode project configuration and strict JSONC", () => {
  const noHome = () => join(workDir, "no-home");
  const emptyGlobal = () => ({ OPENCODE_CONFIG_DIR: join(workDir, "empty-global") });

  it("keeps brackets and commas inside strings, and still reads a trailing comma", async () => {
    putFile(join(workDir, "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
    putFile(join(workDir, "repo", "opencode.jsonc"),
      '{ "mcp": { "one": { "type": "remote", "url": "https://h.example.test/a,]", }, "two": { "command": ["x,}"] }, }, }');
    const found = await readConfiguredMcpServers(join(workDir, "repo"), emptyGlobal(), noHome());
    expect([...found.v1].sort()).toEqual(["one", "two"]);
  });

  it("fails closed on an unterminated block comment instead of guessing", async () => {
    putFile(join(workDir, "repo", ".git", "HEAD"), "x");
    putFile(join(workDir, "repo", "opencode.jsonc"), '{ "mcp": { "a": {} } } /* never closed');
    await expect(readConfiguredMcpServers(join(workDir, "repo"), emptyGlobal(), noHome()))
      .rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
  });

  it.each([".opencode/opencode.json", ".opencode/opencode.jsonc"])("reads %s from the working directory and from its parents up to the git root", async (relative) => {
    const repo = join(workDir, "repo");
    putFile(join(repo, ".git", "HEAD"), "x");
    putFile(join(repo, relative), JSON.stringify({ mcp: { fromRepoDir: { type: "remote", url: "https://r.example.test" } } }));
    mkdirSync(join(repo, "packages", "deep"), { recursive: true });
    const found = await readConfiguredMcpServers(join(repo, "packages", "deep"), emptyGlobal(), noHome());
    expect(found.v1).toEqual(["fromRepoDir"]);
  });

  it("does not walk above the git root", async () => {
    putFile(join(workDir, ".opencode", "opencode.json"), JSON.stringify({ mcp: { outside: { type: "remote", url: "https://o.example.test" } } }));
    putFile(join(workDir, "repo", ".git", "HEAD"), "x");
    mkdirSync(join(workDir, "repo", "sub"), { recursive: true });
    const found = await readConfiguredMcpServers(join(workDir, "repo", "sub"), emptyGlobal(), noHome());
    expect([...found.v1, ...found.v2]).toEqual([]);
  });

  it("disables a V2 server with enabled:false AND disabled:true and a V1 server with enabled:false, copying no file secret", async () => {
    const repo = join(workDir, "repo");
    putFile(join(repo, ".git", "HEAD"), "x");
    putFile(join(repo, ".opencode", "opencode.json"), JSON.stringify({
      mcp: {
        legacy: { type: "remote", url: "https://l.example.test", headers: { Authorization: SYNTHETIC_SECRET } },
        servers: { modern: { type: "remote", url: "https://m.example.test", headers: { Authorization: SYNTHETIC_SECRET } } },
      },
    }));
    const invocation = await new OpenCodeAdapter().buildInvocation(adapterInput("opencode", { cwd: repo, env: emptyGlobal() }));
    const text = invocation.envOverrides!.OPENCODE_CONFIG_CONTENT;
    expect(text).not.toContain(SYNTHETIC_SECRET);
    const config = JSON.parse(text) as { mcp: { legacy: unknown; servers: { modern: unknown } } };
    expect(config.mcp.legacy).toEqual({ enabled: false });
    expect(config.mcp.servers.modern).toEqual({ enabled: false, disabled: true });
  });

  it("appends #variant only for an explicit, non-none effort that is not the single default, and never stacks it", async () => {
    const modelArg = async (cliModel: string, efforts: string[], defaultEffort: string, effort: string) => {
      const input = adapterInput("opencode", { env: emptyGlobal(), effort });
      input.model = { ...input.model, cli_model: cliModel, efforts, default_effort: defaultEffort };
      const invocation = await new OpenCodeAdapter().buildInvocation(input);
      return invocation.args[invocation.args.indexOf("--model") + 1];
    };
    expect(await modelArg("demo", ["medium", "high"], "medium", "high")).toBe("test-provider/demo#high");
    expect(await modelArg("demo", ["high"], "high", "high")).toBe("test-provider/demo");
    expect(await modelArg("demo", ["high"], "high", "xhigh")).toBe("test-provider/demo#xhigh");
    expect(await modelArg("demo", ["none", "high"], "high", "none")).toBe("test-provider/demo");
    expect(await modelArg("demo#low", ["medium", "high"], "medium", "high")).toBe("test-provider/demo#low");
  });
});

// ---------------------------------------------------------------------------
// 2. DSH
// ---------------------------------------------------------------------------
describe("DSH MCP plugin discovery", () => {
  let dshHome: string;
  beforeEach(() => {
    dshHome = join(workDir, "dsh-home");
    mkdirSync(join(dshHome, "profiles"), { recursive: true });
  });
  const env = () => ({ DSH_HOME: dshHome });

  it("recognizes an MCP plugin by its specifier even when its id does not start with mcp-", async () => {
    putFile(join(dshHome, "profiles", "headless.yml"), "- id: github\n  name: '@deepseek-ai/dsh-mcp-client'\n- id: other\n  use: some-dsh-mcp-bridge\n- id: plain\n  name: tool-subagent\n");
    expect((await readConfiguredMcpPluginIds(env())).sort()).toEqual(["github", "other"]);
  });

  it.each(["name", "plugin", "use", "package", "module"])("checks the %s field", async (field) => {
    putFile(join(dshHome, "profiles", "headless.yaml"), `- id: viaField\n  ${field}: "@deepseek-ai/dsh-mcp-client"\n`);
    expect(await readConfiguredMcpPluginIds(env())).toEqual(["viaField"]);
  });

  it("fails closed on an MCP entry that has no usable id", async () => {
    putFile(join(dshHome, "profiles", "headless.yml"), "- name: '@deepseek-ai/dsh-mcp-client'\n");
    expect(await rejection(readConfiguredMcpPluginIds(env()))).toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
  });

  it("scans profiles/<profile>.yml, .yaml and cordis.patch.yml together", async () => {
    putFile(join(dshHome, "profiles", "headless.yml"), "- id: mcp-a\n");
    putFile(join(dshHome, "profiles", "headless.yaml"), "- id: mcp-b\n");
    putFile(join(dshHome, "cordis.patch.yml"), "- id: mcp-c\n");
    expect((await readConfiguredMcpPluginIds(env())).sort()).toEqual(["mcp-a", "mcp-b", "mcp-c"]);
  });

  it("reads the profile named by the harness, not only headless", async () => {
    putFile(join(dshHome, "profiles", "custom.yml"), "- id: mcp-custom\n");
    putFile(join(dshHome, "profiles", "headless.yml"), "- id: mcp-headless\n");
    expect(await readConfiguredMcpPluginIds(env(), "custom")).toEqual(["mcp-custom"]);
    const input = adapterInput("dsh", { env: env() });
    input.harness = { ...input.harness, profile: "custom" } as BuildInvocationInput["harness"];
    const invocation = await new DshAdapter().buildInvocation(input);
    const patch = readFileSync(invocation.args[invocation.args.indexOf("--patch") + 1], "utf8");
    expect(patch).toContain("mcp-custom");
    expect(patch).not.toContain("mcp-headless");
  });

  it.each(["../escape", "a/b", "a\\b", "", "bad name", ".."])("fails closed on the unsafe profile name %j", async (profile) => {
    expect(await rejection(readConfiguredMcpPluginIds(env(), profile))).toMatchObject({ code: "SANDBOX_POLICY_VIOLATION", retryable: false });
  });

  it("understands top-level {patches} and {patch} objects as well as arrays", async () => {
    putFile(join(dshHome, "profiles", "headless.yml"), "patches:\n  - id: mcp-one\n  - id: group\n    insert:\n      - id: mcp-two\n");
    putFile(join(dshHome, "cordis.patch.yml"), "patch:\n  - id: mcp-three\n");
    expect((await readConfiguredMcpPluginIds(env())).sort()).toEqual(["mcp-one", "mcp-three", "mcp-two"]);
  });

  it("disables every discovered id in the generated patch", async () => {
    putFile(join(dshHome, "profiles", "headless.yml"), "- id: github\n  name: '@deepseek-ai/dsh-mcp-client'\n- id: mcp-docs\n");
    const invocation = await new DshAdapter().buildInvocation(adapterInput("dsh", { env: env() }));
    const patch = readFileSync(invocation.args[invocation.args.indexOf("--patch") + 1], "utf8");
    expect(patch).toMatch(/id: github\n\s+disabled: true/);
    expect(patch).toMatch(/id: mcp-docs\n\s+disabled: true/);
  });
});

// ---------------------------------------------------------------------------
// 3. T3 Code profiles and MCP/skill boundaries
// ---------------------------------------------------------------------------
describe("T3 Code Antigravity profiles: caps, symlinks, ids and targets", () => {
  const providers = (fx: Fixture) => join(fx.home, ".t3", "userdata", "providers", "antigravity");
  const profile = (fx: Fixture, name: string): string => {
    const dir = join(providers(fx), name);
    write(join(dir, "config", "mcp_config.json"), "{}");
    return dir;
  };
  const instances = async (fx: Fixture) => CLIENTS.antigravity.instances!(fx.ctx);

  it("does not let 40 invalid directories hide a valid profile (raw scan cap 256, valid cap 32)", async () => {
    const fx = makeFixture();
    for (let index = 0; index < 40; index += 1) mkdirSync(join(providers(fx), `!bad${String(index).padStart(2, "0")}`), { recursive: true });
    for (let index = 0; index < 40; index += 1) profile(fx, `valid${String(index).padStart(2, "0")}-profile`);
    const found = await instances(fx);
    expect(found).toHaveLength(32);
    expect(found[0]!.targetId).toBe("antigravity:t3:valid00-prof");
  });

  it("skips a symlinked mcp_config.json at discovery time", async () => {
    const fx = makeFixture();
    const dir = join(providers(fx), "linked-profile-1");
    const outside = join(fx.root, "outside.json");
    write(outside, "{}");
    mkdirSync(join(dir, "config"), { recursive: true });
    symlinkSync(outside, join(dir, "config", "mcp_config.json"));
    expect(await instances(fx)).toEqual([]);
  });

  it("refuses to write when mcp_config.json is swapped for a symlink after discovery", async () => {
    const fx = makeFixture();
    const dir = profile(fx, "swapme-profile-1");
    const [target] = await instances(fx);
    const outside = join(fx.root, "victim.json");
    write(outside, "{}");
    rmSync(join(dir, "config", "mcp_config.json"));
    symlinkSync(outside, join(dir, "config", "mcp_config.json"));
    const result = await installMcpClient(target!, fx.ctx, REAL);
    expect(result.action).toBe("error");
    expect(read(outside)).toBe("{}");
  });

  async function skillInstall(fx: Fixture, targetId: string): Promise<number> {
    const io = captureIo();
    return runSkillCommand(["install", "--target", targetId], io.io, fx.ctx);
  }

  it("refuses a skills symlink that leaves the trusted locations, whether it points outside or dangles", async () => {
    const fx = makeFixture();
    const dir = profile(fx, "skills-out-profile");
    const outside = join(fx.root, "elsewhere");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "config", "skills"));
    expect(await skillInstall(fx, "antigravity:t3:skills-out-p")).not.toBe(0);
    expect(existsSync(join(outside, "orchestrate"))).toBe(false);

    const fx2 = makeFixture();
    const dir2 = profile(fx2, "skills-dangling");
    symlinkSync(join(fx2.root, "does-not-exist"), join(dir2, "config", "skills"));
    expect(await skillInstall(fx2, "antigravity:t3:skills-dangl")).not.toBe(0);
    expect(existsSync(join(fx2.root, "does-not-exist"))).toBe(false);
  });

  it("allows a skills symlink to the primary Antigravity shared skills directory", async () => {
    const fx = makeFixture();
    const dir = profile(fx, "skills-shared-profile");
    const shared = CLIENTS.antigravity.layout(fx.ctx).skillDir;
    const sharedRoot = join(shared, "..");
    mkdirSync(sharedRoot, { recursive: true });
    symlinkSync(sharedRoot, join(dir, "config", "skills"));
    expect(await skillInstall(fx, "antigravity:t3:skills-share")).toBe(0);
    expect(existsSync(join(sharedRoot, "orchestrate", "SKILL.md"))).toBe(true);
  });

  it("refuses a skills/orchestrate link that escapes the profile", async () => {
    const fx = makeFixture();
    const dir = profile(fx, "orch-escape-profile");
    const outside = join(fx.root, "escape-target");
    mkdirSync(outside);
    mkdirSync(join(dir, "config", "skills"), { recursive: true });
    symlinkSync(outside, join(dir, "config", "skills", "orchestrate"));
    expect(await skillInstall(fx, "antigravity:t3:orch-escape-")).not.toBe(0);
    expect(existsSync(join(outside, "SKILL.md"))).toBe(false);
  });

  it("derives a stable 12-character id and extends it only for a real collision", async () => {
    const fx = makeFixture();
    profile(fx, "abcdefghijkl-one");
    expect((await instances(fx)).map((t) => t.targetId)).toEqual(["antigravity:t3:abcdefghijkl"]);
    profile(fx, "abcdefghijkl-two");
    expect((await instances(fx)).map((t) => t.targetId)).toEqual(["antigravity:t3:abcdefghijkl-o", "antigravity:t3:abcdefghijkl-t"]);
  });

  it("`antigravity:primary` targets only the primary location and the fix command uses it when instances exist", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".gemini", "config", "mcp_config.json"), "{}");
    profile(fx, "instance-profile-1");
    const { targets } = await resolveTargets(fx.ctx, ["antigravity:primary"]);
    expect(targets.map((t) => t.targetId)).toEqual(["antigravity"]);
    expect((await resolveTargets(fx.ctx, ["antigravity"])).targets.length).toBeGreaterThan(1);
    const primary = targets[0]!;
    expect(await fixTargetId(primary, fx.ctx)).toBe("antigravity:primary");
    const status = await inspectClient(primary, fx.ctx);
    expect(JSON.stringify(status)).toContain("--target antigravity:primary");
  });

  it("win32 isCurrent requires a fully qualified launcher path (drive or UNC), never a root-relative one", () => {
    const assume = { assumeEntryExists: true };
    const drive = makeFixture({ platform: "win32", nodePath: "C:\\node\\node.exe", entryPath: "C:\\repo\\dist\\cli\\main.js" });
    expect(isCurrent(["C:\\node\\node.exe", "C:\\repo\\dist\\cli\\main.js", "mcp"], drive.ctx, assume)).toBe(true);
    const unc = makeFixture({ platform: "win32", nodePath: "\\\\server\\share\\node.exe", entryPath: "\\\\server\\share\\repo\\dist\\cli\\main.js" });
    expect(isCurrent(["\\\\server\\share\\node.exe", "\\\\server\\share\\repo\\dist\\cli\\main.js", "mcp"], unc.ctx, assume)).toBe(true);
    // The command matches the context exactly, so only the "fully qualified" rule can reject it.
    const rootRelative = makeFixture({ platform: "win32", nodePath: "\\node\\node.exe", entryPath: "\\repo\\dist\\cli\\main.js" });
    expect(isCurrent(["\\node\\node.exe", "\\repo\\dist\\cli\\main.js", "mcp"], rootRelative.ctx, assume)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Claude settings: selectors, worktrees, source checkout
// ---------------------------------------------------------------------------
describe("Claude readonly settings forwarding", () => {
  const PRIMARY_SELECTOR_NAMES = [
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL",
    "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_RESOURCE",
  ];

  function settingsDir(parent: string, name = "cfg"): string {
    const dir = join(parent, name);
    putFile(join(dir, "settings.json"), JSON.stringify({ env: { AWS_REGION: "eu-west-1" } }));
    return dir;
  }

  it("forwards the allowed variable when no login is selected (negative control)", async () => {
    const cwd = join(workDir, "project");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const cfg = settingsDir(join(workDir, "outside"));
    const result = await inspectClaudeReadonlyForwardedEnv({ CLAUDE_CONFIG_DIR: cfg }, cwd, { homeDir: join(workDir, "home") });
    expect(result.names).toEqual(["AWS_REGION"]);
  });

  it.each(PRIMARY_SELECTOR_NAMES)("forwards nothing when %s already selects the login", async (name) => {
    const cwd = join(workDir, "project");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const cfg = settingsDir(join(workDir, "outside"));
    const result = await inspectClaudeReadonlyForwardedEnv({ CLAUDE_CONFIG_DIR: cfg, [name]: "x" }, cwd, { homeDir: join(workDir, "home") });
    expect(result.names).toEqual([]);
    expect(result.env).toEqual({});
  });

  it("treats the main checkout of a linked git worktree as part of the job repository", async () => {
    const main = join(workDir, "main");
    const worktree = join(workDir, "worktrees", "job-1");
    mkdirSync(join(main, ".git", "worktrees", "job-1"), { recursive: true });
    putFile(join(main, ".git", "worktrees", "job-1", "commondir"), "../..\n");
    mkdirSync(worktree, { recursive: true });
    putFile(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "job-1")}\n`);
    const cfg = settingsDir(main);
    const result = await inspectClaudeReadonlyForwardedEnv({ CLAUDE_CONFIG_DIR: cfg }, worktree, { homeDir: join(workDir, "home") });
    expect(result.names).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/repository|working directory/i);
  });

  it("keeps the source checkout out as well when the job runs in a plain directory elsewhere (extraRepoRoots)", async () => {
    const source = join(workDir, "source");
    mkdirSync(join(source, ".git"), { recursive: true });
    const elsewhere = join(workDir, "elsewhere");
    mkdirSync(elsewhere);
    const cfg = settingsDir(source);
    const options = { homeDir: join(workDir, "home") };
    expect((await inspectClaudeReadonlyForwardedEnv({ CLAUDE_CONFIG_DIR: cfg }, elsewhere, options)).names).toEqual(["AWS_REGION"]);
    const guarded = await inspectClaudeReadonlyForwardedEnv({ CLAUDE_CONFIG_DIR: cfg }, elsewhere, { ...options, extraRepoRoots: [source] });
    expect(guarded.names).toEqual([]);
  });

  it("ClaudeAdapter passes the job's source cwd, so a config directory inside the source checkout is not forwarded", async () => {
    const source = join(workDir, "source");
    mkdirSync(join(source, ".git"), { recursive: true });
    const cfg = settingsDir(source);
    const worktree = join(workDir, "plain-worktree");
    mkdirSync(worktree);
    const env = { CLAUDE_CONFIG_DIR: cfg };
    const withSource = await new ClaudeAdapter().buildInvocation(adapterInput("claude", { cwd: worktree, env, sourceCwd: source }));
    expect(withSource.envOverrides?.AWS_REGION).toBeUndefined();
    const withoutSource = await new ClaudeAdapter().buildInvocation(adapterInput("claude", { cwd: worktree, env }));
    expect(withoutSource.envOverrides?.AWS_REGION).toBe("eu-west-1");
  });
});

// ---------------------------------------------------------------------------
// 5. Secret redaction
// ---------------------------------------------------------------------------
describe("secret redaction before cutting", () => {
  const SECRET = "SECRET-VALUE-0123456789";

  async function logged(chunks: string[], secrets: string[]): Promise<string> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "orch-review-log-")));
    try {
      const store = new JobStore(join(root, "runs"));
      await store.initialize("job");
      const writer = await store.openLog("job", "stdout", new LogBudget(1_000_000));
      const stream = new PassThrough();
      const done = consumeLog(stream, writer, 1_000_000, secrets, () => undefined);
      for (const chunk of chunks) {
        stream.write(chunk);
        await new Promise((resolve) => setImmediate(resolve));
      }
      stream.end();
      await done;
      await writer.close();
      return await readFile(join(store.getJobDir("job"), "stdout.log"), "utf8");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("consumeLog redacts a self-overlapping secret whole, in one chunk and split across chunks", async () => {
    const overlapping = "abc123456abc";
    expect(await logged([`x ${overlapping} y\n`], [overlapping])).toBe("x [REDACTED] y\n");
    expect(await logged(["x abc123456", "abc y\n"], [overlapping])).toBe("x [REDACTED] y\n");
    expect(await logged(["x abc12345", "6abc y\n"], [overlapping])).toBe("x [REDACTED] y\n");
  });

  it("BoundedText redacts a registered secret that straddles the byte cap before truncating", () => {
    registerSecretValues([SECRET]);
    const text = new BoundedText(32);
    text.append("0123456789 SECRET-VA");
    text.append("LUE-0123456789 tail and more");
    expect(text.text()).not.toContain("SECRET");
    expect(text.text()).not.toContain("0123456789 tail");
    expect(Buffer.byteLength(text.text())).toBeLessThanOrEqual(32);
    expect(text.overflowed).toBe(true);
  });

  it("BoundedText keeps the redacted text whole when the secret fits once it is masked", () => {
    registerSecretValues([SECRET]);
    const text = new BoundedText(38);
    text.append("ab SECRET-VAL");
    text.append("UE-0123456789 and more more");
    expect(text.text()).toBe("ab [REDACTED] and more more");
    expect(text.overflowed).toBe(false);
  });

  it("worktree stderr is redacted before it is cut to size", () => {
    const window = `${SECRET}${"b".repeat(4090)}`;
    const reported = reportedStderr(window, false, [SECRET]);
    // Cutting first would leave the tail of the secret ("456789") in front of the padding.
    expect(reported).not.toMatch(/\d{3}/);
    expect(reported).not.toContain("SECRET");
    expect(reported.length).toBeLessThanOrEqual(4096);
  });

  it("worktree stderr drops the possibly partial first word of a cut window", () => {
    expect(reportedStderr("ECRET-VALUE-0123456789 rest", true, [SECRET])).toBe(" rest");
    expect(reportedStderr("ECRET-VALUE-0123456789 rest", false, [])).toBe("ECRET-VALUE-0123456789 rest");
  });

  it("re-redacts every free-text field of a parsed result with the job's extra secrets", () => {
    const extra = "job-only-credential-value-42";
    const parsed = redactParsedResult({
      ok: false, summary: `answer ${extra}`, warnings: [`warn ${extra}`],
      error: {
        code: "NON_ZERO_EXIT", message: `m ${extra}`, retryable: false, raw_error: `raw ${extra}`, stderr_tail: `tail ${extra}`,
      },
    } as never, [extra]);
    expect(JSON.stringify(parsed)).not.toContain(extra);
    expect(parsed.error?.code).toBe("NON_ZERO_EXIT");
    expect(redactParsedResult({ ok: true, summary: "same" }, [])).toEqual({ ok: true, summary: "same" });
  });
});

// ---------------------------------------------------------------------------
// 6. Windows process tree
// ---------------------------------------------------------------------------
describe("Windows process tree checks", () => {
  const fileTime = (ms: number): string => String((BigInt(ms) + 11_644_473_600_000n) * 10_000n);
  const row = (pid: number, parent: number, createdMs: number): string => `${pid},${parent},${fileTime(createdMs)}`;
  const ROOT = 424_242;

  it.each(["", "   \n", "garbage", "Get-CimInstance : Access denied\nAt line:1", "1,2,notanumber"])("treats the unreadable snapshot %j as unknown, never as zero survivors", async (output) => {
    expect(await findWindowsDescendants(ROOT, Date.now(), async () => output)).toBeUndefined();
    expect(await findWindowsDescendants(ROOT, Date.now(), async () => undefined)).toBeUndefined();
  });

  it("still reports a clean table as no descendants (negative control)", async () => {
    expect(await findWindowsDescendants(ROOT, Date.now(), async () => row(4, 0, Date.now()))).toEqual([]);
  });

  it("a root that already exited with an unreadable table is not confirmed ended and is never taskkilled", async () => {
    const taskkill = vi.fn<TaskkillRunner>(async () => undefined);
    const result = await terminateProcessTree({
      pid: ROOT, jobId: "j", graceMs: 0, platform: "win32", taskkill, spawnedAt: Date.now(), rootExited: true,
      listWindowsProcesses: async () => "garbage",
    });
    expect(result).toMatchObject({ terminated: false, processTableUnavailable: true });
    expect(taskkill).not.toHaveBeenCalled();
  });

  it("a root that already exited is never targeted, even when a descendant survives", async () => {
    const taskkill = vi.fn<TaskkillRunner>(async () => undefined);
    const spawnedAt = Date.now();
    await terminateProcessTree({
      pid: ROOT, jobId: "j", graceMs: 0, platform: "win32", taskkill, spawnedAt, rootExited: true,
      listWindowsProcesses: async () => `${row(4, 0, spawnedAt)}\n${row(7_001, ROOT, spawnedAt + 5)}`,
    }).catch(() => undefined);
    for (const [args] of taskkill.mock.calls) expect(args).not.toContain(String(ROOT));
  });

  it("only processes created within 50 ms before the spawn are believed to belong to the job", () => {
    const spawnedAt = 1_800_000_000_000;
    const table = (createdMs: number) => `${row(4, 0, spawnedAt)}\n${row(7_001, ROOT, createdMs)}`;
    expect(parseWindowsProcessListing(table(spawnedAt - 40), ROOT, spawnedAt)).toEqual([7_001]);
    expect(parseWindowsProcessListing(table(spawnedAt - 100), ROOT, spawnedAt)).toEqual([]);
    expect(parseWindowsProcessListing(table(spawnedAt - 1_000), ROOT, spawnedAt)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Classifier
// ---------------------------------------------------------------------------
describe("failure classification", () => {
  it.each([
    "Windows Sandbox is a feature of Windows 11 Pro.",
    "I used the Windows sandbox to run the installer.",
    "The sandbox mode is workspace-write.",
  ])("does not read the sandbox's name alone as a failure: %j", (text) => {
    expect(looksLikeSandboxUnavailable(text, "win32")).toBe(false);
  });

  it.each(["Windows sandbox failed to start", "failed to start the Windows sandbox", "codex-windows-sandbox: setup error"])(
    "still recognizes the real setup failure %j", (text) => {
      expect(looksLikeSandboxUnavailable(text, "win32")).toBe(true);
    });

  it("classifies `403 Unauthorized: model foo not found` as a model error, not a login problem", () => {
    const result = classifiedFailure("CLI", finishInput(), "HTTP 403 Unauthorized: model foo not found", "NON_ZERO_EXIT");
    expect(result.error?.code).toBe("MODEL_UNSUPPORTED");
  });

  it("still classifies a bare 401 Unauthorized as a login problem (negative control)", () => {
    const result = classifiedFailure("CLI", finishInput(), "HTTP 401 Unauthorized", "NON_ZERO_EXIT");
    expect(result.error?.code).toBe("AUTH_REQUIRED");
  });

  it("degradedOrParseError never reclassifies typed-stream prose when allowStdoutErrorClassification is false", () => {
    const prose = "Error: rate limit exceeded";
    const exited = finishInput({ exitCode: 0 });
    expect(degradedOrParseError("CLI", exited, prose, "no json").error?.code).toBe("RATE_LIMITED");
    const streamed = degradedOrParseError("CLI", exited, prose, "no json", { allowStdoutErrorClassification: false });
    expect(streamed).toMatchObject({ ok: true, parseDegraded: true, summary: prose });
  });

  it.each([
    ["Error: rate limit exceeded", "RATE_LIMITED"],
    ["Not logged in. Please run /login", "AUTH_REQUIRED"],
  ])("recognizes an exit-0 diagnostic with an explicit prefix or login prompt: %j", (text, code) => {
    expect(degradedOrParseError("CLI", finishInput({ exitCode: 0 }), text, "no json").error?.code).toBe(code);
  });

  it.each([
    "Rate limit exceeded",
    "Unauthorized",
    "HTTP 429 handling was added to the client.",
    "Here is how to deal with quota exceeded errors:\n\n1. wait\n2. retry",
  ])("keeps an unprefixed answer that merely mentions a failure word as a degraded answer: %j", (text) => {
    expect(degradedOrParseError("CLI", finishInput({ exitCode: 0 }), text, "no json")).toMatchObject({ ok: true, parseDegraded: true });
  });
});

// ---------------------------------------------------------------------------
// 8. Codex -c overrides
// ---------------------------------------------------------------------------
describe("isForbiddenSandboxConfigOverride", () => {
  it.each([
    'sandbox_mode="danger-full-access"',
    "sandbox_mode=danger-full-access",
    '"sandbox_mode" = "danger-full-access"',
    "approval_policy='never'",
    "profiles.fast.sandbox_mode=\"danger-full-access\"",
    "profiles = { fast = { sandbox_mode = \"danger-full-access\" } }",
    "profile = { sandbox_mode = \"danger-full-access\" }",
    "windows.sandbox=\"unelevated\"",
    "windows = { sandbox = \"unelevated\" }",
    "sandbox_workspace_write.network_access=true",
    "default_permissions=\"full\"",
  ])("forbids %j", (override) => {
    expect(isForbiddenSandboxConfigOverride(override)).toBe(true);
  });

  it.each([
    'model="gpt-5"',
    'model_reasoning_effort="high"',
    "features.web_search=true",
    'profiles.fast.model="gpt-5-mini"',
    'notify=["sandbox_mode"]',
  ])("allows the unrelated override %j", (override) => {
    expect(isForbiddenSandboxConfigOverride(override)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. P2 hardening
// ---------------------------------------------------------------------------
describe("P2 hardening", () => {
  it("applyEnvOverrides never lets an adapter inject a reserved variable the base environment lacks", () => {
    const env = applyEnvOverrides({ PATH: "/bin", ORCH_DEPTH: "1" }, { ORCH_MAX_DEPTH: "99", ORCH_DEPTH: "0", EXTRA: "1" }, "linux");
    expect(env).toMatchObject({ PATH: "/bin", ORCH_DEPTH: "1", EXTRA: "1" });
    expect("ORCH_MAX_DEPTH" in env).toBe(false);
    const windows = applyEnvOverrides({ Path: "C:\\a" }, { orch_job_id: "forged", ORCH_JOB_CHAIN: "x" }, "win32");
    expect(Object.keys(windows).map((name) => name.toUpperCase()).filter((name) => name.startsWith("ORCH_"))).toEqual([]);
  });

  describe("Settings UI argv editor keeps typed whitespace as a pending argument", () => {
    const html = readFileSync(fileURLToPath(new URL("../../src/settings-ui/app.html", import.meta.url)), "utf8");
    it("wires trackPending / setPending / hasPendingText with preserveWhitespace for the argv editor only", () => {
      expect(html).toMatch(/function trackPending\(fk, input, commit, options = \{\}\)/);
      expect(html).toMatch(/function setPending\(drawer, fk, text, commit, \{ ?preserveWhitespace/);
      expect(html).toContain("function hasPendingText");
      expect(html).toMatch(/trackPending\(fk, adder, addPending, \{ preserveWhitespace: true \}\)/);
      expect(html.match(/preserveWhitespace: true/g)).toHaveLength(1);
    });
  });

  describe("openInBrowser fallback", () => {
    const env = { SystemRoot: "C:\\Windows" };
    function launcher(behaviour: (command: string, child: EventEmitter) => void) {
      const commands: string[] = [];
      const spawnProcess = ((command: string) => {
        commands.push(command);
        const child = new EventEmitter() as EventEmitter & { unref: () => void };
        child.unref = () => undefined;
        setImmediate(() => behaviour(command, child));
        return child as unknown as ChildProcess;
      }) as unknown as typeof import("node:child_process").spawn;
      return { commands, spawnProcess };
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
    const open = (spawnProcess: typeof import("node:child_process").spawn) =>
      openInBrowser("http://127.0.0.1:1/", { platform: "win32", env, spawnProcess, fileExists: () => true });

    it("moves on after a non-zero exit, exactly once even when `error` fires as well", async () => {
      const { commands, spawnProcess } = launcher((command, child) => {
        if (!command.endsWith("rundll32.exe")) return;
        child.emit("error", new Error("boom"));
        child.emit("exit", 1);
      });
      open(spawnProcess);
      await settle();
      expect(commands.map((command) => command.split("\\").pop())).toEqual(["rundll32.exe", "cmd.exe"]);
    });

    it("moves on after a non-zero exit alone, with no `error` event", async () => {
      const { commands, spawnProcess } = launcher((command, child) => { if (command.endsWith("rundll32.exe")) child.emit("exit", 1); });
      open(spawnProcess);
      await settle();
      expect(commands.map((command) => command.split("\\").pop())).toEqual(["rundll32.exe", "cmd.exe"]);
    });

    it("does not fall back after a clean exit", async () => {
      const { commands, spawnProcess } = launcher((_command, child) => { child.emit("exit", 0); });
      open(spawnProcess);
      await settle();
      expect(commands).toHaveLength(1);
    });
  });

  it("probe environments pass GEMINI_HOME to antigravity only, and prefer the exact PATH spelling on win32", () => {
    expect(buildProbeEnv({ GEMINI_HOME: "/g" }, "antigravity", "linux").GEMINI_HOME).toBe("/g");
    expect(buildProbeEnv({ GEMINI_HOME: "/g" }, "claude", "linux").GEMINI_HOME).toBeUndefined();
    const windows = buildProbeEnv({ Path: "C:\\first", PATH: "C:\\exact" }, "claude", "win32");
    expect(windows.PATH).toBe("C:\\exact");
    expect(windows.Path).toBeUndefined();
  });

  it("windows command line length quotes tab-bearing arguments but not vertical tab or newline", () => {
    expect(windowsCommandLineLength("c", ["a\tb"])).toBe(1 + 1 + 5);
    expect(windowsCommandLineLength("c", ["a\u000bb"])).toBe(1 + 1 + 3);
    expect(windowsCommandLineLength("c", ["a\nb"])).toBe(1 + 1 + 3);
    expect(windowsCommandLineLength("c", ["a b"])).toBe(1 + 1 + 5);
  });

  it("splits a Windows PATH on semicolons outside double quotes", () => {
    expect(splitWindowsPath('C:\\a;"C:\\b;c\\bin";D:\\d')).toEqual(["C:\\a", '"C:\\b;c\\bin"', "D:\\d"]);
    expect(resolveBinary("definitely-not-installed-tool", { platform: "win32", pathEnv: '"C:\\x;y";C:\\z', pathExt: ".exe" })).toBeUndefined();
  });

  describe("npm shim .ps1 parsing", () => {
    const shim = (body: string): string => putFile(join(workDir, "bin", "tool.ps1"), body);

    it("takes the script from the invocation line, not from another JavaScript-looking string", () => {
      const file = shim([
        "#!/usr/bin/env pwsh",
        '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent',
        'Write-Host "$basedir/../logs/old.js"',
        '& "node$exe"  "$basedir/../repo/dist/cli/main.js" $args',
      ].join("\n"));
      expect(readNpmShimTarget(file)).toBe(join(workDir, "repo", "dist", "cli", "main.js"));
    });

    it("finds no target in a .ps1 that never invokes a program", () => {
      expect(readNpmShimTarget(shim('Write-Host "$basedir/../logs/old.js"\n'))).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Final polish: OpenCode depth, DSH nesting, T3 guards, secrets, classifier, shim comments, Claude boundary
// ---------------------------------------------------------------------------
describe("final polish regressions", () => {
  const noHome = () => join(workDir, "no-home");
  const emptyGlobal = () => ({ OPENCODE_CONFIG_DIR: join(workDir, "empty-global") });
  const dshEnv = () => ({ DSH_HOME: join(workDir, "dsh-final") });

  it("resolves a relative OPENCODE_CONFIG against the job's working directory", async () => {
    const repo = join(workDir, "repo");
    putFile(join(repo, ".git", "HEAD"), "x");
    putFile(join(repo, "custom.json"), JSON.stringify({ mcp: { viaRelative: { type: "remote", url: "https://r.example.test" } } }));
    const found = await readConfiguredMcpServers(repo, { ...emptyGlobal(), OPENCODE_CONFIG: "custom.json" }, noHome());
    expect(found.v1).toEqual(["viaRelative"]);
  });

  it("fails closed when the project walk exceeds the maximum depth without reaching a git root", async () => {
    const deep = join(workDir, ...Array.from({ length: 70 }, (_, index) => `d${index}`));
    mkdirSync(deep, { recursive: true });
    await expect(readConfiguredMcpServers(deep, emptyGlobal(), noHome())).rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
  });

  it("scans profiles/<profile>/cordis.patch.yml and plugins nested under a group's config", async () => {
    putFile(join(workDir, "dsh-final", "profiles", "headless", "cordis.patch.yml"), "- id: mcp-profile-dir\n");
    putFile(join(workDir, "dsh-final", "profiles", "headless.yml"), "- id: group\n  config:\n    - id: mcp-nested\n- plugins:\n    - id: mcp-in-array\n");
    expect((await readConfiguredMcpPluginIds(dshEnv())).sort()).toEqual(["mcp-in-array", "mcp-nested", "mcp-profile-dir"]);
  });

  it("does not let valid-looking directories without a config hide real T3 profiles behind the profile cap", async () => {
    const fx = makeFixture();
    const root = join(fx.home, ".t3", "userdata", "providers", "antigravity");
    for (let index = 0; index < 40; index += 1) mkdirSync(join(root, `a${String(index).padStart(2, "0")}-empty-dir`, "config"), { recursive: true });
    write(join(root, "zreal-profile-1", "config", "mcp_config.json"), "{}");
    const found = await CLIENTS.antigravity.instances!(fx.ctx);
    expect(found.map((target) => target.targetId)).toEqual(["antigravity:t3:zreal-profil"]);
  });

  it("applies the symlink guard to a primary Antigravity promoted into a T3 profile through GEMINI_HOME", async () => {
    const fx = makeFixture();
    const profileConfig = join(fx.home, ".t3", "userdata", "providers", "antigravity", "promoted-profile", "config");
    const outside = join(fx.root, "victim.json");
    write(outside, "{}");
    mkdirSync(profileConfig, { recursive: true });
    symlinkSync(outside, join(profileConfig, "mcp_config.json"));
    // GEMINI_HOME/config is the profile's config directory.
    const ctx = { ...fx.ctx, env: { GEMINI_HOME: dirname(profileConfig) } };
    const result = await installMcpClient(CLIENTS.antigravity, ctx, REAL);
    expect(result.action).toBe("error");
    expect(read(outside)).toBe("{}");
  });

  it("compares launcher paths case-insensitively on Windows only", () => {
    const winCtx = { ...makeFixture().ctx, platform: "win32" as const, nodePath: "C:\\Node\\node.exe", entryPath: "C:\\Repo\\dist\\cli\\main.js" };
    const lower = ["c:\\node\\node.exe", "c:\\repo\\dist\\cli\\main.js", "mcp"];
    expect(isCurrent(lower, winCtx, { assumeEntryExists: true })).toBe(true);
    expect(isCurrent(lower, { ...winCtx, platform: "linux" }, { assumeEntryExists: true })).toBe(false);
  });

  it("redacts a job secret before the 2000-character cut of raw_error and message", () => {
    const evidence = `${"x".repeat(1_990)} ${SYNTHETIC_SECRET}`;
    const result = classifiedFailure("CLI", finishInput({ extraSecrets: [SYNTHETIC_SECRET] }), evidence, "NON_ZERO_EXIT");
    expect(result.error?.raw_error).not.toContain("synthetic-secret");
    expect(result.error?.message).not.toContain("synthetic-secret");
  });

  it("classifies a bare `403 Unauthorized: model foo not found` as a model error", () => {
    const result = classifiedFailure("CLI", finishInput(), "403 Unauthorized: model foo not found", "NON_ZERO_EXIT");
    expect(result.error?.code).toBe("MODEL_UNSUPPORTED");
  });

  it("does not turn conversational text that mentions a login into an auth failure, but keeps anchored diagnostics", () => {
    const prose = degradedOrParseError("CLI", finishInput({ exitCode: 0 }), "We fixed the login required redirect.", "no JSON");
    expect(prose.ok).toBe(true);
    const diagnostic = degradedOrParseError("CLI", finishInput({ exitCode: 0 }), "login required", "no JSON");
    expect(diagnostic.error?.code).toBe("AUTH_REQUIRED");
  });

  it("ignores a PowerShell <# ... #> block comment when looking for the shim's script", () => {
    const file = putFile(join(workDir, "bin", "commented.ps1"), [
      "<#", '& "node$exe" "$basedir/../old/dist/cli/main.js" $args', "#>",
      '& "node$exe" "$basedir/../repo/dist/cli/main.js" $args',
    ].join("\n"));
    expect(readNpmShimTarget(file)).toBe(join(workDir, "repo", "dist", "cli", "main.js"));
    const only = putFile(join(workDir, "bin", "only-comment.ps1"), '<#\n& "node$exe" "$basedir/../old/main.js" $args\n#>\n');
    expect(readNpmShimTarget(only)).toBeUndefined();
  });

  it("treats a working directory too deep to search for a git root as inside the repository", async () => {
    const cwd = join(workDir, ...Array.from({ length: 70 }, (_, index) => `p${index}`));
    mkdirSync(cwd, { recursive: true });
    const cfg = join(workDir, "outside-cfg");
    putFile(join(cfg, "settings.json"), JSON.stringify({ env: { AWS_REGION: "eu-west-1" } }));
    const result = await inspectClaudeReadonlyForwardedEnv({ CLAUDE_CONFIG_DIR: cfg }, cwd, { homeDir: join(workDir, "home") });
    expect(result.names).toEqual([]);
  });
});
