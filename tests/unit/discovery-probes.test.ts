import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProbeEnv,
  defaultExecProbe,
  parseAntigravityOutput,
  parseCursorOutput,
  parseFxOutput,
  parseGeminiOutput,
  parseGrokOutput,
  parseKiroOutput,
  parseMuseOutput,
  parseOpencodeOutput,
  parsePiOutput,
  probeCliModels,
} from "../../src/discovery/cli-probes.js";
import {
  DISCOVERY_STDERR_LIMIT_BYTES,
  DISCOVERY_STDOUT_LIMIT_BYTES,
  MAX_MODELS_PER_SOURCE,
  type CliProbeInput,
  type ExecProbe,
  type ProbeRunRequest,
  type ProbeRunResult,
} from "../../src/discovery/types.js";
import type { DriverKind } from "../../src/drivers.js";

const ESC = "\u001b";

function ids(models: readonly { cli_model: string }[]): string[] {
  return models.map((model) => model.cli_model);
}

describe("discovery text and JSON parsers", () => {
  it("parses the Pi table with rounded and exact context windows", () => {
    const stdout = [
      "provider    model                   context  max-out  thinking  images",
      "anthropic   claude-opus-4-5         1.0M     64K      yes       yes",
      "openrouter  moonshotai/kimi-k2      262.1K   32K      no        no",
      "groq        llama-3.3-70b           500K     8K       no        no",
      "local       tiny-model              128000   4096     no        no",
      "",
    ].join("\n");
    const models = parsePiOutput(stdout);
    expect(models).toEqual([
      { cli_provider: "anthropic", cli_model: "claude-opus-4-5", context_window: 1_000_000, context_precision: "rounded", reasoning: true, availability: "reported_available", evidence: "cli_listing" },
      { cli_provider: "openrouter", cli_model: "moonshotai/kimi-k2", context_window: 262_100, context_precision: "rounded", reasoning: false, availability: "reported_available", evidence: "cli_listing" },
      { cli_provider: "groq", cli_model: "llama-3.3-70b", context_window: 500_000, context_precision: "rounded", reasoning: false, availability: "reported_available", evidence: "cli_listing" },
      { cli_provider: "local", cli_model: "tiny-model", context_window: 128_000, context_precision: "exact", reasoning: false, availability: "reported_available", evidence: "cli_listing" },
    ]);
  });

  it("ignores Pi prose and spinners around the table and reads columns by header names", () => {
    const stdout = `${ESC}[2K\rLoading models...\n${ESC}[1mmodel  provider  context  thinking${ESC}[0m\n`
      + "x-1  acme  64K  yes\nTip: run pi --help\n";
    // The header order differs from the default (`model` first), so columns come from the header names.
    const models = parsePiOutput(stdout);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ cli_model: "x-1", cli_provider: "acme", context_window: 64_000, reasoning: true });
    // Headerless rows are accepted positionally, but only when the context column is a number.
    expect(ids(parsePiOutput("acme a-1 64K 8K yes no\nFetching model list from provider now\n"))).toEqual(["a-1"]);
  });

  it("parses OpenCode ids splitting at the first slash, keeping suffixes and dropping ANSI and prose", () => {
    const stdout = `${ESC}[32mdeepinfra/deepseek-ai/DeepSeek-V4-Pro${ESC}[0m\nanthropic/claude-sonnet-4-5[1m]\n`
      + `${ESC}]0;title\u0007openai/gpt-5\nno-slash-line\nWarning: something odd\nopenai/gpt-5\n`;
    const models = parseOpencodeOutput(stdout);
    expect(models.map((model) => [model.cli_provider, model.cli_model])).toEqual([
      ["deepinfra", "deepseek-ai/DeepSeek-V4-Pro"],
      ["anthropic", "claude-sonnet-4-5[1m]"],
      ["openai", "gpt-5"],
    ]);
  });

  it("parses Gemini JSON as an array or wrapped object, reading only allowlisted keys", () => {
    const rows = [
      { modelId: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", contextLimits: { inputTokens: 1_048_576, secret: "x" }, apiKey: "sk-secret" },
      { id: "gemini-flash", name: "Flash", contextLimits: { inputTokens: 1.5 } },
      { nothing: true },
    ];
    for (const payload of [rows, { models: rows }]) {
      const models = parseGeminiOutput(JSON.stringify(payload));
      expect(models).toEqual([
        { cli_model: "gemini-2.5-pro", display_name: "Gemini 2.5 Pro", context_window: 1_048_576, context_precision: "exact", availability: "reported_available", evidence: "cli_listing" },
        { cli_model: "gemini-flash", display_name: "Flash", availability: "reported_available", evidence: "cli_listing" },
      ]);
    }
    expect(parseGeminiOutput("not json at all")).toEqual([]);
  });

  it("parses Antigravity ids keeping effort suffixes and skipping prose", () => {
    const stdout = [
      "Available models",
      "gemini-4-argon-high",
      "* gemini-4-argon-low (default)",
      "- claude-sonnet-5  Anthropic Sonnet",
      "1. gemini-4-argon-medium",
      "Loading...",
      "Use agy --model <id> to pick one",
    ].join("\n");
    expect(ids(parseAntigravityOutput(stdout))).toEqual([
      "gemini-4-argon-high", "gemini-4-argon-low", "claude-sonnet-5", "gemini-4-argon-medium",
    ]);
  });

  it("parses fx ids and models, de-duplicating bare ids already described", () => {
    const payload = {
      ids: ["openai/gpt-5", "anthropic/claude-5", "openai/gpt-5"],
      models: [
        { id: "anthropic/claude-5", provider: "anthropic", contextWindow: 200_000 },
        { name: "zeta-1", context_window: 32_000 },
        { id: "bad id with spaces" },
      ],
    };
    const models = parseFxOutput(JSON.stringify(payload));
    expect(models.map((model) => [model.cli_provider, model.cli_model, model.context_window])).toEqual([
      ["anthropic", "anthropic/claude-5", 200_000],
      [undefined, "zeta-1", 32_000],
      [undefined, "openai/gpt-5", undefined],
    ]);
  });

  it("parses Grok models under the heading and stops at the end of the list", () => {
    const stdout = [
      "grok 1.2.3",
      "",
      "Available models:",
      "* grok-4 (default)",
      "- grok-4-fast",
      "- grok-code-1",
      "",
      "Run `grok --model <id>` to pick one.",
      "- not-a-model-after-list",
    ].join("\n");
    expect(ids(parseGrokOutput(stdout))).toEqual(["grok-4", "grok-4-fast", "grok-code-1"]);
    expect(parseGrokOutput("grok-4\nno heading\n")).toEqual([]);
  });

  it("parses Cursor selector lines and skips headings and tips", () => {
    const stdout = [
      "Available models",
      "",
      "auto - Auto",
      "gpt-5 - GPT-5 (current)",
      "* sonnet-4",
      "Tip - use --model to switch",
      "Note: models change often",
    ].join("\n");
    const models = parseCursorOutput(stdout);
    expect(models.map((model) => [model.cli_model, model.display_name])).toEqual([
      ["auto", "Auto"], ["gpt-5", "GPT-5"], ["sonnet-4", undefined],
    ]);
  });

  it("parses Kiro JSON rows and falls back to id lines for plain text", () => {
    expect(ids(parseKiroOutput(JSON.stringify({ models: [{ model_id: "auto", description: "x" }, { id: "claude-sonnet-4.5" }, "claude-haiku-4.5", { name: "n-1" }] }))))
      .toEqual(["auto", "claude-sonnet-4.5", "claude-haiku-4.5", "n-1"]);
    expect(ids(parseKiroOutput(JSON.stringify(["a-1", "b-2"])))).toEqual(["a-1", "b-2"]);
    expect(ids(parseKiroOutput("Available models:\nauto  Let Kiro pick\n* claude-sonnet-4.5\nNote that this is prose\n"))).toEqual(["auto", "claude-sonnet-4.5"]);
  });

  it("parses Muse one id per line", () => {
    expect(ids(parseMuseOutput(`${ESC}[1mmuse-large${ESC}[0m\n\nmuse-small\nthis is prose\nmuse-large\n`))).toEqual(["muse-large", "muse-small"]);
  });

  it("rejects ids that are too long or contain unsafe characters", () => {
    const tooLong = "a".repeat(201);
    expect(ids(parseMuseOutput(`${tooLong}\nok-id\n$(rm)\n-leading\n`))).toEqual(["ok-id"]);
  });
});

describe("buildProbeEnv", () => {
  it("keeps the allowlist plus the driver's own home variables and drops everything else", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/bin", HOME: "/home/u", LANG: "C", LC_ALL: "C", XDG_CONFIG_HOME: "/x", TMPDIR: "/tmp", SystemRoot: "C:\\Win",
      PI_CODING_AGENT_DIR: "/pi", CODEX_HOME: "/codex",
      OPENAI_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp_x", NODE_OPTIONS: "--require /evil.js", LD_PRELOAD: "/evil.so",
      LD_LIBRARY_PATH: "/evil", DYLD_INSERT_LIBRARIES: "/evil", HTTPS_PROXY: "http://u:p@proxy", NO_COLOR: "0",
    };
    const env = buildProbeEnv(source, "pi");
    expect(env).toEqual({
      PATH: "/bin", HOME: "/home/u", LANG: "C", LC_ALL: "C", XDG_CONFIG_HOME: "/x", TMPDIR: "/tmp", SystemRoot: "C:\\Win",
      PI_CODING_AGENT_DIR: "/pi", NO_COLOR: "1",
    });
    expect(buildProbeEnv(source, "codex").CODEX_HOME).toBe("/codex");
    expect(buildProbeEnv(source, "opencode")).not.toHaveProperty("PI_CODING_AGENT_DIR");
  });
});

const OPENCODE_HELP = "Commands:\n  opencode models [provider]  list all available models\n";
const MUSE_HELP = "Options:\n  --list-models  List available models\n";

function fakeProbeResult(overrides: Partial<ProbeRunResult> = {}): ProbeRunResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false, ...overrides };
}

describe.skipIf(process.platform === "win32")("probeCliModels", () => {
  let root: string;
  let binDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orch-discovery-probes-"));
    binDir = join(root, "bin");
    mkdirSync(binDir);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function installBinary(name: string): string {
    const path = join(binDir, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
    return path;
  }

  function makeInput(driver: DriverKind, binary: string, execProbe: ExecProbe, extra: Partial<CliProbeInput> = {}): CliProbeInput {
    return {
      cwd: root,
      env: { PATH: binDir, HOME: root, OPENAI_API_KEY: "sk-leak", NODE_OPTIONS: "--inspect" },
      homeDir: root,
      platform: process.platform,
      harnessId: driver,
      harness: { driver, display_name: driver, binary, enabled: true, extra_args: ["--dangerous", "--yolo"] },
      driver,
      discovery: "native",
      execProbe,
      probeTimeoutMs: 1234,
      ...extra,
    };
  }

  function recorder(...results: Partial<ProbeRunResult>[]): { exec: ExecProbe; requests: ProbeRunRequest[] } {
    const requests: ProbeRunRequest[] = [];
    const queue = [...results];
    const exec: ExecProbe = async (request) => {
      requests.push(request);
      return fakeProbeResult(queue.shift() ?? {});
    };
    return { exec, requests };
  }

  const LISTING_CASES: ReadonlyArray<{
    driver: DriverKind; binary: string; args: string[]; stdout: string; expected: string[]; helpArgs?: string[]; preflight?: string;
  }> = [
    { driver: "pi", binary: "pi", args: ["--no-extensions", "--no-mcp", "--no-approve", "--offline", "--list-models"], stdout: "provider model context max-out thinking images\nacme a-1 64K 8K yes no\n", expected: ["a-1"] },
    {
      driver: "opencode", binary: "opencode", args: ["models"], stdout: "p/m-1\n", expected: ["m-1"], helpArgs: ["--help"],
      preflight: "Commands:\n  opencode models [provider]  list all available models\n",
    },
    {
      driver: "gemini", binary: "gemini", args: ["models", "list", "--output-format", "json"], stdout: JSON.stringify([{ modelId: "g-1" }]),
      expected: ["g-1"], helpArgs: ["--help"], preflight: "Commands:\n  gemini models list  List models\n  gemini [query..]  Launch Gemini CLI  [default]\n",
    },
    {
      driver: "antigravity", binary: "agy", args: ["models"], stdout: "agy-model-high\n", expected: ["agy-model-high"], helpArgs: ["--help"],
      preflight: "Commands:\n  agy models  List available models\n",
    },
    {
      driver: "grok", binary: "grok", args: ["models"], stdout: "Available models:\n* grok-4 (default)\n", expected: ["grok-4"], helpArgs: ["--help"],
      preflight: "Commands:\n  models  List available models\n",
    },
    {
      driver: "cursor", binary: "cursor-agent", args: ["models"], stdout: "auto - Auto\n", expected: ["auto"], helpArgs: ["--help"],
      preflight: "Commands:\n  agent [options] [prompt...]  Start the Cursor Agent\n  models  List available models for this account\n",
    },
    {
      driver: "kiro", binary: "kiro-cli", args: ["chat", "--list-models", "--format", "json"], stdout: JSON.stringify(["auto"]), expected: ["auto"],
      helpArgs: ["chat", "--help"], preflight: "Options:\n      --list-models  List the available models\n      --format <FORMAT>  Output format\n",
    },
    {
      driver: "muse", binary: "muse", args: ["exec", "--list-models"], stdout: "muse-1\n", expected: ["muse-1"], helpArgs: ["exec", "--help"],
      preflight: "Options:\n  --list-models  List available models\n",
    },
  ];

  it.each(LISTING_CASES)("runs exactly the verified listing command for $driver", async ({ driver, binary, args, stdout, expected, helpArgs, preflight }) => {
    const absolute = installBinary(binary);
    const { exec, requests: all } = recorder(...(preflight === undefined ? [] : [{ stdout: preflight }]), { stdout });
    const result = await probeCliModels(makeInput(driver, binary, exec));
    // A capability check (the help of the CLI) may run first; the listing itself is always the last, exact command.
    expect(all).toHaveLength(preflight === undefined ? 1 : 2);
    if (preflight !== undefined) expect(all[0].args).toEqual(helpArgs);
    const requests = all.slice(-1);
    expect(requests[0]).toMatchObject({
      command: absolute,
      args,
      timeoutMs: 1234,
      stdoutLimitBytes: DISCOVERY_STDOUT_LIMIT_BYTES,
      stderrLimitBytes: DISCOVERY_STDERR_LIMIT_BYTES,
    });
    // Every command of a probe runs in its own scratch directory, never in the caller's working directory.
    for (const request of all) expect(request.cwd).not.toBe(root);
    expect(requests[0].env).toEqual({ PATH: binDir, HOME: root, NO_COLOR: "1" });
    expect(requests[0].args).not.toContain("--dangerous");
    expect(ids(result.models)).toEqual(expected);
    expect(result.diagnostics).toEqual([]);
    expect(result.models[0]).toMatchObject({ availability: "reported_available", evidence: "cli_listing" });
  });

  it("identifies Vercel fx through --help before listing", async () => {
    const absolute = installBinary("fx");
    const { exec, requests } = recorder(
      { stdout: "Usage: fx ask <prompt>\n  fx acp\n" },
      { stdout: JSON.stringify({ ids: ["openai/gpt-5"] }) },
    );
    const result = await probeCliModels(makeInput("fx", "fx", exec));
    expect(requests.map((request) => [request.command, request.args])).toEqual([
      [absolute, ["--help"]],
      [absolute, ["models", "--json"]],
    ]);
    expect(ids(result.models)).toEqual(["openai/gpt-5"]);
  });

  it("does not run `models --json` when the fx binary is the JSON viewer", async () => {
    installBinary("fx");
    const { exec, requests } = recorder({ stdout: "fx - terminal JSON viewer\nUsage: fx [file]\n" });
    const result = await probeCliModels(makeInput("fx", "fx", exec));
    expect(requests).toHaveLength(1);
    expect(result.models).toEqual([]);
    expect(result.diagnostics).toEqual([{ stage: "probe", code: "unsupported_version", message: "binary is not Vercel fx" }]);
  });

  it("never runs a subprocess for drivers without a verified listing command", async () => {
    for (const driver of ["claude", "codex", "dsh", "droid", "qwen", "kimi", "vibe", "copilot"] as const) {
      installBinary(driver);
      const exec = vi.fn<ExecProbe>();
      const result = await probeCliModels(makeInput(driver, driver, exec));
      expect(exec).not.toHaveBeenCalled();
      expect(result).toEqual({
        models: [],
        diagnostics: [{ stage: "probe", code: "scope_unknown", message: `${driver} has no verified model-listing command` }],
        truncated: false,
      });
    }
  });

  it("reports binary_missing without calling the runner", async () => {
    const exec = vi.fn<ExecProbe>();
    const result = await probeCliModels(makeInput("pi", "pi-not-installed", exec));
    expect(exec).not.toHaveBeenCalled();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["binary_missing"]);
  });

  it("does not search the real PATH when the injected environment has none", async () => {
    const exec = vi.fn<ExecProbe>();
    const result = await probeCliModels({ ...makeInput("pi", "node", exec), env: {} });
    expect(exec).not.toHaveBeenCalled();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["binary_missing"]);
  });

  it("maps runner flags and exit codes to diagnostics and never parses their output", async () => {
    installBinary("opencode");
    const stdout = "openai/gpt-5\n";
    const cases: ReadonlyArray<[Partial<ProbeRunResult>, string]> = [
      [{ spawnFailed: true, exitCode: null }, "binary_missing"],
      [{ timedOut: true, exitCode: null, stdout }, "timeout"],
      [{ cancelled: true, exitCode: null, stdout }, "cancelled"],
      [{ outputLimitExceeded: true, exitCode: null, stdout }, "output_limit"],
      [{ exitCode: 2, stdout }, "unsupported_version"],
      [{ exitCode: null, stdout }, "unsupported_version"],
      [{ exitCode: 0, stdout: "only prose here\n" }, "invalid_output"],
    ];
    for (const [overrides, code] of cases) {
      const result = await probeCliModels(makeInput("opencode", "opencode", recorder({ stdout: OPENCODE_HELP }, overrides).exec));
      expect(result.models).toEqual([]);
      expect(result.diagnostics.map((diagnostic) => [diagnostic.stage, diagnostic.code])).toEqual([["probe", code]]);
      expect(result.diagnostics[0].message).not.toContain("openai/gpt-5");
      expect(result.diagnostics[0].message).not.toContain("only prose");
    }
  });

  it("returns an empty observation without a diagnostic for a successful empty listing", async () => {
    installBinary("muse");
    expect(await probeCliModels(makeInput("muse", "muse", recorder({ stdout: MUSE_HELP }, { stdout: "  \n" }).exec)))
      .toEqual({ models: [], diagnostics: [], truncated: false });
  });

  it("keeps a short redacted stderr tail without URLs or ANSI codes on a nonzero exit", async () => {
    installBinary("gemini");
    const stderr = `${ESC}[31mfatal${ESC}[0m: ${"x".repeat(500)} Bearer abcdef123456 see https://user:pw@host.example/path?token=zzz end\n`;
    const result = await probeCliModels(makeInput("gemini", "gemini", recorder({ exitCode: 1, stderr, stdout: "RAW-STDOUT" }).exec));
    const [diagnostic] = result.diagnostics;
    expect(diagnostic.code).toBe("unsupported_version");
    expect(diagnostic.message).toContain("exited with code 1");
    expect(diagnostic.message).not.toContain("abcdef123456");
    expect(diagnostic.message).not.toContain("user:pw");
    expect(diagnostic.message).not.toContain("token=zzz");
    expect(diagnostic.message).not.toContain("RAW-STDOUT");
    expect(diagnostic.message).not.toContain(ESC);
    expect(diagnostic.message!.length).toBeLessThan(300);
  });

  it("caps the models of one source and reports truncation", async () => {
    installBinary("muse");
    const stdout = Array.from({ length: MAX_MODELS_PER_SOURCE + 50 }, (_, index) => `model-${index}`).join("\n");
    const result = await probeCliModels(makeInput("muse", "muse", recorder({ stdout: MUSE_HELP }, { stdout }).exec));
    expect(result.models).toHaveLength(MAX_MODELS_PER_SOURCE);
    expect(result.truncated).toBe(true);
  });

  it("does not run when the signal is already aborted, and never throws when the runner throws", async () => {
    installBinary("muse");
    const exec = vi.fn<ExecProbe>();
    const controller = new AbortController();
    controller.abort();
    const aborted = await probeCliModels(makeInput("muse", "muse", exec, { signal: controller.signal }));
    expect(exec).not.toHaveBeenCalled();
    expect(aborted.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["cancelled"]);

    const throwing: ExecProbe = async () => { throw new Error("boom"); };
    const failed = await probeCliModels(makeInput("muse", "muse", throwing));
    expect(failed.models).toEqual([]);
    expect(failed.diagnostics).toHaveLength(1);
    expect(failed.diagnostics[0].stage).toBe("probe");
  });
});

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    // An unreaped zombie cannot execute.
    return !readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").startsWith("Z");
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, waitMs = 3_000): Promise<boolean> {
  const deadline = performance.now() + waitMs;
  while (!condition()) {
    if (performance.now() >= deadline) return false;
    await setTimeout(20);
  }
  return true;
}

describe.skipIf(process.platform === "win32")("defaultExecProbe (real processes)", () => {
  let root: string;
  const spawnedPids: number[] = [];

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "orch-discovery-exec-")); });
  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function script(name: string, body: string): string {
    const path = join(root, name);
    writeFileSync(path, `#!${process.execPath}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function request(command: string, overrides: Partial<ProbeRunRequest> = {}): ProbeRunRequest {
    return {
      command,
      args: [],
      env: buildProbeEnv(process.env, "pi"),
      cwd: root,
      timeoutMs: 5_000,
      stdoutLimitBytes: 64 * 1024,
      stderrLimitBytes: 64 * 1024,
      ...overrides,
    };
  }

  async function readPid(path: string): Promise<number> {
    expect(await waitUntil(() => existsSync(path))).toBe(true);
    const pid = Number(readFileSync(path, "utf8"));
    spawnedPids.push(pid);
    return pid;
  }

  it("captures stdout, stderr, and the exit code", async () => {
    const command = script("ok", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3);");
    expect(await defaultExecProbe(request(command))).toEqual({
      exitCode: 3, stdout: "out", stderr: "err", timedOut: false, cancelled: false, outputLimitExceeded: false,
    });
  });

  it("ignores stdin so a reader gets EOF immediately", async () => {
    const command = script("stdin", "process.stdin.on('data', () => {}); process.stdin.on('end', () => { console.log('eof'); });");
    const result = await defaultExecProbe(request(command, { timeoutMs: 3_000 }));
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe("eof");
  });

  it("does not interpret shell metacharacters in arguments", async () => {
    const command = script("argv", "console.log(JSON.stringify(process.argv.slice(2)));");
    const args = ["$(touch PWNED)", ";touch PWNED2", "`touch PWNED3`", "a b|c"];
    const result = await defaultExecProbe(request(command, { args }));
    expect(JSON.parse(result.stdout)).toEqual(args);
    for (const marker of ["PWNED", "PWNED2", "PWNED3"]) expect(existsSync(join(root, marker))).toBe(false);
  });

  it("does not expose parent secrets when given the probe environment", async () => {
    vi.stubEnv("SECRET_TOKEN", "super-secret-value");
    vi.stubEnv("NODE_OPTIONS", "--no-warnings");
    const command = script("env", "console.log(JSON.stringify({ secret: process.env.SECRET_TOKEN ?? null, nodeOptions: process.env.NODE_OPTIONS ?? null, noColor: process.env.NO_COLOR, job: process.env.ORCH_JOB_ID }));");
    const result = await defaultExecProbe(request(command));
    const seen = JSON.parse(result.stdout) as Record<string, string | null>;
    expect(seen.secret).toBeNull();
    expect(seen.nodeOptions).toBeNull();
    expect(seen.noColor).toBe("1");
    expect(seen.job).toMatch(/^probe-[0-9a-f-]{36}$/);
  });

  it("terminates the whole process tree on timeout", async () => {
    const pidFile = join(root, "grandchild.pid");
    const command = script("tree", [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: true });",
      `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      "setTimeout(() => {}, 60000);",
    ].join("\n"));
    const started = performance.now();
    const result = await defaultExecProbe(request(command, { timeoutMs: 1_000 }));
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(performance.now() - started).toBeLessThan(4_000);
    const grandchildPid = await readPid(pidFile);
    expect(await waitUntil(() => !isLive(grandchildPid))).toBe(true);
  });

  it("cancels on abort and removes nothing but its own process", async () => {
    const pidFile = join(root, "child.pid");
    const command = script("sleeper", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`);
    const controller = new AbortController();
    const pending = defaultExecProbe(request(command, { signal: controller.signal }));
    const childPid = await readPid(pidFile);
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(await waitUntil(() => !isLive(childPid))).toBe(true);
  });

  it("does not spawn when the signal is already aborted", async () => {
    const marker = join(root, "ran");
    const command = script("never", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, "x");`);
    const result = await defaultExecProbe(request(command, { signal: AbortSignal.abort() }));
    expect(result.cancelled).toBe(true);
    await setTimeout(150);
    expect(existsSync(marker)).toBe(false);
  });

  it("stops a process that floods stdout and bounds what it returns", async () => {
    const pidFile = join(root, "flood.pid");
    const command = script("flood", [
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => process.stdout.write('model-line-xxxxxxxxxxxxxxxx\\n'.repeat(500)), 5);",
    ].join("\n"));
    const result = await defaultExecProbe(request(command, { stdoutLimitBytes: 1_000, timeoutMs: 5_000 }));
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stdout.length).toBeLessThanOrEqual(1_000);
    expect(result.stdout.length).toBeGreaterThan(0);
    // The clipped output never ends in a half-written line.
    expect(result.stdout.endsWith("\n") || /model-line-x{16}$/.test(result.stdout)).toBe(true);
    const pid = await readPid(pidFile);
    expect(await waitUntil(() => !isLive(pid))).toBe(true);
  });

  it("bounds stderr independently", async () => {
    const command = script("noisy", "setInterval(() => process.stderr.write('e'.repeat(4096)), 5);");
    const result = await defaultExecProbe(request(command, { stderrLimitBytes: 2_000 }));
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stderr.length).toBeLessThanOrEqual(2_000);
  });

  it("returns promptly and reaps a background process that keeps the pipes open after the main process exited", async () => {
    const pidFile = join(root, "background.pid");
    const command = script("daemonize", [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const background = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });",
      `writeFileSync(${JSON.stringify(pidFile)}, String(background.pid));`,
      "background.unref();",
      "process.stdout.write('listed');",
    ].join("\n"));
    const started = performance.now();
    const result = await defaultExecProbe(request(command, { timeoutMs: 10_000 }));
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(result).toMatchObject({ exitCode: 0, stdout: "listed", timedOut: false });
    const pid = await readPid(pidFile);
    expect(await waitUntil(() => !isLive(pid))).toBe(true);
  });

  it("reports spawnFailed for a missing or non-executable command and never throws", async () => {
    const missing = await defaultExecProbe(request(join(root, "does-not-exist")));
    expect(missing).toMatchObject({ spawnFailed: true, exitCode: null, timedOut: false, cancelled: false });
    const plain = join(root, "plain.txt");
    writeFileSync(plain, "not executable");
    expect(await defaultExecProbe(request(plain))).toMatchObject({ spawnFailed: true });
    expect(await defaultExecProbe(request(join(root, "x"), { cwd: join(root, "no-such-dir") }))).toMatchObject({ spawnFailed: true });
  });
});
