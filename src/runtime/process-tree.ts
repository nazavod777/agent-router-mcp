import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const POLL_MS = 50;
const DEFAULT_GRACE_MS = 5_000;
const KILL_WAIT_MS = 1_000;
const TASKKILL_TIMEOUT_MS = 10_000;
const JOB_ID_ENV = "ORCH_JOB_ID";
const JOB_CHAIN_ENV = "ORCH_JOB_CHAIN";
const JOB_CHAIN_SEPARATOR = ",";
const PS_PATH = "/bin/ps";
/** macOS/BSD `ps`: `-a` all users, `-x` include detached/no-TTY processes, `-E` append environment, `-ww` unlimited width. */
const PS_ENVIRONMENT_ARGS = ["-axEww", "-o", "pid=,command="];
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

export function spawnDetached(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return spawn(command, args, { ...options, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });
}

function procIds(): number[] {
  if (process.platform !== "linux") return [];
  try {
    return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number);
  } catch {
    return [];
  }
}

/**
 * True when the environment belongs to the job: it either carries `ORCH_JOB_ID=<jobId>` or lists the job in its
 * `ORCH_JOB_CHAIN` (comma-separated ancestry of nested orchestrators). Chain entries are compared as whole tokens.
 */
function environBelongsToJob(environ: Buffer, jobId: string): boolean {
  if (!environ.includes(jobId)) return false; // Cheap pre-filter before decoding the whole block.
  const ownEntry = `${JOB_ID_ENV}=${jobId}`;
  const chainPrefix = `${JOB_CHAIN_ENV}=`;
  for (const entry of environ.toString("utf8").split("\0")) {
    if (entry === ownEntry) return true;
    if (entry.startsWith(chainPrefix) && entry.slice(chainPrefix.length).split(JOB_CHAIN_SEPARATOR).includes(jobId)) return true;
  }
  return false;
}

/** Same rule as `environBelongsToJob`, for the whitespace-separated `KEY=value` tokens that BSD `ps -e` prints. */
function tokensBelongToJob(tokens: readonly string[], jobId: string): boolean {
  const ownEntry = `${JOB_ID_ENV}=${jobId}`;
  const chainPrefix = `${JOB_CHAIN_ENV}=`;
  return tokens.some((token) => token === ownEntry
    || (token.startsWith(chainPrefix) && token.slice(chainPrefix.length).split(JOB_CHAIN_SEPARATOR).includes(jobId)));
}

/**
 * Parses `ps -axEww -o pid=,command=` output (macOS/BSD, where `-E` appends the environment to the command line) and
 * returns the PIDs whose environment belongs to the job. Exported for offline tests.
 */
export function parsePsEnvironmentListing(output: string, jobId: string, excludePids?: ReadonlySet<number>): number[] {
  const pids: number[] = [];
  for (const line of output.split("\n")) {
    if (!line.includes(jobId)) continue; // Cheap pre-filter before tokenizing.
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || excludePids?.has(pid)) continue;
    if (tokensBelongToJob(match[2]!.split(/\s+/), jobId)) pids.push(pid);
  }
  return pids;
}

/** macOS has no /proc: ask `ps` for same-user processes together with their environment. Empty when `ps` fails. */
function findMarkedPidsWithPs(jobId: string, excludePids?: Set<number>): number[] {
  const result = spawnSync(PS_PATH, PS_ENVIRONMENT_ARGS, {
    encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER_BYTES, windowsHide: true,
  });
  if (result.error || result.status !== 0) return [];
  // The `ps` process inherits our environment, so it may carry the marker too; it is already gone by the time we signal.
  const exclude = new Set(excludePids);
  if (result.pid) exclude.add(result.pid);
  return parsePsEnvironmentListing(result.stdout, jobId, exclude);
}

export function findDescendantPidsByJobMarker(jobId: string, excludePids?: Set<number>): number[] {
  if (process.platform === "darwin") return findMarkedPidsWithPs(jobId, excludePids);
  return procIds().filter((pid) => {
    if (pid === process.pid || excludePids?.has(pid)) return false;
    try {
      return environBelongsToJob(readFileSync(`/proc/${pid}/environ`), jobId);
    } catch {
      // Processes can exit or be hidden by kernel permissions between reads.
      return false;
    }
  });
}

function signal(pid: number, value: NodeJS.Signals | 0): boolean {
  try {
    return process.kill(pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if (value === 0 && (error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

function procStatus(pid: number): { live: boolean; pgid: number } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ", 3);
    return { live: state !== "Z" && state !== "X", pgid: Number(group) };
  } catch {
    return undefined;
  }
}

function groupIsLive(pgid: number): boolean {
  if (!signal(-pgid, 0)) return false;
  if (process.platform !== "linux") return true;
  if (procStatus(pgid)?.live) return true;

  const members = procIds().map(procStatus).filter((stat) => stat?.pgid === pgid);
  // A zombie holds its PID and group until its parent reaps it, but cannot execute.
  return members.length === 0 || members.some((member) => member?.live);
}

/** A single process is live unless it is gone or an unreaped zombie (which cannot execute). */
function processIsLive(pid: number): boolean {
  return signal(pid, 0) && (procStatus(pid)?.live ?? true);
}

/** Process groups (negative PIDs) exist only on POSIX; Windows trees are ended with `taskkill /T`. */
function supportsProcessGroups(platform: NodeJS.Platform): boolean {
  return platform !== "win32";
}

export type TaskkillRunner = (args: string[]) => Promise<void>;

function runTaskkill(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("taskkill", args, { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitUntilGone(pid: number, waitMs: number): Promise<boolean> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    if (!processIsLive(pid)) return true;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await setTimeout(Math.min(remaining, POLL_MS));
  }
}

export interface TerminationResult {
  signalSent: "SIGTERM" | "SIGKILL";
  /**
   * False when the process itself is gone but the whole tree could not be confirmed ended (Windows without a working
   * `taskkill /T`): children may still be running and writing.
   */
  terminated: boolean;
  /** Why `terminated` is false. */
  reason?: string;
}

/**
 * Windows has no process groups: `taskkill /PID <pid> /T` ends the tree gracefully, `/F` forces it. When `taskkill` is
 * unavailable the process itself is signalled, which Windows maps to a hard termination of that one process; that can
 * leave children running, so the result then says `terminated: false` even though the parent PID disappeared.
 */
async function terminateWindowsTree(opts: {
  pid: number; graceMs?: number; taskkill?: TaskkillRunner;
}): Promise<TerminationResult> {
  const { pid } = opts;
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid process ID.");
  const taskkill = opts.taskkill ?? runTaskkill;
  let lastFailure: string | undefined;
  let treeKillSucceeded = false;

  async function terminate(value: "SIGTERM" | "SIGKILL", waitMs: number): Promise<boolean> {
    try {
      await taskkill(["/PID", String(pid), "/T", ...(value === "SIGKILL" ? ["/F"] : [])]);
      treeKillSucceeded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        lastFailure = "taskkill is not available";
        signal(pid, value);
      } else {
        lastFailure = errorMessage(error);
      }
    }
    return waitUntilGone(pid, waitMs);
  }

  const result = (signalSent: TerminationResult["signalSent"]): TerminationResult => treeKillSucceeded
    ? { signalSent, terminated: true }
    : {
      signalSent, terminated: false,
      reason: `Process ${pid} exited, but its child processes could not be confirmed ended: ${lastFailure ?? "taskkill /T did not run"}.`,
    };

  if (await terminate("SIGTERM", Math.max(0, opts.graceMs ?? DEFAULT_GRACE_MS))) return result("SIGTERM");
  if (!(await terminate("SIGKILL", KILL_WAIT_MS))) {
    throw new Error(`Process ${pid} is still alive ${KILL_WAIT_MS}ms after a forced taskkill${lastFailure ? ` (${lastFailure})` : ""}.`);
  }
  return result("SIGKILL");
}

export async function terminateProcessTree(opts: {
  pid: number;
  pgid?: number;
  jobId: string;
  graceMs?: number;
  /** Test seam: platform whose termination strategy is used; defaults to the running platform. */
  platform?: NodeJS.Platform;
  /** Test seam: replaces the `taskkill` invocation of the Windows strategy. */
  taskkill?: TaskkillRunner;
}): Promise<TerminationResult> {
  if (!supportsProcessGroups(opts.platform ?? process.platform)) return terminateWindowsTree(opts);

  const pgid = opts.pgid ?? opts.pid;
  if (!Number.isSafeInteger(pgid) || pgid <= 1) throw new Error("Invalid detached process group.");
  const exclude = new Set([opts.pid]);

  async function terminate(value: "SIGTERM" | "SIGKILL", waitMs: number): Promise<boolean> {
    signal(-pgid, value);
    const signaled = new Set<number>();
    const deadline = performance.now() + waitMs;
    for (;;) {
      const marked = findDescendantPidsByJobMarker(opts.jobId, exclude);
      for (const pid of marked) {
        if (signaled.has(pid)) continue;
        signal(pid, value);
        signaled.add(pid);
      }
      if (!groupIsLive(pgid) && marked.every((pid) => !signal(pid, 0) || procStatus(pid)?.live === false)) {
        return true;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) return false;
      await setTimeout(Math.min(remaining, POLL_MS));
    }
  }

  if (await terminate("SIGTERM", Math.max(0, opts.graceMs ?? DEFAULT_GRACE_MS))) {
    return { signalSent: "SIGTERM", terminated: true };
  }
  if (!(await terminate("SIGKILL", KILL_WAIT_MS))) {
    throw new Error(`Process group ${pgid} is still alive ${KILL_WAIT_MS}ms after SIGKILL.`);
  }
  return { signalSent: "SIGKILL", terminated: true };
}

/** Linux scheduler ticks per second (`getconf CLK_TCK` is 100 on every mainstream Linux build). */
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const MS_PER_SECOND = 1_000;
/** Fields of /proc/<pid>/stat after the "(comm)" token, counted from the state field: pgrp, utime, stime, cutime, cstime. */
const STAT_PGRP_INDEX = 2;
const STAT_CPU_INDEXES = [11, 12, 13, 14] as const;

/**
 * Total user+system CPU time (ms) of the processes that currently belong to process group `pgid`. Linux only (reads
 * /proc); returns undefined elsewhere or when /proc is unreadable. The value can drop when a member exits, so callers
 * should compare consecutive samples rather than trust it as monotonic.
 */
export async function sampleProcessGroupCpuMs(pgid: number): Promise<number | undefined> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pgid) || pgid <= 1) return undefined;
  try {
    const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
    let totalTicks = 0;
    let members = 0;
    await Promise.all(names.map(async (name) => {
      try {
        const stat = await readFile(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[STAT_PGRP_INDEX]) !== pgid) return;
        // cutime/cstime count children the member already reaped, so a short-lived tool run by a shell still shows up.
        const ticks = STAT_CPU_INDEXES.reduce((sum, index) => sum + Number(fields[index]), 0);
        if (!Number.isFinite(ticks)) return;
        totalTicks += ticks;
        members += 1;
      } catch {
        // The process exited between readdir and read, or its stat is hidden.
      }
    }));
    return members === 0 ? undefined : Math.round((totalTicks * MS_PER_SECOND) / LINUX_CLOCK_TICKS_PER_SECOND);
  } catch {
    return undefined;
  }
}
