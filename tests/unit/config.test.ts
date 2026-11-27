import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runConfigCommand } from "../../src/cli/config-cmd.js";
import { getDefaultCatalogPath, getLocksDir, getRunsDir, getUserConfigPath, getWorktreesDir } from "../../src/config/paths.js";
import { ConfigManager, computeEntityHash, resolveModelAlias } from "../../src/config/resolver.js";
import { DefaultsSchema, HarnessSchema, type ModelPatch } from "../../src/config/schema.js";
import { CLI_NAME } from "../../src/cli/name.js";
import { ConfigRevisionConflictError, ConfigWriter, breakStaleLock } from "../../src/config/writer.js";
import { logger, redactSecrets } from "../../src/logging.js";

const DEFAULT_CATALOG = `
schema_version = 1

[defaults]
max_queue_size = 12

[aliases]
old = "legacy"
legacy = "primary"

[harnesses.claude]
driver = "claude"
display_name = "Claude"
binary = "claude"
extra_args = ["--one", "--two"]

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
strengths = ["reasoning", "breadth"]
weaknesses = []
best_for = []
avoid_for = []
checked_at = "2026-01-01"

[presets.demo]
description = "Built-in preset"

[presets.demo.roles]
review = { harness = "claude", model = "old", effort = "high" }
draft = { harness = "claude", model = "primary", effort = "low" }
`;

/** Schema-only defaults for session-scoped concurrency and adaptive timeouts; they must never appear in defaults/catalog.toml. */
const ADAPTIVE_TIMEOUT_DEFAULTS = {
  concurrency_scope: "repo",
  host_max_concurrency: 24,
  auto_extend_timeout: true,
  idle_timeout_sec: 900,
  timeout_extension_sec: 600,
  activity_window_sec: 180,
} as const;
const ADAPTIVE_TIMEOUT_DEFAULT_KEYS = Object.keys(ADAPTIVE_TIMEOUT_DEFAULTS);

const CUSTOM_MODEL = {
  harness: "claude",
  display_name: "Custom",
  tier: "light",
  efforts: ["low"],
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
} satisfies ModelPatch;

describe("layered catalog", () => {
  let directory: string;
  let defaultPath: string;
  let userPath: string;
  let manager: ConfigManager;
  let writer: ConfigWriter;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "orch-config-"));
    defaultPath = join(directory, "catalog.toml");
    userPath = join(directory, "models.toml");
    writeFileSync(defaultPath, DEFAULT_CATALOG);
    manager = new ConfigManager({ defaultPath, userPath, now: () => new Date("2026-05-02T00:00:00Z") });
    writer = new ConfigWriter(manager);
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function readOverrides(): ReturnType<typeof parse> {
    return parse(readFileSync(userPath, "utf8"));
  }

  it("sets default limits for retained runs when the catalog omits them", () => {
    const snapshot = manager.load();
    expect(snapshot.config_warnings).toEqual([]);
    expect(snapshot.defaults).toMatchObject({ run_retention_days: 7, max_runs_total_mb: 512 });
  });

  it("ships the raised concurrency defaults and keeps the new tuning knobs schema-only", () => {
    const parsed = DefaultsSchema.parse({});
    expect(parsed).toMatchObject({
      max_concurrency: 8, max_queue_size: 32, default_harness_concurrency: 5, native_subagents: "cli_limit", native_subagent_depth: 2,
    });
    const shipped = new ConfigManager({ defaultPath: getDefaultCatalogPath(), userPath }).load();
    expect(shipped.defaults).toMatchObject({ max_concurrency: 8, max_queue_size: 32, default_harness_concurrency: 5 });
    const catalogDefaults = parse(readFileSync(getDefaultCatalogPath(), "utf8")).defaults as Record<string, unknown>;
    for (const key of ["default_harness_concurrency", "native_subagents", "native_subagent_depth", ...ADAPTIVE_TIMEOUT_DEFAULT_KEYS]) {
      expect(catalogDefaults).not.toHaveProperty(key);
    }
    expect(catalogDefaults).toMatchObject({ max_concurrency: 8, max_queue_size: 32, orch_max_depth: 1 });
  });

  it("provides the session concurrency and adaptive timeout defaults through the manager, schema-only", () => {
    const snapshot = manager.load();
    expect(snapshot.defaults).toMatchObject(ADAPTIVE_TIMEOUT_DEFAULTS);
    expect(snapshot.config_warnings).toEqual([]);
    expect(DefaultsSchema.parse({})).toMatchObject(ADAPTIVE_TIMEOUT_DEFAULTS);
    const shipped = new ConfigManager({ defaultPath: getDefaultCatalogPath(), userPath }).load();
    expect(shipped.defaults).toMatchObject(ADAPTIVE_TIMEOUT_DEFAULTS);
    expect(shipped.config_warnings).toEqual([]);
  });

  it.each([
    [{ default_harness_concurrency: 0 }], [{ default_harness_concurrency: 65 }], [{ native_subagents: "on" }], [{ native_subagent_depth: 4 }],
    [{ host_max_concurrency: 0 }], [{ host_max_concurrency: 257 }], [{ idle_timeout_sec: -1 }], [{ idle_timeout_sec: 86401 }],
    [{ timeout_extension_sec: 59 }], [{ timeout_extension_sec: 3601 }], [{ activity_window_sec: 29 }], [{ activity_window_sec: 1801 }],
    [{ concurrency_scope: "session" }], [{ auto_extend_timeout: "yes" }],
  ])("rejects out-of-range new defaults %j", (patch) => {
    expect(DefaultsSchema.safeParse(patch).success).toBe(false);
  });

  it("accepts a per-harness max_concurrency from 1 to 64 only", () => {
    const base = { driver: "codex", display_name: "Codex", binary: "codex" };
    expect(HarnessSchema.safeParse({ ...base, max_concurrency: 64 }).success).toBe(true);
    for (const value of [0, 65, 1.5]) expect(HarnessSchema.safeParse({ ...base, max_concurrency: value }).success).toBe(false);
  });

  it("provides standard, high-effort and maximum job timeout defaults", () => {
    const expected = {
      default_timeout_sec: 900,
      high_effort_timeout_sec: 1800,
      max_timeout_sec: 3600,
    };
    expect(DefaultsSchema.parse({})).toMatchObject(expected);
    const shipped = new ConfigManager({ defaultPath: getDefaultCatalogPath(), userPath }).load();
    expect(shipped.defaults).toMatchObject(expected);
    expect(shipped.config_warnings).toEqual([]);
  });

  it.each(["default_timeout_sec", "high_effort_timeout_sec"] as const)(
    "loads overrides and warns when %s exceeds the job timeout cap",
    (field) => {
      writeFileSync(userPath, "[defaults]\nmax_timeout_sec = 1800\nmax_queue_size = 17\n" + field + " = 2400\n");

      const snapshot = manager.load();
      expect(snapshot.defaults).toMatchObject({ [field]: 2400, max_timeout_sec: 1800, max_queue_size: 17 });
      expect(snapshot.config_warnings).toEqual([
        expect.stringContaining(`defaults.${field} (2400) exceeds defaults.max_timeout_sec (1800)`),
      ]);
    },
  );

  it.each([
    ["host_max_concurrency", 1], ["host_max_concurrency", 256], ["idle_timeout_sec", 0], ["idle_timeout_sec", 86400],
    ["timeout_extension_sec", 60], ["timeout_extension_sec", 3600], ["activity_window_sec", 30], ["activity_window_sec", 1800],
    ["concurrency_scope", "context"], ["concurrency_scope", "global"], ["auto_extend_timeout", false],
  ])("accepts %s = %s at the boundary", (field, value) => {
    expect(DefaultsSchema.safeParse({ [field]: value }).success).toBe(true);
  });

  it.each([
    ["defaults.host_max_concurrency (4) is below defaults.max_concurrency (8)", "host_max_concurrency = 4"],
    ["defaults.idle_timeout_sec (2000) exceeds defaults.max_timeout_sec (1800)", "max_timeout_sec = 1800\nidle_timeout_sec = 2000"],
    ["defaults.timeout_extension_sec (2400) exceeds defaults.max_timeout_sec (1800)", "max_timeout_sec = 1800\ntimeout_extension_sec = 2400"],
  ])("loads the override and warns: %s", (warning, toml) => {
    writeFileSync(userPath, `[defaults]\n${toml}\n`);
    const snapshot = manager.load();
    expect(snapshot.config_warnings).toEqual([expect.stringContaining(warning)]);
  });

  it("does not warn when idle detection is disabled or the new limits sit exactly on their bounds", () => {
    writeFileSync(userPath, "[defaults]\nmax_timeout_sec = 600\ndefault_timeout_sec = 600\nhigh_effort_timeout_sec = 600\nidle_timeout_sec = 0\ntimeout_extension_sec = 600\nmax_concurrency = 24\nhost_max_concurrency = 24\n");
    expect(manager.load().config_warnings).toEqual([]);
  });

  it.each([
    ["run_retention_days", 0],
    ["run_retention_days", 365],
    ["max_runs_total_mb", 0],
    ["max_runs_total_mb", 102400],
  ])("accepts %s = %i at the boundary", async (field, value) => {
    const snapshot = await writer.updateDefaults({ [field]: value });
    expect(snapshot.config_warnings).toEqual([]);
    expect(snapshot.defaults).toHaveProperty(field, value);
    expect(readOverrides().defaults).toEqual({ [field]: value });
  });

  it.each([
    ["run_retention_days", -1],
    ["run_retention_days", 366],
    ["max_runs_total_mb", -1],
    ["max_runs_total_mb", 102401],
  ])("rejects %s = %i outside the supported range", async (field, value) => {
    await expect(writer.updateDefaults({ [field]: value })).rejects.toThrow(field);
    expect(readdirSync(directory)).toEqual(["catalog.toml"]);
  });

  it("inherits omitted fields, replaces arrays and merges preset roles by field", async () => {
    writeFileSync(userPath, `
[defaults]
max_concurrency = 9

[aliases]
another = "old"

[harnesses.claude]
extra_args = []

[models.primary]
strengths = ["changed"]
enabled = false

[presets.demo.roles]
review = { effort = "low" }
draft = {}
`);
    const snapshot = await writer.upsertModelOverride("custom", CUSTOM_MODEL);

    expect(snapshot.config_warnings).toEqual([]);
    expect(snapshot.defaults).toMatchObject({ stale_after_days: 90, max_queue_size: 12, max_concurrency: 9 });
    expect(snapshot.defaults_provenance).toMatchObject({ max_queue_size: "default", max_concurrency: "overridden" });
    expect(snapshot.aliases_provenance).toMatchObject({ old: "default", another: "overridden" });
    expect(snapshot.harnesses.claude).toMatchObject({ driver: "claude", enabled: true, extra_args: [] });
    expect(snapshot.models.primary).toMatchObject({
      provenance: "overridden",
      cli_model: "primary",
      cost_note: "Built-in price note",
      strengths: ["changed"],
      enabled: false,
      is_stale: true,
      field_provenance: { cost_note: "default", strengths: "overridden", enabled: "overridden" },
    });
    expect(snapshot.models.custom).toMatchObject({
      provenance: "custom",
      cli_model: "custom",
      enabled: true,
      is_stale: false,
      field_provenance: { cli_model: "custom", display_name: "custom" },
    });
    expect(resolveModelAlias("another", snapshot.aliases)).toBe("primary");
    expect(snapshot.presets.demo.roles).toEqual({ review: { harness: "claude", model: "primary", effort: "low" } });
    expect(snapshot.presets.demo.field_provenance).toMatchObject({
      "roles.review.model": "default",
      "roles.review.effort": "overridden",
    });
  });

  it("records a stable built-in hash, saves only differences, and reports drift", async () => {
    const snapshot = await writer.upsertModelOverride("primary", {
      cost_note: "My price note",
      display_name: "Primary",
      strengths: ["reasoning", "breadth"],
    });
    const modelLayer = readOverrides().models;
    expect(modelLayer).toEqual({ primary: { cost_note: "My price note", _base_hash: expect.stringMatching(/^[a-f0-9]{12}$/) } });
    expect(snapshot.models.primary.default_changed).toBe(false);
    expect(computeEntityHash({ b: ["a", "b"], a: { y: 2, x: 1 } }))
      .toBe(computeEntityHash({ a: { x: 1, y: 2 }, b: ["a", "b"] }));
    expect(computeEntityHash({ b: ["a", "b"] })).not.toBe(computeEntityHash({ b: ["b", "a"] }));

    writeFileSync(defaultPath, DEFAULT_CATALOG.replace('speed_note = "Normal speed"', 'speed_note = "New built-in speed"'));
    const changed = manager.reloadIfChanged();
    expect(changed.revision).not.toBe(snapshot.revision);
    expect(changed.models.primary).toMatchObject({
      default_changed: true,
      speed_note: "New built-in speed",
      cost_note: "My price note",
    });
  });

  it("resets model fields, built-in entities, custom entities, and sections", async () => {
    await writer.upsertModelOverride("primary", { enabled: false, cost_note: "Edited" });
    await writer.upsertModelOverride("custom", CUSTOM_MODEL);
    await writer.upsertHarnessOverride("claude", { profile: "test" });
    await writer.upsertPresetOverride("demo", { roles: { draft: null, review: { effort: "low" } } });
    expect(readOverrides().presets).toMatchObject({ demo: { roles: { draft: {}, review: { effort: "low" } } } });
    let snapshot = await writer.upsertPresetOverride("demo", { roles: { review: { model: "old", effort: "high" } } });
    expect(snapshot.presets.demo.roles).toEqual({ review: { harness: "claude", model: "primary", effort: "high" } });
    expect(readOverrides().presets).toMatchObject({ demo: { roles: { draft: {} } } });
    expect(readOverrides().presets).not.toMatchObject({ demo: { roles: { review: expect.anything() } } });

    snapshot = await writer.resetModelField("primary", "cost_note");
    expect(snapshot.models.primary).toMatchObject({ enabled: false, cost_note: "Built-in price note" });
    snapshot = await writer.resetOrDeleteModel("primary");
    expect(snapshot.models.primary).toMatchObject({ enabled: true, provenance: "default" });
    snapshot = await writer.resetOrDeleteModel("custom");
    expect(snapshot.models).not.toHaveProperty("custom");
    snapshot = await writer.resetOrDeleteHarness("claude");
    expect(snapshot.harnesses.claude.profile).toBeUndefined();
    snapshot = await writer.resetOrDeletePreset("demo");
    expect(snapshot.presets.demo.roles).toHaveProperty("draft");
    await writer.updateDefaults({ max_queue_size: 7 });
    snapshot = await writer.resetSection("defaults");
    expect(snapshot.defaults.max_queue_size).toBe(12);
    expect(readOverrides()).toEqual({ schema_version: 1 });
  });

  it("backs up the exact user file on a full reset, even when it is broken", async () => {
    const before = Buffer.from([0xff, 0xfe, 0x5b]);
    writeFileSync(userPath, before);
    expect(manager.load().config_warnings).toHaveLength(1);

    const snapshot = await writer.resetAllToDefault(manager.getRevision());
    const backups = readdirSync(directory).filter((name) => /^models\.toml\.bak\.\d+$/.test(name));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(directory, backups[0]))).toEqual(before);
    expect(readOverrides()).toEqual({ schema_version: 1 });
    expect(snapshot.config_warnings).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(userPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(directory, backups[0])).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects the losing concurrent writer instead of overwriting the first change", async () => {
    const other = new ConfigWriter(new ConfigManager({ defaultPath, userPath }));
    const revision = manager.getRevision();
    const [first, second] = await Promise.allSettled([
      writer.updateDefaults({ max_queue_size: 4 }, revision),
      other.updateDefaults({ max_concurrency: 8 }, revision),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(second.reason).toBeInstanceOf(ConfigRevisionConflictError);
    expect(manager.reloadIfChanged().defaults).toMatchObject({ max_queue_size: 4, max_concurrency: 8 });
    expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml"]);
  });

  it("validates writes before replacement and releases the lock after rejection", async () => {
    await writer.updateDefaults({ max_queue_size: 4 });
    const before = readFileSync(userPath);
    await expect(writer.upsertModelOverride("primary", { efforts: ["low"] })).rejects.toThrow("default_effort");
    await expect(writer.upsertPresetOverride("demo", { roles: { review: { effort: "unknown" } } }))
      .rejects.toThrow("presets.demo.roles.review.effort");
    expect(readFileSync(userPath)).toEqual(before);
    expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml"]);
  });

  it("falls back to the last valid config, or to defaults on the first load", async () => {
    const saved = await writer.updateDefaults({ max_queue_size: 4 });
    writeFileSync(userPath, "[invalid");
    const broken = manager.reloadIfChanged();
    expect(broken.defaults.max_queue_size).toBe(4);
    expect(broken.revision).not.toBe(saved.revision);
    expect(broken.config_warnings[0]).toContain("last-known-good config");

    const fresh = new ConfigManager({ defaultPath, userPath }).load();
    expect(fresh.defaults.max_queue_size).toBe(12);
    expect(fresh.config_warnings[0]).toContain("built-in defaults");

    writeFileSync(userPath, '[models.primary]\nharness = "missing"');
    expect(manager.reloadIfChanged().config_warnings[0]).toContain("models.primary.harness");
    // A single broken entity is quarantined on its own: the built-in model stays and no other override is lost.
    writeFileSync(userPath, '[defaults]\nmax_queue_size = 4\n\n[models.primary]\ncustom = true\ndisplay_name = "Incomplete"');
    const quarantined = manager.reloadIfChanged();
    expect(quarantined.config_warnings[0]).toContain("Quarantined models.primary");
    expect(quarantined.quarantined).toEqual([expect.objectContaining({ section: "models", id: "primary" })]);
    expect(quarantined.models.primary.display_name).toBe("Primary");
    expect(quarantined.defaults.max_queue_size).toBe(4);

    writeFileSync(userPath, '[models.primary]\ndisplay_name = "Recovered"');
    expect(manager.reloadIfChanged().models.primary.display_name).toBe("Recovered");
    expect(manager.getSnapshot().config_warnings).toEqual([]);
  });

  it("recomputes staleness when time advances while keeping the same revision", () => {
    let now = new Date("2026-01-02T00:00:00Z");
    const clocked = new ConfigManager({ defaultPath, userPath, now: () => now });
    const fresh = clocked.load();
    expect(fresh.models.primary.is_stale).toBe(false);
    fresh.models.primary.strengths.push("caller mutation");
    now = new Date("2026-05-01T00:00:00Z");
    const later = clocked.getSnapshot();
    expect(later.revision).toBe(fresh.revision);
    expect(later.models.primary).toMatchObject({ is_stale: true, strengths: ["reasoning", "breadth"] });
  });

  describe("config lock", () => {
    const AGE_PAST_STALE_MS = 31_000;
    const lockFile = () => `${userPath}.lock`;

    function plantLock(pid: number, ageMs: number): void {
      writeFileSync(lockFile(), JSON.stringify({ pid, created_at: Date.now() - ageMs }));
      const when = new Date(Date.now() - ageMs);
      utimesSync(lockFile(), when, when);
    }

    function deadPid(): number {
      const child = spawnSync(process.execPath, ["-e", ""]);
      expect(child.pid).toBeGreaterThan(0);
      return child.pid;
    }

    it("never steals a lock from a live owner, however old the lock is (a slow holder keeps it)", async () => {
      // process.pid is alive and answers kill(pid, 0); pid 1 is alive and answers EPERM for non-root callers
      // (POSIX init only: Windows has no pid 1).
      const livePids = process.platform === "win32" ? [process.pid] : [process.pid, 1];
      for (const pid of livePids) {
        plantLock(pid, AGE_PAST_STALE_MS * 100);
        await expect(writer.updateDefaults({ max_queue_size: 4 }), `pid ${pid}`).rejects.toThrow("Timed out acquiring config lock");
        expect(existsSync(lockFile())).toBe(true);
        expect(existsSync(userPath)).toBe(false);
        rmSync(lockFile());
      }
    });

    it("breaks an old lock whose owner process no longer exists", async () => {
      plantLock(deadPid(), AGE_PAST_STALE_MS);
      await writer.updateDefaults({ max_queue_size: 4 });
      expect(readOverrides()).toMatchObject({ defaults: { max_queue_size: 4 } });
      expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml"]);
    });

    it("breaks a young lock whose owner process no longer exists", async () => {
      plantLock(deadPid(), 1_000);
      await writer.updateDefaults({ max_queue_size: 5 });
      expect(readOverrides()).toMatchObject({ defaults: { max_queue_size: 5 } });
    });

    it("keeps a young lock held by a live process and times out instead of stealing it", async () => {
      plantLock(process.pid, 1_000);
      await expect(writer.updateDefaults({ max_queue_size: 6 })).rejects.toThrow("Timed out acquiring config lock");
      expect(existsSync(lockFile())).toBe(true);
      expect(existsSync(userPath)).toBe(false);
    });

    it("lets many writers race for one stale lock without losing a write or leaving tombstones", async () => {
      plantLock(deadPid(), AGE_PAST_STALE_MS);
      const sizes = [2, 3, 4, 5, 6, 7];
      await Promise.all(sizes.map((size) => writer.updateDefaults({ max_queue_size: size })));
      expect(sizes).toContain((readOverrides().defaults as { max_queue_size: number }).max_queue_size);
      expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml"]);
    });

    it("breakStaleLock removes a stale lock through a tombstone and puts a live lock back untouched", () => {
      plantLock(deadPid(), AGE_PAST_STALE_MS);
      breakStaleLock(lockFile());
      expect(readdirSync(directory)).toEqual(["catalog.toml"]);

      // A contender replaced the stale file with a fresh live lock after our staleness check: it must survive.
      plantLock(process.pid, 100);
      const content = readFileSync(lockFile(), "utf8");
      breakStaleLock(lockFile());
      expect(readFileSync(lockFile(), "utf8")).toBe(content);
      expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml.lock"]);

      rmSync(lockFile());
      expect(() => breakStaleLock(lockFile())).not.toThrow();
    });
  });

  describe("symlinked user config", () => {
    it("keeps a dotfiles symlink and writes through it atomically", async () => {
      const dotfiles = join(directory, "dotfiles");
      mkdirSync(dotfiles);
      const target = join(dotfiles, "models.toml");
      writeFileSync(target, "schema_version = 1\n\n[defaults]\nmax_queue_size = 5\n");
      symlinkSync(target, userPath);

      await writer.updateDefaults({ max_queue_size: 4 });
      expect(lstatSync(userPath).isSymbolicLink()).toBe(true);
      expect(realpathSync(userPath)).toBe(realpathSync(target));
      expect(parse(readFileSync(target, "utf8"))).toMatchObject({ defaults: { max_queue_size: 4 } });
      expect(manager.load().defaults.max_queue_size).toBe(4);
      expect(readdirSync(dotfiles)).toEqual(["models.toml"]);

      await writer.resetAllToDefault();
      expect(lstatSync(userPath).isSymbolicLink()).toBe(true);
      expect(readdirSync(dotfiles).filter((name) => !name.startsWith("models.toml.bak."))).toEqual(["models.toml"]);
    });

    it("creates a regular file when no config exists yet and refuses a symlink to the built-in catalog", async () => {
      await writer.updateDefaults({ max_queue_size: 4 });
      expect(lstatSync(userPath).isSymbolicLink()).toBe(false);
      rmSync(userPath);
      symlinkSync(defaultPath, userPath);
      const before = readFileSync(defaultPath, "utf8");
      await expect(writer.updateDefaults({ max_queue_size: 3 })).rejects.toThrow("built-in catalog");
      expect(readFileSync(defaultPath, "utf8")).toBe(before);
    });
  });
});

describe("agrmcp config commands", () => {
  let directory: string;
  let userPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "orch-cli-config-"));
    userPath = join(directory, "models.toml");
    vi.stubEnv("ORCH_MODELS_PATH", userPath);
    vi.stubEnv("ORCH_STATE_DIR", join(directory, "state"));
    writeFileSync(userPath, '[defaults]\nlocale = "ru"\n');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects bare reset with usage and preserves the original user file", async () => {
    const before = readFileSync(userPath);
    await expect(runConfigCommand(["reset"])).rejects.toThrow(new RegExp(`Usage:[\\s\\S]*${CLI_NAME} config reset`));
    expect(readFileSync(userPath)).toEqual(before);
    expect(readdirSync(directory)).toEqual(["models.toml"]);
  });

  it("sets all fields of a preset role atomically and shows zero config warnings", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const path = "presets.balanced.roles.review";
    const role = { harness: "codex", model: "gpt-6.2-astra", effort: "high" };
    // Start with a different harness so separately updating harness and model would be invalid.
    writeFileSync(userPath, readFileSync(userPath, "utf8") +
      '[presets.balanced.roles.review]\nharness = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "low"\n');
    await runConfigCommand(["set", path, JSON.stringify(role)]);
    await runConfigCommand(["get", path]);
    expect(JSON.parse(log.mock.lastCall![0])).toEqual(role);
    await runConfigCommand(["show", "--json"]);
    expect(JSON.parse(log.mock.lastCall![0])).toMatchObject({ config_warnings: [], defaults: { locale: "ru" } });

    const saved = readFileSync(userPath);
    await expect(runConfigCommand(["set", path, JSON.stringify({ ...role, harness: "claude" })])).rejects.toThrow(/does not match model/);
    expect(readFileSync(userPath)).toEqual(saved);
  });

  it.each([
    ["{}", /non-empty JSON object[\s\S]*would delete the role/],
    ['{"unknown":"x"}', /unknown: unknown/],
    ['{"harness":""}', /invalid: harness/],
  ])("rejects %s as a whole preset role and leaves the file untouched", async (value, message) => {
    writeFileSync(userPath, readFileSync(userPath, "utf8") +
      '[presets.balanced.roles.quick]\nharness = "claude"\nmodel = "claude-haiku-5-5"\neffort = "low"\n');
    const before = readFileSync(userPath);
    await expect(runConfigCommand(["set", "presets.balanced.roles.quick", value])).rejects.toThrow(message);
    expect(readFileSync(userPath)).toEqual(before);
    expect(readdirSync(directory)).toEqual(["models.toml"]);
  });
});

describe("paths and logs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("finds the installation catalog and honors the user and state overrides", () => {
    vi.stubEnv("ORCH_MODELS_PATH", "/custom/models.toml");
    vi.stubEnv("ORCH_STATE_DIR", "/custom/state");
    expect(getDefaultCatalogPath()).toBe(join(import.meta.dirname, "../../defaults/catalog.toml"));
    expect(getUserConfigPath()).toBe("/custom/models.toml");
    expect(getRunsDir()).toBe(join("/custom/state", "runs"));
    expect(getWorktreesDir()).toBe(join("/custom/state", "worktrees"));
    expect(getLocksDir()).toBe(join("/custom/state", "locks"));
    vi.stubEnv("ORCH_MODELS_PATH", "");
    vi.stubEnv("ORCH_STATE_DIR", "");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg/config");
    vi.stubEnv("XDG_STATE_HOME", "/xdg/state");
    expect(getUserConfigPath()).toBe(join("/xdg/config", "orchestrator-mcp", "models.toml"));
    expect(getRunsDir()).toBe(join("/xdg/state", "orchestrator-mcp", "runs"));
  });

  it("redacts token formats, header values, literal extras, and matching environment values", () => {
    vi.stubEnv("ROUTER_TEST_CREDENTIAL", "env.Secret+abc");
    vi.stubEnv("ROUTER_TEST_KEY", "short");
    const secrets = ["sk-abc123", "sk-ant-local123", "ghp_local123", "xoxb-123", "local-bearer", "Basic base64", "extra+(value)", "env.Secret+abc"];
    const output = redactSecrets([
      secrets.slice(0, 4).join(" "),
      `Bearer ${secrets[4]}`,
      `Authorization: ${secrets[5]}`,
      secrets.slice(6).join(" "),
      "short stays readable",
    ].join("\n"), [secrets[6]]);
    for (const secret of secrets) expect(output).not.toContain(secret);
    expect(output).toContain("short stays readable");
    expect(output).toContain("Authorization: [REDACTED]");
  });

  it("writes redacted structured logs only to stderr", () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logger.warn("sk-abc123", { authorization: "opaque-token", nested: ["ghp_local123"] });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    expect(JSON.parse(String(stderr.mock.calls[0][0]))).toMatchObject({
      level: "warn",
      message: "[REDACTED]",
      fields: { authorization: "[REDACTED]", nested: ["[REDACTED]"] },
    });
  });
});
