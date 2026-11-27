import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configDiagnostics, customWrapperWarnings } from "../../src/cli/doctor.js";
import { runConfigCommand } from "../../src/cli/config-cmd.js";
import { getDefaultCatalogPath } from "../../src/config/paths.js";
import { ENTITY_ID_MAX_LENGTH, assertValidEntityId, entityIdProblem, isValidEntityId } from "../../src/config/ids.js";
import { ConfigManager, parseDefaultCatalog, resolveModelAlias } from "../../src/config/resolver.js";
import { HarnessSchema, ModelSchema } from "../../src/config/schema.js";
import { ConfigRevisionConflictError, ConfigWriter } from "../../src/config/writer.js";
import { DRIVER_KINDS, DRIVER_METADATA } from "../../src/drivers.js";

const CATALOG = `
schema_version = 1

[defaults]
max_queue_size = 12

[aliases]
shared-name = "primary"

[harnesses.claude]
driver = "claude"
display_name = "Claude"
binary = "claude"

[harnesses.codex]
driver = "codex"
display_name = "Codex"
binary = "codex"
profile = "base-profile"
extra_args = ["--base"]

[models.primary]
harness = "claude"
display_name = "Primary"
tier = "deep"
efforts = ["low", "high"]
default_effort = "high"
cost_tier = "high"
cost_note = "Built-in price note"
speed_note = "Normal speed"
context_window = 200000
strengths = ["reasoning"]
weaknesses = []
best_for = []
avoid_for = []
checked_at = "2026-01-01"

[presets.demo]
description = "Built-in preset"

[presets.demo.roles]
review = { harness = "claude", model = "shared-name", effort = "high" }
draft = { harness = "claude", model = "primary", effort = "low" }
`;

const MODEL = {
  harness: "claude",
  display_name: "Custom",
  tier: "light",
  efforts: ["low", "high"],
  default_effort: "low",
  cost_tier: "low",
  cost_note: "Local estimate",
  speed_note: "Fast",
  context_window: 100000,
  strengths: [],
  weaknesses: [],
  best_for: [],
  avoid_for: [],
  checked_at: "2026-05-01",
} as const;

let directory: string;
let defaultPath: string;
let userPath: string;
let manager: ConfigManager;
let writer: ConfigWriter;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orch-wave1a-"));
  defaultPath = join(directory, "catalog.toml");
  userPath = join(directory, "models.toml");
  writeFileSync(defaultPath, CATALOG);
  manager = new ConfigManager({ defaultPath, userPath, now: () => new Date("2026-05-02T00:00:00Z") });
  writer = new ConfigWriter(manager);
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const userToml = (): Record<string, any> => parse(readFileSync(userPath, "utf8")) as Record<string, any>;

describe("model IDs take precedence over aliases", () => {
  it("resolves a real model ID before any alias, at every step", () => {
    const aliases = { a: "b", b: "c", x: "y" };
    expect(resolveModelAlias("a", aliases)).toBe("c");
    expect(resolveModelAlias("a", aliases, { a: {} })).toBe("a");
    expect(resolveModelAlias("a", aliases, { b: {} })).toBe("b");
    expect(resolveModelAlias("x", aliases, { other: {} })).toBe("y");
    expect(() => resolveModelAlias("p", { p: "q", q: "p" }, {})).toThrow(/cycle/);
  });

  it("lets a custom model reuse a built-in alias name: presets resolve to the model, silently", async () => {
    expect(manager.load().presets.demo.roles.review.model).toBe("primary");
    const snapshot = await writer.upsertModelOverride("shared-name", { ...MODEL, custom: true });
    expect(snapshot.models["shared-name"].display_name).toBe("Custom");
    expect(snapshot.presets.demo.roles.review.model).toBe("shared-name");
    expect(snapshot.config_warnings).toEqual([]);
    expect(snapshot.quarantined).toEqual([]);
  });

  it("warns about a user-defined alias that a model ID shadows, but not about built-in aliases", () => {
    writeFileSync(userPath, '[aliases]\nprimary = "somewhere-else"\n');
    const snapshot = manager.load();
    expect(snapshot.config_warnings).toEqual([expect.stringContaining('User alias "primary" is ignored')]);
    expect(snapshot.presets.demo.roles.draft.model).toBe("primary");
  });

  it("manages aliases: set, retarget back to the built-in, reset, and refuse bad targets", async () => {
    let snapshot = await writer.upsertAlias("fast", "primary");
    expect(snapshot.aliases.fast).toBe("primary");
    expect(userToml().aliases).toEqual({ fast: "primary" });

    snapshot = await writer.upsertAlias("shared-name", "primary"); // equals the built-in value: no override stays
    expect(userToml().aliases).toEqual({ fast: "primary" });

    await writer.upsertModelOverride("second", { ...MODEL, custom: true });
    snapshot = await writer.upsertAlias("shared-name", "second");
    expect(userToml().aliases["shared-name"]).toBe("second");
    expect(snapshot.presets.demo.roles.review.model).toBe("second");
    snapshot = await writer.resetAlias("shared-name");
    expect(snapshot.aliases["shared-name"]).toBe("primary");
    snapshot = await writer.resetAlias("fast");
    expect(snapshot.aliases.fast).toBeUndefined();
    expect(Object.keys(userToml())).toEqual(["schema_version", "models"]);

    const before = readFileSync(userPath);
    await expect(writer.upsertAlias("ghost", "no-such-model")).rejects.toThrow(/unknown model/);
    await expect(writer.upsertAlias("primary", "second")).rejects.toThrow(/model IDs take precedence/);
    await expect(writer.upsertAlias("loop-a", "loop-a")).rejects.toThrow(/cycle/);
    expect(readFileSync(userPath)).toEqual(before);
    await expect(writer.upsertAlias("empty", "  ")).rejects.toThrow(/non-empty/);
    await expect(writer.upsertAlias("bad id", "primary")).rejects.toThrow(/Id must start/);
  });

  it("resets the whole aliases section", async () => {
    await writer.upsertAlias("fast", "primary");
    await writer.resetSection("aliases");
    expect(manager.load().aliases).toEqual({ "shared-name": "primary" });
  });
});

describe("inherit_mcp is three-state", () => {
  const realDefaults = parseDefaultCatalog(readFileSync(getDefaultCatalogPath(), "utf8"));

  it("no built-in harness pins inherit_mcp; the global default decides", () => {
    expect(realDefaults.defaults.inherit_mcp).toBe(false);
    const pinned = Object.entries(realDefaults.harnesses).filter(([, harness]) => harness.inherit_mcp !== undefined);
    expect(pinned).toEqual([]);
    expect(Object.keys(realDefaults.harnesses).length).toBeGreaterThanOrEqual(17);
  });

  it("an explicit true or false on a harness overrides the default, and reset returns to inheriting", async () => {
    expect(manager.load().harnesses.claude.inherit_mcp).toBeUndefined();
    let snapshot = await writer.upsertHarnessOverride("claude", { inherit_mcp: true });
    expect(snapshot.harnesses.claude.inherit_mcp).toBe(true);
    snapshot = await writer.upsertHarnessOverride("claude", { inherit_mcp: false });
    expect(snapshot.harnesses.claude.inherit_mcp).toBe(false);
    snapshot = await writer.resetHarnessField("claude", "inherit_mcp");
    expect(snapshot.harnesses.claude.inherit_mcp).toBeUndefined();
    expect(userToml()).toEqual({ schema_version: 1 });
  });
});

describe("per-entity quarantine", () => {
  const goodCustomModel = `
[models.keeper]
custom = true
harness = "claude"
display_name = "Keeper"
tier = "light"
efforts = ["low"]
default_effort = "low"
cost_tier = "low"
cost_note = "n"
speed_note = "n"
context_window = 1000
checked_at = 2026-11-26
`;

  it("drops only the broken entities and keeps every other override, custom entity, and disabled built-in", () => {
    writeFileSync(userPath, `
schema_version = 1
[defaults]
max_queue_size = 7

[harnesses.codex]
enabled = false

[harnesses.cluade]
driver = "claude"
display_name = "Typo"

[harnesses.fine]
driver = "gemini"
display_name = "Fine"
binary = "gemini-wrapper"

[models.primary]
display_name = "Renamed"
tier = "specialist"

[models.on-typo]
custom = true
harness = "cluade"
display_name = "Orphan"
tier = "light"
efforts = ["low"]
default_effort = "low"
cost_tier = "low"
context_window = 1000
checked_at = "2026-01-01"

[models.bad-effort]
custom = true
harness = "claude"
display_name = "Bad"
tier = "light"
efforts = ["low"]
default_effort = "high"
cost_tier = "low"
context_window = 1000
checked_at = "2026-01-01"

[models.unknown-key]
custom = true
harness = "claude"
display_name = "Unknown key"
tier = "light"
efforts = ["low"]
default_effort = "low"
cost_tier = "low"
context_window = 1000
checked_at = "2026-01-01"
colour = "red"
${goodCustomModel}
[presets.broken]
description = "Points nowhere"
[presets.broken.roles]
review = { harness = "claude", model = "nope", effort = "low" }
`);
    const snapshot = manager.load();
    expect(snapshot.quarantined.map(({ section, id }) => `${section}.${id}`).sort()).toEqual([
      "harnesses.cluade", "models.bad-effort", "models.on-typo", "models.unknown-key", "presets.broken",
    ]);
    expect(snapshot.quarantined.find((entry) => entry.id === "bad-effort")?.reason).toContain("default_effort");
    expect(snapshot.quarantined.find((entry) => entry.id === "unknown-key")?.reason).toMatch(/colour|Unrecognized/i);
    expect(snapshot.quarantined.find((entry) => entry.id === "on-typo")?.reason).toContain('unknown harness "cluade"');
    expect(snapshot.config_warnings).toHaveLength(5);
    expect(snapshot.config_warnings.every((warning) => warning.startsWith("Quarantined "))).toBe(true);

    // Everything valid survives, including the date-typed TOML value.
    expect(snapshot.defaults.max_queue_size).toBe(7);
    expect(snapshot.harnesses.codex.enabled).toBe(false);
    expect(snapshot.harnesses.fine.binary).toBe("gemini-wrapper");
    expect(snapshot.models.primary).toMatchObject({ display_name: "Renamed", tier: "specialist" });
    expect(snapshot.models.keeper.checked_at).toBe("2026-11-26");
    for (const id of ["on-typo", "bad-effort", "unknown-key"]) expect(snapshot.models[id]).toBeUndefined();
    expect(snapshot.harnesses.cluade).toBeUndefined();
    expect(snapshot.presets.broken).toBeUndefined();
  });

  it("falls back to the built-in definition when a user override of a built-in entity is invalid", () => {
    writeFileSync(userPath, '[defaults]\nmax_queue_size = 3\n[models.primary]\nefforts = ["low"]\n');
    const snapshot = manager.load();
    expect(snapshot.models.primary.efforts).toEqual(["low", "high"]);
    expect(snapshot.models.primary.provenance).toBe("default");
    expect(snapshot.quarantined).toEqual([expect.objectContaining({ section: "models", id: "primary" })]);
    expect(snapshot.defaults.max_queue_size).toBe(3);
  });

  it("blames the model override, not the untouched built-in preset, when the override breaks that preset", () => {
    writeFileSync(userPath, '[defaults]\nmax_queue_size = 3\n[models.primary]\nenabled = true\nefforts = ["high"]\ndefault_effort = "high"\n');
    const snapshot = manager.load();
    expect(snapshot.presets.demo.roles.draft.model).toBe("primary");
    expect(snapshot.models.primary.efforts).toEqual(["low", "high"]);
    expect(snapshot.quarantined).toEqual([expect.objectContaining({ section: "models", id: "primary" })]);
    expect(snapshot.quarantined[0].reason).toContain('breaks the built-in preset "demo"');
    expect(snapshot.config_warnings).toEqual([expect.stringContaining("Quarantined models.primary")]);
    expect(snapshot.defaults.max_queue_size).toBe(3);
  });

  it("still falls back to defaults when the file cannot be parsed at all", () => {
    writeFileSync(userPath, "[models.primary\n");
    const snapshot = manager.load();
    expect(snapshot.config_warnings[0]).toContain("built-in defaults");
    expect(snapshot.models.primary.display_name).toBe("Primary");
    expect(snapshot.quarantined).toEqual([]);
  });

  it("keeps an invalid defaults value fatal for the file (it is not an entity)", () => {
    writeFileSync(userPath, '[defaults]\nmax_queue_size = "many"\n[harnesses.codex]\nenabled = false\n');
    const snapshot = manager.load();
    expect(snapshot.config_warnings[0]).toContain("built-in defaults");
    expect(snapshot.harnesses.codex.enabled).toBe(true);
  });

  it("lets the writer change unrelated settings while a broken entity sits in the file, but refuses new invalid data", async () => {
    writeFileSync(userPath, '[models.broken]\ncustom = true\ndisplay_name = "Incomplete"\n');
    expect(manager.load().quarantined).toHaveLength(1);

    const snapshot = await writer.updateDefaults({ max_queue_size: 5 });
    expect(snapshot.defaults.max_queue_size).toBe(5);
    expect(snapshot.quarantined).toEqual([expect.objectContaining({ id: "broken" })]);
    expect(userToml().models.broken).toEqual({ custom: true, display_name: "Incomplete" });

    const before = readFileSync(userPath);
    await expect(writer.upsertModelOverride("broken", { display_name: "Still incomplete" })).rejects.toThrow(/broken/);
    await expect(writer.upsertModelOverride("primary", { efforts: ["low"] })).rejects.toThrow("default_effort");
    expect(readFileSync(userPath)).toEqual(before);

    const fixed = await writer.upsertModelOverride("broken", { ...MODEL, custom: true });
    expect(fixed.quarantined).toEqual([]);
    expect(fixed.models.broken.display_name).toBe("Custom");
  });
});

describe("TOML dates and card fields", () => {
  it("accepts native TOML dates and datetimes and normalizes them to strings", () => {
    writeFileSync(userPath, `
[models.dated]
custom = true
harness = "claude"
display_name = "Dated"
tier = "light"
efforts = ["low"]
default_effort = "low"
cost_tier = "low"
context_window = 1000
checked_at = 2026-11-26
discovered_at = 2026-11-26T10:30:00Z
source = "manual"
`);
    const snapshot = manager.load();
    expect(snapshot.quarantined).toEqual([]);
    expect(snapshot.models.dated.checked_at).toBe("2026-11-26");
    expect(snapshot.models.dated.discovered_at).toBe("2026-11-26T10:30:00.000Z");
    expect(snapshot.models.dated.cost_note).toBe("");
    expect(snapshot.models.dated.strengths).toEqual([]);
  });

  it("round-trips a hand-written TOML date through the writer without breaking the file", async () => {
    writeFileSync(userPath, `
[models.dated]
custom = true
harness = "claude"
display_name = "Dated"
tier = "light"
efforts = ["low"]
default_effort = "low"
cost_tier = "low"
context_window = 1000
checked_at = 2026-11-26
`);
    const snapshot = await writer.upsertModelOverride("dated", { display_name: "Renamed" });
    expect(snapshot.quarantined).toEqual([]);
    expect(snapshot.models.dated).toMatchObject({ display_name: "Renamed", checked_at: "2026-11-26" });
  });

  const complete = { ...MODEL, efforts: [...MODEL.efforts] };
  const { context_window: _contextWindow, checked_at: _checkedAt, ...withoutFacts } = complete;

  it("requires context_window and checked_at, except on unreviewed discovered cards", () => {
    expect(ModelSchema.safeParse(withoutFacts).success).toBe(false);
    expect(ModelSchema.safeParse({ ...withoutFacts, source: "manual" }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...withoutFacts, source: "catalog", metadata_quality: "curated" }).success).toBe(false);
    for (const metadata_quality of [undefined, "baseline", "template"] as const) {
      expect(ModelSchema.safeParse({ ...withoutFacts, source: "discovered", metadata_quality }).success).toBe(true);
    }
    const reviewed = ModelSchema.safeParse({ ...withoutFacts, source: "discovered", metadata_quality: "reviewed" });
    expect(reviewed.success).toBe(false);
    expect(reviewed.error?.issues.map((issue) => issue.path.join("."))).toEqual(["context_window", "checked_at"]);
  });

  it("validates the discovery fields", () => {
    expect(ModelSchema.safeParse({ ...complete, source: "invented" }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...complete, metadata_quality: "great" }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...complete, template_id: "" }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...complete, discovered_at: "yesterday" }).success).toBe(false);
    expect(ModelSchema.safeParse({ ...complete, discovered_at: "2026-11-26T10:00:00Z", template_id: "t1", source: "discovered" }).success).toBe(true);
    expect(HarnessSchema.safeParse({ driver: "pi", display_name: "Pi", binary: "pi", model_discovery: "wrapper" }).success).toBe(true);
    expect(HarnessSchema.safeParse({ driver: "pi", display_name: "Pi", binary: "pi", model_discovery: "magic" }).success).toBe(false);
  });

  it("keeps every shipped built-in card fully curated", () => {
    const catalog = parseDefaultCatalog(readFileSync(getDefaultCatalogPath(), "utf8"));
    for (const [id, model] of Object.entries(catalog.models)) {
      expect(model.context_window, id).toBeGreaterThan(0);
      expect(model.checked_at, id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(model.cost_note, id).not.toBe("");
      expect(model.speed_note, id).not.toBe("");
    }
  });
});

describe("required non-empty strings and write_permission_mode", () => {
  const harness = { driver: "claude", display_name: "Claude", binary: "claude" } as const;

  it.each([
    ["harness display_name", () => HarnessSchema.safeParse({ ...harness, display_name: "" })],
    ["harness binary", () => HarnessSchema.safeParse({ ...harness, binary: "" })],
    ["model display_name", () => ModelSchema.safeParse({ ...MODEL, display_name: "" })],
    ["model harness", () => ModelSchema.safeParse({ ...MODEL, harness: "" })],
    ["model default_effort", () => ModelSchema.safeParse({ ...MODEL, default_effort: "" })],
    ["model cli_model", () => ModelSchema.safeParse({ ...MODEL, cli_model: "" })],
    ["model cli_provider", () => ModelSchema.safeParse({ ...MODEL, cli_provider: "" })],
  ])("rejects an empty %s", (_name, run) => {
    expect(run().success).toBe(false);
  });

  it("accepts a present cli_model and cli_provider", () => {
    expect(ModelSchema.safeParse({ ...MODEL, cli_model: "m", cli_provider: "p" }).success).toBe(true);
  });

  it("checks write_permission_mode against the driver's known modes only", () => {
    expect(HarnessSchema.safeParse({ ...harness, write_permission_mode: "acceptEdits" }).success).toBe(true);
    const bad = HarnessSchema.safeParse({ ...harness, write_permission_mode: "yolo" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0].message).toContain("acceptEdits, auto");
    expect(HarnessSchema.safeParse({ ...harness, driver: "gemini", write_permission_mode: "yolo" }).success).toBe(true);
    expect(HarnessSchema.safeParse({ ...harness, driver: "gemini", write_permission_mode: "acceptEdits" }).success).toBe(false);
    // A driver with no declared modes accepts any non-empty string.
    expect(DRIVER_METADATA.codex.writePermissionModes).toBeUndefined();
    expect(HarnessSchema.safeParse({ ...harness, driver: "codex", write_permission_mode: "anything" }).success).toBe(true);
  });

  it("rejects an invalid mode when it is written, leaving the file untouched", async () => {
    await writer.updateDefaults({ max_queue_size: 4 });
    const before = readFileSync(userPath);
    await expect(writer.upsertHarnessOverride("claude", { write_permission_mode: "yolo" })).rejects.toThrow(/write_permission_mode/);
    expect(readFileSync(userPath)).toEqual(before);
  });
});

describe("shared entity ID policy", () => {
  it.each(["acme-1.5", "openai/gpt-5", "qwen3:32b", "user@host", "A1", "a".repeat(ENTITY_ID_MAX_LENGTH)])("accepts %s", (id) => {
    expect(isValidEntityId(id)).toBe(true);
    expect(() => assertValidEntityId(id)).not.toThrow();
  });

  it.each([
    "", "-lead", ".lead", "/lead", "trail/", "a//b", "a..b", "has space", "tab\tid", "new\nline", "nul\u0000", "a".repeat(ENTITY_ID_MAX_LENGTH + 1),
    "__proto__", "constructor", "prototype", "semi;colon", "quote\"d", "back\\slash",
  ])("rejects %j", (id) => {
    expect(entityIdProblem(id)).toBeDefined();
    expect(() => assertValidEntityId(id)).toThrow();
  });

  it("lets the writer create IDs with slashes and colons, and refuses invalid new ones", async () => {
    for (const id of ["acme-1.5", "openai/gpt-5", "qwen3:32b"]) {
      const snapshot = await writer.upsertModelOverride(id, { ...MODEL, custom: true });
      expect(snapshot.models[id].display_name).toBe("Custom");
      expect(snapshot.models[id].cli_model).toBe(id);
    }
    await expect(writer.upsertModelOverride("a//b", { ...MODEL, custom: true })).rejects.toThrow(/Id must start/);
    await expect(writer.upsertHarnessOverride("constructor", { driver: "claude", display_name: "x", binary: "x" })).rejects.toThrow(/reserved/);
    await expect(writer.upsertPresetOverride("bad id", { description: "d", roles: {} })).rejects.toThrow(/Id must start/);
    expect(Object.keys(userToml().models).sort()).toEqual(["acme-1.5", "openai/gpt-5", "qwen3:32b"]);
  });

  it("keeps a legacy ID that already exists in the file editable and deletable", async () => {
    writeFileSync(userPath, `[models."Legacy Model"]\ncustom = true\n${Object.entries(MODEL).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`);
    expect(manager.load().models["Legacy Model"]).toBeDefined();
    const edited = await writer.upsertModelOverride("Legacy Model", { display_name: "Edited" });
    expect(edited.models["Legacy Model"].display_name).toBe("Edited");
    const removed = await writer.resetOrDeleteModel("Legacy Model");
    expect(removed.models["Legacy Model"]).toBeUndefined();
  });
});

describe("_unset and field resets", () => {
  it("clears an inherited optional harness field and stops inheriting it", async () => {
    expect(manager.load().harnesses.codex.profile).toBe("base-profile");
    const snapshot = await writer.upsertHarnessOverride("codex", { _unset: ["profile"] });
    expect(snapshot.harnesses.codex.profile).toBeUndefined();
    expect(Object.hasOwn(snapshot.harnesses.codex, "_unset")).toBe(false);
    expect(userToml().harnesses.codex).toMatchObject({ _unset: ["profile"], _base_hash: expect.any(String) });
    expect(snapshot.quarantined).toEqual([]);
    expect(snapshot.config_warnings).toEqual([]);
  });

  it("setting the field again takes it off the clear list, and resetting it inherits again", async () => {
    await writer.upsertHarnessOverride("codex", { _unset: ["profile"] });
    let snapshot = await writer.upsertHarnessOverride("codex", { profile: "work" });
    expect(snapshot.harnesses.codex.profile).toBe("work");
    expect(userToml().harnesses.codex._unset).toBeUndefined();

    await writer.upsertHarnessOverride("codex", { _unset: ["profile"] });
    snapshot = await writer.resetHarnessField("codex", "profile");
    expect(snapshot.harnesses.codex.profile).toBe("base-profile");
    expect(userToml()).toEqual({ schema_version: 1 });
  });

  it("strips override shells that only hold _base_hash after a field reset", async () => {
    await writer.upsertHarnessOverride("claude", { inherit_mcp: true });
    expect(userToml().harnesses.claude).toMatchObject({ inherit_mcp: true, _base_hash: expect.any(String) });
    await writer.resetHarnessField("claude", "inherit_mcp");
    expect(userToml()).toEqual({ schema_version: 1 });

    await writer.upsertModelOverride("primary", { tier: "light" });
    await writer.resetModelField("primary", "tier");
    expect(userToml()).toEqual({ schema_version: 1 });
  });

  it("clears an optional model field, and ignores _unset on a field the built-in does not have or on custom entities", async () => {
    await writer.upsertModelOverride("primary", { cli_provider: "someone" });
    let snapshot = await writer.upsertModelOverride("primary", { _unset: ["cli_provider"] });
    expect(snapshot.models.primary.cli_provider).toBeUndefined();
    expect(userToml()).toEqual({ schema_version: 1 });

    await writer.upsertHarnessOverride("claude", { _unset: ["profile"] });
    expect(userToml()).toEqual({ schema_version: 1 });

    snapshot = await writer.upsertModelOverride("mine", { ...MODEL, custom: true, cli_provider: "x" });
    snapshot = await writer.upsertModelOverride("mine", { _unset: ["cli_provider"] });
    expect(snapshot.models.mine.cli_provider).toBeUndefined();
    expect(userToml().models.mine._unset).toBeUndefined();
  });

  it("rejects an _unset that is not an array", async () => {
    await expect(writer.upsertHarnessOverride("codex", { _unset: "profile" } as never)).rejects.toThrow(/JSON array/);
    expect(existsSync(userPath)).toBe(false);
  });

  it("rejects an _unset that names a required field, and quarantines a hand-written one", async () => {
    await expect(writer.upsertHarnessOverride("codex", { _unset: ["binary"] } as never)).rejects.toThrow(/_unset/);
    writeFileSync(userPath, '[harnesses.codex]\n_unset = ["binary"]\n');
    const snapshot = manager.load();
    expect(snapshot.quarantined).toEqual([expect.objectContaining({ section: "harnesses", id: "codex" })]);
    expect(snapshot.harnesses.codex.binary).toBe("codex");
  });

  it("applies a hand-written _unset", () => {
    writeFileSync(userPath, '[harnesses.codex]\n_unset = ["profile", "extra_args"]\n');
    const snapshot = manager.load();
    expect(snapshot.harnesses.codex.profile).toBeUndefined();
    expect(snapshot.harnesses.codex.extra_args).toBeUndefined();
    expect(snapshot.config_warnings).toEqual([]);
  });
});

describe("ConfigWriter.importModels", () => {
  const discovered = (name: string) => ({ ...MODEL, display_name: name, source: "discovered" } as const);

  it("creates new models and enables a disabled one in a single write", async () => {
    await writer.upsertModelOverride("primary", { enabled: false });
    const inodeBefore = statSync(userPath).ino;
    const result = await writer.importModels({
      create: { "openai/gpt-5": discovered("GPT 5"), "qwen3:32b": discovered("Qwen") },
      enable: ["primary"],
    });
    expect(result.imported).toEqual(["openai/gpt-5", "qwen3:32b"]);
    expect(result.enabled).toEqual(["primary"]);
    expect(result.skipped).toEqual([]);
    expect(result.snapshot.models.primary.enabled).toBe(true);
    expect(result.snapshot.models["openai/gpt-5"]).toMatchObject({ custom: true, source: "discovered", enabled: true });
    expect(result.snapshot.quarantined).toEqual([]);
    expect(userToml().models.primary).toBeUndefined();
    expect(Object.keys(userToml().models).sort()).toEqual(["openai/gpt-5", "qwen3:32b"]);
    expect(statSync(userPath).ino).not.toBe(inodeBefore); // the file was replaced atomically, once
    expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml"]);
  });

  it("is all-or-nothing: one invalid model leaves the file exactly as it was", async () => {
    await writer.upsertModelOverride("primary", { enabled: false });
    const before = readFileSync(userPath);
    await expect(writer.importModels({
      create: { good: discovered("Good"), bad: { ...discovered("Bad"), default_effort: "max" } },
      enable: ["primary"],
    })).rejects.toThrow("default_effort");
    await expect(writer.importModels({ create: { "a//b": discovered("Bad id") } })).rejects.toThrow(/Id must start/);
    await expect(writer.importModels({ enable: ["ghost"] })).rejects.toThrow(/unknown model/);
    expect(readFileSync(userPath)).toEqual(before);
  });

  it("detects a revision conflict before changing anything", async () => {
    const stale = manager.getRevision();
    await writer.updateDefaults({ max_queue_size: 3 });
    const before = readFileSync(userPath);
    await expect(writer.importModels({ create: { fresh: discovered("Fresh") } }, stale)).rejects.toBeInstanceOf(ConfigRevisionConflictError);
    expect(readFileSync(userPath)).toEqual(before);
    const ok = await writer.importModels({ create: { fresh: discovered("Fresh") } }, manager.getRevision());
    expect(ok.imported).toEqual(["fresh"]);
  });

  it("returns early without touching the bytes on a semantic no-op, even for a hand-formatted file", async () => {
    const handFormatted = `# my notes\n[defaults]\n   max_queue_size   =  9\n\n[models.keep]\ncustom=true\n${
      Object.entries(MODEL).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n")}\n`;
    writeFileSync(userPath, handFormatted);
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(userPath, past, past);

    const result = await writer.importModels({ create: { keep: discovered("Duplicate") }, enable: ["primary", "keep"] });
    expect(result.imported).toEqual([]);
    expect(result.enabled).toEqual([]);
    expect(result.skipped).toEqual(["keep"]);
    expect(result.snapshot.models.keep.display_name).toBe("Custom");
    expect(readFileSync(userPath, "utf8")).toBe(handFormatted);
    expect(statSync(userPath).mtime.getTime()).toBe(past.getTime());
    expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml"]);

    const empty = await writer.importModels({});
    expect(empty.imported).toEqual([]);
    expect(readFileSync(userPath, "utf8")).toBe(handFormatted);
  });

  it("never overwrites an existing model that a create entry names", async () => {
    const result = await writer.importModels({ create: { primary: { ...discovered("Hijack") } } });
    expect(result.skipped).toEqual(["primary"]);
    expect(result.snapshot.models.primary.display_name).toBe("Primary");
  });

  it("creates the user file from nothing", async () => {
    expect(existsSync(userPath)).toBe(false);
    const result = await writer.importModels({ create: { fresh: discovered("Fresh") } });
    expect(result.imported).toEqual(["fresh"]);
    expect(existsSync(userPath)).toBe(true);
  });
});

describe("agrmcp config command: sections, quoting, and new entities", () => {
  let cliDirectory: string;
  let cliPath: string;
  const read = (): Record<string, any> => parse(readFileSync(cliPath, "utf8")) as Record<string, any>;
  const modelJson = JSON.stringify({ ...MODEL, harness: "claude", efforts: ["low", "high"] });

  beforeEach(() => {
    cliDirectory = mkdtempSync(join(tmpdir(), "orch-wave1a-cli-"));
    cliPath = join(cliDirectory, "models.toml");
    vi.stubEnv("ORCH_MODELS_PATH", cliPath);
    vi.stubEnv("ORCH_STATE_DIR", join(cliDirectory, "state"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(cliDirectory, { recursive: true, force: true });
  });

  it("creates a model with --section and --id, then gets and resets one field of it", async () => {
    await runConfigCommand(["set", "--section", "models", "--id", "openai/gpt-5", modelJson]);
    expect(read().models["openai/gpt-5"]).toMatchObject({ custom: true, display_name: "Custom" });

    await runConfigCommand(["set", "--section", "models", "--id", "openai/gpt-5", "--field", "cli_provider", "gateway"]);
    expect(read().models["openai/gpt-5"].cli_provider).toBe("gateway");

    const log = vi.mocked(console.log);
    await runConfigCommand(["get", "--section", "models", "--id", "openai/gpt-5", "--field", "cli_provider"]);
    expect(log).toHaveBeenLastCalledWith("gateway");

    await runConfigCommand(["reset", "--section", "models", "--id", "openai/gpt-5", "--field", "cli_provider"]);
    expect(read().models["openai/gpt-5"].cli_provider).toBeUndefined();
    await runConfigCommand(["reset", "--section", "models", "--id", "openai/gpt-5"]);
    expect(read().models).toBeUndefined();
  });

  it("treats an unknown dotted ID set to a JSON object as one new custom entity", async () => {
    await runConfigCommand(["set", "models.acme-1.5", modelJson]);
    await runConfigCommand(["set", "models.qwen3:32b", modelJson]);
    expect(Object.keys(read().models).sort()).toEqual(["acme-1.5", "qwen3:32b"]);
    expect(read().models["acme-1.5"].custom).toBe(true);

    // Now the ID is known, so a dotted field path resolves to the longest matching ID.
    await runConfigCommand(["set", "models.acme-1.5.tier", "specialist"]);
    expect(read().models["acme-1.5"].tier).toBe("specialist");
    expect(Object.keys(read().models).sort()).toEqual(["acme-1.5", "qwen3:32b"]);
  });

  it("accepts quoted segments for IDs with dots", async () => {
    await runConfigCommand(["set", 'models."acme-1.5"', modelJson]);
    await runConfigCommand(["set", 'models."acme-1.5".cli_provider', "gateway"]);
    await runConfigCommand(["get", 'models."acme-1.5".cli_provider']);
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith("gateway");
    await runConfigCommand(["reset", 'models."acme-1.5".cli_provider']);
    expect(read().models["acme-1.5"].cli_provider).toBeUndefined();
    await expect(runConfigCommand(["reset", 'models."acme-1.5".tier'])).rejects.toThrow(/tier/);
    await expect(runConfigCommand(["get", 'models."acme-1.5'])).rejects.toThrow(/Unterminated quote/);
  });

  it("keeps the old behavior: a single field of an unknown entity is not auto-created as custom", async () => {
    await expect(runConfigCommand(["set", "models.nothing-here.tier", "deep"])).rejects.toThrow();
    expect(existsSync(cliPath)).toBe(false);
  });

  it("rejects an invalid ID and a missing --id", async () => {
    await expect(runConfigCommand(["set", "--section", "models", "--id", "bad id", modelJson])).rejects.toThrow(/Id must start/);
    await expect(runConfigCommand(["set", "--section", "models", modelJson])).rejects.toThrow(/--id is required/);
    await expect(runConfigCommand(["set", "--section", "nonsense", "--id", "x", "1"])).rejects.toThrow(/--section must be one of/);
  });

  it("resets one harness field and an alias, and sets an alias", async () => {
    await runConfigCommand(["set", "harnesses.codex.profile", "work"]);
    expect(read().harnesses.codex.profile).toBe("work");
    await runConfigCommand(["reset", "harnesses.codex.profile"]);
    expect(read()).toEqual({ schema_version: 1 });

    await runConfigCommand(["set", "models.my.model", modelJson]);
    await runConfigCommand(["set", "aliases.my-alias", "my.model"]);
    expect(read().aliases).toEqual({ "my-alias": "my.model" });
    await runConfigCommand(["get", "aliases.my-alias"]);
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith("my.model");
    await runConfigCommand(["reset", "aliases.my-alias"]);
    expect(read().aliases).toBeUndefined();

    await runConfigCommand(["set", "--section", "aliases", "--id", "dotted.alias", "my.model"]);
    expect(read().aliases).toEqual({ "dotted.alias": "my.model" });
    await runConfigCommand(["reset", "aliases"]);
    expect(read().aliases).toBeUndefined();
  });

  it("resets a quarantined entity whose ID contains a dot, without quotes", async () => {
    writeFileSync(cliPath, '[models."acme-1.5"]\ncustom = true\ndisplay_name = "Broken"\n');
    await runConfigCommand(["reset", "models.acme-1.5"]);
    expect(read().models).toBeUndefined();
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith("Reset models.acme-1.5");
  });

  it("prints labels without a trailing dot for whole-entity --section commands", async () => {
    await runConfigCommand(["set", "--section", "harnesses", "--id", "claude", '{"enabled":false}']);
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith("Updated harnesses.claude");
    await runConfigCommand(["reset", "--section", "harnesses", "--id", "claude"]);
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith("Reset harnesses.claude");
  });

  it("clears an inherited field with _unset through the CLI", async () => {
    await runConfigCommand(["set", "models.claude-opus-5-5.cli_provider", "gateway"]);
    await runConfigCommand(["set", "models.claude-opus-5-5._unset", '["cli_provider"]']);
    expect(read()).toEqual({ schema_version: 1 });
  });

  it("reports quarantined entities in show --json", async () => {
    mkdirSync(cliDirectory, { recursive: true });
    writeFileSync(cliPath, '[models.ghost]\ncustom = true\ndisplay_name = "x"\n');
    await runConfigCommand(["show", "--json"]);
    const shown = JSON.parse(vi.mocked(console.log).mock.lastCall![0] as string);
    expect(shown.quarantined).toEqual([expect.objectContaining({ section: "models", id: "ghost" })]);
    expect(shown.config_warnings).toHaveLength(1);
  });
});

describe("doctor config diagnostics", () => {
  const harness = (driver: string, extra: Record<string, unknown> = {}) => ({ driver, display_name: driver, binary: driver, enabled: true, ...extra });
  const model = (harnessId: string, extra: Record<string, unknown> = {}) => ({ harness: harnessId, cli_model: "m", ...extra });

  it("reports fields the driver ignores", () => {
    const diagnostics = configDiagnostics({
      harnesses: { claude: harness("claude", { profile: "p", default_upstream_provider: "u" }), codex: harness("codex", { profile: "p" }) },
      models: { a: model("claude", { cli_provider: "x" }), b: model("codex") },
    } as never);
    expect(diagnostics).toEqual([
      expect.stringContaining('Harness "claude": profile is ignored by the claude driver'),
      expect.stringContaining('Harness "claude": default_upstream_provider is ignored'),
      expect.stringContaining('Model "a": cli_provider is ignored by the claude driver'),
    ]);
  });

  it("reports opencode models that have no provider", () => {
    const diagnostics = configDiagnostics({
      harnesses: { opencode: harness("opencode") },
      models: { bare: model("opencode"), prefixed: model("opencode", { cli_model: "opencode-go/glm-5" }), provided: model("opencode", { cli_provider: "opencode-go" }) },
    } as never);
    expect(diagnostics).toEqual([expect.stringContaining('Model "bare": the opencode driver needs a provider')]);
  });

  it("is quiet for the shipped catalog", () => {
    const catalog = parseDefaultCatalog(readFileSync(getDefaultCatalogPath(), "utf8"));
    expect(configDiagnostics(catalog as never)).toEqual([]);
  });

  it("explains a failed custom wrapper with the probe note, and ignores stock binaries and healthy wrappers", () => {
    const config = { harnesses: { wrapped: harness("claude", { binary: "/opt/bin/claude-wrap" }), stock: harness("claude", { binary: "claude" }) } };
    const health = (id: string, fields: Record<string, unknown>) => ({
      harness: id, driver: "claude", enabled: true, installed: false, auth_status: "unknown", ...fields,
    }) as never;
    expect(customWrapperWarnings([health("wrapped", { note: "Binary not found on PATH." })], config as never)).toEqual([
      'Harness "wrapped" (custom binary "/opt/bin/claude-wrap") is not usable: Binary not found on PATH.',
    ]);
    expect(customWrapperWarnings([health("stock", { note: "Binary not found on PATH." })], config as never)).toEqual([]);
    expect(customWrapperWarnings([health("wrapped", { installed: true, auth_status: "ready", note: "fine" })], config as never)).toEqual([]);
    expect(customWrapperWarnings([health("wrapped", {})], config as never)).toEqual([]);
  });
});

describe("driver capability matrix", () => {
  it("describes every driver's profile, provider, prefix, and default effort support", () => {
    const flagged = (key: "supportsProfile" | "usesUpstreamProvider" | "usesCliProvider" | "requiresProviderPrefix") =>
      DRIVER_KINDS.filter((kind) => DRIVER_METADATA[kind][key] === true).sort();
    expect(flagged("supportsProfile")).toEqual(["codex", "dsh"]);
    expect(flagged("usesUpstreamProvider")).toEqual(["dsh", "pi"]);
    expect(flagged("usesCliProvider")).toEqual(["dsh", "fx", "opencode", "pi"]);
    expect(flagged("requiresProviderPrefix")).toEqual(["opencode"]);
  });

  it("offers effort-less drivers only the 'default' effort and reasoning drivers low/medium/high", () => {
    for (const kind of DRIVER_KINDS) {
      const { defaultEfforts, effortSupport } = DRIVER_METADATA[kind];
      expect(defaultEfforts.length, kind).toBeGreaterThan(0);
      if (["gemini", "qwen", "cursor", "grok", "kiro", "muse", "copilot", "kimi", "vibe", "opencode"].includes(kind)) {
        expect(defaultEfforts, kind).toEqual(["default"]);
      } else if (kind === "dsh") {
        // Stock DSH models have no "medium": the levels are the ones the built-in catalog lists for its dsh models.
        expect(effortSupport, kind).toBe("native");
        expect(defaultEfforts, kind).toEqual(["off", "low", "high", "max"]);
      } else {
        expect(effortSupport, kind).toBe("native");
        expect(defaultEfforts, kind).toEqual(["low", "medium", "high"]);
      }
    }
  });
});
