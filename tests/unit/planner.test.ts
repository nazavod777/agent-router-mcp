import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigManager, type ConfigSnapshot } from "../../src/config/resolver.js";
import { PlanPreviewError, buildPlanPreview, delegationAvailability, suggestRuntimeAlternatives, type PlanSubtaskInput } from "../../src/planner/preview.js";
import { ROLES, inferVendorFamily, keywordsForRole } from "../../src/roles/registry.js";
import type { DriverKind, HarnessHealth } from "../../src/types.js";

const CATALOG_PATH = join(import.meta.dirname, "../../defaults/catalog.toml");
const MISSING_USER_PATH = join(import.meta.dirname, "__no_user_config__.toml");
const FRESH_DATE = new Date("2026-11-26T00:00:00Z");
const STALE_DATE = new Date("2027-06-01T00:00:00Z");

function loadConfig(now = FRESH_DATE): ConfigSnapshot {
  return new ConfigManager({ defaultPath: CATALOG_PATH, userPath: MISSING_USER_PATH, now: () => now }).load();
}

function health(harness: string, fields: Partial<HarnessHealth> = {}): HarnessHealth {
  return {
    harness,
    driver: harness as HarnessHealth["driver"],
    enabled: true,
    installed: true,
    auth_status: "ready",
    security_guarantees: { readonly: "os_sandbox", write: "os_sandbox" },
    checked_at: FRESH_DATE.toISOString(),
    ...fields,
  };
}

function expectPlanError(run: () => unknown, code: string, messagePart: RegExp): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlanPreviewError);
    expect((error as PlanPreviewError).structured.code).toBe(code);
    expect((error as PlanPreviewError).message).toMatch(messagePart);
    return;
  }
  throw new Error("expected buildPlanPreview to throw");
}

it("matches UI as a word without matching letters inside unrelated words", () => {
  const matches = (note: string) => keywordsForRole("ui").some((pattern) => pattern.test(note));
  expect(matches("Build a UI")).toBe(true);
  for (const word of ["quick", "build", "requirements"]) expect(matches(word)).toBe(false);
});

describe("inferVendorFamily", () => {
  it.each([
    ["claude", "claude/opus", undefined, "anthropic"],
    ["codex", "gpt-6.2-sol", undefined, "openai"],
    ["dsh", "deepseek-v4-pro", undefined, "deepseek"],
    ["pi", "pi-deepseek-v4-pro", "opencode-go", "deepseek"],
    ["claude", "glm-5", undefined, "zhipu"],
    ["pi", "kimi-k3", "openrouter", "moonshot"],
    ["pi", "qwen3.8-max", undefined, "alibaba"],
    ["pi", "gemini-4-argon", undefined, "google"],
    ["pi", "MiniMax-M2", undefined, "minimax"],
    ["pi", "MiMo-V2", undefined, "xiaomi"],
    ["pi", "x-ai/grok-4", undefined, "xai"],
    ["pi", "custom-name", " DeepSeek-Official ", "deepseek"],
    ["pi", "custom-name", " Custom Vendor ", "custom vendor"],
  ] satisfies Array<[DriverKind, string, string | undefined, string]>)(
    "%s/%s uses the %s provider hint and resolves to %s",
    (driver, cli_model, cli_provider, vendor) => {
      expect(inferVendorFamily({ harness: driver, cli_model, cli_provider }, driver)).toBe(vendor);
    },
  );

  it.each([
    ["explicit vendor_family wins", "pi", { harness: "pi", cli_model: "claude-opus", vendor_family: " Custom-Lab " }, "custom-lab"],
    ["raw vendor prefix is kept", "claude", { harness: "claude", cli_model: "claude-opus-5-5" }, "anthropic"],
    ["meta via Muse", "muse", { harness: "muse", cli_model: "muse-spark-1.3" }, "meta"],
    ["meta via Llama", "opencode", { harness: "opencode", cli_model: "groq/llama-5-70b" }, "meta"],
    ["mistral via Devstral", "vibe", { harness: "vibe", cli_model: "devstral" }, "mistral"],
    ["mistral via the vibe harness", "vibe", { harness: "vibe", cli_model: "default" }, "mistral"],
    ["amazon via Nova", "opencode", { harness: "opencode", cli_model: "amazon-bedrock/nova-pro" }, "amazon"],
    ["google via Antigravity", "antigravity", { harness: "antigravity", cli_model: "gemini-4-neon" }, "google"],
    ["google via the agy- prefix", "antigravity", { harness: "agy-custom", cli_model: "default" }, "google"],
    ["google via Gemini CLI native vendor", "gemini", { harness: "my-gemini", cli_model: "default" }, "google"],
    ["xai via Grok Build", "grok", { harness: "grok", cli_model: "grok-4.7" }, "xai"],
    ["xai via the grok native vendor", "grok", { harness: "build-box", cli_model: "default" }, "xai"],
    ["driver prefix on a custom harness id", "pi", { harness: "kimi-cli", cli_model: "default" }, "moonshot"],
  ] satisfies Array<[string, DriverKind, Parameters<typeof inferVendorFamily>[0], string]>)("%s", (_name, driver, model, vendor) => {
    expect(inferVendorFamily(model, driver)).toBe(vendor);
  });
});

describe("buildPlanPreview", () => {
  const config = loadConfig();

  it.each([undefined, "", "   "])("uses the balanced preset for %j and maps roles to harness/model/effort", (preset) => {
    const result = buildPlanPreview({
      config,
      preset,
      subtasks: [
        { id: "a", title: "Design", task_type: "architecture" },
        { id: "b", title: "Review", task_type: "review" },
      ],
    });
    expect(result.preset).toBe("balanced");
    expect(result.plan_id).toMatch(/^plan_[0-9a-f]{12}$/);
    expect(result.items[0]).toMatchObject({
      harness: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      mode: "readonly",
      isolation: "shared",
      selection_source: "preset",
    });
    expect(result.items[1]).toMatchObject({ harness: "codex", model: "gpt-6.2-sol", security_guarantee: "os_sandbox" });
    expect(result.config_revision).toBe(config.revision);
  });

  it("uses Russian only when requested and lets tool input override the configured locale", () => {
    const input = {
      config,
      subtasks: [{ id: "a", title: "Design", task_type: "architecture" }],
      healthByHarness: { claude: health("claude", { auth_status: "unauthenticated" }) },
    };
    const configured = { ...input, config: { ...config, defaults: { ...config.defaults, locale: "ru" as const } } };
    for (const plan of [buildPlanPreview({ ...input, locale: "ru" }), buildPlanPreview(configured)]) {
      expect(plan.markdown_table.split("\n")[0]).toBe("| # | Подзадача | Харнесс / Модель | Effort | Режим | Изоляция | Тир / Цена | Песочница | Плюсы и риски |");
      expect(plan.warnings).toContain("#1: харнесс claude не авторизован");
      expect(plan.items[0].alternatives[0].reason).toMatch(/[а-я]/);
    }
    expect(buildPlanPreview({ ...configured, locale: "en" }).warnings).toContain("#1: harness claude is not authenticated");
  });

  it("generates unique plan ids", () => {
    const subtasks = [{ id: "a", title: "x", task_type: "review" }];
    expect(buildPlanPreview({ config, subtasks }).plan_id).not.toBe(buildPlanPreview({ config, subtasks }).plan_id);
  });

  it.each([
    [" Planning ", "architecture", "readonly"],
    ["test_implementation", "testing", "write"],
    ["sql_data", "data_sql", "readonly"],
    ["docs", "writing", "write"],
  ] as const)("routes %s through the canonical %s preset role", (alias, canonical, mode) => {
    const expanded = structuredClone(config);
    const roles = expanded.presets.balanced.roles;
    roles[canonical] ??= roles.implementation;
    const result = buildPlanPreview({
      config: expanded,
      subtasks: [{ id: "a", title: "Alias", task_type: alias }],
    });
    expect(result.items[0]).toMatchObject({
      ...roles[canonical], task_type: alias, mode, selection_source: "preset",
    });
  });

  it("uses an exact custom preset role before resolving its alias", () => {
    const expanded = structuredClone(config);
    const roles = expanded.presets.balanced.roles;
    roles.planning = roles.implementation;
    const result = buildPlanPreview({
      config: expanded,
      subtasks: [{ id: "a", title: "Design", task_type: "planning" }],
    });
    expect(result.items[0]).toMatchObject({ ...roles.planning, mode: "readonly", selection_source: "preset" });
  });

  it.each([
    ["gpt-6.2-sol", "gpt-6.2-sol", "review", "openai"],
    ["deepseek-v4-pro", "pi-deepseek-v4-pro", "security_review", "deepseek"],
    ["pi-deepseek-v4-pro", "deepseek-v4-pro", "second_opinion", "deepseek"],
  ])("warns on self-review by %s and %s", (author, reviewer, role, vendor) => {
    const result = buildPlanPreview({
      config,
      subtasks: [
        { id: "review", title: "Review", task_type: role, override: { model: reviewer } },
        { id: "impl", title: "Implement", task_type: "backend", override: { model: author } },
      ],
    });
    const warning = `self-review — same vendor (${vendor}) as change author; pick another harness/vendor for independent review`;
    expect(result.items[0].warnings).toContain(warning);
    expect(result.warnings).toContain(`#1: ${warning}`);
    expect(result.markdown_table).toContain("⚠ self-review");
  });

  const advisors: PlanSubtaskInput[] = [
    { id: "first", title: "Research design", task_type: "research", override: { model: "deepseek-v4-pro" } },
    { id: "second", title: "Check design", task_type: "research", override: { model: "pi-deepseek-v4-pro" } },
  ];

  it.each([
    [undefined, undefined, /all advisors resolve to one vendor \(deepseek\)/],
    ["ru", undefined, /все советники от одного вендора \(deepseek\)/],
    [undefined, "deepseek", /same vendor \(deepseek\) as the host agent/],
    ["ru", "deepseek", /того же вендора \(deepseek\), что и главный агент/],
  ] as const)("warns design advisors about vendor concentration (locale %s, host %s)", (locale, host_vendor, warning) => {
    const plan = buildPlanPreview({ config, intent: "design_consult", host_vendor, locale, subtasks: advisors });
    expect(plan.warnings).toContainEqual(expect.stringMatching(warning));
    for (const item of plan.items) {
      expect(item.warnings).toContainEqual(expect.stringMatching(warning));
      expect(item.alternatives.length).toBeGreaterThan(0);
      for (const { model, harness } of item.alternatives) {
        expect(inferVendorFamily(config.models[model], config.harnesses[harness].driver)).not.toBe("deepseek");
      }
    }
  });

  it("omits consult warnings for ordinary readonly research and for a mixed-vendor consultation", () => {
    const general = buildPlanPreview({ config, subtasks: advisors, intent: "general", host_vendor: "deepseek" });
    const diverse = buildPlanPreview({ config, intent: "design_consult", host_vendor: "anthropic",
      subtasks: [advisors[0], { ...advisors[1], override: { model: "gpt-6.2-sol" } }] });
    for (const plan of [general, diverse]) {
      expect(plan.warnings.join(" ")).not.toContain("design consultation");
    }
  });

  const consultPair: PlanSubtaskInput[] = [
    { id: "arch", title: "Architecture", task_type: "architecture", override: { model: "deepseek-v4-pro" } },
    { id: "second", title: "Second opinion", task_type: "second_opinion", override: { model: "pi-deepseek-v4-pro" } },
  ];

  it("treats architecture + second_opinion as a consultation only when intent is omitted, never for an explicit general", () => {
    const consultation = /design consultation/;
    const omitted = buildPlanPreview({ config, subtasks: consultPair });
    expect(omitted.warnings.join(" ")).toMatch(consultation);
    const general = buildPlanPreview({ config, subtasks: consultPair, intent: "general", host_vendor: "deepseek" });
    expect(general.warnings.join(" ")).not.toMatch(consultation);
  });

  it("warns on each advisor matching the host vendor even when another advisor differs, and on write-only consultations", () => {
    const plan = buildPlanPreview({ config, intent: "design_consult", host_vendor: "deepseek",
      subtasks: [consultPair[0], { ...consultPair[1], override: { model: "gpt-6.2-sol" } }] });
    expect(plan.items[0].warnings).toContainEqual(expect.stringMatching(/same vendor \(deepseek\) as the host agent/));
    expect(plan.items[1].warnings.join(" ")).not.toContain("design consultation");

    const noAdvisors = buildPlanPreview({ config, intent: "design_consult",
      subtasks: [{ id: "impl", title: "Implement", task_type: "implementation", mode: "write" }] });
    expect(noAdvisors.warnings).toContainEqual(expect.stringMatching(/design consultation expects readonly advisory subtasks/));
    const general = buildPlanPreview({ config,
      subtasks: [{ id: "impl", title: "Implement", task_type: "implementation", mode: "write" }] });
    expect(general.warnings.join(" ")).not.toContain("design consultation");
  });

  it("offers installed, authenticated alternatives before missing ones", () => {
    const healthByHarness = Object.fromEntries(Object.keys(config.harnesses).map((id) => [id, health(id, { installed: false })]));
    healthByHarness.claude = health("claude");
    healthByHarness.gemini = health("gemini");
    const plan = buildPlanPreview({ config, healthByHarness,
      subtasks: [{ id: "a", title: "Design", task_type: "architecture", override: { model: "claude-sonnet-5-5" } }] });
    const harnesses = plan.items[0].alternatives.map((alternative) => alternative.harness);
    expect(harnesses).toContain("gemini");
    expect(harnesses).not.toContain("antigravity");
    expect(harnesses.every((id) => ["claude", "gemini"].includes(id))).toBe(true);
  });

  it("prioritizes review alternatives from vendors outside the author's and reviewer's families", () => {
    const result = buildPlanPreview({
      config,
      subtasks: [
        { id: "impl", title: "Implement", task_type: "implementation", override: { model: "deepseek-v4-pro" } },
        { id: "review", title: "Review", task_type: "review", override: { model: "gpt-6.2-sol" } },
      ],
    });
    const review = result.items[1];
    expect(review.warnings.join("\n")).not.toContain("self-review");
    expect(review.alternatives).toHaveLength(2);
    for (const alternative of review.alternatives) {
      expect(alternative.model).not.toMatch(/gpt|deepseek/);
    }
  });

  it("treats explicit writes as authors and excludes the reviewer itself from the warning", () => {
    const review = {
      id: "review", title: "Review and annotate", task_type: "review", mode: "write", override: { model: "gpt-6.2-sol" },
    } satisfies PlanSubtaskInput;
    const single = buildPlanPreview({ config, subtasks: [review] });
    expect(single.items[0].warnings.join("\n")).not.toContain("self-review");

    const result = buildPlanPreview({
      config,
      subtasks: [review, {
        id: "custom", title: "Edit", task_type: "custom_role", mode: "write", override: { model: "gpt-6.2-sol" },
      }],
    });
    expect(result.items[0].warnings.join("\n")).toContain("self-review");
  });

  /** Exact preset IDs shipped in defaults/catalog.toml; a missing one must fail, never fall back to another preset. */
  const BUILTIN_PRESET_IDS = [
    "balanced", "max-quality", "budget", "open-weights", "ui-sprint", "security-audit", "deep-refactor", "fast-sprint",
  ];

  it("ships every built-in preset id in the original catalog and nothing else", () => {
    expect(Object.keys(config.presets).sort()).toEqual([...BUILTIN_PRESET_IDS].sort());
  });

  it.each(BUILTIN_PRESET_IDS)("routes all 23 canonical roles with the %s preset from the original catalog", (preset) => {
    const presetConfig = config.presets[preset];
    expect(presetConfig, `catalog preset ${preset}`).toBeDefined();
    const subtasks = Object.keys(ROLES).map((role) => ({ id: role, title: role, task_type: role }));
    const result = buildPlanPreview({ config, subtasks, preset });
    expect(result.items).toHaveLength(23);
    expect(result.items.filter((item) => item.mode === "readonly")).toHaveLength(13);
    expect(result.items.filter((item) => item.mode === "write")).toHaveLength(10);
    for (const item of result.items) {
      const selected = presetConfig.roles[item.task_type];
      if (selected) {
        expect(item).toMatchObject({ ...selected, selection_source: "preset" });
      } else {
        expect(item.selection_source).toBe("catalog_match");
      }
      expect(config.models[item.model].efforts).toContain(item.effort);
    }
  });

  it("resolves a different preset and rejects unknown or disabled presets", () => {
    const budget = buildPlanPreview({ config, preset: "budget", subtasks: [{ id: "a", title: "Impl", task_type: "implementation" }] });
    expect(budget.items[0]).toMatchObject({
      ...config.presets.budget.roles.implementation, mode: "write", selection_source: "preset",
    });

    expectPlanError(() => buildPlanPreview({ config, preset: "nope", subtasks: [{ id: "a", title: "x", task_type: "review" }] }),
      "PLAN_NOT_FOUND", /does not exist/);

    const disabled = structuredClone(config);
    disabled.presets.budget.enabled = false;
    expectPlanError(() => buildPlanPreview({ config: disabled, preset: "budget", subtasks: [{ id: "a", title: "x", task_type: "review" }] }),
      "PLAN_NOT_FOUND", /disabled/);
  });

  it("applies explicit overrides, resolves aliases, and keeps the user's choice", () => {
    const result = buildPlanPreview({
      config,
      healthByHarness: { claude: health("claude", { auth_status: "unauthenticated" }) },
      subtasks: [
        { id: "a", title: "Review", task_type: "review", override: { model: "claude-sonnet", effort: "low" } },
        { id: "b", title: "Impl", task_type: "implementation", override: { harness: "codex" } },
        { id: "c", title: "Arch", task_type: "architecture", override: { effort: "max" } },
      ],
    });
    expect(result.items[0]).toMatchObject({ model: "claude-sonnet-5-5", harness: "claude", effort: "low", selection_source: "override" });
    expect(result.items[0].warnings).toContain("harness claude is not authenticated");
    expect(result.items[1]).toMatchObject({ harness: "codex", selection_source: "override" });
    expect(result.items[2]).toMatchObject({ model: "claude-opus-5-5", effort: "max", selection_source: "override" });
  });

  it("replaces a preset harness that is not installed with an installed catalog candidate", () => {
    const result = buildPlanPreview({
      config,
      healthByHarness: { claude: health("claude", { installed: false }), codex: health("codex") },
      subtasks: [{ id: "a", title: "Design", task_type: "architecture" }],
    });
    expect(result.items[0]).toMatchObject({ harness: "codex", selection_source: "catalog_match", harness_installed: true });
    expect(result.items[0].warnings).toContain("Harness claude from preset balanced is not installed. Using an available alternative.");
    expect(config.models[result.items[0].model].efforts).toContain(result.items[0].effort);
  });

  it.each([
    [undefined, /claude from preset balanced is not authenticated/],
    ["ru", /claude из пресета balanced не авторизован/],
  ] as const)("replaces an unauthenticated preset harness with a ready alternative (locale %s)", (locale, warning) => {
    const plan = buildPlanPreview({
      config, locale, subtasks: [{ id: "a", title: "Design", task_type: "architecture" }],
      healthByHarness: { claude: health("claude", { auth_status: "unauthenticated" }), codex: health("codex") },
    });
    expect(plan.items[0]).toMatchObject({ harness: "codex", harness_installed: true,
      harness_auth_status: "ready", selection_source: "catalog_match", warnings: expect.arrayContaining([expect.stringMatching(warning)]) });
  });

  it("keeps the preset choice with a warning when no installed replacement exists", () => {
    const result = buildPlanPreview({
      config,
      healthByHarness: { claude: health("claude", { installed: false }) },
      subtasks: [{ id: "a", title: "Design", task_type: "architecture" }],
    });
    expect(result.items[0]).toMatchObject({ harness: "claude", model: "claude-opus-5-5", selection_source: "preset" });
    expect(result.items[0].warnings).toContain("harness claude is not installed");
  });

  it("never runs readonly work on a driver without a readonly guarantee", () => {
    const fxHealth = health("fx", { security_guarantees: { readonly: "unsandboxed", write: "unsandboxed" } });
    const allDown = Object.fromEntries(Object.keys(config.harnesses).map((id) => [id, health(id, { installed: false })]));
    const healthByHarness = { ...allDown, fx: fxHealth };
    const readonly = (override: PlanSubtaskInput["override"]) => () => buildPlanPreview({
      config, healthByHarness, subtasks: [{ id: "r", title: "Review", task_type: "review", mode: "readonly", override }],
    });

    expectPlanError(readonly({ model: "fx-default" }), "SANDBOX_POLICY_VIOLATION", /cannot guarantee safe readonly/);
    expectPlanError(readonly({ harness: "fx" }), "SANDBOX_POLICY_VIOLATION", /cannot guarantee safe readonly/);

    // fx is the only installed harness, yet catalog matching still skips it for readonly roles.
    const readonlyRoles = Object.values(ROLES).filter((role) => role.defaultMode === "readonly");
    const plan = buildPlanPreview({
      config, healthByHarness, subtasks: readonlyRoles.map((role) => ({ id: role.id, title: role.id, task_type: role.id })),
    });
    for (const item of plan.items) {
      expect(item.harness).not.toBe("fx");
      expect(item.alternatives.map((alternative) => alternative.harness)).not.toContain("fx");
    }

    const write = buildPlanPreview({
      config, healthByHarness, subtasks: [{ id: "w", title: "Impl", task_type: "implementation", override: { model: "fx-default" } }],
    });
    expect(write.items[0]).toMatchObject({ harness: "fx", mode: "write", security_guarantee: "unsandboxed" });
  });

  it("warns when an experimental driver is selected and not for verified drivers", () => {
    const result = buildPlanPreview({
      config,
      subtasks: [
        { id: "a", title: "Impl", task_type: "implementation", override: { model: "cursor-auto" } },
        { id: "b", title: "Arch", task_type: "architecture", override: { model: "claude-opus-5-5" } },
      ],
    });
    const warning = "experimental — experimental adapter cursor, check the flags in your local CLI version";
    expect(result.items[0].warnings).toContain(warning);
    expect(result.items[1].warnings.some((entry) => entry.startsWith("experimental"))).toBe(false);
    expect(result.markdown_table).toContain("⚠ experimental");
  });

  it("prefers a verified driver over an experimental one with equal fit", () => {
    const tied = structuredClone(config);
    for (const model of Object.values(tied.models)) model.enabled = false;
    const card = { ...tied.models["cursor-auto"], best_for: [], avoid_for: [], tier: "standard" as const, cost_tier: "medium" as const, enabled: true };
    tied.models["cursor-auto"] = { ...card, harness: "cursor" };
    tied.models["opencode-default"] = { ...card, harness: "opencode" };
    const result = buildPlanPreview({
      config: tied, preset: "balanced", subtasks: [{ id: "a", title: "x", task_type: "custom_role", mode: "write" }],
    });
    expect(result.items[0]).toMatchObject({ model: "opencode-default", selection_source: "catalog_match" });
  });

  it("rejects invalid overrides without silent fallback", () => {
    const run = (override: PlanSubtaskInput["override"]) => () =>
      buildPlanPreview({ config, subtasks: [{ id: "s1", title: "x", task_type: "review", override }] });

    expectPlanError(run({ model: "no-such-model" }), "MODEL_UNSUPPORTED", /unknown model/);
    expectPlanError(run({ harness: "nope" }), "HARNESS_UNAVAILABLE", /unknown harness/);
    expectPlanError(run({ model: "claude-haiku-5-5", effort: "max" }), "MODEL_UNSUPPORTED", /effort "max" is not supported/);
    expectPlanError(run({ model: "gpt-6.2-sol", harness: "claude" }), "MODEL_UNSUPPORTED", /belongs to harness "codex"/);

    const disabled = structuredClone(config);
    disabled.models["gpt-6-luna"].enabled = false;
    expectPlanError(() => buildPlanPreview({
      config: disabled,
      subtasks: [{ id: "s1", title: "x", task_type: "quick", override: { model: "gpt-6-luna" } }],
    }), "MODEL_UNSUPPORTED", /disabled/);
  });

  it("rejects empty plans and duplicate subtask ids", () => {
    expectPlanError(() => buildPlanPreview({ config, subtasks: [] }), "PLAN_REQUIRED", /at least one subtask/);
    expectPlanError(() => buildPlanPreview({
      config,
      subtasks: [{ id: "x", title: "a", task_type: "review" }, { id: "x", title: "b", task_type: "review" }],
    }), "PLAN_REQUIRED", /Duplicate/);
  });

  it("recommends worktree isolation for parallel writes", () => {
    const result = buildPlanPreview({
      config,
      subtasks: [
        { id: "a", title: "Backend", task_type: "implementation" },
        { id: "b", title: "UI", task_type: "ui" },
        { id: "c", title: "Review", task_type: "review" },
      ],
    });
    expect(result.parallel_write_detected).toBe(true);
    expect(result.items.map((item) => [item.mode, item.isolation])).toEqual([
      ["write", "worktree"],
      ["write", "worktree"],
      ["readonly", "shared"],
    ]);
  });

  it("does not flag a single write subtask as parallel", () => {
    const result = buildPlanPreview({ config, subtasks: [{ id: "a", title: "Impl", task_type: "implementation" }] });
    expect(result.parallel_write_detected).toBe(false);
    expect(result.items[0]).toMatchObject({ mode: "write", isolation: "shared", recommended_isolation: "shared" });
  });

  it("warns when the user explicitly requests shared isolation for parallel writes", () => {
    const result = buildPlanPreview({
      config,
      subtasks: [
        { id: "a", title: "One", task_type: "implementation", isolation: "shared" },
        { id: "b", title: "Two", task_type: "implementation", isolation: "shared" },
      ],
    });
    expect(result.items[0]).toMatchObject({ isolation: "shared", recommended_isolation: "worktree", isolation_source: "user" });
    expect(result.items[0].warnings.some((warning) => warning.includes("parallel shared write"))).toBe(true);
    expect(result.warnings.some((warning) => /#1, #2 write in parallel in shared mode/.test(warning))).toBe(true);
  });

  it("emits premium, unsandboxed, stale and dirty-tree warnings", () => {
    const stale = loadConfig(STALE_DATE);
    stale.models["claude-opus-5-5"].cost_tier = "premium";
    const result = buildPlanPreview({
      config: stale,
      preset: "budget",
      cwdDirty: true,
      subtasks: [
        { id: "a", title: "Impl", task_type: "implementation" },
        { id: "b", title: "UI", task_type: "ui" },
        { id: "c", title: "Arch", task_type: "architecture", override: { model: "claude-opus-5-5" } },
      ],
    });
    const [impl, , arch] = result.items;
    expect(impl.security_guarantee).toBe("unsandboxed");
    expect(impl.warnings).toEqual(expect.arrayContaining([
      "unsandboxed — write without OS sandbox",
      expect.stringMatching(/^stale/),
      expect.stringMatching(/^dirty git tree/),
    ]));
    expect(arch.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^premium/)]));
    expect(arch.warnings.some((warning) => warning.startsWith("dirty git tree"))).toBe(false);
    expect(result.warnings.some((warning) => warning.startsWith("#3: premium"))).toBe(true);
  });

  it("falls back to best_for catalog matching for task types without a preset role", () => {
    const withMissingRole = structuredClone(config);
    delete withMissingRole.presets["ui-sprint"].roles.security;
    const result = buildPlanPreview({
      config: withMissingRole, preset: "ui-sprint", subtasks: [{ id: "a", title: "Audit", task_type: "security" }],
    });
    expect(result.items[0].selection_source).toBe("catalog_match");
    expect(result.items[0].mode).toBe("readonly");
    expect(result.items[0].tier).toBe("deep");
  });

  it("prefers ready harnesses for catalog matches when health is provided", () => {
    const withMissingRole = structuredClone(config);
    delete withMissingRole.presets["ui-sprint"].roles.security;
    const allDown = Object.fromEntries(Object.keys(config.harnesses).map((id) => [id, health(id, { installed: false })]));
    const result = buildPlanPreview({
      config: withMissingRole,
      preset: "ui-sprint",
      healthByHarness: { ...allDown, dsh: health("dsh") },
      subtasks: [{ id: "a", title: "Audit", task_type: "security" }],
    });
    expect(result.items[0].harness).toBe("dsh");
  });

  it("offers up to two alternatives that differ from the chosen model", () => {
    const result = buildPlanPreview({ config, subtasks: [{ id: "a", title: "Review", task_type: "review" }] });
    const { alternatives, model } = result.items[0];
    expect(alternatives.length).toBeGreaterThan(0);
    expect(alternatives.length).toBeLessThanOrEqual(2);
    for (const alternative of alternatives) {
      expect(alternative.model).not.toBe(model);
      expect(config.models[alternative.model].efforts).toContain(alternative.effort);
      expect(alternative.reason).not.toBe("");
    }
  });

  it("renders the documented 9-column markdown preview table", () => {
    const result = buildPlanPreview({
      config,
      subtasks: [{ id: "a", title: "Fix | pipe", task_type: "implementation" }],
    });
    const lines = result.markdown_table.split("\n");
    expect(lines[0]).toBe("| # | Subtask | Harness / Model | Effort | Mode | Isolation | Tier / Cost | Sandbox | Pros & Risks |");
    expect(lines[1]).toBe("|---|-----------|------------------|--------|-------|----------|------------|-----------|---------------|");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("Fix \\| pipe");
    expect(lines[2]).toContain("| claude / claude-sonnet-5-5 | high | write | shared | standard / medium | tool_allowlist |");
    const unescapedPipes = lines[2].replace(/\\\|/g, "").split("|").length - 1;
    expect(unescapedPipes).toBe(10);
  });

  it("handles prototype-name task_type and enforces allow_unsandboxed_write = false", () => {
    const safeProto = buildPlanPreview({
      config,
      subtasks: [{ id: "p", title: "Proto key", task_type: "constructor" }],
    });
    expect(safeProto.items).toHaveLength(1);

    const lockedConfig = { ...config, defaults: { ...config.defaults, allow_unsandboxed_write: false } };
    const budgetPlan = buildPlanPreview({
      config: lockedConfig,
      preset: "budget",
      subtasks: [{ id: "imp", title: "Write code", task_type: "implementation" }],
    });
    expect(budgetPlan.items[0].security_guarantee).not.toBe("unsandboxed");
    expect(budgetPlan.items[0].alternatives.every((alt) => config.harnesses[alt.harness].driver !== "pi")).toBe(true);

    expect(() => buildPlanPreview({
      config: lockedConfig,
      subtasks: [{ id: "imp", title: "Force Pi", task_type: "implementation", mode: "write", override: { model: "pi-qwen3.8-max" } }],
    })).toThrow(/allow_unsandboxed_write/);
  });
});

describe("delegation availability", () => {
  const models = ["claude-opus-5-5", "gpt-6.2-sol", "deepseek-v4-pro", "agy-gemini-4-argon"];
  const missing = health("claude", { installed: false });
  const unauthenticated = health("codex", { auth_status: "unauthenticated" });
  const cooldown = { harness: "dsh", scope: "harness", code: "QUOTA_EXCEEDED", raw_error: "out of credits",
    failed_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" } as const;

  function configWithModels(enabled: readonly string[] = models): ConfigSnapshot {
    const config = loadConfig();
    for (const [id, model] of Object.entries(config.models)) model.enabled = enabled.includes(id);
    return config;
  }

  it("is available when an enabled model has an installed and ready harness", () => {
    expect(delegationAvailability({
      config: configWithModels(models.slice(0, 2)),
      healthByHarness: { claude: missing, codex: health("codex") },
    })).toEqual({
      state: "available", usable_count: 1, unknown_count: 0, total_enabled_count: 2,
      blocked_by_harness: { claude: "not_installed" }, retryable: false,
    });
  });

  it("keeps availability unknown before any health probes have run", () => {
    expect(delegationAvailability({ config: configWithModels() })).toEqual({
      state: "unknown", usable_count: 0, unknown_count: 4, total_enabled_count: 4,
      blocked_by_harness: {}, retryable: false,
    });
  });

  it("keeps availability unknown when a blocked model and an unprobed model remain", () => {
    expect(delegationAvailability({
      config: configWithModels(models.slice(0, 2)), healthByHarness: { claude: missing },
    })).toEqual({
      state: "unknown", usable_count: 0, unknown_count: 1, total_enabled_count: 2,
      blocked_by_harness: { claude: "not_installed" }, retryable: false,
    });
  });

  it("reports all blocked harnesses without a retry time when a cooldown is only one of the blockers", () => {
    expect(delegationAvailability({
      config: configWithModels(),
      healthByHarness: { claude: missing, codex: unauthenticated, dsh: health("dsh"), antigravity: health("antigravity") },
      runtimeDegradations: [cooldown],
      excludeHarnesses: ["antigravity"],
    })).toEqual({
      state: "exhausted", usable_count: 0, unknown_count: 0, total_enabled_count: 4, retryable: false,
      blocked_by_harness: { claude: "not_installed", codex: "unauthenticated", dsh: "cooldown", antigravity: "excluded" },
    });
  });

  it("reports when the first model becomes usable again if all blocks are cooldowns", () => {
    expect(delegationAvailability({
      config: configWithModels(models.slice(0, 2)),
      healthByHarness: { claude: health("claude"), codex: health("codex") },
      runtimeDegradations: [
        { ...cooldown, harness: "claude" },
        { ...cooldown, harness: "claude", scope: "model", model: models[0], expires_at: "2099-01-03T00:00:00Z" },
        { ...cooldown, harness: "codex", expires_at: "2099-01-02T00:00:00Z" },
      ],
    })).toEqual({
      state: "exhausted", usable_count: 0, unknown_count: 0, total_enabled_count: 2,
      blocked_by_harness: { claude: "cooldown", codex: "cooldown" },
      earliest_retry_at: "2099-01-02T00:00:00.000Z", retryable: true,
    });
  });

  it("treats an inconclusive probe as unknown, never as a confirmed missing harness", () => {
    const inconclusive = health("claude", { installed: false, probe_inconclusive: true, note: "Probe failed: spawn EAGAIN" });
    expect(delegationAvailability({
      config: configWithModels(models.slice(0, 1)), healthByHarness: { claude: inconclusive },
    })).toEqual({
      state: "unknown", usable_count: 0, unknown_count: 1, total_enabled_count: 1, blocked_by_harness: {}, retryable: false,
    });
    const plan = buildPlanPreview({
      config: configWithModels(models.slice(0, 1)), healthByHarness: { claude: inconclusive },
      subtasks: [{ id: "review", title: "Review changes", task_type: "review" }],
    });
    expect(plan).toMatchObject({ launchable: true, delegation_status: "unknown" });
  });

  it("reports a confirmed unauthenticated or missing harness ahead of its cooldown, without a retry time", () => {
    const both = { ...cooldown, harness: "codex" };
    expect(delegationAvailability({
      config: configWithModels(models.slice(1, 2)), healthByHarness: { codex: unauthenticated }, runtimeDegradations: [both],
    })).toEqual({
      state: "exhausted", usable_count: 0, unknown_count: 0, total_enabled_count: 1,
      blocked_by_harness: { codex: "unauthenticated" }, retryable: false,
    });
    expect(delegationAvailability({
      config: configWithModels(models.slice(1, 2)), healthByHarness: { codex: health("codex", { installed: false }) },
      runtimeDegradations: [both],
    })).toMatchObject({ state: "exhausted", blocked_by_harness: { codex: "not_installed" }, retryable: false });
  });

  it("keeps a plan launchable when an explicit override targets a healthy harness that exclude_harnesses lists", () => {
    const config = configWithModels(models.slice(0, 2));
    const healthByHarness = { claude: health("claude"), codex: health("codex") };
    const subtasks = (override: { harness?: string; model?: string }) =>
      [{ id: "review", title: "Review changes", task_type: "review", override }];
    for (const override of [{ harness: "codex" }, { model: "gpt-6.2-sol" }]) {
      const plan = buildPlanPreview({ config, healthByHarness, excludeHarnesses: ["claude", "codex"], subtasks: subtasks(override) });
      expect(plan).toMatchObject({ launchable: true, delegation_status: "available" });
      expect(plan.items[0]).toMatchObject({ harness: "codex", selection_source: "override" });
    }
    // Without an override the same exclusions leave nothing to delegate to.
    expect(() => buildPlanPreview({ config, healthByHarness, excludeHarnesses: ["claude", "codex"], subtasks: subtasks({}) }))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "DELEGATION_UNAVAILABLE" }) }));
    // The overrides that earned the bypass are echoed so a saved plan can keep honouring them after a timeout.
    expect(buildPlanPreview({ config, healthByHarness, excludeHarnesses: ["claude", "codex"], subtasks: subtasks({ harness: "codex" }) }))
      .toMatchObject({ explicit_harnesses: ["codex"] });
    const modelPlan = buildPlanPreview({
      config, healthByHarness, excludeHarnesses: ["claude", "codex"],
      subtasks: [...subtasks({ model: "gpt-6.2-sol" }), { id: "again", title: "Again", task_type: "review", override: { model: "gpt-6.2-sol" } }],
    });
    expect(modelPlan.explicit_models).toEqual(["gpt-6.2-sol"]);
    expect(modelPlan).not.toHaveProperty("explicit_harnesses");
    expect(buildPlanPreview({ config, healthByHarness, subtasks: subtasks({}) })).not.toHaveProperty("explicit_models");
    // An override on a cooling-down harness is not rescued by the bypass.
    expect(buildPlanPreview({
      config, healthByHarness, excludeHarnesses: ["claude"], runtimeDegradations: [{ ...cooldown, harness: "codex" }],
      subtasks: subtasks({ harness: "codex" }),
    })).toMatchObject({ launchable: false, delegation_status: "exhausted" });
  });

  it.each([
    ["en", /STOP all main work, do not run these subtasks yourself, and notify the user/],
    ["ru", /ОСТАНОВИТЕ всю основную работу, не выполняйте эти подзадачи сами и сообщите пользователю/],
  ] as const)("returns an unlaunchable preview with a hard-stop warning in %s", (locale, warning) => {
    const plan = buildPlanPreview({
      locale, config: configWithModels(models.slice(0, 2)),
      healthByHarness: { claude: missing, codex: unauthenticated },
      subtasks: [{ id: "review", title: "Review changes", task_type: "review" }],
    });
    expect(plan).toMatchObject({
      launchable: false, delegation_status: "exhausted", blocked_reason: "DELEGATION_UNAVAILABLE",
      blocked_by_harness: { claude: "not_installed", codex: "unauthenticated" },
    });
    expect(plan.warnings.find((entry) => entry.startsWith("DELEGATION_UNAVAILABLE"))).toMatch(warning);
  });
});

describe("failover routing", () => {
  const subtask = { id: "a", title: "Architecture", task_type: "architecture" };
  const ready = { claude: health("claude"), codex: health("codex") };
  const quota = { harness: "claude", scope: "harness", code: "QUOTA_EXCEEDED", raw_error: "out of credits",
    failed_at: new Date().toISOString(), expires_at: "2099-01-01T00:00:00Z" } as const;

  it("does not offer runtime alternatives for TIMEOUT even when another harness is ready", () => {
    const input = { config: loadConfig(), healthByHarness: ready, failedHarness: "claude",
      failedModel: "claude-opus-5-5", mode: "readonly", failureScope: "harness" } as const;
    expect(suggestRuntimeAlternatives({ ...input, errorCode: "QUOTA_EXCEEDED" }))
      .toContainEqual(expect.objectContaining({ harness: "codex" }));
    expect(suggestRuntimeAlternatives({ ...input, errorCode: "TIMEOUT" })).toEqual([]);
  });

  it("skips excluded harnesses and models in selections and alternatives, honoring explicit overrides", () => {
    const config = loadConfig();
    const options = { config, healthByHarness: ready, subtasks: [subtask], excludeHarnesses: ["claude"], excludeModels: ["gpt-6.2-astra"] };
    const [chosen] = buildPlanPreview(options).items;
    expect(chosen.harness).toBe("codex");
    for (const item of [chosen, ...chosen.alternatives]) {
      expect(item.harness).not.toBe("claude");
      expect(item.model).not.toBe("gpt-6.2-astra");
    }
    expect(buildPlanPreview({ ...options, subtasks: [{ ...subtask, override: { model: "claude-opus-5-5" } }] })
      .items[0].model).toBe("claude-opus-5-5");
    expect(buildPlanPreview({ config, healthByHarness: ready, subtasks: [subtask], excludeModels: ["claude-opus-5-5"] })
      .items[0].model).not.toBe("claude-opus-5-5");
  });

  it.each([["en", "recently failed in this session"], ["ru", "недавно упал в этой сессии"]] as const)(
    "routes around active quota cooldowns in %s", (locale, warning) => {
      const input = { locale, config: loadConfig(), healthByHarness: ready, subtasks: [subtask] };
      const [chosen] = buildPlanPreview({ ...input, runtimeDegradations: [quota] }).items;
      expect(chosen.harness).toBe("codex");
      expect(chosen.warnings.join(" ")).toContain(warning + " (QUOTA_EXCEEDED: out of credits)");
      expect(buildPlanPreview({ ...input, runtimeDegradations: [{ ...quota, expires_at: "2000-01-01T00:00:00Z" }] })
        .items[0].harness).toBe("claude");
    });

  it("honors the saved plan's excluded harnesses and models in runtime alternatives", () => {
    const config = loadConfig();
    const eligible = ["gpt-6.2-astra", "gpt-6.2-sol", "deepseek-v4-pro"];
    const plan = buildPlanPreview({ config, subtasks: [subtask], excludeHarnesses: ["dsh"], excludeModels: ["gpt-6.2-astra"] });
    for (const [id, model] of Object.entries(config.models)) model.enabled = eligible.includes(id);
    const input = { config, healthByHarness: { ...ready, dsh: health("dsh") }, failedHarness: "claude",
      mode: "readonly", failureScope: "harness", errorCode: "QUOTA_EXCEEDED" } as const;
    expect(suggestRuntimeAlternatives(input).map((item) => item.model).sort()).toEqual([...eligible].sort());
    const filtered = suggestRuntimeAlternatives({ ...input, excludeHarnesses: plan.exclude_harnesses, excludeModels: plan.exclude_models });
    expect(filtered.map((item) => item.model)).toEqual(["gpt-6.2-sol"]);
  });

  it("removes argv-only alternatives specifically for local prompt byte limits", () => {
    const config = loadConfig();
    const models = ["agy-gemini-4-argon", "gpt-6.2-sol"];
    for (const [id, model] of Object.entries(config.models)) model.enabled = models.includes(id);
    const input = { config, healthByHarness: { codex: ready.codex, antigravity: health("antigravity") },
      failedHarness: "claude", mode: "readonly", failureScope: "model", errorCode: "PROMPT_TOO_LARGE" } as const;
    expect(suggestRuntimeAlternatives(input).map((item) => item.model).sort()).toEqual(models);
    const local = suggestRuntimeAlternatives({ ...input, errorDetails: { limit_bytes: 102_400 } });
    expect(local.map((item) => item.model)).toEqual(["gpt-6.2-sol"]);
  });

  it("ranks alternatives by role, scope, vendor independence and transport", () => {
    const config = loadConfig();
    const healthByHarness = { ...ready, pi: health("pi"), antigravity: health("antigravity") };
    const input = { config, healthByHarness, failedModel: "claude-opus-5-5", failedHarness: "claude",
      role: "review", mode: "readonly", failureScope: "harness", errorCode: "QUOTA_EXCEEDED" } as const;
    config.models["gpt-6.2-sol"].best_for = Array(8).fill("code review");
    const choices = suggestRuntimeAlternatives(input);
    expect(choices[0]).toMatchObject({ model: "gpt-6.2-sol", reason: expect.stringContaining("review") });
    expect(choices.every((item) => item.harness !== "claude")).toBe(true);
    const review = suggestRuntimeAlternatives({ ...input, avoidVendors: ["openai"] });
    expect(review.length).toBeGreaterThan(0);
    expect(review.every((item) => inferVendorFamily(config.models[item.model], config.harnesses[item.harness].driver) !== "openai")).toBe(true);
    const modelChoices = suggestRuntimeAlternatives({ ...input, healthByHarness: { claude: ready.claude }, failureScope: "model" });
    expect(modelChoices[0].harness).toBe("claude");
    expect(modelChoices.every((item) => item.model !== input.failedModel)).toBe(true);
    config.models["agy-gemini-4-argon"].best_for = Array(12).fill("code review");
    const larger = suggestRuntimeAlternatives({ ...input, errorCode: "PROMPT_TOO_LARGE", healthByHarness: {
      codex: ready.codex, antigravity: healthByHarness.antigravity }, failureScope: "model" });
    expect(larger[0].harness).toBe("codex");
  });
});

describe("sharding and concurrency summary", () => {
  const config = loadConfig();
  const info = (cap: number) => ({
    effective_cap: cap, global_cap: 8, limit_source: "cli_config" as const, fallback_used: false, native_subagents: "enabled" as const,
  });

  it("expands a subtask into numbered shards and forces write shards into worktrees", () => {
    const result = buildPlanPreview({
      config, subtasks: [{ id: "impl", title: "Backend", task_type: "implementation", shards: 3 }, { id: "rev", title: "Review", task_type: "review" }],
    });
    expect(result.items.map((item) => item.id)).toEqual(["impl#1", "impl#2", "impl#3", "rev"]);
    expect(result.items.map((item) => item.title).slice(0, 3)).toEqual(["Backend [shard 1/3]", "Backend [shard 2/3]", "Backend [shard 3/3]"]);
    expect(result.items.slice(0, 3).every((item) => item.mode === "write" && item.isolation === "worktree")).toBe(true);
    expect(result.parallel_write_detected).toBe(true);
  });

  it("replaces a requested shared isolation on write shards and says so", () => {
    const result = buildPlanPreview({
      config, subtasks: [{ id: "impl", title: "Backend", task_type: "implementation", shards: 2, isolation: "shared" }],
    });
    for (const item of result.items) {
      expect(item).toMatchObject({ isolation: "worktree", isolation_source: "recommended" });
      expect(item.warnings.join("\n")).toMatch(/replaced by "worktree"/);
    }
    expect(result.warnings.join("\n")).not.toMatch(/prohibited/);
  });

  it("keeps readonly shards shared and rejects out-of-range shard counts", () => {
    const readonly = buildPlanPreview({ config, subtasks: [{ id: "r", title: "Audit", task_type: "review", shards: 2 }] });
    expect(readonly.items.map((item) => item.isolation)).toEqual(["shared", "shared"]);
    for (const shards of [0, 9, 1.5]) {
      expectPlanError(() => buildPlanPreview({ config, subtasks: [{ id: "r", title: "Audit", task_type: "review", shards }] }), "PLAN_REQUIRED", /shards/);
    }
    // An expanded id may not collide with another subtask.
    expectPlanError(() => buildPlanPreview({
      config, subtasks: [{ id: "r", title: "Audit", task_type: "review", shards: 2 }, { id: "r#1", title: "Other", task_type: "review" }],
    }), "PLAN_REQUIRED", /Duplicate/);
  });

  it("reports the concurrency summary and warns when planned subtasks exceed a harness cap", () => {
    const subtasks = [{ id: "a", title: "Audit", task_type: "review", shards: 3 }];
    const capped = buildPlanPreview({ config, subtasks, concurrencyByHarness: { codex: info(2) } });
    expect(capped.concurrency).toMatchObject({
      global_max_concurrency: config.defaults.max_concurrency, max_queue_size: config.defaults.max_queue_size,
      per_harness: { codex: { planned_subtasks: 3, effective_cap: 2 } },
    });
    expect(capped.warnings.join("\n")).toMatch(/3 subtasks target harness codex.*at most 2.*queue/);
    const roomy = buildPlanPreview({ config, subtasks, concurrencyByHarness: { codex: info(3) } });
    expect(roomy.warnings.join("\n")).not.toMatch(/queue/);
    // Without discovery the catalog defaults apply: 5 per harness, capped by the global limit.
    expect(buildPlanPreview({ config, subtasks }).concurrency.per_harness.codex)
      .toMatchObject({ effective_cap: 5, limit_source: "fallback", fallback_used: true });
  });

  it("says the rest will hit QUEUE_FULL when the queue is disabled", () => {
    const subtasks = [{ id: "a", title: "Audit", task_type: "review", shards: 3 }];
    const noQueue = { ...config, defaults: { ...config.defaults, max_queue_size: 0 } };
    const text = (locale: "en" | "ru") => buildPlanPreview({ config: noQueue, locale, subtasks, concurrencyByHarness: { codex: info(2) } }).warnings.join("\n");
    expect(text("en")).toMatch(/at most 2 at a time.*max_queue_size = 0.*will hit QUEUE_FULL/);
    expect(text("en")).not.toMatch(/will queue/);
    expect(text("ru")).toMatch(/max_queue_size = 0.*QUEUE_FULL/);
    expect(text("ru")).not.toMatch(/встанут в очередь/);
  });

  it("localizes the queue warning", () => {
    const result = buildPlanPreview({
      config, locale: "ru", subtasks: [{ id: "a", title: "Audit", task_type: "review", shards: 2 }], concurrencyByHarness: { codex: info(1) },
    });
    expect(result.warnings.join("\n")).toMatch(/встанут в очередь/);
  });
});

describe("delegation availability under the sandbox policy", () => {
  const lockedWrites = (...enabled: string[]): ConfigSnapshot => {
    const config = loadConfig();
    for (const [id, model] of Object.entries(config.models)) model.enabled = enabled.includes(id);
    config.defaults.allow_unsandboxed_write = false;
    return config;
  };
  const unsandboxedWrite = health("codex", { security_guarantees: { readonly: "os_sandbox", write: "unsandboxed" } });
  const unsandboxedAll = health("codex", { security_guarantees: { readonly: "unsandboxed", write: "unsandboxed" } });
  const cooldown = { harness: "codex", scope: "harness", code: "QUOTA_EXCEEDED", raw_error: "out of credits",
    failed_at: "2026-01-01T00:00:00Z", expires_at: "2099-01-01T00:00:00Z" } as const;

  it("ignores the sandbox policy when no mode is required", () => {
    for (const modes of [undefined, []]) {
      expect(delegationAvailability({ config: lockedWrites("gpt-6.2-sol"), healthByHarness: { codex: unsandboxedWrite }, modes }))
        .toMatchObject({ state: "available", usable_count: 1, blocked_by_harness: {} });
    }
  });

  it("blocks a harness that cannot run any required mode and keeps the rest usable", () => {
    const config = lockedWrites("gpt-6.2-sol", "claude-opus-5-5");
    const healthByHarness = { codex: unsandboxedWrite, claude: health("claude") };
    expect(delegationAvailability({ config, healthByHarness, modes: ["write"] })).toMatchObject({
      state: "available", usable_count: 1, total_enabled_count: 2, blocked_by_harness: { codex: "sandbox_policy" },
    });
  });

  it("is exhausted when every enabled model is blocked solely by the sandbox policy for all required modes", () => {
    const config = lockedWrites("gpt-6.2-sol");
    const exhausted = delegationAvailability({ config, healthByHarness: { codex: unsandboxedWrite }, modes: ["write"] });
    expect(exhausted).toEqual({
      state: "exhausted", usable_count: 0, unknown_count: 0, total_enabled_count: 1,
      blocked_by_harness: { codex: "sandbox_policy" }, retryable: false,
    });
    // One runnable mode is enough; readonly work still has a home.
    for (const modes of [["readonly"], ["readonly", "write"]] as const) {
      expect(delegationAvailability({ config, healthByHarness: { codex: unsandboxedWrite }, modes }).state).toBe("available");
    }
    expect(delegationAvailability({ config, healthByHarness: { codex: unsandboxedAll }, modes: ["readonly", "write"] }).state).toBe("exhausted");
  });

  it("applies the driver's static guarantee to a harness that has not been probed yet", () => {
    const config = lockedWrites("pi-qwen3.8-max");
    const result = delegationAvailability({ config, modes: ["write"] });
    expect(result).toMatchObject({ state: "exhausted", blocked_by_harness: { pi: "sandbox_policy" }, retryable: false });
  });

  it("never reports a sandbox-blocked harness as retryable after a cooldown", () => {
    const result = delegationAvailability({
      config: lockedWrites("gpt-6.2-sol"), healthByHarness: { codex: unsandboxedWrite }, runtimeDegradations: [cooldown], modes: ["write"],
    });
    expect(result).toMatchObject({ state: "exhausted", blocked_by_harness: { codex: "sandbox_policy" }, retryable: false });
    expect(result).not.toHaveProperty("earliest_retry_at");
  });

  it("buildPlanPreview passes the plan's subtask modes, so a write plan with no sandboxed route is a hard stop", () => {
    const config = lockedWrites("gpt-6.2-sol");
    const healthByHarness = { codex: unsandboxedWrite };
    const write = [{ id: "impl", title: "Implement", task_type: "implementation", mode: "write" as const }];
    expect(() => buildPlanPreview({ config, healthByHarness, subtasks: write }))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "DELEGATION_UNAVAILABLE" }) }));
    const readonly = [{ id: "rev", title: "Review", task_type: "review", mode: "readonly" as const }];
    expect(buildPlanPreview({ config, healthByHarness, subtasks: readonly })).toMatchObject({ launchable: true, delegation_status: "available" });
  });
});

describe("host vendor normalization", () => {
  const config = loadConfig();
  const warningsFor = (hostVendor: string, advisorModel: string): string[] => buildPlanPreview({
    config, intent: "design_consult", host_vendor: hostVendor,
    subtasks: [
      { id: "arch", title: "Architecture", task_type: "architecture", override: { model: advisorModel } },
      { id: "second", title: "Second opinion", task_type: "second_opinion", override: { model: "claude-opus-5-5" } },
    ],
  }).items[0].warnings;

  it.each([
    ["codex", "gpt-6.2-sol", "openai"],
    [" CODEX ", "gpt-6.2-sol", "openai"],
    ["dsh", "deepseek-v4-pro", "deepseek"],
    ["antigravity", "agy-gemini-4-argon", "google"],
    ["agy", "agy-gemini-4-argon", "google"],
    ["gemini", "agy-gemini-4-argon", "google"],
    ["claude", "claude-sonnet-5-5", "anthropic"],
    ["grok", "pi-grok-4.7", "xai"],
    ["qwen", "pi-qwen3.8-max", "alibaba"],
    ["kimi", "pi-kimi-k3.1-pro", "moonshot"],
  ])("maps the driver or binary name %j to its native vendor, so a %s advisor shares the host vendor", (host, model, vendor) => {
    expect(warningsFor(host, model)).toContainEqual(expect.stringContaining(`same vendor (${vendor}) as the host agent`));
  });

  it("keeps drivers without a native vendor and unknown labels from matching an unrelated advisor", () => {
    for (const host of ["kiro-cli", "cursor-agent", "pi", "totally-unknown"]) {
      expect(warningsFor(host, "gpt-6.2-sol").join(" "), host).not.toContain("as the host agent");
    }
  });
});

describe("built-in presets", () => {
  const config = loadConfig();
  const selfReview = (warnings: readonly string[]) => warnings.filter((warning) => warning.startsWith("self-review"));

  it("ships all 8 presets", () => {
    expect(Object.keys(config.presets).sort()).toEqual([
      "balanced", "budget", "deep-refactor", "fast-sprint", "max-quality", "open-weights", "security-audit", "ui-sprint",
    ]);
  });

  it.each(["balanced", "budget", "deep-refactor", "fast-sprint", "max-quality", "open-weights", "security-audit", "ui-sprint"])(
    "%s plans an implementation with an independent review and security pass without self-review warnings", (preset) => {
      for (const reviewRole of ["review", "security"]) {
        const plan = buildPlanPreview({
          config, preset,
          subtasks: [
            { id: "impl", title: "Implement", task_type: "implementation", mode: "write" },
            { id: "check", title: "Check", task_type: reviewRole },
          ],
        });
        expect(plan.items.flatMap((item) => selfReview(item.warnings)), `${preset} implementation + ${reviewRole}`).toEqual([]);
        expect(selfReview(plan.warnings), `${preset} implementation + ${reviewRole} (plan)`).toEqual([]);
        expect(inferVendorFamily(config.models[plan.items[1].model], plan.items[1].driver))
          .not.toBe(inferVendorFamily(config.models[plan.items[0].model], plan.items[0].driver));
      }
    });

  it("routes the three repaired presets to the intended reviewers", () => {
    const role = (preset: string, name: string) => config.presets[preset].roles[name];
    expect(role("ui-sprint", "review")).toEqual({ harness: "claude", model: "claude-opus-5-5", effort: "high" });
    expect(role("ui-sprint", "security")).toEqual({ harness: "claude", model: "claude-opus-5-5", effort: "high" });
    expect(role("deep-refactor", "review")).toEqual({ harness: "codex", model: "gpt-6.2-astra", effort: "xhigh" });
    expect(role("security-audit", "security")).toEqual({ harness: "codex", model: "gpt-6.2-astra", effort: "xhigh" });
    expect(config.presets["deep-refactor"].description).not.toMatch(/Opus[^.]*review/);
  });
});

describe("Fix Wave 2 planner contracts", () => {
  const config = loadConfig();
  const onlyModels = (enabled: readonly string[]): ConfigSnapshot => {
    const copy = loadConfig();
    for (const [id, model] of Object.entries(copy.models)) model.enabled = enabled.includes(id);
    return copy;
  };

  it("resolves exclude_models aliases to canonical IDs before filtering and echoes the canonical IDs", () => {
    expect(config.aliases["claude-opus"]).toBe("claude-opus-5-5");
    const subtasks = [{ id: "a", title: "Design", task_type: "architecture" }];
    expect(buildPlanPreview({ config, subtasks }).items[0].model).toBe("claude-opus-5-5");
    const plan = buildPlanPreview({ config, subtasks, excludeModels: ["claude-opus", "claude-opus-5-5"] });
    expect(plan.items[0].model).not.toBe("claude-opus-5-5");
    expect(plan.items[0].alternatives.map((alternative) => alternative.model)).not.toContain("claude-opus-5-5");
    expect(plan.exclude_models).toEqual(["claude-opus-5-5"]);

    const only = onlyModels(["claude-opus-5-5"]);
    expect(delegationAvailability({ config: only, excludeModels: ["claude-opus"] })).toMatchObject({
      state: "exhausted", blocked_by_harness: { claude: "excluded" },
    });
    const ready = (harness: string) => health(harness);
    const alternatives = suggestRuntimeAlternatives({
      config, healthByHarness: { claude: ready("claude"), codex: ready("codex") }, failedHarness: "codex", failedModel: "gpt-6.2-sol",
      mode: "readonly", failureScope: "model", errorCode: "QUOTA_EXCEEDED", excludeModels: ["claude-opus"],
    });
    expect(alternatives.map((alternative) => alternative.model)).not.toContain("claude-opus-5-5");
  });

  it("rejects a duplicate subtask id before shard expansion, even when the sharded ids would stay distinct", () => {
    // a#1, a#2 and a would all be distinct after expansion, so only a check on the requested ids can catch this.
    expectPlanError(() => buildPlanPreview({
      config, subtasks: [{ id: "a", title: "Sharded", task_type: "review", shards: 2 }, { id: "a", title: "Plain", task_type: "review" }],
    }), "PLAN_REQUIRED", /Duplicate subtask id "a"\./);
    expectPlanError(() => buildPlanPreview({
      config, subtasks: [{ id: "a", title: "One", task_type: "review", shards: 2 }, { id: "a", title: "Two", task_type: "review", shards: 2 }],
    }), "PLAN_REQUIRED", /Duplicate subtask id "a"\./);
  });

  it("names a collision with a generated shard id separately from a plain duplicate", () => {
    expectPlanError(() => buildPlanPreview({
      config, subtasks: [{ id: "r", title: "Audit", task_type: "review", shards: 3 }, { id: "r#2", title: "Other", task_type: "review" }],
    }), "PLAN_REQUIRED", /"r#2": it collides with a generated shard id/);
  });

  it("turns a row that no harness may run into a DELEGATION_UNAVAILABLE hard stop instead of a generic catalog error", () => {
    const locked = onlyModels(["gpt-6.2-sol"]);
    locked.defaults.allow_unsandboxed_write = false;
    const healthByHarness = { codex: health("codex", { security_guarantees: { readonly: "os_sandbox", write: "unsandboxed" } }) };
    const readonly = { id: "rev", title: "Review", task_type: "review", mode: "readonly" as const };
    const write = { id: "impl", title: "Implement", task_type: "implementation", mode: "write" as const };
    // The readonly row alone is fine, so the plan-wide availability is not exhausted.
    expect(buildPlanPreview({ config: locked, healthByHarness, subtasks: [readonly] })).toMatchObject({ launchable: true });
    expect(() => buildPlanPreview({ config: locked, healthByHarness, subtasks: [readonly, write] })).toThrow(expect.objectContaining({
      structured: expect.objectContaining({
        code: "DELEGATION_UNAVAILABLE",
        details: expect.objectContaining({ subtask_id: "impl", blocked_by_harness: { codex: "sandbox_policy" } }),
      }),
    }));
  });

  it("persists the effective intent and the normalized host vendor, and omits them when they do not apply", () => {
    const consult = [
      { id: "arch", title: "Architecture", task_type: "architecture", override: { model: "claude-opus-5-5" } },
      { id: "second", title: "Second opinion", task_type: "second_opinion", override: { model: "gpt-6.2-sol" } },
    ];
    expect(buildPlanPreview({ config, subtasks: consult, intent: "design_consult", host_vendor: "CODEX" }))
      .toMatchObject({ intent: "design_consult", host_vendor: "openai" });
    // Without an explicit intent the architecture + second_opinion pair is still a consultation.
    expect(buildPlanPreview({ config, subtasks: consult })).toMatchObject({ intent: "design_consult" });
    expect(buildPlanPreview({ config, subtasks: consult })).not.toHaveProperty("host_vendor");
    expect(buildPlanPreview({ config, subtasks: consult, intent: "general" })).toMatchObject({ intent: "general" });
    const plain = buildPlanPreview({ config, subtasks: [{ id: "a", title: "Review", task_type: "review" }], host_vendor: "unknown" });
    expect(plain).not.toHaveProperty("intent");
    expect(plain).not.toHaveProperty("host_vendor");
  });

  it("ranks a ready alternative of a known, different vendor first when a replacement must stay independent", () => {
    const only = onlyModels([]);
    const card = (harness: string, vendor_family: string) => ({ ...structuredClone(config.models["claude-opus-5-5"]), harness, vendor_family, enabled: true });
    only.models["a-mystery"] = card("claude", "unknown");
    only.models["b-anthropic"] = card("claude", "anthropic");
    only.models["z-openai"] = card("codex", "openai");
    const failover = (independentFrom?: string[]) => suggestRuntimeAlternatives({
      config: only, healthByHarness: { claude: health("claude"), codex: health("codex") }, failedHarness: "codex", failedModel: "gpt-6.2-sol",
      mode: "readonly", failureScope: "model", errorCode: "QUOTA_EXCEEDED", independentFrom,
    }).map((alternative) => alternative.model);
    // Equal cards sort by ID; the constraint moves the known, different vendor ahead, and "unknown" never counts as different.
    expect(failover()).toEqual(["a-mystery", "b-anthropic", "z-openai"]);
    expect(failover(["anthropic"])).toEqual(["z-openai", "a-mystery", "b-anthropic"]);
    expect(failover(["openai"])).toEqual(["b-anthropic", "a-mystery", "z-openai"]);
  });
});
