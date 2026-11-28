import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeForwardedEnvLine, mcpClientWarnings, platformWarnings, runDoctorCommand } from "../../src/cli/doctor.js";
import { runMcpCommand, runSetupCommand } from "../../src/cli/mcp-cmd.js";
import { isCurrent, createInstallContext } from "../../src/cli/mcp-clients.js";
import {
  CLIENTS, detectClient, inspectClient, inspectMcp, inspectRelevantClients, installMcpClient, resolveTargets, setupClient, uninstallMcpClient,
  type ClientStatus, type InstallContext,
} from "../../src/cli/mcp-install.js";
import { runSkillCommand } from "../../src/cli/skill-cmd.js";
import { inspectSkill } from "../../src/cli/skill-install.js";
import { discoverCliLimits, listCliConfigCandidates } from "../../src/config/cli-limits.js";
import type { HarnessConfig } from "../../src/config/schema.js";
import { readLocalModels } from "../../src/discovery/local-readers.js";
import { FAKE_NODE, SKILL_BODY, captureIo, makeFixture, read, write, type Fixture } from "./helpers/mcp-fixture.js";

const REAL = { dryRun: false, force: false };
const SYNTHETIC_SECRET = "synthetic-secret-value-0123456789";
const html = readFileSync(fileURLToPath(new URL("../../src/settings-ui/app.html", import.meta.url)), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const layoutOf = (fx: Fixture, id: keyof typeof CLIENTS) => CLIENTS[id].layout(fx.ctx);

// ---------------------------------------------------------------------------
// 1a. GEMINI_HOME for Antigravity
// ---------------------------------------------------------------------------

describe("Antigravity honors GEMINI_HOME", () => {
  it("uses <GEMINI_HOME>/config/mcp_config.json and its skills folder (modern layout)", () => {
    const fx = makeFixture();
    const gemini = join(fx.root, "gemini-home");
    const ctx = makeFixture({ homeDir: fx.home, env: { GEMINI_HOME: gemini } }).ctx;
    const layout = CLIENTS.antigravity.layout(ctx);
    expect(layout.configPath).toBe(join(gemini, "config", "mcp_config.json"));
    expect(layout.skillDir).toBe(join(gemini, "config", "skills", "orchestrate"));
    expect(layout.rootDir).toBe(join(gemini, "config"));
  });

  it("keeps the legacy <GEMINI_HOME>/antigravity layout only when it has the file and the modern one does not", () => {
    const fx = makeFixture();
    const gemini = join(fx.root, "gemini-home");
    write(join(gemini, "antigravity", "mcp_config.json"), "{}");
    const ctx = makeFixture({ homeDir: fx.home, env: { GEMINI_HOME: gemini } }).ctx;
    expect(CLIENTS.antigravity.layout(ctx).configPath).toBe(join(gemini, "antigravity", "mcp_config.json"));
    write(join(gemini, "config", "mcp_config.json"), "{}");
    expect(CLIENTS.antigravity.layout(ctx).configPath).toBe(join(gemini, "config", "mcp_config.json"));
  });

  it("ignores ~/.gemini when GEMINI_HOME is set and resolves a relative value against the context cwd", () => {
    const fx = makeFixture();
    write(join(fx.home, ".gemini", "config", "mcp_config.json"), "{}");
    const ctx = makeFixture({ homeDir: fx.home, cwd: fx.root, env: { GEMINI_HOME: "rel-gemini" } }).ctx;
    expect(CLIENTS.antigravity.layout(ctx).configPath).toBe(join(fx.root, "rel-gemini", "config", "mcp_config.json"));
  });

  it("falls back to ~/.gemini without the variable", () => {
    const fx = makeFixture();
    expect(layoutOf(fx, "antigravity").configPath).toBe(join(fx.home, ".gemini", "config", "mcp_config.json"));
  });

  it("matches the variable name case-insensitively on win32 only", () => {
    const fx = makeFixture();
    const gemini = join(fx.root, "gh");
    const win = makeFixture({ homeDir: fx.home, platform: "win32", env: { Gemini_Home: gemini } }).ctx;
    expect(CLIENTS.antigravity.layout(win).configPath).toBe(join(gemini, "config", "mcp_config.json"));
    const linux = makeFixture({ homeDir: fx.home, platform: "linux", env: { Gemini_Home: gemini } }).ctx;
    expect(CLIENTS.antigravity.layout(linux).configPath).toBe(join(fx.home, ".gemini", "config", "mcp_config.json"));
  });

  it("readAntigravity reads <GEMINI_HOME>/antigravity-cli/settings.json (case-insensitive on win32)", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-wave-c-readers-"));
    try {
      const gemini = join(root, "gh");
      write(join(gemini, "antigravity-cli", "settings.json"), JSON.stringify({ model: "gemini-from-gemini-home" }));
      write(join(root, "home", ".gemini", "antigravity-cli", "settings.json"), JSON.stringify({ model: "gemini-from-home" }));
      const harness: HarnessConfig = { driver: "antigravity", display_name: "a", binary: "agy", enabled: true };
      const run = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform) => readLocalModels({
        harnessId: "antigravity", harness, driver: "antigravity", discovery: "native", homeDir: join(root, "home"), env, platform, cwd: root,
      });
      expect((await run({ GEMINI_HOME: gemini })).models.map((model) => model.cli_model)).toEqual(["gemini-from-gemini-home"]);
      expect((await run({})).models.map((model) => model.cli_model)).toEqual(["gemini-from-home"]);
      // The lowercase name matches GEMINI_HOME on win32 (reading from `gemini`, never home) and is ignored on POSIX.
      if (process.platform === "win32") {
        expect((await run({ gemini_home: gemini }, "win32")).models.map((model) => model.cli_model)).toEqual(["gemini-from-gemini-home"]);
      } else {
        expect((await run({ gemini_home: gemini }, "linux")).models.map((model) => model.cli_model)).toEqual(["gemini-from-home"]);
        expect((await run({ gemini_home: gemini }, "win32")).models.map((model) => model.cli_model)).toEqual([]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. T3 Code isolated Antigravity profiles
// ---------------------------------------------------------------------------

describe("T3 Code Antigravity profiles", () => {
  const providers = (fx: Fixture) => join(fx.home, ".t3", "userdata", "providers", "antigravity");

  /** A profile directory with an MCP config (or, with `mcp: false`, some other own content). */
  function profile(fx: Fixture, name: string, options: { mcp?: boolean; base?: string } = {}): string {
    const dir = join(options.base ?? providers(fx), name);
    if (options.mcp === false) write(join(dir, "config", "settings.json"), "{}");
    else write(join(dir, "config", "mcp_config.json"), "{}");
    return dir;
  }

  const ids = async (fx: Fixture) => (await CLIENTS.antigravity.instances!(fx.ctx)).map((target) => target.targetId);

  it("discovers a profile with the documented layout and a short id from the first 12 characters", async () => {
    const fx = makeFixture();
    const dir = profile(fx, "0123456789abcdef");
    const [target] = await CLIENTS.antigravity.instances!(fx.ctx);
    expect(target).toMatchObject({ instance: "t3:0123456789ab", targetId: "antigravity:t3:0123456789ab" });
    expect(target.layout.configPath).toBe(join(dir, "config", "mcp_config.json"));
    expect(target.layout.skillDir).toBe(join(dir, "config", "skills", "orchestrate"));
    expect(target.spec).toBe(CLIENTS.antigravity);
  });

  it("honors T3_HOME instead of ~/.t3 (also on win32 with a differently cased name)", async () => {
    const fx = makeFixture();
    const t3 = join(fx.root, "custom-t3");
    profile(fx, "aaaaaaaa11", { base: join(t3, "userdata", "providers", "antigravity") });
    profile(fx, "bbbbbbbb22");
    const custom = makeFixture({ homeDir: fx.home, env: { T3_HOME: t3 } }).ctx;
    expect((await CLIENTS.antigravity.instances!(custom)).map((target) => target.targetId)).toEqual(["antigravity:t3:aaaaaaaa11"]);
    const win = makeFixture({ homeDir: fx.home, platform: "win32", env: { t3_home: t3 } }).ctx;
    expect((await CLIENTS.antigravity.instances!(win)).map((target) => target.targetId)).toEqual(["antigravity:t3:aaaaaaaa11"]);
    expect(await ids(fx)).toEqual(["antigravity:t3:bbbbbbbb22"]);
  });

  it("accepts a profile that has other own content but no MCP file yet, and skips an empty or skills-only one", async () => {
    const fx = makeFixture();
    profile(fx, "withsettings", { mcp: false });
    mkdirSync(join(providers(fx), "emptyconfig", "config"), { recursive: true });
    mkdirSync(join(providers(fx), "skillsonly", "config", "skills", "orchestrate"), { recursive: true });
    mkdirSync(join(providers(fx), "noconfig"), { recursive: true });
    write(join(providers(fx), "plainfile"), "x");
    expect(await ids(fx)).toEqual(["antigravity:t3:withsettings"]);
  });

  it("returns nothing when the T3 directory does not exist", async () => {
    const fx = makeFixture();
    expect(await ids(fx)).toEqual([]);
  });

  it("keeps a fixed 12-character short id and extends it only when two profiles share their first 12 characters", async () => {
    const fx = makeFixture();
    profile(fx, "abcdefghijkl-one");
    profile(fx, "abcdefghijkl-two");
    profile(fx, "zzzzzzzzzzzzzzzz");
    expect(await ids(fx)).toEqual(["antigravity:t3:abcdefghijkl-o", "antigravity:t3:abcdefghijkl-t", "antigravity:t3:zzzzzzzzzzzz"]);
  });

  it("does not scan below the first level and skips symlinked profile directories", async () => {
    const fx = makeFixture();
    const outside = join(fx.root, "outside-profile");
    write(join(outside, "config", "mcp_config.json"), "{}");
    mkdirSync(providers(fx), { recursive: true });
    symlinkSync(outside, join(providers(fx), "linkedprofile"), "dir");
    write(join(providers(fx), "nested", "deeper", "config", "mcp_config.json"), "{}");
    profile(fx, "realprofile");
    expect(await ids(fx)).toEqual(["antigravity:t3:realprofile"]);
  });

  it("skips a profile whose config directory is a symlink out of the profile", async () => {
    const fx = makeFixture();
    const outside = join(fx.root, "outside-config");
    write(join(outside, "mcp_config.json"), "{}");
    mkdirSync(join(providers(fx), "escapee"), { recursive: true });
    symlinkSync(outside, join(providers(fx), "escapee", "config"), "dir");
    expect(await ids(fx)).toEqual([]);
  });

  it("rejects invalid directory names", async () => {
    const fx = makeFixture();
    profile(fx, "has space");
    profile(fx, "semi;colon");
    profile(fx, "dollar$name");
    profile(fx, "ünïcode-profile");
    profile(fx, "x".repeat(129));
    profile(fx, "ok.name_1-2");
    expect(await ids(fx)).toEqual(["antigravity:t3:ok.name_1-2"]);
  });

  it("accepts a name of exactly 128 characters", async () => {
    const fx = makeFixture();
    profile(fx, "y".repeat(128));
    expect(await ids(fx)).toEqual([`antigravity:t3:${"y".repeat(12)}`]);
  });

  it("caps the profiles at 32, taking them in sorted order", async () => {
    const fx = makeFixture();
    for (let index = 0; index < 40; index += 1) profile(fx, `p${String(index).padStart(2, "0")}-profile`);
    const found = await ids(fx);
    expect(found).toHaveLength(32);
    expect(found[0]).toBe("antigravity:t3:p00-profile");
    expect(found[31]).toBe("antigravity:t3:p31-profile");
  });

  it("does not repeat a profile that GEMINI_HOME already makes the primary antigravity entry", async () => {
    const fx = makeFixture();
    const own = profile(fx, "primaryprofile");
    profile(fx, "otherprofile");
    const ctx = makeFixture({ homeDir: fx.home, env: { GEMINI_HOME: own } }).ctx;
    expect(CLIENTS.antigravity.layout(ctx).configPath).toBe(join(own, "config", "mcp_config.json"));
    expect((await CLIENTS.antigravity.instances!(ctx)).map((target) => target.targetId)).toEqual(["antigravity:t3:otherprofile"]);
    const resolved = await resolveTargets(ctx, ["antigravity"]);
    expect(resolved.targets.map((target) => target.targetId)).toEqual(["antigravity", "antigravity:t3:otherprofile"]);
  });

  it("dedupes two profiles whose config resolves to the same file", async () => {
    const fx = makeFixture();
    const first = profile(fx, "aaaa-first");
    mkdirSync(join(providers(fx), "bbbb-second"), { recursive: true });
    // The second profile's config directory is a real directory, but its MCP file is a link to the first one's.
    mkdirSync(join(providers(fx), "bbbb-second", "config"), { recursive: true });
    symlinkSync(join(first, "config", "mcp_config.json"), join(providers(fx), "bbbb-second", "config", "mcp_config.json"));
    expect(await ids(fx)).toEqual(["antigravity:t3:aaaa-first"]);
  });

  it("`--target all` returns detected primaries plus every instance, `antigravity` the primary plus instances, and `antigravity:t3:<id>` exactly one", async () => {
    const fx = makeFixture();
    profile(fx, "aaaaaaaa-1");
    profile(fx, "bbbbbbbb-2");
    const all = await resolveTargets(fx.ctx, ["all"]);
    // The primary Antigravity is not set up here, so `all` lists only the instances.
    expect(all.targets.map((target) => target.targetId)).toEqual(["antigravity:t3:aaaaaaaa-1", "antigravity:t3:bbbbbbbb-2"]);
    expect(all.specs).toEqual([]);
    expect(all.auto).toBe(true);

    write(join(fx.home, ".gemini", "config", "mcp_config.json"), "{}");
    const withPrimary = await resolveTargets(fx.ctx, ["all"]);
    expect(withPrimary.targets.map((target) => target.targetId)).toEqual(["antigravity", "antigravity:t3:aaaaaaaa-1", "antigravity:t3:bbbbbbbb-2"]);
    expect(withPrimary.specs).toEqual([CLIENTS.antigravity]);

    const family = await resolveTargets(makeFixture({ homeDir: join(fx.root, "elsewhere"), env: { T3_HOME: join(fx.home, ".t3") } }).ctx, ["antigravity"]);
    expect(family.targets.map((target) => target.targetId)).toEqual(["antigravity", "antigravity:t3:aaaaaaaa-1", "antigravity:t3:bbbbbbbb-2"]);

    const one = await resolveTargets(fx.ctx, ["antigravity:t3:bbbbbbbb-2"]);
    expect(one.targets.map((target) => target.targetId)).toEqual(["antigravity:t3:bbbbbbbb-2"]);
    expect(one.specs).toEqual([]);
    expect(one.auto).toBe(false);

    const dedupedList = await resolveTargets(fx.ctx, ["antigravity", "antigravity:t3:aaaaaaaa-1", "all"]);
    expect(dedupedList.targets.map((target) => target.targetId)).toEqual(["antigravity", "antigravity:t3:aaaaaaaa-1", "antigravity:t3:bbbbbbbb-2"]);
  });

  it.each([
    ["antigravity:t3:missing", /Unknown target "antigravity:t3:missing"/],
    ["antigravity:", /Unknown target "antigravity:"/],
    ["claude:t3:aaaaaaaa-1", /Unknown target "claude:t3:aaaaaaaa-1"/],
    ["nope:t3:aaaaaaaa-1", /Unknown target "nope:t3:aaaaaaaa-1"/],
  ])("rejects %s with a clean Unknown target error", async (target, pattern) => {
    const fx = makeFixture();
    profile(fx, "aaaaaaaa-1");
    await expect(resolveTargets(fx.ctx, [target])).rejects.toThrow(pattern);
  });

  it("keeps primary JSON byte-compatible (no `instance` key) and sets `instance` on a profile, with the instance fix command", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".gemini", "config", "mcp_config.json"), "{}");
    const before = captureIo();
    await runMcpCommand(["status", "--json", "--target", "antigravity"], before.io, fx.ctx);
    const noProfiles = JSON.parse(before.out.join("")) as { targets: Array<Record<string, unknown>> };
    expect(noProfiles.targets).toHaveLength(1);
    expect(Object.keys(noProfiles.targets[0])).toEqual([
      "client", "label", "detected", "detected_by", "config_path", "skill_path", "mcp_status", "skill_status", "relevant", "fix_command",
    ]);

    profile(fx, "feedface-profile");
    const after = captureIo();
    await runMcpCommand(["status", "--json", "--target", "antigravity"], after.io, fx.ctx);
    const targets = (JSON.parse(after.out.join("")) as { targets: Array<Record<string, unknown>> }).targets;
    expect(targets).toHaveLength(2);
    expect(Object.keys(targets[0])).toEqual(Object.keys(noProfiles.targets[0]));
    expect(targets[1]).toMatchObject({ client: "antigravity", instance: "t3:feedface-pro", mcp_status: "missing", fix_command: "agrmcp setup --target antigravity:t3:feedface-pro" });
    expect(Object.keys(targets[1])[1]).toBe("instance");
  });

  it("shows antigravity:t3:<id> in human tables and messages", async () => {
    const fx = makeFixture();
    profile(fx, "feedface-profile");
    const status = captureIo();
    await runMcpCommand(["status", "--target", "all"], status.io, fx.ctx);
    const text = status.out.join("\n");
    expect(text).toContain("antigravity:t3:feedface-pro");
    expect(text).toContain("fix with `agrmcp setup --target antigravity:t3:feedface-pro`");

    const install = captureIo();
    expect(await runMcpCommand(["install", "--target", "antigravity:t3:feedface-pro", "--dry-run"], install.io, fx.ctx)).toBe(0);
    expect(install.out.join("\n")).toContain("antigravity:t3:feedface-pro");
  });

  it("installs, repairs and removes the entry only inside the selected profile", async () => {
    const fx = makeFixture();
    const one = profile(fx, "aaaaaaaa-1");
    const two = profile(fx, "bbbbbbbb-2");
    const io = captureIo();
    expect(await runMcpCommand(["install", "--target", "antigravity:t3:aaaaaaaa-1", "--json"], io.io, fx.ctx)).toBe(0);
    const json = JSON.parse(io.out.join("")) as { targets: Array<{ instance?: string; action: string; config_path: string }> };
    expect(json.targets).toHaveLength(1);
    expect(json.targets[0]).toMatchObject({ instance: "t3:aaaaaaaa-1", action: "created", config_path: join(one, "config", "mcp_config.json") });
    expect(JSON.parse(read(join(one, "config", "mcp_config.json"))).mcpServers.orchestrator).toEqual({ command: FAKE_NODE, args: [fx.entry, "mcp"] });
    expect(read(join(two, "config", "mcp_config.json"))).toBe("{}");
    expect(existsSync(join(fx.home, ".gemini"))).toBe(false);

    const removed = captureIo();
    await runMcpCommand(["uninstall", "--target", "antigravity:t3:aaaaaaaa-1"], removed.io, fx.ctx);
    expect(JSON.parse(read(join(one, "config", "mcp_config.json")))).toEqual({ mcpServers: {} });
    expect(read(join(two, "config", "mcp_config.json"))).toBe("{}");
  });

  it("`antigravity` installs into the primary and all profiles; direct callers may pass a spec or a target", async () => {
    const fx = makeFixture();
    const one = profile(fx, "aaaaaaaa-1");
    const io = captureIo();
    expect(await runMcpCommand(["install", "--target", "antigravity", "--json"], io.io, fx.ctx)).toBe(0);
    const json = JSON.parse(io.out.join("")) as { targets: Array<{ instance?: string }> };
    expect(json.targets.map((target) => target.instance)).toEqual([undefined, "t3:aaaaaaaa-1"]);
    expect(Object.hasOwn(json.targets[0], "instance")).toBe(false);
    expect(existsSync(join(fx.home, ".gemini", "config", "mcp_config.json"))).toBe(true);
    expect(JSON.parse(read(join(one, "config", "mcp_config.json"))).mcpServers.orchestrator.command).toBe(FAKE_NODE);

    // Backwards-compatible entry points: a bare spec means the primary location.
    expect((await inspectClient(CLIENTS.antigravity, fx.ctx)).mcp_status).toBe("current");
    expect((await inspectMcp(CLIENTS.antigravity, fx.ctx)).status).toBe("current");
    const [, instance] = (await resolveTargets(fx.ctx, ["antigravity"])).targets;
    expect((await inspectClient(instance, fx.ctx)).instance).toBe("t3:aaaaaaaa-1");
    expect((await uninstallMcpClient(instance, fx.ctx, REAL)).action).toBe("removed");
    expect((await installMcpClient(CLIENTS.antigravity, fx.ctx, REAL)).action).toBe("unchanged");
    expect((await uninstallMcpClient(CLIENTS.antigravity, fx.ctx, REAL)).action).toBe("removed");
  });

  it("detects an instance by its profile, never by the client's binary on PATH", async () => {
    const fx = makeFixture({ pathResolver: (binary) => `/usr/bin/${binary}` });
    profile(fx, "aaaaaaaa-1");
    const [primary, instance] = (await resolveTargets(fx.ctx, ["antigravity"])).targets;
    expect((await detectClient(primary, fx.ctx)).reasons.some((reason) => reason.startsWith("binary "))).toBe(true);
    const detected = await detectClient(instance, fx.ctx);
    expect(detected.detected).toBe(true);
    expect(detected.reasons.some((reason) => reason.startsWith("binary "))).toBe(false);
  });

  it("lists instances as relevant clients and names them in doctor warnings", async () => {
    const fx = makeFixture();
    profile(fx, "aaaaaaaa-1");
    const relevant = await inspectRelevantClients(fx.ctx);
    expect(relevant.map((status) => [status.client, status.instance])).toEqual([["antigravity", "t3:aaaaaaaa-1"]]);
    expect(mcpClientWarnings(relevant)[0]).toBe(
      "Antigravity CLI (antigravity:t3:aaaaaaaa-1): MCP registration is missing; run `agrmcp setup --target antigravity:t3:aaaaaaaa-1`.",
    );
    const primary: ClientStatus = { ...relevant[0], instance: undefined };
    expect(mcpClientWarnings([primary])[0]).toContain("Antigravity CLI (antigravity):");
  });

  describe("a config/skills folder that is a symlink to the shared skills folder", () => {
    function linkedSkills(fx: Fixture, name: string): { shared: string; dir: string } {
      const shared = join(fx.home, ".gemini", "config", "skills");
      write(join(shared, "other-skill", "SKILL.md"), "other\n");
      const dir = profile(fx, name);
      symlinkSync(shared, join(dir, "config", "skills"), "dir");
      return { shared, dir };
    }

    it("inspects and installs the skill through the link", async () => {
      const fx = makeFixture();
      const { shared, dir } = linkedSkills(fx, "aaaaaaaa-1");
      const [instance] = await CLIENTS.antigravity.instances!(fx.ctx);
      expect((await inspectSkill(instance.layout.skillDir, fx.skillSource)).status).toBe("missing");
      const result = await setupClient(instance, fx.ctx, REAL);
      expect(result).toMatchObject({ ok: true, verified: true });
      expect(result.mcp.instance).toBe("t3:aaaaaaaa-1");
      expect(read(join(shared, "orchestrate", "SKILL.md"))).toBe(SKILL_BODY);
      expect(read(join(dir, "config", "skills", "orchestrate", "SKILL.md"))).toBe(SKILL_BODY);
      expect((await inspectClient(instance, fx.ctx)).skill_status).toBe("current");
      expect(realpathSync(join(dir, "config", "skills"))).toBe(realpathSync(shared));
    });

    it("`skill install --target all` writes the shared folder once", async () => {
      const fx = makeFixture();
      linkedSkills(fx, "aaaaaaaa-1");
      const io = captureIo();
      expect(await runSkillCommand(["install", "--target", "antigravity"], io.io, fx.ctx)).toBe(0);
      expect(io.out).toEqual([join(fx.home, ".gemini", "config", "skills", "orchestrate", "SKILL.md")]);
      const all = captureIo();
      expect(await runSkillCommand(["install", "--target", "all"], all.io, fx.ctx)).toBe(0);
      expect(all.out.filter((line) => line.includes(join(".gemini", "config", "skills")))).toHaveLength(1);
      expect(all.out.some((line) => relative(fx.home, line).startsWith(".t3"))).toBe(false);
    });

    it("`skill install --target antigravity:t3:<id>` installs into that profile and notes a missing MCP entry by its full target id", async () => {
      const fx = makeFixture();
      const dir = profile(fx, "cccccccc-1");
      const io = captureIo();
      expect(await runSkillCommand(["install", "--target", "antigravity:t3:cccccccc-1"], io.io, fx.ctx)).toBe(0);
      expect(io.out).toEqual([join(dir, "config", "skills", "orchestrate", "SKILL.md")]);
      expect(io.err.join("\n")).toContain("Note: antigravity:t3:cccccccc-1: the skill is installed but its MCP registration is missing. Run: agrmcp mcp install --target antigravity:t3:cccccccc-1");
      await expect(runSkillCommand(["install", "--target", "antigravity:t3:zzzzzzzz"], captureIo().io, fx.ctx)).rejects.toThrow(/Unknown target/);
    });

    it("`skill install --target all` reaches an instance whose skills folder is its own", async () => {
      const fx = makeFixture();
      const dir = profile(fx, "dddddddd-1");
      const io = captureIo();
      expect(await runSkillCommand(["install", "--target", "all"], io.io, fx.ctx)).toBe(0);
      expect(io.out).toContain(join(dir, "config", "skills", "orchestrate", "SKILL.md"));
    });

    it("`setup --target all --json` marks the instance and keeps the primary entry free of it", async () => {
      const fx = makeFixture();
      write(join(fx.home, ".gemini", "config", "mcp_config.json"), "{}");
      profile(fx, "eeeeeeee-1");
      const io = captureIo();
      expect(await runSetupCommand(["--target", "antigravity", "--json"], io.io, fx.ctx)).toBe(0);
      const json = JSON.parse(io.out.join("")) as { targets: Array<{ mcp: Record<string, unknown>; verified: boolean }> };
      expect(json.targets.map((target) => target.mcp.instance)).toEqual([undefined, "t3:eeeeeeee-1"]);
      expect(json.targets.every((target) => target.verified)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Systemic env-dir parity, explicit OPENCODE_CONFIG, strict isCurrent
// ---------------------------------------------------------------------------

describe("environment directory parity in the MCP client layouts", () => {
  it.each([
    ["fx", "FX_HOME", "mcp.json"],
    ["qwen", "QWEN_HOME", "settings.json"],
    ["kimi", "KIMI_CODE_HOME", "mcp.json"],
  ] as const)("%s honors %s (absolute, relative to the context cwd, and case-insensitive on win32)", (id, variable, file) => {
    const fx = makeFixture();
    const dir = join(fx.root, `${id}-root`);
    const ctx = (overrides: Partial<InstallContext>) => makeFixture({ homeDir: fx.home, cwd: fx.root, ...overrides }).ctx;
    const absolute = CLIENTS[id].layout(ctx({ env: { [variable]: dir } }));
    expect(absolute.configPath).toBe(join(dir, file));
    expect(absolute.skillDir).toBe(join(dir, "skills", "orchestrate"));
    expect(CLIENTS[id].layout(ctx({ env: { [variable]: `rel-${id}` } })).configPath).toBe(join(fx.root, `rel-${id}`, file));
    expect(CLIENTS[id].layout(ctx({ platform: "win32", env: { [variable.toLowerCase()]: dir } })).configPath).toBe(join(dir, file));
    expect(CLIENTS[id].layout(ctx({ platform: "linux", env: { [variable.toLowerCase()]: dir } })).configPath).not.toBe(join(dir, file));
  });

  it("keeps the home-relative defaults without the variables", () => {
    const fx = makeFixture();
    expect(layoutOf(fx, "fx").configPath).toBe(join(fx.home, ".fx", "mcp.json"));
    expect(layoutOf(fx, "qwen").configPath).toBe(join(fx.home, ".qwen", "settings.json"));
    expect(layoutOf(fx, "kimi").configPath).toBe(join(fx.home, ".kimi-code", "mcp.json"));
  });

  it("matches other directory variables case-insensitively on win32 (CODEX_HOME, XDG_CONFIG_HOME)", () => {
    const fx = makeFixture();
    const win = makeFixture({ homeDir: fx.home, platform: "win32", env: { codex_home: join(fx.root, "codex"), xdg_config_home: join(fx.root, "xdg") } }).ctx;
    expect(CLIENTS.codex.layout(win).configPath).toBe(join(fx.root, "codex", "config.toml"));
    expect(CLIENTS.muse.layout(win).configPath).toBe(join(fx.root, "xdg", "muse", "settings.json"));
  });

  it("createInstallContext resolves PATH and PATHEXT case-insensitively on win32 only", () => {
    const fx = makeFixture();
    const bin = join(fx.root, "bin");
    write(join(bin, "tool.cmd"), "@echo off\n");
    chmodSync(join(bin, "tool.cmd"), 0o755);
    const env = { Path: bin, PathExt: ".CMD;.EXE" };
    const win = createInstallContext({ env, platform: "win32", homeDir: fx.home });
    expect(win.pathResolver("tool")).toBe(join(bin, "tool.cmd"));
    const linux = createInstallContext({ env, platform: "linux", homeDir: fx.home });
    expect(linux.pathResolver("tool")).toBeUndefined();
  });

  it("an explicit OPENCODE_CONFIG that does not exist yet is where `mcp install` writes", async () => {
    const fx = makeFixture();
    const explicit = join(fx.root, "custom", "opencode-work.json");
    const ctx = makeFixture({ homeDir: fx.home, env: { OPENCODE_CONFIG: explicit } }).ctx;
    expect(CLIENTS.opencode.layout(ctx).configPath).toBe(explicit);
    const result = await installMcpClient(CLIENTS.opencode, ctx, REAL);
    expect(result).toMatchObject({ action: "created", config_path: explicit, status_after: "current" });
    expect(JSON.parse(read(explicit)).mcp.servers.orchestrator.command).toEqual([FAKE_NODE, ctx.entryPath, "mcp"]);
    expect(existsSync(join(fx.home, ".config", "opencode", "opencode.json"))).toBe(false);
  });

  it("without OPENCODE_CONFIG the existing opencode.jsonc is still preferred", () => {
    const fx = makeFixture();
    write(join(fx.home, ".config", "opencode", "opencode.jsonc"), "{}");
    expect(layoutOf(fx, "opencode").configPath).toBe(join(fx.home, ".config", "opencode", "opencode.jsonc"));
  });
});

describe("isCurrent requires absolute launcher paths", () => {
  it("accepts the canonical absolute command and rejects a relative script path that merely resolves to the entry", () => {
    const fx = makeFixture();
    expect(isCurrent([FAKE_NODE, fx.entry, "mcp"], fx.ctx)).toBe(true);
    const relativeEntry = relative(process.cwd(), fx.entry);
    // On Windows runners cwd (D:) and tmpdir (C:) may sit on different drives, where path.relative returns an absolute path.
    if (!isAbsolute(relativeEntry)) {
      expect(resolve(relativeEntry)).toBe(fx.entry);
      expect(isCurrent([FAKE_NODE, relativeEntry, "mcp"], fx.ctx)).toBe(false);
    }
    expect(isCurrent([FAKE_NODE, "dist/cli/main.js", "mcp"], fx.ctx)).toBe(false);
    expect(isCurrent([FAKE_NODE, "./dist/cli/main.js", "mcp"], fx.ctx)).toBe(false);
  });

  it("rejects a bare `node` even when the context's node path would resolve from the working directory", () => {
    const fx = makeFixture({ nodePath: resolve("node") });
    expect(isCurrent([resolve("node"), fx.entry, "mcp"], fx.ctx)).toBe(true);
    expect(isCurrent(["node", fx.entry, "mcp"], fx.ctx)).toBe(false);
  });

  it("still accepts `agrmcp mcp` when PATH resolves it to this build's entry, and rejects one that leads elsewhere", () => {
    const fx = makeFixture();
    const bin = join(fx.root, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(fx.entry, join(bin, "agrmcp"));
    const other = join(fx.root, "other", "dist", "cli", "main.js");
    write(other, "// other\n");
    const resolver = (target: string) => (binary: string) => (binary === "agrmcp" ? target : undefined);
    expect(isCurrent(["agrmcp", "mcp"], makeFixture({ ...fx.ctx, pathResolver: resolver(join(bin, "agrmcp")) }).ctx)).toBe(true);
    expect(isCurrent(["agrmcp", "mcp"], makeFixture({ ...fx.ctx, pathResolver: resolver(other) }).ctx)).toBe(false);
    expect(isCurrent(["agrmcp", "mcp"], fx.ctx)).toBe(false);
  });

  it("classifies a relative-script registration as stale, so install repairs it", async () => {
    const fx = makeFixture();
    const rel = relative(process.cwd(), fx.entry);
    const relativeEntry = isAbsolute(rel) ? "dist/cli/main.js" : rel;
    write(join(fx.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { orchestrator: { command: FAKE_NODE, args: [relativeEntry, "mcp"] } } }));
    expect((await inspectMcp(CLIENTS.cursor, fx.ctx)).status).toBe("stale");
    expect((await installMcpClient(CLIENTS.cursor, fx.ctx, REAL)).action).toBe("updated");
    expect((await inspectMcp(CLIENTS.cursor, fx.ctx)).status).toBe("current");
  });
});

describe("CLI limit discovery environment parity", () => {
  const options = (fx: Fixture, extra: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; cwd?: string } = {}) => ({
    env: {}, platform: process.platform, home: fx.home, cwd: fx.root, refresh: true, ...extra,
  });
  const harness = (driver: HarnessConfig["driver"], extra: Partial<HarnessConfig> = {}): HarnessConfig => ({ driver, display_name: driver, binary: driver, enabled: true, ...extra });

  it("qwen honors QWEN_HOME and falls back to ~/.qwen", () => {
    const fx = makeFixture();
    const dir = join(fx.root, "qwen-root");
    expect(listCliConfigCandidates("qwen", {}, options(fx, { env: { QWEN_HOME: dir } })).map((c) => c.path)).toEqual([join(dir, "settings.json")]);
    expect(listCliConfigCandidates("qwen", {}, options(fx)).map((c) => c.path)).toEqual([join(fx.home, ".qwen", "settings.json")]);
    expect(listCliConfigCandidates("qwen", {}, options(fx, { env: { QWEN_HOME: "rel" } })).map((c) => c.path)).toEqual([join(fx.root, "rel", "settings.json")]);
  });

  it("kimi reads .kimi, .kimi-code and KIMI_CODE_HOME, lowest precedence first, without duplicates", () => {
    const fx = makeFixture();
    const dir = join(fx.root, "kimi-root");
    expect(listCliConfigCandidates("kimi", {}, options(fx)).map((c) => c.path)).toEqual([
      join(fx.home, ".kimi", "config.toml"), join(fx.home, ".kimi-code", "config.toml"),
    ]);
    expect(listCliConfigCandidates("kimi", {}, options(fx, { env: { KIMI_CODE_HOME: dir } })).map((c) => c.path)).toEqual([
      join(fx.home, ".kimi", "config.toml"), join(fx.home, ".kimi-code", "config.toml"), join(dir, "config.toml"),
    ]);
    expect(listCliConfigCandidates("kimi", {}, options(fx, { env: { KIMI_CODE_HOME: join(fx.home, ".kimi-code") } })).map((c) => c.path)).toEqual([
      join(fx.home, ".kimi", "config.toml"), join(fx.home, ".kimi-code", "config.toml"),
    ]);
  });

  it("applies the discovered values from QWEN_HOME and KIMI_CODE_HOME (and refreshes the cache when they change)", async () => {
    const fx = makeFixture();
    const qwen = join(fx.root, "qwen-root");
    const kimi = join(fx.root, "kimi-root");
    write(join(qwen, "settings.json"), JSON.stringify({ maxConcurrentAgents: 3 }));
    write(join(kimi, "config.toml"), "max_concurrent = 4\n");
    const withQwen = await discoverCliLimits("qwen", harness("qwen"), { ...options(fx, { env: { QWEN_HOME: qwen } }), refresh: false });
    expect(withQwen.config_files).toEqual([join(qwen, "settings.json")]);
    const withoutQwen = await discoverCliLimits("qwen", harness("qwen"), { ...options(fx), refresh: false });
    expect(withoutQwen.config_files).toEqual([]);
    const withKimi = await discoverCliLimits("kimi", harness("kimi"), { ...options(fx, { env: { KIMI_CODE_HOME: kimi } }), refresh: false });
    expect(withKimi.config_files).toEqual([join(kimi, "config.toml")]);
    const withoutKimi = await discoverCliLimits("kimi", harness("kimi"), { ...options(fx), refresh: false });
    expect(withoutKimi.config_files).toEqual([]);
  });

  it("matches the environment variable names case-insensitively on win32 only", () => {
    const winOpts = (env: NodeJS.ProcessEnv) => ({ env, platform: "win32" as const, home: "C:\\Users\\tester", cwd: "C:\\work", refresh: true });
    const linOpts = (env: NodeJS.ProcessEnv) => ({ env, platform: "linux" as const, home: "/home/tester", cwd: "/work", refresh: true });
    expect(listCliConfigCandidates("qwen", {}, winOpts({ qwen_home: "C:\\qwen-root" })).map((c) => c.path.replace(/\\/g, "/")))
      .toEqual(["C:/qwen-root/settings.json"]);
    expect(listCliConfigCandidates("qwen", {}, linOpts({ qwen_home: "/qwen-root" })).map((c) => c.path))
      .toEqual(["/home/tester/.qwen/settings.json"]);
    expect(listCliConfigCandidates("codex", {}, winOpts({ Codex_Home: "C:\\codex-root" })).map((c) => c.path.replace(/\\/g, "/")))
      .toEqual(["C:/codex-root/config.toml"]);
    expect(listCliConfigCandidates("claude", {}, winOpts({ claude_config_dir: "C:\\codex-root" }))[0].path.replace(/\\/g, "/"))
      .toBe("C:/codex-root/settings.json");
  });

  it("reads the Claude concurrency env variables case-insensitively on win32", async () => {
    const fx = makeFixture();
    const win = await discoverCliLimits("claude", harness("claude"), { ...options(fx, { platform: "win32", env: { claude_code_max_concurrent_agents: "6" } }) });
    expect(win.max_concurrent).toBe(6);
    const linux = await discoverCliLimits("claude", harness("claude"), { ...options(fx, { platform: "linux", env: { claude_code_max_concurrent_agents: "6" } }) });
    expect(linux.max_concurrent).toBe(0);
  });

  describe("codex top-level `profile`", () => {
    const toml = [
      'profile = "work"', "", "[agents]", "max_threads = 2", "", "[profiles.work.agents]", "max_threads = 7", "", "[profiles.other.agents]", "max_threads = 9", "",
    ].join("\n");

    it("applies [profiles.<profile>] when the harness names none", async () => {
      const fx = makeFixture();
      write(join(fx.home, ".codex", "config.toml"), toml);
      expect((await discoverCliLimits("codex", harness("codex"), options(fx))).max_concurrent).toBe(7);
    });

    it("lets the harness profile win over the top-level one", async () => {
      const fx = makeFixture();
      write(join(fx.home, ".codex", "config.toml"), toml);
      expect((await discoverCliLimits("codex", harness("codex", { profile: "other" }), options(fx))).max_concurrent).toBe(9);
    });

    it.each([
      ["an empty profile name", 'profile = ""\n[agents]\nmax_threads = 2\n[profiles.work.agents]\nmax_threads = 7\n'],
      ["a non-string profile", "profile = 5\n[agents]\nmax_threads = 2\n[profiles.work.agents]\nmax_threads = 7\n"],
      ["a profile without a table", 'profile = "ghost"\n[agents]\nmax_threads = 2\n[profiles.work.agents]\nmax_threads = 7\n'],
      ["no profile", "[agents]\nmax_threads = 2\n[profiles.work.agents]\nmax_threads = 7\n"],
    ])("uses the base table for %s", async (_name, content) => {
      const fx = makeFixture();
      write(join(fx.home, ".codex", "config.toml"), content);
      expect((await discoverCliLimits("codex", harness("codex"), options(fx))).max_concurrent).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. doctor: platform warnings and Claude readonly forwarded env names
// ---------------------------------------------------------------------------

describe("doctor platform warnings", () => {
  const healthOf = (driver: string, enabled = true) => ({ harness: driver, driver, enabled }) as never;
  const configOf = (...drivers: string[]) => ({ harnesses: Object.fromEntries(drivers.map((driver) => [driver, { driver, enabled: true }])) }) as never;

  const WIN_ENV = { USERPROFILE: "C:\\Users\\tester", TEMP: "D:\\Temp", TMP: "C:\\Users\\tester\\AppData\\Local\\Temp" };
  const UNC_CWD = "\\\\fileserver\\share\\OneDrive\\project";

  function claudeSettings(fx: Fixture, env: Record<string, string>): void {
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({ env }));
  }

  it("reports the Codex Windows conditions (UNC, OneDrive, TEMP outside the profile) for an enabled codex harness only", async () => {
    const fx = makeFixture();
    const context = { env: WIN_ENV, platform: "win32" as const, homeDir: fx.home, cwd: UNC_CWD };
    const report = await platformWarnings([healthOf("codex")], configOf("codex"), context);
    expect(report.warnings.join("\n")).toContain("UNC (network share)");
    expect(report.warnings.join("\n")).toContain("OneDrive");
    expect(report.warnings.join("\n")).toContain("TEMP is outside the user profile");
    expect(report.warnings.join("\n")).not.toContain("TMP is outside");
    expect(report.warnings.join("\n")).not.toContain("fileserver");
    expect(report.claudeForwardedEnv).toEqual([]);

    expect((await platformWarnings([healthOf("codex", false)], configOf("codex"), context)).warnings).toEqual([]);
    expect((await platformWarnings([healthOf("gemini")], configOf("gemini"), context)).warnings).toEqual([]);
    expect((await platformWarnings([healthOf("codex")], configOf(), context)).warnings).toEqual([]);
    expect((await platformWarnings([healthOf("codex")], configOf("codex"), { ...context, platform: "linux" })).warnings).toEqual([]);
  });

  it("reports the long-path condition on Windows", async () => {
    const fx = makeFixture();
    const cwd = `C:\\${"a".repeat(300)}`;
    const report = await platformWarnings([healthOf("codex")], configOf("codex"), { env: {}, platform: "win32", homeDir: fx.home, cwd });
    expect(report.warnings.join("\n")).toMatch(/path is 303 characters long/);
  });

  it("returns the forwarded Claude variable NAMES and never their values", async () => {
    const fx = makeFixture();
    claudeSettings(fx, { ANTHROPIC_API_KEY: SYNTHETIC_SECRET, AWS_REGION: "eu-west-1", UNRELATED_NAME: "ignored" });
    const work = join(fx.root, "work");
    mkdirSync(work, { recursive: true });
    const report = await platformWarnings([healthOf("claude")], configOf("claude"), { env: {}, platform: "linux", homeDir: fx.home, cwd: work });
    expect(report.claudeForwardedEnv).toEqual(["ANTHROPIC_API_KEY", "AWS_REGION"]);
    expect(JSON.stringify(report)).not.toContain(SYNTHETIC_SECRET);
    expect(claudeForwardedEnvLine(report.claudeForwardedEnv)).toBe(
      "Info: a readonly Claude run forwards these settings.json variables (names only): ANTHROPIC_API_KEY, AWS_REGION.",
    );
    const disabled = await platformWarnings([healthOf("claude", false)], configOf("claude"), { env: {}, platform: "linux", homeDir: fx.home, cwd: work });
    expect(disabled).toEqual({ warnings: [], claudeForwardedEnv: [] });
  });

  it("surfaces Claude readonly settings warnings (a relative CLAUDE_CONFIG_DIR, settings inside the working directory)", async () => {
    const fx = makeFixture();
    const relativeDir = await platformWarnings([healthOf("claude")], configOf("claude"), {
      env: { CLAUDE_CONFIG_DIR: "relative-dir" }, platform: "win32", homeDir: fx.home, cwd: fx.root,
    });
    expect(relativeDir.warnings).toEqual(["CLAUDE_CONFIG_DIR is not an absolute path, so the Claude settings.json auth settings were not forwarded."]);
    claudeSettings(fx, { ANTHROPIC_API_KEY: SYNTHETIC_SECRET });
    const inside = await platformWarnings([healthOf("claude")], configOf("claude"), { env: {}, platform: "linux", homeDir: fx.home, cwd: fx.root });
    expect(inside.warnings.join("\n")).toContain("lies inside the job's working directory or repository");
    expect(inside.claudeForwardedEnv).toEqual([]);
  });

  function stubDoctorEnvironment(fx: Fixture): void {
    vi.stubEnv("HOME", fx.home);
    vi.stubEnv("PATH", join(fx.root, "empty-path"));
    vi.stubEnv("XDG_CONFIG_HOME", join(fx.root, "xdg"));
    vi.stubEnv("XDG_STATE_HOME", join(fx.root, "state"));
    vi.stubEnv("ORCH_STATE_DIR", join(fx.root, "orch-state"));
    vi.stubEnv("ORCH_MODELS_PATH", join(fx.root, "models.toml"));
    mkdirSync(join(fx.root, "empty-path"), { recursive: true });
  }

  async function runDoctor(fx: Fixture, args: string[]): Promise<string> {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    await runDoctorCommand(args, fx.ctx);
    vi.restoreAllMocks();
    return lines.join("\n");
  }

  it("doctor --json adds platform_warnings and claude_readonly_forwarded_env (names only), and the text view prints them", async () => {
    const work = join(mkdtempSync(join(tmpdir(), "orch-wave-c-work-")), "work");
    mkdirSync(work, { recursive: true });
    const fx = makeFixture({ cwd: work, env: { USERPROFILE: "C:\\Users\\tester", TEMP: "D:\\Temp" }, platform: "win32" });
    try {
      stubDoctorEnvironment(fx);
      claudeSettings(fx, { ANTHROPIC_API_KEY: SYNTHETIC_SECRET, CLAUDE_CODE_USE_BEDROCK: "1" });
      const json = await runDoctor(fx, ["--json"]);
      expect(json).not.toContain(SYNTHETIC_SECRET);
      const report = JSON.parse(json) as Record<string, unknown>;
      expect(report.claude_readonly_forwarded_env).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK"]);
      expect(String((report.platform_warnings as string[]).join("\n"))).toContain("TEMP is outside the user profile");

      const text = await runDoctor(fx, []);
      expect(text).not.toContain(SYNTHETIC_SECRET);
      expect(text).toContain("Warning: TEMP is outside the user profile (USERPROFILE)");
      expect(text).toContain("Info: a readonly Claude run forwards these settings.json variables (names only): ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK.");
    } finally {
      rmSync(dirname(work), { recursive: true, force: true });
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it("a clean Linux doctor --json omits both fields, and doctor passes its injected context to the limit discovery", async () => {
    const fx = makeFixture({ cwd: join(makeFixture().root, "cwd") });
    stubDoctorEnvironment(fx);
    mkdirSync(fx.ctx.cwd, { recursive: true });
    const report = JSON.parse(await runDoctor(fx, ["--json"])) as Record<string, unknown>;
    expect(Object.hasOwn(report, "platform_warnings")).toBe(false);
    expect(Object.hasOwn(report, "claude_readonly_forwarded_env")).toBe(false);
    expect(Object.hasOwn(report, "mcp_clients")).toBe(true);
    const text = await runDoctor(fx, []);
    expect(text).not.toContain("readonly Claude run forwards");
  });

  it("doctor honors the injected home for the CLI limits (a ctx-only Codex config is found)", async () => {
    const fx = makeFixture({ platform: process.platform });
    stubDoctorEnvironment(fx);
    // The process HOME/USERPROFILE points elsewhere; only the injected context knows about this file.
    write(join(fx.home, ".codex", "config.toml"), "[agents]\nmax_threads = 7\n");
    vi.stubEnv("HOME", join(fx.root, "other-home"));
    vi.stubEnv("USERPROFILE", join(fx.root, "other-home"));
    vi.stubEnv("CODEX_HOME", join(fx.root, "other-home", ".codex"));
    const report = JSON.parse(await runDoctor(fx, ["--json"])) as { harnesses: Array<{ harness: string; concurrency?: { discovered_limit?: number; config_files?: string[] } }> };
    const codex = report.harnesses.find((entry) => entry.harness === "codex");
    expect(codex?.concurrency).toMatchObject({ discovered_limit: 7, config_files: [join(fx.home, ".codex", "config.toml")] });
  });
});

// ---------------------------------------------------------------------------
// 4. Settings UI: literal whitespace in CLI argument rows
// ---------------------------------------------------------------------------

describe("Settings UI keeps literal whitespace in argv tokens", () => {
  function functionSource(name: string): string {
    const match = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m").exec(html);
    expect(match, `function ${name} must exist in app.html`).not.toBeNull();
    return match![0];
  }

  it("argvEditor never trims what the user typed", () => {
    const source = functionSource("argvEditor");
    expect(source).not.toMatch(/\.trim\(\)/);
    expect(source).toContain('if (text === "") return true;');
    expect(source).toContain('event.target.value !== ""');
  });

  it("cleanHarnessDraft drops only empty tokens and keeps whitespace-only and padded ones exactly", () => {
    const { cleanHarnessDraft } = new Function(`${functionSource("dropBlankOptionals")}\n${functionSource("cleanHarnessDraft")}\nreturn { cleanHarnessDraft };`)() as {
      cleanHarnessDraft: (draft: Record<string, unknown>) => { extra_args: string[] };
    };
    const cleaned = cleanHarnessDraft({ display_name: "A", binary: "a", extra_args: ["-c", "", " ", " --flag ", "\t", "k=v", ""] });
    expect(cleaned.extra_args).toEqual(["-c", " ", " --flag ", "\t", "k=v"]);
    expect(cleanHarnessDraft({ display_name: "A", binary: "a", extra_args: [""] }).extra_args).toEqual([]);
  });
});
