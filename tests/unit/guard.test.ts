import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBinary } from "../../src/adapters/probe-utils.js";
import { allowedRootsFromEnv, buildChildEnv, checkRecursionLimit, getCurrentOrchDepth, validateCwd } from "../../src/runtime/guard.js";

describe("orchestration depth", () => {
  it("defaults to zero, increments in the child and blocks at the limit", () => {
    expect(getCurrentOrchDepth({})).toBe(0);
    expect(checkRecursionLimit(1, {})).toBeNull();
    const child = buildChildEnv({ baseEnv: {}, nextDepth: 1, jobId: "job-a" });
    expect(getCurrentOrchDepth(child)).toBe(1);
    expect(checkRecursionLimit(1, child)).toMatchObject({ code: "RECURSION_BLOCKED" });
    // ORCH_MAX_DEPTH can only tighten the configured limit, never raise it.
    expect(checkRecursionLimit(2, { ...child, ORCH_MAX_DEPTH: "2" })).toBeNull();
    expect(checkRecursionLimit(1, { ...child, ORCH_MAX_DEPTH: "2" })).toMatchObject({ code: "RECURSION_BLOCKED" });
    expect(checkRecursionLimit(2, { ...child, ORCH_MAX_DEPTH: "1" })).toMatchObject({ code: "RECURSION_BLOCKED" });
    expect(checkRecursionLimit(1, { ORCH_MAX_DEPTH: "0" })).toMatchObject({ code: "RECURSION_BLOCKED" });
  });

  it("passes the tighter depth limit to the child and splits allowed roots by the platform delimiter", () => {
    expect(buildChildEnv({ baseEnv: { ORCH_MAX_DEPTH: "5" }, nextDepth: 1, jobId: "j", maxDepth: 2 }).ORCH_MAX_DEPTH).toBe("2");
    expect(buildChildEnv({ baseEnv: { ORCH_MAX_DEPTH: "1" }, nextDepth: 1, jobId: "j", maxDepth: 2 }).ORCH_MAX_DEPTH).toBe("1");
    expect(buildChildEnv({ baseEnv: {}, nextDepth: 1, jobId: "j" })).not.toHaveProperty("ORCH_MAX_DEPTH");
    expect(allowedRootsFromEnv({ ORCH_ALLOWED_ROOTS: ["/a", "", "/b c"].join(delimiter) })).toEqual(["/a", "/b c"]);
  });

  it.each(["", "-1", "1.5", "2junk", "9007199254740992"])("treats malformed depth %j as blocked", (value) => {
    expect(checkRecursionLimit(2, { ORCH_DEPTH: value })).toMatchObject({ code: "RECURSION_BLOCKED" });
    expect(checkRecursionLimit(2, { ORCH_DEPTH: "2", ORCH_MAX_DEPTH: value }))
      .toMatchObject({ code: "RECURSION_BLOCKED" });
  });

  it("preserves proxy, CA, CLI and home variables while setting authoritative job markers", () => {
    const base = {
      HTTPS_PROXY: "https://example.invalid", HTTP_PROXY: "http://example.invalid", NO_PROXY: "localhost",
      https_proxy: "https://example.invalid:1234", http_proxy: "http://example.invalid:1234", no_proxy: ".invalid",
      SSL_CERT_FILE: "/cert.pem", NODE_EXTRA_CA_CERTS: "/node.pem", REQUESTS_CA_BUNDLE: "/requests.pem",
      CURL_CA_BUNDLE: "/curl.pem", PATH: "/bin", HOME: "/home/test", USER: "test", XDG_CONFIG_HOME: "/config",
      ANTHROPIC_API_KEY: "fake-anthropic", OPENAI_API_KEY: "fake-openai", CODEX_HOME: "/codex",
      DEEPSEEK_API_KEY: "fake-deepseek", DSH_PROFILE: "test", PI_CODING_AGENT_DIR: "/pi", CLAUDE_CONFIG_DIR: "/claude",
    };
    expect(buildChildEnv({
      baseEnv: base, nextDepth: 2, jobId: "job-b",
      extra: { ORCH_JOB_ID: "spoofed", ORCH_DEPTH: "0", PI_OPTION: "enabled" },
    })).toEqual({ ...base, ORCH_DEPTH: "2", ORCH_JOB_ID: "job-b", ORCH_JOB_CHAIN: "job-b", PI_OPTION: "enabled" });
    expect(base).not.toHaveProperty("ORCH_DEPTH");
  });

  it("appends the job to the inherited ancestry, keeping ORCH_JOB_ID and ignoring spoofed or malformed chains", () => {
    const inherited = buildChildEnv({ baseEnv: { ORCH_JOB_ID: "outer", ORCH_JOB_CHAIN: "root,outer" }, nextDepth: 2, jobId: "inner" });
    expect(inherited).toMatchObject({ ORCH_JOB_ID: "inner", ORCH_JOB_CHAIN: "root,outer,inner" });
    expect(buildChildEnv({ baseEnv: { ORCH_JOB_CHAIN: "ok,,bad token,a/b,-x,fine" }, nextDepth: 1, jobId: "j" }).ORCH_JOB_CHAIN)
      .toBe("ok,fine,j");
    expect(buildChildEnv({ baseEnv: {}, nextDepth: 1, jobId: "j", extra: { ORCH_JOB_CHAIN: "spoofed" } }).ORCH_JOB_CHAIN).toBe("j");
  });

  it("removes repository-local Git variables so a hook cannot redirect Git in the job's checkout", () => {
    const env = buildChildEnv({
      baseEnv: { GIT_DIR: "/hook/.git", GIT_WORK_TREE: "/hook", GIT_INDEX_FILE: "/hook/.git/index", GIT_AUTHOR_NAME: "keep", HOME: "/h" },
      nextDepth: 1, jobId: "j",
    });
    expect(env).not.toHaveProperty("GIT_DIR");
    expect(env).not.toHaveProperty("GIT_WORK_TREE");
    expect(env).not.toHaveProperty("GIT_INDEX_FILE");
    expect(env).toMatchObject({ GIT_AUTHOR_NAME: "keep", HOME: "/h" });
  });
});

describe("working directory validation", () => {
  let root: string;

  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "orch-guard-"))); });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("allows canonical descendants and blocks sibling-prefix and symlink escapes", async () => {
    const allowed = join(root, "allowed");
    const outside = join(root, "allowed-sibling");
    await Promise.all([mkdir(join(allowed, "nested"), { recursive: true }), mkdir(outside)]);
    await Promise.all([
      symlink(outside, join(allowed, "escape"), "dir"),
      symlink(allowed, join(root, "alias"), "dir"),
    ]);
    vi.stubEnv("ORCH_ALLOWED_ROOTS", `${delimiter}${join(root, "alias")}${delimiter}${join(root, "missing")}${delimiter}`);
    await expect(validateCwd(join(allowed, "nested"))).resolves.toEqual({
      realCwd: join(allowed, "nested"), isGitRepo: false,
    });
    await expect(validateCwd(outside)).rejects.toMatchObject({ code: "INVALID_CWD" });
    await expect(validateCwd(join(allowed, "escape"), [allowed])).rejects.toMatchObject({ code: "INVALID_CWD" });
  });

  it("rejects empty paths, missing paths and regular files", async () => {
    const file = join(root, "file.txt");
    await writeFile(file, "");
    for (const cwd of ["", "   ", join(root, "missing"), file]) {
      await expect(validateCwd(cwd, [])).rejects.toMatchObject({ code: "INVALID_CWD" });
    }
  });

  it("returns canonical Git paths, nested cwd and the dirty status", async () => {
    const nested = join(root, "with spaces");
    await mkdir(nested);
    execFileSync("git", ["init", "-q", root]);
    vi.stubEnv("GIT_DIR", join(root, "wrong"));
    await expect(validateCwd(nested, [root])).resolves.toEqual({
      realCwd: nested, isGitRepo: true, gitTopLevel: root, gitCommonDir: join(root, ".git"),
      relativeCwd: "with spaces", isDirty: false,
    });
    await writeFile(join(nested, "untracked.txt"), "only in the parent");
    await expect(validateCwd(nested, [])).resolves.toMatchObject({ isDirty: true });
  });

  it.skipIf(process.platform === "win32")("keeps validating when the dirty-status probe overflows its output buffer", async () => {
    execFileSync("git", ["init", "-q", root]);
    const realGit = resolveBinary("git");
    expect(realGit).toBeDefined();
    const bin = join(root, "bin");
    await mkdir(bin);
    // `git status` prints far more than the probe buffer holds; every other command runs the real git.
    await writeFile(join(bin, "git"), `#!/bin/sh
case "$*" in
  *" status "*) head -c 5000000 /dev/zero | tr '\\0' x; exit 0 ;;
esac
exec "${realGit}" "$@"
`);
    await chmod(join(bin, "git"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    const validated = await validateCwd(root, []);
    expect(validated).toMatchObject({ isGitRepo: true, gitTopLevel: root });
    expect(validated.isDirty).toBeUndefined();
  });
});
