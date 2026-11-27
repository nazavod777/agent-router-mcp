import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = "orchestrator-mcp";

export function getDefaultCatalogPath(): string {
  return fileURLToPath(new URL("../../defaults/catalog.toml", import.meta.url));
}

/** The user config file path; `env` and `home` are injectable so callers that carry their own environment agree with it. */
export function getUserConfigPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return env.ORCH_MODELS_PATH || join(configHome, APP_DIR, "models.toml");
}

export function getStateDir(): string {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return process.env.ORCH_STATE_DIR || join(stateHome, APP_DIR);
}

export function getRunsDir(): string {
  return join(getStateDir(), "runs");
}

export function getWorktreesDir(): string {
  return join(getStateDir(), "worktrees");
}

export function getLocksDir(): string {
  return join(getStateDir(), "locks");
}
