import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigManager, type ConfigSnapshot } from "../../../src/config/resolver.js";
import { ConfigWriter } from "../../../src/config/writer.js";
import type { DiscoveredModel, DiscoveryDeps, DiscoveryObservation } from "../../../src/discovery/index.js";

const CARD_DEFAULTS: Record<string, string> = {
  display_name: '"Built-in card"', tier: '"deep"', efforts: '["low", "high"]', default_effort: '"high"', cost_tier: '"low"',
  cost_note: '"Built-in note"', speed_note: '"Built-in speed"', context_window: "200000", strengths: '["built-in"]',
  weaknesses: "[]", best_for: "[]", avoid_for: "[]", checked_at: '"2026-11-01"',
};

/** A schema-valid model table body; `overrides` replace defaults key by key (values are TOML literals). */
const card = (harness: string, overrides: Record<string, string>): string =>
  Object.entries({ harness: `"${harness}"`, ...CARD_DEFAULTS, ...overrides }).map(([key, value]) => `${key} = ${value}`).join("\n");

/** A small built-in catalog that exercises every driver rule discovery normalizes. */
export const DISCOVERY_CATALOG = `
schema_version = 1

[aliases]
"taken-alias" = "claude-opus-5-5"

[harnesses.claude]
driver = "claude"
display_name = "Claude"
binary = "claude"

[harnesses.pi]
driver = "pi"
display_name = "Pi"
binary = "pi"
default_upstream_provider = "opencode-go"

[harnesses.pi-alt]
driver = "pi"
display_name = "Pi (second profile)"
binary = "pi"

[harnesses.opencode]
driver = "opencode"
display_name = "OpenCode"
binary = "opencode"

[harnesses.dsh]
driver = "dsh"
display_name = "DSH"
binary = "dsh"
default_upstream_provider = "deepseek-official"

[harnesses.gemini]
driver = "gemini"
display_name = "Gemini"
binary = "gemini"

[harnesses.cursor]
driver = "cursor"
display_name = "Cursor"
binary = "cursor-agent"

[harnesses.claude-wrapper]
driver = "claude"
display_name = "Claude wrapper"
binary = "my-claude-wrapper"

[models."claude-opus-5-5"]
${card("claude", { cli_model: '"claude-opus-5-5"', vendor_family: '"anthropic"', cost_tier: '"premium"', efforts: '["low", "medium", "high"]' })}

[models."pi-deepseek-v4-pro"]
${card("pi", { cli_model: '"deepseek-v4-pro"', cli_provider: '"opencode-go"', vendor_family: '"deepseek"', efforts: '["off", "low", "high", "max"]', default_effort: '"low"' })}

[models."dsh-deepseek-v4-pro"]
${card("dsh", { cli_model: '"deepseek-v4-pro"', vendor_family: '"deepseek"', cost_tier: '"medium"' })}

[models."oc-disabled"]
${card("opencode", { cli_model: '"gpt-x"', cli_provider: '"openai"', enabled: "false" })}
`;

export const USER_CONFIG = `
schema_version = 1

[models.dup-a]
custom = true
enabled = false
${card("opencode", { cli_model: '"gpt-y"', cli_provider: '"openai"' })}

[models.dup-b]
custom = true
enabled = false
${card("opencode", { cli_model: '"gpt-y"', cli_provider: '"openai"' })}
`;

export interface DiscoveryWorld {
  root: string;
  home: string;
  userPath: string;
  manager: ConfigManager;
  writer: ConfigWriter;
  environment: { homeDir: string; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; cwd: string };
  snapshot(): ConfigSnapshot;
}

/** An isolated temporary config and home directory; nothing here can reach the real user home. */
export function makeWorld(options: { user?: string; catalog?: string } = {}): DiscoveryWorld {
  // Canonical path: macOS reports /private/var for the /var temp symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orch-discovery-")));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const defaultPath = join(root, "catalog.toml");
  const userPath = join(root, "models.toml");
  writeFileSync(defaultPath, options.catalog ?? DISCOVERY_CATALOG);
  if (options.user !== undefined) writeFileSync(userPath, options.user);
  const manager = new ConfigManager({ defaultPath, userPath, now: () => new Date("2026-11-26T00:00:00Z") });
  return {
    root, home, userPath, manager, writer: new ConfigWriter(manager),
    environment: { homeDir: home, env: {}, platform: "linux", cwd: root },
    snapshot: () => manager.load(),
  };
}

export function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export const FIXED_NOW = new Date("2026-11-26T10:00:00.000Z");

export function listed(cli_model: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return { cli_model, availability: "reported_available", evidence: "cli_listing", ...extra };
}

export function observation(models: DiscoveredModel[]): DiscoveryObservation {
  return { models, diagnostics: [], truncated: false };
}

/** Fake Layer 1/Layer 2 sources: models per harness ID, with call spies. */
export function fakeDeps(layer1: Record<string, DiscoveredModel[]>, layer2: Record<string, DiscoveredModel[]> = {}): DiscoveryDeps & {
  localCalls: string[]; probeCalls: string[];
} {
  const localCalls: string[] = [];
  const probeCalls: string[] = [];
  return {
    localCalls, probeCalls, now: () => FIXED_NOW,
    readLocal: async (input) => { localCalls.push(input.harnessId); return observation(layer1[input.harnessId] ?? []); },
    probe: async (input) => { probeCalls.push(input.harnessId); return observation(layer2[input.harnessId] ?? []); },
  };
}
