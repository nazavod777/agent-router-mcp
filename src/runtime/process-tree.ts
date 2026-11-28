import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { win32 } from "node:path";
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
/** `taskkill` exit code for "the process was not found" (the root PID is already gone). */
const TASKKILL_NOT_FOUND_EXIT_CODE = 128;
const WINDOWS_PROCESS_LIST_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/**
 * Slack for the clock behind process creation times when telling a real descendant from a reused PID. The spawn time is
 * taken right before the process is created, so only a few milliseconds of skew can occur; anything much older was not
 * started by this job.
 */
const WINDOWS_CREATION_TIME_TOLERANCE_MS = 50;
/** Milliseconds between the Windows FILETIME epoch (1601-01-01) and the Unix epoch. */
const FILETIME_UNIX_EPOCH_OFFSET_MS = 11_644_473_600_000n;
const FILETIME_TICKS_PER_MS = 10_000n;
/** One `pid,parentPid,creationFileTimeUtc` line per process. */
const WINDOWS_PROCESS_LIST_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0},{1},{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToFileTimeUtc() } }";
const WINDOWS_PROCESS_LINE = /^\s*(\d+),(\d+),(\d+)\s*$/;
const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Starts a job process without a shell. POSIX: a new session (`detached`) so the whole group can be signalled. Windows:
 * never `detached` (that would open a blank console window and keep libuv from attaching its child-reaping Job
 * Object); `windowsHide` keeps console programs from flashing a window.
 */
export function spawnDetached(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    ...options, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Value of an environment variable, matching the name the way Windows does (case-insensitively). */
function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Absolute path of a program under `%SystemRoot%\System32` (`%windir%` as a fallback), or undefined when the Windows
 * directory is not a drive-absolute path or the file does not exist. System tools are never looked up through PATH, so
 * a same-named program planted in a PATH directory can never run in their place.
 */
export function resolveWindowsSystemBinary(
  segments: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = isRegularFile,
): string | undefined {
  const root = windowsEnvValue(env, "SystemRoot") || windowsEnvValue(env, "windir");
  if (!root || !WINDOWS_DRIVE_ABSOLUTE.test(root)) return undefined;
  const path = win32.join(root, "System32", ...segments);
  return fileExists(path) ? path : undefined;
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

/**
 * Runs `taskkill` with the given arguments. Resolves on exit code 0; rejects with the `execFile` error otherwise
 * (`code` is the numeric exit code, or `"ENOENT"` when `taskkill.exe` cannot be found).
 */
export type TaskkillRunner = (args: string[]) => Promise<void>;
/** One snapshot of the Windows process table as `pid,parentPid,creationFileTimeUtc` lines; undefined when unavailable. */
export type WindowsProcessLister = () => Promise<string | undefined>;

function runTaskkill(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const taskkill = resolveWindowsSystemBinary(["taskkill.exe"]);
    if (taskkill === undefined) {
      reject(Object.assign(new Error("taskkill.exe was not found in %SystemRoot%\\System32."), { code: "ENOENT" }));
      return;
    }
    execFile(taskkill, args, { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type TaskkillOutcome =
  | { kind: "ok" }
  /** Exit code 128: the root PID does not exist (any more). */
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | { kind: "failed"; message: string };

/** Classifies a `taskkill` run by exit code only: its messages are localized and must never be parsed. */
async function runTaskkillClassified(taskkill: TaskkillRunner, args: string[]): Promise<TaskkillOutcome> {
  try {
    await taskkill(args);
    return { kind: "ok" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { kind: "unavailable" };
    if ((code as unknown) === TASKKILL_NOT_FOUND_EXIT_CODE) return { kind: "not-found" };
    return { kind: "failed", message: errorMessage(error) };
  }
}

/**
 * Parses the output of the process-table query (`pid,parentPid,creationFileTimeUtc` per line) and returns the PIDs of
 * every process that descends from `rootPid` through parent-PID links and was created no earlier than the spawn time
 * (minus a small tolerance). Windows keeps a dead parent's PID in its children, so orphans are still found. PID reuse is
 * guarded twice: the creation filter drops processes older than the job, and a child is only believed to belong to a LIVE
 * process that holds its parent PID when it was created after that process (a process cannot be older than its parent).
 * The root is known to be dead when this runs, so a live process holding `rootPid` is a stranger: only children older
 * than it (orphans of the real root) count and its own children never do. A descendant whose parent chain runs through
 * an already-dead intermediate process cannot be reached. Exported for offline tests.
 *
 * Returns undefined when the output holds no valid row at all: a garbled or error-only snapshot must never read as "no
 * survivors". (A real process table always lists at least this process.)
 */
export function parseWindowsProcessListingStrict(output: string, rootPid: number, spawnedAtMs: number): number[] | undefined {
  const earliestMs = spawnedAtMs - WINDOWS_CREATION_TIME_TOLERANCE_MS;
  const createdByPid = new Map<number, number>();
  const rows: Array<{ pid: number; parentPid: number; createdMs: number }> = [];
  for (const line of output.split("\n")) {
    const match = WINDOWS_PROCESS_LINE.exec(line);
    if (!match) continue;
    const row = {
      pid: Number(match[1]), parentPid: Number(match[2]),
      createdMs: Number(BigInt(match[3]!) / FILETIME_TICKS_PER_MS - FILETIME_UNIX_EPOCH_OFFSET_MS),
    };
    createdByPid.set(row.pid, row.createdMs);
    rows.push(row);
  }
  if (rows.length === 0) return undefined;
  const childrenByParent = new Map<number, number[]>();
  for (const { pid, parentPid, createdMs } of rows) {
    if (createdMs < earliestMs || pid === rootPid || pid === process.pid) continue;
    const parentCreatedMs = createdByPid.get(parentPid);
    if (parentCreatedMs !== undefined && (createdMs >= parentCreatedMs) === (parentPid === rootPid)) continue;
    childrenByParent.set(parentPid, [...(childrenByParent.get(parentPid) ?? []), pid]);
  }
  const found = new Set<number>();
  const pending = [rootPid];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of childrenByParent.get(parent) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      pending.push(child);
    }
  }
  return [...found];
}

/** Same as `parseWindowsProcessListingStrict`, with an unusable snapshot reported as no descendants (offline tests). */
export function parseWindowsProcessListing(output: string, rootPid: number, spawnedAtMs: number): number[] {
  return parseWindowsProcessListingStrict(output, rootPid, spawnedAtMs) ?? [];
}

function listWindowsProcesses(): Promise<string | undefined> {
  const powershell = resolveWindowsSystemBinary(["WindowsPowerShell", "v1.0", "powershell.exe"]);
  if (powershell === undefined) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_LIST_SCRIPT], {
      windowsHide: true, timeout: WINDOWS_PROCESS_LIST_TIMEOUT_MS, maxBuffer: WINDOWS_PROCESS_LIST_MAX_BUFFER_BYTES, encoding: "utf8",
    }, (error, stdout) => {
      // A process without a creation time (the idle process) makes the script report an error and a non-zero exit even
      // though every other line is complete, so a numeric exit code with usable output still counts as a snapshot.
      const exitedNormally = !error || (typeof (error as NodeJS.ErrnoException).code === "number" && !error.killed);
      resolve(exitedNormally && stdout.trim() !== "" ? stdout : undefined);
    });
  });
}

/**
 * PIDs of the live processes that descend from `rootPid` (started at `spawnedAtMs` or later), or undefined when the
 * process table could not be read. Windows only; `list` replaces the PowerShell query in tests.
 */
export async function findWindowsDescendants(
  rootPid: number, spawnedAtMs: number, list: WindowsProcessLister = listWindowsProcesses,
): Promise<number[] | undefined> {
  const output = await list().catch(() => undefined);
  return output === undefined ? undefined : parseWindowsProcessListingStrict(output, rootPid, spawnedAtMs);
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
  /**
   * True when `terminated` is false only because the Windows process table could not be read (PowerShell or WMI is
   * restricted): nothing says a child survived. A caller that saw the root exit cleanly by itself may then just warn.
   */
  processTableUnavailable?: boolean;
}

interface WindowsTerminationOptions {
  pid: number;
  graceMs?: number;
  spawnedAt?: number;
  verifyDescendants?: boolean;
  taskkill?: TaskkillRunner;
  listWindowsProcesses?: WindowsProcessLister;
  rootExited?: boolean;
}

/**
 * Windows has no process groups: `taskkill /PID <pid> /T` ends the tree, `/F` forces it (headless console programs
 * ignore the graceful form, which then fails at once and is escalated without waiting). `taskkill` is classified by its
 * exit code only. A root that is already gone (a job that finished normally) is not an error: its leftover descendants
 * are looked up in the process table and ended, and the result is `terminated: true` only when none survive. When
 * `taskkill` is unavailable the process itself is signalled, which Windows maps to a hard termination of that one
 * process; that can leave children running, so the result then says `terminated: false`. When the caller knows the root has
 * already exited (`rootExited`), its PID may have been handed to an unrelated process, so `taskkill` is never run against
 * it: only the descendants found through the process table are ended.
 */
async function terminateWindowsTree(opts: WindowsTerminationOptions): Promise<TerminationResult> {
  const { pid } = opts;
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid process ID.");
  const taskkill = opts.taskkill ?? runTaskkill;
  const graceMs = Math.max(0, opts.graceMs ?? DEFAULT_GRACE_MS);
  let lastFailure: string | undefined;

  const run = async (args: string[]): Promise<TaskkillOutcome> => {
    const outcome = await runTaskkillClassified(taskkill, ["/PID", String(pid), ...args]);
    if (outcome.kind === "failed") lastFailure = outcome.message;
    else if (outcome.kind === "unavailable") lastFailure = "taskkill is not available";
    return outcome;
  };
  const unconfirmed = (signalSent: TerminationResult["signalSent"], why: string): TerminationResult => ({
    signalSent, terminated: false, reason: `Process ${pid} exited, but its child processes could not be confirmed ended: ${why}.`,
  });

  /**
   * The root is gone: whatever it left behind is found through the process table and ended. `signalSent` names the last
   * escalation step that was needed (nothing was sent at all when the root had already exited).
   */
  async function settleGoneRoot(signalSent: TerminationResult["signalSent"]): Promise<TerminationResult> {
    if (opts.verifyDescendants === false) return { signalSent, terminated: true };
    if (opts.spawnedAt === undefined) return unconfirmed(signalSent, lastFailure ?? "the process start time is unknown");
    const list = opts.listWindowsProcesses ?? listWindowsProcesses;
    let survivors = await findWindowsDescendants(pid, opts.spawnedAt, list);
    if (survivors === undefined) {
      return { ...unconfirmed(signalSent, lastFailure ?? "the process table could not be read"), processTableUnavailable: true };
    }
    if (survivors.length > 0) {
      await runTaskkillClassified(taskkill, ["/F", "/T", ...survivors.flatMap((survivor) => ["/PID", String(survivor)])]);
      survivors = await findWindowsDescendants(pid, opts.spawnedAt, list);
      if (survivors === undefined) return unconfirmed(signalSent, "the process table could not be read after ending its children");
      if (survivors.length > 0) return unconfirmed(signalSent, `processes ${survivors.join(", ")} survived taskkill`);
    }
    return { signalSent, terminated: true };
  }

  /** No `taskkill`: signal the root itself (children cannot be reached), then report the tree as unconfirmed. */
  async function signalRootOnly(): Promise<TerminationResult> {
    if (graceMs > 0) {
      signal(pid, "SIGTERM");
      if (await waitUntilGone(pid, graceMs)) return unconfirmed("SIGTERM", lastFailure ?? "taskkill is not available");
    }
    signal(pid, "SIGKILL");
    if (await waitUntilGone(pid, KILL_WAIT_MS)) return unconfirmed("SIGKILL", lastFailure ?? "taskkill is not available");
    throw new Error(`Process ${pid} is still alive ${KILL_WAIT_MS}ms after a forced kill (${lastFailure ?? "taskkill is not available"}).`);
  }

  // A root that has exited no longer pins its PID, so the PID may belong to a stranger by now: never signal it.
  if (opts.rootExited || !processIsLive(pid)) return settleGoneRoot("SIGTERM");

  if (graceMs > 0) {
    const graceful = await run(["/T"]);
    if (graceful.kind === "unavailable") return signalRootOnly();
    // Only a graceful stop that was accepted deserves a wait; a refusal (headless console program) goes straight to force.
    // Exit code 0 of a graceful `taskkill /T` only means the close request was delivered: the descendants are verified too.
    if (graceful.kind === "ok" && await waitUntilGone(pid, graceMs)) return settleGoneRoot("SIGTERM");
    if (!processIsLive(pid)) return settleGoneRoot("SIGTERM");
  }

  const forced = await run(["/T", "/F"]);
  if (forced.kind === "unavailable") return signalRootOnly();
  if (await waitUntilGone(pid, KILL_WAIT_MS)) {
    // Even after `/T /F` the descendants are verified when the caller asked for it (`settleGoneRoot` skips the check otherwise).
    return settleGoneRoot("SIGKILL");
  }
  throw new Error(`Process ${pid} is still alive ${KILL_WAIT_MS}ms after a forced taskkill${lastFailure ? ` (${lastFailure})` : ""}.`);
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
  /** Windows: when the process was spawned (`Date.now()`); lets leftover descendants of an already-finished root be found. */
  spawnedAt?: number;
  /**
   * Windows: look for descendants that outlived a root that is already gone (default true). Short-lived diagnostic probes
   * pass false: they end a still-running tree with `taskkill /T /F` and do not pay for a process-table query.
   */
  verifyDescendants?: boolean;
  /** Test seam: replaces the PowerShell process-table query of the Windows strategy. */
  listWindowsProcesses?: WindowsProcessLister;
  /** Windows: the root process has already exited, so its PID is never targeted (it may have been reused). */
  rootExited?: boolean;
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
