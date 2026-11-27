import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile, canonicalPath } from "./atomic-file.js";

export const SKILL_FILE_NAME = "SKILL.md";
const SKILL_FILE_MODE = 0o644;

export type SkillStatus = "current" | "outdated" | "missing";
export type SkillAction = "created" | "updated" | "unchanged";

export function defaultSkillSourcePath(): string {
  return fileURLToPath(new URL("../../skills/orchestrate/SKILL.md", import.meta.url));
}

export interface SkillInspection {
  status: SkillStatus;
  /** Full path of the SKILL.md this status refers to. */
  path: string;
  /** Set when the location is unusable (for example a file sits where a directory must be). */
  error?: string;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Finds the nearest existing ancestor and fails when it is not a directory (a file in the way). */
async function assertDirectoryChain(directory: string): Promise<void> {
  let current = resolve(directory);
  for (;;) {
    try {
      const info = await stat(current);
      if (!info.isDirectory()) throw new Error(`${current} exists and is not a directory; move it away or choose another --dir.`);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new Error(`A parent of ${current} is a file, not a directory.`);
      if (!isMissing(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }
}

export async function inspectSkill(skillDir: string, sourcePath: string): Promise<SkillInspection> {
  const path = join(skillDir, SKILL_FILE_NAME);
  let installed: Buffer;
  try {
    installed = await readFile(path);
  } catch (error) {
    if (isMissing(error)) return { status: "missing", path };
    return { status: "missing", path, error: error instanceof Error ? error.message : String(error) };
  }
  const source = await readFile(sourcePath);
  return { status: installed.equals(source) ? "current" : "outdated", path };
}

export interface SkillInstallResult {
  path: string;
  action: SkillAction;
}

/** Copies the skill into `<skillDir>/SKILL.md` atomically. With `dryRun` nothing is created. Throws on unusable locations. */
export async function installSkillDir(skillDir: string, sourcePath: string, dryRun: boolean): Promise<SkillInstallResult> {
  const directory = resolve(skillDir);
  const path = join(directory, SKILL_FILE_NAME);
  await assertDirectoryChain(directory);
  try {
    if ((await stat(path)).isDirectory()) throw new Error(`${path} is a directory; expected a file.`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (await canonicalPath(path) === await canonicalPath(sourcePath)) return { path, action: "unchanged" };
  const { status } = await inspectSkill(directory, sourcePath);
  if (status === "current") return { path, action: "unchanged" };
  if (!dryRun) await atomicWriteFile(path, await readFile(sourcePath, "utf8"), { backup: false, newFileMode: SKILL_FILE_MODE });
  return { path, action: status === "missing" ? "created" : "updated" };
}
