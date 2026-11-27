import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { DefaultsConfig } from "../config/schema.js";
import { isInsidePath, type ValidatedCwd } from "./guard.js";

export type ConcurrencyScope = DefaultsConfig["concurrency_scope"];

const SESSION_ID_LENGTH = 12;
const GIT_DIR_SUFFIXES = ["/.git", "\\.git"];

export interface SessionKeyInput {
  scope: ConcurrencyScope;
  contextId?: string;
  cwd: Pick<ValidatedCwd, "realCwd" | "gitTopLevel" | "gitCommonDir">;
  /** Directory holding the orchestrator's job worktrees; a job running inside it belongs to the repository it was cut from. */
  worktreesDir?: string;
}

/**
 * Resolves symbolic links (for example macOS `/tmp` -> `/private/tmp`). A path that does not exist yet keeps its missing
 * tail: the nearest existing ancestor is resolved. Anything unresolvable stays as given.
 */
function canonicalPath(path: string): string {
  if (!isAbsolute(path)) return path; // For example a Windows path seen on POSIX: nothing to resolve here.
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

/** The main checkout root a git common dir belongs to; a bare repository (no `.git` suffix) is its own root. */
function repoRootOfCommonDir(commonDir: string): string {
  // Cut the suffix by hand: path.dirname() would not understand a Windows separator when running on POSIX.
  const suffix = GIT_DIR_SUFFIXES.find((candidate) => commonDir.endsWith(candidate));
  return suffix ? commonDir.slice(0, -suffix.length) : commonDir;
}

/**
 * The repository (or plain directory) a job belongs to. Every path is canonical, so the main checkout, an orchestrator
 * worktree cut from it and a symbolic-link spelling of either all share one key: worktrees fold back into their main
 * repository through the common dir, and a main checkout is keyed by the same common dir.
 */
function repoKey({ cwd, worktreesDir }: Pick<SessionKeyInput, "cwd" | "worktreesDir">): string {
  const realCwd = canonicalPath(cwd.realCwd);
  const commonDir = cwd.gitCommonDir === undefined ? undefined : canonicalPath(cwd.gitCommonDir);
  if (worktreesDir !== undefined && commonDir && isInsidePath(canonicalPath(worktreesDir), realCwd)) {
    return `repo:${repoRootOfCommonDir(commonDir)}`;
  }
  if (cwd.gitTopLevel) {
    const topLevel = canonicalPath(cwd.gitTopLevel);
    // A checkout whose common dir is its own `.git` has the same key as the worktrees cut from it.
    return `repo:${commonDir && repoRootOfCommonDir(commonDir) === topLevel ? repoRootOfCommonDir(commonDir) : topLevel}`;
  }
  return `dir:${realCwd}`;
}

/** Identity of the "session" whose jobs share one concurrency budget (`max_concurrency`). */
export function deriveSessionKey(input: SessionKeyInput): string {
  if (input.scope === "global") return "global";
  if (input.scope === "context") {
    const contextId = input.contextId?.trim();
    if (contextId) return `ctx:${contextId}`;
  }
  return repoKey(input);
}

/** Short, stable, non-reversible label for a session key; safe to show to the model without leaking local paths. */
export function sessionDisplayId(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, SESSION_ID_LENGTH);
}
