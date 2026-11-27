import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateCwd } from "../../src/runtime/guard.js";
import { createWorktree, inspectWorktree, removeStaleRepoLock, removeWorktree, withRepoLock } from "../../src/runtime/worktree.js";
import type { RunMode } from "../../src/types.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Orch Test", "-c", "user.email=orch@example.invalid", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe("runtime worktrees", () => {
  let root: string;
  let repo: string;
  let worktreesDir: string;
  let locksDir: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orch-worktree-")));
    repo = join(root, "source");
    worktreesDir = join(root, "worktrees");
    locksDir = join(root, "locks");
    await mkdir(join(repo, "nested"), { recursive: true });
    git(repo, "init", "-q");
    await Promise.all([
      writeFile(join(repo, ".gitignore"), "*.ignored\n"),
      writeFile(join(repo, "nested", "tracked ✨.txt"), "base content\n"),
    ]);
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Initial");
  });

  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function create(jobId: string, mode: RunMode, cwd = repo, baseRef?: string) {
    return createWorktree({ ...await validateCwd(cwd, []), jobId, mode, baseRef, worktreesDir, locksDir });
  }

  function removal(force?: boolean) {
    return { gitCommonDir: join(repo, ".git"), worktreesDir, locksDir, force };
  }

  it("creates detached and writable checkouts concurrently with an external manifest", async () => {
    const [detached, writable] = await Promise.all([create("reader", "readonly"), create("writer", "write")]);
    expect(git(detached.worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(git(writable.worktree.path, "branch", "--show-current")).toBe("orch/writer");
    expect(writable.worktree.base_commit).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(writable.worktree.path, "status", "--porcelain", "--ignored")).toBe("");
    const metadata = join(dirname(writable.worktree.path), ".metadata", "writer", ".orch-worktree.json");
    expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({ path: writable.worktree.path, jobId: "writer" });
    await expect(Promise.all([
      removeWorktree(detached.worktree, removal()), removeWorktree(writable.worktree, removal()),
    ])).resolves.toEqual([{ removed: true }, { removed: true }]);
    expect(git(repo, "branch", "--list", "orch/*")).toBe("");
    expect(await readdir(locksDir)).toEqual([]);
    await expect(stat(metadata)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves nested cwd and warns that dirty and untracked source files are excluded", async () => {
    const nested = join(repo, "nested");
    await Promise.all([
      writeFile(join(nested, "tracked ✨.txt"), "dirty"),
      writeFile(join(nested, "untracked.md"), "source only"),
    ]);
    const { worktree, effectiveCwd, warnings } = await create("nested", "readonly", nested);
    expect(effectiveCwd).toBe(join(worktree.path, "nested"));
    expect(warnings.join(" ")).toMatch(/not copied/);
    expect(await readFile(join(effectiveCwd, "tracked ✨.txt"), "utf8")).toBe("base content\n");
    await expect(stat(join(effectiveCwd, "untracked.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-Git, unborn and invalid refs without creating a checkout", async () => {
    await expect(create("nongit", "readonly", root)).rejects.toMatchObject({ code: "WORKTREE_ERROR" });
    const unborn = join(root, "unborn");
    await mkdir(unborn);
    git(unborn, "init", "-q");
    await expect(create("unborn", "readonly", unborn)).rejects.toMatchObject({ code: "WORKTREE_ERROR" });
    await expect(create("invalid", "write", repo, "--help")).rejects.toMatchObject({ code: "WORKTREE_ERROR" });
    await expect(stat(worktreesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back checkout and branch when the requested cwd is missing from the base ref", async () => {
    const nested = join(repo, "newly-created");
    await mkdir(nested);
    await writeFile(join(nested, "untracked.txt"), "outside base");
    await expect(create("rollback", "write", nested)).rejects.toMatchObject({ code: "WORKTREE_ERROR" });
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("rollback");
    expect(git(repo, "branch", "--list", "orch/*")).toBe("");
  });

  it("records tracked, renamed and untracked paths, refusing dirty cleanup", async () => {
    const { worktree } = await create("changed", "write");
    const cwd = worktree.path;
    git(cwd, "mv", "nested/tracked ✨.txt", "nested/renamed ✨.txt");
    await Promise.all([
      writeFile(join(cwd, "nested", "renamed ✨.txt"), "changed line\n"),
      writeFile(join(cwd, "untracked.txt"), "only in worktree"),
    ]);
    const inspection = await inspectWorktree(worktree);
    expect(inspection).toMatchObject({ dirty: true, has_ignored_files: false, head_moved: false });
    expect(inspection.changed_files).toEqual(expect.arrayContaining([
      "nested/tracked ✨.txt", "nested/renamed ✨.txt", "untracked.txt",
    ]));
    expect(inspection.diff_stat).toContain("file");
    expect(inspection.diff).toContain("+changed line");
    expect(inspection.diff).toContain('Untracked files: "untracked.txt"');
    await expect(removeWorktree(worktree, removal())).resolves.toMatchObject({
      removed: false, reason: expect.stringMatching(/tracked or untracked/),
    });
    await expect(removeWorktree(worktree, removal(true))).resolves.toEqual({ removed: true });
  });

  it("protects ignored files and a moved HEAD unless forced", async () => {
    const { worktree } = await create("protected", "write");
    const ignored = join(worktree.path, "private.ignored");
    await writeFile(ignored, "preserve me");
    await expect(inspectWorktree(worktree)).resolves.toMatchObject({ dirty: false, has_ignored_files: true, head_moved: false });
    await expect(removeWorktree(worktree, removal())).resolves.toMatchObject({
      removed: false, reason: expect.stringMatching(/ignored files/),
    });
    expect(await readFile(ignored, "utf8")).toBe("preserve me");
    await rm(ignored);
    git(worktree.path, "commit", "--allow-empty", "-qm", "Result commit");
    await expect(inspectWorktree(worktree)).resolves.toMatchObject({ dirty: false, head_moved: true });
    await expect(removeWorktree(worktree, removal())).resolves.toMatchObject({
      removed: false, reason: expect.stringMatching(/HEAD moved/),
    });
    await expect(removeWorktree(worktree, removal(true))).resolves.toEqual({ removed: true });
    expect(git(repo, "branch", "--list", "orch/*")).toBe("");
  });

  it("refuses even forced cleanup without a matching ownership manifest", async () => {
    const { worktree } = await create("owned", "readonly");
    await expect(removeWorktree({ ...worktree, base_commit: "0".repeat(40) }, removal(true)))
      .resolves.toMatchObject({ removed: false, reason: expect.stringMatching(/ownership/i) });
    expect((await stat(worktree.path)).isDirectory()).toBe(true);
  });

  it("removes a clean write worktree branched from an unmerged feature branch without force", async () => {
    git(repo, "checkout", "-qb", "feature-unmerged");
    await writeFile(join(repo, "feat.txt"), "feature\n");
    git(repo, "add", "feat.txt");
    git(repo, "commit", "-qm", "Feature commit");
    git(repo, "checkout", "-q", "-");

    const { worktree } = await create("unmerged-base", "write", repo, "feature-unmerged");
    await expect(removeWorktree(worktree, removal(false))).resolves.toEqual({ removed: true });
    expect(git(repo, "branch", "--list", "orch/unmerged-base")).toBe("");
  });

  describe("repository lock takeover", () => {
    const STALE_AGE_MS = 11 * 60_000;

    async function lockPath(): Promise<string> {
      const commonDir = await realpath(join(repo, ".git"));
      return join(locksDir, `${createHash("sha256").update(commonDir).digest("hex").slice(0, 24)}.lock`);
    }

    async function writeLock(path: string, pid: number, ageMs: number): Promise<void> {
      await mkdir(locksDir, { recursive: true });
      await writeFile(path, JSON.stringify({ pid, created_at: Date.now() - ageMs }));
      const when = new Date(Date.now() - ageMs);
      await utimes(path, when, when);
    }

    /** A PID that is certainly not running: a child that already exited. */
    function deadPid(): number {
      const result = spawnSync(process.execPath, ["-e", ""]);
      return result.pid;
    }

    it("takes over a lock whose owner process is gone, whatever its age", async () => {
      await writeLock(await lockPath(), deadPid(), 1_000);
      const { worktree } = await create("after-dead-owner", "readonly");
      expect((await stat(worktree.path)).isDirectory()).toBe(true);
      expect(await readdir(locksDir)).toEqual([]);
    }, 10_000);

    it("never removes the lock of a live owner, even one older than ten minutes", async () => {
      const path = await lockPath();
      await writeLock(path, process.pid, STALE_AGE_MS);
      const before = await readFile(path, "utf8");
      await expect(removeStaleRepoLock(path)).resolves.toBe(false);
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await readdir(locksDir)).toEqual([basename(path)]);
    });

    it("takes over a lock without a readable owner once it is older than a minute", async () => {
      const path = await lockPath();
      await mkdir(locksDir, { recursive: true });
      await writeFile(path, "");
      const when = new Date(Date.now() - STALE_AGE_MS);
      await utimes(path, when, when);
      const { worktree } = await create("after-ownerless-lock", "readonly");
      expect((await stat(worktree.path)).isDirectory()).toBe(true);
    }, 10_000);

    it("removes a stale lock through a tombstone and leaves nothing behind", async () => {
      const path = await lockPath();
      await writeLock(path, deadPid(), STALE_AGE_MS);
      await expect(removeStaleRepoLock(path)).resolves.toBe(true);
      expect(await readdir(locksDir)).toEqual([]);
      // Already gone counts as removed, so the caller simply retries acquiring the lock.
      await expect(removeStaleRepoLock(path)).resolves.toBe(true);
    });

    it("does not delete a lock another process took over while this one held an older token", async () => {
      const path = await lockPath();
      const gate = Promise.withResolvers<void>();
      const holding = withRepoLock(await realpath(join(repo, ".git")), locksDir, () => gate.promise);
      await vi.waitFor(async () => { expect(await readdir(locksDir)).toEqual([basename(path)]); });
      // Someone replaces the lock file (as a stale-lock breaker would after wrongly judging us dead).
      await rm(path);
      await writeLock(path, process.pid, 1_000);
      const foreign = await readFile(path, "utf8");
      gate.resolve();
      await holding;
      expect(await readFile(path, "utf8")).toBe(foreign);
    });

    it("puts back a live lock that replaced the stale one before it was moved", async () => {
      const path = await lockPath();
      await writeLock(path, process.pid, 1_000);
      const before = await readFile(path, "utf8");
      await expect(removeStaleRepoLock(path)).resolves.toBe(false);
      expect(await readFile(path, "utf8")).toBe(before);
      expect(await readdir(locksDir)).toEqual([basename(path)]);
    });
  });

  it("redacts a secret before the diff is clipped, even when the clip lands inside it", async () => {
    const secret = "synthetic-diff-secret-0123456789";
    const { worktree } = await create("secret-diff", "write");
    await writeFile(join(worktree.path, "nested", "tracked ✨.txt"), `base content\nkey = ${secret}\n`);
    const full = (await inspectWorktree(worktree, undefined, [secret])).diff;
    expect(full).not.toContain(secret);
    expect(full).toContain("key = [REDACTED]");
    // The unredacted diff places the secret here; cut a few bytes into it (the notice reserves 19 bytes).
    const unredacted = (await inspectWorktree(worktree)).diff;
    const cut = Buffer.byteLength(unredacted.slice(0, unredacted.indexOf(secret))) + 6 + Buffer.byteLength("\n[Diff truncated.]\n");
    const clipped = (await inspectWorktree(worktree, cut, [secret])).diff;
    expect(clipped).toContain("key = ");
    expect(clipped).not.toContain("synthe");
  });

  it("removes a worktree whose registered path differs only in its spelling", async () => {
    const { worktree } = await create("spelled", "readonly");
    const gitdir = join(repo, ".git", "worktrees", "spelled", "gitdir");
    // Git then lists the checkout as `<path>/`, as it lists `C:/dir` on Windows where the target is `C:\dir`.
    await writeFile(gitdir, `${worktree.path}//.git\n`);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain(`worktree ${worktree.path}/`);
    await expect(removeWorktree(worktree, removal())).resolves.toEqual({ removed: true });
    await expect(stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
