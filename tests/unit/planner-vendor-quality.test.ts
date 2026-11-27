import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigManager, type ConfigSnapshot } from "../../src/config/resolver.js";
import { buildPlanPreview, suggestRuntimeAlternatives } from "../../src/planner/preview.js";
import { UNKNOWN_VENDOR, inferVendorFamily, isAggregatorProvider, isKnownVendor } from "../../src/roles/registry.js";
import type { DriverKind } from "../../src/types.js";

const CATALOG_PATH = join(import.meta.dirname, "../../defaults/catalog.toml");
const MISSING_USER_PATH = join(import.meta.dirname, "__no_user_config__.toml");

function loadConfig(): ConfigSnapshot {
  return structuredClone(new ConfigManager({
    defaultPath: CATALOG_PATH,
    userPath: MISSING_USER_PATH,
    now: () => new Date("2026-11-26T00:00:00Z"),
  }).load());
}

/** A snapshot where only the given models (copies of real cards) are enabled. */
function configWithOnly(models: Record<string, Partial<ConfigSnapshot["models"][string]> & { copyOf: string }>): ConfigSnapshot {
  const config = loadConfig();
  for (const model of Object.values(config.models)) model.enabled = false;
  for (const [id, { copyOf, ...changes }] of Object.entries(models)) {
    config.models[id] = { ...structuredClone(config.models[copyOf]), cli_model: id, enabled: true, ...changes };
  }
  return config;
}

describe("inferVendorFamily with aggregator providers", () => {
  it.each([
    ["openrouter", "anthropic/claude-sonnet-5", "anthropic"],
    ["openrouter", "sonnet-5", "anthropic"],
    ["requesty", "gpt-6-mini", "openai"],
    ["opencode-go", "deepseek-v4", "deepseek"],
    ["together", "glm-5.2", "zhipu"],
    ["fireworks", "qwen3-coder", "alibaba"],
    ["groq", "kimi-k3", "moonshot"],
    ["litellm", "grok-4", "xai"],
    ["ollama", "devstral-small", "mistral"],
    ["bedrock", "mistral-large", "mistral"],
    ["vertex", "gemini-4", "google"],
  ])("%s hosting %s resolves to the model's vendor %s", (cli_provider, cli_model, vendor) => {
    expect(inferVendorFamily({ harness: "pi", cli_model, cli_provider }, "pi")).toBe(vendor);
  });

  it("never names an aggregator as the vendor and returns unknown for a model it cannot place", () => {
    for (const cli_provider of ["openrouter", "OpenRouter", " lmstudio ", "vercel", "cloudflare", "azure", "deepinfra", "opencode"]) {
      expect(isAggregatorProvider(cli_provider)).toBe(true);
      expect(inferVendorFamily({ harness: "my-gateway", cli_model: "mystery-1", cli_provider }, "pi")).toBe(UNKNOWN_VENDOR);
    }
    // An aggregator harness name or driver's native vendor must not leak in either.
    expect(inferVendorFamily({ harness: "claude", cli_model: "mystery-1", cli_provider: "openrouter" }, "claude")).toBe(UNKNOWN_VENDOR);
  });

  it("treats a gateway named inside cli_model like a gateway named in cli_provider", () => {
    expect(inferVendorFamily({ harness: "opencode", cli_model: "openrouter/mystery" }, "opencode")).toBe(UNKNOWN_VENDOR);
    expect(inferVendorFamily({ harness: "opencode", cli_model: "openrouter/deepseek-v4" }, "opencode")).toBe("deepseek");
    expect(inferVendorFamily({ harness: "opencode", cli_model: "acme/mystery" }, "opencode")).toBe("opencode");
  });

  it("still lets an explicit vendor_family win and keeps a real provider as a vendor hint", () => {
    expect(inferVendorFamily({ harness: "pi", cli_model: "mystery-1", cli_provider: "openrouter", vendor_family: "Acme" }, "pi")).toBe("acme");
    expect(inferVendorFamily({ harness: "pi", cli_model: "mystery-1", cli_provider: "acme-labs" }, "pi" as DriverKind)).toBe("acme-labs");
  });

  it("places bare Anthropic model names", () => {
    for (const cli_model of ["sonnet", "opus-5", "haiku-5-5"]) {
      expect(inferVendorFamily({ harness: "pi", cli_model }, "pi")).toBe("anthropic");
    }
  });
});

describe("plan preview vendor independence and card quality", () => {
  it("does not offer an unknown-vendor model as an independent reviewer", () => {
    const subtasks = [
      { id: "author", title: "Write", task_type: "implementation", override: { model: "claude-opus-5-5" } },
      { id: "review", title: "Review", task_type: "review", override: { model: "gpt-6.2-sol" } },
    ];
    const lightCard = { copyOf: "claude-haiku-5-5", tier: "light" as const, best_for: [], strengths: [] };
    const base = { "claude-opus-5-5": { copyOf: "claude-opus-5-5" }, "gpt-6.2-sol": { copyOf: "gpt-6.2-sol" } };

    const independent = configWithOnly({ ...base, "other-lab-1": { ...lightCard, vendor_family: "other-lab" } });
    const reviewAlternatives = (config: ConfigSnapshot) =>
      buildPlanPreview({ config, subtasks }).items[1].alternatives.map((alternative) => alternative.model);
    expect(reviewAlternatives(independent)).toContain("other-lab-1");

    const unknown = configWithOnly({ ...base, "mystery-1": { ...lightCard, cli_provider: "openrouter" } });
    expect(inferVendorFamily(unknown.models["mystery-1"], "claude")).toBe(UNKNOWN_VENDOR);
    expect(reviewAlternatives(unknown)).not.toContain("mystery-1");
  });

  it.each([
    ["baseline loses to a curated card", { a: "baseline", b: "curated" }, "card-b"],
    ["baseline loses to a card without quality metadata", { a: "baseline", b: undefined }, "card-b"],
    ["a reviewed card beats a baseline card even when its ID sorts later", { a: "baseline", b: "reviewed" }, "card-b"],
    ["a template card loses to a reviewed card", { a: "template", b: "reviewed" }, "card-b"],
  ] as const)("when equally eligible, %s", (_name, qualities, expected) => {
    const config = configWithOnly({
      "card-a": { copyOf: "claude-sonnet-5-5", metadata_quality: qualities.a },
      "card-b": { copyOf: "claude-sonnet-5-5", metadata_quality: qualities.b },
    });
    const plan = buildPlanPreview({ config, subtasks: [{ id: "work", title: "Implement", task_type: "implementation" }] });
    expect(plan.items[0].model).toBe(expected);
  });
});

describe("unknown vendors in consultations and failover", () => {
  const MYSTERY = { copyOf: "claude-opus-5-5", cli_model: "mystery-1", cli_provider: "openrouter" } as const;

  it("keeps an equally relevant unknown-vendor model out of design-consult alternatives", () => {
    const config = configWithOnly({
      "claude-opus-5-5": { copyOf: "claude-opus-5-5" },
      "gpt-6.2-sol": { copyOf: "gpt-6.2-sol" },
      "mystery-1": MYSTERY,
    });
    expect(inferVendorFamily(config.models["mystery-1"], "claude")).toBe(UNKNOWN_VENDOR);
    const plan = buildPlanPreview({
      config, intent: "design_consult", host_vendor: "anthropic",
      subtasks: [
        { id: "design", title: "Design", task_type: "architecture", override: { model: "claude-opus-5-5" } },
        { id: "second", title: "Second opinion", task_type: "second_opinion", override: { model: "gpt-6.2-sol" } },
      ],
    });
    // Item 0 repeats the host's vendor, so it gets cross-vendor alternatives only.
    expect(plan.items[0].alternatives.map((alternative) => alternative.model)).toEqual(["gpt-6.2-sol"]);
  });

  it("ranks a known other vendor above an unknown one when failing over from a vendor outage", () => {
    const config = configWithOnly({
      "claude-opus-5-5": { copyOf: "claude-opus-5-5" },
      "a-mystery": { copyOf: "gpt-6.2-sol", cli_model: "mystery-1", cli_provider: "openrouter" },
      "z-known": { copyOf: "gpt-6.2-sol", cli_model: "gpt-6.2-sol" },
    });
    const harness = (id: string) => ({
      harness: id, driver: id as DriverKind, enabled: true, installed: true, auth_status: "ready" as const,
      security_guarantees: { readonly: "os_sandbox" as const, write: "os_sandbox" as const }, checked_at: "2026-11-26T00:00:00Z",
    });
    const alternatives = suggestRuntimeAlternatives({
      config, healthByHarness: { claude: harness("claude"), codex: harness("codex") },
      failedHarness: "claude", failedModel: "claude-opus-5-5", mode: "readonly", failureScope: "harness", errorCode: "QUOTA_EXCEEDED",
    });
    expect(alternatives.map((alternative) => alternative.model)).toEqual(["z-known", "a-mystery"]);
  });
});

describe("P2-12: a Pi model inheriting its harness's upstream provider", () => {
  /** A Pi card with no provider of its own, on a harness that routes everything through OpenRouter (or not). */
  function configWithPiOpaque(upstream: string | undefined): ConfigSnapshot {
    const config = configWithOnly({
      "claude-opus-5-5": { copyOf: "claude-opus-5-5" },
      "gpt-6.2-sol": { copyOf: "gpt-6.2-sol" },
      "pi-mystery": { copyOf: "pi-deepseek-v4-pro", cli_model: "mystery-1", cli_provider: undefined, vendor_family: undefined },
    });
    if (upstream === undefined) delete config.harnesses.pi.default_upstream_provider;
    else config.harnesses.pi.default_upstream_provider = upstream;
    return config;
  }

  it("resolves to the unknown vendor when the inherited provider is an aggregator", () => {
    const model = { harness: "pi", cli_model: "mystery-1" };
    expect(inferVendorFamily(model, "pi", "openrouter")).toBe(UNKNOWN_VENDOR);
    // The model's own provider still wins over the harness default; without any provider the old result is unchanged.
    expect(inferVendorFamily({ ...model, cli_provider: "acme-labs" }, "pi", "openrouter")).toBe("acme-labs");
    expect(inferVendorFamily(model, "pi")).not.toBe(UNKNOWN_VENDOR);
  });

  it("keeps such a model out of cross-vendor design-consult alternatives and out of the UI's inferred vendors", () => {
    const subtasks = [
      { id: "design", title: "Design", task_type: "architecture", override: { model: "claude-opus-5-5" } },
      { id: "second", title: "Second opinion", task_type: "second_opinion", override: { model: "gpt-6.2-sol" } },
    ];
    const alternativesOf = (config: ConfigSnapshot) =>
      buildPlanPreview({ config, intent: "design_consult", host_vendor: "anthropic", subtasks }).items[0].alternatives.map((alternative) => alternative.model);

    expect(alternativesOf(configWithPiOpaque("openrouter"))).toEqual(["gpt-6.2-sol"]);
    // Control: without the aggregator the opaque model is wrongly treated as an independent vendor, which is the bug being guarded.
    expect(alternativesOf(configWithPiOpaque(undefined))).toContain("pi-mystery");
  });

  it("ranks it below a known vendor in runtime failover after a vendor outage", () => {
    const health = (harness: string, driver: DriverKind) => ({
      harness, driver, enabled: true, installed: true, auth_status: "ready" as const,
      security_guarantees: { readonly: "os_sandbox" as const, write: "os_sandbox" as const }, checked_at: "2026-11-26T00:00:00Z",
    });
    const failover = (config: ConfigSnapshot) => suggestRuntimeAlternatives({
      config, healthByHarness: { claude: health("claude", "claude"), codex: health("codex", "codex"), pi: health("pi", "pi") },
      failedHarness: "claude", failedModel: "claude-opus-5-5", mode: "readonly", failureScope: "harness", errorCode: "QUOTA_EXCEEDED",
    }).map((alternative) => alternative.model);
    expect(failover(configWithPiOpaque("openrouter"))).toEqual(["gpt-6.2-sol", "pi-mystery"]);
    // Control: treated as a vendor of its own ("pi"), the opaque model would be preferred ahead of the known one.
    expect(failover(configWithPiOpaque(undefined))[0]).toBe("pi-mystery");
  });
});

describe("P2-12 (scope): the inherited provider only counts for drivers that route through it", () => {
  it("ignores harness.default_upstream_provider for a driver that never reads it", () => {
    const model = { harness: "claude", cli_model: "mystery-1" };
    expect(inferVendorFamily(model, "claude", "bedrock")).toBe(inferVendorFamily(model, "claude"));
    expect(inferVendorFamily(model, "pi", "bedrock")).toBe(UNKNOWN_VENDOR);
  });
});

describe("an unknown vendor never confirms independence", () => {
  const MYSTERY = { copyOf: "claude-opus-5-5", cli_model: "mystery-1", cli_provider: "openrouter" } as const;
  const base = { "claude-opus-5-5": { copyOf: "claude-opus-5-5" }, "gpt-6.2-sol": { copyOf: "gpt-6.2-sol" } };
  const consult = (model: string) => [
    { id: "design", title: "Design", task_type: "architecture", override: { model } },
    { id: "second", title: "Second opinion", task_type: "second_opinion", override: { model: "gpt-6.2-sol" } },
  ];

  it("isKnownVendor accepts only an identified vendor", () => {
    for (const vendor of [UNKNOWN_VENDOR, "Unknown", " unknown ", "", "  ", undefined]) expect(isKnownVendor(vendor), String(vendor)).toBe(false);
    for (const vendor of ["anthropic", "acme-labs"]) expect(isKnownVendor(vendor), vendor).toBe(true);
    // An explicit vendor_family of "unknown" is the unknown vendor, however it is spelled.
    expect(isKnownVendor(inferVendorFamily({ harness: "pi", cli_model: "x", vendor_family: " Unknown " }, "pi"))).toBe(false);
  });

  it("warns on a design-consult advisor whose vendor cannot be determined, but not on a known one", () => {
    const config = configWithOnly({ ...base, "mystery-1": MYSTERY });
    expect(inferVendorFamily(config.models["mystery-1"], "claude")).toBe(UNKNOWN_VENDOR);
    const plan = buildPlanPreview({ config, intent: "design_consult", host_vendor: "anthropic", subtasks: consult("mystery-1") });
    expect(plan.items[0].warnings).toContainEqual(expect.stringContaining("advisor's vendor could not be determined"));
    expect(plan.items[1].warnings.join(" ")).not.toContain("could not be determined");
    const known = buildPlanPreview({ config, intent: "design_consult", host_vendor: "google", subtasks: consult("claude-opus-5-5") });
    expect(known.items.flatMap((item) => item.warnings).join(" ")).not.toContain("could not be determined");
  });

  it("does not report two unknown advisors as an independent pair", () => {
    const config = configWithOnly({ ...base, "mystery-1": MYSTERY, "mystery-2": { ...MYSTERY, cli_model: "mystery-2" } });
    const plan = buildPlanPreview({
      config, intent: "design_consult",
      subtasks: [
        { id: "a", title: "A", task_type: "architecture", override: { model: "mystery-1" } },
        { id: "b", title: "B", task_type: "second_opinion", override: { model: "mystery-2" } },
      ],
    });
    for (const item of plan.items) expect(item.warnings).toContainEqual(expect.stringContaining("could not be determined"));
  });

  it("flags a review as independence-unverified when either the reviewer's or the author's vendor is unknown", () => {
    const subtasks = (author: string, reviewer: string) => [
      { id: "author", title: "Write", task_type: "implementation", override: { model: author } },
      { id: "review", title: "Review", task_type: "review", override: { model: reviewer } },
    ];
    const config = configWithOnly({ ...base, "mystery-1": MYSTERY });
    const unverified = (warnings: string[]) => warnings.some((warning) => warning.startsWith("independence unverified"));
    expect(unverified(buildPlanPreview({ config, subtasks: subtasks("claude-opus-5-5", "mystery-1") }).items[1].warnings)).toBe(true);
    expect(unverified(buildPlanPreview({ config, subtasks: subtasks("mystery-1", "gpt-6.2-sol") }).items[1].warnings)).toBe(true);
    // Control: known and different vendors stay quiet, and a same-vendor pair keeps its own, stronger warning.
    const clean = buildPlanPreview({ config, subtasks: subtasks("claude-opus-5-5", "gpt-6.2-sol") }).items[1].warnings;
    expect(unverified(clean)).toBe(false);
    expect(clean.some((warning) => warning.startsWith("self-review"))).toBe(false);
    const same = buildPlanPreview({ config, subtasks: subtasks("claude-opus-5-5", "claude-opus-5-5") }).items[1].warnings;
    expect(same.some((warning) => warning.startsWith("self-review"))).toBe(true);
  });

  it("offers no reviewer alternative as independent while an author's vendor is unknown", () => {
    const config = configWithOnly({
      ...base, "mystery-1": MYSTERY, "gemini-x": { copyOf: "gpt-6.2-sol", vendor_family: "google", tier: "light" as const },
    });
    const alternativesFor = (author: string) => buildPlanPreview({
      config, subtasks: [
        { id: "author", title: "Write", task_type: "implementation", override: { model: author } },
        { id: "review", title: "Review", task_type: "review", override: { model: "gpt-6.2-sol" } },
      ],
    }).items[1].alternatives.map((alternative) => alternative.model);
    // Control: with a known author the third vendor is the confirmed independent pick and leads.
    expect(alternativesFor("claude-opus-5-5")[0]).toBe("gemini-x");
    // The unknown author could itself be that vendor, so the third vendor loses its independent standing and drops out.
    expect(alternativesFor("mystery-1")).not.toContain("gemini-x");
  });
});
