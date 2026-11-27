import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  CLIENTS, CLIENT_IDS, detectClient, inspectMcp, installMcpClient, looksOwned, resolveTargets, uninstallMcpClient,
  type ClientId, type InstallContext, type McpTargetResult,
} from "../../src/cli/mcp-install.js";
import { FAKE_NODE, makeFixture, read, write, type Fixture } from "./helpers/mcp-fixture.js";

const REAL = { dryRun: false, force: false };
const FORCE = { dryRun: false, force: true };
const DRY = { dryRun: true, force: false };

const install = (fx: Fixture, id: ClientId, options = REAL): Promise<McpTargetResult> => installMcpClient(CLIENTS[id], fx.ctx, options);
const uninstall = (fx: Fixture, id: ClientId, options = REAL): Promise<McpTargetResult> => uninstallMcpClient(CLIENTS[id], fx.ctx, options);
const argvOf = (fx: Fixture): string[] => [FAKE_NODE, fx.entry, "mcp"];
const split = (fx: Fixture) => ({ command: FAKE_NODE, args: [fx.entry, "mcp"] });

/** Every directory entry under `root`, for "nothing was created" assertions. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true }).map((entry) => join(entry.parentPath, entry.name)).sort();
}

describe("client registry and per-format output", () => {
  type JsonCase = [ClientId, string, string[], (fx: Fixture) => unknown, string];
  const jsonCases: JsonCase[] = [
    ["claude", ".claude.json", ["mcpServers", "orchestrator"], (fx) => ({ type: "stdio", ...split(fx) }), ".claude/skills/orchestrate"],
    ["pi", ".pi/agent/mcp.json", ["mcpServers", "orchestrator"], (fx) => split(fx), ".pi/agent/skills/orchestrate"],
    ["gemini", ".gemini/settings.json", ["mcpServers", "orchestrator"], (fx) => split(fx), ".gemini/skills/orchestrate"],
    ["antigravity", ".gemini/config/mcp_config.json", ["mcpServers", "orchestrator"], (fx) => split(fx), ".gemini/config/skills/orchestrate"],
    ["cursor", ".cursor/mcp.json", ["mcpServers", "orchestrator"], (fx) => split(fx), ".cursor/skills/orchestrate"],
    ["droid", ".factory/mcp.json", ["mcpServers", "orchestrator"], (fx) => ({ type: "stdio", ...split(fx) }), ".factory/skills/orchestrate"],
    ["kiro", ".kiro/settings/mcp.json", ["mcpServers", "orchestrator"], (fx) => split(fx), ".kiro/skills/orchestrate"],
    ["copilot", ".copilot/mcp-config.json", ["mcpServers", "orchestrator"], (fx) => ({ type: "local", ...split(fx), tools: ["*"] }), ".copilot/skills/orchestrate"],
    ["qwen", ".qwen/settings.json", ["mcpServers", "orchestrator"], (fx) => split(fx), ".qwen/skills/orchestrate"],
    ["kimi", ".kimi-code/mcp.json", ["mcpServers", "orchestrator"], (fx) => split(fx), ".kimi-code/skills/orchestrate"],
    ["fx", ".fx/mcp.json", ["mcpServers", "orchestrator"], (fx) => ({ type: "stdio", command: argvOf(fx) }), ".fx/skills/orchestrate"],
    ["muse", ".config/muse/settings.json", ["mcp_servers", "orchestrator"], (fx) => ({ transport: "stdio", ...split(fx), mode: "optional" }), ".config/muse/skills/orchestrate"],
    ["opencode", ".config/opencode/opencode.json", ["mcp", "servers", "orchestrator"], (fx) => ({ type: "local", command: argvOf(fx) }), ".config/opencode/skills/orchestrate"],
  ];

  it.each(jsonCases)("%s: creates a JSON config with the exact entry and reports skill path", async (id, rel, path, entry, skillRel) => {
    const fx = makeFixture();
    const result = await install(fx, id);
    expect(result).toMatchObject({ action: "created", status: "missing", status_after: "current", file_created: true });
    expect(result.config_path).toBe(join(fx.home, rel));
    expect(result.skill_path).toBe(join(fx.home, skillRel));
    let node: unknown = JSON.parse(read(result.config_path));
    for (const key of path) node = (node as Record<string, unknown>)[key];
    expect(node).toEqual(entry(fx));
    expect(statSync(result.config_path).mode & 0o777).toBe(0o600);
  });

  it("codex and grok: write a [mcp_servers.orchestrator] table", async () => {
    for (const [id, rel] of [["codex", ".codex/config.toml"], ["grok", ".grok/config.toml"]] as const) {
      const fx = makeFixture();
      const result = await install(fx, id);
      expect(result.config_path).toBe(join(fx.home, rel));
      expect(parseToml(read(result.config_path))).toEqual({ mcp_servers: { orchestrator: split(fx) } });
      expect(result.skill_path).toBe(join(fx.home, rel.split("/")[0], "skills", "orchestrate"));
    }
  });

  it("vibe: writes a [[mcp_servers]] element named orchestrator", async () => {
    const fx = makeFixture();
    const result = await install(fx, "vibe");
    expect(result.config_path).toBe(join(fx.home, ".vibe/config.toml"));
    expect(parseToml(read(result.config_path))).toEqual({ mcp_servers: [{ name: "orchestrator", transport: "stdio", ...split(fx) }] });
  });

  it("dsh: writes an insert item for the dsh MCP client plugin", async () => {
    const fx = makeFixture();
    const result = await install(fx, "dsh");
    expect(result.config_path).toBe(join(fx.home, ".dsh/cordis.patch.yml"));
    expect(parseYaml(read(result.config_path))).toEqual([{
      insert: [{ id: "mcp-orchestrator", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "orchestrator", transport: "stdio", ...split(fx) } }],
    }]);
  });

  it("covers every driver exactly once", () => {
    expect(Object.keys(CLIENTS).sort()).toEqual([...CLIENT_IDS].sort());
    expect(CLIENT_IDS).toHaveLength(17);
  });
});

describe("environment overrides and legacy layouts", () => {
  const layoutOf = (fx: Fixture, id: ClientId) => CLIENTS[id].layout(fx.ctx);

  it.each([
    ["claude", "CLAUDE_CONFIG_DIR", ".claude.json", "skills/orchestrate"],
    ["codex", "CODEX_HOME", "config.toml", "skills/orchestrate"],
    ["dsh", "DSH_HOME", "cordis.patch.yml", "skills/orchestrate"],
    ["pi", "PI_CODING_AGENT_DIR", "mcp.json", "skills/orchestrate"],
    ["copilot", "COPILOT_HOME", "mcp-config.json", "skills/orchestrate"],
    ["vibe", "VIBE_HOME", "config.toml", "skills/orchestrate"],
    ["kimi", "KIMI_CODE_HOME", "mcp.json", "skills/orchestrate"],
    ["grok", "GROK_HOME", "config.toml", "skills/orchestrate"],
    ["opencode", "OPENCODE_CONFIG_DIR", "opencode.json", "skills/orchestrate"],
    ["gemini", "GEMINI_CLI_HOME", ".gemini/settings.json", ".gemini/skills/orchestrate"],
  ] as const)("%s honors %s", (id, variable, configRel, skillRel) => {
    const base = makeFixture();
    const custom = join(base.root, "custom");
    const fx = makeFixture({ env: { [variable]: custom } });
    const layout = layoutOf(fx, id);
    expect(layout.configPath).toBe(join(custom, ...configRel.split("/")));
    expect(layout.skillDir).toBe(join(custom, ...skillRel.split("/")));
  });

  it("muse and opencode follow XDG_CONFIG_HOME", () => {
    const base = makeFixture();
    const xdg = join(base.root, "xdg");
    const fx = makeFixture({ env: { XDG_CONFIG_HOME: xdg } });
    expect(layoutOf(fx, "muse").configPath).toBe(join(xdg, "muse", "settings.json"));
    expect(layoutOf(fx, "muse").skillDir).toBe(join(xdg, "muse", "skills", "orchestrate"));
    expect(layoutOf(fx, "opencode").configPath).toBe(join(xdg, "opencode", "opencode.json"));
  });

  it("opencode prefers an existing opencode.jsonc and an OPENCODE_CONFIG file", () => {
    const fx = makeFixture();
    write(join(fx.home, ".config/opencode/opencode.jsonc"), "{}");
    expect(layoutOf(fx, "opencode").configPath).toBe(join(fx.home, ".config/opencode/opencode.jsonc"));

    const explicit = join(fx.root, "elsewhere.json");
    write(explicit, "{}");
    const withEnv = makeFixture({ homeDir: fx.home, env: { OPENCODE_CONFIG: explicit } });
    expect(layoutOf(withEnv, "opencode").configPath).toBe(explicit);
    expect(layoutOf(withEnv, "opencode").skillDir).toBe(join(fx.home, ".config/opencode/skills/orchestrate"));

    const missing = makeFixture({ homeDir: fx.home, env: { OPENCODE_CONFIG: join(fx.root, "nope.json") } });
    expect(layoutOf(missing, "opencode").configPath).toBe(join(fx.home, ".config/opencode/opencode.jsonc"));
  });

  it("antigravity targets the legacy path only when it exists and the new one does not", () => {
    const fx = makeFixture();
    expect(layoutOf(fx, "antigravity").configPath).toBe(join(fx.home, ".gemini/config/mcp_config.json"));
    write(join(fx.home, ".gemini/antigravity/mcp_config.json"), "{}");
    expect(layoutOf(fx, "antigravity").configPath).toBe(join(fx.home, ".gemini/antigravity/mcp_config.json"));
    expect(layoutOf(fx, "antigravity").skillDir).toBe(join(fx.home, ".gemini/antigravity/skills/orchestrate"));
    write(join(fx.home, ".gemini/config/mcp_config.json"), "{}");
    expect(layoutOf(fx, "antigravity").configPath).toBe(join(fx.home, ".gemini/config/mcp_config.json"));
  });

  it("kimi falls back to ~/.kimi only when it exists and ~/.kimi-code does not", () => {
    const fx = makeFixture();
    expect(layoutOf(fx, "kimi").configPath).toBe(join(fx.home, ".kimi-code/mcp.json"));
    mkdirSync(join(fx.home, ".kimi"));
    expect(layoutOf(fx, "kimi").configPath).toBe(join(fx.home, ".kimi/mcp.json"));
    mkdirSync(join(fx.home, ".kimi-code"));
    expect(layoutOf(fx, "kimi").configPath).toBe(join(fx.home, ".kimi-code/mcp.json"));
  });
});

describe("JSON and JSONC editing", () => {
  it("adds the entry without touching the rest of the file", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".cursor/mcp.json");
    write(path, '{\n  "mcpServers": {\n    "other": { "command": "a" }\n  }\n}\n');
    await install(fx, "cursor");
    expect(read(path)).toBe([
      "{", '  "mcpServers": {', '    "other": { "command": "a" },', '    "orchestrator": {', `      "command": "${FAKE_NODE}",`, '      "args": [',
      `        "${fx.entry}",`, '        "mcp"', "      ]", "    }", "  }", "}", "",
    ].join("\n"));
  });

  it("keeps tab indentation, unrelated keys and the existing file mode", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".qwen/settings.json");
    write(path, '{\n\t"theme": "dark",\n\t"mcpServers": {}\n}', 0o644);
    chmodSync(path, 0o644);
    await install(fx, "qwen");
    const text = read(path);
    expect(text).toContain('\t"theme": "dark"');
    expect(text).toContain('\t\t"orchestrator": {');
    expect(JSON.parse(text).mcpServers.orchestrator).toEqual(split(fx));
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it("preserves comments and trailing commas in JSONC", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".config/opencode/opencode.jsonc");
    write(path, '{\n  // keep me\n  "theme": "dark", // trailing note\n  "mcp": {\n    "servers": {\n      "other": { "type": "local", "command": ["x"] }, // other note\n    },\n  },\n}\n');
    const result = await install(fx, "opencode");
    const text = read(path);
    expect(result.config_path).toBe(path);
    expect(text).toContain("// keep me");
    expect(text).toContain('"theme": "dark", // trailing note');
    expect(text).toContain("// other note");
    expect(text).toContain('"orchestrator": {');
    expect((await inspectMcp(CLIENTS.opencode, fx.ctx)).status).toBe("current");
  });

  it("inserts after a last member that has a same-line comment but no comma", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".kiro/settings/mcp.json");
    write(path, '{\n  "mcpServers": {\n    "other": { "command": "a" } // note\n  }\n}\n');
    await install(fx, "kiro");
    const text = read(path);
    expect(text).toContain('"other": { "command": "a" }, // note\n    "orchestrator"');
    expect((await inspectMcp(CLIENTS.kiro, fx.ctx)).status).toBe("current");
  });

  it("creates missing parent objects and handles inline objects", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".gemini/settings.json");
    write(path, '{"theme":"x"}');
    await install(fx, "gemini");
    expect(JSON.parse(read(path))).toEqual({ theme: "x", mcpServers: { orchestrator: split(fx) } });
  });

  it("opencode V1 (flat mcp) and V2 (mcp.servers) are detected from the document", async () => {
    const v1 = makeFixture();
    const v1Path = join(v1.home, ".config/opencode/opencode.json");
    write(v1Path, JSON.stringify({ mcp: { other: { type: "local", command: ["x"], enabled: true } } }));
    await install(v1, "opencode");
    expect(JSON.parse(read(v1Path)).mcp.orchestrator).toEqual({ type: "local", command: argvOf(v1), enabled: true });
    expect(JSON.parse(read(v1Path)).mcp.servers).toBeUndefined();

    const v2 = makeFixture();
    const v2Path = join(v2.home, ".config/opencode/opencode.json");
    write(v2Path, JSON.stringify({ mcp: { servers: { other: { type: "local", command: ["x"] } } } }));
    await install(v2, "opencode");
    expect(JSON.parse(read(v2Path)).mcp.servers.orchestrator).toEqual({ type: "local", command: argvOf(v2) });
    expect(JSON.parse(read(v2Path)).mcp.orchestrator).toBeUndefined();

    const fresh = makeFixture();
    write(join(fresh.home, ".config/opencode/opencode.json"), "{}");
    await install(fresh, "opencode");
    expect(JSON.parse(read(join(fresh.home, ".config/opencode/opencode.json"))).mcp.servers.orchestrator).toBeDefined();
  });

  it("refuses a malformed or wrongly shaped file and leaves it untouched", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".cursor/mcp.json");
    write(path, '{ "mcpServers": ');
    const broken = await install(fx, "cursor", FORCE);
    expect(broken).toMatchObject({ action: "skipped", status: "invalid" });
    expect(read(path)).toBe('{ "mcpServers": ');

    write(path, '{ "mcpServers": [] }');
    expect(await install(fx, "cursor", FORCE)).toMatchObject({ action: "skipped", status: "invalid" });
    write(path, "[]");
    expect(await install(fx, "cursor", FORCE)).toMatchObject({ action: "skipped", status: "invalid" });
    expect(tree(join(fx.home, ".cursor")).filter((entry) => entry.includes(".bak."))).toEqual([]);
  });
});

describe("TOML editing", () => {
  const CODEX_BASE = '# my settings\nmodel = "gpt"\n\n[mcp_servers.other]\ncommand = "other" # keep\n\n[profiles.fast]\nmodel = "mini"\n';

  it("appends a table and preserves comments and other tables byte-for-byte", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, CODEX_BASE);
    await install(fx, "codex");
    const text = read(path);
    expect(text.startsWith(CODEX_BASE)).toBe(true);
    expect(parseToml(text)).toMatchObject({ model: "gpt", mcp_servers: { other: { command: "other" }, orchestrator: split(fx) }, profiles: { fast: { model: "mini" } } });
  });

  it("updates a stale table in place, keeping extra keys, comments, sub-tables and multi-line arrays", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".grok/config.toml");
    write(path, [
      "[mcp_servers.orchestrator]", "# pinned by me", 'command = "node"', 'args = [', '  "/old/clone/dist/cli/main.js",', '  "mcp",', "]",
      "startup_timeout_sec = 30", "", "[mcp_servers.orchestrator.env]", 'KEY = "v"', "", "[other]", "a = 1", "",
    ].join("\n"));
    const result = await install(fx, "grok");
    expect(result).toMatchObject({ status: "stale", action: "updated", status_after: "current" });
    const text = read(path);
    expect(text).toContain("# pinned by me");
    expect(parseToml(text)).toEqual({
      mcp_servers: { orchestrator: { ...split(fx), startup_timeout_sec: 30, env: { KEY: "v" } } }, other: { a: 1 },
    });
    expect(result.backup_path && read(result.backup_path)).toContain("/old/clone/dist/cli/main.js");
  });

  it("does not mistake brackets inside multi-line strings or arrays for headers", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, 'notes = """\n[mcp_servers.orchestrator]\ncommand = "fake"\n"""\nlist = [\n  [1, 2],\n  [3],\n]\n');
    await install(fx, "codex");
    const parsed = parseToml(read(path)) as { notes: string; mcp_servers: { orchestrator: unknown } };
    expect(parsed.notes).toContain("[mcp_servers.orchestrator]");
    expect(parsed.mcp_servers.orchestrator).toEqual(split(fx));
  });

  it("reports an inline-table entry as unsupported instead of corrupting the file", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    const original = 'mcp_servers = { orchestrator = { command = "node", args = ["/old/dist/cli/main.js", "mcp"] } }\n';
    write(path, original);
    const result = await install(fx, "codex");
    expect(result).toMatchObject({ status: "stale", action: "error" });
    expect(read(path)).toBe(original);
  });

  it("rejects an unparsable TOML file", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, "[broken\n");
    expect(await install(fx, "codex", FORCE)).toMatchObject({ action: "skipped", status: "invalid" });
    expect(read(path)).toBe("[broken\n");
  });

  it("vibe: appends next to other [[mcp_servers]] elements and updates only the orchestrator one", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".vibe/config.toml");
    const other = '# vibe\n[[mcp_servers]]\nname = "other"\ntransport = "stdio"\ncommand = "x"\n';
    write(path, other);
    await install(fx, "vibe");
    expect(read(path).startsWith(other)).toBe(true);
    expect((parseToml(read(path)).mcp_servers as { name: string }[]).map((entry) => entry.name)).toEqual(["other", "orchestrator"]);

    write(path, `${other}\n[[mcp_servers]]\nname = "orchestrator"\ntransport = "stdio"\ncommand = "node"\nargs = ["/old/dist/cli/main.js", "mcp"]\n\n[mcp_servers.env]\nA = "1"\n`);
    const result = await install(fx, "vibe");
    expect(result).toMatchObject({ status: "stale", action: "updated" });
    const servers = parseToml(read(path)).mcp_servers as Record<string, unknown>[];
    expect(servers[0]).toEqual({ name: "other", transport: "stdio", command: "x" });
    expect(servers[1]).toEqual({ name: "orchestrator", transport: "stdio", ...split(fx), env: { A: "1" } });
  });

  it("vibe: several elements named orchestrator are a conflict", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".vibe/config.toml");
    const block = '[[mcp_servers]]\nname = "orchestrator"\ntransport = "stdio"\ncommand = "node"\nargs = ["/old/dist/cli/main.js", "mcp"]\n';
    write(path, `${block}\n${block}`);
    expect(await install(fx, "vibe")).toMatchObject({ status: "conflict", action: "skipped" });
    expect(await install(fx, "vibe", FORCE)).toMatchObject({ action: "updated", status_after: "current" });
    expect((parseToml(read(path)).mcp_servers as unknown[]).length).toBe(1);
  });
});

describe("YAML (dsh) editing", () => {
  const BASE = [
    "# top comment", "- insert:", "    # first plugin", "    - id: other", '      name: "@deepseek-ai/dsh-mcp-client"',
    "      config: { serverName: other, command: x, args: [] } # inline note", "- remove: [legacy]", "",
  ].join("\n");

  it("adds the item into the existing insert list and keeps comments and other plugins", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".dsh/cordis.patch.yml");
    write(path, BASE);
    await install(fx, "dsh");
    const text = read(path);
    for (const kept of ["# top comment", "# first plugin", "# inline note"]) expect(text).toContain(kept);
    const parsed = parseYaml(text) as { insert?: { id: string }[]; remove?: string[] }[];
    expect(parsed[0].insert?.map((item) => item.id)).toEqual(["other", "mcp-orchestrator"]);
    expect(parsed[1]).toEqual({ remove: ["legacy"] }); // flow-sequence spacing may be normalized; content is not
  });

  it("creates an insert operation when only other operations exist, and for an empty file", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".dsh/cordis.patch.yml");
    write(path, "- remove: [legacy]\n");
    await install(fx, "dsh");
    expect((parseYaml(read(path)) as unknown[]).length).toBe(2);

    const empty = makeFixture();
    write(join(empty.home, ".dsh/cordis.patch.yml"), "# only a comment\n");
    await install(empty, "dsh");
    expect(read(join(empty.home, ".dsh/cordis.patch.yml"))).toContain("# only a comment");
    expect((await inspectMcp(CLIENTS.dsh, empty.ctx)).status).toBe("current");
  });

  it("matches an existing entry by id or by serverName and updates it in place", async () => {
    for (const header of ["id: mcp-orchestrator", "id: renamed"]) {
      const fx = makeFixture();
      const path = join(fx.home, ".dsh/cordis.patch.yml");
      write(path, [
        "# keep", "- insert:", `    - ${header}`, '      name: "@deepseek-ai/dsh-mcp-client"', "      config:", "        serverName: orchestrator",
        "        transport: stdio", "        command: node", "        args: [/old/dist/cli/main.js, mcp]", "        timeout: 30", "",
      ].join("\n"));
      const result = await install(fx, "dsh");
      expect(result).toMatchObject({ status: "stale", action: "updated", status_after: "current" });
      const [{ insert }] = parseYaml(read(path)) as { insert: { config: Record<string, unknown> }[] }[];
      expect(insert).toHaveLength(1);
      expect(insert[0].config).toMatchObject({ ...split(fx), timeout: 30 });
      expect(read(path)).toContain("# keep");
    }
  });

  it("treats a foreign plugin or duplicate entries as a conflict; --force replaces them", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".dsh/cordis.patch.yml");
    write(path, "- insert:\n    - id: mcp-orchestrator\n      name: some-other-plugin\n      config: { command: python, args: [server.py] }\n");
    expect(await install(fx, "dsh")).toMatchObject({ status: "conflict", action: "skipped" });
    expect(await install(fx, "dsh", FORCE)).toMatchObject({ action: "updated", status_after: "current" });

    const dupes = makeFixture();
    const dupePath = join(dupes.home, ".dsh/cordis.patch.yml");
    const item = (id: string) => `    - id: ${id}\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: { serverName: orchestrator, transport: stdio, command: node, args: [/old/dist/cli/main.js, mcp] }\n`;
    write(dupePath, `- insert:\n${item("mcp-orchestrator")}${item("second")}`);
    expect(await install(dupes, "dsh")).toMatchObject({ status: "conflict", action: "skipped" });
    await install(dupes, "dsh", FORCE);
    expect(((parseYaml(read(dupePath)) as { insert: unknown[] }[])[0].insert)).toHaveLength(1);
  });

  it("rejects malformed YAML and a non-sequence document", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".dsh/cordis.patch.yml");
    write(path, "key: [unclosed\n");
    expect(await install(fx, "dsh", FORCE)).toMatchObject({ action: "skipped", status: "invalid" });
    write(path, "a: 1\n");
    expect(await install(fx, "dsh", FORCE)).toMatchObject({ action: "skipped", status: "invalid" });
    expect(read(path)).toBe("a: 1\n");
  });
});

describe("idempotency, stale upgrades and backups", () => {
  const ids: ClientId[] = ["claude", "codex", "dsh", "pi", "antigravity", "opencode", "gemini", "cursor", "grok", "kiro", "fx", "muse", "copilot", "droid", "qwen", "kimi", "vibe"];

  it.each(ids)("%s: a second install keeps exact bytes and mtime", async (id) => {
    const fx = makeFixture();
    const first = await install(fx, id);
    expect(first.action).toBe("created");
    const before = { text: read(first.config_path), mtime: statSync(first.config_path).mtimeMs };
    utimesSync(first.config_path, new Date(1_000_000), new Date(1_000_000));
    const second = await install(fx, id);
    expect(second).toMatchObject({ action: "unchanged", status: "current", status_after: "current" });
    expect(read(first.config_path)).toBe(before.text);
    expect(statSync(first.config_path).mtimeMs).toBe(1_000_000);
    expect(readdirSync(join(first.config_path, "..")).filter((name) => name.includes(".bak."))).toEqual([]);
  });

  it("never reports an orchestrator-mcp shim as current, even when it points at this build, and migrates it", async () => {
    const fx = makeFixture();
    write(join(fx.root, "repo/dist/cli/mcp.js"), "// mcp\n");
    const shim = join(fx.root, "bin", "orchestrator-mcp");
    mkdirSync(join(fx.root, "bin"));
    symlinkSync(join(fx.root, "repo/dist/cli/mcp.js"), shim);
    write(join(fx.home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { orchestrator: { command: shim, args: [] } } }));
    expect((await inspectMcp(CLIENTS.cursor, fx.ctx)).status).toBe("stale");
    expect(await install(fx, "cursor")).toMatchObject({ status: "stale", action: "updated", status_after: "current" });

    write(join(fx.home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "orchestrator-mcp", args: [] } } }));
    expect((await inspectMcp(CLIENTS.cursor, fx.ctx)).status).toBe("stale");
  });

  it.each([
    ["an old clone path", { command: "/opt/node/bin/node", args: ["/old/clone/dist/cli/main.js", "mcp"] }],
    ["a bare node", { command: "node", args: ["/old/clone/dist/cli/main.js", "mcp"] }],
    ["a moved orchestrator-mcp", { command: "/usr/local/bin/orchestrator-mcp", args: [] }],
  ])("upgrades %s to the current absolute paths and keeps a private backup", async (_name, stale) => {
    const fx = makeFixture();
    const path = join(fx.home, ".pi/agent/mcp.json");
    const original = JSON.stringify({ mcpServers: { orchestrator: { ...stale, env: { A: "1" } } } }, null, 2);
    write(path, original, 0o640);
    chmodSync(path, 0o640);
    const result = await install(fx, "pi");
    expect(result).toMatchObject({ status: "stale", action: "updated", status_after: "current" });
    expect(JSON.parse(read(path)).mcpServers.orchestrator).toEqual({ ...split(fx), env: { A: "1" } });
    expect(result.backup_path).toMatch(/mcp\.json\.bak\.\d{8}T\d+Z$/);
    expect(read(result.backup_path!)).toBe(original);
    expect(statSync(result.backup_path!).mode & 0o777).toBe(0o600);
    expect(statSync(path).mode & 0o777).toBe(0o640);
  });

  it("creates no backup for a new file", async () => {
    const fx = makeFixture();
    const result = await install(fx, "cursor");
    expect(result.backup_path).toBeUndefined();
    expect(readdirSync(join(fx.home, ".cursor")).filter((name) => name.includes(".bak."))).toEqual([]);
  });

  it("writes through a symlink to the real file and rejects a dangling one", async () => {
    const fx = makeFixture();
    const real = join(fx.root, "dotfiles/mcp.json");
    write(real, "{}\n");
    mkdirSync(join(fx.home, ".cursor"));
    symlinkSync(real, join(fx.home, ".cursor/mcp.json"));
    await install(fx, "cursor");
    expect(lstatSync(join(fx.home, ".cursor/mcp.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(read(real)).mcpServers.orchestrator).toEqual(split(fx));

    const dangling = makeFixture();
    mkdirSync(join(dangling.home, ".cursor"));
    symlinkSync(join(dangling.root, "missing/mcp.json"), join(dangling.home, ".cursor/mcp.json"));
    const result = await install(dangling, "cursor");
    expect(result).toMatchObject({ action: "error" });
    expect(result.message).toMatch(/dangling/);
    expect(existsSync(join(dangling.root, "missing"))).toBe(false);
  });

  it("fails cleanly when the built entry point is missing (but a dry run still plans)", async () => {
    const fx = makeFixture({ entryPath: join(makeFixture().root, "nope/dist/cli/main.js") });
    expect(await install(fx, "cursor")).toMatchObject({ action: "error" });
    expect(existsSync(join(fx.home, ".cursor"))).toBe(false);
    expect(await install(fx, "cursor", DRY)).toMatchObject({ action: "created" });
  });
});

describe("foreign and disabled entry protection", () => {
  it.each([
    ["claude", ".claude.json", () => JSON.stringify({ mcpServers: { orchestrator: { type: "stdio", command: "python", args: ["srv.py"] } } }, null, 2)],
    ["codex", ".codex/config.toml", () => '[mcp_servers.orchestrator]\ncommand = "python"\nargs = ["srv.py"]\nurl_note = "x"\n'],
    ["vibe", ".vibe/config.toml", () => '[[mcp_servers]]\nname = "orchestrator"\ntransport = "stdio"\ncommand = "python"\n'],
    ["fx", ".fx/mcp.json", () => JSON.stringify({ mcpServers: { orchestrator: { type: "http", url: "https://example.com/mcp" } } })],
  ] as const)("%s: a foreign orchestrator entry is skipped, then replaced only with --force", async (id, rel, content) => {
    const fx = makeFixture();
    const path = join(fx.home, rel);
    const original = content(fx);
    write(path, original);
    const skipped = await install(fx, id);
    expect(skipped).toMatchObject({ status: "conflict", action: "skipped", status_after: "conflict" });
    expect(read(path)).toBe(original);
    const forced = await install(fx, id, FORCE);
    expect(forced).toMatchObject({ status: "conflict", action: "updated", status_after: "current" });
    expect(read(path)).not.toContain("python");
    expect(read(path)).not.toContain("example.com");
  });

  it.each([
    ["claude", ".claude.json", (fx: Fixture) => JSON.stringify({ mcpServers: { orchestrator: { type: "stdio", ...split(fx), disabled: true } } })],
    ["opencode", ".config/opencode/opencode.json", (fx: Fixture) => JSON.stringify({ mcp: { orchestrator: { type: "local", command: argvOf(fx), enabled: false } } })],
    ["codex", ".codex/config.toml", (fx: Fixture) => `[mcp_servers.orchestrator]\ncommand = "${FAKE_NODE}"\nargs = ["${fx.entry}", "mcp"]\nenabled = false\n`],
    ["dsh", ".dsh/cordis.patch.yml", (fx: Fixture) => `- insert:\n    - id: mcp-orchestrator\n      name: "@deepseek-ai/dsh-mcp-client"\n      disabled: true\n      config: { serverName: orchestrator, transport: stdio, command: ${FAKE_NODE}, args: [${fx.entry}, mcp] }\n`],
  ] as const)("%s: a disabled entry is not silently re-enabled", async (id, rel, content) => {
    const fx = makeFixture();
    const path = join(fx.home, rel);
    const original = content(fx);
    write(path, original);
    expect(await install(fx, id)).toMatchObject({ status: "disabled", action: "skipped" });
    expect(read(path)).toBe(original);
    const forced = await install(fx, id, FORCE);
    expect(forced).toMatchObject({ status: "disabled", action: "updated", status_after: "current" });
    expect(read(path)).not.toMatch(/disabled|enabled\s*[:=]\s*false/);
  });
});

describe("dry run", () => {
  it("creates no files, directories or backups for any client", async () => {
    const fx = makeFixture();
    const before = tree(fx.home);
    for (const id of CLIENT_IDS) {
      const result = await install(fx, id, DRY);
      expect(result).toMatchObject({ action: "created", status_after: "current" });
    }
    expect(tree(fx.home)).toEqual(before);
  });

  it("reports the update plan for an existing file without modifying or backing it up", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    write(path, '[mcp_servers.orchestrator]\ncommand = "node"\nargs = ["/old/dist/cli/main.js", "mcp"]\n');
    const snapshot = tree(fx.home);
    const text = read(path);
    expect(await install(fx, "codex", DRY)).toMatchObject({ status: "stale", action: "updated" });
    expect(await uninstall(fx, "codex", DRY)).toMatchObject({ action: "removed" });
    expect(read(path)).toBe(text);
    expect(tree(fx.home)).toEqual(snapshot);
  });
});

describe("uninstall", () => {
  it("removes only the orchestrator entry from JSON/JSONC and restores the original bytes", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".cursor/mcp.json");
    const original = '{\n  // note\n  "mcpServers": {\n    "other": { "command": "a" }\n  },\n  "theme": 1\n}\n';
    write(path, original);
    await install(fx, "cursor");
    expect(read(path)).not.toBe(original);
    const result = await uninstall(fx, "cursor");
    expect(result).toMatchObject({ action: "removed", status_after: "missing" });
    expect(read(path)).toBe(original);
  });

  it("removes a first member and a sole member cleanly", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".qwen/settings.json");
    write(path, `{\n  "mcpServers": {\n    "orchestrator": ${JSON.stringify(split(fx))},\n    "other": {}\n  }\n}\n`);
    await uninstall(fx, "qwen");
    expect(JSON.parse(read(path))).toEqual({ mcpServers: { other: {} } });
    write(path, `{ "mcpServers": { "orchestrator": ${JSON.stringify(split(fx))} } }`);
    await uninstall(fx, "qwen");
    expect(JSON.parse(read(path))).toEqual({ mcpServers: {} });
  });

  it("removes TOML tables and array elements including their sub-tables", async () => {
    const fx = makeFixture();
    const codex = join(fx.home, ".codex/config.toml");
    const base = '# c\n[other]\na = 1\n';
    write(codex, base);
    await install(fx, "codex");
    await uninstall(fx, "codex");
    expect(read(codex)).toBe(base);

    const vibe = join(fx.home, ".vibe/config.toml");
    write(vibe, '[[mcp_servers]]\nname = "keep"\ntransport = "stdio"\ncommand = "k"\n');
    const keep = read(vibe);
    await install(fx, "vibe");
    await uninstall(fx, "vibe");
    expect(read(vibe)).toBe(keep);
  });

  it("removes the dsh item and drops an emptied insert operation but keeps comments", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".dsh/cordis.patch.yml");
    write(path, "# head\n- remove: [legacy]\n");
    await install(fx, "dsh");
    await uninstall(fx, "dsh");
    expect(read(path)).toContain("# head");
    expect(parseYaml(read(path))).toEqual([{ remove: ["legacy"] }]);
  });

  it("refuses foreign entries unless --force and reports missing entries as nothing to do", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".pi/agent/mcp.json");
    const foreign = JSON.stringify({ mcpServers: { orchestrator: { command: "python", args: ["x.py"] } } });
    write(path, foreign);
    expect(await uninstall(fx, "pi")).toMatchObject({ action: "skipped", status: "conflict" });
    expect(read(path)).toBe(foreign);
    expect(await uninstall(fx, "pi", FORCE)).toMatchObject({ action: "removed" });
    expect(JSON.parse(read(path)).mcpServers).toEqual({});
    expect(await uninstall(fx, "pi")).toMatchObject({ action: "unchanged", status: "missing" });
    expect(await uninstall(makeFixture(), "gemini")).toMatchObject({ action: "unchanged" });
  });

  it("removes a disabled owned entry without --force", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".claude.json");
    write(path, JSON.stringify({ mcpServers: { orchestrator: { ...split(fx), disabled: true } } }));
    expect(await uninstall(fx, "claude")).toMatchObject({ action: "removed", status: "disabled" });
  });
});

describe("detection and target resolution", () => {
  it("--target all selects nothing on an empty machine but explicit targets always work", async () => {
    const fx = makeFixture();
    expect((await resolveTargets(fx.ctx, ["all"])).specs).toEqual([]);
    expect((await resolveTargets(fx.ctx, ["fx", "fx", "claude"])).specs.map((spec) => spec.id)).toEqual(["fx", "claude"]);
    await expect(resolveTargets(fx.ctx, ["nope"])).rejects.toThrow(/Unknown target "nope"/);
  });

  it("detects by config directory, config file or binary on PATH", async () => {
    const fx = makeFixture({ pathResolver: (binary) => (binary === "gemini" ? "/usr/bin/gemini" : binary === "agy" ? "/usr/bin/agy" : undefined) });
    write(join(fx.home, ".cursor/notes.txt"), "user file\n");
    write(join(fx.home, ".claude.json"), "{}");
    const detected = (await resolveTargets(fx.ctx, ["all"])).specs.map((spec) => spec.id).sort();
    expect(detected).toEqual(["antigravity", "claude", "cursor", "gemini"]);
    expect((await detectClient(CLIENTS.gemini, fx.ctx)).reasons).toEqual(["binary /usr/bin/gemini"]);
  });

  it("a lone copied skill directory does not make an absent CLI look installed", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".dsh/skills/orchestrate/SKILL.md"), "x");
    write(join(fx.home, ".cursor/skills/orchestrate/SKILL.md"), "x");
    expect((await resolveTargets(fx.ctx, ["all"])).specs).toEqual([]);
    write(join(fx.home, ".dsh/profiles/a.yml"), "x");
    expect((await resolveTargets(fx.ctx, ["all"])).specs.map((spec) => spec.id)).toEqual(["dsh"]);
  });

  it("antigravity's directories do not make gemini look installed, and vice versa", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".gemini/antigravity/notes.txt"), "user file\n");
    expect((await resolveTargets(fx.ctx, ["all"])).specs.map((spec) => spec.id)).toEqual(["antigravity"]);
    const other = makeFixture();
    write(join(other.home, ".gemini/settings.json"), "{}");
    expect((await resolveTargets(other.ctx, ["all"])).specs.map((spec) => spec.id)).toEqual(["gemini"]);
  });
});

describe("inspection details", () => {
  it("redacts secrets in conflict details and never prints the whole command line", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { orchestrator: { command: "srv", args: ["--api-key=sk-ABCDEF1234567890ABCDEF", "--x", "--y", "--z"] } } }));
    const inspection = await inspectMcp(CLIENTS.cursor, fx.ctx);
    expect(inspection.status).toBe("conflict");
    expect(inspection.detail).not.toContain("--z");
    expect(inspection.detail).not.toContain("sk-ABCDEF1234567890ABCDEF");
  });
});

describe("review regressions", () => {
  it("an entry whose build path belongs to a different package is foreign, not stale", async () => {
    const fx = makeFixture();
    const foreignRoot = join(fx.root, "acme-orchestrator");
    write(join(foreignRoot, "package.json"), '{"name":"acme-orchestrator"}');
    write(join(foreignRoot, "dist/cli/main.js"), "//");
    const path = join(fx.home, ".claude.json");
    const original = JSON.stringify({ mcpServers: { orchestrator: { command: "node", args: [join(foreignRoot, "dist/cli/main.js"), "mcp"], env: { ACME_KEY: "k" } } } });
    write(path, original);
    expect(await install(fx, "claude")).toMatchObject({ status: "conflict", action: "skipped" });
    expect(await uninstall(fx, "claude")).toMatchObject({ status: "conflict", action: "skipped" });
    expect(read(path)).toBe(original);

    const ownRoot = join(fx.root, "renamed-clone");
    write(join(ownRoot, "package.json"), '{"name":"agent-router-mcp"}');
    write(join(ownRoot, "dist/cli/main.js"), "//");
    write(path, JSON.stringify({ mcpServers: { orchestrator: { command: "node", args: [join(ownRoot, "dist/cli/main.js"), "mcp"] } } }));
    expect((await inspectMcp(CLIENTS.claude, fx.ctx)).status).toBe("stale");
  });

  it("keeps comments that introduce the next TOML table on uninstall and on forced replace", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".codex/config.toml");
    const tail = '# notes for context7: token lives in env\n# [mcp_servers.old]\n[mcp_servers.context7]\ncommand = "c7"\n';
    write(path, `[mcp_servers.orchestrator]\ncommand = "node"\nargs = ["/old/dist/cli/main.js", "mcp"]\n\n${tail}`);
    await install(fx, "codex");
    await uninstall(fx, "codex");
    expect(read(path)).toBe(tail);

    write(path, `[mcp_servers.orchestrator]\ncommand = "python"\n\n${tail}`);
    await install(fx, "codex", FORCE);
    expect(read(path)).toContain(tail);
    expect(parseToml(read(path)).mcp_servers).toMatchObject({ orchestrator: split(fx), context7: { command: "c7" } });
  });

  it("a lone skill directory under a legacy root does not detect kimi or antigravity", async () => {
    const fx = makeFixture();
    write(join(fx.home, ".kimi/skills/orchestrate/SKILL.md"), "x");
    write(join(fx.home, ".gemini/antigravity/skills/orchestrate/SKILL.md"), "x");
    expect((await resolveTargets(fx.ctx, ["all"])).specs).toEqual([]);
    write(join(fx.home, ".kimi/mcp.json"), "{}");
    expect((await resolveTargets(fx.ctx, ["all"])).specs.map((spec) => spec.id)).toEqual(["kimi"]);
  });

  it("refuses to overwrite a config that changed between reading and writing", async () => {
    let fx: Fixture;
    let tamper = true;
    fx = makeFixture({
      pathResolver: () => {
        if (tamper) {
          tamper = false;
          write(join(fx.home, ".claude.json"), '{"projects":{"a":1}}');
        }
        return undefined;
      },
    });
    write(join(fx.home, ".claude.json"), "{}");
    const result = await install(fx, "claude");
    expect(result).toMatchObject({ action: "error" });
    expect(result.message).toMatch(/changed while it was being edited/);
    expect(read(join(fx.home, ".claude.json"))).toBe('{"projects":{"a":1}}');
  });

  it("keeps comments inside an empty JSONC object when adding the entry", async () => {
    for (const [initial, comment] of [['{\n  // keep me\n}\n', "// keep me"], ['{ "mcpServers": { /* add servers here */ } }', "/* add servers here */"]]) {
      const fx = makeFixture();
      const path = join(fx.home, ".cursor/mcp.json");
      write(path, initial);
      await install(fx, "cursor");
      expect(read(path)).toContain(comment);
      expect((await inspectMcp(CLIENTS.cursor, fx.ctx)).status).toBe("current");
    }
  });

  it("removes a JSONC member whose comma is separated from the value by a comment", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".cursor/mcp.json");
    write(path, `{"mcpServers": {"orchestrator": ${JSON.stringify(split(fx))} /* c */, "b": {}}}`);
    expect(await uninstall(fx, "cursor")).toMatchObject({ action: "removed", status_after: "missing" });
    expect(JSON.parse(read(path).replace(/\/\*.*?\*\//g, ""))).toEqual({ mcpServers: { b: {} } });

    write(path, `{"mcpServers": {"a": 1 /* x, y */ , "orchestrator": ${JSON.stringify(split(fx))}}}`);
    await uninstall(fx, "cursor");
    expect(read(path)).toContain("/* x, y */");
    expect(JSON.parse(read(path).replace(/\/\*.*?\*\//g, "")).mcpServers).toEqual({ a: 1 });
  });
});

describe("second review round regressions", () => {
  const STALE_ARGS = 'args = ["/old/dist/cli/main.js", "mcp"]';
  const OTHER_ELEMENT = ['[[mcp_servers]]', 'name = "other"', 'transport = "stdio"', 'command = "x"', ""];
  const orchestratorElement = (args = STALE_ARGS, command = "node") => ['[[mcp_servers]]', 'name = "orchestrator"', 'transport = "stdio"', `command = "${command}"`, args, ""];
  const DETACHED_ENV = ["[unrelated]", "a = 1", "", "[mcp_servers.env]", 'TOKEN = "x"', ""];
  const mcpServersOf = (path: string) => parseToml(read(path)).mcp_servers as Record<string, unknown>[];

  describe("vibe sub-tables separated from their [[mcp_servers]] element", () => {
    it("uninstall removes the detached sub-table with its element and never re-attaches it to a sibling", async () => {
      const fx = makeFixture();
      const path = join(fx.home, ".vibe/config.toml");
      write(path, [...OTHER_ELEMENT, ...orchestratorElement(), ...DETACHED_ENV].join("\n"));
      expect(mcpServersOf(path)[1].env).toEqual({ TOKEN: "x" });
      expect(await uninstall(fx, "vibe")).toMatchObject({ action: "removed", status_after: "missing" });
      expect(mcpServersOf(path)).toEqual([{ name: "other", transport: "stdio", command: "x" }]);
      expect(parseToml(read(path)).unrelated).toEqual({ a: 1 });
      expect(read(path)).not.toContain("TOKEN");
    });

    it("a sub-table that belongs to the following element stays with it", async () => {
      const fx = makeFixture();
      const path = join(fx.home, ".vibe/config.toml");
      write(path, [...orchestratorElement(), ...OTHER_ELEMENT, ...DETACHED_ENV].join("\n"));
      expect(await uninstall(fx, "vibe")).toMatchObject({ action: "removed" });
      expect(mcpServersOf(path)).toEqual([{ name: "other", transport: "stdio", command: "x", env: { TOKEN: "x" } }]);
    });

    it("a stale repair keeps the detached sub-table on the orchestrator element", async () => {
      const fx = makeFixture();
      const path = join(fx.home, ".vibe/config.toml");
      write(path, [...OTHER_ELEMENT, ...orchestratorElement(), ...DETACHED_ENV].join("\n"));
      expect(await install(fx, "vibe")).toMatchObject({ status: "stale", action: "updated", status_after: "current" });
      const servers = mcpServersOf(path);
      expect(servers[0]).toEqual({ name: "other", transport: "stdio", command: "x" });
      expect(servers[1]).toEqual({ name: "orchestrator", transport: "stdio", ...split(fx), env: { TOKEN: "x" } });
    });

    it("a forced replace drops the detached sub-table instead of leaking it to a sibling", async () => {
      const fx = makeFixture();
      const path = join(fx.home, ".vibe/config.toml");
      write(path, [...OTHER_ELEMENT, ...orchestratorElement('args = ["srv.py"]', "python"), ...DETACHED_ENV].join("\n"));
      expect(await install(fx, "vibe", FORCE)).toMatchObject({ status: "conflict", action: "updated", status_after: "current" });
      const servers = mcpServersOf(path);
      expect(servers[0]).toEqual({ name: "other", transport: "stdio", command: "x" });
      expect(servers[1]).toEqual({ name: "orchestrator", transport: "stdio", ...split(fx) });
      expect(read(path)).not.toContain("TOKEN");
    });
  });

  it("copilot: a stale repair keeps the user's narrowed tools while refreshing the command", async () => {
    const fx = makeFixture();
    const path = join(fx.home, ".copilot/mcp-config.json");
    write(path, JSON.stringify({ mcpServers: { orchestrator: { type: "local", command: "node", args: ["/old/dist/cli/main.js", "mcp"], tools: ["orch_status"] } } }));
    expect(await install(fx, "copilot")).toMatchObject({ status: "stale", action: "updated", status_after: "current" });
    expect(JSON.parse(read(path)).mcpServers.orchestrator).toEqual({ type: "local", ...split(fx), tools: ["orch_status"] });
  });

  describe("dsh patch file shapes", () => {
    const entryYaml = (fx: Fixture, indent: string) => [
      `${indent}id: mcp-orchestrator`, `${indent}name: "@deepseek-ai/dsh-mcp-client"`,
      `${indent}config: { serverName: orchestrator, transport: stdio, command: ${FAKE_NODE}, args: [${fx.entry}, mcp] }`,
    ].join("\n");
    const patchPath = (fx: Fixture) => join(fx.home, ".dsh/cordis.patch.yml");

    it("does not add the entry into a scoped insert operation", async () => {
      const fx = makeFixture();
      write(patchPath(fx), "- profile: dev\n  insert:\n    - id: other\n      name: some-plugin\n");
      await install(fx, "dsh");
      const parsed = parseYaml(read(patchPath(fx))) as { profile?: string; insert: { id: string }[] }[];
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({ profile: "dev", insert: [{ id: "other", name: "some-plugin" }] });
      expect(parsed[1].insert.map((item) => item.id)).toEqual(["mcp-orchestrator"]);
    });

    it.each([
      ["an alias item inside insert", (fx: Fixture) => `- shared: &entry\n${entryYaml(fx, "    ")}\n- insert:\n    - *entry\n`],
      ["an aliased insert list", (fx: Fixture) => `- defs: &list\n    - id: mcp-orchestrator\n      name: "@deepseek-ai/dsh-mcp-client"\n      config: { serverName: orchestrator, transport: stdio, command: ${FAKE_NODE}, args: [${fx.entry}, mcp] }\n- insert: *list\n`],
    ])("detects an entry defined through %s", async (_name, content) => {
      const fx = makeFixture();
      const original = content(fx);
      write(patchPath(fx), original);
      expect((await inspectMcp(CLIENTS.dsh, fx.ctx)).status).toBe("current");
      expect(await install(fx, "dsh")).toMatchObject({ action: "unchanged", status: "current" });
      expect(read(patchPath(fx))).toBe(original);
    });

    it("refuses to edit a stale entry that is only reachable through an alias", async () => {
      const fx = makeFixture();
      const original = "- defs: &list\n    - id: mcp-orchestrator\n      name: \"@deepseek-ai/dsh-mcp-client\"\n      config: { serverName: orchestrator, transport: stdio, command: node, args: [/old/dist/cli/main.js, mcp] }\n- insert: *list\n";
      write(patchPath(fx), original);
      expect(await install(fx, "dsh")).toMatchObject({ status: "stale", action: "error" });
      expect(await uninstall(fx, "dsh")).toMatchObject({ action: "error" });
      expect(read(patchPath(fx))).toBe(original);
    });

    it("reports a later disabled override as disabled; --force removes the override", async () => {
      const fx = makeFixture();
      const original = `- insert:\n    -\n${entryYaml(fx, "      ")}\n- id: mcp-orchestrator\n  disabled: true\n- remove: [legacy]\n`;
      write(patchPath(fx), original);
      expect((await inspectMcp(CLIENTS.dsh, fx.ctx)).status).toBe("disabled");
      expect(await install(fx, "dsh")).toMatchObject({ status: "disabled", action: "skipped" });
      expect(read(patchPath(fx))).toBe(original);
      expect(await install(fx, "dsh", FORCE)).toMatchObject({ status: "disabled", action: "updated", status_after: "current" });
      expect(parseYaml(read(patchPath(fx)))).toEqual([
        { insert: [{ id: "mcp-orchestrator", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "orchestrator", transport: "stdio", ...split(fx) } }] },
        { remove: ["legacy"] },
      ]);
    });
  });

  describe("orchestrator-mcp ownership", () => {
    it.each([
      [["python", "orchestrator-mcp"], false],
      [["bash", "/x/orchestrator-mcp"], false],
      [["python3", "/x/orchestrator-mcp.py"], false],
      [["/usr/bin/env", "orchestrator-mcp"], false],
      [["orchestrator-mcp"], true],
      [["/usr/local/bin/orchestrator-mcp"], true],
      [["C:\\bin\\orchestrator-mcp.cmd"], true],
      [["/usr/bin/node", "/x/orchestrator-mcp"], true],
      [["node.exe", "C:\\x\\orchestrator-mcp.js"], true],
    ])("looksOwned(%j) is %s", (argv, owned) => {
      expect(looksOwned(argv)).toBe(owned);
    });

    it("a foreign interpreter running a script named orchestrator-mcp is a conflict and is left untouched", async () => {
      const fx = makeFixture();
      const path = join(fx.home, ".cursor/mcp.json");
      const original = JSON.stringify({ mcpServers: { orchestrator: { command: "python", args: ["orchestrator-mcp"] } } });
      write(path, original);
      expect(await install(fx, "cursor")).toMatchObject({ status: "conflict", action: "skipped" });
      expect(await uninstall(fx, "cursor")).toMatchObject({ status: "conflict", action: "skipped" });
      expect(read(path)).toBe(original);
    });
  });

  describe("fx binary collision with the fx JSON viewer", () => {
    const fxOnPath = (binary: string) => (binary === "fx" ? "/usr/bin/fx" : undefined);

    it("a binary named fx on PATH alone does not detect the client", async () => {
      const fx = makeFixture({ pathResolver: fxOnPath });
      expect((await detectClient(CLIENTS.fx, fx.ctx)).detected).toBe(false);
      expect((await resolveTargets(fx.ctx, ["all"])).specs).toEqual([]);
      write(join(fx.home, ".fx/skills/orchestrate/SKILL.md"), "x");
      expect((await resolveTargets(fx.ctx, ["all"])).specs).toEqual([]);
    });

    it("the binary counts once ~/.fx has content of its own", async () => {
      const fx = makeFixture({ pathResolver: fxOnPath });
      write(join(fx.home, ".fx/config.json"), "{}");
      const detection = await detectClient(CLIENTS.fx, fx.ctx);
      expect(detection.detected).toBe(true);
      expect(detection.reasons).toEqual(expect.arrayContaining(["binary /usr/bin/fx", `directory ${join(fx.home, ".fx")}`]));
      expect((await resolveTargets(fx.ctx, ["all"])).specs.map((spec) => spec.id)).toEqual(["fx"]);
    });
  });

  describe("OpenCode JSONC stale repair", () => {
    const opencodePath = (fx: Fixture) => join(fx.home, ".config/opencode/opencode.jsonc");

    it("updates only the changed properties so comments on untouched siblings survive", async () => {
      const fx = makeFixture();
      const path = opencodePath(fx);
      write(path, [
        "{", '  "mcp": {', '    "servers": {', '      "orchestrator": {', '        "type": "local",',
        '        "command": ["node", "/old/dist/cli/main.js", "mcp"], // old launcher',
        "        // keep me", '        "environment": { "A": "1" } // trailing note', "      }", "    }", "  }", "}", "",
      ].join("\n"));
      expect(await install(fx, "opencode")).toMatchObject({ status: "stale", action: "updated", status_after: "current" });
      const text = read(path);
      expect(text).toContain("// keep me");
      expect(text).toContain('"environment": { "A": "1" } // trailing note');
      expect(JSON.parse(text.replace(/\/\/[^\n]*/g, "")).mcp.servers.orchestrator).toEqual({ type: "local", command: argvOf(fx), environment: { A: "1" } });
    });

    it("a forced repair drops enabled:false, disabled and args but keeps unknown keys and their comments", async () => {
      const fx = makeFixture();
      const path = opencodePath(fx);
      write(path, [
        "{", '  "mcp": { "servers": {', '    "orchestrator": {', '      "type": "local",', '      "command": ["node", "/old/dist/cli/main.js", "mcp"],',
        '      "args": ["legacy"],', '      "enabled": false,', '      "disabled": true,', "      // keep me", '      "timeout": 30', "    }", "  } }", "}", "",
      ].join("\n"));
      expect(await install(fx, "opencode")).toMatchObject({ status: "disabled", action: "skipped" });
      expect(await install(fx, "opencode", FORCE)).toMatchObject({ action: "updated", status_after: "current" });
      const text = read(path);
      expect(text).toContain("// keep me");
      expect(JSON.parse(text.replace(/\/\/[^\n]*/g, "")).mcp.servers.orchestrator).toEqual({ type: "local", command: argvOf(fx), timeout: 30 });
    });
  });
});
