import { describe, expect, it } from "vitest";
import { deriveSessionKey, sessionDisplayId } from "../../src/runtime/session-key.js";

const WORKTREES = "/state/worktrees";

describe("deriveSessionKey", () => {
  const plainDir = { realCwd: "/work/notes" };
  const repo = { realCwd: "/work/app/pkg", gitTopLevel: "/work/app", gitCommonDir: "/work/app/.git" };

  it("uses one key for the whole host in global scope", () => {
    expect(deriveSessionKey({ scope: "global", cwd: repo, worktreesDir: WORKTREES })).toBe("global");
    expect(deriveSessionKey({ scope: "global", cwd: plainDir, contextId: "task-1" })).toBe("global");
  });

  it("keys a repository by its git top level, whatever sub-directory the job runs in", () => {
    expect(deriveSessionKey({ scope: "repo", cwd: repo, worktreesDir: WORKTREES })).toBe("repo:/work/app");
    expect(deriveSessionKey({ scope: "repo", cwd: { ...repo, realCwd: "/work/app" }, worktreesDir: WORKTREES })).toBe("repo:/work/app");
  });

  it("keys a directory outside git by its real path", () => {
    expect(deriveSessionKey({ scope: "repo", cwd: plainDir, worktreesDir: WORKTREES })).toBe("dir:/work/notes");
  });

  it.each([
    ["a regular checkout", "/state/worktrees/job-1/app", "/work/app/.git", "repo:/work/app"],
    ["a Windows-style common dir", "/state/worktrees/job-1/app", "C:\\work\\app\\.git", "repo:C:\\work\\app"],
    ["a bare repository", "/state/worktrees/job-1/app", "/srv/app.git", "repo:/srv/app.git"],
  ])("folds an orchestrator worktree of %s back into its main repository", (_name, realCwd, gitCommonDir, expected) => {
    const worktree = { realCwd, gitTopLevel: realCwd, gitCommonDir };
    expect(deriveSessionKey({ scope: "repo", cwd: worktree, worktreesDir: WORKTREES })).toBe(expected);
  });

  it("does not treat a checkout outside the worktrees directory as a worktree", () => {
    const sibling = { realCwd: "/state/worktrees-other/app", gitTopLevel: "/state/worktrees-other/app", gitCommonDir: "/work/app/.git" };
    expect(deriveSessionKey({ scope: "repo", cwd: sibling, worktreesDir: WORKTREES })).toBe("repo:/state/worktrees-other/app");
  });

  it("falls back to the top level when a path inside the worktrees directory has no common dir", () => {
    const odd = { realCwd: "/state/worktrees/loose", gitTopLevel: "/state/worktrees/loose" };
    expect(deriveSessionKey({ scope: "repo", cwd: odd, worktreesDir: WORKTREES })).toBe("repo:/state/worktrees/loose");
  });

  it("keys by context_id in context scope and trims it", () => {
    expect(deriveSessionKey({ scope: "context", contextId: "  task-7 ", cwd: repo, worktreesDir: WORKTREES })).toBe("ctx:task-7");
  });

  it.each([undefined, "", "   "])("falls back to the repository key in context scope when context_id is %j", (contextId) => {
    expect(deriveSessionKey({ scope: "context", contextId, cwd: repo, worktreesDir: WORKTREES })).toBe("repo:/work/app");
    expect(deriveSessionKey({ scope: "context", contextId, cwd: plainDir })).toBe("dir:/work/notes");
  });
});

describe("sessionDisplayId", () => {
  it("is a stable 12-character hex label that does not reveal the path", () => {
    const id = sessionDisplayId("repo:/work/secret-project");
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(sessionDisplayId("repo:/work/secret-project")).toBe(id);
    expect(id).not.toContain("secret");
  });

  it("differs between sessions", () => {
    expect(sessionDisplayId("repo:/a")).not.toBe(sessionDisplayId("repo:/b"));
  });
});
