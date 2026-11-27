import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLI_NAME, LEGACY_CLI_NAMES } from "../../src/cli/name.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const FIXED_FILES = [
  "README.md",
  "README.ru.md",
  "README.zh.md",
  "docs/AI_AGENT_GUIDE.md",
  "AGENTS.md",
  "CLAUDE.md",
  "skills/orchestrate/SKILL.md",
  "src/settings-ui/app.html",
  "src/settings-ui/server.ts",
  "src/mcp/server.ts",
];
const GLOBBED_DIRS: Array<{ dir: string; extension: string }> = [
  { dir: "assets", extension: ".svg" },
  { dir: "docs/examples", extension: ".toml" },
];

const listFiles = (): string[] => [
  ...FIXED_FILES,
  ...GLOBBED_DIRS.flatMap(({ dir, extension }) =>
    readdirSync(join(ROOT, dir)).filter((name) => name.endsWith(extension)).sort().map((name) => `${dir}/${name}`)),
];

/** Old `orch <subcommand>` invocations, and the old `orchestrate-settings` binary. Never valid advice anymore. */
const LEGACY_INVOCATION = /\borch (mcp|setup|settings|doctor|config|skill|wait)\b|\borchestrate-settings\b/;
/** `orchestrator-mcp` is still the XDG directory name and may appear as that path; anywhere else it is the retired binary. */
const LEGACY_BINARY = /(?<![\w./-])orchestrator-mcp\b(?!\/)/;
const XDG_PATH = /(\.config|\.local\/state|XDG_[A-Z_]+\}?)\/orchestrator-mcp\b/g;
/** A line that explicitly talks about the retired names (migration or cleanup note) in English, Russian, or Chinese. */
const MIGRATION_NOTE = /legacy|migrat|stale|older release|earlier release|no longer|\bgone\b|стар|устаревш|мигрир|旧的|过期|迁移|不再/i;

export function findLegacyCliMentions(text: string): string[] {
  return text.split("\n").flatMap((line, index) => {
    if (MIGRATION_NOTE.test(line)) return [];
    const withoutPaths = line.replace(XDG_PATH, "");
    return LEGACY_INVOCATION.test(withoutPaths) || LEGACY_BINARY.test(withoutPaths) ? [`${index + 1}: ${line.trim().slice(0, 140)}`] : [];
  });
}

describe("CLI naming guard", () => {
  const files = listFiles();

  it("scans the documentation, examples, skill, UI, MCP server, and every SVG", () => {
    expect(files).toEqual(expect.arrayContaining(["README.md", "assets/hero.svg", "assets/before-after.svg", "docs/examples/models.minimal.toml"]));
    expect(files.filter((file) => file.endsWith(".svg")).length).toBeGreaterThan(10);
  });

  it.each(files)("%s recommends no legacy CLI invocation", (file) => {
    expect(findLegacyCliMentions(readFileSync(join(ROOT, file), "utf8"))).toEqual([]);
  });

  describe("detector negative control", () => {
    it.each([
      "Run `orch setup --target all` now.",
      "$ orch doctor",
      "<tspan> orchestrate-settings</tspan>",
      "Register it with `orchestrator-mcp` as the command.",
      "orch wait --job 1",
    ])("flags %j", (line) => {
      expect(findLegacyCliMentions(line)).toHaveLength(1);
    });

    it.each([
      "default `~/.config/orchestrator-mcp/models.toml`",
      "state in ~/.local/state/orchestrator-mcp",
      "$XDG_CONFIG_HOME/orchestrator-mcp/models.toml",
      "Legacy `orchestrator-mcp` / `orch mcp` entries are migrated by `agrmcp setup`.",
      "MCP tool `orch_run`, env `ORCH_DEPTH`, key `orchestrator`, skill `orchestrate`",
      "agrmcp setup --target all",
    ])("accepts %j", (line) => {
      expect(findLegacyCliMentions(line)).toEqual([]);
    });
  });

  describe("package binary", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string; bin: Record<string, string> };

    it("exposes only the unified command, matching CLI_NAME", () => {
      expect(Object.keys(pkg.bin)).toEqual([CLI_NAME]);
      expect(pkg.bin[CLI_NAME]).toBe("./dist/cli/main.js");
      for (const legacy of LEGACY_CLI_NAMES) expect(pkg.bin).not.toHaveProperty(legacy);
    });

    it("keeps the stable package name", () => {
      expect(pkg.name).toBe("agent-router-mcp");
    });
  });
});
