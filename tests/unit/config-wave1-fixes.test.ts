/** Regression tests for fix wave 1: null rejection, lock ownership, cold-start fail-closed, redaction, resolver and writer edge cases. */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "smol-toml";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDefaultCatalogPath } from "../../src/config/paths.js";
import { ConfigManager, parseDefaultCatalog, parseUserOverrides, resolveConfig } from "../../src/config/resolver.js";
import { ConfigRevisionConflictError, ConfigWriter } from "../../src/config/writer.js";
import { DRIVER_METADATA } from "../../src/drivers.js";
import { logger, redactSecrets } from "../../src/logging.js";
import { inferVendorFamily } from "../../src/roles/registry.js";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");

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

[presets.aliased]
description = "Uses an alias"

[presets.aliased.roles]
deep = { harness = "claude", model = "shared", effort = "high" }
`;

let directory: string;
let defaultPath: string;
let userPath: string;
let manager: ConfigManager;
let writer: ConfigWriter;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orch-wave1-"));
  defaultPath = join(directory, "catalog.toml");
  userPath = join(directory, "models.toml");
  writeFileSync(defaultPath, CATALOG);
  manager = new ConfigManager({ defaultPath, userPath });
  writer = new ConfigWriter(manager);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

const readUser = (): string => readFileSync(userPath, "utf8");
const readOverrides = (): Record<string, unknown> => parse(readUser());
/** Runs a mutation callback inside the writer's lock, the way the public methods do (private on purpose; tests only). */
const mutateWith = (change: (overrides: Record<string, unknown>) => void | "unchanged") =>
  (writer as unknown as { mutate: (revision: undefined, change: unknown) => Promise<unknown> }).mutate(undefined, change);

describe("P0: null values are rejected before TOML serialization", () => {
  it("rejects null in defaults and names the field, leaving the file untouched", async () => {
    await writer.updateDefaults({ allow_unsandboxed_write: false });
    const before = readUser();
    await expect(writer.updateDefaults({ allow_unsandboxed_write: null } as never)).rejects.toThrow("defaults.allow_unsandboxed_write");
    await expect(writer.updateDefaults({ require_plan_id: null } as never)).rejects.toThrow(/null/);
    expect(readUser()).toBe(before);
    expect(manager.load().defaults.allow_unsandboxed_write).toBe(false);
  });

  it("rejects null in harness, model, and preset fields, and inside arrays", async () => {
    await expect(writer.upsertHarnessOverride("claude", { inherit_mcp: null } as never)).rejects.toThrow("harnesses.claude.inherit_mcp");
    await expect(writer.upsertModelOverride("alpha", { display_name: null } as never)).rejects.toThrow("models.alpha.display_name");
    await expect(writer.upsertModelOverride("alpha", { strengths: ["a", null] } as never)).rejects.toThrow("models.alpha.strengths[1]");
    await expect(writer.upsertPresetOverride("balanced", { description: null } as never)).rejects.toThrow("presets.balanced.description");
    await expect(writer.upsertPresetOverride("balanced", { roles: { deep: { effort: null } } } as never))
      .rejects.toThrow("presets.balanced.roles.deep.effort");
    expect(existsSync(userPath)).toBe(false);
  });

  it("finds a null nested inside arrays: in an object element, an array element, or deeper", async () => {
    await expect(writer.upsertHarnessOverride("claude", { extra_args: ["--ok", { nested: null }] } as never))
      .rejects.toThrow("harnesses.claude.extra_args[1].nested");
    await expect(writer.upsertHarnessOverride("claude", { extra_args: [["a", null]] } as never))
      .rejects.toThrow("harnesses.claude.extra_args[0][1]");
    await expect(writer.upsertModelOverride("alpha", { strengths: [{ list: [{ deep: null }] }] } as never))
      .rejects.toThrow("models.alpha.strengths[0].list[0].deep");
    await expect(writer.upsertPresetOverride("balanced", { roles: { deep: { notes: [["x", null]] } } } as never))
      .rejects.toThrow("presets.balanced.roles.deep.notes[0][1]");
    expect(existsSync(userPath)).toBe(false);
  });

  it("rejects a null alias target and a null in an imported model", async () => {
    await expect(writer.upsertAlias("fresh", null as never)).rejects.toThrow(/non-empty target/);
    await expect(writer.importModels({ create: { fresh: { harness: "claude", display_name: null } as never } })).rejects.toThrow("models.fresh.display_name");
    expect(existsSync(userPath)).toBe(false);
  });

  it("still lets presets.<id>.roles.<role> = null delete a preset role", async () => {
    await writer.upsertPresetOverride("balanced", { roles: { quick: null } });
    expect(manager.load().presets.balanced.roles).not.toHaveProperty("quick");
    expect(manager.load().presets.balanced.roles).toHaveProperty("deep");
  });

  it("validates _unset entries strictly instead of dropping bad ones", async () => {
    await expect(writer.upsertModelOverride("alpha", { _unset: ["not_a_field"] } as never)).rejects.toThrow(/cannot clear "not_a_field"/);
    await expect(writer.upsertModelOverride("alpha", { _unset: [42] } as never)).rejects.toThrow(/field names \(strings\), got number/);
    await expect(writer.upsertModelOverride("alpha", { _unset: [null] } as never)).rejects.toThrow("models.alpha._unset[0]");
    await expect(writer.upsertModelOverride("alpha", { _unset: "vendor_family" } as never)).rejects.toThrow(/JSON array/);
    await expect(writer.upsertHarnessOverride("claude", { _unset: ["driver"] } as never)).rejects.toThrow(/cannot clear "driver"/);
    await expect(writer.upsertPresetOverride("balanced", { _unset: ["description"] } as never)).rejects.toThrow(/no clearable fields/);
    expect(existsSync(userPath)).toBe(false);
    await writer.upsertModelOverride("alpha", { _unset: ["vendor_family"] });
    expect(manager.load().models.alpha.vendor_family).toBeUndefined();
  });
});

describe("P1: cross-process config lock", () => {
  const lockFile = () => `${userPath}.lock`;

  it("writes { pid, token, createdAt } on creation and removes only its own lock on release", async () => {
    let seen: { pid: number; token: string; createdAt: number } | undefined;
    await mutateWith(() => {
      seen = JSON.parse(readFileSync(lockFile(), "utf8"));
      return "unchanged";
    });
    expect(seen).toMatchObject({ pid: process.pid, token: expect.any(String), createdAt: expect.any(Number) });
    expect(existsSync(lockFile())).toBe(false);
  });

  it("leaves a lock alone that another process took after ours was stolen", async () => {
    const foreign = JSON.stringify({ pid: process.pid, token: "someone-else", createdAt: Date.now() });
    await mutateWith(() => {
      // Simulates our lock being replaced while we were slow: the file now belongs to another holder.
      rmSync(lockFile());
      writeFileSync(lockFile(), foreign);
      return "unchanged";
    });
    expect(readFileSync(lockFile(), "utf8")).toBe(foreign);
  });

  it("does not steal a young unreadable lock, and recovers an old unreadable one", async () => {
    writeFileSync(lockFile(), "{ not json");
    await expect(writer.updateDefaults({ max_queue_size: 3 })).rejects.toThrow("Timed out acquiring config lock");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(), old, old);
    await writer.updateDefaults({ max_queue_size: 3 });
    expect(readOverrides()).toMatchObject({ defaults: { max_queue_size: 3 } });
    expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml"]);
  });

  describe("two real processes", () => {
    const DIST_WRITER = join(ROOT, "dist", "config", "writer.js");
    const DIST_RESOLVER = join(ROOT, "dist", "config", "resolver.js");
    const SOURCES = ["writer.ts", "resolver.ts", "schema.ts"].map((name) => join(ROOT, "src", "config", name));

    beforeAll(async () => {
      const newestSource = Math.max(...SOURCES.map((path) => statSync(path).mtimeMs));
      if (!existsSync(DIST_WRITER) || statSync(DIST_WRITER).mtimeMs < newestSource) await run("npm", ["run", "build"], { cwd: ROOT, timeout: 120_000 });
    }, 130_000);

    const CHILD = `
      const [writerUrl, resolverUrl, defaultPath, userPath, field, base, count] = process.argv.slice(2);
      const { ConfigWriter } = await import(writerUrl);
      const { ConfigManager } = await import(resolverUrl);
      const writer = new ConfigWriter(new ConfigManager({ defaultPath, userPath }));
      for (let step = 1; step <= Number(count); step++) await writer.updateDefaults({ [field]: Number(base) + step });
    `;

    it("keeps both edits when two processes change different fields at the same time", async () => {
      const script = join(directory, "child.mjs");
      writeFileSync(script, CHILD);
      const spawnChild = (field: string, base: number) => run(process.execPath, [
        script, `file://${DIST_WRITER}`, `file://${DIST_RESOLVER}`, defaultPath, userPath, field, String(base), "20",
      ], { timeout: 60_000 });
      await Promise.all([spawnChild("max_queue_size", 100), spawnChild("default_timeout_sec", 1000)]);
      expect(readOverrides()).toMatchObject({ defaults: { max_queue_size: 120, default_timeout_sec: 1020 } });
      expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "child.mjs", "models.toml"]);
    }, 90_000);
  });
});

describe("P1: a broken user config fails closed on a cold start", () => {
  const BROKEN = ["[defaults]\nallow_unsandboxed_write = false\nmax_concurrency = \n", "[bogus]\nx = 1\n", '[defaults]\nallow_unsandboxed_write = "nope"\n'];

  it.each(BROKEN)("sets cold_start_fallback when the first load cannot use %j", (text) => {
    writeFileSync(userPath, text);
    const snapshot = manager.load();
    expect(snapshot.cold_start_fallback).toBe(true);
    expect(snapshot.config_warnings.join("\n")).toMatch(/Invalid user config/);
    expect(snapshot.defaults.allow_unsandboxed_write).toBe(true); // The built-in value, not the user's `false`.
  });

  it("does not set the flag for a missing file, a valid file, or an entity-level quarantine", () => {
    expect(manager.load().cold_start_fallback).toBe(false);
    writeFileSync(userPath, "[defaults]\nallow_unsandboxed_write = false\n[models.broken]\ncustom = true\n");
    const snapshot = manager.load();
    expect(snapshot.cold_start_fallback).toBe(false);
    expect(snapshot.quarantined.map(({ id }) => id)).toEqual(["broken"]);
  });

  it("keeps the last good config (and no flag) when the file breaks after a good load", () => {
    writeFileSync(userPath, "[defaults]\nallow_unsandboxed_write = false\n");
    expect(manager.load().defaults.allow_unsandboxed_write).toBe(false);
    writeFileSync(userPath, "[defaults\n");
    const snapshot = manager.load();
    expect(snapshot).toMatchObject({ cold_start_fallback: false, defaults: { allow_unsandboxed_write: false } });
    expect(snapshot.config_warnings.join("\n")).toContain("last-known-good");
  });

  it("can still be repaired with config reset (syntax error) and config set (bad defaults value)", async () => {
    writeFileSync(userPath, BROKEN[0]);
    expect(manager.load().cold_start_fallback).toBe(true);
    await writer.resetAllToDefault();
    expect(manager.load().cold_start_fallback).toBe(false);
    expect(readdirSync(directory).some((name) => name.startsWith("models.toml.bak."))).toBe(true);

    // A fresh process has no earlier good config in memory.
    manager = new ConfigManager({ defaultPath, userPath });
    writer = new ConfigWriter(manager);
    writeFileSync(userPath, BROKEN[2]);
    expect(manager.load().cold_start_fallback).toBe(true);
    await writer.updateDefaults({ allow_unsandboxed_write: false });
    expect(manager.load()).toMatchObject({ cold_start_fallback: false, defaults: { allow_unsandboxed_write: false } });
  });

  it("survives a user path that is a directory (EISDIR) instead of throwing", () => {
    mkdirSync(userPath);
    const snapshot = manager.load();
    expect(snapshot.cold_start_fallback).toBe(true);
    expect(snapshot.config_warnings.join("\n")).toContain("EISDIR");

    // With a good config already in memory, a later unreadable file keeps that config.
    rmSync(userPath, { recursive: true });
    writeFileSync(userPath, "[defaults]\nmax_queue_size = 3\n");
    expect(manager.load().defaults.max_queue_size).toBe(3);
    rmSync(userPath);
    mkdirSync(userPath);
    expect(manager.load()).toMatchObject({ cold_start_fallback: false, defaults: { max_queue_size: 3 } });
  });
});

describe("P1: secrets never reach logs, warnings, or write errors", () => {
  it("redacts provider token prefixes, JWTs, and X-API-Key header values", () => {
    const secrets = [
      `AIza${"a1B2".repeat(8)}`, "xai-abcdefghij1234", `github_pat_${"A1b2".repeat(6)}`, `ghs_${"a1B2".repeat(6)}`, `gho_${"a1B2".repeat(6)}`,
      "glpat-abcdefghij123456", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r",
    ];
    for (const secret of secrets) expect(redactSecrets(`value=${secret} end`), secret).toBe("value=[REDACTED] end");
    const headers = redactSecrets('X-API-Key: plainkey123\nx-api-key: "quoted key"\n{"x-api-key": "jsonkey456", "ok": 1}');
    expect(headers).not.toMatch(/plainkey123|quoted key|jsonkey456/);
  });

  it("redacts URL userinfo (also with quotes and JSON escapes), query values, and fragments", () => {
    const plain = redactSecrets('GET https://alice:p"ss@example.com/a/b?token=abc123&x=1#access_token=frag789 done');
    expect(plain).not.toMatch(/alice|p"ss|abc123|frag789/);
    expect(plain).toContain("example.com/a/b");
    const escaped = redactSecrets(String.raw`{"url":"https:\/\/bob:s3cr3t@host.example\/v1?api_key=zzz999#top"}`);
    expect(escaped).not.toMatch(/bob|s3cr3t|zzz999|#top/);
    expect(escaped).toContain("host.example");
    expect(redactSecrets("see https://example.com/docs and a@b.example")).toBe("see https://example.com/docs and a@b.example");
  });

  it("redacts a secret environment value that appears JSON-escaped", () => {
    const secret = 'pa"ss\\word-123456';
    vi.stubEnv("ROUTER_TEST_PASSWORD", secret);
    const embedded = JSON.stringify({ message: `bad value ${secret}` });
    expect(embedded).not.toContain(secret);
    expect(redactSecrets(embedded)).not.toContain("word-123456");
    expect(redactSecrets(`raw ${secret}`)).toBe("raw [REDACTED]");
  });

  it("redacts credential-named metadata fields recursively in structured logs, and keeps counts", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    logger.info("event", {
      api_key: "k1", nested: { Cookie: "c1", deeper: [{ client_secret: "s1", PASSWORD: { value: "p1" } }], safe: "visible" },
      tokens_used: 42, Authorization: "Bearer zzz",
    });
    const fields = JSON.parse(String(stderr.mock.calls[0][0])).fields;
    expect(fields).toEqual({
      api_key: "[REDACTED]",
      nested: { Cookie: "[REDACTED]", deeper: [{ client_secret: "[REDACTED]", PASSWORD: "[REDACTED]" }], safe: "visible" },
      tokens_used: 42,
      Authorization: "[REDACTED]",
    });
  });

  it("reports a TOML syntax error without the raw source lines, in warnings and in write errors", async () => {
    writeFileSync(userPath, '[defaults]\nmax_queue_size = 3\nnote = hunter2hunter2 "token-in-value"\n');
    const snapshot = manager.load();
    expect(snapshot.config_warnings.join("\n")).toMatch(/TOML syntax error at line 3, column \d+/);
    expect(snapshot.config_warnings.join("\n")).not.toMatch(/hunter2hunter2|token-in-value/);
    const failure = await writer.updateDefaults({ max_queue_size: 4 }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/TOML syntax error at line 3/);
    expect((failure as Error).message).not.toMatch(/hunter2hunter2|token-in-value/);
    expect(parseUserOverridesMessage('[x]\nkey = sk-live-0123456789abcdef bad\n')).not.toContain("sk-live-0123456789abcdef");
  });

  it("redacts quarantine reasons and config_warnings built from user values", () => {
    const secret = "sk-live-0123456789abcdef";
    writeFileSync(userPath, `[aliases]\nghost = "${secret}"\n`);
    const snapshot = manager.load();
    expect(snapshot.quarantined).toEqual([expect.objectContaining({ section: "aliases", id: "ghost" })]);
    expect(JSON.stringify(snapshot.quarantined)).not.toContain(secret);
    expect(JSON.stringify(snapshot.config_warnings)).not.toContain(secret);
    expect(snapshot.quarantined[0].reason).toContain("[REDACTED]");
  });
});

function parseUserOverridesMessage(text: string): string {
  try {
    parseUserOverrides(text);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("P2: resolver edge cases", () => {
  it("quarantines cyclic aliases and aliases to missing models one by one, keeping valid aliases and presets", () => {
    writeFileSync(userPath, '[aliases]\nloop-a = "loop-b"\nloop-b = "loop-a"\nghost = "nope"\nfine = "beta"\n');
    const snapshot = manager.load();
    expect(snapshot.cold_start_fallback).toBe(false);
    expect(snapshot.quarantined.map(({ section, id }) => `${section}.${id}`).sort()).toEqual(["aliases.ghost", "aliases.loop-a", "aliases.loop-b"]);
    expect(snapshot.aliases).toMatchObject({ fine: "beta", shared: "alpha" });
    expect(snapshot.aliases).not.toHaveProperty("ghost");
    expect(Object.keys(snapshot.presets).sort()).toEqual(["aliased", "balanced"]);
  });

  it("brings the built-in alias back when a user override of it is invalid", () => {
    writeFileSync(userPath, '[aliases]\nshared = "nope"\n');
    const snapshot = manager.load();
    expect(snapshot.quarantined).toEqual([expect.objectContaining({ section: "aliases", id: "shared" })]);
    expect(snapshot.aliases.shared).toBe("alpha");
    expect(snapshot.presets.aliased.roles.deep.model).toBe("alpha");
  });

  it("blames the model override, not the preset, when a preset override only changes metadata", () => {
    writeFileSync(userPath, '[models.alpha]\nefforts = ["low"]\ndefault_effort = "low"\n[presets.balanced]\ndescription = "Mine"\n');
    const snapshot = manager.load();
    expect(snapshot.quarantined.map(({ section, id }) => `${section}.${id}`)).toEqual(["models.alpha"]);
    expect(snapshot.presets.balanced.description).toBe("Mine");
    expect(snapshot.models.alpha.efforts).toEqual(["low", "high"]);
  });

  it("still drops a preset whose own role override is the broken part", () => {
    writeFileSync(userPath, '[presets.balanced.roles]\ndeep = { harness = "claude", model = "alpha", effort = "bogus" }\n');
    const snapshot = manager.load();
    expect(snapshot.quarantined.map(({ section, id }) => `${section}.${id}`)).toEqual(["presets.balanced"]);
    expect(snapshot.presets.balanced.roles.deep.effort).toBe("high"); // The built-in preset stays.
  });

  it("reports one quarantine record per entity when a malformed preset also fails its built-in fallback", () => {
    // `shared` now points at a model of another harness: the aliased built-in preset breaks, and no model override is to blame.
    writeFileSync(userPath, '[presets]\naliased = false\n[models.stray]\ncustom = true\nharness = "codex"\ndisplay_name = "Stray"\n' +
      `${CARD}\n[aliases]\nshared = "stray"\n`);
    const records = manager.load().quarantined.filter(({ section, id }) => section === "presets" && id === "aliased");
    expect(records).toHaveLength(1);
    expect(records[0].reason).toContain("must be a table");
  });

  it("quarantines reserved IDs such as __proto__ with a diagnostic instead of silently dropping them", () => {
    writeFileSync(userPath, '[models.__proto__]\nx = 1\n[aliases]\n__proto__ = "alpha"\n');
    const snapshot = manager.load();
    expect(snapshot.cold_start_fallback).toBe(false);
    expect(snapshot.quarantined.map(({ section, id, reason }) => `${section}.${id}: ${reason}`).sort()).toEqual([
      "aliases.__proto__: aliases.__proto__ uses a reserved name and cannot be an ID",
      "models.__proto__: models.__proto__ uses a reserved name and cannot be an ID",
    ]);
    expect(Object.getPrototypeOf(snapshot.models)).toBe(Object.prototype);
  });

  it("rejects a reserved key in [defaults] instead of letting Zod drop it", () => {
    writeFileSync(userPath, "[defaults]\n__proto__ = 1\n");
    const snapshot = manager.load();
    expect(snapshot.cold_start_fallback).toBe(true);
    expect(snapshot.config_warnings.join("\n")).toContain("defaults.__proto__ is a reserved name");
  });

  it("quarantines an impossible unquoted date instead of rolling it over, and leaves valid dates, strings, and comments alone", () => {
    const override = (date: string) => `[models.alpha]\nchecked_at = ${date}\n`;
    for (const impossible of ["2026-02-30", "2025-02-29", "2026-04-31", "2026-00-10"]) {
      writeFileSync(userPath, override(impossible));
      const snapshot = new ConfigManager({ defaultPath, userPath }).load();
      expect(snapshot.quarantined.map(({ id }) => id), impossible).toEqual(["alpha"]);
      expect(snapshot.models.alpha.checked_at, impossible).toBe("2026-01-01");
    }
    for (const fine of ["2024-02-29", "2026-02-28", "2026-03-02"]) {
      writeFileSync(userPath, override(fine));
      const snapshot = new ConfigManager({ defaultPath, userPath }).load();
      expect(snapshot.quarantined, fine).toEqual([]);
      expect(snapshot.models.alpha.checked_at, fine).toBe(fine);
    }
    writeFileSync(userPath, `# 2026-02-30 in a comment\n[models.alpha]\ndisplay_name = "built 2026-02-30"\nchecked_at = 2026-02-28 # not 2026-02-31\n`);
    const snapshot = new ConfigManager({ defaultPath, userPath }).load();
    expect(snapshot.quarantined).toEqual([]);
    expect(snapshot.models.alpha).toMatchObject({ display_name: "built 2026-02-30", checked_at: "2026-02-28" });
  });

  it("does not throw while resolving when the default catalog is resolved without overrides", () => {
    expect(() => resolveConfig(parseDefaultCatalog(CATALOG))).not.toThrow();
  });
});

describe("P2: writer edge cases", () => {
  it("writes through a dangling symlink instead of replacing it, creating the target and its folder", async () => {
    const target = join(directory, "dotfiles", "nested", "models.toml");
    mkdirSync(join(directory, "dotfiles"));
    symlinkSync(target, userPath);
    expect(existsSync(target)).toBe(false);

    await writer.updateDefaults({ max_queue_size: 4 });
    expect(lstatSync(userPath).isSymbolicLink()).toBe(true);
    expect(parse(readFileSync(target, "utf8"))).toMatchObject({ defaults: { max_queue_size: 4 } });
    expect(manager.load().defaults.max_queue_size).toBe(4);
    expect(readdirSync(join(directory, "dotfiles", "nested"))).toEqual(["models.toml"]);
  });

  it("follows a chain of dangling symlinks to the final missing target", async () => {
    const final = join(directory, "final.toml");
    const hop = join(directory, "hop.toml");
    symlinkSync(final, hop);
    symlinkSync("hop.toml", userPath); // relative link to another dangling link
    await writer.updateDefaults({ max_queue_size: 5 });
    expect(lstatSync(userPath).isSymbolicLink()).toBe(true);
    expect(lstatSync(hop).isSymbolicLink()).toBe(true);
    expect(parse(readFileSync(final, "utf8"))).toMatchObject({ defaults: { max_queue_size: 5 } });
  });

  it("refuses to overwrite an edit made by someone else while the write was being prepared", async () => {
    writeFileSync(userPath, "[defaults]\nmax_queue_size = 2\n");
    const external = "[defaults]\nmax_queue_size = 9\n# edited by hand\n";
    await expect(mutateWith((overrides) => {
      overrides.defaults = { max_queue_size: 3 };
      writeFileSync(userPath, external); // The person saves their editor right now, without taking the lock.
    })).rejects.toBeInstanceOf(ConfigRevisionConflictError);
    expect(readUser()).toBe(external);
    expect(readdirSync(directory).sort()).toEqual(["catalog.toml", "models.toml"]);
  });

  it("keeps writing normally when nothing changed underneath", async () => {
    await writer.updateDefaults({ max_queue_size: 3 });
    await writer.updateDefaults({ max_queue_size: 4 });
    expect(readOverrides()).toMatchObject({ defaults: { max_queue_size: 4 } });
  });
});

describe("P2: built-in catalog and driver facts", () => {
  const catalog = parseDefaultCatalog(readFileSync(getDefaultCatalogPath(), "utf8"));

  it("marks cursor-auto and copilot-default as an unknown vendor so they are never confirmed independent advisors", () => {
    for (const id of ["cursor-auto", "copilot-default"]) {
      const model = catalog.models[id];
      expect(model.vendor_family, id).toBe("unknown");
      expect(inferVendorFamily(model, catalog.harnesses[model.harness].driver), id).toBe("unknown");
    }
  });

  it("describes the security-audit preset with the efforts it really configures", () => {
    const preset = catalog.presets["security-audit"];
    expect(preset.description).toContain("Opus on high and Astra on xhigh");
    const efforts = (model: string) => new Set(Object.values(preset.roles).filter((role) => role.model === model).map((role) => role.effort));
    expect([...efforts("claude-opus-5-5")].sort()).toEqual(["high", "medium"]);
    expect(efforts("gpt-6.2-astra")).toContain("xhigh");
  });

  it("offers dsh only the efforts its stock models support (no medium)", () => {
    const supported = new Set<string>(DRIVER_METADATA.dsh.defaultEfforts);
    expect(supported.has("medium")).toBe(false);
    for (const [id, model] of Object.entries(catalog.models).filter(([, entry]) => catalog.harnesses[entry.harness].driver === "dsh")) {
      expect(model.efforts.every((effort) => supported.has(effort)), id).toBe(true);
    }
  });

  it("adds no new keys to [defaults] in the built-in catalog", () => {
    expect(Object.keys(parse(readFileSync(getDefaultCatalogPath(), "utf8")).defaults as object)).toEqual([
      "stale_after_days", "max_concurrency", "max_queue_size", "default_timeout_sec", "max_timeout_sec", "max_mcp_output_bytes",
      "max_log_bytes_per_job", "orch_max_depth", "inherit_mcp", "require_plan_id", "allow_unsandboxed_write",
    ]);
  });
});
