import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AntigravityAdapter } from "../../src/adapters/antigravity.js";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { DshAdapter } from "../../src/adapters/dsh.js";
import { DroidAdapter } from "../../src/adapters/ecosystem.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type { BuildInvocationInput, CliAdapter } from "../../src/adapters/types.js";
import { FxAdapter } from "../../src/adapters/vendor-clis.js";
import type { HarnessConfig } from "../../src/config/schema.js";
import { DRIVER_KINDS } from "../../src/drivers.js";
import { installStubClis, type StubCliEnvironment } from "./helpers/stub-clis.js";
import type { DriverKind, HarnessHealth, RunMode } from "../../src/types.js";

let root: string;
let jobCounter = 0;
let stubClis: StubCliEnvironment;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "orch-adapter-effort-provider-"));
  // Adapters refuse a binary they cannot resolve, and must never read the real user's CLI configuration.
  stubClis = installStubClis(DRIVER_KINDS);
});

afterAll(() => {
  stubClis.restore();
  rmSync(root, { recursive: true, force: true });
});

function request(
  driver: DriverKind,
  overrides: { effort?: string; mode?: RunMode; harness?: Partial<HarnessConfig>; cliProvider?: string } = {},
): BuildInvocationInput {
  jobCounter += 1;
  const jobDir = join(root, `job-${jobCounter}`);
  mkdirSync(jobDir, { mode: 0o700, recursive: true });
  return {
    harnessId: driver,
    harness: { driver, display_name: driver, binary: driver, enabled: true, ...overrides.harness },
    modelId: "test",
    model: {
      display_name: "Test", harness: driver, cli_model: "demo", tier: "standard", efforts: ["medium", "high"],
      default_effort: "medium", cost_tier: "low", cost_note: "", speed_note: "", context_window: 1000, strengths: [],
      weaknesses: [], best_for: [], avoid_for: [], checked_at: "2026-11-25", enabled: true,
      ...(overrides.cliProvider ? { cli_provider: overrides.cliProvider } : {}),
    },
    effort: overrides.effort ?? "high", mode: overrides.mode ?? "write", prompt: "question", cwd: root, jobDir,
    inheritMcp: false, isGitRepo: true,
  };
}

/** Writes an executable node script that stands in for a CLI binary. */
function fakeBinary(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("pi upstream provider", () => {
  const adapter = new PiAdapter();

  it("falls back to harness.default_upstream_provider when the model has no cli_provider", async () => {
    const built = await adapter.buildInvocation(request("pi", { harness: { default_upstream_provider: "upstream" } }));
    expect(built.args[built.args.indexOf("--model") + 1]).toBe("upstream/demo");
  });

  it("lets model.cli_provider win over the harness default", async () => {
    const built = await adapter.buildInvocation(
      request("pi", { harness: { default_upstream_provider: "upstream" }, cliProvider: "own" }),
    );
    expect(built.args[built.args.indexOf("--model") + 1]).toBe("own/demo");
  });

  it("does not stack the harness default on a cli_model that already names its provider", async () => {
    const qualified = request("pi", { harness: { default_upstream_provider: "deepseek" } });
    qualified.model.cli_model = "zai/glm-5.3";
    const built = await adapter.buildInvocation(qualified);
    expect(built.args[built.args.indexOf("--model") + 1]).toBe("zai/glm-5.3");

    // An explicit model-level provider is still honored.
    const explicit = request("pi", { harness: { default_upstream_provider: "deepseek" }, cliProvider: "own" });
    explicit.model.cli_model = "zai/glm-5.3";
    const explicitArgs = (await adapter.buildInvocation(explicit)).args;
    expect(explicitArgs[explicitArgs.indexOf("--model") + 1]).toBe("own/zai/glm-5.3");
  });

  it("passes a bare model when neither provider is set", async () => {
    const built = await adapter.buildInvocation(request("pi"));
    expect(built.args[built.args.indexOf("--model") + 1]).toBe("demo");
  });

  it("checks auth for the same provider the invocation uses", async () => {
    const log = join(root, "pi-probe.jsonl");
    const binary = fakeBinary("pi-probe-cli", `
      const args = process.argv.slice(2);
      require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
      if (args[0] === "--version") console.log("1.0.0");
      else console.log(JSON.stringify({ status: "ready" }));
    `);
    const harness = { driver: "pi", display_name: "Pi", binary, enabled: true, default_upstream_provider: "upstream" } as HarnessConfig;
    const health = await adapter.probe("pi", harness, { timeoutMs: 5000 });
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
    const authCall = calls.find((args) => args[0] === "auth");
    expect(authCall?.[authCall.indexOf("--provider") + 1]).toBe("upstream");
    expect(health.auth_status).toBe("ready");

    const built = await adapter.buildInvocation(request("pi", { harness }));
    expect(built.args[built.args.indexOf("--model") + 1]).toBe("upstream/demo");
  });
});

describe('"default" effort omits the native effort flag', () => {
  const cases: Array<[string, CliAdapter, DriverKind, (args: string[]) => boolean]> = [
    ["claude", new ClaudeAdapter(), "claude", (args) => args.includes("--effort")],
    ["codex", new CodexAdapter(), "codex", (args) => args.some((arg) => arg.startsWith("model_reasoning_effort"))],
    ["pi", new PiAdapter(), "pi", (args) => args.includes("--thinking")],
    ["antigravity", new AntigravityAdapter(), "antigravity", (args) => args.includes("--effort")],
    ["droid", new DroidAdapter(), "droid", (args) => args.includes("--reasoning-effort")],
    ["fx", new FxAdapter(), "fx", (args) => args.includes("--effort")],
  ];

  for (const [name, adapter, driver, hasEffortFlag] of cases) {
    it(`${name}: an explicit effort is passed, "default" is not`, async () => {
      const explicit = await adapter.buildInvocation(request(driver, { effort: "high" }));
      expect(hasEffortFlag(explicit.args)).toBe(true);
      const unset = await adapter.buildInvocation(request(driver, { effort: "default" }));
      expect(hasEffortFlag(unset.args)).toBe(false);
      expect(unset.nativeEffort).toBe("default");
    });
  }

  it("dsh: reasoningEffort is left out of the patch for \"default\"", async () => {
    const adapter = new DshAdapter();
    const patchConfig = async (effort: string) => {
      const built = await adapter.buildInvocation(request("dsh", { effort }));
      const patch = parseYaml(readFileSync(built.args[built.args.indexOf("--patch") + 1], "utf8")) as Array<{ config: Record<string, unknown> }>;
      return patch[0].config;
    };
    expect(await patchConfig("high")).toMatchObject({ reasoningEffort: "high" });
    expect(await patchConfig("default")).not.toHaveProperty("reasoningEffort");
  });

  it("antigravity: an effort suffix in the model name still wins and warns", async () => {
    const input = request("antigravity", { effort: "default" });
    input.model.cli_model = "demo-high";
    const built = await new AntigravityAdapter().buildInvocation(input);
    expect(built.args).not.toContain("--effort");
    expect(built.nativeEffort).toBe("high");
  });
});

describe("probe cache key", () => {
  function countingRegistry(): { registry: AdapterRegistry; probes: () => number } {
    let probes = 0;
    const adapter = {
      driver: "dsh",
      securityGuarantees: { readonly: "os_sandbox", write: "os_sandbox" },
      mapEffort: (effort: string) => effort,
      buildInvocation: async () => { throw new Error("not used"); },
      createStreamParser: () => { throw new Error("not used"); },
      probe: async (harnessId: string, harness: HarnessConfig): Promise<HarnessHealth> => {
        probes += 1;
        return {
          harness: harnessId, driver: "dsh", enabled: harness.enabled, installed: true, auth_status: "ready",
          security_guarantees: { readonly: "os_sandbox", write: "os_sandbox" }, checked_at: new Date().toISOString(),
        };
      },
    } as unknown as CliAdapter;
    return { registry: new AdapterRegistry({ adapters: [adapter] }), probes: () => probes };
  }
  const base = { driver: "dsh", display_name: "Fake", binary: "fake-cli", enabled: true } as HarnessConfig;

  it.each([
    ["profile", { profile: "other" }],
    ["extra_args", { extra_args: ["--flag"] }],
  ] as const)("re-probes when %s changes", async (_field, change) => {
    const { registry, probes } = countingRegistry();
    await registry.probeHarness("dsh", base);
    await registry.probeHarness("dsh", base);
    expect(probes()).toBe(1);
    await registry.probeHarness("dsh", { ...base, ...change });
    expect(probes()).toBe(2);
    expect(registry.getCachedHealth("dsh", base)).toBeDefined();
  });
});

describe("fx identity notes name the configured binary", () => {
  const adapter = new FxAdapter();

  it("names a custom binary when --help does not identify fx", async () => {
    const binary = fakeBinary("custom-fx-viewer", `
      const args = process.argv.slice(2);
      if (args[0] === "--help") console.log("fx - interactive JSON viewer");
      else if (args[0] === "--version") console.log("1.0.0");
      else console.log("{}");
    `);
    const harness = { driver: "fx", display_name: "Fx", binary, enabled: true } as HarnessConfig;
    const health = await adapter.probe("fx", harness, { timeoutMs: 5000 });
    expect(health.installed).toBe(false);
    expect(health.note).toContain(JSON.stringify(binary));
    expect(health.note).not.toContain("'fx'");
  });

  it("names a custom binary when it does not answer --help", async () => {
    const binary = fakeBinary("custom-fx-silent", "setTimeout(() => {}, 60000);");
    const harness = { driver: "fx", display_name: "Fx", binary, enabled: true } as HarnessConfig;
    const health = await adapter.probe("fx", harness, { timeoutMs: 300 });
    expect(health.probe_inconclusive).toBe(true);
    expect(health.note).toContain(`\`${binary} --help\``);
  });
});
