import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveBinary } from "../adapters/probe-utils.js";
import type { StructuredError } from "../types.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_LOCAL_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_GRAFT_FILE", "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE", "GIT_INTERNAL_SUPER_PREFIX", "GIT_NAMESPACE", "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY", "GIT_PREFIX", "GIT_QUARANTINE_PATH", "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE", "GIT_WORK_TREE",
];

function parseDepth(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const depth = Number(value);
  return Number.isSafeInteger(depth) ? depth : undefined;
}

export function getCurrentOrchDepth(env: NodeJS.ProcessEnv = process.env): number {
  if (env.ORCH_DEPTH === undefined) return 0;
  return parseDepth(env.ORCH_DEPTH) ?? Number.MAX_SAFE_INTEGER;
}

/** ORCH_MAX_DEPTH can only tighten the configured limit, never raise it. */
export function effectiveMaxDepth(maxDepth: number, env: NodeJS.ProcessEnv = process.env): number {
  const envLimit = parseDepth(env.ORCH_MAX_DEPTH);
  return envLimit === undefined ? maxDepth : Math.min(envLimit, maxDepth);
}

export function checkRecursionLimit(maxDepth: number, env: NodeJS.ProcessEnv = process.env): StructuredError | null {
  const currentDepth = getCurrentOrchDepth(env);
  const limit = effectiveMaxDepth(maxDepth, env);
  if (currentDepth < limit && currentDepth < Number.MAX_SAFE_INTEGER) return null;
  return {
    code: "RECURSION_BLOCKED",
    message: "Orchestration recursion limit reached or ORCH_DEPTH is invalid.",
    retryable: false,
    details: { current_depth: currentDepth, max_depth: limit },
  };
}

const JOB_CHAIN_SEPARATOR = ",";
const SAFE_CHAIN_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/** Ancestry of job IDs inherited from an outer orchestrator, with malformed tokens dropped. */
function inheritedJobChain(env: NodeJS.ProcessEnv): string[] {
  return (env.ORCH_JOB_CHAIN ?? "").split(JOB_CHAIN_SEPARATOR).filter((token) => SAFE_CHAIN_TOKEN.test(token));
}

/**
 * Environment of a job's CLI. `ORCH_JOB_ID` names this job; `ORCH_JOB_CHAIN` lists it after the jobs of every outer
 * orchestrator, so processes that escape a nested orchestrator can still be matched to the outer job. Repository-local
 * Git variables are removed so a hook-launched orchestrator cannot redirect Git away from a job's worktree.
 */
export function buildChildEnv(opts: {
  baseEnv?: NodeJS.ProcessEnv;
  nextDepth: number;
  jobId: string;
  extra?: Record<string, string>;
  /** Configured orchestration depth limit; the child inherits the tighter of it and its own ORCH_MAX_DEPTH. */
  maxDepth?: number;
}): NodeJS.ProcessEnv {
  const baseEnv = opts.baseEnv ?? process.env;
  const inherited = { ...baseEnv };
  for (const name of GIT_LOCAL_ENV) delete inherited[name];
  return {
    ...inherited,
    ...opts.extra,
    ORCH_DEPTH: String(opts.nextDepth),
    ORCH_JOB_ID: opts.jobId,
    ORCH_JOB_CHAIN: [...inheritedJobChain(baseEnv), opts.jobId].join(JOB_CHAIN_SEPARATOR),
    ...(opts.maxDepth === undefined ? {} : { ORCH_MAX_DEPTH: String(effectiveMaxDepth(opts.maxDepth, baseEnv)) }),
  };
}

export interface ValidatedCwd {
  realCwd: string;
  isGitRepo: boolean;
  gitTopLevel?: string;
  gitCommonDir?: string;
  relativeCwd?: string;
  isDirty?: boolean;
}

export function isInsidePath(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

/** The null device Git reads as an empty config file. */
export const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const JOB_ID_ENV = "ORCH_JOB_ID";

/** `jobId` marks the Git process (and everything it spawns) as belonging to a job, so process-tree cleanup can find it. */
export function gitEnvironment(jobId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  for (const name of GIT_LOCAL_ENV) delete env[name];
  if (jobId !== undefined) env[JOB_ID_ENV] = jobId;
  return env;
}

/** Git environment that ignores the system and global config, so neither can add filters, hooks or other commands. */
export function isolatedGitEnvironment(jobId?: string): NodeJS.ProcessEnv {
  return { ...gitEnvironment(jobId), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NULL_DEVICE };
}

export function allowedRootsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return (env.ORCH_ALLOWED_ROOTS ?? "").split(delimiter).filter(Boolean);
}

const FILTER_KEY_PATTERN = "^filter\\..*\\.(smudge|process|clean)$";
const FILTER_KEY = /^filter\.(.+)\.(smudge|process|clean)$/;
export const MAX_FILTER_OVERRIDES = 256;
/**
 * Passed to every `git status` / `git diff` of the service: Git would otherwise descend into submodules and run the
 * filters configured in a submodule's own repository config, which `filterOverrides` (it lists only this repository) cannot blank.
 */
export const IGNORE_SUBMODULES = "--ignore-submodules=all";

/**
 * Absolute path of the `git` executable used for every service Git call. It is resolved through `resolveBinary`, which
 * skips relative PATH entries (`.`, empty, `./bin`), so a `git` planted in a job's working directory can never run.
 * Throws an `ENOENT` error when Git is not installed (callers treat that as "not a Git repository" where that is safe).
 */
export function gitExecutable(): string {
  const path = resolveBinary("git");
  if (path === undefined) {
    throw Object.assign(new Error("The git executable was not found in an absolute PATH directory."), { code: "ENOENT" });
  }
  return path;
}

/** Thrown when a repository configures more filters than can be neutralized; running Git would execute the rest. */
export class TooManyGitFiltersError extends Error {
  constructor() {
    super(
      `The repository configures more than ${MAX_FILTER_OVERRIDES} Git filters (filter.<name>.smudge/process/clean), ` +
      "which cannot all be disabled safely. Remove the unneeded filters from the repository, included or worktree config.",
    );
    this.name = "TooManyGitFiltersError";
  }
}

/** Thrown for a filter whose name cannot be addressed by a `-c` override. */
export class UnblankableGitFilterError extends Error {
  constructor() {
    super('A Git filter name in the repository config contains "=", so the filter cannot be disabled safely. Rename or remove that filter.');
    this.name = "UnblankableGitFilterError";
  }
}

/**
 * `-c` overrides that blank every `smudge`, `process` and `clean` command Git is configured with and make the filters
 * optional, so a `.gitattributes` entry can never run a command while files are checked out or compared. The filters are
 * listed from the repository config (included files and worktree config too, through `--includes`) with the system and
 * global config ignored; the Git command the overrides are meant for must use the same isolated environment. More
 * filters than the safety cap is an error: leaving the rest active would run their commands.
 */
export async function filterOverrides(cwd: string, opts: { signal?: AbortSignal; jobId?: string } = {}): Promise<string[]> {
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync(gitExecutable(), [
      "-c", "core.fsmonitor=false", "config", "--includes", "--name-only", "--get-regexp", FILTER_KEY_PATTERN,
    ], {
      cwd, env: isolatedGitEnvironment(opts.jobId), timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      signal: opts.signal,
    }));
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return []; // No such key configured.
    throw error;
  }
  const overrides: string[] = [];
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const key = line.trim();
    const match = FILTER_KEY.exec(key);
    if (!match) continue;
    // `-c name=value` splits at the FIRST "=", so a filter named "a=b" could not be blanked: refuse instead of leaving it active.
    if (match[1].includes("=")) throw new UnblankableGitFilterError();
    if (!names.has(match[1]) && names.size >= MAX_FILTER_OVERRIDES) throw new TooManyGitFiltersError();
    overrides.push("-c", `${key}=`);
    names.add(match[1]);
  }
  for (const name of names) overrides.push("-c", `filter.${name}.required=false`);
  return overrides;
}

/** Runs the resolved Git with every configured filter disabled, in the isolated environment the overrides were listed in. */
export async function runFilterFreeGit(
  cwd: string, args: string[], opts: { jobId?: string; signal?: AbortSignal; timeout: number; maxBuffer: number },
): Promise<Buffer> {
  const overrides = await filterOverrides(cwd, opts);
  const { stdout } = await execFileAsync(gitExecutable(), ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${NULL_DEVICE}`, ...overrides, ...args], {
    cwd, env: isolatedGitEnvironment(opts.jobId), timeout: opts.timeout, killSignal: "SIGKILL", maxBuffer: opts.maxBuffer,
    signal: opts.signal, encoding: "buffer",
  });
  return stdout;
}

async function gitProbe(cwd: string, args: string[], jobId?: string): Promise<string> {
  const { stdout } = await execFileAsync(gitExecutable(), ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: gitEnvironment(jobId),
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.replace(/\r?\n$/, "");
}

/** The dirty flag only adds a warning, so a slow or oversized `git status` leaves it unknown instead of failing validation. */
async function probeIsDirty(cwd: string, jobId?: string): Promise<boolean | undefined> {
  try {
    // `git status` rehashes files through their clean filter; a repository filter must never run from this probe.
    const status = await runFilterFreeGit(cwd, ["status", "--porcelain", "--untracked-files=normal", IGNORE_SUBMODULES], {
      jobId, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
    });
    return status.length > 0;
  } catch {
    return undefined;
  }
}

async function assertInsideAllowedRoots(realCwd: string, allowedRoots: readonly string[]): Promise<void> {
  if (allowedRoots.length === 0) return;
  const roots = await Promise.allSettled(allowedRoots.map((root) => realpath(root)));
  if (!roots.some((root) => root.status === "fulfilled" && isInsidePath(root.value, realCwd))) {
    throw new Error("Working directory is outside the allowed roots.");
  }
}

function invalidCwd(error: unknown): StructuredError {
  return {
    code: "INVALID_CWD",
    message: error instanceof Error ? error.message : "Could not validate the working directory.",
    retryable: false,
  };
}

/**
 * Checks again, right before a CLI is spawned, a directory that was validated earlier (possibly before a long wait in
 * the queue): it must still be the same canonical directory, and (with `allowedRoots`) still inside them. A symbolic
 * link swapped in meanwhile makes the canonical path differ from the validated one.
 */
export async function revalidateCwd(validatedRealCwd: string, allowedRoots: readonly string[] = []): Promise<void> {
  try {
    const realCwd = await realpath(validatedRealCwd);
    if (realCwd !== validatedRealCwd) throw new Error("Working directory changed after it was validated.");
    if (!(await stat(realCwd)).isDirectory()) throw new Error("Working directory is not a directory.");
    await assertInsideAllowedRoots(realCwd, allowedRoots);
  } catch (error) {
    throw invalidCwd(error);
  }
}

/** `jobId` marks every Git subprocess of the validation as part of that job (`ORCH_JOB_ID`), so process-tree cleanup finds it. */
export async function validateCwd(
  cwd: string, allowedRoots = allowedRootsFromEnv(process.env), jobId?: string,
): Promise<ValidatedCwd> {
  try {
    if (!cwd.trim()) throw new Error("Working directory is empty.");
    const realCwd = await realpath(cwd);
    if (!(await stat(realCwd)).isDirectory()) throw new Error("Working directory is not a directory.");

    await assertInsideAllowedRoots(realCwd, allowedRoots);

    let gitTopLevel: string;
    try {
      gitTopLevel = await realpath(await gitProbe(realCwd, ["rev-parse", "--show-toplevel"], jobId));
    } catch (error) {
      const { code, stderr } = error as { code?: number | string; stderr?: string };
      if (code === "ENOENT" || (code === 128 && /not a git repository|must be run in a work tree/.test(stderr ?? ""))) {
        return { realCwd, isGitRepo: false };
      }
      throw error;
    }

    const [commonDir, isDirty] = await Promise.all([
      gitProbe(realCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], jobId),
      probeIsDirty(realCwd, jobId),
    ]);
    return {
      realCwd,
      isGitRepo: true,
      gitTopLevel,
      gitCommonDir: await realpath(resolve(realCwd, commonDir)),
      relativeCwd: relative(gitTopLevel, realCwd),
      isDirty,
    };
  } catch (error) {
    throw invalidCwd(error);
  }
}
