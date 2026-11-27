import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/** Environment variables that move a CLI's own configuration; tests point them at an empty directory. */
const CLI_HOME_VARIABLES = [
  "CODEX_HOME", "DSH_HOME", "COPILOT_HOME", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT",
] as const;

const FX_STUB = `#!/bin/sh
if [ "$1" = "--help" ]; then echo "Usage: fx ask | fx acp"; fi
exit 0
`;
const DEFAULT_STUB = "#!/bin/sh\nexit 0\n";

/**
 * Points every CLI home variable at `emptyHome` (and clears the inline OpenCode config), so the real user's CLI
 * configuration can never reach an assertion. Returns the function that restores the previous environment.
 */
export function isolateCliHomes(emptyHome: string): () => void {
  const saved = new Map<string, string | undefined>();
  for (const name of CLI_HOME_VARIABLES) {
    saved.set(name, process.env[name]);
    if (name === "OPENCODE_CONFIG_CONTENT" || name === "OPENCODE_CONFIG") delete process.env[name];
    else process.env[name] = emptyHome;
  }
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export interface StubCliEnvironment {
  /** Directory holding the stub executables (first on PATH while installed). */
  binDir: string;
  /** An empty directory every CLI home variable points at. */
  emptyHome: string;
  restore(): void;
}

/**
 * Makes adapter tests hermetic: executable stubs named `names` come first on PATH (an adapter now refuses a binary it
 * cannot resolve instead of spawning the raw name), and the CLI home variables point at an empty directory so the real
 * user's Codex / DSH / OpenCode / Copilot configuration can never reach an assertion.
 */
export function installStubClis(names: readonly string[], stubs: Record<string, string> = {}): StubCliEnvironment {
  // Canonical path: macOS reports /private/var for the /var temp symlink.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orch-stub-clis-")));
  const binDir = join(root, "bin");
  const emptyHome = join(root, "home");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(emptyHome, { recursive: true });
  for (const name of names) {
    const path = join(binDir, name);
    writeFileSync(path, stubs[name] ?? (name === "fx" ? FX_STUB : DEFAULT_STUB), { mode: 0o755 });
    chmodSync(path, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
  const restoreHomes = isolateCliHomes(emptyHome);
  return {
    binDir,
    emptyHome,
    restore() {
      restoreHomes();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
