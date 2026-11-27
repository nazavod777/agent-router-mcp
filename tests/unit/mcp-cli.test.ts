import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli/main.js";
import { mcpClientWarnings, runDoctorCommand } from "../../src/cli/doctor.js";
import { runMcpCommand, runSetupCommand } from "../../src/cli/mcp-cmd.js";
import { CLI_NAME } from "../../src/cli/name.js";
import { CLIENTS, inspectClient, inspectRelevantClients } from "../../src/cli/mcp-install.js";
import { runSkillCommand } from "../../src/cli/skill-cmd.js";
import { SKILL_BODY, captureIo, makeFixture, read, write } from "./helpers/mcp-fixture.js";

/** A config directory that proves the CLI is set up: an empty directory is only a leftover and does not count. */
const leaveConfigDir = (dir: string): void => write(join(dir, "notes.txt"), "user file\n");

const parseJson = (lines: string[]) => JSON.parse(lines.join("\n")) as Record<string, any>;

describe(`${CLI_NAME} mcp install / status / uninstall`, () => {
  it("install --json --dry-run reports the plan and writes nothing", async () => {
    const fx = makeFixture();
    const { io, out } = captureIo();
    const code = await runMcpCommand(["install", "--target", "cursor,codex", "--dry-run", "--json"], io, fx.ctx);
    expect(code).toBe(0);
    const report = parseJson(out);
    expect(report).toMatchObject({ command: "install", dry_run: true, ok: true, entry_path: fx.entry });
    expect(report.targets.map((target: { client: string; action: string }) => `${target.client}:${target.action}`)).toEqual(["cursor:created", "codex:created"]);
    expect(readdirSync(fx.home)).toEqual([]);
  });

  it("install writes, prints a table, and exits non-zero on a conflict", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".qwen/settings.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "python" } } }));
    const { io, out } = captureIo();
    const code = await runMcpCommand(["install", "--target", "cursor", "--target", "qwen"], io, fx.ctx);
    expect(code).toBe(1);
    expect(out.join("\n")).toMatch(/cursor\s+missing\s+created\s+current/);
    expect(out.join("\n")).toMatch(/qwen\s+conflict\s+skipped\s+conflict/);
    expect(out.join("\n")).toContain("--force");
    expect(existsSync(join(fx.home, ".cursor/mcp.json"))).toBe(true);
  });

  it("a skipped disabled entry is reported but is not a failure", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".claude.json"), JSON.stringify({ mcpServers: { orchestrator: { command: fx.ctx.nodePath, args: [fx.entry, "mcp"], disabled: true } } }));
    const { io } = captureIo();
    expect(await runMcpCommand(["install", "--target", "claude"], io, fx.ctx)).toBe(0);
  });

  it("with --target all and no detected CLI prints a hint and succeeds", async () => {
    const fx = makeFixture();
    const { io, out } = captureIo();
    expect(await runMcpCommand(["install"], io, fx.ctx)).toBe(0);
    expect(out.join("\n")).toContain("No supported CLI was detected");
  });

  it("status --check exits 1 on drift and 0 once everything is current; --json lists targets", async () => {
    const fx = makeFixture();
    leaveConfigDir(join(fx.home, ".cursor"));
    leaveConfigDir(join(fx.home, ".qwen"));
    const first = captureIo();
    expect(await runMcpCommand(["status", "--check"], first.io, fx.ctx)).toBe(1);
    expect(first.out.join("\n")).toMatch(/cursor\s+yes\s+missing\s+missing/);
    expect(first.out.join("\n")).toContain(`${CLI_NAME} setup --target cursor`);

    expect(await runMcpCommand(["status"], captureIo().io, fx.ctx)).toBe(0);

    const setup = captureIo();
    expect(await runSetupCommand(["--json"], setup.io, fx.ctx)).toBe(0);
    const second = captureIo();
    expect(await runMcpCommand(["status", "--check", "--json"], second.io, fx.ctx)).toBe(0);
    const report = parseJson(second.out);
    expect(report.drift).toBe(false);
    expect(report.targets.map((target: { mcp_status: string; skill_status: string }) => `${target.mcp_status}/${target.skill_status}`)).toEqual(["current/current", "current/current"]);
  });

  it("status --check flags an outdated skill, a stale entry and an invalid file", async () => {
    const fx = makeFixture();
    await runSetupCommand(["--target", "cursor,qwen,pi"], captureIo().io, fx.ctx);
    write(join(fx.home, ".cursor/skills/orchestrate/SKILL.md"), "old skill\n");
    write(join(fx.home, ".qwen/settings.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "node", args: ["/old/dist/cli/main.js", "mcp"] } } }));
    write(join(fx.home, ".pi/agent/mcp.json"), "{ broken");
    const { io, out } = captureIo();
    expect(await runMcpCommand(["status", "--check", "--json", "--target", "cursor,qwen,pi"], io, fx.ctx)).toBe(1);
    const byClient = Object.fromEntries(parseJson(out).targets.map((target: { client: string }) => [target.client, target]));
    expect(byClient.cursor).toMatchObject({ mcp_status: "current", skill_status: "outdated" });
    expect(byClient.qwen).toMatchObject({ mcp_status: "stale" });
    expect(byClient.pi).toMatchObject({ mcp_status: "invalid" });
  });

  it("uninstall removes owned entries and refuses foreign ones", async () => {
    const fx = makeFixture();
    await runMcpCommand(["install", "--target", "cursor"], captureIo().io, fx.ctx);
    write(join(fx.home, ".qwen/settings.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "python" } } }));
    const { io, out } = captureIo();
    const code = await runMcpCommand(["uninstall", "--target", "cursor,qwen", "--json"], io, fx.ctx);
    expect(code).toBe(1);
    expect(parseJson(out).targets.map((target: { client: string; action: string }) => `${target.client}:${target.action}`)).toEqual(["cursor:removed", "qwen:skipped"]);
    expect(JSON.parse(read(join(fx.home, ".cursor/mcp.json"))).mcpServers).toEqual({});
  });

  it("rejects unknown subcommands, targets and flags", async () => {
    const fx = makeFixture();
    const { io } = captureIo();
    await expect(runMcpCommand(["bogus"], io, fx.ctx)).rejects.toThrow(/Usage/);
    await expect(runMcpCommand(["install", "--target", "nope"], io, fx.ctx)).rejects.toThrow(/Unknown target "nope"/);
    await expect(runMcpCommand(["install", "--target", ""], io, fx.ctx)).rejects.toThrow(/must not be empty/);
    await expect(runMcpCommand(["install", "--wat"], io, fx.ctx)).rejects.toThrow();
    await expect(runMcpCommand(["install", "extra"], io, fx.ctx)).rejects.toThrow(/Unexpected argument/);
  });
});

describe(`${CLI_NAME} setup`, () => {
  it("installs MCP registration and the skill together and verifies both", async () => {
    const fx = makeFixture();
    const { io, out } = captureIo();
    expect(await runSetupCommand(["--target", "codex,dsh,cursor", "--json"], io, fx.ctx)).toBe(0);
    const report = parseJson(out);
    expect(report.ok).toBe(true);
    for (const target of report.targets) {
      expect(target).toMatchObject({ verified: true, ok: true, skill: { action: "created", status_after: "current" }, mcp: { action: "created", status_after: "current" } });
      expect(read(target.skill.path)).toBe(SKILL_BODY);
    }
    const again = captureIo();
    expect(await runSetupCommand(["--target", "codex,dsh,cursor", "--json"], again.io, fx.ctx)).toBe(0);
    expect(parseJson(again.out).targets.map((target: any) => `${target.mcp.action}/${target.skill.action}`)).toEqual(["unchanged/unchanged", "unchanged/unchanged", "unchanged/unchanged"]);
  });

  it("--dry-run touches nothing", async () => {
    const fx = makeFixture();
    const { io, out } = captureIo();
    expect(await runSetupCommand(["--target", "claude,gemini", "--dry-run"], io, fx.ctx)).toBe(0);
    expect(out.join("\n")).toContain("Dry run");
    expect(readdirSync(fx.home)).toEqual([]);
  });

  it("exits non-zero when a target conflicts, still processing the others", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".kiro/settings/mcp.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "python" } } }));
    const { io, out } = captureIo();
    expect(await runSetupCommand(["--target", "kiro,cursor", "--json"], io, fx.ctx)).toBe(1);
    const report = parseJson(out);
    expect(report.ok).toBe(false);
    expect(report.targets[0]).toMatchObject({ ok: false, mcp: { action: "skipped", status: "conflict" } });
    expect(report.targets[1]).toMatchObject({ ok: true, verified: true });
  });

  it("exits non-zero when the skill location is blocked by a file", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".cursor/skills"), "i am a file");
    const { io, out } = captureIo();
    expect(await runSetupCommand(["--target", "cursor", "--json"], io, fx.ctx)).toBe(1);
    expect(parseJson(out).targets[0].skill).toMatchObject({ action: "error" });
    expect(parseJson(out).targets[0].skill.message).toMatch(/not a directory/);
  });
});

describe(`${CLI_NAME} skill install hardening`, () => {
  it("rejects an empty --dir and --dir combined with --target", async () => {
    const fx = makeFixture();
    const { io } = captureIo();
    await expect(runSkillCommand(["install", "--dir", ""], io, fx.ctx)).rejects.toThrow(/--dir must not be empty/);
    await expect(runSkillCommand(["install", "--dir", "x", "--target", "claude"], io, fx.ctx)).rejects.toThrow(/cannot be combined/);
    await expect(runSkillCommand(["install", "--target", "nope"], io, fx.ctx)).rejects.toThrow(/Unknown target/);
    expect(readdirSync(fx.home)).toEqual([]);
  });

  it("installs into a custom --dir as <dir>/orchestrate/SKILL.md without MCP notes", async () => {
    const fx = makeFixture();
    const dir = join(fx.root, "custom-skills");
    const { io, out, err } = captureIo();
    expect(await runSkillCommand(["install", "--dir", dir], io, fx.ctx)).toBe(0);
    expect(out).toEqual([join(dir, "orchestrate", "SKILL.md")]);
    expect(err).toEqual([]);
  });

  it("respects CLAUDE_CONFIG_DIR and CODEX_HOME and covers the new grok, fx and muse targets", async () => {
    const base = makeFixture();
    const custom = join(base.root, "custom");
    const fx = makeFixture({ env: { CLAUDE_CONFIG_DIR: join(custom, "claude"), CODEX_HOME: join(custom, "codex"), XDG_CONFIG_HOME: join(custom, "xdg") } });
    const { io, out } = captureIo();
    expect(await runSkillCommand(["install", "--target", "claude,codex,grok,fx,muse"], io, fx.ctx)).toBe(0);
    expect(out).toEqual([
      join(custom, "claude/skills/orchestrate/SKILL.md"), join(custom, "codex/skills/orchestrate/SKILL.md"),
      join(fx.home, ".grok/skills/orchestrate/SKILL.md"), join(fx.home, ".fx/skills/orchestrate/SKILL.md"),
      join(custom, "xdg/muse/skills/orchestrate/SKILL.md"),
    ]);
    expect(out.every((path) => existsSync(path))).toBe(true);
  });

  it("--target all installs the core CLIs plus detected ones only", async () => {
    const fx = makeFixture();
    leaveConfigDir(join(fx.home, ".cursor"));
    const { io, out } = captureIo();
    await runSkillCommand(["install"], io, fx.ctx);
    expect(out.map((path) => path.replace(fx.home, "~")).sort()).toEqual([
      "~/.claude/skills/orchestrate/SKILL.md", "~/.codex/skills/orchestrate/SKILL.md", "~/.cursor/skills/orchestrate/SKILL.md",
      "~/.dsh/skills/orchestrate/SKILL.md", "~/.pi/agent/skills/orchestrate/SKILL.md",
    ]);
  });

  it("reports a file-in-the-way per target, keeps going, and exits 1", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".claude/skills"), "a file where a directory belongs");
    const { io, out, err } = captureIo();
    const code = await runSkillCommand(["install", "--target", "claude,codex"], io, fx.ctx);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/claude: .*not a directory/);
    expect(out).toEqual([join(fx.home, ".codex/skills/orchestrate/SKILL.md")]);

    write(join(fx.home, ".cursor/skills/orchestrate/SKILL.md/keep"), "x");
    const dirAsFile = captureIo();
    expect(await runSkillCommand(["install", "--target", "cursor"], dirAsFile.io, fx.ctx)).toBe(1);
    expect(dirAsFile.err.join("\n")).toMatch(/is a directory/);
  });

  it("does not install twice into one directory reached through two symlinks", async () => {
    const fx = makeFixture();
    const shared = join(fx.root, "shared-skills");
    mkdirSync(shared);
    mkdirSync(join(fx.home, ".claude"));
    mkdirSync(join(fx.home, ".codex"));
    symlinkSync(shared, join(fx.home, ".claude/skills"));
    symlinkSync(shared, join(fx.home, ".codex/skills"));
    const { io, out } = captureIo();
    expect(await runSkillCommand(["install", "--target", "claude,codex"], io, fx.ctx)).toBe(0);
    expect(out).toHaveLength(1);
    expect(read(join(shared, "orchestrate/SKILL.md"))).toBe(SKILL_BODY);
  });

  it("notes installed skills whose MCP registration is missing or stale, with the exact command", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".claude.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "node", args: ["/old/dist/cli/main.js", "mcp"] } } }));
    const { io, err } = captureIo();
    await runSkillCommand(["install", "--target", "claude,cursor"], io, fx.ctx);
    expect(err.join("\n")).toContain(`claude: the skill is installed but its MCP registration is stale. Run: ${CLI_NAME} mcp install --target claude`);
    expect(err.join("\n")).toContain(`${CLI_NAME} setup --target cursor`);
    await runMcpCommand(["install", "--target", "claude,cursor"], captureIo().io, fx.ctx);
    const after = captureIo();
    await runSkillCommand(["install", "--target", "claude,cursor"], after.io, fx.ctx);
    expect(after.err).toEqual([]);
  });

  it("is idempotent and keeps print/path/usage behavior", async () => {
    const fx = makeFixture();
    const { io, out } = captureIo();
    await runSkillCommand(["path"], io, fx.ctx);
    expect(out).toEqual([fx.skillSource]);
    await runSkillCommand(["--help"], io, fx.ctx);
    expect(out[1]).toMatch(new RegExp(`^Usage: ${CLI_NAME} skill print\\|path\\|install`));
    await expect(runSkillCommand(["wat"], io, fx.ctx)).rejects.toThrow(/Usage/);
    chmodSync(fx.home, 0o755);
  });
});

describe("orch doctor MCP client diagnostics", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("warns for detected or skill-bearing clients and offers exact remediation commands", async () => {
    const fx = makeFixture();
    leaveConfigDir(join(fx.home, ".cursor"));
    write(join(fx.home, ".qwen/settings.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "node", args: ["/old/dist/cli/main.js", "mcp"] } } }));
    write(join(fx.home, ".pi/agent/mcp.json"), "{ nope");
    await runSkillCommand(["install", "--target", "gemini"], captureIo().io, fx.ctx);
    const clients = await inspectRelevantClients(fx.ctx);
    expect(clients.map((client) => `${client.client}:${client.mcp_status}/${client.skill_status}`).sort()).toEqual([
      "cursor:missing/missing", "gemini:missing/current", "pi:invalid/missing", "qwen:stale/missing",
    ]);
    const warnings = mcpClientWarnings(clients);
    expect(warnings.join("\n")).toContain(`\`${CLI_NAME} setup --target cursor\``);
    expect(warnings.join("\n")).toContain(`\`${CLI_NAME} mcp install --target gemini\``);
    expect(warnings.join("\n")).toContain(`\`${CLI_NAME} setup --target qwen\``);
    expect(warnings.join("\n")).toContain("fix the syntax in");
    expect(mcpClientWarnings(await Promise.all([inspectClient(CLIENTS.codex, fx.ctx)]).then((list) => list.map((item) => ({ ...item, mcp_status: "current" as const, skill_status: "current" as const }))))).toEqual([]);
  });

  async function runDoctor(args: string[], fx: ReturnType<typeof makeFixture>): Promise<string> {
    const empty = join(fx.root, "empty-path");
    mkdirSync(empty, { recursive: true });
    vi.stubEnv("HOME", fx.home);
    vi.stubEnv("PATH", empty);
    vi.stubEnv("XDG_CONFIG_HOME", join(fx.root, "xdg"));
    vi.stubEnv("XDG_STATE_HOME", join(fx.root, "state"));
    vi.stubEnv("ORCH_STATE_DIR", join(fx.root, "orch-state"));
    vi.stubEnv("ORCH_MODELS_PATH", join(fx.root, "models.toml"));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await runDoctorCommand(args, fx.ctx);
    } finally {
      spy.mockRestore();
    }
    return lines.join("\n");
  }

  it("--json keeps harnesses[] and adds mcp_clients[] plus warnings", async () => {
    const fx = makeFixture();
    leaveConfigDir(join(fx.home, ".cursor"));
    await runMcpCommand(["install", "--target", "codex"], captureIo().io, fx.ctx);
    const report = JSON.parse(await runDoctor(["--json"], fx)) as Record<string, any>;
    expect(Array.isArray(report.harnesses)).toBe(true);
    expect(report.harnesses.length).toBeGreaterThanOrEqual(17);
    expect(report.harnesses[0]).toHaveProperty("auth_status");
    expect(report.config_warnings).toEqual([]);
    const byClient = Object.fromEntries(report.mcp_clients.map((client: { client: string }) => [client.client, client]));
    expect(byClient.codex).toMatchObject({ mcp_status: "current", skill_status: "missing", detected: true });
    expect(byClient.cursor).toMatchObject({ mcp_status: "missing", fix_command: `${CLI_NAME} setup --target cursor` });
    // cursor: MCP missing; codex: MCP current but its skill copy is missing.
    expect(report.mcp_client_warnings).toHaveLength(2);
    expect(report.mcp_client_warnings.join("\n")).toContain(`${CLI_NAME} setup --target cursor`);
    expect(report.mcp_client_warnings.join("\n")).toMatch(/Codex CLI \(codex\): MCP registration is current but the skill is missing/);
  });

  it("prints a compact MCP client registrations table and warning lines", async () => {
    const fx = makeFixture();
    leaveConfigDir(join(fx.home, ".cursor"));
    const text = await runDoctor([], fx);
    expect(text).toMatch(/Harness\s+Driver\s+Contract/);
    expect(text).toContain("MCP client registrations");
    expect(text).toMatch(/Client\s+MCP\s+Skill\s+Config Path/);
    expect(text).toMatch(/cursor\s+missing\s+missing\s+\S*\.cursor\/mcp\.json/);
    expect(text).toMatch(new RegExp(`Warning: Cursor CLI \\(cursor\\): MCP registration is missing; run \`${CLI_NAME} setup --target cursor\`\\.`));
  });

  it("says so when no client is detected", async () => {
    expect(await runDoctor([], makeFixture())).toContain("No supported CLI client detected");
  });
});

describe("entrypoints", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never routes extra arguments of the pure stdio entrypoint to the installer", async () => {
    // Even if the guard broke, the installer would only reach this throwaway home.
    const fx = makeFixture();
    vi.stubEnv("HOME", fx.home);
    vi.stubEnv("USERPROFILE", fx.home);
    for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) vi.stubEnv(name, join(fx.root, name));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previous = process.exitCode;
    try {
      await runCli(["install", "--target", "claude"], "mcp");
      expect(process.exitCode).toBe(1);
      expect(stderr.mock.calls.join("")).toContain(`Usage: ${CLI_NAME} mcp`);
      expect(readdirSync(fx.home)).toEqual([]);
    } finally {
      process.exitCode = previous;
      stderr.mockRestore();
    }
  });
});
