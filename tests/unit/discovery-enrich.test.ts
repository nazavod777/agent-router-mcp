import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModelSchema } from "../../src/config/schema.js";
import { entityIdProblem } from "../../src/config/ids.js";
import {
  MAX_PREVIEW_CANDIDATES, buildCandidates, mergeDiscoveredModels, normalizeRoute,
  type DiscoveredModel, type DiscoveryCandidate, type HarnessDiscoveryResult,
} from "../../src/discovery/index.js";
import { FIXED_NOW, USER_CONFIG, listed, makeWorld, type DiscoveryWorld } from "./helpers/discovery-fixture.js";
import type { DriverKind } from "../../src/drivers.js";

let world: DiscoveryWorld | undefined;
afterEach(() => {
  if (world) rmSync(world.root, { recursive: true, force: true });
  world = undefined;
});

function result(harness: string, driver: DriverKind, models: DiscoveredModel[]): HarnessDiscoveryResult {
  return { harness, driver, observed_at: FIXED_NOW.toISOString(), status: "ok", models, diagnostics: [], truncated: false };
}

function build(results: HarnessDiscoveryResult[], options: { providers?: "configured" | "all"; now?: Date } = {}) {
  return buildCandidates({ config: world!.snapshot(), results, providers: options.providers ?? "configured", now: options.now ?? FIXED_NOW });
}

function only(candidates: readonly DiscoveryCandidate[]): DiscoveryCandidate {
  expect(candidates).toHaveLength(1);
  return candidates[0];
}

describe("route normalization follows each driver's invocation rules", () => {
  it("folds provider/model for pi and opencode, fills default providers for pi and dsh", () => {
    const pi = { default_upstream_provider: "opencode-go" };
    expect(normalizeRoute("pi", pi, { cli_model: "deepseek-v4-pro" })).toEqual({ provider: "opencode-go", model: "deepseek-v4-pro" });
    expect(normalizeRoute("pi", pi, { cli_model: "x/y" })).toEqual({ provider: "x", model: "y" });
    expect(normalizeRoute("pi", pi, { cli_model: "a/b", cli_provider: "x" })).toEqual({ provider: "x", model: "a/b" });
    expect(normalizeRoute("pi", {}, { cli_model: "bare" })).toEqual({ model: "bare" });
    expect(normalizeRoute("opencode", {}, { cli_model: "deepinfra/deepseek-ai/DeepSeek-V4-Pro" }))
      .toEqual({ provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Pro" });
    expect(normalizeRoute("opencode", {}, { cli_model: "deepseek-ai/DeepSeek-V4-Pro", cli_provider: "deepinfra" }))
      .toEqual({ provider: "deepinfra", model: "deepseek-ai/DeepSeek-V4-Pro" });
    expect(normalizeRoute("dsh", {}, { cli_model: "m" })).toEqual({ provider: "deepseek-official", model: "m" });
    expect(normalizeRoute("dsh", { default_upstream_provider: "mine" }, { cli_model: "m" })).toEqual({ provider: "mine", model: "m" });
    expect(normalizeRoute("claude", {}, { cli_model: "m", cli_provider: "ignored" })).toEqual({ model: "m" });
    expect(normalizeRoute("fx", {}, { cli_model: "m", cli_provider: "openai" })).toEqual({ provider: "openai", model: "m" });
  });
});

describe("merge and deduplicate", () => {
  it("prefers exact structured context over rounded listing data and keeps reported_available", () => {
    world = makeWorld();
    const merged = mergeDiscoveredModels("pi", { default_upstream_provider: undefined }, [
      listed("gpt-5", { cli_provider: "openai", context_window: 400_000, context_precision: "rounded" }),
      { cli_model: "gpt-5", cli_provider: "openai", display_name: "GPT-5", context_window: 400_321, context_precision: "exact",
        availability: "configured", evidence: "local_config", reasoning: true },
    ]);
    expect(merged).toEqual([{
      cli_model: "gpt-5", cli_provider: "openai", display_name: "GPT-5", context_window: 400_321, context_precision: "exact",
      reasoning: true, availability: "reported_available", evidence: "cli_listing",
    }]);
  });

  it("merges the same route written in different forms and drops blank ids", () => {
    world = makeWorld();
    const merged = mergeDiscoveredModels("opencode", {}, [
      listed("deepinfra/a/b"), listed("a/b", { cli_provider: "deepinfra" }), listed("   "), listed("other/c"),
    ]);
    expect(merged.map((model) => `${model.cli_provider}|${model.cli_model}`)).toEqual(["deepinfra|a/b", "other|c"]);
  });
});

describe("stage 1: match configured models, enabled or disabled", () => {
  it("matches pi models through the folded provider/model form and the default upstream provider", () => {
    world = makeWorld();
    for (const model of [listed("opencode-go/deepseek-v4-pro"), listed("deepseek-v4-pro"), listed("deepseek-v4-pro", { cli_provider: "opencode-go" })]) {
      const candidate = only(build([result("pi", "pi", [model])]).candidates);
      expect(candidate).toMatchObject({ status: "already_configured", action: "none", existing_model_id: "pi-deepseek-v4-pro", proposed_id: "pi-deepseek-v4-pro" });
      expect(candidate.proposed_model).toBeUndefined();
    }
  });

  it("fills the default provider for dsh before matching", () => {
    world = makeWorld();
    expect(only(build([result("dsh", "dsh", [listed("deepseek-v4-pro")])]).candidates)).toMatchObject({ status: "already_configured", existing_model_id: "dsh-deepseek-v4-pro" });
    expect(only(build([result("dsh", "dsh", [listed("deepseek-v4-pro", { cli_provider: "deepseek-official" })])]).candidates).status).toBe("already_configured");
    expect(only(build([result("dsh", "dsh", [listed("deepseek-v4-pro", { cli_provider: "other-host" })])]).candidates).status).toBe("new");
  });

  it("proposes enabling a disabled built-in card", () => {
    world = makeWorld();
    const candidate = only(build([result("opencode", "opencode", [listed("openai/gpt-x")])]).candidates);
    expect(candidate).toMatchObject({ status: "disabled_in_catalog", action: "enable", existing_model_id: "oc-disabled", proposed_id: "oc-disabled" });
    expect(candidate.proposed_model).toBeUndefined();
  });

  it("reports several disabled matches as ambiguous with no action", () => {
    world = makeWorld({ user: USER_CONFIG });
    const candidate = only(build([result("opencode", "opencode", [listed("openai/gpt-y")])]).candidates);
    expect(candidate).toMatchObject({ status: "ambiguous", action: "none" });
    expect(candidate.existing_model_id).toBeUndefined();
  });

  it("treats a route that is configured on another harness as new for this harness", () => {
    world = makeWorld();
    expect(only(build([result("pi-alt", "pi", [listed("opencode-go/deepseek-v4-pro")])]).candidates).status).toBe("new");
  });
});

describe("stage 2: exact built-in template", () => {
  it("inherits portable metadata from a same-driver, same-provider template and intersects efforts", () => {
    world = makeWorld();
    const candidate = only(build([result("pi-alt", "pi", [listed("opencode-go/deepseek-v4-pro", { context_window: 1_000_000, context_precision: "rounded" })])]).candidates);
    expect(candidate).toMatchObject({ status: "new", action: "import", metadata_quality: "template", template_id: "pi-deepseek-v4-pro" });
    expect(candidate.proposed_model).toMatchObject({
      harness: "pi-alt", cli_model: "deepseek-v4-pro", cli_provider: "opencode-go", tier: "deep", vendor_family: "deepseek",
      cost_tier: "low", efforts: ["low", "high"], default_effort: "low", source: "discovered", metadata_quality: "template",
      template_id: "pi-deepseek-v4-pro", discovered_at: FIXED_NOW.toISOString(), context_window: 1_000_000, enabled: true,
    });
  });

  it("keeps template efforts the CLI itself reports as supported", () => {
    world = makeWorld();
    const candidate = only(build([result("pi-alt", "pi", [listed("opencode-go/deepseek-v4-pro", { native_efforts: ["off", "max"] })])]).candidates);
    expect(candidate.proposed_model?.efforts).toEqual(["off", "low", "high", "max"]);
  });

  it("uses a unique upstream match from another driver but does not copy a cost tier that is not comparable", () => {
    world = makeWorld();
    const candidate = only(build([result("gemini", "gemini", [listed("claude-opus-5-5")])]).candidates);
    expect(candidate).toMatchObject({ metadata_quality: "template", template_id: "claude-opus-5-5" });
    expect(candidate.proposed_model).toMatchObject({ tier: "deep", vendor_family: "anthropic", cost_tier: "medium", efforts: ["default"], default_effort: "default" });
  });

  it("falls back to the baseline when two templates match equally well (no guessing), and never matches fuzzily", () => {
    world = makeWorld();
    // Two built-in cards (pi and dsh) share this upstream model and neither is on the discovering driver: a guess, so baseline.
    const ambiguous = only(build([result("opencode", "opencode", [listed("someone/deepseek-v4-pro")])]).candidates);
    expect(ambiguous.metadata_quality).toBe("baseline");
    expect(only(build([result("cursor", "cursor", [listed("deepseek-v4-pro")])]).candidates).metadata_quality).toBe("baseline");
    const prefix = only(build([result("claude", "claude", [listed("claude-opus-5")])]).candidates);
    expect(prefix.metadata_quality).toBe("baseline");
    expect(prefix.template_id).toBeUndefined();
  });

  it("never uses user-made or overridden cards as templates", () => {
    world = makeWorld({ user: USER_CONFIG });
    const candidate = only(build([result("claude", "claude", [listed("gpt-y")])]).candidates);
    expect(candidate.metadata_quality).toBe("baseline");
  });
});

describe("stage 3: honest baseline", () => {
  it("synthesizes a conservative, schema-valid card and leaves unknown facts out", () => {
    world = makeWorld();
    const candidate = only(build([result("pi", "pi", [listed("my-local-llm", { cli_provider: "ollama" })])]).candidates);
    expect(candidate).toMatchObject({ status: "new", action: "import", metadata_quality: "baseline" });
    const model = candidate.proposed_model;
    expect(model).toMatchObject({
      harness: "pi", cli_model: "my-local-llm", cli_provider: "ollama", display_name: "my-local-llm", tier: "standard", cost_tier: "medium",
      efforts: ["low", "medium", "high"], default_effort: "low", strengths: ["Auto-discovered from pi CLI"], weaknesses: [], best_for: [],
      avoid_for: [], cost_note: "Unverified (auto-discovered)", speed_note: "Unverified (auto-discovered)", source: "discovered",
      metadata_quality: "baseline", discovered_at: FIXED_NOW.toISOString(), enabled: true,
    });
    expect(model).not.toHaveProperty("context_window");
    expect(model).not.toHaveProperty("checked_at");
    expect(model).not.toHaveProperty("template_id");
    expect(model).not.toHaveProperty("vendor_family"); // ollama only hosts the model: no vendor is claimed
    expect(ModelSchema.safeParse({ ...model, custom: true }).success).toBe(true);
  });

  it("uses default efforts per driver capability and infers a known vendor", () => {
    world = makeWorld();
    const [gemini] = build([result("gemini", "gemini", [listed("qwen3-coder-next", { context_window: 262_144, context_precision: "exact" })])]).candidates;
    expect(gemini.proposed_model).toMatchObject({ efforts: ["default"], default_effort: "default", context_window: 262_144 });
    expect(typeof gemini.proposed_model?.vendor_family).toBe("string");
    const [nonReasoning] = build([result("pi", "pi", [listed("plain", { cli_provider: "ollama", reasoning: false })])]).candidates;
    expect(nonReasoning.proposed_model?.efforts).toEqual(["default"]);
  });

  it("skips models a driver cannot route (opencode without a provider) and counts them", () => {
    world = makeWorld();
    const built = build([result("opencode", "opencode", [listed("bare-model"), listed("p/ok")])]);
    expect(built.candidates.map((candidate) => candidate.discovered.cli_model)).toEqual(["ok"]);
    expect(built.unroutable).toEqual({ opencode: 1 });
  });

  it("hides unconnected providers unless all providers are requested", () => {
    world = makeWorld();
    const models = [listed("a", { cli_provider: "x" }), listed("b", { cli_provider: "y", availability: "unconnected" })];
    expect(build([result("pi", "pi", models)]).candidates).toHaveLength(1);
    expect(build([result("pi", "pi", models)], { providers: "all" }).candidates).toHaveLength(2);
  });
});

describe("deterministic, collision-free ID allocation", () => {
  const ids = (candidates: readonly DiscoveryCandidate[]) => candidates.map((candidate) => candidate.proposed_id);

  it("avoids existing model IDs, disabled cards, and aliases", () => {
    world = makeWorld({ user: USER_CONFIG });
    const built = build([result("claude", "claude", [listed("taken-alias"), listed("oc-disabled"), listed("dup-a"), listed("fresh")])]);
    const byModel = Object.fromEntries(built.candidates.map((candidate) => [candidate.discovered.cli_model, candidate.proposed_id]));
    expect(byModel["taken-alias"]).toBe("claude-taken-alias");
    expect(byModel["oc-disabled"]).toBe("claude-oc-disabled");
    expect(byModel["dup-a"]).toBe("claude-dup-a");
    expect(byModel.fresh).toBe("fresh");
  });

  it("separates batch collisions with the harness prefix and then a short deterministic hash", () => {
    world = makeWorld();
    const models = [listed("GPT-X", { cli_provider: "p1" }), listed("gpt-x", { cli_provider: "p2" }), listed("Gpt-X", { cli_provider: "p3" })];
    const first = ids(build([result("pi", "pi", models)]).candidates);
    expect(first[0]).toBe("gpt-x");
    expect(first[1]).toBe("pi-gpt-x");
    expect(first[2]).toMatch(/^pi-gpt-x-[0-9a-f]{8}$/);
    expect(new Set(first.map((id) => id.toLowerCase())).size).toBe(3);
    expect(ids(build([result("pi", "pi", [...models].reverse())]).candidates)).toEqual(first);
  });

  it("produces valid IDs from slashes, colons, spaces, long and degenerate names", () => {
    world = makeWorld();
    const models = [
      listed("deepseek-ai/DeepSeek-V4-Pro", { cli_provider: "deepinfra" }), listed("qwen3:32b", { cli_provider: "ollama" }),
      listed("Model With Spaces!!", { cli_provider: "p" }), listed("a".repeat(300), { cli_provider: "p" }), listed("!!!", { cli_provider: "p" }),
      listed("x..y//z", { cli_provider: "p" }), listed("-lead", { cli_provider: "p" }),
    ];
    const built = build([result("opencode", "opencode", models)]);
    expect(built.candidates).toHaveLength(models.length);
    for (const candidate of built.candidates) expect(entityIdProblem(candidate.proposed_id), candidate.proposed_id).toBeUndefined();
    const byModel = Object.fromEntries(built.candidates.map((candidate) => [candidate.discovered.cli_model, candidate.proposed_id]));
    expect(byModel["deepseek-ai/DeepSeek-V4-Pro"]).toBe("deepseek-ai/deepseek-v4-pro");
    expect(byModel["qwen3:32b"]).toBe("qwen3:32b");
    expect(byModel["Model With Spaces!!"]).toBe("model-with-spaces");
    expect(byModel["a".repeat(300)]).toHaveLength(128);
    expect(byModel["!!!"]).toBe("model");
    expect(new Set(ids(built.candidates)).size).toBe(models.length);
  });

  it("makes proposed models that import cleanly through the config writer", async () => {
    world = makeWorld();
    const built = build([result("opencode", "opencode", [listed("deepinfra/deepseek-ai/DeepSeek-V4-Pro"), listed("p/qwen3:32b")]),
      result("pi", "pi", [listed("my-local-llm", { cli_provider: "ollama" })])]);
    const create = Object.fromEntries(built.candidates.map((candidate) => [candidate.proposed_id, candidate.proposed_model!]));
    const imported = await world!.writer.importModels({ create });
    expect(imported.imported.sort()).toEqual(Object.keys(create).sort());
    expect(imported.snapshot.config_warnings).toEqual([]);
    expect(imported.snapshot.models["deepseek-ai/deepseek-v4-pro"]).toMatchObject({ source: "discovered", custom: true, enabled: true });
  });

  it("keeps keys stable across observation times and changes them when material metadata changes", () => {
    world = makeWorld();
    const run = (now: Date, context: number) => only(build([result("pi", "pi", [listed("m", { cli_provider: "ollama", context_window: context })])], { now }).candidates);
    const a = run(FIXED_NOW, 1000);
    expect(run(new Date("2027-01-01T00:00:00Z"), 1000).key).toBe(a.key);
    expect(run(FIXED_NOW, 2000).key).not.toBe(a.key);
    expect(a.key).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("limits", () => {
  it("caps the preview at 1,000 candidates and reports the total", () => {
    world = makeWorld();
    const models = Array.from({ length: MAX_PREVIEW_CANDIDATES + 200 }, (_, index) => listed(`model-${index}`, { cli_provider: "p" }));
    const built = build([result("pi", "pi", models)]);
    expect(built.candidates).toHaveLength(MAX_PREVIEW_CANDIDATES);
    expect(built.total).toBe(MAX_PREVIEW_CANDIDATES + 200);
    expect(built.truncated).toBe(true);
    expect(new Set(built.candidates.map((candidate) => candidate.proposed_id.toLowerCase())).size).toBe(MAX_PREVIEW_CANDIDATES);
  });

  it("ignores results for harnesses that are not configured", () => {
    world = makeWorld();
    expect(build([result("ghost", "pi", [listed("x", { cli_provider: "p" })])]).candidates).toEqual([]);
  });
});
