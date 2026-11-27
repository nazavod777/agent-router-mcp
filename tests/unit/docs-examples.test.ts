import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigManager, type ConfigSnapshot } from "../../src/config/resolver.js";

const EXAMPLES_DIR = fileURLToPath(new URL("../../docs/examples/", import.meta.url));

// Every example file must have an entry here, so a new example cannot ship unchecked.
const EXPECTATIONS: Record<string, (config: ConfigSnapshot) => void> = {
  "models.minimal.toml": (config) => {
    expect(config.defaults.locale).toBe("en");
    expect(config.defaults.max_concurrency).toBe(2);
    expect(config.defaults.default_timeout_sec).toBe(600);
    expect(config.defaults_provenance.default_timeout_sec).toBe("overridden");
    expect(config.harnesses.kiro.enabled).toBe(false);
    expect(config.harnesses.kiro.provenance).toBe("overridden");
    expect(config.harnesses.kiro.binary).toBe("kiro-cli");
  },
  "custom-harness.toml": (config) => {
    const harness = config.harnesses["claude-custom"];
    expect(harness).toMatchObject({
      driver: "claude",
      binary: "/usr/local/bin/claude-wrapper",
      enabled: true,
      provenance: "custom",
    });
    const model = config.models["claude-custom-sonnet"];
    expect(model).toMatchObject({
      harness: "claude-custom",
      cli_model: "claude-sonnet-5-5",
      default_effort: "high",
      provenance: "custom",
    });
    expect(model.efforts).toContain(model.default_effort);
  },
  "preset-role.toml": (config) => {
    const preset = config.presets.balanced;
    expect(preset.roles.quick).toEqual({ harness: "claude", model: "claude-sonnet-5-5", effort: "medium" });
    expect(preset.provenance).toBe("overridden");
    // Other roles stay inherited from the built-in catalog.
    expect(preset.roles.implementation).toEqual({ harness: "claude", model: "claude-sonnet-5-5", effort: "high" });
  },
};

const exampleFiles = readdirSync(EXAMPLES_DIR).filter((name) => name.endsWith(".toml")).sort();

function loadWithUserConfig(userPath: string): ConfigSnapshot {
  return new ConfigManager({ userPath }).load();
}

describe("docs/examples TOML files", () => {
  it("covers every example file with an expectation", () => {
    expect(exampleFiles.length).toBeGreaterThan(0);
    expect(exampleFiles).toEqual(Object.keys(EXPECTATIONS).sort());
  });

  it.each(exampleFiles)("%s loads with zero config_warnings and applies its override", (name) => {
    const config = loadWithUserConfig(join(EXAMPLES_DIR, name));
    expect(config.config_warnings).toEqual([]);
    EXPECTATIONS[name](config);
  });

  describe("negative control", () => {
    let scratch: string | undefined;
    afterEach(() => {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    });

    it("reports a config warning when a preset role breaks the harness/model invariant", () => {
      scratch = mkdtempSync(join(tmpdir(), "orch-docs-examples-"));
      const broken = join(scratch, "models.toml");
      const source = readFileSync(join(EXAMPLES_DIR, "preset-role.toml"), "utf8");
      writeFileSync(broken, source.replace('harness = "claude"', 'harness = "codex"'));
      const config = loadWithUserConfig(broken);
      expect(config.config_warnings).toHaveLength(1);
      expect(config.config_warnings[0]).toMatch(/does not match model/);
      expect(config.presets.balanced.roles.quick.model).toBe("claude-haiku-5-5");
    });
  });
});
