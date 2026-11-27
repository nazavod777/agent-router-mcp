import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicWriteFile, MAX_BACKUPS } from "../../src/cli/atomic-file.js";
import { runConfigCommand } from "../../src/cli/config-cmd.js";
import { mcpClientWarnings, runDoctorCommand } from "../../src/cli/doctor.js";
import { runCli } from "../../src/cli/main.js";
import { runMcpCommand, runSetupCommand } from "../../src/cli/mcp-cmd.js";
import {
  CLIENTS, detectClient, hasDrift, inspectClient, inspectMcp, installMcpClient, isCurrent, preferStableNodePath, resolveTargets,
  setupClient, uninstallMcpClient, type ClientStatus, type InstallContext,
} from "../../src/cli/mcp-install.js";
import { CLI_NAME } from "../../src/cli/name.js";
import { runSkillCommand } from "../../src/cli/skill-cmd.js";
import { parse as parseToml } from "smol-toml";
import { FAKE_NODE, captureIo, makeFixture, read, write, type Fixture } from "./helpers/mcp-fixture.js";

/** Lets a test make the JSON/TOML editors corrupt unrelated content, to prove commit() refuses such a write. */
const corruption = vi.hoisted(() => ({ on: false }));

vi.mock("../../src/cli/jsonc-edit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/jsonc-edit.js")>();
  return {
    ...actual,
    setValueAt: (...args: Parameters<typeof actual.setValueAt>) => {
      const edited = actual.setValueAt(...args);
      return corruption.on ? edited.replace('"keep": 1', '"keep": 2') : edited;
    },
  };
});

vi.mock("../../src/cli/toml-edit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/toml-edit.js")>();
  return {
    ...actual,
    appendBlock: (...args: Parameters<typeof actual.appendBlock>) => {
      const edited = actual.appendBlock(...args);
      return corruption.on ? edited.replace('model = "gpt"', 'model = "other"') : edited;
    },
  };
});

const SECRET = "hunter2-plain-value";
const REAL = { dryRun: false, force: false };
const FORCE = { dryRun: false, force: true };
const DRY = { dryRun: true, force: false };

const split = (fx: Fixture) => ({ command: FAKE_NODE, args: [fx.entry, "mcp"] });
const leaveConfigDir = (dir: string): void => write(join(dir, "notes.txt"), "user file\n");
const backupsIn = (dir: string, name: string): string[] => readdirSync(dir).filter((entry) => entry.startsWith(`${name}.bak.`)).sort();

afterEach(() => {
  corruption.on = false;
  vi.unstubAllEnvs();
});

describe("parse errors never echo config lines", () => {
  const BROKEN_TOML = `password_hint = "${SECRET}"\n[mcp_servers.other\ntoken = "${SECRET}"\n`;
  const BROKEN_YAML = `- id: other\n  password_hint: ${SECRET}\n bad: [\n`;

  it("TOML: the detail keeps the summary and position, and nothing from the file", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".codex/config.toml"), BROKEN_TOML);
    const inspection = await inspectMcp(CLIENTS.codex, fx.ctx);
    expect(inspection.status).toBe("invalid");
    expect(inspection.detail).toMatch(/^Invalid TOML document.* at line 2, column \d+$/);
    expect(inspection.detail).not.toContain(SECRET);
    expect(inspection.detail).not.toContain("\n");
  });

  it("YAML: the detail keeps the summary and position, and nothing from the file", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".dsh/cordis.patch.yml"), BROKEN_YAML);
    const inspection = await inspectMcp(CLIENTS.dsh, fx.ctx);
    expect(inspection.status).toBe("invalid");
    expect(inspection.detail).toMatch(/ at line \d+, column \d+$/);
    expect(inspection.detail).not.toContain(SECRET);
    expect(inspection.detail).not.toContain("\n");
  });

  it("status, install, uninstall, setup, doctor and --json output never contain the file's lines", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".codex/config.toml"), BROKEN_TOML);
    write(join(fx.home, ".dsh/cordis.patch.yml"), BROKEN_YAML);
    const outputs: string[] = [];
    for (const id of ["codex", "dsh"] as const) {
      outputs.push(JSON.stringify(await installMcpClient(CLIENTS[id], fx.ctx, REAL)));
      outputs.push(JSON.stringify(await uninstallMcpClient(CLIENTS[id], fx.ctx, REAL)));
      outputs.push(JSON.stringify(await setupClient(CLIENTS[id], fx.ctx, REAL)));
      outputs.push(JSON.stringify(await inspectClient(CLIENTS[id], fx.ctx)));
    }
    const status = captureIo();
    await runMcpCommand(["status", "--json"], status.io, fx.ctx);
    const text = captureIo();
    await runMcpCommand(["status"], text.io, fx.ctx);
    const setup = captureIo();
    await runSetupCommand(["--target", "codex,dsh"], setup.io, fx.ctx);
    outputs.push(...status.out, ...text.out, ...setup.out, ...mcpClientWarnings(await Promise.all([inspectClient(CLIENTS.codex, fx.ctx), inspectClient(CLIENTS.dsh, fx.ctx)])));
    expect(outputs.join("\n")).not.toContain(SECRET);
    expect(outputs.join("\n")).toContain("line 2");
  });

  it("redacts credential-shaped text that survives in a short summary", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".gemini/settings.json"), "{ nope");
    write(join(fx.home, ".claude.json"), "{}");
    const tomlFx = makeFixture();
    write(join(tomlFx.home, ".codex/config.toml"), 'key = "sk-abcdefghijklmnop"\nx = [\n');
    expect((await inspectMcp(CLIENTS.codex, tomlFx.ctx)).detail).not.toContain("sk-abcdefghijklmnop");
  });
});

describe("foreign entries show launcher and argument count only", () => {
  const foreign = (command: string, args: string[]) => JSON.stringify({ mcpServers: { orchestrator: { command, args } } });

  it('prints `existing entry runs "<basename>" (+N args)` and never an argument value', async () => {
    const fx = makeFixture();
    write(join(fx.home, ".qwen/settings.json"), foreign("/usr/local/bin/acme-mcp", ["--api-key", SECRET, `https://h.example/x?token=${SECRET}`]));
    const inspection = await inspectMcp(CLIENTS.qwen, fx.ctx);
    expect(inspection.status).toBe("conflict");
    expect(inspection.detail).toBe('existing entry runs "acme-mcp" (+3 args)');
  });

  it("omits the count when there are no arguments and uses the singular for one", async () => {
    const none = makeFixture();
    write(join(none.home, ".qwen/settings.json"), foreign("acme-mcp", []));
    expect((await inspectMcp(CLIENTS.qwen, none.ctx)).detail).toBe('existing entry runs "acme-mcp"');
    const one = makeFixture();
    write(join(one.home, ".qwen/settings.json"), foreign("acme-mcp", ["--serve"]));
    expect((await inspectMcp(CLIENTS.qwen, one.ctx)).detail).toBe('existing entry runs "acme-mcp" (+1 arg)');
  });

  it("does not leak arguments glued into a one-string command, or an OpenCode command array", async () => {
    const glued = makeFixture();
    write(join(glued.home, ".qwen/settings.json"), foreign(`acme-mcp --api-key ${SECRET}`, []));
    expect((await inspectMcp(CLIENTS.qwen, glued.ctx)).detail).toBe('existing entry runs "acme-mcp"');
    const array = makeFixture();
    write(join(array.home, ".config/opencode/opencode.json"), JSON.stringify({ mcp: { servers: { orchestrator: { type: "local", command: ["acme", "--token", SECRET] } } } }));
    expect((await inspectMcp(CLIENTS.opencode, array.ctx)).detail).toBe('existing entry runs "acme" (+2 args)');
  });

  it("names the first word of a one-string command, not the tail of a URL argument", async () => {
    const url = makeFixture();
    write(join(url.home, ".qwen/settings.json"), foreign(`npx mcp-remote https://host.example/sse?token=${SECRET}`, []));
    const detail = (await inspectMcp(CLIENTS.qwen, url.ctx)).detail;
    expect(detail).toBe('existing entry runs "npx"');
    expect(detail).not.toContain("sse");
    const windows = makeFixture();
    write(join(windows.home, ".qwen/settings.json"), foreign("C:\\tools\\acme-mcp.cmd   --serve", []));
    expect((await inspectMcp(CLIENTS.qwen, windows.ctx)).detail).toBe('existing entry runs "acme-mcp.cmd"');
  });

  it("keeps secrets out of install/setup/status/doctor messages for a colliding server", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".qwen/settings.json"), foreign("/opt/acme-mcp", ["--api-key", SECRET, `https://h.example/x?token=${SECRET}`]));
    const outputs = [
      JSON.stringify(await installMcpClient(CLIENTS.qwen, fx.ctx, REAL)),
      JSON.stringify(await installMcpClient(CLIENTS.qwen, fx.ctx, DRY)),
      JSON.stringify(await uninstallMcpClient(CLIENTS.qwen, fx.ctx, REAL)),
      JSON.stringify(await setupClient(CLIENTS.qwen, fx.ctx, REAL)),
      ...mcpClientWarnings([await inspectClient(CLIENTS.qwen, fx.ctx)]),
    ];
    const status = captureIo();
    await runMcpCommand(["status", "--json"], status.io, fx.ctx);
    outputs.push(...status.out);
    expect(outputs.join("\n")).not.toContain(SECRET);
    expect(outputs.join("\n")).toContain('existing entry runs \\"acme-mcp\\" (+3 args)');
  });
});

describe("edits that would touch anything besides the orchestrator entry are refused", () => {
  it("JSON: a (simulated) corrupting edit is not written, not even as a backup", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".qwen/settings.json");
    const original = '{ "keep": 1, "mcpServers": {} }\n';
    write(path, original);
    corruption.on = true;
    for (const options of [REAL, DRY]) {
      const result = await installMcpClient(CLIENTS.qwen, fx.ctx, options);
      expect(result).toMatchObject({ action: "error", status_after: "missing" });
      expect(result.message).toMatch(/outside the "orchestrator" entry/);
    }
    expect(read(path)).toBe(original);
    expect(backupsIn(join(fx.home, ".qwen"), "settings.json")).toEqual([]);
    corruption.on = false;
    expect(await installMcpClient(CLIENTS.qwen, fx.ctx, REAL)).toMatchObject({ action: "created", status_after: "current" });
  });

  it("TOML: a (simulated) corrupting edit is refused", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, 'model = "gpt"\n');
    corruption.on = true;
    expect(await installMcpClient(CLIENTS.codex, fx.ctx, REAL)).toMatchObject({ action: "error" });
    expect(read(path)).toBe('model = "gpt"\n');
  });

  it("accepts real edits of every format that only change the entry (formatting may differ)", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".codex/config.toml"), '# keep me\nmodel = "gpt"\n\n[mcp_servers.other]\ncommand = "o"\n');
    write(join(fx.home, ".dsh/cordis.patch.yml"), "# patches\n- id: keep\n  disabled: true\n");
    write(join(fx.home, ".config/opencode/opencode.json"), '{ // c\n "mcp": { "foo": { "type": "local", "command": ["x"] } }, "keep": [1,2] }\n');
    write(join(fx.home, ".vibe/config.toml"), 'active = "a"\n\n[[mcp_servers]]\nname = "other"\ntransport = "stdio"\ncommand = "o"\n');
    for (const id of ["codex", "dsh", "opencode", "vibe"] as const) {
      expect(await installMcpClient(CLIENTS[id], fx.ctx, REAL), id).toMatchObject({ action: "created", status_after: "current" });
      expect(await uninstallMcpClient(CLIENTS[id], fx.ctx, REAL), id).toMatchObject({ action: "removed", status_after: "missing" });
    }
  });
});

describe("backups of symlinked configs", () => {
  it("land next to the symlink, never inside the symlink target's directory", async () => {
    const fx = makeFixture();
    const dotfiles = join(fx.root, "dotfiles");
    write(join(dotfiles, "config.toml"), 'model = "gpt"\n');
    mkdirSync(join(fx.home, ".codex"), { recursive: true });
    symlinkSync(join(dotfiles, "config.toml"), join(fx.home, ".codex/config.toml"));
    const result = await installMcpClient(CLIENTS.codex, fx.ctx, REAL);
    expect(result.action).toBe("created");
    expect(result.backup_path).toMatch(new RegExp(`${join(fx.home, ".codex", "config.toml").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.bak\\.`));
    expect(readdirSync(dotfiles)).toEqual(["config.toml"]);
    expect(read(result.backup_path!)).toBe('model = "gpt"\n');
  });

  it(`keeps only the newest ${MAX_BACKUPS} backups of one file and leaves other files alone`, async () => {
    const fx = makeFixture();
    const path = join(fx.root, "cfg", "settings.json");
    write(path, "v0");
    write(join(fx.root, "cfg", "settings.json.bak.manual"), "mine");
    write(join(fx.root, "cfg", "other.json.bak.20200101T000000000Z"), "other file");
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
    const made: string[] = [];
    for (let version = 1; version <= 9; version += 1) {
      made.push((await atomicWriteFile(path, `v${version}`, { backup: true, now })).backupPath!);
    }
    const kept = backupsIn(join(fx.root, "cfg"), "settings.json").filter((name) => name !== "settings.json.bak.manual");
    expect(kept).toHaveLength(MAX_BACKUPS);
    expect(kept.map((name) => join(fx.root, "cfg", name))).toEqual(made.slice(-MAX_BACKUPS));
    expect(read(made[8])).toBe("v8");
    expect(existsSync(join(fx.root, "cfg", "settings.json.bak.manual"))).toBe(true);
    expect(existsSync(join(fx.root, "cfg", "other.json.bak.20200101T000000000Z"))).toBe(true);
    expect(read(path)).toBe("v9");
  });

  it("rotates correctly when the clock does not advance (collision counters)", async () => {
    const fx = makeFixture();
    const path = join(fx.root, "cfg", "a.toml");
    write(path, "v0");
    const now = () => new Date(Date.UTC(2026, 0, 1));
    for (let version = 1; version <= 13; version += 1) await atomicWriteFile(path, `v${version}`, { backup: true, now });
    const kept = backupsIn(join(fx.root, "cfg"), "a.toml");
    expect(kept).toHaveLength(MAX_BACKUPS);
    expect(kept.map((name) => read(join(fx.root, "cfg", name))).sort()).toEqual(["v10", "v11", "v12", "v8", "v9"].sort());
  });
});

describe("stable node path", () => {
  it("prefers the PATH entry when it is the same file as process.execPath", () => {
    const fx = makeFixture();
    const real = join(fx.root, "Cellar/node/22.1.0/bin/node");
    write(real, "#!/bin/sh\n");
    mkdirSync(join(fx.root, "bin"));
    const stable = join(fx.root, "bin/node");
    symlinkSync(real, stable);
    expect(preferStableNodePath(real, () => stable)).toBe(stable);
  });

  it("keeps execPath when PATH has no node or a different one", () => {
    const fx = makeFixture();
    const real = join(fx.root, "Cellar/node/22.1.0/bin/node");
    const other = join(fx.root, "other/node");
    write(real, "a");
    write(other, "b");
    expect(preferStableNodePath(real, () => undefined)).toBe(real);
    expect(preferStableNodePath(real, () => other)).toBe(real);
    expect(preferStableNodePath(real, () => "node")).toBe(real);
  });

  it("an existing registration written with the version-specific path stays current under the stable path", () => {
    const fx = makeFixture();
    const real = join(fx.root, "Cellar/node/22.1.0/bin/node");
    write(real, "#!/bin/sh\n");
    mkdirSync(join(fx.root, "bin"));
    symlinkSync(real, join(fx.root, "bin/node"));
    const ctx: InstallContext = { ...fx.ctx, nodePath: join(fx.root, "bin/node") };
    expect(isCurrent([real, fx.entry, "mcp"], ctx)).toBe(true);
    expect(isCurrent([join(fx.root, "bin/node"), fx.entry, "mcp"], ctx)).toBe(true);
  });
});

describe("TOML table form: detached sub-tables of the entry", () => {
  const FOREIGN = [
    "[mcp_servers.orchestrator]", 'command = "python"', 'args = ["srv.py"]', "",
    "[other]", "x = 1", "",
    "[mcp_servers.orchestrator.env]", 'API_KEY = "hunter2-plain-value"', "",
    "[tail]", "y = 2", "",
  ].join("\n");

  it("uninstall --force removes the entry together with a sub-table placed elsewhere", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, FOREIGN);
    expect(await uninstallMcpClient(CLIENTS.codex, fx.ctx, REAL)).toMatchObject({ action: "skipped", status: "conflict" });
    const result = await uninstallMcpClient(CLIENTS.codex, fx.ctx, FORCE);
    expect(result).toMatchObject({ action: "removed", status_after: "missing" });
    expect(parseToml(read(path))).toEqual({ other: { x: 1 }, tail: { y: 2 } });
  });

  it("install --force replaces the entry and does not keep the foreign env sub-table attached", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, FOREIGN);
    const result = await installMcpClient(CLIENTS.codex, fx.ctx, FORCE);
    expect(result).toMatchObject({ action: "updated", status_after: "current" });
    const parsed = parseToml(read(path)) as { mcp_servers: { orchestrator: unknown }; other: unknown; tail: unknown };
    expect(parsed.mcp_servers.orchestrator).toEqual(split(fx));
    expect(parsed.other).toEqual({ x: 1 });
    expect(parsed.tail).toEqual({ y: 2 });
    expect(read(path)).not.toContain("hunter2");
  });

  it("also handles a sub-table written before the table header, and leaves unrelated sub-tables alone", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, [
      "[mcp_servers.orchestrator.env]", 'A = "1"', "",
      "[mcp_servers.keep]", 'command = "k"', "",
      "[mcp_servers.orchestrator]", 'command = "python"', "",
    ].join("\n"));
    expect(await uninstallMcpClient(CLIENTS.codex, fx.ctx, FORCE)).toMatchObject({ action: "removed", status_after: "missing" });
    expect(parseToml(read(path))).toEqual({ mcp_servers: { keep: { command: "k" } } });
  });

  it("keeps the user's own env sub-table when our own entry is merely repaired", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, `[mcp_servers.orchestrator]\ncommand = "node"\nargs = ["/old/dist/cli/main.js", "mcp"]\n\n[other]\nx = 1\n\n[mcp_servers.orchestrator.env]\nA = "1"\n`);
    expect(await installMcpClient(CLIENTS.codex, fx.ctx, REAL)).toMatchObject({ action: "updated", status_after: "current" });
    expect((parseToml(read(path)) as { mcp_servers: { orchestrator: unknown } }).mcp_servers.orchestrator).toEqual({ ...split(fx), env: { A: "1" } });
  });
});

describe("detection ignores empty leftover directories", () => {
  it("an empty ~/.cursor is not a configured client, but one with a user file is", async () => {
    const fx = makeFixture();
    mkdirSync(join(fx.home, ".cursor"));
    expect((await detectClient(CLIENTS.cursor, fx.ctx)).detected).toBe(false);
    expect((await resolveTargets(fx.ctx, ["all"])).specs).toEqual([]);
    expect((await inspectClient(CLIENTS.cursor, fx.ctx)).relevant).toBe(false);
    leaveConfigDir(join(fx.home, ".cursor"));
    expect((await detectClient(CLIENTS.cursor, fx.ctx)).detected).toBe(true);
  });
});

describe("status / setup honesty", () => {
  const disabled = (fx: Fixture) => JSON.stringify({ mcpServers: { orchestrator: { ...split(fx), disabled: true } } });

  async function withCurrentSkill(fx: Fixture): Promise<void> {
    await runSkillCommand(["install", "--target", "qwen"], captureIo().io, fx.ctx);
  }

  it.each([
    ["disabled", (fx: Fixture) => disabled(fx)],
    ["conflict", () => JSON.stringify({ mcpServers: { orchestrator: { command: "acme-mcp", args: [] } } })],
    ["invalid", () => "{ nope"],
  ])("status --check fails for a %s (disabled, foreign or unparsable) registration even though the skill is current", async (status, content) => {
    const fx = makeFixture();
    write(join(fx.home, ".qwen/settings.json"), content(fx));
    await withCurrentSkill(fx);
    const { io, out } = captureIo();
    expect(await runMcpCommand(["status", "--check", "--target", "qwen", "--json"], io, fx.ctx)).toBe(1);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ drift: true, targets: [{ mcp_status: status, skill_status: "current" }] });
  });

  it("status --check passes only when MCP and skill are both current", async () => {
    const fx = makeFixture();
    expect(await installMcpClient(CLIENTS.qwen, fx.ctx, REAL)).toMatchObject({ status_after: "current" });
    await withCurrentSkill(fx);
    expect(hasDrift(await inspectClient(CLIENTS.qwen, fx.ctx))).toBe(false);
    expect(await runMcpCommand(["status", "--check", "--target", "qwen"], captureIo().io, fx.ctx)).toBe(0);
  });

  it("setup says why it could not verify a disabled or foreign entry left untouched", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".qwen/settings.json"), disabled(fx));
    const result = await setupClient(CLIENTS.qwen, fx.ctx, REAL);
    expect(result).toMatchObject({ verified: false, mcp: { action: "skipped", status_after: "disabled" } });
    expect(result.unverified_reason).toBe("the MCP registration is disabled and was left untouched");

    const foreign = makeFixture();
    write(join(foreign.home, ".qwen/settings.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "acme-mcp", args: [] } } }));
    expect(await setupClient(CLIENTS.qwen, foreign.ctx, REAL)).toMatchObject({
      verified: false, ok: false, unverified_reason: "the MCP registration is conflict and was left untouched",
    });

    const text = captureIo();
    expect(await runSetupCommand(["--target", "qwen"], text.io, fx.ctx)).toBe(0);
    expect(text.out.join("\n")).toMatch(/qwen\s+disabled -> skipped\s+\S+ -> \S+\s+no\s/);
    expect(text.out.join("\n")).toContain("qwen: not verified: the MCP registration is disabled and was left untouched");
  });

  it("setup reports verified for a fully repaired client and no reason", async () => {
    const fx = makeFixture();
    const result = await setupClient(CLIENTS.qwen, fx.ctx, REAL);
    expect(result).toMatchObject({ verified: true, ok: true });
    expect(result).not.toHaveProperty("unverified_reason");
  });

  it("an invalid config's hint says to fix the syntax first and never points at `mcp install`", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".qwen/settings.json"), "{ nope");
    const status = await inspectClient(CLIENTS.qwen, fx.ctx);
    expect(status.fix_command).toBe(`${CLI_NAME} setup --target qwen`);
    const { io, out } = captureIo();
    await runMcpCommand(["status", "--target", "qwen"], io, fx.ctx);
    const text = out.join("\n");
    expect(text).toContain(`qwen: fix the syntax error in ${join(fx.home, ".qwen/settings.json")} first, then run \`${CLI_NAME} setup --target qwen\``);
    expect(text).not.toContain("mcp install");
  });
});

describe("doctor skill drift warning", () => {
  const base: ClientStatus = {
    client: "qwen", label: "Qwen Code", detected: true, detected_by: [], config_path: "/h/.qwen/settings.json", skill_path: "/h/.qwen/skills/orchestrate",
    mcp_status: "current", skill_status: "current", relevant: true,
  };

  it("warns about a missing or outdated skill even when the MCP entry is current", () => {
    expect(mcpClientWarnings([base])).toEqual([]);
    expect(mcpClientWarnings([{ ...base, skill_status: "outdated", fix_command: `${CLI_NAME} setup --target qwen` }])).toEqual([
      `Qwen Code (qwen): MCP registration is current but the skill is outdated at /h/.qwen/skills/orchestrate; run \`${CLI_NAME} setup --target qwen\`.`,
    ]);
    expect(mcpClientWarnings([{ ...base, skill_status: "missing", skill_error: "EACCES", fix_command: "x" }])[0]).toContain("skill is missing at /h/.qwen/skills/orchestrate (EACCES)");
  });
});

describe("-h / --help", () => {
  function capture(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    return { lines, restore: () => spy.mockRestore() };
  }

  it.each([["doctor", "--help"], ["doctor", "-h"], ["config", "show", "--help"], ["config", "show", "-h"]])("agrmcp %s exits cleanly with usage", async (...argv) => {
    const log = capture();
    const previous = process.exitCode;
    try {
      await runCli(argv);
      expect(process.exitCode).toBe(previous);
    } finally {
      log.restore();
    }
    expect(log.lines.join("\n")).toMatch(/Usage:/);
  });

  it.each([["install", "--help"], ["install", "-h"], ["print", "--help"], ["print", "-h"], ["path", "--help"]])("skill %s prints usage and returns 0", async (...argv) => {
    const fx = makeFixture();
    const { io, out } = captureIo();
    expect(await runSkillCommand(argv, io, fx.ctx)).toBe(0);
    expect(out.join("\n")).toMatch(new RegExp(`^Usage: ${CLI_NAME} skill print\\|path\\|install`));
    expect(existsSync(join(fx.home, ".claude"))).toBe(false);
  });

  it("the top-level help lines all start their description in the same column", async () => {
    const log = capture();
    try {
      await runCli([]);
    } finally {
      log.restore();
    }
    const lines = log.lines.join("\n").split("\n");
    const description = (prefix: string, text: string): number => lines.find((line) => line.startsWith(prefix))!.indexOf(text);
    expect(description("  wait ", "Wait for jobs")).toBe(description("  doctor ", "Check CLI availability"));
    expect(description("  wait ", "Wait for jobs")).toBe(description("  settings ", "Start the local settings UI"));
  });
});

describe("a models.toml that failed to parse on cold start", () => {
  function stubEnvironment(fx: Fixture): string {
    const modelsPath = join(fx.root, "models.toml");
    writeFileSync(modelsPath, "[[[ definitely not toml");
    vi.stubEnv("HOME", fx.home);
    vi.stubEnv("PATH", join(fx.root, "empty-path"));
    vi.stubEnv("XDG_CONFIG_HOME", join(fx.root, "xdg"));
    vi.stubEnv("XDG_STATE_HOME", join(fx.root, "state"));
    vi.stubEnv("ORCH_STATE_DIR", join(fx.root, "orch-state"));
    vi.stubEnv("ORCH_MODELS_PATH", modelsPath);
    mkdirSync(join(fx.root, "empty-path"), { recursive: true });
    return modelsPath;
  }

  async function logged(run: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  it("config show --json exposes cold_start_fallback, and the text view prints an error banner", async () => {
    const fx = makeFixture();
    const modelsPath = stubEnvironment(fx);
    const report = JSON.parse(await logged(() => runConfigCommand(["show", "--json"]))) as { cold_start_fallback: boolean; config_warnings: string[] };
    expect(report.cold_start_fallback).toBe(true);
    expect(report.config_warnings.join("\n")).toContain("Invalid user config");
    expect(await logged(() => runConfigCommand(["show"]))).toContain(`ERROR: the user config ${modelsPath} could not be loaded`);
  });

  it("doctor --json carries cold_start_fallback and the text report starts with an error banner", async () => {
    const fx = makeFixture();
    const modelsPath = stubEnvironment(fx);
    const report = JSON.parse(await logged(() => runDoctorCommand(["--json"], fx.ctx))) as { cold_start_fallback: boolean };
    expect(report.cold_start_fallback).toBe(true);
    const text = await logged(() => runDoctorCommand([], fx.ctx));
    expect(text.split("\n")[0]).toBe(`ERROR: the user config ${modelsPath} could not be loaded, so the results below show the built-in defaults, not your configuration. Jobs are refused until the file is repaired.`);
  });

  it("a healthy config reports cold_start_fallback false and no banner", async () => {
    const fx = makeFixture();
    stubEnvironment(fx);
    vi.stubEnv("ORCH_MODELS_PATH", join(fx.root, "missing-models.toml"));
    const report = JSON.parse(await logged(() => runConfigCommand(["show", "--json"]))) as { cold_start_fallback: boolean };
    expect(report.cold_start_fallback).toBe(false);
    expect(await logged(() => runConfigCommand(["show"]))).not.toContain("ERROR:");
  });
});
