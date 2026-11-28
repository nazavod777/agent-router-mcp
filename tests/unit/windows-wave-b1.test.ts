import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, inspectClaudeReadonlyForwardedEnv } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { BoundedMessages, createJsonResultParser } from "../../src/adapters/parsers.js";
import {
  PARSER_BUFFER_LIMIT_BYTES, classifiedFailure, degradedOrParseError, looksLikeAuthFailure, looksLikePromptTooLarge,
  looksLikeProviderOverloaded, looksLikeQuotaExceeded, mapEffortWith,
} from "../../src/adapters/probe-utils.js";
import type {
  BuildInvocationInput, BuiltInvocation, CliAdapter, FinishParseInput, ParsedAdapterResult,
} from "../../src/adapters/types.js";
import { createAssistantEventParser } from "../../src/adapters/vendor-clis.js";
import { ConfigManager } from "../../src/config/resolver.js";
import { clearRegisteredSecretValues, createSecretRedactor, redactSecrets, registerSecretValues } from "../../src/logging.js";
import { OrchestratorRunner, applyEnvOverrides, type RunJobRequest } from "../../src/runtime/runner.js";
import type { ErrorCode } from "../../src/types.js";
import { installStubClis, type StubCliEnvironment } from "./helpers/stub-clis.js";

/** A value with no recognizable credential shape, so only exact-value redaction can catch it. */
const PLAIN_SECRET = "zq-straddle-secret-0123456789";

afterEach(() => clearRegisteredSecretValues());

function finishInput(overrides: Partial<FinishParseInput> = {}): FinishParseInput {
  return { exitCode: 1, signal: null, stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0, ...overrides };
}

function parseLines(adapter: Pick<CliAdapter, "createStreamParser">, lines: unknown[], input: Partial<FinishParseInput> = {}): ParsedAdapterResult {
  const parser = adapter.createStreamParser();
  for (const line of lines) parser.pushLine(typeof line === "string" ? line : JSON.stringify(line));
  return parser.finish(finishInput(input));
}

function failureCode(text: string, fallback: ErrorCode = "NON_ZERO_EXIT"): ErrorCode | undefined {
  return classifiedFailure("Test CLI", finishInput(), text, fallback).error?.code;
}

// ---------------------------------------------------------------------------
// 1a. Bounded process-wide secret registry
// ---------------------------------------------------------------------------
describe("registerSecretValues", () => {
  it("masks a registered value in every later redaction, plain and JSON-escaped", () => {
    const secret = 'plain "quoted" secret value';
    expect(redactSecrets(`value=${secret}`)).toContain(secret);
    registerSecretValues([secret]);
    expect(redactSecrets(`value=${secret}`)).toBe("value=[REDACTED]");
    expect(createSecretRedactor()(JSON.stringify({ value: secret }))).not.toContain("quoted");
  });

  it("ignores values shorter than 8 characters", () => {
    registerSecretValues(["short12", "", "1234567"]);
    expect(redactSecrets("short12 1234567")).toBe("short12 1234567");
    registerSecretValues(["12345678"]);
    expect(redactSecrets("x 12345678 y")).toBe("x [REDACTED] y");
  });

  it("keeps at most 256 values and evicts the oldest first", () => {
    const values = Array.from({ length: 300 }, (_, index) => `registry-value-${String(index).padStart(4, "0")}`);
    registerSecretValues(values);
    const redact = createSecretRedactor();
    expect(redact(values[0])).toBe(values[0]);
    expect(redact(values[43])).toBe(values[43]);
    expect(redact(values[44])).toBe("[REDACTED]");
    expect(redact(values[299])).toBe("[REDACTED]");
  });

  it("moves a re-registered value to the newest position", () => {
    const values = Array.from({ length: 256 }, (_, index) => `refresh-value-${String(index).padStart(4, "0")}`);
    registerSecretValues(values);
    registerSecretValues([values[0]]);
    registerSecretValues(["refresh-value-extra"]);
    const redact = createSecretRedactor();
    expect(redact(values[0])).toBe("[REDACTED]");
    expect(redact(values[1])).toBe(values[1]);
  });

  it("is combined with explicit extra secrets and cleared by clearRegisteredSecretValues", () => {
    registerSecretValues(["registered-secret-aaaa"]);
    const redact = createSecretRedactor(["explicit-secret-bbbb"]);
    expect(redact("registered-secret-aaaa explicit-secret-bbbb")).toBe("[REDACTED] [REDACTED]");
    clearRegisteredSecretValues();
    expect(createSecretRedactor()("registered-secret-aaaa")).toBe("registered-secret-aaaa");
  });
});

// ---------------------------------------------------------------------------
// 1b. Runner: one env snapshot for adapter and child, adapter secrets
// ---------------------------------------------------------------------------
describe("applyEnvOverrides", () => {
  it("replaces a differently-cased spelling on Windows instead of duplicating it", () => {
    const env = applyEnvOverrides({ Path: "C:\\old", KEEP: "1" }, { PATH: "C:\\new" }, "win32");
    expect(env).toEqual({ PATH: "C:\\new", KEEP: "1" });
  });

  it("is case-sensitive elsewhere and never mutates the base environment", () => {
    const base = { Path: "a" };
    expect(applyEnvOverrides(base, { PATH: "b" }, "linux")).toEqual({ Path: "a", PATH: "b" });
    expect(base).toEqual({ Path: "a" });
  });

  it("keeps the orchestration variables the runner owns", () => {
    const env = applyEnvOverrides(
      { ORCH_DEPTH: "1", ORCH_JOB_ID: "job-1", ORCH_JOB_CHAIN: "job-1" },
      { orch_depth: "0", ORCH_JOB_ID: "other", ORCH_JOB_CHAIN: "x", ORCH_MAX_DEPTH: "99" }, "win32",
    );
    // ORCH_MAX_DEPTH is absent from the base environment, so an adapter cannot introduce it either.
    expect(env).toEqual({ ORCH_DEPTH: "1", ORCH_JOB_ID: "job-1", ORCH_JOB_CHAIN: "job-1" });
  });
});

describe("runner env snapshot and adapter secrets", () => {
  const OK_PRINT_ENV = 'console.log(JSON.stringify([process.env.TEST_BASE, process.env.TEST_OVERRIDE, process.env.ORCH_JOB_ID, process.env.ORCH_DEPTH].join("|")))';
  let root: string;
  let runner: OrchestratorRunner | undefined;
  let invocations: BuildInvocationInput[];

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orch-b1-runner-")));
    invocations = [];
  });

  afterEach(async () => {
    try {
      await runner?.shutdown();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function configure(build: (input: BuildInvocationInput) => Partial<BuiltInvocation>): Promise<RunJobRequest> {
    const configPath = join(root, "override.toml");
    await writeFile(configPath, "[defaults]\n");
    const adapter: CliAdapter = {
      driver: "claude",
      securityGuarantees: { readonly: "tool_allowlist", write: "unsandboxed" },
      mapEffort: (effort) => effort,
      async probe() { throw new Error("No live probe expected"); },
      async buildInvocation(input) {
        invocations.push(input);
        return { command: process.execPath, args: ["-e", input.prompt], stdin: "", nativeEffort: input.effort, tempFiles: [], warnings: [], ...build(input) };
      },
      createStreamParser() {
        const lines: string[] = [];
        return {
          pushLine(line) { if (line) lines.push(JSON.parse(line) as string); },
          finish(input) {
            if (input.exitCode) return classifiedFailure("Mock", input, undefined, "NON_ZERO_EXIT");
            return { ok: true, summary: lines.join("\n") };
          },
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
      env: { TEST_BASE: "base-value" },
      terminateGraceMs: 80,
      cliLimits: { home: join(root, "home"), cacheTtlMs: 0 },
    });
    return { cwd: root, prompt: OK_PRINT_ENV, model: "claude-sonnet", mode: "readonly" };
  }

  it("hands the adapter the same environment the child gets, then applies the adapter's overrides on top", async () => {
    const request = await configure(() => ({ envOverrides: { TEST_OVERRIDE: "from-adapter", TEST_BASE: "overridden" } }));
    const job = await runner!.run(request);
    expect(job).toMatchObject({ status: "completed" });
    const snapshot = invocations[0].env!;
    expect(snapshot).toMatchObject({ TEST_BASE: "base-value", ORCH_JOB_ID: job.job_id, ORCH_DEPTH: "1" });
    // The overrides are not part of the snapshot the adapter saw (and the snapshot was not mutated afterwards).
    expect(snapshot.TEST_OVERRIDE).toBeUndefined();
    expect(job.result?.summary).toBe(`overridden|from-adapter|${job.job_id}|1`);
  }, 20_000);

  it("passes the base value through when the adapter has no overrides", async () => {
    const request = await configure(() => ({}));
    const job = await runner!.run(request);
    expect(job.result?.summary).toBe(`base-value||${job.job_id}|1`);
  }, 20_000);

  it("does not let an adapter override the orchestration depth or job id of the child", async () => {
    const request = await configure(() => ({ envOverrides: { ORCH_DEPTH: "0", ORCH_JOB_ID: "forged" } }));
    const job = await runner!.run(request);
    expect(job.result?.summary).toBe(`base-value||${job.job_id}|1`);
  }, 20_000);

  it("redacts adapter-reported secrets from the result, errors and logs, and registers them process-wide", async () => {
    const secret = "adapter-file-credential-7788";
    const successRequest = await configure(() => ({ envOverrides: { TEST_FILE_VALUE: secret } }));
    const printSecret = 'console.log(JSON.stringify("value=" + process.env.TEST_FILE_VALUE))';

    // Negative control: without `secrets` nothing knows the value is sensitive (its variable name is harmless).
    const leaked = await runner!.run({ ...successRequest, prompt: printSecret });
    expect(leaked.result?.summary).toBe(`value=${secret}`);
    await runner!.shutdown();

    const request = await configure(() => ({ envOverrides: { TEST_FILE_VALUE: secret }, secrets: [secret] }));
    const done = await runner!.run({ ...request, prompt: printSecret });
    expect(done.result?.summary).toBe("value=[REDACTED]");
    expect((await runner!.readLogs(done.job_id, "stdout")).text).not.toContain(secret);
    // Registered, so an adapter-level redactSecrets() call masks it as well.
    expect(redactSecrets(`x ${secret}`)).toBe("x [REDACTED]");

    const failed = await runner!.run({ ...request, prompt: 'console.error("bad " + process.env.TEST_FILE_VALUE); process.exit(1)' });
    expect(failed.status).toBe("failed");
    expect(JSON.stringify(failed)).not.toContain(secret);
    expect((await runner!.readLogs(failed.job_id, "stderr")).text).not.toContain(secret);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// 2. Claude readonly: user settings.json auth/endpoint allowlist
// ---------------------------------------------------------------------------
describe("inspectClaudeReadonlyForwardedEnv", () => {
  let root: string;
  beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), "orch-b1-claude-"))); });
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  interface Scenario {
    base: string;
    configDir: string;
    cwd: string;
    homeDir: string;
  }

  /** A project (a repository with a `.git` entry), a user config directory and a home, all siblings in one temp directory. */
  function scenario(settings?: unknown): Scenario {
    const base = mkdtempSync(join(root, "case-"));
    const configDir = join(base, "cfg");
    const cwd = join(base, "project");
    const homeDir = join(base, "home");
    mkdirSync(configDir);
    mkdirSync(join(cwd, ".git"), { recursive: true });
    mkdirSync(join(cwd, "sub"));
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    if (settings !== undefined) writeFileSync(join(configDir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    return { base, configDir, cwd, homeDir };
  }

  const inspect = (s: Scenario, env: NodeJS.ProcessEnv = {}, platform?: NodeJS.Platform, cwd = s.cwd) =>
    inspectClaudeReadonlyForwardedEnv({ CLAUDE_CONFIG_DIR: s.configDir, ...env }, cwd, { platform, homeDir: s.homeDir });

  const ALLOWED_SAMPLE: Record<string, string> = {
    ANTHROPIC_API_KEY: "sk-ant-sample-key-0001", ANTHROPIC_AUTH_TOKEN: "auth-token-sample-0001", ANTHROPIC_BASE_URL: "https://gateway.example.test/v1",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-sample-0001", ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-x", ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-x",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-x", ANTHROPIC_SMALL_FAST_MODEL: "fast-x",
    CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example.test", CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-west-2", AWS_BEARER_TOKEN_BEDROCK: "bearer-token-sample-01",
    AWS_ACCESS_KEY_ID: "AKIASAMPLE0000000001", AWS_SECRET_ACCESS_KEY: "aws-secret-sample-0001", AWS_SESSION_TOKEN: "aws-session-sample-0001",
    CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_VERTEX_PROJECT_ID: "project-x", ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example.test",
    CLOUD_ML_REGION: "global", VERTEX_REGION_CLAUDE_3_5_SONNET: "us-east5", CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_API_KEY: "foundry-key-sample-01", ANTHROPIC_FOUNDRY_AUTH_TOKEN: "foundry-token-sample1",
    ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test", ANTHROPIC_FOUNDRY_RESOURCE: "resource-x", CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "1",
  };

  const FORBIDDEN_SAMPLE: Record<string, string> = {
    HTTPS_PROXY: "http://proxy.example.test:8080", HTTP_PROXY: "http://proxy.example.test:8080", ALL_PROXY: "socks5://proxy.example.test",
    NO_PROXY: "localhost", NODE_EXTRA_CA_CERTS: "/tmp/ca.pem", SSL_CERT_FILE: "/tmp/ca.pem", ANTHROPIC_CUSTOM_HEADERS: "X-Test: 1",
    ANTHROPIC_BETA: "beta-x", NODE_OPTIONS: "--require /tmp/evil.js", PATH: "/tmp/evil", CLAUDE_CODE_SHELL: "/tmp/sh", BASH_ENV: "/tmp/env.sh",
    LD_PRELOAD: "/tmp/evil.so", LD_LIBRARY_PATH: "/tmp", DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib", apiKeyHelper: "/tmp/helper.sh",
    VERTEX_REGION_OTHER: "us", SOME_OTHER_VARIABLE: "x",
  };

  it("forwards exactly the allowlisted names and nothing else", async () => {
    const s = scenario({ apiKeyHelper: "/tmp/helper.sh", env: { ...ALLOWED_SAMPLE, ...FORBIDDEN_SAMPLE } });
    const result = await inspect(s);
    expect(result.names).toEqual(Object.keys(ALLOWED_SAMPLE).sort());
    expect(result.env).toEqual(ALLOWED_SAMPLE);
    expect(result.warnings).toEqual([]);
  });

  it("reports secret-looking values (name with KEY/TOKEN/SECRET, 8+ characters) for redaction only", async () => {
    const s = scenario({ env: { ANTHROPIC_API_KEY: "sk-ant-sample-key-0001", AWS_SESSION_TOKEN: "short", AWS_REGION: "us-east-1-long-value", CLAUDE_CODE_USE_BEDROCK: "1" } });
    const result = await inspect(s);
    expect(result.secrets).toEqual(["sk-ant-sample-key-0001"]);
  });

  it("never puts a value into a warning", async () => {
    const s = scenario({ env: { ANTHROPIC_BASE_URL: "https://user:hunter2pass@gateway.example.test/?token=abc123def" } });
    const result = await inspect(s);
    expect(result.env).toEqual({});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("ANTHROPIC_BASE_URL");
    expect(result.warnings.join(" ")).not.toMatch(/hunter2pass|abc123def|gateway\.example/);
  });

  it.each([
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  ])("imports nothing from settings.json when the environment already has %s", async (selector) => {
    const s = scenario({ env: { ANTHROPIC_API_KEY: "sk-ant-sample-key-0001", AWS_REGION: "us-east-1", CLOUD_ML_REGION: "global" } });
    const result = await inspect(s, { [selector]: "1" });
    expect(result).toEqual({ env: {}, names: [], secrets: [], warnings: [] });
  });

  it("does not treat an empty selector as a chosen login, and is case-insensitive about selectors on Windows only", async () => {
    const s = scenario();
    writeFileSync(join(s.homeDir, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-sample-key-0001" } }));
    const inspectHome = (env: NodeJS.ProcessEnv, platform?: NodeJS.Platform) =>
      inspectClaudeReadonlyForwardedEnv(env, s.cwd, { platform, homeDir: s.homeDir });
    expect((await inspectHome({ ANTHROPIC_AUTH_TOKEN: "" })).names).toEqual(["ANTHROPIC_API_KEY"]);
    expect((await inspectHome({ anthropic_auth_token: "tok" }, "linux")).names).toEqual(["ANTHROPIC_API_KEY"]);
    expect((await inspectHome({ anthropic_auth_token: "tok" }, "win32")).names).toEqual([]);
  });

  it("never overwrites a variable the environment already holds, but fills an empty one", async () => {
    const s = scenario({ env: { AWS_REGION: "from-settings", AWS_DEFAULT_REGION: "from-settings", CLOUD_ML_REGION: "from-settings" } });
    const result = await inspect(s, { AWS_REGION: "from-env", AWS_DEFAULT_REGION: "" });
    expect(result.env).toEqual({ AWS_DEFAULT_REGION: "from-settings", CLOUD_ML_REGION: "from-settings" });
  });

  it("ignores non-string values, empty strings and strings containing a NUL byte", async () => {
    const s = scenario({ env: { AWS_REGION: 5, AWS_DEFAULT_REGION: "us\u0000east", CLOUD_ML_REGION: "", CLAUDE_CODE_USE_BEDROCK: true, ANTHROPIC_SMALL_FAST_MODEL: ["x"], ANTHROPIC_DEFAULT_OPUS_MODEL: "ok" } });
    expect((await inspect(s)).env).toEqual({ ANTHROPIC_DEFAULT_OPUS_MODEL: "ok" });
  });

  it.each(["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL"])(
    "validates %s as a plain http(s) URL",
    async (name) => {
      const good = ["https://gateway.example.test/v1", "http://localhost:8080", "https://gateway.example.test:8443/a/b"];
      const bad = [
        "ftp://gateway.example.test", "file:///etc/passwd", "javascript:alert(1)", "not a url", "https://user@gateway.example.test",
        "https://user:pass@gateway.example.test", "https://gateway.example.test/?token=1", "https://gateway.example.test/#frag",
      ];
      for (const value of good) expect((await inspect(scenario({ env: { [name]: value } }))).env).toEqual({ [name]: value });
      for (const value of bad) {
        const result = await inspect(scenario({ env: { [name]: value } }));
        expect(result.env, value).toEqual({});
        expect(result.warnings, value).toHaveLength(1);
        expect(result.warnings[0]).not.toContain(value);
      }
    },
  );

  it("uses an absolute CLAUDE_CONFIG_DIR, falls back to ~/.claude when it is unset or empty", async () => {
    const s = scenario({ env: { AWS_REGION: "from-config-dir" } });
    writeFileSync(join(s.homeDir, ".claude", "settings.json"), JSON.stringify({ env: { AWS_REGION: "from-home" } }));
    expect((await inspect(s)).env).toEqual({ AWS_REGION: "from-config-dir" });
    expect((await inspect(s, { CLAUDE_CONFIG_DIR: "" })).env).toEqual({ AWS_REGION: "from-home" });
    const unset = await inspectClaudeReadonlyForwardedEnv({}, s.cwd, { homeDir: s.homeDir });
    expect(unset.env).toEqual({ AWS_REGION: "from-home" });
  });

  it("refuses a relative CLAUDE_CONFIG_DIR with a warning and does not fall back to the home directory", async () => {
    const s = scenario();
    writeFileSync(join(s.homeDir, ".claude", "settings.json"), JSON.stringify({ env: { AWS_REGION: "from-home" } }));
    mkdirSync(join(s.cwd, "relative-cfg"));
    writeFileSync(join(s.cwd, "relative-cfg", "settings.json"), JSON.stringify({ env: { AWS_REGION: "from-cwd" } }));
    const result = await inspect(s, { CLAUDE_CONFIG_DIR: "relative-cfg" });
    expect(result.env).toEqual({});
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("CLAUDE_CONFIG_DIR");
  });

  describe("repository boundary", () => {
    const REFUSAL = /inside the job's working directory or repository/;

    it("refuses a settings.json inside the working directory", async () => {
      const s = scenario();
      const inside = join(s.cwd, "sub", ".claude");
      mkdirSync(inside);
      writeFileSync(join(inside, "settings.json"), JSON.stringify({ env: { AWS_REGION: "x" } }));
      const result = await inspect(s, { CLAUDE_CONFIG_DIR: inside }, undefined, join(s.cwd, "sub"));
      expect(result.env).toEqual({});
      expect(result.warnings[0]).toMatch(REFUSAL);
    });

    it("refuses a settings.json inside the Git repository that contains the working directory", async () => {
      const s = scenario();
      const inside = join(s.cwd, "tooling");
      mkdirSync(inside);
      writeFileSync(join(inside, "settings.json"), JSON.stringify({ env: { AWS_REGION: "x" } }));
      const result = await inspect(s, { CLAUDE_CONFIG_DIR: inside }, undefined, join(s.cwd, "sub"));
      expect(result.env).toEqual({});
      expect(result.warnings[0]).toMatch(REFUSAL);
    });

    it("refuses a symbolic link that leads into the repository", async () => {
      const s = scenario();
      const inside = join(s.cwd, "real-cfg");
      mkdirSync(inside);
      writeFileSync(join(inside, "settings.json"), JSON.stringify({ env: { AWS_REGION: "x" } }));
      const link = join(s.base, "link-cfg");
      symlinkSync(inside, link, "dir");
      const result = await inspect(s, { CLAUDE_CONFIG_DIR: link });
      expect(result.env).toEqual({});
      expect(result.warnings[0]).toMatch(REFUSAL);
    });

    it("refuses a home directory that is itself inside the working directory", async () => {
      const s = scenario();
      const home = join(s.cwd, "fake-home");
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { AWS_REGION: "x" } }));
      const result = await inspectClaudeReadonlyForwardedEnv({}, s.cwd, { homeDir: home });
      expect(result.env).toEqual({});
      expect(result.warnings[0]).toMatch(REFUSAL);
    });

    it("accepts a user directory outside the repository (control)", async () => {
      const s = scenario({ env: { AWS_REGION: "x-region" } });
      expect((await inspect(s, {}, undefined, join(s.cwd, "sub"))).env).toEqual({ AWS_REGION: "x-region" });
    });
  });

  describe("bounded and safe open", () => {
    it("skips a missing settings.json silently", async () => {
      expect(await inspect(scenario())).toEqual({ env: {}, names: [], secrets: [], warnings: [] });
      const missingDir = scenario();
      expect(await inspect(missingDir, { CLAUDE_CONFIG_DIR: join(missingDir.base, "does-not-exist") })).toEqual({ env: {}, names: [], secrets: [], warnings: [] });
    });

    it("skips malformed JSON with a warning", async () => {
      const result = await inspect(scenario('{"env": {"AWS_REGION": '));
      expect(result.env).toEqual({});
      expect(result.warnings).toHaveLength(1);
    });

    it.each([
      ["an array", "[]"], ["a string", '"x"'], ["a missing env block", '{"model":"x"}'],
      ["an env block that is an array", '{"env":["AWS_REGION"]}'], ["an env block that is a string", '{"env":"AWS_REGION=x"}'],
    ])("forwards nothing when the file holds %s", async (_label, text) => {
      expect((await inspect(scenario(text))).env).toEqual({});
    });

    it("accepts a file of exactly 256 KiB and rejects one byte more with a warning", async () => {
      const body = '{"env":{"AWS_REGION":"us-east-1"}}';
      const s = scenario(body + " ".repeat(262_144 - body.length));
      expect((await inspect(s)).env).toEqual({ AWS_REGION: "us-east-1" });
      const big = scenario(body + " ".repeat(262_145 - body.length));
      const result = await inspect(big);
      expect(result.env).toEqual({});
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("262144");
    });

    it.skipIf(process.platform === "win32")("rejects a symbolic link as settings.json", async () => {
      const s = scenario();
      writeFileSync(join(s.base, "real-settings.json"), JSON.stringify({ env: { AWS_REGION: "x" } }));
      symlinkSync(join(s.base, "real-settings.json"), join(s.configDir, "settings.json"));
      const result = await inspect(s);
      expect(result.env).toEqual({});
      expect(result.warnings).toHaveLength(1);
    });

    it.skipIf(process.platform === "win32")("rejects a FIFO as settings.json without blocking", async () => {
      const s = scenario();
      execFileSync("mkfifo", [join(s.configDir, "settings.json")]);
      const result = await inspect(s);
      expect(result.env).toEqual({});
      expect(result.warnings).toHaveLength(1);
    });

    it("rejects a settings.json that is a directory", async () => {
      const s = scenario();
      mkdirSync(join(s.configDir, "settings.json"));
      const result = await inspect(s);
      expect(result.env).toEqual({});
      expect(result.warnings).toHaveLength(1);
    });
  });

  describe("Windows environment-name rules", () => {
    it("skips keys that differ only in letter case, warns once per name, and keeps the unambiguous ones", async () => {
      const s = scenario({
        env: {
          ANTHROPIC_BASE_URL: "https://a.example.test", anthropic_base_url: "https://b.example.test",
          AWS_REGION: "us-east-1", ignored_variable: "x",
        },
      });
      const result = await inspect(s, {}, "win32");
      expect(result.env).toEqual({ AWS_REGION: "us-east-1" });
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("ANTHROPIC_BASE_URL");
      expect(result.warnings[0]).not.toContain("example.test");
    });

    it("matches a single differently-cased key and forwards it under its canonical name", async () => {
      const s = scenario({ env: { anthropic_api_key: "sk-ant-sample-key-0001", vertex_region_claude_haiku: "us-east5" } });
      const result = await inspect(s, {}, "win32");
      expect(result.env).toEqual({ ANTHROPIC_API_KEY: "sk-ant-sample-key-0001", VERTEX_REGION_CLAUDE_HAIKU: "us-east5" });
      expect(result.warnings).toEqual([]);
    });

    it("matches names case-sensitively on other platforms", async () => {
      const s = scenario();
      writeFileSync(join(s.homeDir, ".claude", "settings.json"), JSON.stringify({
        env: {
          anthropic_api_key: "sk-ant-sample-key-0001", ANTHROPIC_BASE_URL: "https://a.example.test",
          anthropic_base_url: "https://b.example.test", VERTEX_REGION_CLAUDE_lower: "us",
        },
      }));
      const result = await inspectClaudeReadonlyForwardedEnv({}, s.cwd, { platform: "linux", homeDir: s.homeDir });
      expect(result.env).toEqual({ ANTHROPIC_BASE_URL: "https://a.example.test" });
    });
  });
});

describe("ClaudeAdapter readonly profile", () => {
  let root: string;
  let stubClis: StubCliEnvironment;
  let counter = 0;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "orch-b1-claude-adapter-")));
    stubClis = installStubClis(["claude"]);
  });
  afterAll(() => {
    stubClis.restore();
    rmSync(root, { recursive: true, force: true });
  });

  function setup(settings: unknown): { configDir: string; cwd: string; jobDir: string } {
    counter += 1;
    const base = join(root, `adapter-${counter}`);
    const configDir = join(base, "cfg");
    const cwd = join(base, "project");
    const jobDir = join(base, "job");
    for (const dir of [configDir, cwd, jobDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(configDir, "settings.json"), JSON.stringify(settings));
    return { configDir, cwd, jobDir };
  }

  function request(
    paths: { cwd: string; jobDir: string }, mode: "readonly" | "write", extra: string[] = [], env?: NodeJS.ProcessEnv,
  ): BuildInvocationInput {
    return {
      harnessId: "claude",
      harness: { driver: "claude", display_name: "claude", binary: "claude", enabled: true, extra_args: extra },
      modelId: "test",
      model: {
        display_name: "Test", harness: "claude", cli_model: "demo", tier: "standard", efforts: ["medium", "high"],
        default_effort: "medium", cost_tier: "low", cost_note: "", speed_note: "", context_window: 1000, strengths: [],
        weaknesses: [], best_for: [], avoid_for: [], checked_at: "2026-11-25", enabled: true,
      },
      effort: "high", mode, prompt: "question", cwd: paths.cwd, jobDir: paths.jobDir, inheritMcp: false, isGitRepo: false,
      ...(env ? { env } : {}),
    };
  }

  const SETTINGS = { env: { ANTHROPIC_API_KEY: "sk-ant-sample-key-0001", AWS_REGION: "us-east-1", HTTPS_PROXY: "http://proxy.example.test" } };

  it("keeps every readonly restriction and forwards the allowlisted settings as env overrides and secrets", async () => {
    const paths = setup(SETTINGS);
    const invocation = await new ClaudeAdapter().buildInvocation(request(paths, "readonly", [], { CLAUDE_CONFIG_DIR: paths.configDir }));
    const { args } = invocation;
    const at = (flag: string) => args.indexOf(flag);
    expect(args.slice(at("--tools"), at("--tools") + 2)).toEqual(["--tools", "Read,Glob,Grep"]);
    expect(args).toContain("--restricted");
    expect(args.slice(at("--permission-mode"), at("--permission-mode") + 2)).toEqual(["--permission-mode", "plan"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args.slice(at("--disallowed-tools"), at("--disallowed-tools") + 2)).toEqual(["--disallowed-tools", "mcp__*"]);
    expect(invocation.envOverrides).toEqual({ ANTHROPIC_API_KEY: "sk-ant-sample-key-0001", AWS_REGION: "us-east-1" });
    expect(invocation.secrets).toEqual(["sk-ant-sample-key-0001"]);
    expect(JSON.stringify([args, invocation.warnings])).not.toContain("sk-ant-sample-key-0001");
  });

  it("does not forward anything in a write run", async () => {
    const paths = setup(SETTINGS);
    const invocation = await new ClaudeAdapter().buildInvocation(request(paths, "write", [], { CLAUDE_CONFIG_DIR: paths.configDir }));
    expect(invocation.envOverrides).toBeUndefined();
    expect(invocation.secrets).toBeUndefined();
  });

  it("forwards nothing when the child environment already selects a login", async () => {
    const paths = setup(SETTINGS);
    const invocation = await new ClaudeAdapter().buildInvocation(
      request(paths, "readonly", [], { CLAUDE_CONFIG_DIR: paths.configDir, ANTHROPIC_AUTH_TOKEN: "already-chosen-token" }),
    );
    expect(invocation.envOverrides).toBeUndefined();
    expect(invocation.secrets).toBeUndefined();
  });

  it("reads the process environment when the caller passes no snapshot", async () => {
    const paths = setup(SETTINGS);
    vi.stubEnv("CLAUDE_CONFIG_DIR", paths.configDir);
    // The developer's own login selectors must not leak into the assertion (an empty value counts as unset).
    for (const selector of [
      "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_REGION",
    ]) vi.stubEnv(selector, "");
    try {
      const invocation = await new ClaudeAdapter().buildInvocation(request(paths, "readonly"));
      expect(invocation.envOverrides).toMatchObject({ AWS_REGION: "us-east-1" });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("surfaces a settings problem as a non-fatal warning", async () => {
    const paths = setup(SETTINGS);
    writeFileSync(join(paths.configDir, "settings.json"), "{ not json");
    const invocation = await new ClaudeAdapter().buildInvocation(request(paths, "readonly", [], { CLAUDE_CONFIG_DIR: paths.configDir }));
    expect(invocation.envOverrides).toBeUndefined();
    expect(invocation.warnings).toHaveLength(1);
  });

  it.each([["--add-dir", "/tmp/elsewhere"], ["--add-dir=/tmp/elsewhere"]])("refuses %s in a readonly run", async (...extra) => {
    const paths = setup(SETTINGS);
    await expect(new ClaudeAdapter().buildInvocation({ ...request(paths, "readonly", extra), allowUnsandboxedWrite: true }))
      .rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
  });

  it("still refuses --add-dir in a sandboxed write run", async () => {
    const paths = setup(SETTINGS);
    await expect(new ClaudeAdapter().buildInvocation(request(paths, "write", ["--add-dir", "/tmp/elsewhere"])))
      .rejects.toMatchObject({ code: "SANDBOX_POLICY_VIOLATION" });
  });
});

// ---------------------------------------------------------------------------
// 3. Failure classification
// ---------------------------------------------------------------------------
describe("authentication patterns", () => {
  it.each([
    "Failed to authenticate: OAuth session expired", "Your OAuth session has expired", "auth session revoked", "Auth session invalid",
    "refresh token expired", "The refresh token has expired", "refresh token revoked", "error: invalid_grant", "token_expired",
    "Please re-authenticate", "please reauthenticate to continue", "The API key is not valid", "API key not valid. Please pass a valid API key.",
    "Incorrect API key provided: sk-abc",
    "HTTP/2 401", "API Error: 401", '{"status": 401}', '{"code": 403}', "API Error: 403", "401 Unauthorized", "403 Forbidden", "status=403",
  ])("recognizes %j as an authentication failure", (text) => {
    expect(looksLikeAuthFailure(text)).toBe(true);
    expect(failureCode(text)).toBe("AUTH_REQUIRED");
  });

  it.each([
    "The refresh token logic in src/auth.ts looks correct.",
    "oauth session handling lives in session.ts",
    "See src/auth.ts:401: the check returns early.",
    "line 403 of the file contains the handler",
    "You should ask users to re-authenticate after a password reset.",
    "invalid grants are rejected by the validator",
    "The API key format is documented in the README.",
  ])("does not treat code-review prose %j as an authentication failure", (text) => {
    expect(looksLikeAuthFailure(text)).toBe(false);
  });
});

describe("failure class priority", () => {
  it.each([
    "HTTP 403 model claude-x not found", "API Error: 403 permission denied for model claude-x",
    '{"status": 403, "message": "model claude-x does not exist"}', "HTTP/2 403 model_not_supported", "403 Forbidden: model claude-x is not allowed",
  ])("classifies a 403 that names a model (%j) as MODEL_UNSUPPORTED", (text) => {
    expect(failureCode(text)).toBe("MODEL_UNSUPPORTED");
    expect(classifiedFailure("X", finishInput(), text, "NON_ZERO_EXIT").error?.failure_scope).toBe("model");
  });

  it.each([
    "HTTP 403 Forbidden", "API Error: 403", '{"code": 403, "message": "access denied"}',
  ])("keeps a bare 403 (%j) as AUTH_REQUIRED", (text) => {
    expect(failureCode(text)).toBe("AUTH_REQUIRED");
  });

  it.each([
    "401 Unauthorized: model claude-x not found", "Failed to authenticate: OAuth session expired (HTTP 403, model claude-x)",
    "invalid api key; model claude-x not found", "Not logged in. HTTP 403 model x not found",
  ])("lets a strong authentication signal (%j) win over a model error", (text) => {
    expect(failureCode(text)).toBe("AUTH_REQUIRED");
  });

  it("recognizes model_not_supported", () => {
    expect(failureCode("error code: model_not_supported")).toBe("MODEL_UNSUPPORTED");
  });
});

describe("quota, overload and prompt-size patterns", () => {
  it.each([
    "You've exceeded your current quota", "You\u2019ve exceeded your quota", "You exceeded your current quota, please check your plan",
    '{"status": 402}', "HTTP/2 402", "API Error: 402",
  ])("classifies %j as QUOTA_EXCEEDED", (text) => {
    expect(looksLikeQuotaExceeded(text)).toBe(true);
    expect(failureCode(text)).toBe("QUOTA_EXCEEDED");
  });

  it("keeps a hard quota message QUOTA_EXCEEDED even when the provider sends 429", () => {
    expect(failureCode("429 You've exceeded your current quota")).toBe("QUOTA_EXCEEDED");
    expect(failureCode("429 Too Many Requests")).toBe("RATE_LIMITED");
  });

  it.each([
    "HTTP 500", '{"status": 500}', "HTTP/2 504", "500 Internal Server Error", "504 Gateway Timeout", "504 Gateway Time-out",
    '{"status": "UNAVAILABLE"}', 'code: "UNAVAILABLE"', '{"code": "DEADLINE_EXCEEDED"}', "rpc error: DEADLINE_EXCEEDED", "status 503",
  ])("classifies %j as PROVIDER_OVERLOADED", (text) => {
    expect(looksLikeProviderOverloaded(text)).toBe(true);
    expect(failureCode(text)).toBe("PROVIDER_OVERLOADED");
  });

  it.each(["See src/a.ts:500: for details", "the code is unavailable in this region", "status unavailable", "line 504 changed"])(
    "does not treat %j as an overload", (text) => { expect(looksLikeProviderOverloaded(text)).toBe(false); },
  );

  it.each(['{"status": 413}', "HTTP 413", "HTTP/2 413 Request Entity Too Large", "Payload Too Large", "error: context_window_exceeded"])(
    "classifies %j as PROMPT_TOO_LARGE", (text) => {
      expect(looksLikePromptTooLarge(text)).toBe(true);
      expect(failureCode(text)).toBe("PROMPT_TOO_LARGE");
    },
  );

  it("does not take a file position for a status code", () => {
    expect(looksLikePromptTooLarge("src/a.ts:413: see here")).toBe(false);
    expect(looksLikeQuotaExceeded("src/a.ts:402: see here")).toBe(false);
  });
});

describe("exit 0 with a short diagnostic on stdout", () => {
  const degraded = (text: string, stderrTail = "") => degradedOrParseError("Test CLI", finishInput({ exitCode: 0, stderrTail }), text, "no result object");

  it.each([
    ["Error: login required", "AUTH_REQUIRED"],
    ["Failed to authenticate: OAuth session expired", "AUTH_REQUIRED"],
    ["Unauthorized: token expired", "AUTH_REQUIRED"],
    ["API Error: 429 rate limit reached", "RATE_LIMITED"],
    ["Fatal: model_not_supported", "MODEL_UNSUPPORTED"],
    ["Error: Rate limit exceeded", "RATE_LIMITED"],
    ["Error: You've exceeded your current quota", "QUOTA_EXCEEDED"],
    ["Please re-authenticate.\nRun the login command.", "AUTH_REQUIRED"],
    ["Not logged in. Please run /login", "AUTH_REQUIRED"],
  ] as const)("reports %j as a failed run (%s)", (text, code) => {
    const result = degraded(text);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(result.parseDegraded).toBeUndefined();
  });

  it.each([
    // Without an error label only a login prompt counts: answers that mention a limit, a quota or a status stay answers.
    "Rate limit exceeded", "You've exceeded your current quota", "Unauthorized", "HTTP 429 handling was added.",
    "Rate limiting is implemented in src/limiter.ts using a token bucket.",
    "The login flow stores a refresh token and retries when the quota is checked.",
    "Error: something unrelated broke",
    "Done.",
    `Review notes\n\nThe handler returns 401 Unauthorized when the token is missing.\n\nNo other issues.`,
    `\`\`\`\nrate limit exceeded\n\`\`\``,
    `Error: login required\n${"padding ".repeat(300)}`,
    `${"line one is a long review sentence about authentication and quota handling. ".repeat(9)}Rate limit exceeded`,
  ])("keeps %j as a degraded answer", (text) => {
    const result = degraded(text);
    expect(result).toMatchObject({ ok: true, parseDegraded: true });
  });

  it("still classifies from stderr first", () => {
    expect(degraded("some answer", "Error: login required")).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
  });

  it("applies to the stream parsers that fall back to raw text", () => {
    const parsed = parseLines(new ClaudeAdapter(), ["Error: login required"], { exitCode: 0 });
    expect(parsed).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    const codex = parseLines(new CodexAdapter(), ["Error: login required"], { exitCode: 0 });
    expect(codex).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
  });
});

describe("mapEffortWith", () => {
  it("lowercases the standard levels and the synonym keys, whatever their case", () => {
    for (const level of ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "default"]) {
      expect(mapEffortWith({}, `  ${level.toUpperCase()} `)).toBe(level);
    }
    expect(mapEffortWith({ "extra-high": "xhigh" }, " Extra-High ")).toBe("xhigh");
    expect(mapEffortWith({ maximum: "max" }, "MAXIMUM")).toBe("max");
  });

  it("keeps the case of a custom value and only trims it", () => {
    expect(mapEffortWith({}, "  Budget-16K  ")).toBe("Budget-16K");
    expect(mapEffortWith({ minimal: "low" }, "CustomMode")).toBe("CustomMode");
  });

  it("is what the Claude adapter uses", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.mapEffort("X-High")).toBe("xhigh");
    expect(adapter.mapEffort("Mixed_Case")).toBe("Mixed_Case");
  });
});

// ---------------------------------------------------------------------------
// 3b. Redact before truncate
// ---------------------------------------------------------------------------
describe("redaction happens before truncation", () => {
  it("keeps a secret cut by the stderr tail window out of the failure message", () => {
    const secret = `sk-${"B".repeat(100)}`;
    const stderrTail = `pad ${secret} ${"z".repeat(450)}`;
    const error = classifiedFailure("Test CLI", finishInput({ stderrTail }), undefined, "NON_ZERO_EXIT").error!;
    expect(error.message).not.toContain("BBBBBBBBBB");
    expect(error.message).toContain("[REDACTED]");
  });

  it("keeps a registered value cut by the stderr tail window out of the failure message", () => {
    registerSecretValues([PLAIN_SECRET]);
    const stderrTail = `pad ${PLAIN_SECRET} ${"z".repeat(480)}`;
    const error = classifiedFailure("Test CLI", finishInput({ stderrTail }), undefined, "NON_ZERO_EXIT").error!;
    expect(error.message).not.toContain("0123456789");
    expect(error.message).not.toContain("secret");
  });

  it("BoundedMessages redacts a message before cutting it to its byte budget", () => {
    registerSecretValues([PLAIN_SECRET]);
    const messages = new BoundedMessages(40);
    messages.push(`${"a".repeat(30)}${PLAIN_SECRET}`);
    expect(messages.values()).toHaveLength(1);
    expect(messages.values()[0]).not.toContain("zq-");
    expect(messages.values()[0]).toBe(`${"a".repeat(30)}[REDACTED]`);
  });

  it("keeps a value cut by the Claude assistant-error budget out of the result", () => {
    registerSecretValues([PLAIN_SECRET]);
    // "server_error: " is 14 characters; 6 characters of the secret would survive a cut at 2048 bytes.
    const text = `${"a".repeat(2048 - 14 - 6)}${PLAIN_SECRET}`;
    const parsed = parseLines(new ClaudeAdapter(), [
      { type: "assistant", error: "server_error", message: { id: "m1", content: [{ type: "text", text }] } },
    ], { exitCode: 1 });
    const evidence = JSON.stringify(parsed.error);
    expect(evidence).not.toContain("zq-str");
    expect(evidence).not.toContain("straddle");
  });

  it("keeps a value cut by the Claude result-errors budget out of the result", () => {
    registerSecretValues([PLAIN_SECRET]);
    const text = `${"a".repeat(16 * 1024 - 6)}${PLAIN_SECRET}`;
    const parsed = parseLines(new ClaudeAdapter(), [
      { type: "result", subtype: "error_during_execution", is_error: true, result: "", errors: [text] },
    ], { exitCode: 1 });
    expect(JSON.stringify(parsed.error)).not.toContain("zq-str");
  });

  it("keeps a value cut by the Codex answer buffer out of the summary", () => {
    registerSecretValues([PLAIN_SECRET]);
    const text = `${"b".repeat(PARSER_BUFFER_LIMIT_BYTES - 6)}${PLAIN_SECRET}`;
    const parsed = parseLines(new CodexAdapter(), [
      { type: "item.completed", item: { type: "agent_message", text } },
      { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
    ], { exitCode: 0 });
    expect(parsed.ok).toBe(true);
    expect(parsed.summary).not.toContain("zq-str");
    // Redacted first (the secret became "[REDACTED]"), then cut at the buffer limit.
    expect(parsed.summary.endsWith("[REDAC")).toBe(true);
  });

  it("keeps a registered value out of the Codex transient-error warning", () => {
    registerSecretValues([PLAIN_SECRET]);
    const parsed = parseLines(new CodexAdapter(), [
      { type: "error", message: `transient ${PLAIN_SECRET}` },
      { type: "turn.failed", error: { message: "model x rejected" } },
    ], { exitCode: 1 });
    expect(JSON.stringify(parsed)).not.toContain(PLAIN_SECRET);
    expect(parsed.warnings?.join(" ")).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// 3c. Error text stays out of the summary
// ---------------------------------------------------------------------------
describe("failed results keep the error message out of the summary", () => {
  it("Claude: an is_error result with no streamed assistant text has an empty summary", () => {
    const parsed = parseLines(new ClaudeAdapter(), [
      { type: "result", subtype: "success", is_error: true, result: "API Error: 500 upstream exploded" },
    ], { exitCode: 1 });
    expect(parsed).toMatchObject({ ok: false, summary: "", error: { code: "PROVIDER_OVERLOADED" } });
  });

  it("Claude: streamed assistant text that differs from the error stays as the partial summary", () => {
    const parsed = parseLines(new ClaudeAdapter(), [
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "partial answer so far" }] } },
      { type: "result", subtype: "error_during_execution", is_error: true, result: "API Error: 500 upstream exploded" },
    ], { exitCode: 1 });
    expect(parsed).toMatchObject({ ok: false, summary: "partial answer so far" });
  });

  it("Claude: assistant text that merely repeats the error message is not kept as a summary", () => {
    const parsed = parseLines(new ClaudeAdapter(), [
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "API Error: 500 upstream exploded" }] } },
      { type: "result", subtype: "success", is_error: true, result: "API Error: 500 upstream exploded" },
    ], { exitCode: 1 });
    expect(parsed).toMatchObject({ ok: false, summary: "" });
  });

  it("Claude: a bare non-zero exit keeps the answer text as the summary (unchanged)", () => {
    const parsed = parseLines(new ClaudeAdapter(), [
      { type: "result", subtype: "success", is_error: false, result: "the answer" },
    ], { exitCode: 3 });
    expect(parsed).toMatchObject({ ok: false, summary: "the answer" });
  });

  describe("createJsonResultParser", () => {
    const parserFor = (extracted: { text?: string; isError?: boolean; errorMessage?: string }) =>
      createJsonResultParser({ label: "Test CLI", extract: () => extracted });
    const run = (extracted: { text?: string; isError?: boolean; errorMessage?: string }, exitCode = 1) => {
      const parser = parserFor(extracted);
      parser.pushLine('{"x":1}');
      return parser.finish(finishInput({ exitCode }));
    };

    it("drops the text when it is the error message itself", () => {
      expect(run({ text: "boom", isError: true, errorMessage: "boom" }).summary).toBe("");
    });

    it("drops the text when the CLI gave no separate error message", () => {
      const result = run({ text: "boom", isError: true });
      expect(result.summary).toBe("");
      expect(result.error?.message).toContain("boom");
    });

    it("keeps text that differs from the error message", () => {
      expect(run({ text: "partial", isError: true, errorMessage: "different" }).summary).toBe("partial");
    });

    it("keeps the answer text of a bare non-zero exit", () => {
      expect(run({ text: "answer", isError: false }).summary).toBe("answer");
    });
  });
});

// ---------------------------------------------------------------------------
// 3d. Assistant-event parser (Cursor, Kiro, Muse, ...)
// ---------------------------------------------------------------------------
describe("createAssistantEventParser errors", () => {
  it("keeps every error event instead of overwriting the first", () => {
    const parsed = parseLines({ createStreamParser: () => createAssistantEventParser("Test CLI") }, [
      { type: "error", error: { message: "first cause: upstream refused" } },
      { type: "error", message: "later generic failure" },
    ], { exitCode: 1 });
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.message).toContain("first cause: upstream refused");
    expect(parsed.error?.message).toContain("later generic failure");
  });

  it("reads the message nested in error.data", () => {
    const parsed = parseLines({ createStreamParser: () => createAssistantEventParser("Test CLI") }, [
      { type: "error", error: { name: "UnknownError", data: { message: "Failed to authenticate: OAuth session expired" } } },
    ], { exitCode: 1 });
    expect(parsed).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(parsed.error?.message).toContain("OAuth session expired");
  });

  it("falls back to a generic message and redacts before bounding", () => {
    registerSecretValues([PLAIN_SECRET]);
    const parsed = parseLines({ createStreamParser: () => createAssistantEventParser("Test CLI") }, [
      { type: "error" },
      { type: "error", error: `leaked ${PLAIN_SECRET}` },
    ], { exitCode: 1 });
    expect(parsed.error?.message).toContain("Test CLI reported an error.");
    expect(JSON.stringify(parsed)).not.toContain(PLAIN_SECRET);
  });

  it("bounds the number of kept error messages", () => {
    const events = Array.from({ length: 2_000 }, (_, index) => ({ type: "error", message: `failure number ${index}` }));
    const parsed = parseLines({ createStreamParser: () => createAssistantEventParser("Test CLI") }, events, { exitCode: 1 });
    expect(parsed.ok).toBe(false);
    expect(parsed.error?.raw_error?.length ?? 0).toBeLessThanOrEqual(2_000);
    expect(parsed.error?.raw_error).not.toContain("failure number 1999");
  });
});
