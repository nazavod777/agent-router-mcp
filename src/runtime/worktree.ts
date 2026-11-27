import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { getLocksDir, getWorktreesDir } from "../config/paths.js";
import { redactSecrets } from "../logging.js";
import type { RunMode, StructuredError, WorktreeInfo } from "../types.js";
import { filterOverrides, gitExecutable, IGNORE_SUBMODULES, isInsidePath, isolatedGitEnvironment, NULL_DEVICE } from "./guard.js";
import { redactionLookahead, truncateUtf8, utf8PrefixLength } from "./output.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const LOCK_WAIT_MS = 60_000;
const LOCK_POLL_MS = 50;
const DEFAULT_DIFF_BYTES = 1024 * 1024;
const DETACHED_BRANCH = "HEAD";
const INCOMPLETE_TRAILING_TOKEN = /\S+$/;
const MANIFEST_NAME = ".orch-worktree.json";
const SAFE_JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
/** Repository config that could run a command during checkout or diffing is switched off for every Git call. */
const GIT_OPTIONS = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${NULL_DEVICE}`, "-c", "core.sshCommand=false"];

interface WorktreeManifest {
  jobId: string;
  gitCommonDir: string;
  path: string;
  branch: string;
  baseCommit: string;
}

export interface CreateWorktreeOptions {
  realCwd: string;
  gitTopLevel?: string;
  gitCommonDir?: string;
  relativeCwd?: string;
  isDirty?: boolean;
  jobId: string;
  mode: RunMode;
  baseRef?: string;
  worktreesDir?: string;
  locksDir?: string;
  /** Aborts setup promptly: the lock wait and every Git subprocess stop, and a half-made worktree is rolled back. */
  signal?: AbortSignal;
  /** Called with the worktree path right before it is created, so the caller can reserve it before it is visible. */
  onReserve?: (path: string) => void;
}

export interface WorktreeInspection {
  dirty: boolean;
  diff_stat: string;
  changed_files: string[];
  diff: string;
  has_ignored_files: boolean;
  head_moved: boolean;
}

function repoHash(commonDir: string): string {
  return createHash("sha256").update(commonDir).digest("hex").slice(0, 24);
}

function manifestPath(target: string, jobId: string): string {
  return join(dirname(target), ".metadata", jobId, MANIFEST_NAME);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string | number): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

interface GitOptions {
  signal?: AbortSignal;
  /** Marks the Git process as part of this job (`ORCH_JOB_ID`), so process-tree cleanup finds what it spawns. */
  jobId?: string;
  /** The command reads or writes working-tree files: every filter configured in the repository is disabled for it. */
  filters?: boolean;
}

async function runGit(cwd: string, args: string[], opts: GitOptions): Promise<string> {
  const { stdout } = await execFileAsync(gitExecutable(), [...GIT_OPTIONS, ...args], {
    cwd,
    env: isolatedGitEnvironment(opts.jobId),
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    signal: opts.signal,
  });
  return stdout;
}

/** The repository's own filters (included and worktree config too), blanked; system and global config are ignored. */
export async function localFilterOverrides(cwd: string, opts: GitOptions = {}): Promise<string[]> {
  return filterOverrides(cwd, { signal: opts.signal, jobId: opts.jobId });
}

async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const overrides = opts.filters ? await localFilterOverrides(cwd, opts) : [];
  return runGit(cwd, [...overrides, ...args], opts);
}

/** A lock without a readable owner PID is stale after this long. */
const LEGACY_LOCK_AGE_MS = 60_000;
const STALE_TOMBSTONE_SUFFIX = "stale";

interface RepoLockOwner { pid?: number; token?: string }

async function readLockOwner(path: string): Promise<RepoLockOwner | undefined> {
  try {
    const parsed = JSON.parse((await readFile(path, "utf8")).trim()) as { pid?: unknown; token?: unknown };
    return {
      ...(typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? { pid: parsed.pid } : {}),
      ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
    };
  } catch {
    return undefined; // Empty, partial or legacy content: the owner is unknown.
  }
}

/**
 * A lock is stale when its owner process is gone. A live owner is never robbed, however old the lock is: the holder
 * would otherwise lose it in the middle of a Git operation. Only a lock with no readable owner falls back to its age.
 */
async function isStaleRepoLock(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    const owner = await readLockOwner(path);
    if (owner?.pid !== undefined) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        return hasCode(error, "ESRCH");
      }
    }
    return Date.now() - stats.mtimeMs > LEGACY_LOCK_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Takes over a lock that looked stale. The lock is first renamed to a unique tombstone, which only one contender can
 * win, and is deleted only after the tombstone is verified stale again: between the caller's check and the rename the
 * owner may have been replaced by a live one, whose lock is then put back instead of being destroyed.
 * Returns true when a stale lock was removed (or was already gone).
 */
export async function removeStaleRepoLock(path: string): Promise<boolean> {
  const tombstone = `${path}.${randomUUID()}.${STALE_TOMBSTONE_SUFFIX}`;
  try {
    await rename(path, tombstone);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
  if (await isStaleRepoLock(tombstone)) {
    await unlink(tombstone).catch(() => {});
    return true;
  }
  // A live lock was moved by mistake; link() refuses to overwrite a lock another contender created meanwhile.
  try {
    await link(tombstone, path);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  await unlink(tombstone).catch(() => {});
  return false;
}

/** Deletes the lock file only while it still holds our token and is still our file, never another process's lock. */
async function releaseRepoLock(lock: Awaited<ReturnType<typeof open>>, path: string, token: string): Promise<void> {
  try {
    const [onDisk, mine] = await Promise.all([stat(path), lock.stat()]);
    if (onDisk.ino === mine.ino && onDisk.dev === mine.dev && (await readLockOwner(path))?.token === token) {
      await unlink(path).catch(() => {});
    }
  } catch {
    // The lock file is already gone or was replaced; there is nothing of ours left to delete.
  } finally {
    await lock.close().catch(() => {});
  }
}

export async function withRepoLock<T>(
  commonDir: string, locksDir: string, action: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
  const path = join(locksDir, `${repoHash(commonDir)}.lock`);
  const deadline = performance.now() + LOCK_WAIT_MS;
  const token = randomUUID();
  let lock;
  for (;;) {
    signal?.throwIfAborted();
    try {
      lock = await open(path, "wx", 0o600);
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, token, created_at: Date.now() }));
      } catch (writeError) {
        await lock.close();
        await unlink(path).catch(() => {});
        throw writeError;
      }
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (await isStaleRepoLock(path) && await removeStaleRepoLock(path)) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for worktree lock ${path}.`);
      await setTimeout(Math.min(LOCK_POLL_MS, remaining), undefined, { signal });
    }
  }

  try {
    signal?.throwIfAborted();
    return await action();
  } finally {
    await releaseRepoLock(lock, path, token);
  }
}

async function resolveStoragePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT") || dirname(path) === path) throw error;
    return join(await resolveStoragePath(dirname(path)), basename(path));
  }
}

async function createPrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== path) throw new Error(`Unexpected symbolic link in worktree storage: ${path}.`);
}

async function verifyCheckout(cwd: string, commonDir: string, opts: GitOptions = {}): Promise<void> {
  const [top, common] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"], opts),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts),
  ]);
  if (await realpath(top.slice(0, -1)) !== cwd || await realpath(common.slice(0, -1)) !== commonDir) {
    throw new Error("Checkout does not belong to the expected Git repository.");
  }
}

const WORKTREE_LIST_PREFIX = "worktree ";

/**
 * Paths Git lists for the repository, normalized the way `target` is (absolute, native separators) so a Windows
 * `C:/x/y` listing equals `C:\x\y`; the real path is added too when the listed one is a link.
 */
async function registeredWorktreePaths(commonDir: string, opts: GitOptions = {}): Promise<Set<string>> {
  const output = await git(commonDir, ["--git-dir", commonDir, "worktree", "list", "--porcelain", "-z"], opts);
  const paths = new Set<string>();
  for (const entry of output.split("\0\0")) {
    const first = entry.split("\0", 1)[0];
    if (!first.startsWith(WORKTREE_LIST_PREFIX)) continue;
    const listed = resolve(first.slice(WORKTREE_LIST_PREFIX.length));
    paths.add(listed);
    try {
      paths.add(await realpath(listed));
    } catch {
      // A missing or unreadable listed path simply keeps its lexical form.
    }
  }
  return paths;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function deleteBranch(
  commonDir: string, branch: string, baseCommit: string, force: boolean, jobId?: string,
): Promise<void> {
  if (branch === DETACHED_BRANCH) return;
  const repo = ["--git-dir", commonDir];
  const opts: GitOptions = { jobId };
  try {
    await git(commonDir, [...repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], opts);
  } catch (error) {
    if (hasCode(error, 1)) return;
    throw error;
  }
  if (force) {
    await git(commonDir, [...repo, "branch", "-D", "--", branch], opts);
  } else {
    // Atomic delete only if the temporary branch still points at its original base commit (works even for unmerged base_ref).
    await git(commonDir, [...repo, "update-ref", "-d", `refs/heads/${branch}`, baseCommit], opts);
  }
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<{
  worktree: WorktreeInfo;
  effectiveCwd: string;
  warnings: string[];
}> {
  try {
    if (!opts.gitTopLevel || !opts.gitCommonDir) throw new Error("Worktree isolation requires a Git working tree.");
    if (!SAFE_JOB_ID.test(opts.jobId)) throw new Error("Invalid job ID for a worktree.");
    const [topLevel, commonDir, realCwd] = await Promise.all([
      realpath(opts.gitTopLevel), realpath(opts.gitCommonDir), realpath(opts.realCwd),
    ]);
    const storage = await resolveStoragePath(resolve(opts.worktreesDir ?? getWorktreesDir()));
    if (isInsidePath(topLevel, storage) || isInsidePath(commonDir, storage)) {
      throw new Error("Worktree storage must be outside the source repository.");
    }
    const repoDir = join(storage, repoHash(commonDir));
    const target = join(repoDir, opts.jobId);
    const relativeCwd = opts.relativeCwd ?? "";
    if (!isInsidePath(target, resolve(target, relativeCwd)) || resolve(topLevel, relativeCwd) !== realCwd) {
      throw new Error("The relative working directory does not match the source checkout.");
    }

    const { signal, jobId } = opts;
    const gitOpts: GitOptions = { signal, jobId };
    return await withRepoLock(commonDir, opts.locksDir ?? getLocksDir(), async () => {
      await verifyCheckout(topLevel, commonDir, gitOpts);
      const ref = opts.baseRef || "HEAD";
      let sha: string;
      try {
        sha = (await git(topLevel, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], gitOpts)).trim();
      } catch (error) {
        signal?.throwIfAborted();
        throw new Error(`Cannot resolve worktree base ref ${JSON.stringify(ref)} to a commit.`, { cause: error });
      }

      await createPrivateDirectory(repoDir);
      if (await pathExists(target)) throw new Error("Worktree target already exists.");
      const metadata = manifestPath(target, opts.jobId);
      await createPrivateDirectory(dirname(dirname(metadata)));
      await mkdir(dirname(metadata), { mode: 0o700 });
      const branch = opts.mode === "readonly" ? DETACHED_BRANCH : `orch/${opts.jobId}`;
      const options = opts.mode === "readonly" ? ["--detach"] : ["-b", branch];
      let added = false;
      try {
        opts.onReserve?.(target);
        await git(topLevel, ["worktree", "add", ...options, "--", target, sha], { ...gitOpts, filters: true });
        added = true;
        signal?.throwIfAborted();
        const effectiveCwd = await realpath(join(target, relativeCwd));
        if (!isInsidePath(target, effectiveCwd) || !(await stat(effectiveCwd)).isDirectory()) {
          throw new Error("The working directory is absent or outside the new worktree.");
        }
        const manifest: WorktreeManifest = { jobId: opts.jobId, gitCommonDir: commonDir, path: target, branch, baseCommit: sha };
        await writeFile(metadata, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
        return {
          worktree: { path: target, branch, base_commit: sha, relative_cwd: relativeCwd },
          effectiveCwd,
          warnings: opts.isDirty
            ? ["Uncommitted and untracked changes in the source checkout are not copied into the worktree."]
            : [],
        };
      } catch (error) {
        try {
          // Rollback must finish even when setup was aborted, so it carries no abort signal.
          if (added) {
            await git(topLevel, ["worktree", "remove", "--force", "--", target], { jobId, filters: true });
            await deleteBranch(commonDir, branch, sha, true, jobId);
          }
          await unlink(metadata).catch((err: unknown) => { if (!hasCode(err, "ENOENT")) throw err; });
          await rmdir(dirname(metadata));
        } catch (cleanupError) {
          throw new Error(`${errorMessage(error)} Worktree rollback failed: ${errorMessage(cleanupError)}`, { cause: error });
        }
        throw error;
      }
    }, signal);
  } catch (error) {
    const message = opts.signal?.aborted ? "Worktree setup was aborted." : errorMessage(error);
    throw { code: "WORKTREE_ERROR", message, retryable: false } satisfies StructuredError;
  }
}

/**
 * Reads `git diff` redacted BEFORE it is clipped to `maxBytes`: the read window extends past the cap, so a secret that
 * straddles the cap is replaced whole. If even the window is cut, its incomplete last token is discarded.
 */
async function readDiff(
  cwd: string, base: string, maxBytes: number, extraSecrets: string[], opts: GitOptions,
): Promise<{ diff: string; truncated: boolean }> {
  const overrides = await localFilterOverrides(cwd, opts);
  const child = spawn(gitExecutable(), [...GIT_OPTIONS, ...overrides, "diff", "--no-ext-diff", "--no-textconv", IGNORE_SUBMODULES, base, "--"], {
    cwd,
    env: isolatedGitEnvironment(opts.jobId),
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    signal: opts.signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const windowBytes = maxBytes + redactionLookahead(extraSecrets);
  const chunks: Buffer[] = [];
  let kept = 0;
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const keep = Math.min(chunk.length, windowBytes + 1 - kept);
    if (keep > 0) chunks.push(chunk.subarray(0, keep));
    kept += keep;
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
  await new Promise<void>((resolveExit, reject) => {
    child.on("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolveExit();
      else reject(new Error(`git diff failed: ${stderr.trim() || code || "terminated"}`));
    });
  });
  // The lookahead byte identifies whether the read window itself was cut.
  const bytes = Buffer.concat(chunks, kept);
  const windowCut = kept > windowBytes;
  const window = windowCut ? bytes.subarray(0, utf8PrefixLength(bytes, windowBytes)).toString("utf8") : bytes.toString("utf8");
  const complete = windowCut ? window.replace(INCOMPLETE_TRAILING_TOKEN, "") : window;
  const clipped = truncateUtf8(redactSecrets(complete, extraSecrets), maxBytes);
  return { diff: clipped.text, truncated: windowCut || clipped.truncated };
}

function readStatus(status: string): { changed: string[]; untracked: string[]; ignored: boolean } {
  const entries = status.split("\0");
  const changed: string[] = [];
  const untracked: string[] = [];
  let ignored = false;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code === "!!") {
      ignored = true;
      continue;
    }
    changed.push(path);
    if (code === "??") untracked.push(path);
    if (/[RC]/.test(code)) changed.push(entries[++index]);
  }
  return { changed, untracked, ignored };
}

/** `extraSecrets` are redacted from the diff and the untracked-file notice before they are clipped to `maxDiffBytes`. */
export async function inspectWorktree(
  worktree: WorktreeInfo, maxDiffBytes = DEFAULT_DIFF_BYTES, extraSecrets: string[] = [],
  opts: { jobId?: string; signal?: AbortSignal } = {},
): Promise<WorktreeInspection> {
  const gitOpts: GitOptions = { ...opts, filters: true };
  const base = worktree.base_commit;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw new Error("Invalid worktree base commit.");
  const cwd = worktree.path;
  const maxBytes = Math.max(0, Math.floor(maxDiffBytes));
  const [rawStatus, diffStat, committedPaths, head] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all", IGNORE_SUBMODULES], gitOpts),
    git(cwd, ["diff", "--stat", "--no-ext-diff", "--no-textconv", IGNORE_SUBMODULES, base, "--"], gitOpts),
    git(cwd, ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", IGNORE_SUBMODULES, base, "--"], gitOpts),
    git(cwd, ["rev-parse", "--verify", "HEAD"], opts),
  ]);
  const status = readStatus(rawStatus);
  const notice = status.untracked.length
    ? redactSecrets(`\n[Untracked files: ${status.untracked.map((path) => JSON.stringify(path)).join(", ")}]\n`, extraSecrets) : "";
  const suffix = truncateUtf8(notice, maxBytes).text;
  const available = maxBytes - Buffer.byteLength(suffix);
  const { diff, truncated } = await readDiff(cwd, base, available, extraSecrets, opts);
  const truncation = truncated ? truncateUtf8("\n[Diff truncated.]\n", available).text : "";
  return {
    dirty: status.changed.length > 0,
    diff_stat: diffStat.trimEnd(),
    changed_files: [...new Set([...committedPaths.split("\0").filter(Boolean), ...status.changed])],
    diff: truncateUtf8(diff, available - Buffer.byteLength(truncation)).text + truncation + suffix,
    has_ignored_files: status.ignored,
    head_moved: head.trim() !== base,
  };
}

export async function removeWorktree(worktree: WorktreeInfo, opts: {
  gitCommonDir: string;
  force?: boolean;
  worktreesDir?: string;
  locksDir?: string;
}): Promise<{ removed: boolean; reason?: string }> {
  try {
    const commonDir = await realpath(opts.gitCommonDir);
    const target = resolve(worktree.path);
    const jobId = basename(target);
    const storage = opts.worktreesDir
      ? await resolveStoragePath(resolve(opts.worktreesDir))
      : dirname(dirname(target));
    if (!SAFE_JOB_ID.test(jobId) || target !== join(storage, repoHash(commonDir), jobId)) {
      throw new Error("Worktree path is outside its expected repository storage.");
    }

    const gitOpts: GitOptions = { jobId };
    return await withRepoLock(commonDir, opts.locksDir ?? getLocksDir(), async () => {
      const metadata = manifestPath(target, jobId);
      if (await realpath(metadata) !== metadata) throw new Error("Worktree manifest path is not canonical.");
      const manifest = JSON.parse(await readFile(metadata, "utf8")) as WorktreeManifest;
      const branch = worktree.branch;
      if (manifest.path !== target || manifest.jobId !== jobId || manifest.gitCommonDir !== commonDir ||
          manifest.branch !== branch || manifest.baseCommit !== worktree.base_commit ||
          (branch !== DETACHED_BRANCH && branch !== `orch/${jobId}`)) {
        throw new Error("Worktree ownership could not be verified.");
      }
      const repo = ["--git-dir", commonDir];
      const registered = (await registeredWorktreePaths(commonDir, gitOpts)).has(target);
      if (registered) {
        if (await realpath(target) !== target) throw new Error("Worktree path is not canonical.");
        await verifyCheckout(target, commonDir, gitOpts);
        if (!opts.force) {
          const state = await inspectWorktree(worktree, 0, [], gitOpts);
          if (state.dirty) return { removed: false, reason: "Worktree has tracked or untracked changes." };
          if (state.has_ignored_files) return { removed: false, reason: "Worktree contains ignored files." };
          if (state.head_moved) return { removed: false, reason: "Worktree HEAD moved from the base commit." };
        }
        await git(commonDir, [...repo, "worktree", "remove", ...(opts.force ? ["--force"] : []), "--", target], { ...gitOpts, filters: true });
      } else if (await pathExists(target)) {
        // A prior removal may have succeeded before branch or manifest cleanup failed.
        throw new Error("Worktree path is not registered with the source repository.");
      }
      await deleteBranch(commonDir, branch, worktree.base_commit, opts.force === true, jobId);
      await unlink(metadata);
      await rmdir(dirname(metadata));
      return { removed: true };
    });
  } catch (error) {
    return { removed: false, reason: errorMessage(error) };
  }
}

const MAX_GIT_LINK_BYTES = 4096;
const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

/**
 * Confirms that `worktree.path` is still the exact worktree this orchestrator registered for the job, before anything is
 * inspected in it: the canonical path is unchanged, its `.git` file is a link into this repository's worktree
 * administration whose back-link points here, Git still lists it, and the manifest written at creation names it.
 * Returns undefined when the identity holds, otherwise the reason it does not.
 */
export async function verifyWorktreeIdentity(worktree: WorktreeInfo, gitCommonDir: string): Promise<string | undefined> {
  try {
    const commonDir = await realpath(gitCommonDir);
    const target = resolve(worktree.path);
    const jobId = basename(target);
    if (!SAFE_JOB_ID.test(jobId)) return "the worktree directory name is not a job ID";
    if (await realpath(target) !== target) return "the worktree path is not canonical (it is, or passes through, a symbolic link)";

    const marker = join(target, ".git");
    const markerInfo = await lstat(marker);
    if (!markerInfo.isFile() || markerInfo.size > MAX_GIT_LINK_BYTES) return "the worktree .git entry is not a linked-worktree file";
    const link = GITDIR_LINE.exec(await readFile(marker, "utf8"));
    if (!link) return "the worktree .git file has no gitdir link";
    const adminDir = await realpath(resolve(target, link[1]));
    if (dirname(adminDir) !== join(commonDir, "worktrees")) return "the worktree is linked to another repository";
    const backLink = (await readFile(join(adminDir, "gitdir"), "utf8")).trim();
    if (await realpath(dirname(resolve(adminDir, backLink))) !== target) return "the repository links this worktree name to another directory";
    if (!(await registeredWorktreePaths(commonDir, { jobId })).has(target)) return "Git no longer lists this worktree";

    const manifest = JSON.parse(await readFile(manifestPath(target, jobId), "utf8")) as Partial<WorktreeManifest>;
    if (manifest.path !== target || manifest.gitCommonDir !== commonDir || manifest.baseCommit !== worktree.base_commit) {
      return "the worktree manifest does not match this worktree";
    }
    return undefined;
  } catch (error) {
    return `the worktree could not be verified (${errorMessage(error)})`;
  }
}
