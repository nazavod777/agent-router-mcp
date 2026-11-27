import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execProbe, PROBE_OUTPUT_LIMIT_BYTES, resolveBinary } from "../../src/adapters/probe-utils.js";

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "linux") return true;
    return !readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /, "").startsWith("Z");
  } catch {
    return false;
  }
}

async function readWhenCreated(path: string, waitMs = 3_000): Promise<string> {
  const deadline = performance.now() + waitMs;
  for (;;) {
    try {
      const value = readFileSync(path, "utf8");
      if (value) return value;
    } catch {
      // Not created yet.
    }
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await setTimeout(10);
  }
}

describe("probe utilities", () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "orch-probe-utils-")); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function makeExecutable(path: string): string {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(path, 0o755);
    return path;
  }

  describe("resolveBinary", () => {
    // A bare name resolves through PATHEXT on Windows, so an extensionless POSIX-style file would never be found there.
    const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

    it("skips relative PATH entries so a file in the working directory can never hijack a command name", () => {
      makeExecutable(join(root, "rel-bin", exe("tool")));
      makeExecutable(join(root, exe("tool")));
      vi.spyOn(process, "cwd").mockReturnValue(root);
      for (const pathEnv of ["rel-bin", ".", "", `.${delimiter}rel-bin`, "./rel-bin", `${delimiter}`]) {
        expect(resolveBinary("tool", { pathEnv }), JSON.stringify(pathEnv)).toBeUndefined();
      }
      // An absolute entry after relative ones still works.
      expect(resolveBinary("tool", { pathEnv: `.${delimiter}${join(root, "rel-bin")}` })).toBe(join(root, "rel-bin", exe("tool")));
    });

    it("resolves a relative binary path against the explicit base directory only, never the working directory", () => {
      const wrapper = makeExecutable(join(root, "config", "bin", exe("wrapper")));
      makeExecutable(join(root, "cwd", "bin", exe("wrapper")));
      vi.spyOn(process, "cwd").mockReturnValue(join(root, "cwd"));
      expect(resolveBinary("./bin/wrapper", { baseDir: join(root, "config") })).toBe(wrapper);
      expect(resolveBinary("bin/wrapper", { baseDir: join(root, "config") })).toBe(wrapper);
      expect(resolveBinary("./bin/wrapper")).toBeUndefined();
      expect(resolveBinary("./bin/wrapper", { baseDir: "relative-base" })).toBeUndefined();
    });

    it("tries PATHEXT extensions for a bare name on Windows and keeps an explicit extension", () => {
      const cmd = makeExecutable(join(root, "bin", "tool.cmd"));
      const exe = makeExecutable(join(root, "bin", "other.exe"));
      const windows = { platform: "win32", pathEnv: join(root, "bin"), pathExt: ".EXE;.CMD" } as const;
      expect(resolveBinary("tool", windows)).toBe(cmd);
      expect(resolveBinary("other", windows)).toBe(exe);
      expect(resolveBinary("other.exe", windows)).toBe(exe);
      expect(resolveBinary("tool.cmd", windows)).toBe(cmd);
      expect(resolveBinary("missing", windows)).toBeUndefined();
      // The default list (.exe, .cmd, .bat, .com) applies when PATHEXT is not set.
      const bat = makeExecutable(join(root, "bin", "legacy.bat"));
      expect(resolveBinary("legacy", { platform: "win32", pathEnv: join(root, "bin"), pathExt: "" })).toBe(bat);
    });

    it("does not guess extensions off Windows", () => {
      makeExecutable(join(root, "bin", "tool.cmd"));
      expect(resolveBinary("tool", { platform: "linux", pathEnv: join(root, "bin"), pathExt: ".CMD" })).toBeUndefined();
    });
  });

  describe.skipIf(process.platform === "win32")("execProbe", () => {
    it("redacts a secret before the byte cap clips the output inside it", async () => {
      const secret = "synthetic-probe-secret-0123456789";
      vi.stubEnv("PROBE_TEST_TOKEN", secret);
      // Space-separated padding fills the cap so that only the first bytes of the secret are still inside it.
      const padding = "pad ".repeat(Math.floor((PROBE_OUTPUT_LIMIT_BYTES - 16) / 4));
      const script = `process.stdout.write("first line\\n" + ${JSON.stringify(padding)} + process.env.PROBE_TEST_TOKEN)`;
      const result = await execProbe(process.execPath, ["-e", script], 10_000);
      expect(result.ok).toBe(false); // Output over the cap fails the probe, as before.
      expect(result.stdout).toContain("first line");
      expect(result.stdout).not.toContain("synth");
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(PROBE_OUTPUT_LIMIT_BYTES);
    });

    it("keeps reporting ordinary output, exit codes and missing commands", async () => {
      vi.stubEnv("PROBE_TEST_TOKEN", "synthetic-probe-secret-0123456789");
      expect(await execProbe(process.execPath, ["-e", 'console.log("v1.2.3 " + process.env.PROBE_TEST_TOKEN)'], 10_000))
        .toMatchObject({ ok: true, exitCode: 0, timedOut: false, stdout: "v1.2.3 [REDACTED]\n" });
      expect(await execProbe(process.execPath, ["-e", "process.exit(3)"], 10_000)).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
      const missing = await execProbe(join(root, "absent"), []);
      expect(missing).toMatchObject({ ok: false, timedOut: false });
      expect(missing.stderr).toContain("ENOENT");
    });

    it("terminates the whole process tree on timeout instead of waiting for a grandchild that holds the pipes", async () => {
      const pidFile = join(root, "grandchild.pid");
      const grandchild = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1_000);`;
      // The grandchild inherits stdout, so the pipe stays open after the direct child is killed.
      const script = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });
        setInterval(() => {}, 1_000);`;
      const started = performance.now();
      const probe = execProbe(process.execPath, ["-e", script], 500);
      const pid = Number(await readWhenCreated(pidFile));
      try {
        expect(isLive(pid)).toBe(true);
        expect(await probe).toMatchObject({ ok: false, timedOut: true });
        expect(performance.now() - started).toBeLessThan(5_000);
        await setTimeout(50);
        expect(isLive(pid)).toBe(false);
      } finally {
        if (isLive(pid)) process.kill(pid, "SIGKILL");
      }
    }, 15_000);
  });
});
