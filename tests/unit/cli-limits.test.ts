import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as realSleep } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLI_CONCURRENCY_FALLBACK, type CliLimits, clearCliLimitsCache, discoverAllCliLimits, discoverCliLimits, emptyCliLimits, listCliConfigCandidates,
  stripJsoncComments,
} from "../../src/config/cli-limits.js";
import type { HarnessConfig } from "../../src/config/schema.js";
import { buildNativeSubagentsControl, resolveHarnessConcurrency } from "../../src/runtime/concurrency.js";

/** Paths whose `lstat` never settles, to simulate a stalled network mount. */
const stalled = vi.hoisted(() => ({ paths: new Set<string>(), calls: [] as string[], waiters: [] as Array<() => void> }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: ((path: string, ...rest: unknown[]) => {
      if (stalled.paths.has(String(path))) {
        stalled.calls.push(String(path));
        // Never settles unless a test releases it, and then it answers like the real file system.
        return new Promise((resolve, reject) => {
          stalled.waiters.push(() => (actual.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest).then(resolve, reject));
        });
      }
      return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.lstat,
  };
});

const policyDefaults = { max_concurrency: 8, default_harness_concurrency: 5, native_subagents: "cli_limit", native_subagent_depth: 2 } as const;

function harness(driver: HarnessConfig["driver"], extra: Partial<HarnessConfig> = {}): HarnessConfig {
  return { driver, display_name: driver, binary: driver, enabled: true, ...extra };
}

describe("stripJsoncComments", () => {
  it("removes comments and trailing commas but never touches string contents", () => {
    const raw = '\uFEFF{\n // line\n "url": "http://x/*not-a-comment*/", /* block */ "a": [1, 2,], "b": "tail,}",\n}\n';
    expect(JSON.parse(stripJsoncComments(raw))).toEqual({ url: "http://x/*not-a-comment*/", a: [1, 2], b: "tail,}" });
  });

  it("replaces a block comment with a space so it cannot glue two tokens together", () => {
    expect(stripJsoncComments("1/*c*/2")).toBe("1 2");
    // "12" would silently be a valid number; with the space it is the syntax error it really is.
    expect(() => JSON.parse(stripJsoncComments('{"a": 1/*c*/2}'))).toThrow();
    expect(JSON.parse(stripJsoncComments('{"a":/*c*/1,/* d */"b":[1,/* e */2/* f */,]}'))).toEqual({ a: 1, b: [1, 2] });
  });

  it("keeps escaped quotes inside strings and tolerates an unterminated block comment", () => {
    expect(JSON.parse(stripJsoncComments('{"q": "say \\"//hi\\""} /* open'))).toEqual({ q: 'say "//hi"' });
  });
});

describe("discoverCliLimits", () => {
  let root: string;
  let home: string;
  let project: string;

  beforeEach(async () => {
    clearCliLimitsCache();
    root = await mkdtemp(join(tmpdir(), "orch-cli-limits-"));
    home = join(root, "home");
    project = join(root, "project");
    await Promise.all([mkdir(home), mkdir(project)]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function put(path: string, content: string): Promise<string> {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  /** `systemRoot` keeps the real /etc (e.g. a machine-wide managed-settings.json) out of every test. */
  const options = () => ({ env: {}, home, cwd: project, platform: "linux" as const, cacheTtlMs: 0, systemRoot: join(root, "system") });

  it("falls back cleanly when nothing is configured", async () => {
    const limits = await discoverCliLimits("codex", harness("codex"), options());
    expect(limits).toMatchObject({ max_concurrent: 0, native_subagents: "unknown", source: "fallback", fallback_used: true, config_files: [] });
    expect(DEFAULT_CLI_CONCURRENCY_FALLBACK).toBe(5);
  });

  describe("codex", () => {
    it("reads agents limits and records which keys exist", async () => {
      await put(join(home, ".codex", "config.toml"), "[agents]\nmax_threads = 4\nmax_depth = 3\n");
      const limits = await discoverCliLimits("codex", harness("codex"), options());
      expect(limits).toMatchObject({ max_concurrent: 4, max_depth: 3, native_subagents: "enabled", source: "cli_config" });
      // Only keys the user really has are recorded: this config uses the legacy alias.
      expect(limits.discovered_keys).toEqual(["agents.max_depth", "agents.max_threads"]);
    });

    it("prefers an enabled multi_agent_v2 limit (minus the parent thread), with CRLF and a profile layer", async () => {
      await put(join(home, ".codex", "config.toml"),
        "[agents]\r\nmax_concurrent_threads_per_session = 9\r\n[features.multi_agent_v2]\r\nenabled = true\r\nmax_concurrent_threads_per_session = 4\r\n" +
        "[profiles.fast.agents]\r\nmax_depth = 1\r\n");
      const limits = await discoverCliLimits("codex", harness("codex", { profile: "fast" }), options());
      expect(limits).toMatchObject({ max_concurrent: 3, max_depth: 1 });
      const plain = await discoverCliLimits("codex", harness("codex"), options());
      expect(plain.max_depth).toBeUndefined();
    });

    it("never reports fewer than one child thread for v2 with a limit of one, and disables on multi_agent = false", async () => {
      await put(join(home, ".codex", "config.toml"), "[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 1\n");
      expect((await discoverCliLimits("codex", harness("codex"), options())).max_concurrent).toBe(1);
      await put(join(home, ".codex", "config.toml"), "[features]\nmulti_agent = false\n");
      expect(await discoverCliLimits("codex", harness("codex"), options())).toMatchObject({ native_subagents: "disabled_by_config" });
    });

    it("honours CODEX_HOME", async () => {
      await put(join(root, "codex-home", "config.toml"), "[agents]\nmax_threads = 2\n");
      const limits = await discoverCliLimits("codex", harness("codex"), { ...options(), env: { CODEX_HOME: join(root, "codex-home") } });
      expect(limits.max_concurrent).toBe(2);
    });
  });

  describe("claude", () => {
    it("layers process env, user, project and managed settings, with later layers winning", async () => {
      await put(join(home, ".claude", "settings.json"), '{ "env": { "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "2" }, "maxSubagentSpawnDepth": 1 }');
      await put(join(project, ".claude", "settings.local.json"), '{ // local\n "maxConcurrentSubagents": 6, }');
      const limits = await discoverCliLimits("claude", harness("claude"), {
        ...options(), env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "9", CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "3", UNRELATED_SECRET: "x" },
      });
      expect(limits).toMatchObject({ max_concurrent: 6, max_depth: 1, native_subagents: "enabled" });
      expect(limits.config_files).toEqual([join(home, ".claude", "settings.json"), join(project, ".claude", "settings.local.json")]);
      expect(JSON.stringify(limits)).not.toContain("UNRELATED_SECRET");
    });

    it("ignores out-of-range values with a warning that names only the key", async () => {
      await put(join(home, ".claude", "settings.json"), '{ "maxConcurrentSubagents": 999, "maxSubagentSpawnDepth": "SECRET-VALUE" }');
      const limits = await discoverCliLimits("claude", harness("claude"), options());
      expect(limits.max_concurrent).toBe(0);
      expect(limits.warnings).toEqual([
        "Ignored maxConcurrentSubagents: expected an integer from 0 to 64.",
        "Ignored maxSubagentSpawnDepth: expected an integer from 0 to 64.",
      ]);
      expect(JSON.stringify(limits)).not.toContain("SECRET-VALUE");
    });

    it("reports only the path of an unparseable file, never parser text", async () => {
      const file = await put(join(home, ".claude", "settings.json"), '{ "token": "sk-leak-me" ');
      const limits = await discoverCliLimits("claude", harness("claude"), options());
      expect(limits.warnings).toEqual([`Could not parse ${file}.`]);
    });

    it("never opens symlinks, directories or oversized files", async () => {
      const real = await put(join(root, "real.json"), '{ "maxConcurrentSubagents": 7 }');
      await mkdir(join(home, ".claude"), { recursive: true });
      await symlink(real, join(home, ".claude", "settings.json"));
      await mkdir(join(project, ".claude", "settings.json"), { recursive: true });
      await put(join(project, ".claude", "settings.local.json"), `{ "pad": "${"x".repeat(1024 * 1024)}" }`);
      const limits = await discoverCliLimits("claude", harness("claude"), options());
      expect(limits.max_concurrent).toBe(0);
      expect(limits.config_files).toEqual([]);
      expect(limits.warnings).toHaveLength(3);
    });

    it("reads managed settings only from the injected system root and lets them win over every other layer", async () => {
      await put(join(home, ".claude", "settings.json"), '{ "maxConcurrentSubagents": 2 }');
      const managed = await put(join(root, "system", "etc", "claude-code", "managed-settings.json"), '{ "maxConcurrentSubagents": 5 }');
      const limits = await discoverCliLimits("claude", harness("claude"), options());
      expect(limits.max_concurrent).toBe(5);
      expect(limits.config_files).toEqual([join(home, ".claude", "settings.json"), managed]);
      expect(listCliConfigCandidates("claude", {}, options()).at(-1)?.path).toBe(managed);
      expect(listCliConfigCandidates("gemini", {}, options()).at(-1)?.path).toBe(join(root, "system", "etc", "gemini-cli", "settings.json"));
    });

    it("does not read the machine's real managed settings when a system root is injected", async () => {
      const limits = await discoverCliLimits("claude", harness("claude"), options());
      expect(limits.config_files.every((file) => file.startsWith(root))).toBe(true);
      expect(limits.warnings).toEqual([]);
    });

    const DENIED_FILE_NAMES = [
      "auth.json", "credentials.json", ".credentials.json", ".env", ".env.local", "key.pem", "private.key", "claude.json",
      "my-credentials.json", "id_ed25519", ".netrc", "api-token.json", "secrets.json", "hosts.yml",
    ];
    it.each(DENIED_FILE_NAMES)("never opens the credential-like file %s, even when OPENCODE_CONFIG points at it", async (name) => {
      const denied = await put(join(root, "denied", name), '{ "subagents": { "maxConcurrent": 7 } }');
      const found = await discoverCliLimits("opencode", harness("opencode"), { ...options(), env: { OPENCODE_CONFIG: denied } });
      expect(found.max_concurrent).toBe(0);
      expect(found.config_files).toEqual([]);
      expect(found.warnings).toEqual([`Skipped ${denied}: file name is denied.`]);
    });
  });

  describe("opencode", () => {
    it("merges user, OPENCODE_CONFIG and project files and preserves an explicit zero", async () => {
      await put(join(home, ".config", "opencode", "opencode.jsonc"), '{ "subagent_depth": 2, "subagents": { "maxConcurrent": 4 } }');
      await put(join(project, "opencode.json"), '{ "experimental": { "subagent_depth": 1 } }');
      expect(await discoverCliLimits("opencode", harness("opencode"), options())).toMatchObject({ max_concurrent: 4, max_depth: 1 });
      await put(join(project, "opencode.json"), '{ "experimental": { "subagent_depth": 0 } }');
      const off = await discoverCliLimits("opencode", harness("opencode"), options());
      expect(off).toMatchObject({ max_depth: 0, native_subagents: "disabled_by_config" });
    });
  });

  describe("dsh", () => {
    it("reads the profile and the patch file, for the harness profile name", async () => {
      await put(join(home, ".dsh", "profiles", "work.yml"), "- id: subagent\n  config:\n    maxActiveSubagents: 3\n    maxDepth: 2\n");
      await put(join(home, ".dsh", "cordis.patch.yml"), "- id: tool-subagent\n  config:\n    maxConcurrentAgents: 2\n- id: other\n  config:\n    maxDepth: 9\n");
      const limits = await discoverCliLimits("dsh", harness("dsh", { profile: "work" }), options());
      expect(limits).toMatchObject({ max_concurrent: 2, max_depth: 2, native_subagents: "enabled" });
    });

    it("records the depth per subagent plugin, the later entry of a plugin id replacing the earlier one", async () => {
      await put(join(home, ".dsh", "profiles", "headless.yml"),
        "- id: subagent\n  config:\n    maxDepth: 1\n- id: subagent-spawn-in-process\n  config:\n    maxDepth: 3\n");
      await put(join(home, ".dsh", "cordis.patch.yml"), "- id: subagent-spawn-in-process\n  config:\n    maxDepth: 2\n- id: other\n  config:\n    maxDepth: 9\n");
      const limits = await discoverCliLimits("dsh", harness("dsh"), options());
      expect(limits.max_depth_by_plugin).toEqual({ subagent: 1, "subagent-spawn-in-process": 2 });
      expect(limits.max_depth).toBe(2);
      expect(buildNativeSubagentsControl(
        resolveHarnessConcurrency({ harnessId: "dsh", harness: harness("dsh"), defaults: policyDefaults, cliLimits: limits }), limits, "cli_limit",
      )).toMatchObject({ discoveredPluginDepths: { subagent: 1, "subagent-spawn-in-process": 2 } });
    });

    it("derives the same depth whatever the order of the plugin entries", async () => {
      const entries = ["- id: subagent\n  config:\n    maxDepth: 3\n", "- id: tool-subagent\n  config:\n    maxDepth: 1\n"];
      await put(join(home, ".dsh", "profiles", "headless.yml"), entries.join(""));
      const forward = await discoverCliLimits("dsh", harness("dsh"), options());
      await put(join(home, ".dsh", "profiles", "headless.yml"), [...entries].reverse().join(""));
      const reversed = await discoverCliLimits("dsh", harness("dsh"), options());
      expect(forward.max_depth).toBe(3);
      expect(reversed.max_depth).toBe(3);
      expect(reversed.max_depth_by_plugin).toEqual(forward.max_depth_by_plugin);
    });

    it("reports no per-plugin depth when no plugin states one", async () => {
      await put(join(home, ".dsh", "cordis.patch.yml"), "- id: tool-subagent\n");
      const limits = await discoverCliLimits("dsh", harness("dsh"), options());
      expect(limits).not.toHaveProperty("max_depth_by_plugin");
      expect(buildNativeSubagentsControl(
        resolveHarnessConcurrency({ harnessId: "dsh", harness: harness("dsh"), defaults: policyDefaults, cliLimits: limits }), limits, "cli_limit",
      )).not.toHaveProperty("discoveredPluginDepths");
    });

    it("marks a bare tool-subagent entry as enabled unless it or another entry disables it", async () => {
      await put(join(home, ".dsh", "cordis.patch.yml"), "- id: tool-subagent\n");
      expect(await discoverCliLimits("dsh", harness("dsh"), options())).toMatchObject({ native_subagents: "enabled" });
      clearCliLimitsCache();
      await put(join(home, ".dsh", "cordis.patch.yml"), "- id: tool-subagent\n  disabled: true\n");
      expect(await discoverCliLimits("dsh", harness("dsh"), options())).toMatchObject({ native_subagents: "disabled_by_config" });
      clearCliLimitsCache();
      await put(join(home, ".dsh", "cordis.patch.yml"), "- id: subagent\n  disabled: true\n- id: tool-subagent\n  disabled: false\n");
      expect(await discoverCliLimits("dsh", harness("dsh"), options())).toMatchObject({ native_subagents: "disabled_by_config" });
      clearCliLimitsCache();
      await put(join(home, ".dsh", "cordis.patch.yml"), "- id: tool-subagent\n  config:\n    maxDepth: 0\n");
      expect(await discoverCliLimits("dsh", harness("dsh"), options())).toMatchObject({ native_subagents: "disabled_by_config" });
    });

    it.each(["../../evil", "CON", "nul.txt", "a/b", ".hidden"])("rejects unsafe profile name %j", async (profile) => {
      const limits = await discoverCliLimits("dsh", harness("dsh", { profile }), options());
      expect(limits.warnings).toHaveLength(1);
    });

    it("rejects profile names that could escape the profiles directory", async () => {
      await put(join(home, "evil.yml"), "- id: subagent\n  config:\n    maxActiveSubagents: 3\n");
      const limits = await discoverCliLimits("dsh", harness("dsh", { profile: "../../evil" }), options());
      expect(limits.max_concurrent).toBe(0);
      expect(limits.warnings).toHaveLength(1);
    });

    it("rejects more aliases than the limit even when the default parser limit would allow them", async () => {
      await put(join(home, ".dsh", "cordis.patch.yml"), `a: &a [x, y]\nb: [${Array(60).fill("*a").join(", ")}]\n`);
      const limits = await discoverCliLimits("dsh", harness("dsh"), options());
      expect(limits.warnings).toEqual([`Could not parse ${join(home, ".dsh", "cordis.patch.yml")}.`]);
    });

    it("never writes to stderr or emits a process warning for malformed, warning-only or alias-bomb YAML", async () => {
      const emitWarning = vi.spyOn(process, "emitWarning");
      const stderrWrite = vi.spyOn(process.stderr, "write");
      const consoleWarn = vi.spyOn(console, "warn");
      const file = join(home, ".dsh", "cordis.patch.yml");
      const bomb = ["a: &a [x, x, x, x, x, x, x, x, x]", ...["b", "c", "d", "e", "f"].map((name, index) =>
        `${name}: &${name} [${Array(9).fill(`*${["a", "b", "c", "d", "e"][index]}`).join(", ")}]`)].join("\n");
      try {
        const documents = [
          "- id: subagent\n  config: [unterminated\n  token: sk-leak-me-0123456789\n", // parse error
          "- id: subagent\n  config:\n    maxActiveSubagents: !!unknowntag 3\n", // parser warning only
          bomb,
        ];
        for (const document of documents) {
          clearCliLimitsCache();
          await put(file, document);
          const limits = await discoverCliLimits("dsh", harness("dsh"), options());
          expect(JSON.stringify(limits)).not.toContain("sk-leak-me");
        }
        expect(emitWarning).not.toHaveBeenCalled();
        expect(stderrWrite).not.toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();
      } finally {
        emitWarning.mockRestore();
        stderrWrite.mockRestore();
        consoleWarn.mockRestore();
      }
    });

    it("rejects a document with parse errors but still reads one that only has parser warnings", async () => {
      const file = join(home, ".dsh", "cordis.patch.yml");
      await put(file, "- id: subagent\n  config: [unterminated\n    maxActiveSubagents: 3\n");
      expect(await discoverCliLimits("dsh", harness("dsh"), options())).toMatchObject({ max_concurrent: 0, config_files: [] });
      await put(file, "- id: subagent\n  config:\n    maxActiveSubagents: 3\n    note: !!unknowntag x\n");
      expect(await discoverCliLimits("dsh", harness("dsh"), options())).toMatchObject({ max_concurrent: 3, config_files: [file] });
    });

    it("survives a YAML alias bomb", async () => {
      const lines = ["a: &a [x, x, x, x, x, x, x, x, x]"];
      for (const [index, name] of ["b", "c", "d", "e", "f", "g", "h", "i"].entries()) {
        const previous = index === 0 ? "a" : ["b", "c", "d", "e", "f", "g", "h", "i"][index - 1];
        lines.push(`${name}: &${name} [${Array(9).fill(`*${previous}`).join(", ")}]`);
      }
      await put(join(home, ".dsh", "cordis.patch.yml"), lines.join("\n"));
      const limits = await discoverCliLimits("dsh", harness("dsh"), options());
      expect(limits.max_concurrent).toBe(0);
      expect(limits.warnings).toEqual([`Could not parse ${join(home, ".dsh", "cordis.patch.yml")}.`]);
    });
  });

  describe("gemini, pi and others", () => {
    it("reads gemini user and project settings", async () => {
      await put(join(home, ".gemini", "settings.json"), '{ "agents": { "maxConcurrency": 3 } }');
      await put(join(project, ".gemini", "settings.json"), '{ "experimental": { "enableAgents": false } }');
      expect(await discoverCliLimits("gemini", harness("gemini"), options())).toMatchObject({ max_concurrent: 3, native_subagents: "disabled_by_config" });
    });

    it("marks pi subagents as disabled by the invocation even when its config allows them", async () => {
      await put(join(home, ".pi", "agent", "settings.json"), '{ "subagents": { "maxConcurrent": 2 } }');
      expect(await discoverCliLimits("pi", harness("pi"), options())).toMatchObject({ max_concurrent: 2, native_subagents: "disabled_by_invocation" });
    });

    it.each([["droid", ".factory/settings.json", '{ "subagents": { "maxConcurrent": 2 } }'], ["kimi", ".kimi/config.toml", "[subagents]\nmaxConcurrent = 2\n"]] as const)(
      "reads %s from its standard config location", async (driver, file, content) => {
        await put(join(home, file), content);
        expect((await discoverCliLimits(driver, harness(driver), options())).max_concurrent).toBe(2);
      });

    it("returns an unknown fallback for drivers without a known config", async () => {
      expect(await discoverCliLimits("cursor", harness("cursor"), options())).toMatchObject({ native_subagents: "unknown", fallback_used: true });
    });
  });

  it("caps the number of warnings it returns", async () => {
    const entries = Array.from({ length: 100 }, () => "- id: subagent\n  config:\n    maxDepth: 999\n").join("");
    await put(join(home, ".dsh", "cordis.patch.yml"), entries);
    const limits = await discoverCliLimits("dsh", harness("dsh"), options());
    expect(limits.warnings).toHaveLength(21);
    expect(limits.warnings.at(-1)).toBe("80 more warnings omitted.");
  });

  it("builds deterministic candidate lists for Windows drive and UNC paths on any OS", () => {
    const win = { platform: "win32" as const, home: "C:\\Users\\me", env: { ProgramData: "D:\\PD", APPDATA: "C:\\Users\\me\\AppData\\Roaming" } };
    const claude = listCliConfigCandidates("claude", {}, { ...win, cwd: "\\\\srv\\share\\proj" }).map((entry) => entry.path);
    expect(claude).toEqual([
      "C:\\Users\\me\\.claude\\settings.json", "C:\\Users\\me\\.claude\\settings.local.json",
      "\\\\srv\\share\\proj\\.claude\\settings.json", "\\\\srv\\share\\proj\\.claude\\settings.local.json",
      "D:\\PD\\ClaudeCode\\managed-settings.json", "C:\\Program Files\\ClaudeCode\\managed-settings.json",
    ]);
    const withProgramFiles = listCliConfigCandidates("claude", {}, { ...win, env: { ...win.env, ProgramFiles: "D:\\PF" }, cwd: "E:\\work" })
      .map((entry) => entry.path);
    expect(withProgramFiles.slice(-2)).toEqual(["D:\\PD\\ClaudeCode\\managed-settings.json", "D:\\PF\\ClaudeCode\\managed-settings.json"]);
    const opencode = listCliConfigCandidates("opencode", {}, { ...win, cwd: "E:\\work" }).map((entry) => entry.path);
    expect(opencode[0]).toBe("C:\\Users\\me\\AppData\\Roaming\\opencode\\opencode.json");
    expect(opencode.at(-1)).toBe("E:\\work\\opencode.jsonc");
    expect(listCliConfigCandidates("gemini", {}, { ...win, cwd: "E:\\work" }).map((entry) => entry.path)).toEqual([
      "C:\\Users\\me\\.gemini\\settings.json", "E:\\work\\.gemini\\settings.json", "D:\\PD\\gemini-cli\\settings.json",
    ]);
    expect(listCliConfigCandidates("gemini", {}, { platform: "linux", home: "/home/me", cwd: "/p", env: {} }).at(-1)?.path)
      .toBe("/etc/gemini-cli/settings.json");
    expect(listCliConfigCandidates("claude", {}, { platform: "darwin", home: "/Users/me", cwd: "/p", env: {} }).at(-1)?.path)
      .toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
    expect(listCliConfigCandidates("claude", {}, { platform: "linux", home: "/home/me", cwd: "/p", env: {} }).at(-1)?.path)
      .toBe("/etc/claude-code/managed-settings.json");
  });

  describe("relative environment paths", () => {
    const posixCwd = "/work/proj";
    const winCwd = "E:\\work\\proj";
    const paths = (driver: HarnessConfig["driver"], env: Record<string, string>, platform: "linux" | "win32", cwd: string) =>
      listCliConfigCandidates(driver, {}, { env, platform, cwd, home: platform === "win32" ? "C:\\Users\\me" : "/home/me" }).map((entry) => entry.path);

    it.each([
      ["codex", "CODEX_HOME", "rel/codex", "/work/proj/rel/codex/config.toml"],
      ["claude", "CLAUDE_CONFIG_DIR", "../claude-cfg", "/work/claude-cfg/settings.json"],
      ["opencode", "OPENCODE_CONFIG_DIR", "oc", "/work/proj/oc/opencode.json"],
      ["opencode", "OPENCODE_CONFIG", "conf/custom.json", "/work/proj/conf/custom.json"],
      ["dsh", "DSH_HOME", ".dsh-local", "/work/proj/.dsh-local/profiles/headless.yml"],
      ["gemini", "GEMINI_CLI_HOME", "gem", "/work/proj/gem/.gemini/settings.json"],
      ["pi", "PI_CODING_AGENT_DIR", "pi-agent", "/work/proj/pi-agent/settings.json"],
    ] as const)("resolves a relative %s %s against the working directory on posix", (driver, name, value, expected) => {
      expect(paths(driver, { [name]: value }, "linux", posixCwd)).toContain(expected);
      expect(paths(driver, { [name]: "/abs/dir" }, "linux", posixCwd).join("\n")).not.toContain(posixCwd + "/abs");
    });

    it.each([
      ["codex", "CODEX_HOME", "rel\\codex", "E:\\work\\proj\\rel\\codex\\config.toml"],
      ["claude", "CLAUDE_CONFIG_DIR", "..\\cfg", "E:\\work\\cfg\\settings.json"],
      ["opencode", "OPENCODE_CONFIG", "conf\\custom.json", "E:\\work\\proj\\conf\\custom.json"],
      ["dsh", "DSH_HOME", "dsh", "E:\\work\\proj\\dsh\\profiles\\headless.yml"],
      ["pi", "PI_CODING_AGENT_DIR", "pi", "E:\\work\\proj\\pi\\settings.json"],
    ] as const)("resolves a relative %s %s against the working directory with Windows separators", (driver, name, value, expected) => {
      expect(paths(driver, { [name]: value }, "win32", winCwd)).toContain(expected);
      expect(paths(driver, { [name]: "D:\\abs" }, "win32", winCwd).join("\n")).toContain("D:\\abs");
    });
  });

  it("ignores the tool-use concurrency variable because it counts tool calls, not subagents", async () => {
    await put(join(home, ".claude", "settings.json"), '{ "env": { "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY": "7" } }');
    const limits = await discoverCliLimits("claude", harness("claude"), { ...options(), env: { CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: "9" } });
    expect(limits).toMatchObject({ max_concurrent: 0, source: "fallback", native_subagents: "unknown", discovered_keys: [], warnings: [] });
  });

  describe("discovery deadline", () => {
    const codexFile = () => join(home, ".codex", "config.toml");

    beforeEach(() => {
      stalled.paths.clear();
      stalled.calls.length = 0;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    });

    afterEach(() => {
      vi.useRealTimers();
      stalled.paths.clear();
      stalled.waiters.length = 0;
    });

    /** Real file system answers arrive on the real event loop; the timers of `node:timers/promises` are not faked. */
    const settleRealIo = () => realSleep(100);

    it("lets concurrent callers share one discovery instead of probing the stalled mount once each", async () => {
      await put(codexFile(), "[agents]\nmax_threads = 4\n");
      stalled.paths.add(codexFile());
      const callers = Array.from({ length: 6 }, () => discoverCliLimits("codex", harness("codex"), options()));
      await vi.advanceTimersByTimeAsync(3_000);
      const results = await Promise.all(callers);
      expect(results.every((limits) => limits.fallback_used)).toBe(true);
      expect(stalled.calls).toHaveLength(1);
      // Each caller got its own copy.
      results[0].warnings.push("changed");
      expect(results[1].warnings).not.toContain("changed");
    });

    it("lets concurrent callers of a healthy file share one result", async () => {
      await put(codexFile(), "[agents]\nmax_threads = 4\n");
      const results = await Promise.all(Array.from({ length: 6 }, () => discoverCliLimits("codex", harness("codex"), options())));
      expect(results.map((limits) => limits.max_concurrent)).toEqual([4, 4, 4, 4, 4, 4]);
    });

    it("never lets an older timed-out discovery overwrite the result of a newer forced refresh", async () => {
      const cached = { ...options(), cacheTtlMs: 60_000 };
      const when = new Date("2026-01-01T00:00:00Z");
      await put(codexFile(), "[agents]\nmax_threads = 4\n");
      await utimes(codexFile(), when, when);
      stalled.paths.add(codexFile());
      const older = discoverCliLimits("codex", harness("codex"), { ...cached, refresh: true }); // A forced probe: it reads the files itself.
      await vi.advanceTimersByTimeAsync(3_000);
      await older; // Timed out for its caller, but its probe is still waiting on the mount.

      // The mount answers again; a forced refresh sees the new value (same file size and mtime stamp, on purpose).
      stalled.paths.clear();
      await put(codexFile(), "[agents]\nmax_threads = 7\n");
      await utimes(codexFile(), when, when);
      const refreshed = await discoverCliLimits("codex", harness("codex"), { ...cached, refresh: true });
      expect(refreshed.max_concurrent).toBe(7);

      // The file goes back to the old content with an identical stamp, then the old probe finally resumes and reads it.
      await put(codexFile(), "[agents]\nmax_threads = 4\n");
      await utimes(codexFile(), when, when);
      stalled.waiters.splice(0).forEach((resume) => resume());
      await settleRealIo();

      expect((await discoverCliLimits("codex", harness("codex"), cached)).max_concurrent).toBe(7);
    });

    it("covers the file stat calls with the 3 s deadline and reuses the fallback for 15 s", async () => {
      await put(codexFile(), "[agents]\nmax_threads = 4\n");
      stalled.paths.add(codexFile());
      const first = discoverCliLimits("codex", harness("codex"), options());
      await vi.advanceTimersByTimeAsync(2_999);
      let settled = false;
      void first.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await first).toMatchObject({
        max_concurrent: 0, fallback_used: true, warnings: ["Could not discover CLI limits for codex."],
      });
      expect(stalled.calls).toHaveLength(1);

      // Within the TTL the stalled mount is not touched again and the answer is immediate (no timer advance needed).
      await vi.advanceTimersByTimeAsync(14_000);
      expect(await discoverCliLimits("codex", harness("codex"), options())).toMatchObject({ fallback_used: true });
      expect(stalled.calls).toHaveLength(1);

      // Another harness context is not affected by the cached fallback.
      expect(await discoverCliLimits("claude", harness("claude"), options())).toMatchObject({ fallback_used: true, warnings: [] });

      // After the TTL the mount is probed again, still under the deadline.
      await vi.advanceTimersByTimeAsync(1_001);
      const again = discoverCliLimits("codex", harness("codex"), options());
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await again).toMatchObject({ fallback_used: true });
      expect(stalled.calls).toHaveLength(2);
    });

    it("lets refresh bypass the cached timeout fallback and recovers once the mount answers", async () => {
      await put(codexFile(), "[agents]\nmax_threads = 4\n");
      stalled.paths.add(codexFile());
      const first = discoverCliLimits("codex", harness("codex"), options());
      await vi.advanceTimersByTimeAsync(3_000);
      await first;
      stalled.paths.clear();
      expect(await discoverCliLimits("codex", harness("codex"), options())).toMatchObject({ max_concurrent: 0 });
      expect(await discoverCliLimits("codex", harness("codex"), { ...options(), refresh: true })).toMatchObject({ max_concurrent: 4 });
      // The successful refresh retires the fallback, so the next plain call (still inside the 15 s window) sees the real limits.
      expect(await discoverCliLimits("codex", harness("codex"), options())).toMatchObject({ max_concurrent: 4, fallback_used: false });
    });
  });

  describe("cache", () => {
    it("serves cached results until the file changes, the TTL expires or refresh is requested", async () => {
      const file = await put(join(home, ".codex", "config.toml"), "[agents]\nmax_threads = 2\n");
      const cached = { ...options(), cacheTtlMs: 60_000 };
      expect((await discoverCliLimits("codex", harness("codex"), cached)).max_concurrent).toBe(2);
      // Same size and a restored mtime would hide a change, so change the size.
      await writeFile(file, "[agents]\nmax_threads = 12\n");
      expect((await discoverCliLimits("codex", harness("codex"), cached)).max_concurrent).toBe(12);
      await writeFile(file, "[agents]\nmax_threads = 3\n");
      expect((await discoverCliLimits("codex", harness("codex"), { ...cached, refresh: true })).max_concurrent).toBe(3);
    });

    it("returns copies, so callers cannot corrupt the cache", async () => {
      await put(join(home, ".codex", "config.toml"), "[agents]\nmax_threads = 2\n");
      const cached = { ...options(), cacheTtlMs: 60_000 };
      (await discoverCliLimits("codex", harness("codex"), cached)).discovered_keys.push("junk");
      expect((await discoverCliLimits("codex", harness("codex"), cached)).discovered_keys).not.toContain("junk");
    });
  });

  it("discovers every harness and resolves the effective cap against the global cap and overrides", async () => {
    await put(join(home, ".codex", "config.toml"), "[agents]\nmax_threads = 20\n");
    const harnesses = { codex: harness("codex"), claude: harness("claude", { max_concurrency: 2 }), cursor: harness("cursor") };
    const all = await discoverAllCliLimits({ harnesses }, options());
    const defaults = { max_concurrency: 8, default_harness_concurrency: 5, native_subagents: "cli_limit", native_subagent_depth: 2 } as const;
    const resolve = (id: keyof typeof harnesses) =>
      resolveHarnessConcurrency({ harnessId: id, harness: harnesses[id], defaults, cliLimits: all[id] });
    expect(resolve("codex")).toMatchObject({ effective_cap: 8, global_cap: 8, discovered_limit: 20, limit_source: "cli_config", fallback_used: false });
    expect(resolve("claude")).toMatchObject({ effective_cap: 2, limit_source: "harness_override" });
    expect(resolve("cursor")).toMatchObject({ effective_cap: 5, limit_source: "fallback", fallback_used: true, native_max_depth: 1 });
    expect(resolveHarnessConcurrency({ harnessId: "codex", harness: harnesses.codex, defaults: { ...defaults, native_subagents: "off" }, cliLimits: all.codex }))
      .toMatchObject({ native_subagents: "disabled_by_policy", native_max_depth: 0 });
    for (const native_subagents of ["disabled_by_invocation", "disabled_by_config"] as const) {
      const disabled = { ...emptyCliLimits("pi"), native_subagents };
      expect(resolveHarnessConcurrency({ harnessId: "pi", harness: harness("pi"), defaults, cliLimits: disabled }))
        .toMatchObject({ native_subagents, native_max_depth: 0 });
    }
  });
  describe("native_subagents = off", () => {
    const off = { ...policyDefaults, native_subagents: "off" } as const;
    const resolveOff = (driver: HarnessConfig["driver"], native: CliLimits["native_subagents"] = "unknown") =>
      resolveHarnessConcurrency({ harnessId: driver, harness: harness(driver), defaults: off, cliLimits: { ...emptyCliLimits(driver), native_subagents: native } });

    it.each(["claude", "codex", "opencode", "dsh"] as const)("reports %s as disabled_by_policy because its adapter enforces the policy", (driver) => {
      expect(resolveOff(driver)).toMatchObject({ native_subagents: "disabled_by_policy", native_max_depth: 0 });
      expect(resolveOff(driver).warnings).toBeUndefined();
    });

    it.each(["gemini", "qwen", "cursor", "grok", "kiro", "droid"] as const)(
      "keeps the discovered state for %s, which has no per-run flag, and says so", (driver) => {
        const info = resolveOff(driver);
        expect(info.native_subagents).toBe("unknown");
        expect(info.native_max_depth).toBe(1);
        expect(info.warnings).toEqual([expect.stringContaining(`not enforced for ${driver}`)]);
      });

    it("keeps pi disabled_by_invocation without a warning", () => {
      const info = resolveOff("pi", "disabled_by_invocation");
      expect(info).toMatchObject({ native_subagents: "disabled_by_invocation", native_max_depth: 0 });
      expect(info.warnings).toBeUndefined();
    });

    it("adds nothing under the cli_limit policy", () => {
      const info = resolveHarnessConcurrency({ harnessId: "gemini", harness: harness("gemini"), defaults: policyDefaults, cliLimits: emptyCliLimits("gemini") });
      expect(info.warnings).toBeUndefined();
    });
  });
});
