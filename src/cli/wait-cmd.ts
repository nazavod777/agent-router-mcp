import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { getRunsDir } from "../config/paths.js";
import type { ErrorCode, JobRecord, JobStatus } from "../types.js";
import { CLI_NAME } from "./name.js";

const DEFAULT_TIMEOUT_SEC = 1800;
const MAX_TIMEOUT_SEC = 7200;
const DEFAULT_SETTLE_MS = 1500;
const MAX_SETTLE_MS = 10_000;
const DEBOUNCE_MS = 20;
const SAFETY_CHECK_MS = 5000;
const READ_BATCH_SIZE = 16;
const JOB_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const TERMINAL_STATUSES = new Set<JobStatus>(["completed", "failed", "timed_out", "cancelled"]);
const META_FILE = "meta.json";

const USAGE = `Usage: ${CLI_NAME} wait --job <id> [--job <id> ...] [--until any|all]
                 [--timeout <sec>] [--settle-ms <ms>] [--state-dir <path>]

Accepts positional job IDs and comma-separated --job values.
Defaults: --until any, --timeout ${DEFAULT_TIMEOUT_SEC}, --settle-ms ${DEFAULT_SETTLE_MS}.
Use --help or -h to show this message.

Exit codes:
  0    a job finished (wake_reason "terminal" or "all_terminal")
  2    --timeout elapsed first (wake_reason "timeout"); jobs are still pending
  130  interrupted by SIGINT or SIGTERM (wake_reason "cancelled")
  1    invalid arguments or an unexpected error
The JSON result is printed in every case, so \`${CLI_NAME} wait --job X && next\` only continues after a finished job.`;

type WaitUntil = "any" | "all";
type WakeReason = "terminal" | "all_terminal" | "timeout" | "cancelled";

export interface WaitCliOptions {
  jobIds: readonly string[];
  until?: WaitUntil;
  timeoutSec?: number;
  settleMs?: number;
  stateDir?: string;
  signal?: AbortSignal;
}

interface WaitJob {
  job_id: string;
  status: JobStatus | "pending";
  harness?: string;
  model?: string;
  subtask_id?: string;
  plan_id?: string;
  exit_code?: number;
  error_code?: ErrorCode;
}

export interface WaitCliResult {
  wake_reason: WakeReason;
  until: WaitUntil;
  held_ms: number;
  pending_count: number;
  jobs: WaitJob[];
}

interface WatchedDirectory {
  watcher: FSWatcher;
  jobs: Set<WatchedJob>;
}

interface WatchedJob {
  dir: string;
  snapshot: WaitJob;
  watch?: WatchedDirectory;
  /** Identity of the meta.json version behind `snapshot`; an unchanged file is not read again. */
  metaSignature?: string;
}

function checkInteger(value: number, min: number, max: number, flag: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}.`);
  }
}

/**
 * Cheap identity of the current meta.json (inode, size, change times). Metadata is replaced atomically, so every
 * real update changes it; replayed or coalesced watcher events (macOS FSEvents) leave it equal. Undefined if absent.
 */
async function statMetaSignature(dir: string): Promise<string | undefined> {
  try {
    const { ino, size, mtimeNs, ctimeNs } = await stat(join(dir, META_FILE), { bigint: true });
    return `${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  } catch {
    return undefined;
  }
}

async function readJob(jobId: string, dir: string, signal: AbortSignal): Promise<WaitJob> {
  try {
    const job = JSON.parse(await readFile(join(dir, "meta.json"), { encoding: "utf8", signal })) as Partial<JobRecord> | null;
    const status = job?.status;
    if (job && status && (status === "queued" || status === "running" || TERMINAL_STATUSES.has(status))) {
      return {
        job_id: jobId,
        status,
        harness: job.harness,
        model: job.model,
        subtask_id: job.subtask_id,
        plan_id: job.plan_id,
        exit_code: job.result?.exit_code,
        error_code: job.error?.code,
      };
    }
  } catch {
    // Missing, unreadable, and partially written metadata can be retried on the next event.
  }
  return { job_id: jobId, status: "pending" };
}

function isTerminalSnapshot(job: WaitJob): boolean {
  return job.status !== "pending" && TERMINAL_STATUSES.has(job.status);
}

function countPending(jobs: readonly WatchedJob[]): number {
  let pending = 0;
  for (const { snapshot: { status } } of jobs) {
    if (status === "pending" || !TERMINAL_STATUSES.has(status)) pending++;
  }
  return pending;
}

export async function waitForJobsOnDisk(options: WaitCliOptions): Promise<WaitCliResult> {
  const {
    until = "any", timeoutSec = DEFAULT_TIMEOUT_SEC, settleMs = DEFAULT_SETTLE_MS, stateDir, signal,
  } = options;
  const jobIds = [...new Set(options.jobIds)];
  if (jobIds.length === 0) throw new Error("Specify at least one job ID.");
  for (const id of jobIds) {
    if (typeof id !== "string" || !JOB_ID.test(id)) throw new Error(`Invalid job ID: ${JSON.stringify(id)}.`);
  }
  if (until !== "any" && until !== "all") throw new Error("--until must be any or all.");
  checkInteger(timeoutSec, 1, MAX_TIMEOUT_SEC, "--timeout");
  checkInteger(settleMs, 0, MAX_SETTLE_MS, "--settle-ms");
  if (stateDir === "") throw new Error("--state-dir must be a non-empty path.");

  const start = performance.now();
  const deadline = start + timeoutSec * 1000;
  const runsDir = resolve(stateDir === undefined ? getRunsDir() : join(stateDir, "runs"));
  const jobs: WatchedJob[] = jobIds.map((id) => ({
    dir: join(runsDir, id),
    snapshot: { job_id: id, status: "pending" },
  }));
  const watches = new Map<string, WatchedDirectory>();
  const dirty = new Set<WatchedJob>();
  const reads = new AbortController();
  let debounce: NodeJS.Timeout | undefined;
  let safety: NodeJS.Timeout | undefined;
  let settle: NodeJS.Timeout | undefined;
  let settleExpired = false;
  let reading = true;
  let stopped = false;
  let complete!: (reason: WakeReason) => void;
  let rejectWake!: (error: unknown) => void;
  const wake = new Promise<WakeReason>((done, reject) => {
    complete = done;
    rejectWake = reject;
  });

  function finish(reason: WakeReason): void {
    if (stopped) return;
    stopped = true;
    complete(reason);
  }

  function fail(error: unknown): void {
    if (stopped) return;
    stopped = true;
    rejectWake(error);
  }

  function unwatch(dir: string, entry: WatchedDirectory): void {
    watches.delete(dir);
    entry.watcher.close();
  }

  function watchDirectory(dir: string): WatchedDirectory | undefined {
    const existing = watches.get(dir);
    if (existing) return existing;
    try {
      const watchedJobs = new Set<WatchedJob>();
      const watcher = watch(dir, (event, filename) => {
        if (watches.get(dir) !== entry) return;
        if (event === "rename" && (filename === null || filename === basename(dir))) {
          // Reattach if the watched directory itself was removed or replaced.
          unwatch(dir, entry);
          schedule(watchedJobs);
          return;
        }
        schedule([...watchedJobs].filter((job) => {
          const suffix = relative(dir, job.dir);
          // Inside the job folder only the metadata file (or its atomic-write temp `meta.json.<id>.tmp`) matters.
          if (!suffix) return !filename || filename === META_FILE || filename.startsWith(`${META_FILE}.`);
          return !filename || filename === suffix.split(sep, 1)[0];
        }));
      });
      const entry: WatchedDirectory = { watcher, jobs: watchedJobs };
      watches.set(dir, entry);
      watcher.on("error", () => {
        if (watches.get(dir) !== entry) return;
        unwatch(dir, entry);
        schedule(watchedJobs);
      });
      return entry;
    } catch {
      // A missing directory or unsupported watcher still has the safety check.
      return undefined;
    }
  }

  function watchNearestDirectory(dir: string): WatchedDirectory | undefined {
    const direct = watchDirectory(dir);
    const parent = dirname(dir);
    if (direct || parent === dir) return direct;
    const ancestor = watchNearestDirectory(parent);
    // With the ancestor armed, retry the child to catch a concurrent mkdir.
    return watchDirectory(dir) ?? ancestor;
  }

  function attachWatchers(affected: readonly WatchedJob[]): void {
    // Move each affected job to its closest available directory.
    for (const job of affected) {
      job.watch?.jobs.delete(job);
      job.watch = watchNearestDirectory(job.dir);
      job.watch?.jobs.add(job);
    }
    for (const [dir, entry] of watches) {
      if (entry.jobs.size === 0) unwatch(dir, entry);
    }
  }

  async function readJobs(affected: readonly WatchedJob[]): Promise<void> {
    for (let offset = 0; offset < affected.length && !stopped; offset += READ_BATCH_SIZE) {
      await Promise.all(affected.slice(offset, offset + READ_BATCH_SIZE).map(async (job) => {
        // Stat before reading: a write landing in between only costs one redundant read later, never a missed update.
        const signature = await statMetaSignature(job.dir);
        if (signature !== undefined && signature === job.metaSignature && job.snapshot.status !== "pending") return;
        const snapshot = await readJob(job.snapshot.job_id, job.dir, reads.signal);
        // A transient read failure must not turn an already-seen terminal result back into "pending".
        if (!stopped && !(snapshot.status === "pending" && isTerminalSnapshot(job.snapshot))) {
          job.snapshot = snapshot;
          job.metaSignature = snapshot.status === "pending" ? undefined : signature;
        }
      }));
    }
  }

  function checkCondition(initial = false, finalSettleRead = false): void {
    const pending = countPending(jobs);
    if (pending === 0) finish("all_terminal");
    else if (until === "any" && pending < jobs.length) {
      const remaining = deadline - performance.now();
      if (initial || finalSettleRead || settleMs === 0 || remaining <= 0) {
        finish("terminal");
      } else if (settle === undefined) {
        settle = setTimeout(() => {
          // Include changes that arrived just before the settle window closed.
          settleExpired = true;
          scheduleFullRead();
        }, Math.min(settleMs, remaining));
      }
    }
    if (finalSettleRead) {
      settle = undefined;
      settleExpired = false;
    }
  }

  async function refresh(): Promise<void> {
    reading = true;
    const finalSettleRead = settleExpired;
    const affected = [...dirty];
    dirty.clear();
    attachWatchers(affected);
    await readJobs(affected);
    reading = false;
    if (stopped) return;
    checkCondition(false, finalSettleRead);
    schedule([]);
  }

  function schedule(affected: Iterable<WatchedJob>): void {
    if (stopped) return;
    for (const job of affected) dirty.add(job);
    if (reading || dirty.size === 0) return;
    if (settleExpired) {
      clearTimeout(debounce);
      debounce = undefined;
      void refresh().catch(fail);
    } else if (debounce === undefined) {
      debounce = setTimeout(() => {
        debounce = undefined;
        void refresh().catch(fail);
      }, DEBOUNCE_MS);
    }
  }

  /** Safety nets re-read every job even when its meta.json looks unchanged, in case a watcher event was lost. */
  function scheduleFullRead(): void {
    forgetSignatures();
    schedule(jobs);
  }

  function forgetSignatures(): void {
    for (const job of jobs) job.metaSignature = undefined;
  }

  async function startWatching(): Promise<void> {
    await readJobs(jobs);
    if (stopped) return;
    checkCondition(true);
    if (stopped) return;
    attachWatchers(jobs);
    // Close the gap between the first read and the watchers: always read once more, whatever the signatures say.
    forgetSignatures();
    await readJobs(jobs);
    if (stopped) return;
    checkCondition();
    if (stopped) return;
    reading = false;
    schedule([]);
    safety = setInterval(scheduleFullRead, SAFETY_CHECK_MS);
  }

  const cancel = () => finish("cancelled");
  const timeout = setTimeout(() => {
    const pending = countPending(jobs);
    if (pending === 0) finish("all_terminal");
    else finish(until === "any" && pending < jobs.length ? "terminal" : "timeout");
  }, deadline - performance.now());
  try {
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    else void startWatching().catch(fail);
    const wakeReason = await wake;
    const snapshots = jobs.map((job) => job.snapshot);
    return {
      wake_reason: wakeReason,
      until,
      held_ms: Math.round(performance.now() - start),
      pending_count: countPending(jobs),
      jobs: snapshots,
    };
  } finally {
    reads.abort();
    clearTimeout(timeout);
    clearTimeout(debounce);
    clearTimeout(settle);
    clearInterval(safety);
    signal?.removeEventListener("abort", cancel);
    for (const [dir, entry] of watches) unwatch(dir, entry);
  }
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return /^\d+$/.test(value) ? Number(value) : NaN;
}

export const WAIT_EXIT_CODES: Readonly<Record<WakeReason, number>> = { terminal: 0, all_terminal: 0, timeout: 2, cancelled: 130 };

/** Prints the JSON result and returns the process exit code (see the exit codes in the usage text). */
export async function runWaitCommand(args: string[]): Promise<number> {
  const { values, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: {
      job: { type: "string", multiple: true },
      until: { type: "string" },
      timeout: { type: "string" },
      "settle-ms": { type: "string" },
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const until = values.until ?? "any";
  if (until !== "any" && until !== "all") throw new Error("--until must be any or all.");
  const jobIds = tokens.flatMap((token) => {
    if (token.kind === "positional") return [token.value];
    if (token.kind === "option" && token.name === "job") return token.value?.split(",") ?? [];
    return [];
  });

  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const result = await waitForJobsOnDisk({
      jobIds,
      until,
      timeoutSec: parseInteger(values.timeout),
      settleMs: parseInteger(values["settle-ms"]),
      stateDir: values["state-dir"],
      signal: controller.signal,
    });
    console.log(JSON.stringify(result, null, 2));
    return WAIT_EXIT_CODES[result.wake_reason];
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
