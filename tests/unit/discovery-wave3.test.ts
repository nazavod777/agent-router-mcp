/**
 * Regression tests for the Wave 3 review findings on model discovery: probe launch and scratch directory, help-gated listing
 * commands, reaping, enrichment isolation between harnesses, sanitizing, and the shared offline deadline.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProbeEnv, defaultExecProbe, parseCursorOutput, parseGeminiOutput, probeCliModels } from "../../src/discovery/cli-probes.js";
import {
  applyDiscovery, buildCandidates, discoverModels, mergeDiscoveredModels, offlineDiscoveryHints, previewDiscovery,
  type CliProbeInput, type DiscoveredModel, type DiscoveryDeps, type ExecProbe, type HarnessDiscoveryResult, type ProbeRunRequest, type ProbeRunResult,
} from "../../src/discovery/index.js";
import { compareText, harnessKeyTag } from "../../src/discovery/enrich.js";
import { scrubDiscoveryText } from "../../src/discovery/sanitize.js";
import type { DriverKind } from "../../src/drivers.js";
import { FIXED_NOW, fakeDeps, listed, makeWorld, observation, type DiscoveryWorld } from "./helpers/discovery-fixture.js";

const fakeResult = (overrides: Partial<ProbeRunResult> = {}): ProbeRunResult =>
  ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false, ...overrides });

function resultOf(harness: string, driver: DriverKind, models: DiscoveredModel[]): HarnessDiscoveryResult {
  return { harness, driver, observed_at: FIXED_NOW.toISOString(), status: "ok", models, diagnostics: [], truncated: false };
}

// ---------------------------------------------------------------------------
// Probes: launch, scratch directory, help gate, reaping
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("CLI probes (Wave 3)", () => {
  let root: string;
  let binDir: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orch-discovery-w3-"));
    binDir = join(root, "bin");
    repo = join(root, "repo");
    mkdirSync(binDir);
    mkdirSync(repo);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function install(path: string, mode = 0o755): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, mode);
    return path;
  }

  function input(driver: DriverKind, binary: string, execProbe: ExecProbe, extra: Partial<CliProbeInput> = {}): CliProbeInput {
    return {
      cwd: repo, env: { PATH: binDir, HOME: root }, homeDir: root, platform: process.platform, harnessId: driver,
      harness: { driver, display_name: driver, binary, enabled: true }, driver, discovery: "native", execProbe, probeTimeoutMs: 1000, ...extra,
    };
  }

  function recorder(...results: Partial<ProbeRunResult>[]): { exec: ExecProbe; requests: ProbeRunRequest[] } {
    const requests: ProbeRunRequest[] = [];
    const queue = [...results];
    return { requests, exec: async (request) => { requests.push(request); return fakeResult(queue.shift() ?? {}); } };
  }

  describe("A: the binary is resolved without the caller's working directory and a Windows shim is unwrapped", () => {
    it("does not run a relative binary that exists only in the caller's working directory", async () => {
      install(join(repo, "wrap"));
      const { exec, requests } = recorder({ stdout: "provider model context max-out thinking images\nacme a-1 64K 8K yes no\n" });
      const observed = await probeCliModels(input("pi", "./wrap", exec));
      expect(requests).toEqual([]);
      expect(observed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["binary_missing"]);
    });

    it("resolves a relative binary against the user config directory", async () => {
      const wrapper = install(join(root, ".config", "orchestrator-mcp", "wrap"));
      const { exec, requests } = recorder({ stdout: "provider model context max-out thinking images\nacme a-1 64K 8K yes no\n" });
      const observed = await probeCliModels(input("pi", "./wrap", exec));
      expect(requests.map((request) => request.command)).toEqual([wrapper]);
      expect(observed.models.map((model) => model.cli_model)).toEqual(["a-1"]);
    });

    it("follows ORCH_MODELS_PATH when it moves the config directory", async () => {
      const wrapper = install(join(root, "custom-config", "tools", "wrap"));
      const { exec, requests } = recorder({ stdout: "provider model context max-out thinking images\nacme a-1 64K 8K yes no\n" });
      const env = { PATH: binDir, HOME: root, ORCH_MODELS_PATH: join(root, "custom-config", "models.toml") };
      await probeCliModels(input("pi", "tools/wrap", exec, { env }));
      expect(requests.map((request) => request.command)).toEqual([wrapper]);
    });

    it("spawns an npm .cmd shim on Windows as node plus its script, for the help and the listing alike", async () => {
      const script = join(binDir, "node_modules", "opencode-ai", "bin", "opencode.js");
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, "// entry\n");
      writeFileSync(join(binDir, "opencode.cmd"), [
        "@ECHO off", "SETLOCAL", 'SET "_prog=node"',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.js" %*',
      ].join("\r\n"));
      chmodSync(join(binDir, "opencode.cmd"), 0o755);
      const { exec, requests } = recorder({ stdout: "Commands:\n  opencode models [provider]  list models\n" }, { stdout: "p/m-1\n" });
      const env = { PATH: binDir, PATHEXT: ".CMD", HOME: root };
      const observed = await probeCliModels(input("opencode", "opencode", exec, { platform: "win32", env }));
      expect(requests.map((request) => [request.command, request.args])).toEqual([
        [process.execPath, [script, "--help"]],
        [process.execPath, [script, "models"]],
      ]);
      expect(observed.models.map((model) => model.cli_model)).toEqual(["m-1"]);
    });

    it("reports binary_missing, and spawns nothing, for a .cmd launcher that is not an npm JavaScript shim", async () => {
      writeFileSync(join(binDir, "opencode.cmd"), "@echo off\r\nsome-native-thing.exe %*\r\n");
      chmodSync(join(binDir, "opencode.cmd"), 0o755);
      const exec = vi.fn<ExecProbe>();
      const observed = await probeCliModels(input("opencode", "opencode", exec, { platform: "win32", env: { PATH: binDir, PATHEXT: ".CMD", HOME: root } }));
      expect(exec).not.toHaveBeenCalled();
      expect(observed.diagnostics).toEqual([expect.objectContaining({ stage: "probe", code: "binary_missing", message: expect.stringContaining(".cmd/.bat") })]);
    });
  });

  describe("B: every probe command runs in its own empty scratch directory", () => {
    it("runs the help and the listing in one existing empty directory that is not the caller's, and removes it afterwards", async () => {
      mkdirSync(join(repo, ".gemini"));
      writeFileSync(join(repo, ".gemini", "settings.json"), "{}");
      install(join(binDir, "gemini"));
      const seen: Array<{ cwd: string; existed: boolean; entries: string[] }> = [];
      const queue = [{ stdout: "Commands:\n  gemini models list  List models\n" }, { stdout: JSON.stringify([{ modelId: "g-1" }]) }];
      const exec: ExecProbe = async (request) => {
        seen.push({ cwd: request.cwd, existed: existsSync(request.cwd), entries: existsSync(request.cwd) ? readdirSync(request.cwd) : ["<missing>"] });
        return fakeResult(queue.shift());
      };
      const observed = await probeCliModels(input("gemini", "gemini", exec));
      expect(observed.models.map((model) => model.cli_model)).toEqual(["g-1"]);
      expect(seen).toHaveLength(2);
      expect(new Set(seen.map((entry) => entry.cwd)).size).toBe(1);
      expect(seen[0].cwd).not.toBe(repo);
      expect(seen[0].cwd.startsWith(tmpdir())).toBe(true);
      for (const entry of seen) expect(entry).toMatchObject({ existed: true, entries: [] });
      expect(existsSync(seen[0].cwd)).toBe(false);
      expect(existsSync(join(repo, ".gemini", "settings.json"))).toBe(true);
    });

    it.each<[string, ExecProbe]>([
      ["the runner throws", async () => { throw new Error("boom"); }],
      ["the probe is cancelled", async () => fakeResult({ cancelled: true, exitCode: null })],
      ["the command cannot be started", async () => fakeResult({ spawnFailed: true, exitCode: null })],
    ])("removes the scratch directory when %s", async (_name, behaviour) => {
      install(join(binDir, "muse"));
      let scratch: string | undefined;
      const exec: ExecProbe = async (request) => { scratch = request.cwd; return behaviour(request); };
      await probeCliModels(input("muse", "muse", exec));
      expect(scratch).toBeDefined();
      expect(existsSync(scratch as string)).toBe(false);
    });

    it("creates no scratch directory when the binary is missing or the signal is already aborted", async () => {
      // A private TMPDIR keeps other test files (running in parallel) out of the directory listing.
      const privateTmp = mkdtempSync(join(tmpdir(), "orch-private-tmp-"));
      const previousTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = privateTmp;
      try {
        await probeCliModels(input("muse", "muse", vi.fn<ExecProbe>()));
        install(join(binDir, "muse"));
        await probeCliModels(input("muse", "muse", vi.fn<ExecProbe>(), { signal: AbortSignal.abort() }));
        expect(readdirSync(privateTmp)).toEqual([]);
      } finally {
        if (previousTmpdir === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmpdir;
        rmSync(privateTmp, { recursive: true, force: true });
      }
    });
  });

  describe("C: a listing command runs only when the help advertises it in the right section", () => {
    const GEMINI_HELP_WITH_MODELS_OPTION = [
      "Usage: gemini [options] [command]", "", "Options:", "  models    Choose models  [string]", "",
      "Commands:", "  gemini mcp  Manage MCP servers", "  gemini [query..]  Launch Gemini CLI  [default]",
    ].join("\n");

    it("does not take an `models` entry of the Options section for a models subcommand (Gemini)", async () => {
      install(join(binDir, "gemini"));
      const { exec, requests } = recorder({ stdout: GEMINI_HELP_WITH_MODELS_OPTION });
      const observed = await probeCliModels(input("gemini", "gemini", exec));
      expect(requests.map((request) => request.args)).toEqual([["--help"]]);
      expect(observed.diagnostics).toEqual([expect.objectContaining({ code: "scope_unknown" })]);
    });

    const CASES: ReadonlyArray<{
      driver: DriverKind; binary: string; helpArgs: string[]; listingArgs: string[]; advertised: string; notAdvertised: string[]; stdout: string; expected: string;
    }> = [
      {
        driver: "opencode", binary: "opencode", helpArgs: ["--help"], listingArgs: ["models"], stdout: "p/m-1\n", expected: "m-1",
        advertised: "Commands:\n  opencode models [provider]  list all available models\n",
        notAdvertised: ["Usage: opencode [command]\n\nOptions:\n  --model  Pick one of the models\nRun opencode models to list them\n"],
      },
      {
        driver: "antigravity", binary: "agy", helpArgs: ["--help"], listingArgs: ["models"], stdout: "agy-high\n", expected: "agy-high",
        advertised: "Commands:\n  agy models  List available models\n",
        notAdvertised: ["Usage: agy [prompt..]\n\nCommands:\n  agy login  Log in\n        models are managed in the console\n"],
      },
      {
        driver: "grok", binary: "grok", helpArgs: ["--help"], listingArgs: ["models"], stdout: "Available models:\n* grok-4 (default)\n", expected: "grok-4",
        advertised: "USAGE:\n  grok [OPTIONS] [prompt]\n\nSUBCOMMANDS:\n  models  List available models\n",
        notAdvertised: ["Usage: grok [options] [prompt]\n\nOptions:\n  -m, --model <id>  Model to use\n\nCommands:\n  login  Sign in\n"],
      },
      {
        driver: "cursor", binary: "cursor-agent", helpArgs: ["--help"], listingArgs: ["models"], stdout: "auto - Auto\n", expected: "auto",
        advertised: "Commands:\n  agent [options] [prompt...]  Start the Cursor Agent\n  models|ls  List available models\n",
        notAdvertised: ["Usage: cursor-agent [options] [command] [prompt...]\n\nCommands:\n  agent  Start models of the agent\n  login\n"],
      },
      {
        driver: "kiro", binary: "kiro-cli", helpArgs: ["chat", "--help"], listingArgs: ["chat", "--list-models", "--format", "json"], stdout: JSON.stringify(["auto"]), expected: "auto",
        advertised: "Options:\n      --list-models  List the available models\n      --format <FORMAT>  Output format\n",
        notAdvertised: ["Usage: kiro-cli chat [OPTIONS] [INPUT]\n\nOptions:\n      --format <FORMAT>  Output format; see --list-models in the docs\n\nCommands:\n  --list-models  not an option\n"],
      },
      {
        driver: "muse", binary: "muse", helpArgs: ["exec", "--help"], listingArgs: ["exec", "--list-models"], stdout: "muse-1\n", expected: "muse-1",
        advertised: "Options:\n  -l, --list-models  List available models\n",
        notAdvertised: ["Usage: muse exec [prompt]\n\nOptions:\n  --model <id>  Pick a model\n\nRun muse exec --list-models someday\n"],
      },
    ];

    it.each(CASES)("runs the $driver listing after a help that advertises it", async ({ driver, binary, helpArgs, listingArgs, advertised, stdout, expected }) => {
      install(join(binDir, binary));
      const { exec, requests } = recorder({ stdout: advertised }, { stdout });
      const observed = await probeCliModels(input(driver, binary, exec));
      expect(requests.map((request) => request.args)).toEqual([helpArgs, listingArgs]);
      expect(observed.models.map((model) => model.cli_model)).toEqual([expected]);
      expect(observed.diagnostics).toEqual([]);
    });

    it.each(CASES.flatMap((entry) => entry.notAdvertised.map((help) => ({ ...entry, help }))))(
      "never runs the $driver listing when the help does not advertise it (it would be sent as a prompt)",
      async ({ driver, binary, helpArgs, listingArgs, help }) => {
        install(join(binDir, binary));
        const { exec, requests } = recorder({ stdout: help }, { stdout: "should-not-be-read\n" });
        const observed = await probeCliModels(input(driver, binary, exec));
        expect(requests.map((request) => request.args)).toEqual([helpArgs]);
        expect(requests.some((request) => request.args.join(" ") === listingArgs.join(" "))).toBe(false);
        expect(observed.models).toEqual([]);
        expect(observed.diagnostics).toEqual([expect.objectContaining({ stage: "probe", code: "scope_unknown" })]);
      });

    it.each(CASES)("stops at a failing help for $driver without running the listing", async ({ driver, binary }) => {
      install(join(binDir, binary));
      const { exec, requests } = recorder({ exitCode: 2, stderr: "unknown command" });
      const observed = await probeCliModels(input(driver, binary, exec));
      expect(requests).toHaveLength(1);
      expect(observed.diagnostics).toEqual([expect.objectContaining({ code: "unsupported_version" })]);
    });

    it("keeps Pi's flag fallback and runs no help for it", async () => {
      install(join(binDir, "pi"));
      const { exec, requests } = recorder({ exitCode: 1, stderr: "Error: Unknown option: --no-approve" }, { stdout: "provider model context max-out thinking images\nacme a-1 64K 8K yes no\n" });
      await probeCliModels(input("pi", "pi", exec));
      expect(requests.map((request) => request.args)).toEqual([
        ["--no-extensions", "--no-mcp", "--no-approve", "--offline", "--list-models"], ["--no-extensions", "--no-mcp", "--list-models"],
      ]);
    });
  });
});

describe.skipIf(process.platform !== "linux")("defaultExecProbe reaps a detached grandchild after a clean exit (F)", () => {
  let root: string;
  const spawned: number[] = [];
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "orch-discovery-w3-exec-")); });
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  });

  const isLive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return !readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").startsWith("Z");
    } catch { return false; }
  };
  async function waitUntil(condition: () => boolean, waitMs = 3_000): Promise<boolean> {
    const deadline = performance.now() + waitMs;
    while (!condition()) {
      if (performance.now() >= deadline) return false;
      await setTimeout(20);
    }
    return true;
  }

  it("kills a setsid-detached grandchild that holds no pipe and no process group of the probe", async () => {
    const pidFile = join(root, "grandchild.pid");
    const command = join(root, "leaves-a-daemon");
    writeFileSync(command, [
      `#!${process.execPath}`,
      "const { spawn } = require('node:child_process');",
      // A new session (setsid), no inherited pipes: it inherits only the environment, with the ORCH_JOB_ID marker.
      "const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', detached: true });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(daemon.pid));`,
      "daemon.unref();",
      "console.log('listed');",
    ].join("\n"));
    chmodSync(command, 0o755);
    const result = await defaultExecProbe({
      command, args: [], env: buildProbeEnv(process.env, "pi"), cwd: root, timeoutMs: 10_000, stdoutLimitBytes: 65_536, stderrLimitBytes: 65_536,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "listed\n", timedOut: false });
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    spawned.push(pid);
    expect(await waitUntil(() => !isLive(pid))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enrichment: card validity and independent harnesses
// ---------------------------------------------------------------------------

describe("G: one unusable discovered model cannot abort a batch", () => {
  let world: DiscoveryWorld | undefined;
  afterEach(() => {
    if (world) rmSync(world.root, { recursive: true, force: true });
    world = undefined;
  });

  const OPTIONS = { mode: "offline" as const, providers: "configured" as const, harness: "pi" };

  it("drops a vendor family longer than 64 characters instead of proposing a card the config would refuse", async () => {
    const w = (world = makeWorld());
    const longProvider = "p".repeat(200);
    const deps = fakeDeps({ pi: [listed("good-one", { cli_provider: "acme" }), listed("long-provider-model", { cli_provider: longProvider }), listed("good-two", { cli_provider: "acme" })] });
    const preview = await previewDiscovery(w.snapshot(), { ...OPTIONS, ...w.environment }, deps);
    const long = preview.candidates.find((candidate) => candidate.discovered.cli_model === "long-provider-model");
    expect(long?.action).toBe("import");
    expect(long?.proposed_model?.vendor_family).toBeUndefined();

    const result = await applyDiscovery(w.manager, w.writer, { ...OPTIONS, ...w.environment }, { allNew: true }, deps);
    expect([...result.imported].sort()).toEqual(["good-one", "good-two", "long-provider-model"]);
    expect(w.snapshot().models["long-provider-model"].vendor_family).toBeUndefined();
    expect(w.snapshot().config_warnings).toEqual([]);
  });

  it("leaves out a model whose card would not validate, says so, and still imports the others", async () => {
    const w = (world = makeWorld());
    const deps = fakeDeps({ pi: [listed("bad-context", { cli_provider: "acme", context_window: 1.5 }), listed("fine-model", { cli_provider: "acme" })] });
    const preview = await previewDiscovery(w.snapshot(), { ...OPTIONS, ...w.environment }, deps);
    expect(preview.candidates.map((candidate) => candidate.discovered.cli_model)).toEqual(["fine-model"]);
    expect(preview.harnesses.find((entry) => entry.harness === "pi")?.diagnostics).toEqual([
      { stage: "offline", code: "invalid_output", message: "1 model(s) skipped: no valid model entry can be built for them." },
    ]);
    const result = await applyDiscovery(w.manager, w.writer, { ...OPTIONS, ...w.environment }, { allNew: true }, deps);
    expect(result.imported).toEqual(["fine-model"]);
  });
});

describe("H: harnesses are independent of each other", () => {
  let world: DiscoveryWorld | undefined;
  afterEach(() => {
    if (world) rmSync(world.root, { recursive: true, force: true });
    world = undefined;
  });

  const SHARED = [listed("shared-model", { cli_provider: "acme" })];

  it("proposes the same ID and key for a harness whether another harness succeeded or came back empty", () => {
    const w = (world = makeWorld());
    const config = w.snapshot();
    const build = (first: DiscoveredModel[]) => buildCandidates({
      config, providers: "configured", now: FIXED_NOW, results: [resultOf("pi", "pi", first), resultOf("pi-alt", "pi", SHARED)],
    });
    const second = (built: ReturnType<typeof build>) => built.candidates.find((candidate) => candidate.harness === "pi-alt");
    const withFirst = second(build(SHARED));
    const withoutFirst = second(build([]));
    expect(withFirst?.proposed_id).toBe("shared-model");
    expect(withoutFirst?.proposed_id).toBe(withFirst?.proposed_id);
    expect(withoutFirst?.key).toBe(withFirst?.key);
    expect(withFirst?.key.slice(0, 4)).toBe(harnessKeyTag("pi-alt"));
  });

  it("re-probes only the harness a selected key belongs to", async () => {
    const w = (world = makeWorld());
    const deps = fakeDeps({}, { pi: SHARED, "pi-alt": [listed("alt-only", { cli_provider: "acme" })], claude: [listed("claude-new-x")] });
    const options = { mode: "on_demand" as const, providers: "configured" as const, ...w.environment };
    const preview = await previewDiscovery(w.snapshot(), options, deps);
    expect(new Set(deps.probeCalls).size).toBeGreaterThan(3);
    const key = preview.candidates.find((candidate) => candidate.harness === "pi-alt")?.key as string;

    deps.probeCalls.splice(0);
    deps.localCalls.splice(0);
    const result = await applyDiscovery(w.manager, w.writer, options, { select: [key] }, deps);
    expect(result.imported).toEqual(["alt-only"]);
    expect(deps.probeCalls).toEqual(["pi-alt"]);
    expect(deps.localCalls).toEqual(["pi-alt"]);
  });

  it("still probes every harness for --all-new, and rejects a key that matches no harness as stale", async () => {
    const w = (world = makeWorld());
    const deps = fakeDeps({}, { pi: SHARED, claude: [listed("claude-new-x")] });
    const options = { mode: "on_demand" as const, providers: "configured" as const, ...w.environment };
    await applyDiscovery(w.manager, w.writer, options, { allNew: true }, deps);
    expect(new Set(deps.probeCalls)).toEqual(new Set(["claude", "pi", "pi-alt", "opencode", "dsh", "gemini", "cursor"]));
    deps.probeCalls.splice(0);
    await expect(applyDiscovery(w.manager, w.writer, options, { select: ["0123456789abcdef"] }, deps)).rejects.toThrow(/stale or unknown/);
    await expect(applyDiscovery(w.manager, w.writer, options, { select: ["zz"] }, deps)).rejects.toThrow(/stale or unknown/);
  });

  it("never lets two harnesses silently overwrite each other when both propose the same ID", async () => {
    const w = (world = makeWorld());
    const deps = fakeDeps({}, { pi: SHARED, "pi-alt": SHARED });
    const options = { mode: "on_demand" as const, providers: "configured" as const, ...w.environment };
    const preview = await previewDiscovery(w.snapshot(), options, deps);
    const keys = preview.candidates.filter((candidate) => candidate.proposed_id === "shared-model").map((candidate) => candidate.key);
    expect(keys).toHaveLength(2);
    await expect(applyDiscovery(w.manager, w.writer, options, { select: keys }, deps)).rejects.toThrow(/both propose the model ID "shared-model"/);
    expect(w.snapshot().models["shared-model"]).toBeUndefined();

    const batch = await applyDiscovery(w.manager, w.writer, options, { allNew: true }, deps);
    expect(batch.imported).toEqual(["shared-model"]);
    expect(batch.remaining_new).toBe(1);
    expect(w.snapshot().models["shared-model"].harness).toBe("pi");
    // The deferred one gets a different ID on the next preview, because the first ID is now taken.
    const next = await previewDiscovery(w.snapshot(), options, deps);
    const deferred = next.candidates.find((candidate) => candidate.harness === "pi-alt" && candidate.action === "import");
    expect(deferred?.proposed_id).toBe("pi-alt-shared-model");
  });

  it("orders ids by code unit, not by locale", () => {
    const models = ["b-1", "B-2", "a-3", "Z-4", "é-5"].map((id) => listed(id));
    expect(mergeDiscoveredModels("claude", {}, models).map((model) => model.cli_model)).toEqual(["B-2", "Z-4", "a-3", "b-1", "é-5"]);
    expect(["b", "B", "a", "Z", "é"].sort(compareText)).toEqual(["B", "Z", "a", "b", "é"]);
    expect(compareText("a", "a")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

describe("I: URLs shrink to their origin and hidden characters disappear", () => {
  it("keeps only scheme://host[:port] of every URL in text", () => {
    expect(scrubDiscoveryText("see https://user:pw@api.example.com:8443/v2/KEYINPATH/models?x=1#frag now")).toBe("see https://api.example.com:8443 now");
    expect(scrubDiscoveryText("a http://h.example/p and b https://i.example/q?token=zzz")).toBe("a http://h.example and b https://i.example");
    expect(scrubDiscoveryText("broken https:// url and file:///etc/passwd")).toBe("broken https:// url and <url>");
  });

  it("strips bidi controls and zero-width characters, before looking for URLs", () => {
    const hidden = "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2060\u2066\u2067\u2068\u2069\ufeff";
    expect(scrubDiscoveryText(`Ev${hidden}il`)).toBe("Evil");
    expect(scrubDiscoveryText("https\u200b://user:pw@evil.example/KEY")).toBe("https://evil.example");
  });

  it("applies both rules to probe display names and drops ids that carry a hidden character", () => {
    const gemini = parseGeminiOutput(JSON.stringify([
      { modelId: "gemini-a", displayName: "Gem\u202eini\u200b A https://k:s@h.example/v1/KEY" },
      { modelId: "gemini\u200b-b", displayName: "hidden id" },
    ]));
    expect(gemini.map((model) => [model.cli_model, model.display_name])).toEqual([["gemini-a", "Gemini A https://h.example"]]);
    const cursor = parseCursorOutput("auto - Au\u2066to\u2069 Router\nplain - Plain\n");
    expect(cursor.map((model) => model.display_name)).toEqual(["Auto Router", "Plain"]);
  });
});

// ---------------------------------------------------------------------------
// One shared offline deadline
// ---------------------------------------------------------------------------

describe("E: the offline budget is one deadline shared by every harness", () => {
  let world: DiscoveryWorld | undefined;
  afterEach(() => {
    if (world) rmSync(world.root, { recursive: true, force: true });
    world = undefined;
  });

  function spyDeps(): { deps: DiscoveryDeps; seen: Array<{ id: string; deadlineAtMs?: number; hintMode?: boolean }> } {
    const seen: Array<{ id: string; deadlineAtMs?: number; hintMode?: boolean }> = [];
    const deps: DiscoveryDeps = {
      now: () => FIXED_NOW,
      readLocal: async (readInput) => {
        seen.push({ id: readInput.harnessId, deadlineAtMs: readInput.deadlineAtMs, hintMode: readInput.hintMode });
        return observation([]);
      },
    };
    return { deps, seen };
  }

  it("hands the same absolute deadline, and hint mode, to every harness reader of the hint run", async () => {
    const w = (world = makeWorld());
    const { deps, seen } = spyDeps();
    await offlineDiscoveryHints(w.snapshot(), w.environment, deps);
    expect(seen.length).toBeGreaterThan(5);
    expect(typeof seen[0].deadlineAtMs).toBe("number");
    expect(new Set(seen.map((entry) => entry.deadlineAtMs)).size).toBe(1);
    expect(seen.every((entry) => entry.hintMode === true)).toBe(true);
  });

  it("applies no deadline and no hint caps to an ordinary offline discovery", async () => {
    const w = (world = makeWorld());
    const { deps, seen } = spyDeps();
    await discoverModels(w.snapshot(), { mode: "offline", providers: "configured", ...w.environment }, deps);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen.every((entry) => entry.deadlineAtMs === undefined && entry.hintMode === undefined)).toBe(true);
  });

  it("shares one deadline when a caller sets offlineDeadlineMs on a normal discovery", async () => {
    const w = (world = makeWorld());
    const { deps, seen } = spyDeps();
    await discoverModels(w.snapshot(), { mode: "offline", providers: "configured", offlineDeadlineMs: 500, ...w.environment }, deps);
    expect(new Set(seen.map((entry) => entry.deadlineAtMs)).size).toBe(1);
  });
});
