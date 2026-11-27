import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessConfig } from "../../src/config/schema.js";
import { DRIVER_KINDS, type DriverKind } from "../../src/drivers.js";
import { readLocalModels } from "../../src/discovery/local-readers.js";
import { MAX_MODELS_PER_SOURCE, type DiscoveredModel, type DiscoveryObservation, type ModelDiscoveryMode } from "../../src/discovery/types.js";

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "discovery-readers-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(file: string, content: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function putHome(relative: string, content: string): string {
  return put(join(home, relative), content);
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  harness?: Partial<HarnessConfig>;
  discovery?: ModelDiscoveryMode;
  signal?: AbortSignal;
  deadlineAtMs?: number;
  hintMode?: boolean;
}

function run(driver: DriverKind, options: RunOptions = {}): Promise<DiscoveryObservation> {
  const harness: HarnessConfig = { driver, display_name: driver, binary: driver, enabled: true, ...options.harness };
  return readLocalModels({
    harnessId: driver, harness, driver, discovery: options.discovery ?? "native", homeDir: home, env: options.env ?? {},
    platform: "linux", cwd: join(root, "cwd"),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.deadlineAtMs !== undefined ? { deadlineAtMs: options.deadlineAtMs } : {}),
    ...(options.hintMode ? { hintMode: true } : {}),
  });
}

function find(observation: DiscoveryObservation, model: string, provider?: string): DiscoveredModel | undefined {
  return observation.models.find((entry) => entry.cli_model === model && entry.cli_provider === provider);
}

function ids(observation: DiscoveryObservation): string[] {
  return observation.models.map((entry) => entry.cli_provider ? `${entry.cli_provider}/${entry.cli_model}` : entry.cli_model).sort();
}

describe("pi", () => {
  it("reads models.json providers, overrides, and settings.json defaults and enabledModels", async () => {
    putHome(".pi/agent/models.json", JSON.stringify({
      providers: {
        local: {
          apiKey: "sk-SECRET",
          models: [
            { id: "m1", name: "Model One", contextWindow: 128000, reasoning: true, thinkingLevelMap: { low: "low", high: "high", off: null } },
            { id: "m2" },
          ],
          modelOverrides: { "builtin-x": { name: "Builtin X", contextWindow: 64000 } },
        },
      },
    }));
    putHome(".pi/agent/settings.json", JSON.stringify({
      defaultProvider: "local", defaultModel: "m1", enabledModels: ["acme/nested/model-z", "local/m2", "acme/*", "bare"],
    }));
    const result = await run("pi");
    expect(find(result, "m1", "local")).toMatchObject({
      display_name: "Model One", context_window: 128000, context_precision: "exact", reasoning: true,
      native_efforts: ["low", "high"], availability: "configured", evidence: "local_config",
    });
    expect(find(result, "builtin-x", "local")).toMatchObject({ display_name: "Builtin X", context_window: 64000 });
    expect(find(result, "model-z", "acme")).toBeUndefined();
    expect(find(result, "nested/model-z", "acme")).toBeDefined();
    expect(find(result, "bare")).toBeDefined();
    expect(ids(result)).toEqual(["acme/nested/model-z", "bare", "local/builtin-x", "local/m1", "local/m2"]);
    expect(result.models.filter((entry) => entry.cli_model === "m2")).toHaveLength(1);
    expect(result.diagnostics).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("sk-SECRET");
  });

  it("honours PI_CODING_AGENT_DIR and resolves a relative value against the injected cwd", async () => {
    put(join(root, "cwd", "pi-dir", "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "rel" }] } } }));
    const result = await run("pi", { env: { PI_CODING_AGENT_DIR: "pi-dir" } });
    expect(ids(result)).toEqual(["p/rel"]);
  });
});

describe("opencode", () => {
  it("reads V2 providers and V1 provider with JSONC comments and trailing commas, and splits the top-level model at the first slash", async () => {
    putHome(".config/opencode/opencode.jsonc", `{
      // comment
      "providers": { "alpha": { "models": { "a-1": { "name": "Alpha One", "limit": { "context": 200000, }, "reasoning": true, }, }, }, },
      /* block */
      "model": "openrouter/anthropic/claude-x",
    }`);
    putHome(".config/opencode/opencode.json", JSON.stringify({ provider: { beta: { models: { "b-1": {} } } } }));
    const result = await run("opencode");
    expect(find(result, "a-1", "alpha")).toMatchObject({ display_name: "Alpha One", context_window: 200000, reasoning: true });
    expect(find(result, "b-1", "beta")).toBeDefined();
    expect(find(result, "anthropic/claude-x", "openrouter")).toBeDefined();
    expect(result.diagnostics).toEqual([]);
  });

  it("honours OPENCODE_CONFIG, OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME and reads each file once", async () => {
    const explicit = put(join(root, "explicit.json"), JSON.stringify({ provider: { e: { models: { m: {} } } } }));
    put(join(root, "cfgdir", "opencode.json"), JSON.stringify({ providers: { d: { models: { m: {} } } } }));
    put(join(root, "xdg", "opencode", "opencode.json"), JSON.stringify({ providers: { x: { models: { m: {} } } } }));
    const result = await run("opencode", { env: { OPENCODE_CONFIG: explicit, OPENCODE_CONFIG_DIR: join(root, "cfgdir"), XDG_CONFIG_HOME: join(root, "xdg") } });
    expect(ids(result)).toEqual(["d/m", "e/m", "x/m"]);
  });
});

describe("codex", () => {
  const codexHome = (): string => join(home, ".codex");

  it("reads config.toml, the profile table and the profile file, and the models cache", async () => {
    put(join(codexHome(), "config.toml"), [
      'model = "root-model"', 'model_provider = "openai"', 'model_reasoning_effort = "low"', "model_context_window = 100000", "",
      "[profiles.fast]", 'model = "fast-model"', 'model_reasoning_effort = "high"', "",
    ].join("\n"));
    put(join(codexHome(), "fast.config.toml"), 'model_context_window = 50000\n');
    put(join(codexHome(), "models_cache.json"), JSON.stringify({
      models: [
        { slug: "gpt-x", display_name: "GPT X", context_window: 272000, supported_reasoning_levels: [{ effort: "low" }, { effort: "high", description: "x" }] },
        { slug: "gpt-y", supported_reasoning_levels: ["medium"] },
        { slug: "gpt-z" },
      ],
    }));
    const result = await run("codex", { harness: { profile: "fast" } });
    expect(find(result, "root-model", "openai")).toBeUndefined();
    expect(find(result, "fast-model", "openai")).toMatchObject({
      context_window: 50000, context_precision: "exact", reasoning: true, native_efforts: ["high"], availability: "configured", evidence: "local_config",
    });
    expect(find(result, "gpt-x")).toMatchObject({
      display_name: "GPT X", context_window: 272000, native_efforts: ["low", "high"], availability: "unknown", evidence: "local_cache",
    });
    expect(find(result, "gpt-y")).toMatchObject({ native_efforts: ["medium"], reasoning: true });
    expect(find(result, "gpt-z")).toMatchObject({ availability: "unknown" });
    expect(result.diagnostics).toEqual([]);
  });

  it("reads the root model without a profile, and tolerates an absent cache", async () => {
    put(join(codexHome(), "config.toml"), 'model = "m"\nmodel_reasoning_effort = "none"\n');
    const result = await run("codex");
    expect(result.models).toEqual([{ cli_model: "m", availability: "configured", evidence: "local_config" }]);
  });

  it("rejects an unsafe profile name with a diagnostic and never builds a path from it", async () => {
    put(join(codexHome(), "config.toml"), 'model = "m"\n');
    put(join(root, "escape.config.toml"), 'model = "escaped"\n');
    const result = await run("codex", { harness: { profile: "../../escape" } });
    expect(ids(result)).toEqual(["m"]);
    expect(result.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "Ignored the harness profile: not a plain file name." }]);
  });

  it("honours CODEX_HOME", async () => {
    put(join(root, "ch", "config.toml"), 'model = "from-env"\n');
    expect(ids(await run("codex", { env: { CODEX_HOME: join(root, "ch") } }))).toEqual(["from-env"]);
  });
});

describe("dsh", () => {
  const defaultPatch = (): string => join(home, ".dsh", "cordis.patch.yml");

  it("reads agent-default-model and llm-pi-ai from the patch files, preferring the configured upstream provider", async () => {
    put(defaultPatch(), [
      "- id: agent-default-model", "  config:", "    model: deepseek-v4", "    reasoningEffort: high",
      "- id: llm-pi-ai", "  config:", "    providers:", "      custom:", "        apiKey: sk-SECRET", "        models:",
      "          - id: c-1", "            name: Custom One", "            contextWindow: 65536", "            reasoningEfforts: [low, high]",
      "          - id: c-2", "- id: unrelated", "  config: { model: nope }", "",
    ].join("\n"));
    put(join(home, ".dsh", "profiles", "headless", "cordis.patch.yml"), [
      "patches:", "  - id: agent-default-model", "    config: { provider: acme, model: profile-model }",
      "  - id: llm-pi-ai", "    disabled: true", "    config: { providers: { off: { models: [{ id: disabled-model }] } } }", "",
    ].join("\n"));
    const result = await run("dsh", { harness: { default_upstream_provider: "my-upstream" } });
    expect(find(result, "deepseek-v4", "my-upstream")).toMatchObject({ reasoning: true, native_efforts: ["high"] });
    expect(find(result, "c-1", "custom")).toMatchObject({ display_name: "Custom One", context_window: 65536, native_efforts: ["low", "high"], reasoning: true });
    expect(find(result, "c-2", "custom")).toBeDefined();
    expect(find(result, "profile-model", "acme")).toBeDefined();
    expect(find(result, "disabled-model", "off")).toBeUndefined();
    expect(find(result, "nope")).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("sk-SECRET");
  });

  it("falls back to deepseek-official and reads only the requested profile", async () => {
    put(defaultPatch(), "- id: agent-default-model\n  config: { model: m }\n");
    put(join(home, ".dsh", "profiles", "other", "cordis.patch.yml"), "- id: agent-default-model\n  config: { model: other-model }\n");
    const result = await run("dsh");
    expect(ids(result)).toEqual(["deepseek-official/m"]);
    expect(ids(await run("dsh", { harness: { profile: "other" } }))).toEqual(["deepseek-official/m", "deepseek-official/other-model"]);
  });

  it("reports an invalid YAML file by basename and reason only", async () => {
    put(defaultPatch(), "- id: [unterminated secret-text-sk-SECRET\n");
    const result = await run("dsh");
    expect(result.models).toEqual([]);
    expect(result.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "cordis.patch.yml: invalid content" }]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});

describe("claude", () => {
  it("reads model, availableModels, modelOverrides and modelPicker and never the env block", async () => {
    putHome(".claude/settings.json", JSON.stringify({
      model: "opus", availableModels: ["sonnet", "haiku"], env: { ANTHROPIC_API_KEY: "sk-SECRET", ANTHROPIC_MODEL: "env-model" },
      modelOverrides: { "claude-opus-4-1": "arn:aws:bedrock:us-east-1:123:inference-profile/x" },
      modelPicker: { options: [{ model: "picker-model", label: "Picker" }, { label: "no model" }] },
    }));
    const result = await run("claude");
    expect(ids(result)).toEqual(["arn:aws:bedrock:us-east-1:123:inference-profile/x", "claude-opus-4-1", "haiku", "opus", "picker-model", "sonnet"]);
    expect(find(result, "picker-model")).toMatchObject({ display_name: "Picker", availability: "configured" });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|env-model/);
  });

  it("honours CLAUDE_CONFIG_DIR", async () => {
    put(join(root, "cc", "settings.json"), JSON.stringify({ model: "from-env" }));
    putHome(".claude/settings.json", JSON.stringify({ model: "home-model" }));
    expect(ids(await run("claude", { env: { CLAUDE_CONFIG_DIR: join(root, "cc") } }))).toEqual(["from-env"]);
  });
});

describe("gemini and antigravity", () => {
  it("reads gemini model.name and modelConfigs keys, honouring GEMINI_CLI_HOME", async () => {
    const settings = JSON.stringify({
      model: { name: "gemini-2.5-pro" }, modelConfigs: { customAliases: { fast: { x: 1 } }, modelDefinitions: { "gemini-custom": { apiKey: "sk-SECRET" } } },
    });
    putHome(".gemini/settings.json", settings);
    const result = await run("gemini");
    expect(ids(result)).toEqual(["fast", "gemini-2.5-pro", "gemini-custom"]);
    put(join(root, "gh", ".gemini", "settings.json"), JSON.stringify({ model: { name: "env-gemini" } }));
    expect(ids(await run("gemini", { env: { GEMINI_CLI_HOME: join(root, "gh") } }))).toEqual(["env-gemini"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("reads antigravity models, reducing URLs to scheme://host and dropping any value with userinfo", async () => {
    putHome(".gemini/antigravity-cli/settings.json", JSON.stringify({
      model: "ag-default", modelProvider: "google",
      customModelsConfig: { customModels: [
        { modelName: "https://host.example/v1/model?key=SECRET#frag", label: "Remote" },
        { modelName: "https://user:pass@host.example/v1/model", label: "WithUserinfo" },
        { modelName: "plain-model", label: "Plain\u001b[31m Red\u0007" },
      ] },
    }));
    const result = await run("antigravity");
    expect(find(result, "ag-default", "google")).toBeDefined();
    expect(find(result, "https://host.example")).toMatchObject({ display_name: "Remote" });
    expect(result.models.some((model) => model.display_name === "WithUserinfo")).toBe(false);
    expect(find(result, "plain-model")).toMatchObject({ display_name: "Plain Red" });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/user:pass|SECRET|frag|key=|v1\/model/);
  });

  it("never lets a credential survive hidden behind invisible characters, a missing scheme, or a URL path", async () => {
    const hostile = [
      "https://\u2028user:SECRET2@host/v1", "https\u200b://user:SECRET3@host/v1", "//user:SECRET4@host/v1", "user:SECRET5@host",
      "https://eth-mainnet.g.alchemy.com/v2/SECRETPATHKEY", "https://\nuser:SECRET6@host", "https://host/\u0000x?token=SECRET7",
    ];
    putHome(".gemini/antigravity-cli/settings.json", JSON.stringify({
      model: hostile[0], customModelsConfig: { customModels: hostile.map((modelName, index) => ({ modelName, label: hostile[index] })) },
    }));
    const result = await run("antigravity");
    expect(JSON.stringify(result)).not.toMatch(/SECRET/);
    expect(ids(result)).toEqual(expect.arrayContaining(["https://eth-mainnet.g.alchemy.com", "https://host"]));
    expect(ids(result).every((id) => !id.includes("@") && !id.includes("v2"))).toBe(true);
  });
});

describe("grok, fx, vibe, kimi", () => {
  it("reads grok models table and per-model entries", async () => {
    putHome(".grok/config.toml", [
      "[models]", 'default = "grok-4"', 'allowed_models = ["grok-4", "grok-3"]', "",
      "[model.grok-4]", 'name = "Grok 4"', "context_window = 256000", "supports_reasoning_effort = true", 'api_key = "sk-SECRET"', "",
    ].join("\n"));
    const result = await run("grok");
    expect(find(result, "grok-4")).toMatchObject({ display_name: "Grok 4", context_window: 256000, reasoning: true });
    expect(find(result, "grok-3")).toBeDefined();
    expect(result.models).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("reads fx string and array models and allowlisted metadata only", async () => {
    putHome(".fx/settings.json", JSON.stringify({
      provider: "p1",
      models: { p1: ["a", "b"], p2: "single" },
      providers: { p1: { apiKey: "sk-SECRET", model_metadata: { a: { context_window: 32000, reasoning: true, token: "sk-SECRET", baseUrl: "https://u:p@h/?k=SECRET" }, c: { contextLength: 1000 } } } },
    }));
    const result = await run("fx");
    expect(find(result, "a", "p1")).toMatchObject({ context_window: 32000, reasoning: true });
    expect(find(result, "b", "p1")).toBeDefined();
    expect(find(result, "single", "p2")).toBeDefined();
    expect(find(result, "c", "p1")).toMatchObject({ context_window: 1000 });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|u:p/);
  });

  it("reads vibe active/allowed models and [[models]] entries", async () => {
    putHome(".vibe/config.toml", [
      'active_model = "devstral"', 'allowed_models = ["devstral", "small"]', "",
      "[[models]]", 'alias = "devstral"', 'name = "devstral-2"', 'provider = "mistral"', 'display_name = "Devstral"',
      "max_context_length = 131072", 'thinking_levels = ["low", "high"]', 'api_key = "sk-SECRET"', "",
      "[[models]]", 'name = "by-name"', "thinking = true", "",
    ].join("\n"));
    const result = await run("vibe");
    expect(find(result, "devstral")).toBeDefined();
    expect(find(result, "devstral", "mistral")).toMatchObject({
      display_name: "Devstral", context_window: 131072, native_efforts: ["low", "high"], reasoning: true,
    });
    expect(find(result, "small")).toBeDefined();
    expect(find(result, "by-name")).toMatchObject({ reasoning: true });
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("reads the first existing kimi config only and never provider tables", async () => {
    putHome(".kimi/config.toml", 'default_model = "old"\n');
    putHome(".kimi-code/config.toml", [
      'default_model = "k2"', "", "[models.k2]", 'model = "kimi-k2-turbo"', 'provider = "moonshot"', 'display_name = "Kimi K2"',
      "max_context_size = 262144", "", "[providers.moonshot]", 'api_key = "sk-SECRET"', 'base_url = "https://u:p@api.example/v1?x=SECRET"', "",
    ].join("\n"));
    const result = await run("kimi");
    expect(result.models).toEqual([{
      cli_model: "kimi-k2-turbo", cli_provider: "moonshot", display_name: "Kimi K2", context_window: 262144, context_precision: "exact",
      availability: "configured", evidence: "local_config",
    }]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|moonshot\.|api\.example/);
  });

  it("falls through kimi candidates in order and keeps an unknown default alias", async () => {
    putHome(".kimi/config.toml", 'default_model = "legacy"\n');
    expect(ids(await run("kimi"))).toEqual(["legacy"]);
    put(join(root, "share", "config.toml"), 'default_model = "shared"\n');
    expect(ids(await run("kimi", { env: { KIMI_SHARE_DIR: join(root, "share") } }))).toEqual(["shared"]);
  });

  it("reads a kimi path that is named twice only once and still falls through to the later candidates", async () => {
    // KIMI_CODE_HOME names the same directory as the default `~/.kimi-code`; neither has a config, `~/.kimi` does.
    putHome(".kimi/config.toml", 'default_model = "legacy"\n');
    const result = await run("kimi", { env: { KIMI_CODE_HOME: join(home, ".kimi-code") } });
    expect(ids(result)).toEqual(["legacy"]);
    expect(result.diagnostics).toEqual([]);
    // An existing file named twice is read once too: a broken one yields exactly one diagnostic.
    putHome(".kimi-code/config.toml", "= not toml");
    const broken = await run("kimi", { env: { KIMI_CODE_HOME: join(home, ".kimi-code") } });
    expect(broken.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "config.toml: invalid content" }]);
  });
});

describe("copilot, droid, qwen", () => {
  it("copies only allowlisted copilot fields and never planted secrets", async () => {
    putHome(".copilot/providers.json", JSON.stringify({
      providers: [{
        name: "azure", apiKey: "sk-SECRET", headers: { Authorization: "Bearer X" }, baseUrl: "https://user:pass@host.example/v1?key=SECRET",
        models: [
          { id: "gpt-x", name: "GPT X", maxContextWindowTokens: 128000, reasoning_effort: "medium", provider: "openai", token: "sk-SECRET", url: "https://user:pass@h/?key=SECRET" },
          { id: "gpt-y", reasoning_effort: ["low", "high"] },
        ],
      }],
    }));
    const result = await run("copilot");
    expect(find(result, "gpt-x", "openai")).toEqual({
      cli_model: "gpt-x", cli_provider: "openai", display_name: "GPT X", context_window: 128000, context_precision: "exact", reasoning: true,
      native_efforts: ["medium"], availability: "configured", evidence: "local_config",
    });
    expect(find(result, "gpt-y", "azure")).toMatchObject({ native_efforts: ["low", "high"], reasoning: true });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|Bearer|user:pass|Authorization/);
  });

  it("prefers COPILOT_PROVIDERS_CONFIG over COPILOT_HOME", async () => {
    putHome(".copilot/providers.json", JSON.stringify({ providers: [{ name: "a", models: [{ id: "home-model" }] }] }));
    const explicit = put(join(root, "explicit-providers.json"), JSON.stringify({ providers: [{ name: "b", models: [{ id: "explicit-model" }] }] }));
    const result = await run("copilot", { env: { COPILOT_PROVIDERS_CONFIG: explicit, COPILOT_HOME: join(root, "nope") } });
    expect(ids(result)).toEqual(["b/explicit-model"]);
  });

  it("reads droid customModels without apiKey or baseUrl", async () => {
    putHome(".factory/settings.json", JSON.stringify({
      customModels: [{
        id: "custom:Opus-0", model: "claude-opus", displayName: "Opus", provider: "anthropic", maxContextLimit: 200000,
        reasoningEffort: "high", apiKey: "sk-SECRET", baseUrl: "https://user:pass@host/v1?key=SECRET",
      }, { id: "custom:Plain-1", enableThinking: true }],
    }));
    const result = await run("droid");
    expect(find(result, "claude-opus", "anthropic")).toMatchObject({
      display_name: "Opus", context_window: 200000, reasoning: true, native_efforts: ["high"],
    });
    expect(find(result, "custom:Plain-1")).toMatchObject({ reasoning: true });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|user:pass/);
  });

  it("reads qwen model.name and modelProviders without envKey/baseUrl/apiKey", async () => {
    putHome(".qwen/settings.json", JSON.stringify({
      model: { name: "qwen3-coder" },
      modelProviders: { openai: [{ id: "qwen-plus", name: "Qwen Plus", envKey: "SECRET_ENV", baseUrl: "https://u:p@h/?k=SECRET", apiKey: "sk-SECRET", generationConfig: { contextWindowSize: 131072 } }] },
    }));
    const result = await run("qwen");
    expect(find(result, "qwen3-coder")).toBeDefined();
    expect(find(result, "qwen-plus", "openai")).toMatchObject({ display_name: "Qwen Plus", context_window: 131072 });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|u:p/);
  });
});

describe("probe-only drivers", () => {
  it.each(["cursor", "kiro", "muse"] as const)("%s returns an empty, silent observation", async (driver) => {
    putHome(".cursor/settings.json", JSON.stringify({ model: "x" }));
    expect(await run(driver)).toEqual({ models: [], diagnostics: [], truncated: false });
  });

  it("covers every driver kind with a reader", async () => {
    for (const driver of DRIVER_KINDS) {
      const result = await run(driver);
      expect(result.diagnostics).toEqual([]);
      expect(result.truncated).toBe(false);
    }
  });
});

describe("file safety", () => {
  const settingsFile = (): string => join(home, ".claude", "settings.json");

  it("treats missing files as silent", async () => {
    expect(await run("claude")).toEqual({ models: [], diagnostics: [], truncated: false });
  });

  it("follows a symbolic link to a regular file (dotfile managers link configs into place)", async () => {
    const target = put(join(root, "dotfiles", "claude-settings.json"), JSON.stringify({ model: "linked" }));
    mkdirSync(dirname(settingsFile()), { recursive: true });
    symlinkSync(target, settingsFile());
    const result = await run("claude");
    expect(ids(result)).toEqual(["linked"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("refuses a symbolic link whose TARGET is a denied secret file, even though the link name is harmless", async () => {
    const secret = put(join(root, "dotfiles", "auth.json"), JSON.stringify({ model: "leaked-through-link" }));
    mkdirSync(dirname(settingsFile()), { recursive: true });
    symlinkSync(secret, settingsFile());
    const result = await run("claude");
    expect(result.models).toEqual([]);
    expect(result.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: file name is denied" }]);
    expect(JSON.stringify(result)).not.toContain("leaked-through-link");
  });

  it("refuses a link to a directory or a FIFO, and treats a dangling link as a missing file", async () => {
    mkdirSync(dirname(settingsFile()), { recursive: true });
    const directory = join(root, "dotfiles", "a-directory");
    mkdirSync(directory, { recursive: true });
    symlinkSync(directory, settingsFile());
    expect((await run("claude")).diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: not a regular file" }]);

    rmSync(settingsFile());
    const fifo = join(root, "dotfiles", "a-fifo");
    try {
      execFileSync("mkfifo", [fifo]);
      symlinkSync(fifo, settingsFile());
      expect((await run("claude")).diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: not a regular file" }]);
      rmSync(settingsFile());
    } catch {
      // mkfifo is unavailable on this platform: the directory case above already covers the non-regular target.
    }

    symlinkSync(join(root, "dotfiles", "does-not-exist.json"), settingsFile());
    expect(await run("claude")).toEqual({ models: [], diagnostics: [], truncated: false });
  });

  it("applies the size cap to the target of a symbolic link", async () => {
    const target = put(join(root, "dotfiles", "big.json"), JSON.stringify({ model: "big", pad: "x".repeat(1024 * 1024 + 1) }));
    mkdirSync(dirname(settingsFile()), { recursive: true });
    symlinkSync(target, settingsFile());
    expect((await run("claude")).diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: file is too large" }]);
  });

  it("reads an empty config file as a valid source without degrading the harness", async () => {
    putHome(".claude/settings.json", "");
    expect(await run("claude")).toEqual({ models: [], diagnostics: [], truncated: false });
    putHome(".codex/config.toml", "  \n");
    expect(await run("codex")).toEqual({ models: [], diagnostics: [], truncated: false });
    putHome(".dsh/cordis.patch.yml", "\n");
    expect(await run("dsh")).toEqual({ models: [], diagnostics: [], truncated: false });
  });

  it("rejects a directory and a FIFO instead of a regular file", async () => {
    mkdirSync(settingsFile(), { recursive: true });
    const directory = await run("claude");
    expect(directory.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: not a regular file" }]);
    rmSync(settingsFile(), { recursive: true });
    try {
      execFileSync("mkfifo", [settingsFile()]);
    } catch {
      return;
    }
    const fifo = await run("claude");
    expect(fifo.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: not a regular file" }]);
  });

  it("rejects an oversized file", async () => {
    putHome(".claude/settings.json", JSON.stringify({ model: "big", pad: "x".repeat(1024 * 1024 + 1) }));
    const result = await run("claude");
    expect(result.models).toEqual([]);
    expect(result.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: file is too large" }]);
  });

  it("reports invalid JSON without echoing the content", async () => {
    putHome(".claude/settings.json", '{"model": "sk-SECRET-value", ');
    const result = await run("claude");
    expect(result.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: invalid content" }]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  it("never opens a denied file name even when an env var points at it", async () => {
    const denied = put(join(root, "auth.json"), JSON.stringify({ provider: { p: { models: { leaked: {} } } } }));
    const result = await run("opencode", { env: { OPENCODE_CONFIG: denied } });
    expect(result.models).toEqual([]);
    expect(result.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "auth.json: file name is denied" }]);
  });

  it("does not hit the deny list for the model cache and provider file names", async () => {
    put(join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [{ slug: "cache-ok" }] }));
    putHome(".copilot/providers.json", JSON.stringify({ providers: [{ name: "p", models: [{ id: "providers-ok" }] }] }));
    expect(ids(await run("codex"))).toEqual(["cache-ok"]);
    expect(ids(await run("copilot"))).toEqual(["p/providers-ok"]);
  });

  it("strips a BOM and normalizes CRLF", async () => {
    putHome(".codex/config.toml", '﻿model = "bom-model"\r\nmodel_provider = "p"\r\n');
    expect(ids(await run("codex"))).toEqual(["p/bom-model"]);
  });

  it("ignores prototype-pollution keys", async () => {
    putHome(".config/opencode/opencode.json", `{
      "__proto__": { "polluted": true },
      "providers": {
        "__proto__": { "models": { "evil": {} } },
        "constructor": { "models": { "evil-ctor": {} } },
        "ok": { "models": { "__proto__": {}, "prototype": {}, "good": {} } }
      }
    }`);
    const result = await run("opencode");
    expect(ids(result)).toEqual(["ok/good"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("sanitizing and bounds", () => {
  it("strips control characters, caps length, redacts URL-like ids, and drops anything that is not a plain token", async () => {
    putHome(".claude/settings.json", JSON.stringify({
      model: "ok\u0000\u001b[1mname\u001b[0m",
      availableModels: [
        "y".repeat(500), "https://user:pass@h.example/m?token=SECRET", "https://h.example/m?token=SECRET", "ftp://", "   ",
        "--dangerously-skip-permissions", "opus --print hi", "-m", "has space",
      ],
    }));
    const result = await run("claude");
    for (const model of result.models) {
      expect(model.cli_model.length).toBeLessThanOrEqual(200);
      expect(model.cli_model).not.toMatch(/[\u0000-\u001f]/);
    }
    expect(ids(result)).toEqual(["https://h.example", "okname", "y".repeat(200)]);
    expect(JSON.stringify(result)).not.toMatch(/user:pass|SECRET|print|dangerously/);
  });

  it("caps models per observation and reports truncation", async () => {
    const models = Array.from({ length: MAX_MODELS_PER_SOURCE + 50 }, (_unused, index) => `m${index}`);
    putHome(".grok/config.toml", `[models]\nallowed_models = ${JSON.stringify(models)}\n`);
    const result = await run("grok");
    expect(result.models.length).toBe(MAX_MODELS_PER_SOURCE);
    expect(result.truncated).toBe(true);
  });

  it("drops invalid context windows and effort tokens", async () => {
    putHome(".config/opencode/opencode.json", JSON.stringify({
      providers: { p: { models: { a: { limit: { context: -5 } }, b: { limit: { context: "128k" } }, c: { limit: { context: 1.5 } } } } },
    }));
    putHome(".codex/models_cache.json", JSON.stringify([{ slug: "e", supported_reasoning_levels: ["ok", "bad value!", "<script>"] }]));
    const opencode = await run("opencode");
    expect(opencode.models.every((model) => model.context_window === undefined && model.context_precision === undefined)).toBe(true);
    expect(find(await run("codex"), "e")?.native_efforts).toEqual(["ok"]);
  });
});

describe("custom wrapper rule", () => {
  const realClaudeSettings = (): void => {
    putHome(".claude/settings.json", JSON.stringify({ model: "stock-opus", availableModels: ["stock-sonnet"] }));
  };

  it("manual mode never reads stock driver files and reports only extra_args models plus manual_only when none", async () => {
    realClaudeSettings();
    const empty = await run("claude", { discovery: "manual", harness: { binary: "claude-wrapper" } });
    expect(empty).toEqual({
      models: [], truncated: false,
      diagnostics: [{ stage: "offline", code: "manual_only", message: "Custom wrapper: models are declared manually." }],
    });
    const withArgs = await run("claude", {
      discovery: "manual", harness: { binary: "claude-wrapper", extra_args: ["--model", "wrapped-model", "-m", "short", "--model=eq-model", "--model", "--bad", "-m=skip"] },
    });
    expect(ids(withArgs)).toEqual(["eq-model", "short", "wrapped-model"]);
    expect(withArgs.models.every((model) => model.availability === "configured" && model.evidence === "local_config")).toBe(true);
    expect(withArgs.diagnostics).toEqual([]);
    expect(JSON.stringify(withArgs)).not.toContain("stock");
  });

  it("wrapper mode reads no driver files and reports scope_unknown", async () => {
    realClaudeSettings();
    const result = await run("claude", { discovery: "wrapper" });
    expect(result.models).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["scope_unknown"]);
    expect(result.diagnostics[0]?.stage).toBe("offline");
  });

  it("native mode reads driver files and also inspects extra_args", async () => {
    realClaudeSettings();
    const result = await run("claude", { harness: { extra_args: ["--model", "stock-opus", "-m", "extra-only", "--model=https://u:p@h.example/x?k=SECRET"] } });
    expect(ids(result)).toEqual(["extra-only", "stock-opus", "stock-sonnet"]); // the URL with userinfo is dropped whole
    expect(result.models.filter((model) => model.cli_model === "stock-opus")).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/u:p|SECRET/);
  });

  it("ignores a value that starts with a dash", async () => {
    const result = await run("claude", { discovery: "manual", harness: { extra_args: ["--model", "-x", "--model=-y", "-m"] } });
    expect(result.models).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["manual_only"]);
  });
});

describe("deadline and cancellation", () => {
  it("returns truncated with no reads once the deadline has passed", async () => {
    putHome(".claude/settings.json", JSON.stringify({ model: "m" }));
    const result = await run("claude", { deadlineAtMs: performance.now() - 1 });
    expect(result.models).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["timeout"]);
  });

  it("returns truncated when the signal is already aborted", async () => {
    putHome(".pi/agent/models.json", JSON.stringify({ providers: { p: { models: [{ id: "m" }] } } }));
    const controller = new AbortController();
    controller.abort();
    const result = await run("pi", { signal: controller.signal });
    expect(result.models).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["cancelled"]);
  });

  it("stops reading further files once the signal aborts and keeps what was gathered", async () => {
    putHome(".pi/agent/models.json", JSON.stringify({ providers: { p: { models: [{ id: "first" }] } } }));
    putHome(".pi/agent/settings.json", JSON.stringify({ defaultModel: "second" }));
    // The signal reports "not aborted" for the first file check and "aborted" from the second one on.
    let checks = 0;
    const signal = {
      get aborted() {
        checks += 1;
        return checks > 1;
      },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    const result = await run("pi", { signal });
    expect(ids(result)).toEqual(["p/first"]);
    expect(result.truncated).toBe(true);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["cancelled"]);
  });
});

describe("hint mode and the nested-loop deadline", () => {
  it("reads smaller files and fewer of them in hint mode than in a normal read", async () => {
    // 200 KiB is fine for a normal read and over the hint-mode cap.
    putHome(".claude/settings.json", JSON.stringify({ model: "bulky", pad: "x".repeat(200 * 1024) }));
    expect(ids(await run("claude"))).toEqual(["bulky"]);
    const hinted = await run("claude", { hintMode: true });
    expect(hinted.models).toEqual([]);
    expect(hinted.diagnostics).toEqual([{ stage: "offline", code: "source_unreadable", message: "settings.json: file is too large" }]);

    // Five existing OpenCode configs: all are read normally, only the first three in hint mode, and the cut is reported.
    const configFiles = ["a", "b", "c", "d", "e"].map((name) => put(join(root, "oc", `${name}.json`), JSON.stringify({ model: `p/model-${name}` })));
    const env = { OPENCODE_CONFIG: configFiles[0], OPENCODE_CONFIG_DIR: join(root, "oc-dir") };
    putHome(".config/opencode/opencode.json", JSON.stringify({ model: "p/model-home" }));
    put(join(root, "oc-dir", "opencode.json"), JSON.stringify({ model: "p/model-dir-json" }));
    put(join(root, "oc-dir", "opencode.jsonc"), JSON.stringify({ model: "p/model-dir-jsonc" }));
    putHome(".config/opencode/opencode.jsonc", JSON.stringify({ model: "p/model-home-jsonc" }));
    const normal = await run("opencode", { env });
    expect(normal.models).toHaveLength(5);
    expect(normal.truncated).toBe(false);
    const hint = await run("opencode", { env, hintMode: true });
    expect(hint.models).toHaveLength(3);
    expect(hint.truncated).toBe(true);
  });

  it("stops inside a long parsing loop once the deadline passes, not only between files", async () => {
    const available = Array.from({ length: 400 }, (_, index) => `model-${index}`);
    putHome(".claude/settings.json", JSON.stringify({ availableModels: available }));
    expect((await run("claude")).models).toHaveLength(400);

    // A clock that lets the file load through and then jumps past the deadline.
    let reads = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (++reads <= 8 ? 0 : 10_000));
    try {
      const result = await run("claude", { deadlineAtMs: 1_000 });
      expect(result.models.length).toBeLessThan(400);
      expect(result.truncated).toBe(true);
      expect(result.diagnostics.map((entry) => entry.code)).toEqual(["timeout"]);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not read a later file once the deadline has passed", async () => {
    putHome(".pi/agent/models.json", "{ broken");
    putHome(".pi/agent/settings.json", "{ also broken");
    const result = await run("pi", { deadlineAtMs: performance.now() - 1 });
    // Neither file was opened, so neither produced an `invalid content` diagnostic.
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["timeout"]);
    expect(result.models).toEqual([]);
  });
});

describe("module hygiene", () => {
  it("never imports child_process, net, or http modules", () => {
    const source = readFileSync(new URL("../../src/discovery/local-readers.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/child_process|node:net|node:http|node:https|node:dns|fetch\(/);
    expect(source).not.toMatch(/os\.homedir|homedir\(\)|process\.env|process\.cwd/);
  });
});
