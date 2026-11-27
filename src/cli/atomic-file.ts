import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
/** Backups kept per file; older ones are deleted after each new backup. */
export const MAX_BACKUPS = 5;
const MAX_BACKUP_COLLISIONS = 1000;

export interface AtomicWriteOptions {
  /**
   * Create a `<file>.bak.<timestamp>` copy before replacing an existing file. The copy sits next to the path the caller named,
   * so a config symlinked into a dotfiles repository never gets secret-bearing backups inside that repository. Only the
   * newest `MAX_BACKUPS` copies of the file are kept.
   */
  backup: boolean;
  /** Clock used for the backup suffix (tests inject a fixed date). */
  now?: () => Date;
  /** Mode for a file that does not exist yet (defaults to private 0600). */
  newFileMode?: number;
  /**
   * The content the new text was derived from (`null` = the file must not exist yet). If the file differs when the
   * write is about to happen, nothing is written, so a concurrent writer's changes are never silently lost.
   */
  expectedText?: string | null;
}

export interface AtomicWriteResult {
  /** The real file that was replaced (symlinks are followed). */
  target: string;
  backupPath?: string;
  created: boolean;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** Resolves a (possibly symlinked) config path to the real file. Dangling symlinks are rejected, never recreated. */
export async function resolveWriteTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  let info;
  try {
    info = await lstat(absolute);
  } catch (error) {
    if (isNotFound(error)) return absolute;
    throw error;
  }
  if (!info.isSymbolicLink()) return absolute;
  try {
    return await realpath(absolute);
  } catch (error) {
    if (isNotFound(error)) throw new Error(`${absolute} is a dangling symlink; refusing to write through it.`);
    throw error;
  }
}

function backupSuffix(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

/**
 * A free backup name for `now`. When backups with the same timestamp exist, the counter goes one past the highest one (not
 * the first free number), so rotation freeing a low number can never make a newer backup sort before an older one.
 */
async function uniqueBackupPath(location: string, now: Date): Promise<string> {
  const base = `${location}.bak.${backupSuffix(now)}`;
  const prefix = basename(base);
  let highest = -1;
  for (const entry of await readdir(dirname(location))) {
    if (entry === prefix) highest = Math.max(highest, 0);
    else if (entry.startsWith(`${prefix}-`) && /^\d+$/.test(entry.slice(prefix.length + 1))) highest = Math.max(highest, Number(entry.slice(prefix.length + 1)));
  }
  if (highest >= MAX_BACKUP_COLLISIONS) throw new Error(`Could not pick a free backup name next to ${location}.`);
  return highest < 0 ? base : `${base}-${highest + 1}`;
}

/** Sort key of a backup suffix `<timestamp>[-<counter>]`; timestamps compare lexically, collision counters numerically. */
function backupOrder(suffix: string): [string, number] {
  const [timestamp, counter] = suffix.split("-");
  return [timestamp, counter === undefined ? 0 : Number(counter)];
}

/** Deletes all but the newest `MAX_BACKUPS` backups of `location` (never `keep`, the one just made). Best effort: failures are ignored. */
async function rotateBackups(location: string, keep: string): Promise<void> {
  const name = basename(location);
  const prefix = `${name}.bak.`;
  try {
    const others = (await readdir(dirname(location)))
      .filter((entry) => entry.startsWith(prefix) && /^\d{8}T\d+Z(?:-\d+)?$/.test(entry.slice(prefix.length)) && join(dirname(location), entry) !== keep)
      .sort((left, right) => {
        const [leftTime, leftCount] = backupOrder(left.slice(prefix.length));
        const [rightTime, rightCount] = backupOrder(right.slice(prefix.length));
        return leftTime === rightTime ? leftCount - rightCount : leftTime < rightTime ? -1 : 1;
      });
    await Promise.all(others.slice(0, Math.max(0, others.length - (MAX_BACKUPS - 1))).map((entry) => rm(join(dirname(location), entry), { force: true }).catch(() => undefined)));
  } catch {
    // Rotation is housekeeping; a failure must never fail the write.
  }
}

/**
 * Replaces `path` with `content` atomically: temp file in the same directory, then rename.
 * Preserves the mode of an existing file (0600 for new ones) and backs up the previous bytes privately.
 */
export async function atomicWriteFile(path: string, content: string, options: AtomicWriteOptions): Promise<AtomicWriteResult> {
  const target = await resolveWriteTarget(path);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIR_MODE });

  let mode = options.newFileMode ?? PRIVATE_FILE_MODE;
  let created = true;
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`${target} exists and is not a regular file.`);
    mode = info.mode & 0o777;
    created = false;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const assertUnchanged = async (): Promise<void> => {
    if (options.expectedText === undefined) return;
    const current = await readTextIfExists(target);
    if ((current ?? null) !== options.expectedText) {
      throw new Error(`${target} changed while it was being edited; nothing was written. Re-run the command.`);
    }
  };
  await assertUnchanged();

  let backupPath: string | undefined;
  if (!created && options.backup) {
    // Next to the named path, not the symlink target: the target may live in a git-tracked dotfiles directory.
    backupPath = await uniqueBackupPath(resolve(path), (options.now ?? (() => new Date()))());
    await copyFile(target, backupPath, constants.COPYFILE_EXCL);
    const handle = await open(backupPath, "r+");
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
    } finally {
      await handle.close();
    }
    await rotateBackups(resolve(path), backupPath);
  }

  const temp = join(directory, `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  try {
    const handle = await open(temp, "wx", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertUnchanged();
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { target, backupPath, created };
}

/** Reads a UTF-8 file, returning undefined when it does not exist. */
export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

/** Real path of the longest existing prefix plus the not-yet-existing tail; makes symlinked duplicates comparable. */
export async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch (error) {
      const parent = dirname(current);
      if (!isNotFound(error) || parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}
