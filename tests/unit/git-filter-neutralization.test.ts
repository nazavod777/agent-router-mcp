import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filterOverrides, gitExecutable, MAX_FILTER_OVERRIDES, runFilterFreeGit, TooManyGitFiltersError, UnblankableGitFilterError, validateCwd,
} from "../../src/runtime/guard.js";
import { snapshotWorkspace, treeFingerprint } from "../../src/runtime/runner.js";
import { createWorktree, inspectWorktree } from "../../src/runtime/worktree.js";

// Same byte length as "base\n": Git then has to run the clean filter to find out whether the file really changed.
const SAME_SIZE_EDIT = "BASE\n";
const IS_WINDOWS = process.platform === "win32";
const REAL_GIT = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(REAL_GIT, ["-c", "user.name=Orch Test", "-c", "user.email=orch@example.invalid", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    // Hermetic: the developer's own global config (gpg signing, hooks) must not decide whether the fixture commits.
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

describe.skipIf(IS_WINDOWS)("git filter neutralization and resolved git executable", () => {
  let root: string;
  let repo: string;
  let marker: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "orch-gitfilter-")));
    repo = join(root, "repo");
    marker = join(root, "filter-ran");
    await mkdir(repo);
    git(repo, "init", "-q");
    await writeFile(join(repo, ".gitattributes"), "*.txt filter=evil\n");
    await writeFile(join(repo, "a.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "-c", "filter.evil.clean=cat", "commit", "-qm", "Initial");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  const evilCommand = () => `sh -c 'touch ${marker}; cat'`;

  it("resolves an absolute git and never a git planted in a relative PATH entry", async () => {
    const planted = join(root, "planted");
    await mkdir(planted);
    await writeFile(join(planted, "git"), `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    await chmod(join(planted, "git"), 0o755);
    vi.stubEnv("PATH", `.${delimiter}${process.env.PATH ?? ""}`);
    const previous = process.cwd();
    process.chdir(planted);
    try {
      expect(isAbsolute(gitExecutable())).toBe(true);
      expect(gitExecutable()).not.toBe(join(planted, "git"));
      await expect(validateCwd(repo, [])).resolves.toMatchObject({ isGitRepo: true });
    } finally {
      process.chdir(previous);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("treats a missing git executable as ENOENT", () => {
    vi.stubEnv("PATH", "relative-only");
    expect(() => gitExecutable()).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });

  it("lists filters from included config files and from the worktree config", async () => {
    await writeFile(join(root, "extra.gitconfig"), `[filter "included"]\n\tclean = touch ${marker}\n`);
    git(repo, "config", "include.path", join(root, "extra.gitconfig"));
    git(repo, "config", "extensions.worktreeConfig", "true");
    git(repo, "config", "--worktree", "filter.wt.smudge", "touch x");
    git(repo, "config", "filter.evil.process", "touch y");
    const overrides = await filterOverrides(repo);
    expect(overrides).toEqual(expect.arrayContaining([
      "-c", "filter.included.clean=", "-c", "filter.wt.smudge=", "-c", "filter.evil.process=",
      "-c", "filter.included.required=false", "-c", "filter.wt.required=false", "-c", "filter.evil.required=false",
    ]));
  });

  it("ignores system and global filters in the listing, so the command must run in the same isolated environment", async () => {
    const globalConfig = join(root, "global.gitconfig");
    await writeFile(globalConfig, `[filter "globalone"]\n\tclean = touch ${marker}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    expect(await filterOverrides(repo)).toEqual([]);
    // The filter-free runner uses the isolated environment, so the global filter does not run either.
    await writeFile(join(repo, ".gitattributes"), "*.txt filter=globalone\n");
    await writeFile(join(repo, "a.txt"), SAME_SIZE_EDIT);
    await runFilterFreeGit(repo, ["status", "--porcelain"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed instead of leaving filters active when there are more than the safety cap", async () => {
    const lines = Array.from({ length: MAX_FILTER_OVERRIDES + 1 }, (_, index) => `[filter "f${index}"]\n\tclean = true\n`).join("");
    await writeFile(join(repo, ".git", "config"), `${await readFile(join(repo, ".git", "config"), "utf8")}${lines}`);
    await expect(filterOverrides(repo)).rejects.toBeInstanceOf(TooManyGitFiltersError);
    await expect(filterOverrides(repo)).rejects.toThrow(/more than 256 Git filters/);
    // Every caller inherits the failure: no Git command runs with the remaining filters active.
    await expect(runFilterFreeGit(repo, ["status"], { timeout: 5000, maxBuffer: 1024 * 1024 })).rejects.toBeInstanceOf(TooManyGitFiltersError);
    await expect(createWorktree({
      ...await validateCwd(repo, []), jobId: "cap-job", mode: "write", worktreesDir: join(root, "wt"), locksDir: join(root, "locks"),
    })).rejects.toMatchObject({ code: "WORKTREE_ERROR", message: expect.stringMatching(/more than 256 Git filters/) });
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed for a filter whose name contains '=' (a -c override would split it at the first '=')", async () => {
    await writeFile(join(repo, ".gitattributes"), "*.txt filter=a=b\n");
    git(repo, "config", "filter.a=b.clean", evilCommand());
    await writeFile(join(repo, "a.txt"), SAME_SIZE_EDIT);
    await expect(filterOverrides(repo)).rejects.toBeInstanceOf(UnblankableGitFilterError);
    await expect(runFilterFreeGit(repo, ["status", "--porcelain"], { timeout: 5000, maxBuffer: 1024 * 1024 }))
      .rejects.toBeInstanceOf(UnblankableGitFilterError);
    expect(await validateCwd(repo, [])).toMatchObject({ isGitRepo: true, isDirty: undefined });
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs a filter configured in a submodule's own repository", async () => {
    const lib = join(root, "lib");
    await mkdir(lib);
    git(lib, "init", "-q");
    await writeFile(join(lib, ".gitattributes"), "*.txt filter=sub\n");
    await writeFile(join(lib, "s.txt"), "base\n");
    git(lib, "add", ".");
    git(lib, "-c", "filter.sub.clean=cat", "commit", "-qm", "lib");
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "sub");
    git(repo, "commit", "-qm", "add submodule");
    const subGitDir = git(join(repo, "sub"), "rev-parse", "--absolute-git-dir");
    git(join(repo, "sub"), "config", "--file", join(subGitDir, "config"), "filter.sub.clean", evilCommand());
    await writeFile(join(repo, "sub", "s.txt"), SAME_SIZE_EDIT);

    // Control: plain Git does run the submodule's filter, so the assertions below prove something.
    git(repo, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    await rm(marker);

    await validateCwd(repo, []);
    await treeFingerprint(repo, repo, "job-sub");
    await snapshotWorkspace(repo, repo, "", "job-sub");
    await runFilterFreeGit(repo, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD"], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const { worktree } = await createWorktree({
      ...await validateCwd(repo, []), jobId: "sub-job", mode: "write", worktreesDir: join(root, "wt"), locksDir: join(root, "locks"),
    });
    await inspectWorktree(worktree, 4096);
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs a repository filter from validateCwd, the runner snapshots or worktree inspection", async () => {
    git(repo, "config", "filter.evil.clean", evilCommand());
    git(repo, "config", "filter.evil.process", evilCommand());
    await writeFile(join(repo, "a.txt"), SAME_SIZE_EDIT);
    await writeFile(join(repo, "b.txt"), "untracked content\n");

    // Control: plain Git runs the filter on this checkout, so the assertions below prove the service never does.
    git(repo, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    await rm(marker);

    expect(await validateCwd(repo, [])).toMatchObject({ isGitRepo: true, isDirty: true });
    expect(await treeFingerprint(repo, repo, "job-1")).toMatchObject({ clean: false });
    expect((await snapshotWorkspace(repo, repo, "", "job-1"))?.has("a.txt")).toBe(true);
    expect(existsSync(marker)).toBe(false);

    const { worktree } = await createWorktree({
      ...await validateCwd(repo, []), jobId: "inspect-job", mode: "write", worktreesDir: join(root, "wt"), locksDir: join(root, "locks"),
    });
    await writeFile(join(worktree.path, "a.txt"), SAME_SIZE_EDIT);
    expect(await inspectWorktree(worktree, 4096)).toMatchObject({ dirty: true, changed_files: ["a.txt"] });
    expect(existsSync(marker)).toBe(false);
  });

  it("marks every job-scoped Git subprocess with ORCH_JOB_ID and runs the resolved executable", async () => {
    const wrapperDir = join(root, "wrapper");
    const log = join(root, "git-env.log");
    await mkdir(wrapperDir);
    await writeFile(join(wrapperDir, "git"), `#!/bin/sh\necho "job=$ORCH_JOB_ID" >> ${log}\nexec ${REAL_GIT} "$@"\n`);
    await chmod(join(wrapperDir, "git"), 0o755);
    vi.stubEnv("PATH", `${wrapperDir}${delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("ORCH_JOB_ID", "");

    await validateCwd(repo, [], "job-validate");
    await treeFingerprint(repo, repo, "job-fingerprint");
    await snapshotWorkspace(repo, repo, "", "job-snapshot");

    const lines = (await readFile(log, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThan(6);
    for (const prefix of ["job-validate", "job-fingerprint", "job-snapshot"]) {
      expect(lines).toContain(`job=${prefix}`);
    }
    expect(lines.every((line) => /^job=job-(validate|fingerprint|snapshot)$/.test(line))).toBe(true);
  });
});
