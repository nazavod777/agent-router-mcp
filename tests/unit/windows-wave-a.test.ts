import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WINDOWS_COMMAND_LINE_CHARS, assertCommandLineFits, windowsCommandLineLength } from "../../src/adapters/parsers.js";
import { execProbe, resolveBinary, resolveLaunch, unwrapLauncher } from "../../src/adapters/probe-utils.js";
import { readNpmShimTarget } from "../../src/cli/npm-shim.js";
import { detectEol, getNodeAt, nodeToValue, parseJsonc, removeValueAt, setValueAt } from "../../src/cli/jsonc-edit.js";
import { buildProbeEnv } from "../../src/discovery/cli-probes.js";
import {
  allowedRootsFromEnv, buildChildEnv, checkRecursionLimit, getCurrentOrchDepth, gitEnvironment, gitInvocation, isolatedGitEnvironment,
  validateCwd,
} from "../../src/runtime/guard.js";
import { logger } from "../../src/logging.js";
import { spawnDetached } from "../../src/runtime/process-tree.js";
import { createWorktree, inspectWorktree, removeWorktree } from "../../src/runtime/worktree.js";
import { openInBrowser } from "../../src/settings-ui/server.js";

/** Records the options of every `spawn` / `execFile` call, and lets a test replace `spawn` with a fake child. */
const recorded = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ command: string; options: Record<string, unknown> }>,
  execFileOptions: [] as Array<Record<string, unknown>>,
  fakeSpawn: undefined as ((command: string, args: string[]) => unknown) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify: promisifyOriginal } = await import("node:util");
  type Loose = (...args: unknown[]) => unknown;
  const realExecFile = actual.execFile as unknown as Loose & { [key: symbol]: Loose };
  const execFile = Object.assign((...args: unknown[]) => realExecFile(...args), {
    [promisifyOriginal.custom]: (command: unknown, args: unknown, options: Record<string, unknown>) => {
      recorded.execFileOptions.push(options);
      return realExecFile[promisifyOriginal.custom]!(command, args, options);
    },
  });
  const spawn = (command: string, args: string[], options: Record<string, unknown>) => {
    recorded.spawnCalls.push({ command, options });
    return recorded.fakeSpawn ? recorded.fakeSpawn(command, args) : (actual.spawn as unknown as Loose)(command, args, options);
  };
  return { ...actual, execFile, spawn };
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Orch Test", "-c", "user.email=orch@example.invalid", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "orch-wave-a-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

// ---------------------------------------------------------------------------
// 1. Hidden headless spawns
// ---------------------------------------------------------------------------

describe("spawnDetached", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    recorded.spawnCalls.length = 0;
  });

  async function spawnOn(platform: NodeJS.Platform): Promise<Record<string, unknown>> {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    const child = spawnDetached(process.execPath, ["-e", "0"], { cwd: root, env: process.env });
    await new Promise((resolve) => child.once("close", resolve));
    return recorded.spawnCalls.at(-1)!.options;
  }

  it("on Windows is not detached (no console window, libuv's job object applies) and hides the window", async () => {
    expect(await spawnOn("win32")).toMatchObject({ detached: false, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  });

  it("on POSIX stays detached so the whole process group can be signalled, and still sets windowsHide", async () => {
    expect(await spawnOn("linux")).toMatchObject({ detached: true, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  });
});

describe.skipIf(process.platform === "win32")("git subprocesses of the runtime", () => {
  let repo: string;
  let worktreesDir: string;
  let locksDir: string;

  beforeEach(async () => {
    const base = await realpath(mkdtempSync(join(root, "git-")));
    repo = join(base, "source");
    worktreesDir = join(base, "worktrees");
    locksDir = join(base, "locks");
    await mkdir(repo, { recursive: true });
    git(repo, "init", "-q");
    await writeFile(join(repo, "a.txt"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "Initial");
    recorded.spawnCalls.length = 0;
    recorded.execFileOptions.length = 0;
  });

  afterEach(() => { recorded.fakeSpawn = undefined; });

  it("passes windowsHide: true to every git call (validation, worktree creation, diff, removal)", async () => {
    const created = await createWorktree({ ...await validateCwd(repo, []), jobId: "hide-1", mode: "readonly", worktreesDir, locksDir });
    await writeFile(join(created.worktree.path, "a.txt"), "changed\n");
    await inspectWorktree(created.worktree, 10_000, [], { jobId: "hide-1" });
    await removeWorktree(created.worktree, { gitCommonDir: join(repo, ".git"), worktreesDir, locksDir, force: true });
    expect(recorded.execFileOptions.length).toBeGreaterThan(5);
    expect(recorded.execFileOptions.every((options) => options.windowsHide === true)).toBe(true);
    const diffSpawns = recorded.spawnCalls.filter((call) => /git/.test(call.command));
    expect(diffSpawns.length).toBeGreaterThan(0);
    expect(diffSpawns.every((call) => call.options.windowsHide === true)).toBe(true);
  });

  it("keeps a multi-byte character of git's stderr intact when it is split across two chunks", async () => {
    const created = await createWorktree({ ...await validateCwd(repo, []), jobId: "utf8-1", mode: "readonly", worktreesDir, locksDir });
    const bytes = Buffer.from("fatal: bad ✨ object", "utf8");
    const split = bytes.indexOf(0xe2) + 1; // In the middle of the three-byte sparkle.
    recorded.fakeSpawn = () => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => {
        child.stderr.write(bytes.subarray(0, split));
        child.stderr.write(bytes.subarray(split));
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit("close", 128));
      });
      return child;
    };
    const failure = await inspectWorktree(created.worktree, 10_000, [], {}).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("git diff failed: fatal: bad ✨ object");
  });

  describe("with a git that ends its lines with CRLF (Windows)", () => {
    let originalPath: string | undefined;

    beforeEach(() => {
      const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
      const bin = mkdtempSync(join(root, "crlf-bin-"));
      writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in\n  *" rev-parse "*) ${JSON.stringify(realGit)} "$@" | awk '{ printf "%s\\r\\n", $0 }' ;;\n  *) exec ${JSON.stringify(realGit)} "$@" ;;\nesac\n`);
      chmodSync(join(bin, "git"), 0o755);
      originalPath = process.env.PATH;
      process.env.PATH = `${bin}:${originalPath}`;
    });
    afterEach(() => { process.env.PATH = originalPath; });

    it("creates and removes a worktree: the \\r of `rev-parse` paths is stripped, not left on the path", async () => {
      const created = await createWorktree({ ...await validateCwd(repo, []), jobId: "crlf-1", mode: "readonly", worktreesDir, locksDir });
      await expect(removeWorktree(created.worktree, { gitCommonDir: join(repo, ".git"), worktreesDir, locksDir })).resolves.toEqual({ removed: true });
    });
  });
});

// ---------------------------------------------------------------------------
// 1. openInBrowser
// ---------------------------------------------------------------------------

describe("openInBrowser", () => {
  const URL_WITH_FRAGMENT = "http://127.0.0.1:4111/?x=1&y=2#t=secret";
  const env = { SystemRoot: "C:\\Windows" };
  const allExist = () => true;

  function fakeSpawn(failures: ReadonlySet<string> = new Set()) {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const spawnProcess = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => undefined;
      if (failures.has(command)) setImmediate(() => child.emit("error", Object.assign(new Error("spawn failed"), { code: "ENOENT" })));
      return child as unknown as ChildProcess;
    }) as unknown as typeof import("node:child_process").spawn;
    return { calls, spawnProcess };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("on Windows starts System32\\rundll32.exe url.dll,FileProtocolHandler, detached, hidden, with the URL untouched", async () => {
    const { calls, spawnProcess } = fakeSpawn();
    openInBrowser(URL_WITH_FRAGMENT, { platform: "win32", env, spawnProcess, fileExists: allExist });
    await tick();
    expect(calls).toEqual([{
      command: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", URL_WITH_FRAGMENT],
      options: { detached: true, windowsHide: true, stdio: "ignore" },
    }]);
  });

  it("falls back to System32\\cmd.exe /d /c start \"\" <url> when rundll32 cannot be started", async () => {
    const { calls, spawnProcess } = fakeSpawn(new Set(["C:\\Windows\\System32\\rundll32.exe"]));
    openInBrowser(URL_WITH_FRAGMENT, { platform: "win32", env, spawnProcess, fileExists: allExist });
    await tick();
    expect(calls.map((call) => call.command)).toEqual(["C:\\Windows\\System32\\rundll32.exe", "C:\\Windows\\System32\\cmd.exe"]);
    expect(calls[1]).toMatchObject({
      args: ["/d", "/c", "start", "", URL_WITH_FRAGMENT], options: { detached: true, windowsHide: true, stdio: "ignore" },
    });
  });

  it("never looks a Windows system binary up through PATH: without a usable SystemRoot nothing is spawned", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const { calls, spawnProcess } = fakeSpawn();
    openInBrowser(URL_WITH_FRAGMENT, { platform: "win32", env: { PATH: "C:\\Windows\\System32" }, spawnProcess, fileExists: allExist });
    openInBrowser(URL_WITH_FRAGMENT, { platform: "win32", env, spawnProcess, fileExists: () => false });
    await tick();
    expect(calls).toEqual([]);
    expect(info).toHaveBeenCalledTimes(2); // The user is told to open the URL manually, once per attempt.
    info.mockRestore();
  });

  it("keeps open / xdg-open on macOS and Linux", () => {
    const mac = fakeSpawn();
    openInBrowser("http://127.0.0.1:1/", { platform: "darwin", spawnProcess: mac.spawnProcess });
    const linux = fakeSpawn();
    openInBrowser("http://127.0.0.1:1/", { platform: "linux", spawnProcess: linux.spawnProcess });
    expect(mac.calls.map((call) => call.command)).toEqual(["open"]);
    expect(linux.calls.map((call) => call.command)).toEqual(["xdg-open"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Windows environment names are case-insensitive
// ---------------------------------------------------------------------------

describe("Windows environment variable names", () => {
  it("buildChildEnv strips Git variables, replaces ORCH_* and merges PATH regardless of case on Windows", () => {
    const env = buildChildEnv({
      baseEnv: {
        Git_Dir: "C:\\evil", GIT_WORK_TREE: "C:\\evil", git_index_file: "x", Path: "C:\\base", SystemRoot: "C:\\Windows",
        Orch_Depth: "1", orch_job_chain: "outer", ORCH_MAX_DEPTH: "5",
      },
      nextDepth: 2, jobId: "job-1", extra: { PATH: "C:\\extra;C:\\base" }, maxDepth: 3, platform: "win32",
    });
    expect(env).toEqual({
      SystemRoot: "C:\\Windows", PATH: "C:\\extra;C:\\base", ORCH_DEPTH: "2", ORCH_JOB_ID: "job-1", ORCH_JOB_CHAIN: "outer,job-1", ORCH_MAX_DEPTH: "3",
    });
  });

  it("buildChildEnv stays case-sensitive on POSIX, where `Path` and `PATH` are different variables", () => {
    const env = buildChildEnv({
      baseEnv: { Git_Dir: "/x", GIT_DIR: "/y", Path: "/a", Orch_Depth: "9" }, nextDepth: 1, jobId: "j", extra: { PATH: "/b" }, platform: "linux",
    });
    expect(env).toEqual({ Git_Dir: "/x", Path: "/a", PATH: "/b", Orch_Depth: "9", ORCH_DEPTH: "1", ORCH_JOB_ID: "j", ORCH_JOB_CHAIN: "j" });
  });

  it("reads depth, depth limit and allowed roots with any name case on Windows only", () => {
    const env = { Orch_Depth: "2", orch_max_depth: "2", ORCH_allowed_roots: "C:\\a;C:\\b" };
    expect(getCurrentOrchDepth(env, "win32")).toBe(2);
    expect(checkRecursionLimit(5, env, "win32")).toMatchObject({ code: "RECURSION_BLOCKED", details: { current_depth: 2, max_depth: 2 } });
    expect(allowedRootsFromEnv({ Orch_Allowed_Roots: "/a" }, "win32")).toEqual(["/a"]);
    expect(getCurrentOrchDepth(env, "linux")).toBe(0);
    expect(allowedRootsFromEnv({ Orch_Allowed_Roots: "/a" }, "linux")).toEqual([]);
  });

  it("gitEnvironment and isolatedGitEnvironment drop differently-cased Git_Dir and keep exactly one spelling of what they set", () => {
    const base = { Git_Dir: "C:\\evil", git_work_tree: "C:\\evil", Lc_All: "de_DE", git_optional_locks: "1", Git_Config_Global: "C:\\g", Path: "C:\\p" };
    const plain = gitEnvironment("job-9", "win32", base);
    expect(plain).toEqual({ Path: "C:\\p", LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", Git_Config_Global: "C:\\g", ORCH_JOB_ID: "job-9" });
    const isolated = isolatedGitEnvironment("job-9", "win32", base);
    expect(Object.keys(isolated).filter((key) => key.toUpperCase() === "GIT_CONFIG_GLOBAL")).toEqual(["GIT_CONFIG_GLOBAL"]);
    expect(isolated.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("buildProbeEnv keeps Path, SystemRoot, UserProfile, Temp, Tmp, LocalAppData, AppData and the driver's home in any case, once", () => {
    const source = {
      Path: "C:\\bin", PATH: "C:\\other", SystemRoot: "C:\\Windows", UserProfile: "C:\\Users\\u", Temp: "C:\\t", Tmp: "C:\\t", LocalAppData: "C:\\l",
      AppData: "C:\\a", Codex_Home: "C:\\codex", Lang: "C", No_Color: "0", Api_Key: "secret", Node_Options: "--require x",
    };
    // Two spellings of one name: the exact canonical one (`PATH`) wins, as in getEnvValue.
    expect(buildProbeEnv(source, "codex", "win32")).toEqual({
      PATH: "C:\\other", SystemRoot: "C:\\Windows", UserProfile: "C:\\Users\\u", Temp: "C:\\t", Tmp: "C:\\t", LocalAppData: "C:\\l", AppData: "C:\\a",
      Codex_Home: "C:\\codex", Lang: "C", NO_COLOR: "1",
    });
    // Off Windows the driver variable and the exact-case names keep their exact spelling.
    expect(buildProbeEnv(source, "codex", "linux")).not.toHaveProperty("Codex_Home");
    expect(buildProbeEnv(source, "codex", "linux")).not.toHaveProperty("Lang");
  });
});

// ---------------------------------------------------------------------------
// 4. Windows binary lookup, npm shims, git launch
// ---------------------------------------------------------------------------

describe("Windows binary lookup", () => {
  function executable(path: string, content = "MZ"): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, { mode: 0o755 });
    return path;
  }

  it("strips paired double quotes from PATH segments", () => {
    const dir = mkdtempSync(join(root, "quoted dir-"));
    const exe = executable(join(dir, "tool.exe"));
    const options = { platform: "win32", pathExt: ".EXE;.CMD" } as const;
    expect(resolveBinary("tool", { ...options, pathEnv: `"${dir}"` })).toBe(exe);
    expect(resolveBinary("tool", { ...options, pathEnv: `C:\\nowhere;"${dir}"` })).toBe(exe);
    // Only a PAIR is stripped; a lone quote is not a valid directory.
    expect(resolveBinary("tool", { ...options, pathEnv: `"${dir}` })).toBeUndefined();
    // POSIX directories may legitimately contain quotes: nothing is stripped there.
    expect(resolveBinary("tool", { platform: "linux", pathEnv: `"${dir}"` })).toBeUndefined();
  });

  it("rejects drive-relative paths (D:sub\\tool.exe, D:tool.exe) however they are written", () => {
    const base = mkdtempSync(join(root, "drive-"));
    // Plain names only: a ":" in a file name cannot be created on Windows. The drive-relative spellings must not resolve to them.
    executable(join(base, "sub", "tool.exe"));
    executable(join(base, "tool.exe"));
    const options = { platform: "win32", pathExt: ".EXE", baseDir: base, pathEnv: base } as const;
    expect(resolveBinary("D:sub\\tool.exe", options)).toBeUndefined();
    expect(resolveBinary("D:sub/tool.exe", options)).toBeUndefined();
    expect(resolveBinary("D:tool.exe", options)).toBeUndefined();
    expect(resolveBinary("d:tool", options)).toBeUndefined();
  });

  it("checks an explicit .exe name directly even when PATHEXT omits .EXE", () => {
    const dir = mkdtempSync(join(root, "ext-"));
    const exe = executable(join(dir, "tool.exe"));
    expect(resolveBinary("tool.exe", { platform: "win32", pathEnv: dir, pathExt: ".CMD;.BAT" })).toBe(exe);
    // The upper-case spelling resolves only where the file system ignores case (macOS, Windows).
    const caseInsensitive = existsSync(join(dir, "TOOL.EXE"));
    const upper = resolveBinary("TOOL.EXE", { platform: "win32", pathEnv: dir, pathExt: ".CMD" });
    if (caseInsensitive) expect(upper).toBeDefined();
    else expect(upper).toBeUndefined();
    expect(resolveBinary(exe, { platform: "win32", pathEnv: "", pathExt: ".CMD" })).toBe(exe);
    // A bare name still only tries the listed extensions.
    expect(resolveBinary("tool", { platform: "win32", pathEnv: dir, pathExt: ".CMD;.BAT" })).toBeUndefined();
  });

  it("never picks a .ps1 implicitly from PATHEXT, and unwraps or rejects an explicit one instead of spawning it", () => {
    const dir = mkdtempSync(join(root, "ps1-"));
    executable(join(dir, "tool.ps1"), "#!/usr/bin/env pwsh\n");
    expect(resolveBinary("tool", { platform: "win32", pathEnv: dir, pathExt: ".PS1;.EXE" })).toBeUndefined();
    const exe = executable(join(dir, "tool.exe"));
    expect(resolveBinary("tool", { platform: "win32", pathEnv: dir, pathExt: ".PS1;.EXE" })).toBe(exe);

    const npmDir = mkdtempSync(join(root, "npm-ps1-"));
    const shim = executable(join(npmDir, "cli.ps1"), '#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "node$exe" "$basedir/node_modules/cli/bin/cli.js" $args\n');
    expect(resolveLaunch(shim, { platform: "win32" })).toEqual({
      command: process.execPath, prefixArgs: [join(npmDir, "node_modules/cli/bin/cli.js")],
    });
    const foreign = executable(join(npmDir, "other.ps1"), "Write-Host hi\n");
    expect(() => unwrapLauncher(foreign, "win32")).toThrowError(expect.objectContaining({ code: "CLI_NOT_FOUND", message: expect.stringContaining(".ps1") }));
    expect(unwrapLauncher(foreign, "linux")).toEqual({ command: foreign, prefixArgs: [] });
  });

  it("gitInvocation launches the resolved git as an absolute program with no shim prefix", () => {
    const launch = gitInvocation(["status"]);
    expect(isAbsolute(launch.command)).toBe(true);
    expect(launch.command).toBe(resolveBinary("git"));
    expect(launch.args).toEqual(["status"]); // A real executable has no launcher prefix.
  });
});

describe("readNpmShimTarget comment lines", () => {
  function shim(name: string, content: string): string {
    const dir = mkdtempSync(join(root, "shim-"));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it("ignores REM, @REM and :: lines of a .cmd shim, CRLF or not, so a comment cannot name the target", () => {
    const content = [
      "@ECHO off", 'REM was "%dp0%\\node_modules\\old\\unused.js"', '@rem also "%~dp0\\stale.js"', ':: "C:\\abs\\commented.js"', '   rem "%dp0%\\indented.js"',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\cli\\bin\\real.js" %*', "",
    ].join("\r\n");
    const path = shim("cli.cmd", content);
    expect(readNpmShimTarget(path)).toBe(join(path, "..", "node_modules", "cli", "bin", "real.js"));
  });

  it("does not treat a command that merely starts with the letters rem as a comment", () => {
    const path = shim("cli.bat", '@echo off\r\nremote "%dp0%\\bin\\actual.js" %*\r\n');
    expect(readNpmShimTarget(path)).toBe(join(path, "..", "bin", "actual.js"));
  });

  it("finds nothing when the only script mentioned is in a comment", () => {
    expect(readNpmShimTarget(shim("cli.cmd", '@echo off\r\nREM runs "%dp0%\\unused.js"\r\necho hi\r\n'))).toBeUndefined();
  });

  it("ignores # comment lines of a .ps1 or POSIX shim", () => {
    const sh = shim("cli", '#!/bin/sh\n# "$basedir/unused.js"\nexec node "$basedir/real.js" "$@"\n');
    expect(readNpmShimTarget(sh)).toBe(join(sh, "..", "real.js"));
  });
});

describe("execProbe", () => {
  it.skipIf(process.platform === "win32")("returns a clean exit 0 promptly even when a grandchild keeps the output pipes open", async () => {
    // The shell exits at once, the background sleeper inherits stdout/stderr and keeps them open.
    const started = performance.now();
    const result = await execProbe("/bin/sh", ["-c", "echo done; sleep 30 & exit 0"], 20_000);
    expect(result).toMatchObject({ ok: true, exitCode: 0, timedOut: false });
    expect(result.stdout).toContain("done");
    expect(performance.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it.skipIf(process.platform === "win32")("still reports a non-zero exit with its code when pipes stay open", async () => {
    const result = await execProbe("/bin/sh", ["-c", "echo bad >&2; sleep 30 & exit 3"], 20_000);
    expect(result).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    expect(result.stderr).toContain("bad");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. Windows command-line length
// ---------------------------------------------------------------------------

describe("Windows command-line limit counts the terminating NUL", () => {
  /** An argument that makes `a b` plus the argument exactly `total` characters long. */
  const lineOf = (total: number) => {
    const prefix = windowsCommandLineLength("a", [""]);
    return "x".repeat(total - prefix + 2);
  };

  it("allows 32,766 characters and rejects 32,767 (CreateProcessW: 32,767 UTF-16 units including the NUL)", () => {
    expect(MAX_WINDOWS_COMMAND_LINE_CHARS).toBe(32_766);
    const fits = lineOf(32_766);
    expect(windowsCommandLineLength("a", [fits])).toBe(32_766);
    expect(() => assertCommandLineFits("Tool", "a", [fits], "win32")).not.toThrow();
    const tooLong = lineOf(32_767);
    expect(windowsCommandLineLength("a", [tooLong])).toBe(32_767);
    expect(() => assertCommandLineFits("Tool", "a", [tooLong], "win32")).toThrowError(expect.objectContaining({
      code: "PROMPT_TOO_LARGE", details: { command_line_chars: 32_767, limit_chars: 32_766 },
    }));
    expect(() => assertCommandLineFits("Tool", "a", [tooLong], "linux")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. CRLF-preserving JSONC edits
// ---------------------------------------------------------------------------

describe("jsonc-edit keeps CRLF line endings", () => {
  const crlf = (text: string) => text.replace(/\n/g, "\r\n");
  const hasBareLf = (text: string) => /(?<!\r)\n/.test(text);

  it("detects the document's own line ending", () => {
    expect(detectEol("{\r\n  \"a\": 1\r\n}")).toBe("\r\n");
    expect(detectEol("{\n  \"a\": 1\n}")).toBe("\n");
    expect(detectEol("{}")).toBe("\n");
  });

  it("inserts a new member into a multi-line CRLF object with CRLF, and a comment keeps its own line", () => {
    const text = crlf('{\n  // servers\n  "mcpServers": {\n    "a": { "command": "x" } // keep\n  }\n}\n');
    const out = setValueAt(text, parseJsonc(text), ["mcpServers", "orchestrator"], { command: "node", args: ["main.js", "mcp"] });
    expect(hasBareLf(out)).toBe(false);
    expect(nodeToValue(parseJsonc(out))).toEqual({
      mcpServers: { a: { command: "x" }, orchestrator: { command: "node", args: ["main.js", "mcp"] } },
    });
    expect(out).toContain('"a": { "command": "x" }, // keep\r\n');
    expect(out).toContain('    "orchestrator": {\r\n      "command": "node",');
  });

  it("creates missing parents and fills an empty object with CRLF", () => {
    const empty = crlf("{\n}\n");
    const created = setValueAt(empty, parseJsonc(empty), ["mcpServers", "o"], { command: "n" });
    expect(hasBareLf(created)).toBe(false);
    expect(nodeToValue(parseJsonc(created))).toEqual({ mcpServers: { o: { command: "n" } } });
    const hollow = crlf('{\n  "mcpServers": {}\n}\n');
    expect(hasBareLf(setValueAt(hollow, parseJsonc(hollow), ["mcpServers", "o"], { command: "n" }))).toBe(false);
  });

  it("replaces an existing multi-line value with CRLF and removes members cleanly", () => {
    const text = crlf('{\n  "mcpServers": {\n    "o": { "command": "old" },\n    "b": 1 // tail\n  }\n}\n');
    const replaced = setValueAt(text, parseJsonc(text), ["mcpServers", "o"], { command: "new", args: ["1"] });
    expect(hasBareLf(replaced)).toBe(false);
    expect(nodeToValue(getNodeAt(parseJsonc(replaced), ["mcpServers", "o"])!)).toEqual({ command: "new", args: ["1"] });
    const removed = removeValueAt(text, parseJsonc(text), ["mcpServers", "b"]);
    expect(hasBareLf(removed)).toBe(false);
    expect(removed).not.toContain("tail");
    expect(nodeToValue(parseJsonc(removed))).toEqual({ mcpServers: { o: { command: "old" } } });
  });

  it("leaves LF documents byte-for-byte LF", () => {
    const text = '{\n  "mcpServers": {\n    "a": 1\n  }\n}\n';
    expect(setValueAt(text, parseJsonc(text), ["mcpServers", "o"], { command: "n" })).not.toContain("\r");
  });
});
