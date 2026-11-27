/** Regression tests for the P2 review findings on config resolution and writing (quarantine isolation, malformed entities, provenance). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDefaultCatalogPath } from "../../src/config/paths.js";
import { ConfigManager, parseDefaultCatalog, parseUserOverrides, resolveConfig } from "../../src/config/resolver.js";
import { HarnessSchema } from "../../src/config/schema.js";
import { ConfigWriter } from "../../src/config/writer.js";
import { DRIVER_METADATA } from "../../src/drivers.js";

const CARD = `tier = "deep"
efforts = ["low", "high"]
default_effort = "high"
cost_tier = "high"
cost_note = "n"
speed_note = "s"
context_window = 200000
strengths = []
weaknesses = []
best_for = []
avoid_for = []
checked_at = "2026-01-01"`;

const CATALOG = `
schema_version = 1

[aliases]
shared = "alpha"

[harnesses.claude]
driver = "claude"
display_name = "Claude"
binary = "claude"
write_permission_mode = "acceptEdits"

[harnesses.codex]
driver = "codex"
display_name = "Codex"
binary = "codex"

[models.alpha]
harness = "claude"
display_name = "Alpha"
vendor_family = "anthropic"
${CARD}

[models.beta]
harness = "claude"
display_name = "Beta"
${CARD}

[presets.balanced]
description = "Built-in"

[presets.balanced.roles]
deep = { harness = "claude", model = "alpha", effort = "high" }
quick = { harness = "claude", model = "beta", effort = "low" }
`;

/** A valid model override that still breaks the untouched built-in preset (alpha no longer offers "high"). */
const BREAKING_ALPHA = '[models.alpha]\nefforts = ["low"]\ndefault_effort = "low"\n';

let directory: string;
let defaultPath: string;
let userPath: string;
let manager: ConfigManager;
let writer: ConfigWriter;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orch-config-p2-"));
  defaultPath = join(directory, "catalog.toml");
  userPath = join(directory, "models.toml");
  writeFileSync(defaultPath, CATALOG);
  manager = new ConfigManager({ defaultPath, userPath, now: () => new Date("2026-05-02T00:00:00Z") });
  writer = new ConfigWriter(manager);
});
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

const userToml = (): Record<string, any> => parse(readFileSync(userPath, "utf8")) as Record<string, any>;

describe("P2-6A: quarantine blames only the offending entity override", () => {
  it("keeps a valid override on another model of the same preset", () => {
    writeFileSync(userPath, `[defaults]\nmax_queue_size = 7\n[harnesses.codex]\nenabled = false\n[models.beta]\nenabled = false\n${BREAKING_ALPHA}`);
    const snapshot = manager.load();
    expect(snapshot.quarantined.map(({ section, id }) => `${section}.${id}`)).toEqual(["models.alpha"]);
    expect(snapshot.models.alpha.efforts).toEqual(["low", "high"]);
    // The unrelated overrides survive: beta stays disabled although it is a role model of the very preset that broke.
    expect(snapshot.models.beta.enabled).toBe(false);
    expect(snapshot.models.beta.provenance).toBe("overridden");
    expect(snapshot.harnesses.codex.enabled).toBe(false);
    expect(snapshot.defaults.max_queue_size).toBe(7);
    expect(snapshot.presets.balanced.roles.deep.model).toBe("alpha");
  });
});

describe("P2-6A (precision): only a model whose override actually causes the break is blamed", () => {
  it("leaves an innocent override alone when a user alias redirects a role to a model it cannot serve", () => {
    // `shared` -> gamma (a codex model) makes the claude role fail, but gamma's own harmless override is not the cause.
    const catalog = `${CATALOG}
[models.gamma]
harness = "codex"
display_name = "Gamma"
${CARD}

[presets.aliased]
description = "Uses an alias"

[presets.aliased.roles]
deep = { harness = "claude", model = "shared", effort = "high" }
`;
    writeFileSync(defaultPath, catalog);
    writeFileSync(userPath, '[aliases]\nshared = "gamma"\n[models.gamma]\ndisplay_name = "G2"\n');
    const snapshot = manager.load();
    expect(snapshot.models.gamma.display_name).toBe("G2");
    expect(snapshot.quarantined.map(({ section, id }) => `${section}.${id}`).sort()).toEqual(["presets.aliased"]);
  });
});

describe("P2-6B: writes are not blocked by an untouched, already quarantined entity", () => {
  it("lets unrelated edits through while a valid override that breaks a built-in preset is quarantined", async () => {
    writeFileSync(userPath, BREAKING_ALPHA);
    expect(manager.load().quarantined).toEqual([expect.objectContaining({ section: "models", id: "alpha" })]);

    const afterDefaults = await writer.updateDefaults({ max_queue_size: 5 });
    expect(afterDefaults.defaults.max_queue_size).toBe(5);
    const afterHarness = await writer.upsertHarnessOverride("codex", { enabled: false });
    expect(afterHarness.harnesses.codex.enabled).toBe(false);
    const afterModel = await writer.upsertModelOverride("beta", { display_name: "Renamed" });
    expect(afterModel.models.beta.display_name).toBe("Renamed");
    // The broken override is neither dropped nor fixed by the unrelated writes.
    expect(userToml().models.alpha).toMatchObject({ efforts: ["low"], default_effort: "low" });
    expect(afterModel.quarantined).toEqual([expect.objectContaining({ id: "alpha" })]);
  });

  it("still rejects a write that touches an entity and leaves it quarantined, or that breaks a new one", async () => {
    writeFileSync(userPath, BREAKING_ALPHA);
    const before = readFileSync(userPath);
    await expect(writer.upsertModelOverride("alpha", { display_name: "Still breaks" })).rejects.toThrow(/presets\.balanced/);
    // A different model whose new override breaks the preset is a new offender and is refused.
    await expect(writer.upsertModelOverride("beta", { efforts: ["high"], default_effort: "high" })).rejects.toThrow(/presets\.balanced/);
    expect(readFileSync(userPath)).toEqual(before);
  });

  it("lets a write repair a file that does not resolve at all, even while other entities are broken", async () => {
    writeFileSync(userPath, '[defaults]\nmax_queue_size = -1\n[models]\nbroken = false\n');
    expect(manager.load().config_warnings[0]).toContain("built-in defaults");
    const repaired = await writer.updateDefaults({ max_queue_size: 5 });
    expect(repaired.defaults.max_queue_size).toBe(5);
    expect(repaired.quarantined).toEqual([expect.objectContaining({ id: "broken" })]);
  });

  it("does not let a skipped existing ID abort the rest of an import", async () => {
    writeFileSync(userPath, '[models.broken]\ncustom = true\ndisplay_name = "Incomplete"\n');
    expect(manager.load().quarantined).toEqual([expect.objectContaining({ id: "broken" })]);
    const fresh = { harness: "claude", display_name: "Fresh", tier: "light", efforts: ["low"], default_effort: "low", cost_tier: "low",
      cost_note: "", speed_note: "", context_window: 1000, checked_at: "2026-05-01" } as const;
    const result = await writer.importModels({ create: { broken: fresh, fresh } });
    expect(result.skipped).toEqual(["broken"]);
    expect(result.imported).toEqual(["fresh"]);
    expect(result.snapshot.models.fresh.display_name).toBe("Fresh");
    expect(result.snapshot.quarantined).toEqual([expect.objectContaining({ id: "broken" })]);
  });
});

describe("P2-7: a malformed entity quarantines only itself", () => {
  it("keeps every other user override when entities are not tables", () => {
    writeFileSync(userPath, [
      '[defaults]\nmax_queue_size = 9',
      '[harnesses]\ncodex = "oops"',
      "[harnesses.claude]\nenabled = false",
      "[models]\nbroken = false\nghost = [1, 2]",
      "[models.beta]\nenabled = false",
      "[presets]\ndemo = 3",
      '[aliases]\nbad = 5\nempty = ""\nfine = "beta"',
    ].join("\n"));
    const snapshot = manager.load();
    expect(snapshot.quarantined.map(({ section, id }) => `${section}.${id}`).sort()).toEqual([
      "aliases.bad", "aliases.empty", "harnesses.codex", "models.broken", "models.ghost", "presets.demo",
    ]);
    // Nothing else was dropped: the disabled harness and model, the default, and the valid alias all still apply.
    expect(snapshot.harnesses.claude.enabled).toBe(false);
    expect(snapshot.models.beta.enabled).toBe(false);
    expect(snapshot.defaults.max_queue_size).toBe(9);
    expect(snapshot.aliases.fine).toBe("beta");
    expect(snapshot.harnesses.codex.enabled).toBe(true);
    expect(snapshot.config_warnings.some((warning) => warning.includes("Invalid user config"))).toBe(false);
  });

  it("parses the file schema leniently but refuses a malformed entity under a strict policy", () => {
    const overrides = parseUserOverrides('[models]\nbroken = false\n');
    expect(overrides.models).toEqual({ broken: false });
    expect(() => resolveConfig(parseDefaultCatalog(CATALOG), overrides, { onInvalid: () => "throw" })).toThrow(/models\.broken/);
  });

  it("lets a valid save repair a malformed entity and unrelated writes leave it alone", async () => {
    writeFileSync(userPath, '[models]\nbroken = false\n');
    await writer.updateDefaults({ max_queue_size: 4 });
    expect(userToml().models.broken).toBe(false);
    const repaired = await writer.upsertModelOverride("broken", {
      harness: "claude", display_name: "Repaired", tier: "light", efforts: ["low"], default_effort: "low", cost_tier: "low",
      cost_note: "", speed_note: "", context_window: 1000, checked_at: "2026-05-01", custom: true,
    });
    expect(repaired.quarantined).toEqual([]);
    expect(repaired.models.broken.display_name).toBe("Repaired");
  });
});

describe("P2-13: quarantine reasons are redacted when created", () => {
  it("never carries a secret value from the broken TOML into quarantined[] or warnings", () => {
    const secret = "sk-live-0123456789abcdef";
    // The reference check quotes the unknown harness name, so a secret typed there lands in the failure reason.
    writeFileSync(userPath, `[models.leaky]\ncustom = true\nharness = "${secret}"\ndisplay_name = "x"\n${CARD}\n`);
    const snapshot = manager.load();
    expect(snapshot.quarantined).toHaveLength(1);
    expect(JSON.stringify(snapshot.quarantined)).not.toContain(secret);
    expect(snapshot.quarantined[0].reason).toContain("[REDACTED]");
    expect(JSON.stringify(snapshot.config_warnings)).not.toContain(secret);
    // The record itself (not only the loader's warning text) is clean, so every consumer of resolveConfig is covered.
    const resolved = resolveConfig(parseDefaultCatalog(CATALOG), parseUserOverrides(readFileSync(userPath, "utf8")));
    expect(JSON.stringify(resolved.quarantined)).not.toContain(secret);
  });
});

describe("P2-14: a cleared built-in field keeps its overridden provenance", () => {
  it("reports field_provenance overridden for a field removed through _unset", async () => {
    let snapshot = await writer.upsertHarnessOverride("claude", { _unset: ["write_permission_mode"] });
    expect(snapshot.harnesses.claude.write_permission_mode).toBeUndefined();
    expect(snapshot.harnesses.claude.field_provenance.write_permission_mode).toBe("overridden");
    expect(snapshot.harnesses.claude.provenance).toBe("overridden");
    // A built-in field that is not cleared stays "default", and the reset button's own action brings the value back.
    expect(snapshot.harnesses.claude.field_provenance.binary).toBe("default");
    snapshot = await writer.resetHarnessField("claude", "write_permission_mode");
    expect(snapshot.harnesses.claude.write_permission_mode).toBe("acceptEdits");
    expect(snapshot.harnesses.claude.field_provenance.write_permission_mode).toBe("default");
  });

  it("does the same for a model field, and ignores a hand-written _unset of a field the built-in lacks", () => {
    writeFileSync(userPath, '[models.alpha]\n_unset = ["vendor_family", "cli_provider"]\n');
    const { models } = manager.load();
    expect(models.alpha.vendor_family).toBeUndefined();
    expect(models.alpha.field_provenance.vendor_family).toBe("overridden");
    expect(models.alpha.field_provenance.cli_provider).toBeUndefined();
  });
});

describe("P2-11: legacy Antigravity write_permission_mode", () => {
  it("accepts acceptEdits next to the canonical accept-edits, and still rejects unknown modes", () => {
    const harness = { driver: "antigravity", display_name: "Antigravity", binary: "agy" };
    expect(HarnessSchema.safeParse({ ...harness, write_permission_mode: "accept-edits" }).success).toBe(true);
    expect(HarnessSchema.safeParse({ ...harness, write_permission_mode: "acceptEdits" }).success).toBe(true);
    expect(HarnessSchema.safeParse({ ...harness, write_permission_mode: "yolo" }).success).toBe(false);
    // The UI-facing list keeps only the canonical spelling.
    expect(DRIVER_METADATA.antigravity.writePermissionModes).toEqual(["accept-edits", "auto"]);
  });

  it("does not quarantine the real catalog's antigravity harness for a user-set acceptEdits", () => {
    const defaults = parseDefaultCatalog(readFileSync(getDefaultCatalogPath(), "utf8"));
    const resolved = resolveConfig(defaults, { harnesses: { antigravity: { write_permission_mode: "acceptEdits" } } });
    expect(resolved.quarantined).toEqual([]);
    expect(resolved.harnesses.antigravity.write_permission_mode).toBe("acceptEdits");
  });
});
