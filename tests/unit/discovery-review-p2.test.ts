/** Regression tests for the P2 review findings on model discovery (probe safety, sanitizing, ordering, budgets, scoping). */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runModelsCommand } from "../../src/cli/models-cmd.js";
import { customWrapperWarnings } from "../../src/cli/doctor.js";
import { buildProbeEnv, defaultExecProbe, parseGeminiOutput, probeCliModels } from "../../src/discovery/cli-probes.js";
import {
  OFFLINE_HINT_DEADLINE_MS, MAX_MODELS_PER_SOURCE, MAX_PREVIEW_CANDIDATES, buildCandidates, discoverModels, effectiveDiscovery,
  isCustomHarness, offlineDiscoveryHints, previewDiscovery,
  type CliProbeInput, type DiscoveredModel, type DiscoveryDeps, type ExecProbe, type HarnessDiscoveryResult, type ProbeRunRequest, type ProbeRunResult,
} from "../../src/discovery/index.js";
import type { DriverKind } from "../../src/drivers.js";
import { FIXED_NOW, USER_CONFIG, fakeDeps, listed, makeWorld, observation, type DiscoveryWorld } from "./helpers/discovery-fixture.js";

let world: DiscoveryWorld | undefined;
afterEach(() => {
  if (world) rmSync(world.root, { recursive: true, force: true });
  world = undefined;
});
const setup = (user?: string): DiscoveryWorld => (world = makeWorld({ user }));

function result(harness: string, driver: DriverKind, models: DiscoveredModel[]): HarnessDiscoveryResult {
  return { harness, driver, observed_at: FIXED_NOW.toISOString(), status: "ok", models, diagnostics: [], truncated: false };
}

const fakeResult = (overrides: Partial<ProbeRunResult> = {}): ProbeRunResult =>
  ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimitExceeded: false, ...overrides });

// ---------------------------------------------------------------------------
// Probes: Gemini capability gate, Pi isolation flags, env allowlist, redaction, process-group reaping
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("CLI probes (P2 safety)", () => {
  let root: string;
  let binDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "orch-discovery-p2-"));
    binDir = join(root, "bin");
    mkdirSync(binDir);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function install(name: string): void {
    const path = join(binDir, name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }

  function input(driver: DriverKind, binary: string, execProbe: ExecProbe): CliProbeInput {
    install(binary);
    return {
      cwd: root, env: { PATH: binDir, HOME: root }, homeDir: root, platform: process.platform, harnessId: driver,
      harness: { driver, display_name: driver, binary, enabled: true }, driver, discovery: "native", execProbe, probeTimeoutMs: 1000,
    };
  }

  function recorder(...results: Partial<ProbeRunResult>[]): { exec: ExecProbe; requests: ProbeRunRequest[] } {
    const requests: ProbeRunRequest[] = [];
    const queue = [...results];
    return { requests, exec: async (request) => { requests.push(request); return fakeResult(queue.shift() ?? {}); } };
  }

  // Real `gemini --help` of 0.55.1: no models subcommand; `gemini [query..]` is the default prompt command.
  const GEMINI_0_55_HELP = [
    "Usage: gemini [options] [command]", "", "Commands:",
    "  gemini mcp                   Manage MCP servers",
    "  gemini extensions <command>  Manage Gemini CLI extensions.  [aliases: extension]",
    "  gemini [query..]             Launch Gemini CLI  [default]", "",
    "Options:", "  -m, --model  Model  [string]", "  -p, --prompt  Run in non-interactive (headless) mode",
  ].join("\n");

  describe("P2-1: Gemini is listed only when its help advertises a models subcommand", () => {
    it("never runs `gemini models list` on a CLI without one (it would start a headless prompt) and reports no error", async () => {
      const { exec, requests } = recorder({ stdout: GEMINI_0_55_HELP });
      const observed = await probeCliModels(input("gemini", "gemini", exec));
      expect(requests.map((request) => request.args)).toEqual([["--help"]]);
      expect(observed.models).toEqual([]);
      expect(observed.diagnostics).toEqual([expect.objectContaining({ stage: "probe", code: "scope_unknown", message: expect.stringContaining("does not expose a models subcommand") })]);
      expect(observed.diagnostics[0].message).toContain("~/.gemini/settings.json");
    });

    it("keeps that outcome a non-failure: the harness is `unsupported`, not `unavailable`", async () => {
      const w = setup();
      const { exec, requests } = recorder({ stdout: GEMINI_0_55_HELP });
      const deps: DiscoveryDeps = {
        now: () => FIXED_NOW, readLocal: async () => observation([]),
        probe: (probeInput) => probeCliModels({ ...probeInput, execProbe: exec, env: { PATH: binDir, HOME: root } }),
      };
      install("gemini");
      const [gemini] = await discoverModels(w.snapshot(), { harness: "gemini", mode: "on_demand", providers: "configured", ...w.environment, env: { PATH: binDir, HOME: root } }, deps);
      expect(gemini.status).toBe("unsupported");
      expect(requests.map((request) => request.args.join(" "))).toEqual(["--help"]);
    });

    it.each([
      ["a bare command line", "Commands:\n  models list  List models\n"],
      ["a `gemini`-prefixed command line", "Commands:\n  gemini models list  List the available models\n  gemini mcp  MCP\n"],
    ])("runs the exact listing after help advertises it as %s", async (_name, help) => {
      const { exec, requests } = recorder({ stdout: help }, { stdout: JSON.stringify([{ modelId: "gemini-x" }]) });
      const observed = await probeCliModels(input("gemini", "gemini", exec));
      expect(requests.map((request) => request.args)).toEqual([["--help"], ["models", "list", "--output-format", "json"]]);
      expect(observed.models.map((model) => model.cli_model)).toEqual(["gemini-x"]);
      expect(observed.diagnostics).toEqual([]);
    });

    it("does not mistake prose or the --model flag for a subcommand, and stops when help itself fails", async () => {
      const prose = recorder({ stdout: "Usage: gemini\n  -m, --model  Pick one of the models listed by the docs\nRun gemini models to see them\n\nmodels are described online\n" });
      await probeCliModels(input("gemini", "gemini", prose.exec));
      expect(prose.requests).toHaveLength(1);

      const broken = recorder({ exitCode: 1, stderr: "boom" });
      const observed = await probeCliModels(input("gemini", "gemini", broken.exec));
      expect(broken.requests).toHaveLength(1);
      expect(observed.diagnostics).toEqual([expect.objectContaining({ code: "unsupported_version" })]);
    });
  });

  describe("P2-2: Pi never loads extensions or MCP servers during discovery", () => {
    const PI_TABLE = "provider model context max-out thinking images\nacme a-1 64K 8K yes no\n";

    it("runs with the isolation flags and offline mode", async () => {
      const { exec, requests } = recorder({ stdout: PI_TABLE });
      const observed = await probeCliModels(input("pi", "pi", exec));
      expect(requests.map((request) => request.args)).toEqual([["--no-extensions", "--no-mcp", "--no-approve", "--offline", "--list-models"]]);
      expect(observed.models.map((model) => model.cli_model)).toEqual(["a-1"]);
    });

    it("falls back only to the isolated shorter form when an older Pi rejects a newer flag", async () => {
      const { exec, requests } = recorder({ exitCode: 1, stderr: "Error: Unknown option: --no-approve" }, { stdout: PI_TABLE });
      const observed = await probeCliModels(input("pi", "pi", exec));
      expect(requests.map((request) => request.args)).toEqual([
        ["--no-extensions", "--no-mcp", "--no-approve", "--offline", "--list-models"],
        ["--no-extensions", "--no-mcp", "--list-models"],
      ]);
      expect(observed.models).toHaveLength(1);
    });

    it("never retries without the isolation flags, however the older Pi fails", async () => {
      const { exec, requests } = recorder(
        { exitCode: 1, stderr: "Error: Unknown option: --no-extensions" }, { exitCode: 1, stderr: "Error: Unknown option: --no-extensions" }, { stdout: PI_TABLE },
      );
      const observed = await probeCliModels(input("pi", "pi", exec));
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(request.args).toEqual(expect.arrayContaining(["--no-extensions", "--no-mcp"]));
      expect(observed.models).toEqual([]);
      expect(observed.diagnostics).toEqual([expect.objectContaining({ code: "unsupported_version" })]);
    });

    it("judges rejected flags by stderr, because a real Pi prints `Unknown option` yet exits 0 and still lists", async () => {
      const ignored = { exitCode: 0, stderr: "Error: Unknown option: --no-mcp", stdout: PI_TABLE };
      const retried = recorder(ignored, { stdout: PI_TABLE });
      const accepted = await probeCliModels(input("pi", "pi", retried.exec));
      expect(retried.requests.map((request) => request.args)).toEqual([
        ["--no-extensions", "--no-mcp", "--no-approve", "--offline", "--list-models"], ["--no-extensions", "--no-mcp", "--list-models"],
      ]);
      expect(accepted.models).toHaveLength(1);

      // The listing of a Pi that ignored an isolation flag may have run extensions or MCP servers: it is not accepted.
      const stillIgnored = recorder(ignored, ignored);
      const refused = await probeCliModels(input("pi", "pi", stillIgnored.exec));
      expect(stillIgnored.requests).toHaveLength(2);
      expect(refused.models).toEqual([]);
      expect(refused.diagnostics).toEqual([expect.objectContaining({ code: "unsupported_version" })]);
    });

    it("does not retry on an unrelated failure", async () => {
      const { exec, requests } = recorder({ exitCode: 1, stderr: "network unreachable" });
      await probeCliModels(input("pi", "pi", exec));
      expect(requests).toHaveLength(1);
    });
  });

  describe("P2-3: the probe environment is an exact allowlist", () => {
    it("drops XDG_/LC_ wildcards (activation tokens, session cookies) and keeps only the named base directories and locale vars", () => {
      const source: NodeJS.ProcessEnv = {
        PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", SHELL: "/bin/sh", TERM: "xterm", TMPDIR: "/t", TEMP: "/t", TMP: "/t", CI: "1",
        XDG_CONFIG_HOME: "/c", XDG_DATA_HOME: "/d", XDG_CACHE_HOME: "/k", XDG_STATE_HOME: "/s",
        LANG: "C.UTF-8", LC_ALL: "C", LC_CTYPE: "C",
        XDG_ACTIVATION_TOKEN: "tok", XDG_SESSION_COOKIE: "cookie", XDG_RUNTIME_DIR: "/run/user/1", XDG_SESSION_ID: "3",
        LC_PAPER: "x", LC_MESSAGES: "x", xdg_config_home: "/lower",
      };
      const env = buildProbeEnv(source, "pi");
      expect(Object.keys(env).sort()).toEqual([
        "CI", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "LOGNAME", "NO_COLOR", "PATH", "SHELL", "TEMP", "TERM", "TMP", "TMPDIR", "USER",
        "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
      ]);
    });
  });

  describe("P2-4: probe strings are sanitized", () => {
    it("strips URL userinfo, query, and fragment from display names and drops secret-shaped ids", () => {
      const rows = [
        { modelId: "gemini-a", displayName: "Gemini A https://user:p4ss@models.example.com/v1/a?api_key=SECRETKEY123#frag" },
        { modelId: "sk-live-0123456789abcdef", displayName: "leaky" },
        { modelId: "gemini-b", displayName: "B ?token=ABCDEF&x=1" },
      ];
      const models = parseGeminiOutput(JSON.stringify(rows));
      expect(models.map((model) => model.cli_model)).toEqual(["gemini-a", "gemini-b"]);
      expect(models[0].display_name).toBe("Gemini A https://models.example.com");
      expect(models[1].display_name).toBe("B ?token=[REDACTED]&x=1");
      const text = JSON.stringify(models);
      for (const secret of ["p4ss", "user:", "SECRETKEY123", "frag", "ABCDEF", "0123456789abcdef"]) expect(text).not.toContain(secret);
    });

    it("drops a route whose id or provider merely contains a secret shape instead of importing `acme/[REDACTED]`", async () => {
      const { parseOpencodeOutput, parsePiOutput } = await import("../../src/discovery/cli-probes.js");
      expect(parseOpencodeOutput("acme/sk-abcdefghijk123\nacme/fine-model\n").map((model) => model.cli_model)).toEqual(["fine-model"]);
      const piTable = "provider model context max-out thinking images\nsk-proj123 m-1 64K 8K yes no\nacme m-2 64K 8K yes no\n";
      expect(parsePiOutput(piTable).map((model) => `${model.cli_provider}/${model.cli_model}`)).toEqual(["acme/m-2"]);
    });

    it("scrubs diagnostic messages and candidate fields all the way into a previewed and written config", async () => {
      const w = setup();
      const leaky = listed("my-model", { cli_provider: "acme", display_name: "Mine https://u:pw-SECRET@host.example/p?api_key=KEY-SECRET#f" });
      const deps: DiscoveryDeps = {
        now: () => FIXED_NOW, readLocal: async () => observation([]),
        probe: async () => ({ models: [leaky, listed("sk-live-0123456789abcdef", { cli_provider: "acme" })], truncated: false,
          diagnostics: [{ stage: "probe", code: "invalid_output", message: "see https://u:pw-SECRET@host.example/x?token=KEY-SECRET" }] }),
      };
      const preview = await previewDiscovery(w.snapshot(), { harness: "pi", mode: "on_demand", providers: "configured", ...w.environment }, deps);
      expect(preview.candidates.map((candidate) => candidate.discovered.cli_model)).toEqual(["my-model"]);
      const candidate = preview.candidates[0];
      expect(candidate.discovered.display_name).toBe("Mine https://host.example");
      expect(candidate.proposed_model?.display_name).toBe("Mine https://host.example");
      expect(JSON.stringify(preview)).not.toMatch(/SECRET|pw-|0123456789abcdef/);

      await w.writer.importModels({ create: { [candidate.proposed_id]: candidate.proposed_model! } });
      expect(readFileSync(w.userPath, "utf8")).not.toMatch(/SECRET|pw-/);
    });
  });

  describe("P2-5: the probe's process group is reaped on every completion path", () => {
    function script(name: string, body: string): string {
      const path = join(root, name);
      writeFileSync(path, `#!${process.execPath}\n${body}\n`);
      chmodSync(path, 0o755);
      return path;
    }
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
    const request = (command: string): ProbeRunRequest => ({
      command, args: [], env: buildProbeEnv(process.env, "pi"), cwd: root, timeoutMs: 10_000, stdoutLimitBytes: 65_536, stderrLimitBytes: 65_536,
    });
    const LINGERING_CHILD = (pidFile: string, exit: string) => [
      "const { spawn } = require('node:child_process');",
      // Same process group as the probe (not detached), no inherited pipes: only the group can reveal it after a clean exit.
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      "child.unref();",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      exit,
    ].join("\n");

    it.skipIf(process.platform !== "linux")("kills a descendant that outlives a clean exit with closed pipes", async () => {
      const pidFile = join(root, "lingering.pid");
      const started = performance.now();
      const outcome = await defaultExecProbe(request(script("clean", LINGERING_CHILD(pidFile, "console.log('done');"))));
      expect(outcome).toMatchObject({ exitCode: 0, stdout: "done\n", timedOut: false, cancelled: false });
      expect(performance.now() - started).toBeLessThan(4_000);
      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf8"));
      try {
        expect(await waitUntil(() => !isLive(pid))).toBe(true);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    });

    it.skipIf(process.platform !== "linux")("also reaps it after a non-zero exit and still reports the exit code", async () => {
      const pidFile = join(root, "lingering-failed.pid");
      const outcome = await defaultExecProbe(request(script("failed", LINGERING_CHILD(pidFile, "process.exit(3);"))));
      expect(outcome.exitCode).toBe(3);
      const pid = Number(readFileSync(pidFile, "utf8"));
      try {
        expect(await waitUntil(() => !isLive(pid))).toBe(true);
      } finally {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Service: wrapper opt-in, literal harness IDs, hint budget
// ---------------------------------------------------------------------------

describe("P2-3: only the stock executable looked up by bare name is native", () => {
  it.each(["./tools/pi", "/usr/local/bin/custom/pi", "C:\\tools\\pi", "tools\\pi", "../pi", "pi-wrapper", "pi.exe"])(
    "treats %s as a custom wrapper that stays manual until the user opts in", (binary) => {
      const harness = { driver: "pi" as const, binary };
      expect(isCustomHarness(harness)).toBe(true);
      expect(effectiveDiscovery(harness)).toBe("manual");
      expect(effectiveDiscovery({ ...harness, model_discovery: "native" })).toBe("native");
      expect(effectiveDiscovery({ ...harness, model_discovery: "wrapper" })).toBe("wrapper");
    });

  it("keeps the bare stock name native, and doctor agrees about which binaries are custom", () => {
    expect(isCustomHarness({ driver: "pi", binary: "pi" })).toBe(false);
    expect(effectiveDiscovery({ driver: "pi", binary: "pi" })).toBe("native");
    expect(isCustomHarness({ driver: "antigravity", binary: "agy" })).toBe(false);
    const health = { harness: "pi", driver: "pi" as const, enabled: true, installed: false, auth_status: "unknown" as const, note: "not found" };
    const warn = (binary: string) => customWrapperWarnings([health], { harnesses: { pi: { driver: "pi", display_name: "Pi", binary, enabled: true } } });
    expect(warn("/opt/x/pi")).toHaveLength(1);
    expect(warn("pi")).toHaveLength(0);
  });

  it("does not probe a path-based binary that merely ends in the stock name, unless the user opts in", async () => {
    const w = setup();
    const config = w.snapshot();
    config.harnesses.pi.binary = "/usr/local/bin/custom/pi";
    const probe = async (): Promise<ReturnType<typeof observation>> => observation([listed("probed-model", { cli_provider: "acme" })]);
    const deps = (calls: string[]): DiscoveryDeps => ({ now: () => FIXED_NOW, readLocal: async () => observation([]), probe: async (input) => { calls.push(input.harnessId); return probe(); } });
    const options = { harness: "pi", mode: "on_demand" as const, providers: "configured" as const, ...w.environment };

    const skipped: string[] = [];
    const [manual] = await discoverModels(config, options, deps(skipped));
    expect(skipped).toEqual([]);
    expect(manual.models).toEqual([]);

    config.harnesses.pi.model_discovery = "wrapper";
    const probed: string[] = [];
    const [wrapper] = await discoverModels(config, options, deps(probed));
    expect(probed).toEqual(["pi"]);
    expect(wrapper.models.map((model) => model.cli_model)).toEqual(["probed-model"]);
  });
});

describe("P2-15: a literal harness named \"all\" is not a wildcard", () => {
  const ALL_HARNESS = '[harnesses.all]\ncustom = true\ndriver = "pi"\ndisplay_name = "Literally all"\nbinary = "pi"\nmodel_discovery = "native"\n';

  it("scans only that harness when the ID is given, and every enabled harness when it is omitted", async () => {
    const w = setup(ALL_HARNESS);
    const base = { mode: "offline" as const, providers: "configured" as const, ...w.environment };

    const literal = fakeDeps({});
    const only = await discoverModels(w.snapshot(), { ...base, harness: "all" }, literal);
    expect(only.map((entry) => entry.harness)).toEqual(["all"]);
    expect(literal.localCalls).toEqual(["all"]);

    const wildcard = fakeDeps({});
    const everything = await discoverModels(w.snapshot(), base, wildcard);
    expect(wildcard.localCalls).toContain("all");
    expect(wildcard.localCalls.length).toBeGreaterThan(5);
  });

  it("rejects \"all\" as an unknown harness when no harness has that ID", async () => {
    const w = setup();
    await expect(discoverModels(w.snapshot(), { harness: "all", mode: "offline", providers: "configured", ...w.environment }, fakeDeps({})))
      .rejects.toThrow(/Unknown harness "all"/);
  });

  it("makes `models discover --harness <id>` pass the exact ID and only an omitted flag mean every harness", async () => {
    const w = setup(ALL_HARNESS);
    const out: string[] = [];
    const exec = async (args: string[], deps: ReturnType<typeof fakeDeps>) => {
      await runModelsCommand(args, { manager: w.manager, environment: w.environment, discovery: deps, io: { out: (text) => out.push(text), err: (text) => out.push(text) } });
    };
    const literal = fakeDeps({ all: [listed("only-here", { cli_provider: "acme" })], claude: [listed("claude-elsewhere")] });
    await exec(["discover", "--offline", "--harness", "all"], literal);
    expect(literal.localCalls).toEqual(["all"]);
    expect(out.join("\n")).toContain("only-here");
    expect(out.join("\n")).not.toContain("claude-elsewhere");

    const omitted = fakeDeps({ claude: [listed("claude-elsewhere")] });
    await exec(["discover", "--offline"], omitted);
    expect(omitted.localCalls.length).toBeGreaterThan(5);

    const none = setup();
    await expect(runModelsCommand(["discover", "--offline", "--harness", "all"], { manager: none.manager, environment: none.environment, discovery: fakeDeps({}), io: { out: () => {}, err: () => {} } }))
      .rejects.toThrow(/Unknown harness "all"/);
  });
});

describe("P2-10: doctor's offline hints stay inside the 45 ms budget", () => {
  const bulk = (prefix: string, count: number, extra: Partial<DiscoveredModel> = {}): DiscoveredModel[] =>
    Array.from({ length: count }, (_, index) => listed(`${prefix}-${index}`, extra));

  it("counts 8,000 observations within the budget, covering reading and counting", async () => {
    const w = setup();
    const layer1 = {
      claude: bulk("c", 2000), gemini: bulk("g", 2000), cursor: bulk("u", 2000),
      pi: bulk("p", 2000, { cli_provider: "acme" }),
    };
    // Warm up module and JIT work once so the measurement is of steady-state counting, as in a real doctor run's second harness pass.
    await offlineDiscoveryHints(w.snapshot(), w.environment, fakeDeps(layer1));
    const started = performance.now();
    const hints = await offlineDiscoveryHints(w.snapshot(), w.environment, fakeDeps(layer1));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(OFFLINE_HINT_DEADLINE_MS);
    expect(hints.unconfigured_models).toBe(8000);
    expect(hints.harnesses.map((entry) => entry.harness)).toEqual(["claude", "cursor", "gemini", "pi"]);
    expect(hints.truncated).toBeUndefined();
  });

  it("caps one harness at the per-source limit and says the count is a lower bound", async () => {
    const w = setup();
    const hints = await offlineDiscoveryHints(w.snapshot(), w.environment, fakeDeps({ claude: bulk("c", 8000) }));
    expect(hints.unconfigured_models).toBe(MAX_MODELS_PER_SOURCE);
    expect(hints.truncated).toBe(true);
  });

  it("stops counting at the deadline instead of finishing a long list", async () => {
    const w = setup();
    const slowRead: DiscoveryDeps["readLocal"] = async () => {
      const until = performance.now() + OFFLINE_HINT_DEADLINE_MS + 5;
      while (performance.now() < until) { /* the reader itself used up the whole budget */ }
      return observation(bulk("late", 1500));
    };
    const hints = await offlineDiscoveryHints(w.snapshot(), w.environment, { now: () => FIXED_NOW, readLocal: slowRead });
    expect(hints.truncated).toBe(true);
    expect(hints.unconfigured_models).toBeLessThan(1500 * 8);
  });

  it("still reports the harnesses that were quick when another reader runs out the whole budget", async () => {
    const w = setup();
    const harnessIds = Object.keys(w.snapshot().harnesses);
    const stuck = harnessIds[harnessIds.length - 1];
    const readLocal: DiscoveryDeps["readLocal"] = async (readInput) => {
      if (readInput.harnessId === stuck) return new Promise(() => { /* never answers: the read deadline ends the wait */ });
      return observation([listed(`only-${readInput.harnessId}`, { cli_provider: "acme" })]);
    };
    const hints = await offlineDiscoveryHints(w.snapshot(), w.environment, { now: () => FIXED_NOW, readLocal });
    expect(hints.truncated).toBe(true);
    expect(hints.unconfigured_models).toBe(harnessIds.length - 1);
    expect(hints.harnesses.map((entry) => entry.harness)).not.toContain(stuck);
  });

  it("agrees with the full preview about what is new and what is disabled", async () => {
    const w = setup(USER_CONFIG);
    const layer1 = {
      claude: [listed("claude-opus-5-5"), listed("claude-new-1"), listed("claude-new-1"), listed("claude-hidden", { availability: "unconnected" })],
      opencode: [listed("gpt-x", { cli_provider: "openai" }), listed("gpt-y", { cli_provider: "openai" }), listed("no-provider")],
    };
    const hints = await offlineDiscoveryHints(w.snapshot(), w.environment, fakeDeps(layer1));
    const preview = await previewDiscovery(w.snapshot(), { mode: "offline", providers: "configured", ...w.environment }, fakeDeps(layer1));
    const count = (status: string) => preview.candidates.filter((candidate) => candidate.status === status).length;
    expect(hints.unconfigured_models).toBe(count("new"));
    expect(hints.disabled_models).toBe(count("disabled_in_catalog"));
    expect(hints).toMatchObject({ unconfigured_models: 1, disabled_models: 1 });
  });
});

// ---------------------------------------------------------------------------
// Enrichment: quarantined IDs, actionable-first ordering
// ---------------------------------------------------------------------------

describe("P2-8: IDs held by quarantined entries are never proposed", () => {
  it("allocates a different ID than a quarantined model's", () => {
    const w = setup('[models.my-local-llm]\ncustom = true\ndisplay_name = "Half written"\n');
    const config = w.snapshot();
    expect(config.quarantined).toEqual([expect.objectContaining({ section: "models", id: "my-local-llm" })]);
    expect(config.models["my-local-llm"]).toBeUndefined();
    const built = buildCandidates({ config, results: [result("pi", "pi", [listed("my-local-llm", { cli_provider: "ollama" })])], providers: "configured", now: FIXED_NOW });
    expect(built.candidates).toHaveLength(1);
    expect(built.candidates[0].proposed_id).not.toBe("my-local-llm");
    expect(built.candidates[0].proposed_id.toLowerCase()).toContain("my-local-llm");
    // Control: without the quarantine record the natural ID is used.
    const unquarantined = buildCandidates({ config: { ...config, quarantined: [] }, results: [result("pi", "pi", [listed("my-local-llm", { cli_provider: "ollama" })])], providers: "configured", now: FIXED_NOW });
    expect(unquarantined.candidates[0].proposed_id).toBe("my-local-llm");
  });
});

describe("P2-9: actionable candidates sort ahead of configured ones before the preview cap", () => {
  it("orders new, disabled, ambiguous, then already configured", () => {
    const w = setup(USER_CONFIG);
    const built = buildCandidates({
      config: w.snapshot(), providers: "configured", now: FIXED_NOW,
      results: [
        result("claude", "claude", [listed("claude-opus-5-5"), listed("claude-new")]),
        result("opencode", "opencode", [listed("gpt-x", { cli_provider: "openai" }), listed("gpt-y", { cli_provider: "openai" })]),
      ],
    });
    expect(built.candidates.map((candidate) => candidate.status)).toEqual(["new", "disabled_in_catalog", "ambiguous", "already_configured"]);
  });

  it("keeps all 10 new models inside the 1,000-row preview when 1,000 configured models precede them", () => {
    const w = setup();
    const config = w.snapshot();
    for (let index = 0; index < 1000; index += 1) {
      config.models[`configured-${index}`] = { ...structuredClone(config.models["claude-opus-5-5"]), cli_model: `configured-${index}` };
    }
    const configured = Array.from({ length: 1000 }, (_, index) => listed(`configured-${index}`));
    const fresh = Array.from({ length: 10 }, (_, index) => listed(`zzz-new-${index}`));
    const built = buildCandidates({ config, results: [result("claude", "claude", [...configured, ...fresh])], providers: "configured", now: FIXED_NOW });
    expect(built.total).toBe(1010);
    expect(built.truncated).toBe(true);
    expect(built.candidates).toHaveLength(MAX_PREVIEW_CANDIDATES);
    expect(built.candidates.slice(0, 10).map((candidate) => candidate.status)).toEqual(Array(10).fill("new"));
    expect(built.candidates.slice(0, 10).map((candidate) => candidate.discovered.cli_model).sort())
      .toEqual(fresh.map((model) => model.cli_model).sort());
    expect(built.candidates.slice(10).every((candidate) => candidate.status === "already_configured")).toBe(true);
  });

  it("lets --all-new reach new models that the old order truncated away", async () => {
    const w = setup();
    const config = w.snapshot();
    for (let index = 0; index < 1000; index += 1) {
      config.models[`configured-${index}`] = { ...structuredClone(config.models["claude-opus-5-5"]), cli_model: `configured-${index}` };
    }
    const models = [...Array.from({ length: 1000 }, (_, index) => listed(`configured-${index}`)), listed("zzz-brand-new")];
    const preview = await previewDiscovery(config, { harness: "claude", mode: "offline", providers: "configured", ...w.environment },
      { now: () => FIXED_NOW, readLocal: async () => observation(models) });
    expect(preview.candidates[0]).toMatchObject({ status: "new", action: "import" });
    expect(preview.candidates.filter((candidate) => candidate.action === "import")).toHaveLength(1);
  });
});
