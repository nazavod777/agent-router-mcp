import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { getEnvValue, isInsidePath } from "../runtime/guard.js";
import { isObject } from "./probe-utils.js";

/**
 * `claude --restricted` ignores the user's `settings.json`, including its `env` block, so a login that lives only there
 * (an API key, a proxy endpoint, a Bedrock/Vertex/Foundry switch) would be missing from a readonly run. This module
 * forwards a STRICT allowlist of those auth and endpoint variables, read from the user-level file only.
 */

const SETTINGS_FILE_NAME = "settings.json";
const CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const MAX_SETTINGS_BYTES = 262_144;
const MAX_FORWARDED_VALUE_CHARS = 8192;
const MAX_GIT_ROOT_WALK_DEPTH = 64;
const SECRET_NAME = /KEY|TOKEN|SECRET/i;
const MIN_SECRET_LENGTH = 8;

const ALLOWED_EXACT_NAMES: readonly string[] = [
  // Anthropic
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  // Bedrock
  "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "AWS_REGION", "AWS_DEFAULT_REGION",
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  // Vertex
  "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL", "CLOUD_ML_REGION", "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  // Foundry
  "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
];
const ALLOWED_PATTERNS: readonly RegExp[] = [/^VERTEX_REGION_CLAUDE_[A-Z0-9_]+$/];
const ALLOWED_NAME_SET: ReadonlySet<string> = new Set(ALLOWED_EXACT_NAMES);

/** Endpoint variables: a forwarded URL must be a plain http(s) address without credentials, query or fragment. */
const BASE_URL_NAMES: ReadonlySet<string> = new Set([
  "ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL",
]);

/** A non-empty value for any of these in the child environment means the caller already chose a login: import nothing. */
const PRIMARY_SELECTORS: readonly string[] = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_RESOURCE",
];

export interface ClaudeForwardedEnvOptions {
  /** Platform whose rules apply (Windows environment names are case-insensitive); defaults to the running one. */
  platform?: NodeJS.Platform;
  /** Home directory that holds `.claude` when `CLAUDE_CONFIG_DIR` is unset; defaults to the OS home directory. */
  homeDir?: string;
  /**
   * Further directories whose repository must also be kept out: the source checkout of a job that runs in a git worktree,
   * where `cwd` is the worktree and the checkout it was created from is somewhere else.
   */
  extraRepoRoots?: readonly string[];
}

export interface ClaudeForwardedEnv {
  /** Variables to add to the child environment (never one the environment already holds). */
  env: Record<string, string>;
  /** Names of the forwarded variables, sorted; safe to display (no values). */
  names: string[];
  /** Values of the forwarded variables that look like credentials, for redaction. */
  secrets: string[];
  /** Non-fatal problems; they never contain a value from the file. */
  warnings: string[];
}

const NOTHING_FORWARDED = (warnings: string[] = []): ClaudeForwardedEnv => ({ env: {}, names: [], secrets: [], warnings });

function canonicalName(key: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? key.toUpperCase() : key;
}

function isAllowedName(name: string): boolean {
  return ALLOWED_NAME_SET.has(name) || ALLOWED_PATTERNS.some((pattern) => pattern.test(name));
}

function hasValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): boolean {
  const value = getEnvValue(env, name, platform);
  return value !== undefined && value !== "";
}

function isPlainHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

/** The walk ran out of levels before reaching the file system root: the repository boundary is unknown. */
const GIT_ROOT_SEARCH_EXHAUSTED = Symbol("git-root-search-exhausted");

/** The nearest directory at or above `start` that holds a `.git` entry, found without starting Git. */
async function findGitRoot(start: string): Promise<string | typeof GIT_ROOT_SEARCH_EXHAUSTED | undefined> {
  let current = start;
  for (let depth = 0; depth < MAX_GIT_ROOT_WALK_DEPTH; depth += 1) {
    try {
      await lstat(join(current, ".git"));
      return current;
    } catch {
      // Not here; look one level up.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return GIT_ROOT_SEARCH_EXHAUSTED;
}

async function canonicalOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

const GITDIR_POINTER = /^gitdir:\s*(.+?)\s*$/m;
const MAX_POINTER_BYTES = 4096;
/** Pointer files (`.git`, `commondir`) are a line or two; a larger or non-regular file is never read. */
const MAX_POINTER_FILE_BYTES = 16_384;

/** Reads a small text file; undefined when it is missing, unreadable or large. */
async function readSmallText(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_POINTER_FILE_BYTES) return undefined;
    const text = await readFile(path, "utf8");
    return text.length <= MAX_POINTER_BYTES ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a linked worktree really lives. In a worktree `.git` is a file (`gitdir: <repo>/.git/worktrees/<name>`), and that
 * directory's `commondir` leads back to the main repository, so both the git directory and the main checkout count as
 * "the repository" for this job.
 */
async function linkedWorktreeRoots(gitRoot: string): Promise<string[]> {
  const pointer = await readSmallText(join(gitRoot, ".git"));
  const target = pointer === undefined ? undefined : GITDIR_POINTER.exec(pointer)?.[1];
  if (target === undefined) return [];
  const gitDir = await canonicalOrResolved(isAbsolute(target) || win32.isAbsolute(target) ? target : resolve(gitRoot, target));
  const roots = [gitDir];
  const common = (await readSmallText(join(gitDir, "commondir")))?.trim();
  if (common) {
    const commonDir = await canonicalOrResolved(isAbsolute(common) || win32.isAbsolute(common) ? common : resolve(gitDir, common));
    roots.push(commonDir);
    // The main checkout is the directory that holds the common `.git`.
    if (basenameOf(commonDir).toLowerCase() === ".git") roots.push(dirname(commonDir));
  }
  return roots;
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** True when `dir` is `root` or lies inside it; Windows paths compare case-insensitively. */
function isUnder(root: string, dir: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? isInsidePath(root.toLowerCase(), dir.toLowerCase()) : isInsidePath(root, dir);
}

/** True when the directory lies inside the job's working directory, a given source checkout, or the repository around either. */
async function isInsideJobRepository(realDir: string, cwd: string, extraRoots: readonly string[], platform: NodeJS.Platform): Promise<boolean> {
  for (const start of [cwd, ...extraRoots]) {
    const realStart = await canonicalOrResolved(start);
    if (isUnder(realStart, realDir, platform)) return true;
    const gitRoot = await findGitRoot(realStart);
    // Fail closed: a path too deep to search is treated as inside the repository, never as a way around the boundary.
    if (gitRoot === GIT_ROOT_SEARCH_EXHAUSTED) return true;
    if (gitRoot === undefined) continue;
    const roots = [await canonicalOrResolved(gitRoot), ...await linkedWorktreeRoots(gitRoot)];
    if (roots.some((root) => isUnder(root, realDir, platform))) return true;
  }
  return false;
}

/** Reads the file with every check a hostile path could trip: regular file only, no symlink, bounded size. */
async function readBoundedSettings(path: string, platform: NodeJS.Platform): Promise<{ text?: string; warning?: string }> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { warning: "Claude settings.json could not be inspected; its auth settings were not forwarded." };
  }
  if (!before.isFile()) return { warning: "Claude settings.json is not a regular file (or is a symbolic link); it was ignored." };
  if (before.size > MAX_SETTINGS_BYTES) return { warning: `Claude settings.json is larger than ${MAX_SETTINGS_BYTES} bytes; it was ignored.` };
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (platform !== "win32" ? constants.O_NOFOLLOW : 0);
  let handle;
  try {
    handle = await open(path, flags);
    const after = await handle.stat();
    // The handle must be the very file that was checked: a swap between lstat and open is refused.
    // Windows reports inode 0 on some file systems, so identity is compared there only when either side has a real value;
    // size and modification time are compared everywhere.
    const inodeKnown = platform !== "win32" || before.ino !== 0 || after.ino !== 0;
    const swapped = after.dev !== before.dev || (inodeKnown && after.ino !== before.ino)
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs;
    if (!after.isFile() || after.size > MAX_SETTINGS_BYTES || swapped) {
      return { warning: "Claude settings.json changed while it was being read; it was ignored." };
    }
    const buffer = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_SETTINGS_BYTES) return { warning: `Claude settings.json is larger than ${MAX_SETTINGS_BYTES} bytes; it was ignored.` };
    return { text: buffer.toString("utf8", 0, total) };
  } catch {
    return { warning: "Claude settings.json could not be read; its auth settings were not forwarded." };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * The auth and endpoint variables of the user-level Claude `settings.json` that a readonly run forwards to the CLI
 * (`--restricted` does not load that file itself). Only the user file is read: `CLAUDE_CONFIG_DIR` (absolute only) or
 * `~/.claude`; never a project file, and never a file inside the job's working directory or its repository. Only an
 * allowlist of names is forwarded (no proxy, certificate, header, shell or loader variables), a base URL must be a plain
 * http(s) address, and nothing is imported when the environment already selects a login or when a variable is already set.
 */
export async function inspectClaudeReadonlyForwardedEnv(
  env: NodeJS.ProcessEnv, cwd: string, options: ClaudeForwardedEnvOptions = {},
): Promise<ClaudeForwardedEnv> {
  const platform = options.platform ?? process.platform;
  const flavor = platform === "win32" ? win32 : posix;
  const warnings: string[] = [];

  // The group gate: a login already chosen in the environment decides, and nothing from the file may mix with it.
  if (PRIMARY_SELECTORS.some((name) => hasValue(env, name, platform))) return NOTHING_FORWARDED();

  const configured = getEnvValue(env, CONFIG_DIR_ENV, platform);
  let configDir: string;
  if (configured !== undefined && configured !== "") {
    // A relative directory would be resolved against the untrusted working directory.
    if (!flavor.isAbsolute(configured)) {
      return NOTHING_FORWARDED([`${CONFIG_DIR_ENV} is not an absolute path, so the Claude settings.json auth settings were not forwarded.`]);
    }
    configDir = configured;
  } else {
    configDir = join(options.homeDir ?? homedir(), ".claude");
  }

  let realDir: string;
  try {
    realDir = await realpath(configDir);
  } catch {
    return NOTHING_FORWARDED();
  }
  if (await isInsideJobRepository(realDir, cwd, options.extraRepoRoots ?? [], platform)) {
    return NOTHING_FORWARDED([
      "The Claude user settings.json lies inside the job's working directory or repository, so its auth settings were not forwarded.",
    ]);
  }

  const read = await readBoundedSettings(join(realDir, SETTINGS_FILE_NAME), platform);
  if (read.warning) warnings.push(read.warning);
  if (read.text === undefined) return NOTHING_FORWARDED(warnings);

  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return NOTHING_FORWARDED([...warnings, "Claude settings.json is not valid JSON; its auth settings were not forwarded."]);
  }
  const block = isObject(parsed) ? parsed.env : undefined;
  if (!isObject(block)) return NOTHING_FORWARDED(warnings);

  // Windows names are case-insensitive: two spellings of one name are ambiguous, so neither is used.
  const collisions = new Set<string>();
  if (platform === "win32") {
    const seen = new Set<string>();
    for (const key of Object.keys(block)) {
      const folded = key.toUpperCase();
      if (seen.has(folded)) collisions.add(folded);
      seen.add(folded);
    }
  }

  const forwarded: Record<string, string> = {};
  const warnedCollisions = new Set<string>();
  for (const [key, value] of Object.entries(block)) {
    const name = canonicalName(key, platform);
    if (!isAllowedName(name)) continue;
    if (collisions.has(name)) {
      if (!warnedCollisions.has(name)) {
        warnedCollisions.add(name);
        warnings.push(`Claude settings.json defines ${name} more than once with different letter case; it was not forwarded.`);
      }
      continue;
    }
    if (typeof value !== "string" || value === "" || value.includes("\0") || value.length > MAX_FORWARDED_VALUE_CHARS) continue;
    if (hasValue(env, name, platform)) continue;
    if (BASE_URL_NAMES.has(name) && !isPlainHttpUrl(value)) {
      warnings.push(`Claude settings.json ${name} is not a plain http(s) URL without credentials, query or fragment; it was not forwarded.`);
      continue;
    }
    forwarded[name] = value;
  }

  const names = Object.keys(forwarded).sort();
  const secrets = names.filter((name) => SECRET_NAME.test(name) && forwarded[name].length >= MIN_SECRET_LENGTH).map((name) => forwarded[name]);
  return { env: forwarded, names, secrets, warnings };
}
