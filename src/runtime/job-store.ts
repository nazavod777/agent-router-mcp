import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getRunsDir } from "../config/paths.js";
import type { JobRecord, JobStatus, ProgressCheckpoint } from "../types.js";
import { utf8PrefixLength } from "./output.js";

const MAX_READ_BYTES = 24_000;
const SAFE_JOB_DIR_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const DAY_MS = 86_400_000;
const LIVE_JOB_GRACE_MS = DAY_MS;
/** Only these statuses prove a run is finished; anything else (missing, unknown, queued, running) may still be live. */
const TERMINAL_STATUSES: ReadonlySet<unknown> = new Set<JobStatus>(["completed", "failed", "timed_out", "cancelled"]);
const MAX_META_BYTES = 262_144;
/** Persisted `worktree.changed_files` is capped so `meta.json` stays far below `MAX_META_BYTES`. */
const MAX_PERSISTED_FILES_BYTES = 128 * 1024;
const WORKTREE_REF_FILE = "worktree-ref.json";
const MAX_WORKTREE_REF_BYTES = 16_384;
const MAX_UTF8_CHAR_BYTES = 4;
/** `O_NOFOLLOW` and `O_NONBLOCK` do not exist on every platform; the regular-file check still applies there. */
const SAFE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const MAX_SCAN_DEPTH = 4;
const LOG_FILES = {
  summary: "result.md",
  stdout: "stdout.log",
  stderr: "stderr.log",
  diff: "diff.patch",
  checkpoint: "checkpoint.json",
} as const;

export type LogPart = keyof typeof LOG_FILES | "files";

/**
 * Tiny, guaranteed-bounded record of the two facts that keep a live worktree's run directory alive: the job status and
 * the worktree path. It survives a `meta.json` that is unreadable or over the size cap.
 */
export interface WorktreeRef {
  status: JobStatus;
  worktree_path: string;
}

export interface LogChunk {
  job_id: string;
  part: LogPart;
  text: string;
  offset_bytes: number;
  next_offset_bytes: number;
  total_bytes: number;
  eof: boolean;
}

export interface PruneRunsOptions {
  /** Delete finished runs older than this many days; 0 disables age-based pruning. */
  retentionDays: number;
  /** Keep the total size of finished runs under this many bytes (oldest first); 0 disables size-based pruning. */
  maxTotalBytes: number;
  /** Jobs owned by this process that must never be pruned. */
  activeJobIds?: ReadonlySet<string>;
  now?: number;
  /** Stops scanning and removing as soon as it is aborted; already removed runs stay removed. */
  signal?: AbortSignal;
}

export interface PruneRunsResult {
  removed: number;
  freedBytes: number;
}

interface PruneCandidate {
  dir: string;
  bytes: number;
  timestamp: number;
}

interface DirectoryUsage {
  /** Sum of regular file sizes below the directory; symbolic links are neither followed nor counted. */
  bytes: number;
  /** Newest mtime of the directory and the files and directories below it. */
  latestMtimeMs: number;
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPath(error)) return false;
    return true; // Unknown state: treat as present so nothing is deleted by mistake.
  }
}

/**
 * Opens a persisted artifact without following a symbolic link and without blocking on a FIFO, and checks that the opened
 * descriptor is a regular file. The caller closes the handle.
 */
async function openRegularFile(path: string): Promise<{ handle: FileHandle; size: number }> {
  const handle = await open(path, SAFE_READ_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Object.assign(new Error(`Not a regular file: ${path}`), { code: "ENOTREG" });
    return { handle, size: info.size };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Reads a whole regular file of at most `maxBytes`; a larger file, a link, a FIFO or any other kind of entry is refused. */
async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  const { handle, size } = await openRegularFile(path);
  try {
    if (size > maxBytes) throw Object.assign(new Error(`File exceeds ${maxBytes} bytes: ${path}`), { code: "EFBIG" });
    const bytes = Buffer.allocUnsafe(size);
    let length = 0;
    while (length < size) {
      const { bytesRead } = await handle.read(bytes, length, size - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function readBoundedJson(path: string, maxBytes: number): Promise<unknown> {
  return JSON.parse((await readBoundedFile(path, maxBytes)).toString("utf8"));
}

/** Reads `meta.json` only when it is a small regular file; anything else counts as unreadable metadata. */
async function readMeta(dir: string): Promise<Partial<JobRecord> | undefined> {
  try {
    const parsed = await readBoundedJson(join(dir, "meta.json"), MAX_META_BYTES);
    return typeof parsed === "object" && parsed !== null ? (parsed as Partial<JobRecord>) : undefined;
  } catch {
    return undefined;
  }
}

async function readWorktreeRef(dir: string): Promise<WorktreeRef | undefined> {
  try {
    const parsed = await readBoundedJson(join(dir, WORKTREE_REF_FILE), MAX_WORKTREE_REF_BYTES) as Partial<WorktreeRef> | null;
    return parsed && typeof parsed.worktree_path === "string" && parsed.worktree_path
      ? { status: parsed.status as JobStatus, worktree_path: parsed.worktree_path } : undefined;
  } catch {
    return undefined;
  }
}

/** `changed_files` fitted to a byte budget; a final entry says how many paths were left out. */
function capChangedFiles(files: readonly string[]): string[] {
  let used = 0;
  const kept: string[] = [];
  for (const file of files) {
    const cost = Buffer.byteLength(file) + 4;
    if (used + cost > MAX_PERSISTED_FILES_BYTES) break;
    used += cost;
    kept.push(file);
  }
  return kept.length === files.length ? kept : [...kept, `[... ${files.length - kept.length} more file(s) omitted ...]`];
}

/** Measures a run directory without following symbolic links, to a bounded depth. */
async function measureDirectory(dir: string, initialMtimeMs: number, signal?: AbortSignal): Promise<DirectoryUsage> {
  const usage: DirectoryUsage = { bytes: 0, latestMtimeMs: initialMtimeMs };
  async function visit(path: string, depth: number): Promise<void> {
    let names: string[];
    try {
      names = await readdir(path);
    } catch {
      return; // The directory vanished or is unreadable; it does not count.
    }
    for (const name of names) {
      if (signal?.aborted) return;
      try {
        const info = await lstat(join(path, name));
        if (info.isFile()) {
          usage.bytes += info.size;
          usage.latestMtimeMs = Math.max(usage.latestMtimeMs, info.mtimeMs);
        } else if (info.isDirectory() && depth < MAX_SCAN_DEPTH) {
          usage.latestMtimeMs = Math.max(usage.latestMtimeMs, info.mtimeMs);
          await visit(join(path, name), depth + 1);
        }
      } catch {
        // The entry vanished or is unreadable; it does not count.
      }
    }
  }
  await visit(dir, 1);
  return usage;
}

export class LogBudget {
  readonly maxBytes: number;
  remainingBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, Math.floor(maxBytes));
    this.remainingBytes = this.maxBytes;
  }
}

export class BoundedLogWriter {
  truncated = false;

  constructor(private readonly file: FileHandle, private readonly budget: LogBudget) {}

  async append(chunk: Buffer): Promise<void> {
    if (this.truncated || chunk.length === 0) return;
    const keep = utf8PrefixLength(chunk, this.budget.remainingBytes);
    this.budget.remainingBytes -= keep;
    if (keep > 0) await this.file.writeFile(chunk.subarray(0, keep));
    if (keep < chunk.length) await this.markTruncated();
  }

  async markTruncated(): Promise<void> {
    if (this.truncated) return;
    this.truncated = true;
    await this.file.writeFile(`\n[... log truncated at ${this.budget.maxBytes} bytes ...]\n`);
  }

  async close(): Promise<void> {
    await this.file.close();
  }
}

function cappedInteger(value: number, max: number): number {
  return Number.isNaN(value) ? 0 : Math.min(max, Math.max(0, Math.floor(value)));
}

/** Bytes of the UTF-8 sequence that starts `bytes[0]`, never more than `bytes.length`. */
function firstCharLength(bytes: Buffer): number {
  let length = 1;
  while (length < bytes.length && length < MAX_UTF8_CHAR_BYTES && (bytes[length] & 0xc0) === 0x80) length++;
  return length;
}

/**
 * One page of a log. Both ends of the page sit on character boundaries, so a multi-byte character is never split
 * between two cursors: a start offset inside a character moves forward to the next boundary, and a limit smaller than
 * the next character returns that whole character (the cursor still advances).
 */
function logChunk(
  jobId: string, part: LogPart, bytes: Buffer, offset: number, limit: number, total: number,
): LogChunk {
  let skipped = 0;
  if (offset > 0) {
    while (skipped < bytes.length && skipped < MAX_UTF8_CHAR_BYTES - 1 && (bytes[skipped] & 0xc0) === 0x80) skipped++;
  }
  const page = bytes.subarray(skipped);
  const start = offset + skipped;
  const end = utf8PrefixLength(page, limit) || (page.length > 0 && limit > 0 ? firstCharLength(page) : 0);
  const next = start + end;
  return {
    job_id: jobId,
    part,
    text: page.subarray(0, end).toString("utf8"),
    offset_bytes: start,
    next_offset_bytes: next,
    total_bytes: total,
    eof: next >= total,
  };
}

export class JobStore {
  private readonly runsDir: string;

  constructor(runsDir = getRunsDir()) {
    this.runsDir = resolve(runsDir);
  }

  getJobDir(jobId: string): string {
    if (!SAFE_JOB_DIR_NAME.test(jobId)) throw new Error("Invalid job ID.");
    return join(this.runsDir, jobId);
  }

  async initialize(jobId: string): Promise<void> {
    await mkdir(this.runsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.getJobDir(jobId), { mode: 0o700 });
  }

  async openLog(jobId: string, part: "stdout" | "stderr", budget: LogBudget): Promise<BoundedLogWriter> {
    return new BoundedLogWriter(await open(join(this.getJobDir(jobId), LOG_FILES[part]), "wx", 0o600), budget);
  }

  /**
   * Writes `meta.json` (with `changed_files` capped) and, once the job has a worktree, the tiny `worktree-ref.json`
   * first, so even a `meta.json` that later grows unreadable can never make the run of a live worktree prunable.
   */
  async persistJobMeta(job: JobRecord): Promise<void> {
    const files = job.worktree?.changed_files;
    const persisted = job.worktree && files
      ? { ...job, worktree: { ...job.worktree, changed_files: capChangedFiles(files) } } : job;
    if (job.worktree?.path) {
      const ref: WorktreeRef = { status: job.status, worktree_path: job.worktree.path };
      await this.atomicWrite(job.job_id, WORKTREE_REF_FILE, JSON.stringify(ref) + "\n");
    }
    await this.atomicWrite(job.job_id, "meta.json", JSON.stringify(persisted, null, 2) + "\n");
  }

  async saveResult(jobId: string, text: string): Promise<void> {
    await this.atomicWrite(jobId, LOG_FILES.summary, text);
  }

  async saveDiff(jobId: string, diff: string): Promise<void> {
    await this.atomicWrite(jobId, LOG_FILES.diff, diff);
  }

  async saveCheckpoint(jobId: string, data: ProgressCheckpoint): Promise<void> {
    await this.atomicWrite(jobId, LOG_FILES.checkpoint, JSON.stringify(data, null, 2) + "\n");
  }

  /** Reads the saved checkpoint; a missing, oversized, or malformed file yields undefined. */
  async readCheckpoint(jobId: string): Promise<ProgressCheckpoint | undefined> {
    try {
      const parsed = await readBoundedJson(join(this.getJobDir(jobId), LOG_FILES.checkpoint), MAX_META_BYTES);
      if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as ProgressCheckpoint).tool_trail)) return undefined;
      return parsed as ProgressCheckpoint;
    } catch {
      return undefined;
    }
  }

  async readLogChunk(jobId: string, part: LogPart, offsetBytes = 0, limitBytes = MAX_READ_BYTES): Promise<LogChunk> {
    const dir = this.getJobDir(jobId);
    const offset = cappedInteger(offsetBytes, Number.MAX_SAFE_INTEGER);
    const limit = cappedInteger(limitBytes, MAX_READ_BYTES);
    try {
      if (part === "files") {
        const job = await readBoundedJson(join(dir, "meta.json"), MAX_META_BYTES) as Partial<JobRecord>;
        const bytes = Buffer.from((job.worktree?.changed_files ?? []).join("\n"));
        const start = Math.min(offset, bytes.length);
        return logChunk(jobId, part, bytes.subarray(start, start + limit + MAX_UTF8_CHAR_BYTES), start, limit, bytes.length);
      }

      const { handle: file, size } = await openRegularFile(join(dir, LOG_FILES[part]));
      try {
        const start = Math.min(offset, size);
        const bytes = Buffer.allocUnsafe(Math.min(size - start, limit + MAX_UTF8_CHAR_BYTES));
        const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
        return logChunk(jobId, part, bytes.subarray(0, bytesRead), start, limit, size);
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return logChunk(jobId, part, Buffer.alloc(0), 0, limit, 0);
    }
  }

  /**
   * Removes old finished job directories from runs/. Skips jobs owned by this process, runs whose status is not an explicit
   * terminal one (queued, running, unknown or missing) and whose files changed recently (possibly owned by another
   * process), directories with unreadable metadata that changed recently, and any job whose worktree still exists on
   * disk. Skipped directories still count toward the size cap.
   * Never throws for one bad entry.
   */
  async pruneOldRuns(options: PruneRunsOptions): Promise<PruneRunsResult> {
    const { retentionDays, maxTotalBytes, activeJobIds, signal } = options;
    const none: PruneRunsResult = { removed: 0, freedBytes: 0 };
    if (retentionDays <= 0 && maxTotalBytes <= 0) return none;
    const now = options.now ?? Date.now();

    let entries: Dirent[];
    try {
      entries = await readdir(this.runsDir, { withFileTypes: true });
    } catch (error) {
      if (isMissingPath(error)) return none;
      throw error;
    }

    const candidates: PruneCandidate[] = [];
    let protectedBytes = 0;
    for (const entry of entries) {
      if (signal?.aborted) return none;
      if (!entry.isDirectory() || !SAFE_JOB_DIR_NAME.test(entry.name)) continue;
      const dir = join(this.runsDir, entry.name);
      try {
        const dirInfo = await lstat(dir);
        const usage = await measureDirectory(dir, dirInfo.mtimeMs, signal);
        if (signal?.aborted) return none;
        if (activeJobIds?.has(entry.name)) {
          protectedBytes += usage.bytes;
          continue;
        }
        const [meta, ref] = await Promise.all([readMeta(dir), readWorktreeRef(dir)]);
        // Only an explicit terminal status proves the run is over; missing metadata or an unknown status may belong to
        // a live job in another process. The sidecar still answers when `meta.json` is oversized or unreadable.
        const status = meta?.status ?? ref?.status;
        const worktreePath = meta?.worktree?.path ?? ref?.worktree_path;
        const maybeLive = !TERMINAL_STATUSES.has(status);
        const keep = (maybeLive && now - usage.latestMtimeMs < LIVE_JOB_GRACE_MS) ||
          (worktreePath !== undefined && await pathExists(worktreePath)) ||
          // A worktree reference with unreadable metadata is never pruned on a guess: the run may still be live.
          (meta === undefined && ref !== undefined && !TERMINAL_STATUSES.has(ref.status));
        if (keep) {
          protectedBytes += usage.bytes;
          continue;
        }
        const timestamp = Date.parse(meta?.finished_at ?? meta?.created_at ?? "") || usage.latestMtimeMs;
        candidates.push({ dir, bytes: usage.bytes, timestamp });
      } catch {
        // An unreadable entry is left alone.
      }
    }

    let removed = 0;
    let freedBytes = 0;
    const remove = async (candidate: PruneCandidate): Promise<boolean> => {
      if (signal?.aborted) return false;
      try {
        await rm(candidate.dir, { recursive: true, force: true });
        removed++;
        freedBytes += candidate.bytes;
        return true;
      } catch {
        return false; // One failed removal must not abort pruning.
      }
    };

    let remaining = candidates;
    if (retentionDays > 0) {
      const cutoffMs = retentionDays * DAY_MS;
      const kept: PruneCandidate[] = [];
      for (const candidate of remaining) {
        if (now - candidate.timestamp > cutoffMs && await remove(candidate)) continue;
        kept.push(candidate);
      }
      remaining = kept;
    }
    if (maxTotalBytes > 0) {
      let total = protectedBytes + remaining.reduce((sum, candidate) => sum + candidate.bytes, 0);
      for (const candidate of [...remaining].sort((left, right) => left.timestamp - right.timestamp)) {
        if (total <= maxTotalBytes || signal?.aborted) break;
        if (await remove(candidate)) total -= candidate.bytes;
      }
    }
    return { removed, freedBytes };
  }

  private async atomicWrite(jobId: string, name: string, content: string): Promise<void> {
    const path = join(this.getJobDir(jobId), name);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, content, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}
