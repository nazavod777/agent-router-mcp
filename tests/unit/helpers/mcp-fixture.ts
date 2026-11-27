import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInstallContext, type InstallContext } from "../../../src/cli/mcp-install.js";
import type { CliIo } from "../../../src/cli/table.js";

export const FAKE_NODE = "/opt/node/bin/node";
export const SKILL_BODY = "---\nname: orchestrate\n---\nskill v1\n";

export interface Fixture {
  root: string;
  home: string;
  entry: string;
  skillSource: string;
  ctx: InstallContext;
}

/** An isolated machine: temp home, a fake built entry point, and an injected context. Never touches the real home. */
export function makeFixture(overrides: Partial<InstallContext> = {}): Fixture {
  // Canonical path: macOS reports /private/var for the /var temp symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orch-mcp-install-")));
  const home = join(root, "home");
  mkdirSync(home);
  const entry = join(root, "repo", "dist", "cli", "main.js");
  write(entry, "// built entry\n");
  const skillSource = join(root, "SKILL.md");
  write(skillSource, SKILL_BODY);
  let tick = 0;
  const ctx = createInstallContext({
    homeDir: home, env: {}, platform: "linux", nodePath: FAKE_NODE, entryPath: entry, cwd: root,
    pathResolver: () => undefined, skillSourcePath: skillSource,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    ...overrides,
  });
  return { root, home, entry, skillSource, ctx };
}

export function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
}

export const read = (path: string): string => readFileSync(path, "utf8");

export function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}
