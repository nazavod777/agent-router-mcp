import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoveryHintLine, runDoctorCommand } from "../../src/cli/doctor.js";
import { runModelsCommand } from "../../src/cli/models-cmd.js";
import { runCli } from "../../src/cli/main.js";
import { CLI_NAME } from "../../src/cli/name.js";
import { ConfigRevisionConflictError } from "../../src/config/writer.js";
import { MAX_APPLY_BATCH, offlineDiscoveryHints, previewDiscovery } from "../../src/discovery/index.js";
import { makeFixture } from "./helpers/mcp-fixture.js";
import { fakeDeps, listed, makeWorld, write, type DiscoveryWorld } from "./helpers/discovery-fixture.js";

let world: DiscoveryWorld | undefined;
const cleanups: string[] = [];
afterEach(() => {
  if (world) rmSync(world.root, { recursive: true, force: true });
  world = undefined;
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setup(user?: string): DiscoveryWorld {
  world = makeWorld({ user });
  return world;
}

async function run(args: string[], deps: ReturnType<typeof fakeDeps>): Promise<{ code: number; out: string }> {
  const w = world as DiscoveryWorld;
  const lines: string[] = [];
  const code = await runModelsCommand(args, {
    manager: w.manager, environment: w.environment, discovery: deps, io: { out: (text) => lines.push(text), err: (text) => lines.push(text) },
  });
  return { code, out: lines.join("\n") };
}

const NEW_PI = { pi: [listed("my-local-llm", { cli_provider: "ollama", context_window: 262_100, context_precision: "rounded" })] };

describe("agrmcp models discover (preview)", () => {
  it("prints a read-only table, a summary, and exact apply instructions without writing anything", async () => {
    const w = setup();
    const { code, out } = await run(["discover", "--harness", "pi", "--offline"], fakeDeps(NEW_PI));
    expect(code).toBe(0);
    expect(out).toMatch(/Harness\s+Provider\s+Model\s+Status\s+Proposed ID\s+Quality\s+Context/);
    expect(out).toMatch(/pi\s+ollama\s+my-local-llm\s+new\s+my-local-llm\s+baseline\s+~262100/);
    expect(out).toContain("Summary: 1 model(s): 1 new, 0 disabled in catalog, 0 already configured, 0 ambiguous.");
    const revision = w.snapshot().revision;
    expect(out).toContain(`Revision: ${revision}`);
    expect(out).toContain(`${CLI_NAME} models discover --harness pi --offline --apply --select <key>[,<key>...] --revision ${revision}`);
    expect(existsSync(w.userPath)).toBe(false);
  });

  it("--json prints the full preview; --offline never runs a probe; the default mode does for built-in harnesses only", async () => {
    setup();
    const offline = fakeDeps(NEW_PI);
    const json = JSON.parse((await run(["discover", "--offline", "--json"], offline)).out) as Record<string, any>;
    expect(json).toMatchObject({ mode: "offline", providers: "configured", total_candidates: 1, truncated: false });
    expect(json.candidates[0]).toMatchObject({ harness: "pi", status: "new", action: "import" });
    expect(offline.probeCalls).toEqual([]);

    const onDemand = fakeDeps({}, { pi: [listed("from-listing", { cli_provider: "ollama" })] });
    const result = JSON.parse((await run(["discover", "--json"], onDemand)).out) as Record<string, any>;
    expect(result.mode).toBe("on_demand");
    expect(onDemand.probeCalls).toContain("pi");
    expect(onDemand.probeCalls).not.toContain("claude-wrapper"); // a custom wrapper binary is never probed implicitly
    const wrapper = result.harnesses.find((entry: { harness: string }) => entry.harness === "claude-wrapper");
    expect(wrapper.diagnostics.map((d: { code: string }) => d.code)).not.toContain("busy");
  });

  it("--json stays valid JSON when a value holds a line-greedy secret shape, and still redacts secret-shaped values", async () => {
    setup();
    // `Authorization: ...` runs to the end of a line: redacting the serialized text would eat the closing quote and comma.
    const deps = fakeDeps({ pi: [
      listed("header-model", { cli_provider: "ollama", display_name: "Authorization: abc" }),
      listed("bearer-model", { cli_provider: "ollama", display_name: "Bearer abcdef123456 and https://u:pw@host.example/v1?token=zzz" }),
    ] });
    const { out } = await run(["discover", "--harness", "pi", "--offline", "--json"], deps);
    const parsed = JSON.parse(out) as { candidates: Array<{ discovered: { cli_model: string; display_name: string } }> };
    const names = Object.fromEntries(parsed.candidates.map((candidate) => [candidate.discovered.cli_model, candidate.discovered.display_name]));
    expect(names["header-model"]).toBe("Authorization: [REDACTED]");
    expect(names["bearer-model"]).not.toMatch(/abcdef123456|u:pw|zzz/);
    expect(out).not.toMatch(/abcdef123456|u:pw|zzz/);
  });

  it("rejects unknown harnesses and mutation flags without --apply", async () => {
    setup();
    await expect(run(["discover", "--harness", "nope"], fakeDeps({}))).rejects.toThrow(/Unknown harness "nope"/);
    await expect(run(["discover", "--select", "abc"], fakeDeps({}))).rejects.toThrow(/only work together with --apply/);
    await expect(run(["discover", "--all-new"], fakeDeps({}))).rejects.toThrow(/only work together with --apply/);
    await expect(run(["discover", "--apply"], fakeDeps({}))).rejects.toThrow(/--apply needs --select/);
    await expect(run(["nonsense"], fakeDeps({}))).rejects.toThrow(/Unknown models command/);
    expect((await run([], fakeDeps({}))).out).toContain("models discover");
  });
});

describe("agrmcp models discover --apply", () => {
  async function previewKeys(deps: ReturnType<typeof fakeDeps>, extra: string[] = ["--harness", "pi", "--offline"]): Promise<{ keys: string[]; revision: string }> {
    const json = JSON.parse((await run(["discover", ...extra, "--json"], deps)).out) as { revision: string; candidates: Array<{ key: string }> };
    return { keys: json.candidates.map((candidate) => candidate.key), revision: json.revision };
  }

  it("imports the selected candidate atomically and verifies the revision", async () => {
    const w = setup();
    const deps = fakeDeps(NEW_PI);
    const { keys, revision } = await previewKeys(deps);
    const { out } = await run(["discover", "--harness", "pi", "--offline", "--apply", "--select", keys[0], "--revision", revision], deps);
    expect(out).toContain("Imported 1: my-local-llm");
    const model = w.snapshot().models["my-local-llm"];
    expect(model).toMatchObject({ harness: "pi", cli_model: "my-local-llm", cli_provider: "ollama", source: "discovered", metadata_quality: "baseline", custom: true });
    expect(w.snapshot().config_warnings).toEqual([]);
    // Applying again is a no-op preview: the model is now configured.
    const after = JSON.parse((await run(["discover", "--harness", "pi", "--offline", "--json"], deps)).out) as Record<string, any>;
    expect(after.candidates[0]).toMatchObject({ status: "already_configured", action: "none", existing_model_id: "my-local-llm" });
  });

  it("accepts comma separated and repeated --select, and enables disabled cards", async () => {
    const w = setup();
    const deps = fakeDeps({ pi: [listed("a", { cli_provider: "p" }), listed("b", { cli_provider: "p" })], opencode: [listed("openai/gpt-x")] });
    const { keys } = await previewKeys(deps, ["--offline"]);
    expect(keys).toHaveLength(3);
    const { out } = await run(["discover", "--offline", "--apply", "--select", `${keys[0]},${keys[1]}`, "--select", keys[2], "--json"], deps);
    const parsed = JSON.parse(out) as { imported: string[]; enabled: string[] };
    expect(parsed.imported.sort()).toEqual(["a", "b"]);
    expect(parsed.enabled).toEqual(["oc-disabled"]);
    expect(w.snapshot().models["oc-disabled"].enabled).toBe(true);
  });

  it("rejects a revision that no longer matches and writes nothing", async () => {
    const w = setup();
    const deps = fakeDeps(NEW_PI);
    const { keys, revision } = await previewKeys(deps);
    await w.writer.updateDefaults({ max_queue_size: 7 }); // someone else changes the config after the preview
    await expect(run(["discover", "--harness", "pi", "--offline", "--apply", "--select", keys[0], "--revision", revision], deps))
      .rejects.toBeInstanceOf(ConfigRevisionConflictError);
    expect(w.snapshot().models["my-local-llm"]).toBeUndefined();
  });

  it("rejects stale or unknown keys, and keys of candidates with nothing to apply", async () => {
    const w = setup();
    const deps = fakeDeps(NEW_PI);
    await expect(run(["discover", "--harness", "pi", "--offline", "--apply", "--select", "deadbeefdeadbeef"], deps)).rejects.toThrow(/stale or unknown/);
    // The listing changed since the preview: the old key no longer exists.
    const { keys } = await previewKeys(deps);
    const changed = fakeDeps({ pi: [listed("my-local-llm", { cli_provider: "ollama", context_window: 1 })] });
    await expect(run(["discover", "--harness", "pi", "--offline", "--apply", "--select", keys[0]], changed)).rejects.toThrow(/stale or unknown/);
    // An already configured model has no action.
    await run(["discover", "--harness", "pi", "--offline", "--apply", "--all-new"], deps);
    const configured = await previewKeys(deps);
    await expect(run(["discover", "--harness", "pi", "--offline", "--apply", "--select", configured.keys[0]], deps)).rejects.toThrow(/nothing to apply/);
    expect(Object.keys(w.snapshot().models)).toContain("my-local-llm");
  });

  it(`caps --all-new at ${MAX_APPLY_BATCH} models per call and --select at the same limit`, async () => {
    const w = setup();
    const many = Array.from({ length: MAX_APPLY_BATCH + 10 }, (_, index) => listed(`bulk-${String(index).padStart(3, "0")}`, { cli_provider: "p" }));
    const deps = fakeDeps({ pi: many });
    const first = JSON.parse((await run(["discover", "--harness", "pi", "--offline", "--apply", "--all-new", "--json"], deps)).out) as { imported: string[]; remaining_new: number };
    expect(first.imported).toHaveLength(MAX_APPLY_BATCH);
    expect(first.remaining_new).toBe(10);
    const second = JSON.parse((await run(["discover", "--harness", "pi", "--offline", "--apply", "--all-new", "--json"], deps)).out) as { imported: string[]; remaining_new: number };
    expect(second.imported).toHaveLength(10);
    expect(second.remaining_new).toBe(0);
    expect(Object.keys(w.snapshot().models).filter((id) => id.startsWith("bulk-"))).toHaveLength(MAX_APPLY_BATCH + 10);

    const tooMany = Array.from({ length: MAX_APPLY_BATCH + 1 }, (_, index) => `key${index}`).join(",");
    await expect(run(["discover", "--offline", "--apply", "--select", tooMany], deps)).rejects.toThrow(/At most 50/);
  });

  it("prints a ready next-batch command with the NEW revision when more models remain", async () => {
    const w = setup();
    const many = Array.from({ length: MAX_APPLY_BATCH + 1 }, (_, index) => listed(`next-${String(index).padStart(3, "0")}`, { cli_provider: "p" }));
    const { out } = await run(["discover", "--harness", "pi", "--offline", "--apply", "--all-new"], fakeDeps({ pi: many }));
    expect(out).toContain(`More new models remain (1). Next batch: ${CLI_NAME} models discover --harness pi --offline --apply --all-new --revision ${w.snapshot().revision}`);
  });

  it("rejects --select together with --all-new through the service", async () => {
    setup();
    await expect(run(["discover", "--offline", "--apply", "--select", "abc", "--all-new"], fakeDeps({}))).rejects.toThrow(/either --select or --all-new/);
  });

  it("is reachable through the main CLI entry and prints the usage", async () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { out.push(String(line)); });
    const previous = process.exitCode;
    await runCli(["models", "--help"]);
    process.exitCode = previous;
    spy.mockRestore();
    expect(out.join("\n")).toContain(`${CLI_NAME} models discover`);
  });
});

describe("discovery service limits", () => {
  it("runs at most two probes at once and hands slots over without exceeding the limit", async () => {
    const w = setup();
    let running = 0;
    let peak = 0;
    const deps = {
      ...fakeDeps({}),
      probe: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((done) => setTimeout(done, 15));
        running -= 1;
        return { models: [], diagnostics: [], truncated: false };
      },
    };
    await previewDiscovery(w.snapshot(), { mode: "on_demand", providers: "configured", ...w.environment }, deps);
    expect(peak).toBe(2);
  });

  it("gives a stalled local reader the overall deadline too: the shared signal aborts it", async () => {
    const w = setup();
    const started = performance.now();
    const preview = await previewDiscovery(w.snapshot(), { harness: "pi", mode: "offline", providers: "configured", overallTimeoutMs: 30, ...w.environment }, {
      readLocal: (input) => new Promise((resolve) => {
        input.signal?.addEventListener("abort", () => resolve({ models: [], truncated: true, diagnostics: [{ stage: "offline", code: "cancelled" }] }), { once: true });
      }),
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(preview.harnesses[0]).toMatchObject({ truncated: true });
  });
});

describe("doctor: offline discovery hints", () => {
  it("counts locally detected unconfigured models with zero subprocesses", async () => {
    const w = setup();
    write(join(w.home, ".pi/agent/models.json"), JSON.stringify({ providers: { ollama: { apiKey: "sk-LEAK", models: [{ id: "llama-local", name: "Llama" }, { id: "second" }] } } }));
    const hints = await offlineDiscoveryHints(w.snapshot(), w.environment);
    // The fixture catalog has two pi harnesses that share one ~/.pi directory, so each reports the same two models.
    expect(hints).toMatchObject({ mode: "offline", unconfigured_models: 4, disabled_models: 0 });
    expect(hints.harnesses.map((entry) => `${entry.harness}:${entry.new_models}`).sort()).toEqual(["pi-alt:2", "pi:2"]);
    expect(JSON.stringify(hints)).not.toContain("sk-LEAK");
    expect(discoveryHintLine(hints)).toBe(`Discovery hint: 4 unconfigured models detected locally — run \`${CLI_NAME} models discover\` to review.`);
    expect(discoveryHintLine({ ...hints, unconfigured_models: 0 })).toBeUndefined();
    expect(discoveryHintLine({ ...hints, unconfigured_models: 1 })).toBe(`Discovery hint: 1 unconfigured model detected locally — run \`${CLI_NAME} models discover\` to review.`);
  });

  it("stays within its time budget: a reader that hangs yields a partial, truncated result instead of blocking", async () => {
    const w = setup();
    const started = performance.now();
    const preview = await previewDiscovery(w.snapshot(), { harness: "pi", mode: "offline", providers: "configured", offlineDeadlineMs: 20, ...w.environment }, {
      readLocal: () => new Promise(() => undefined), probe: async () => { throw new Error("must not probe"); },
    });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(preview.harnesses[0]).toMatchObject({ truncated: true, status: "unavailable" });
    expect(preview.harnesses[0].diagnostics.map((d) => d.code)).toContain("timeout");
  });

  async function doctor(args: string[]): Promise<string> {
    const fx = makeFixture();
    cleanups.push(fx.root);
    write(join(fx.home, ".pi/agent/models.json"), JSON.stringify({ providers: { ollama: { models: [{ id: "llama-local" }] } } }));
    vi.stubEnv("HOME", fx.home);
    vi.stubEnv("PATH", join(fx.root, "empty-path"));
    vi.stubEnv("XDG_CONFIG_HOME", join(fx.root, "xdg"));
    vi.stubEnv("XDG_STATE_HOME", join(fx.root, "state"));
    vi.stubEnv("ORCH_STATE_DIR", join(fx.root, "orch-state"));
    vi.stubEnv("ORCH_MODELS_PATH", join(fx.root, "models.toml"));
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    await runDoctorCommand(args, fx.ctx);
    return lines.join("\n");
  }

  it("adds discovery_hints to --json and one summary line to the human output", async () => {
    const report = JSON.parse(await doctor(["--json"])) as Record<string, any>;
    expect(report.discovery_hints).toMatchObject({ mode: "offline", unconfigured_models: 1 });
    vi.restoreAllMocks();
    expect(await doctor([])).toContain(`Discovery hint: 1 unconfigured model detected locally — run \`${CLI_NAME} models discover\` to review.`);
  });
});

describe("discovery stays out of the run path", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

  /** Static, runtime imports only: type-only imports are erased and dynamic `import()` loads lazily, on demand. */
  function importsOf(file: string): string[] {
    const text = readFileSync(file, "utf8").replace(/^\s*(?:import|export) type\b[\s\S]*?from\s*["'][^"']+["'];?/gm, "");
    const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;(]*?\bfrom\s*["'](\.[^"']+)["']|(?:^|\n)\s*import\s*["'](\.[^"']+)["']/g)]
      .map((match) => match[1] ?? match[2]);
    return specifiers.map((specifier) => resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
  }

  function closure(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      queue.push(...importsOf(file));
    }
    return seen;
  }

  it("never statically reaches discovery from orch_plan_preview, orch_run, the MCP server, or the CLI entry that starts it", () => {
    const discoveryDir = join(root, "discovery") + "/";
    for (const entry of ["mcp/server.ts", "mcp/tools.ts", "planner/preview.ts", "runtime/runner.ts", "cli/main.ts", "cli/mcp.ts", "cli/doctor.ts"]) {
      const offenders = [...closure(join(root, entry))].filter((file) => file.startsWith(discoveryDir) || file.endsWith("models-cmd.ts"));
      expect(offenders, `${entry} must not reach discovery`).toEqual([]);
    }
    // The graph walker must actually see static imports (negative control).
    expect([...closure(join(root, "cli/models-cmd.ts"))].some((file) => file.startsWith(discoveryDir))).toBe(true);
    // main and doctor load discovery only through a dynamic import.
    expect(readFileSync(join(root, "cli/main.ts"), "utf8")).toContain('await import("./models-cmd.js")');
    expect(readFileSync(join(root, "cli/doctor.ts"), "utf8")).toContain('await import("../discovery/index.js")');
    expect(readdirSync(join(root, "discovery")).length).toBeGreaterThan(0);
  });

  it("does not mention discovery tools or services in the MCP tool registry", () => {
    expect(readFileSync(join(root, "mcp/tools.ts"), "utf8")).not.toMatch(/discover(y|Models)|models-cmd/);
  });
});
