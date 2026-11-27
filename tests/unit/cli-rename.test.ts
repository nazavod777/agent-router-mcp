import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findStaleCliLinks, runDoctorCommand, staleCliLinkWarning } from "../../src/cli/doctor.js";
import { runCli } from "../../src/cli/main.js";
import {
  CLIENTS, classifyEntry, hasDrift, inspectClient, installMcpClient, isCurrent, looksOwned, setupClient, uninstallMcpClient,
  type InstallContext,
} from "../../src/cli/mcp-install.js";
import { CLI_NAME, LEGACY_CLI_NAMES } from "../../src/cli/name.js";
import { FAKE_NODE, makeFixture, read, write, type Fixture } from "./helpers/mcp-fixture.js";

const REAL = { dryRun: false, force: false };
const cursorConfig = (fx: Fixture) => join(fx.home, ".cursor/mcp.json");
const writeEntry = (fx: Fixture, entry: unknown) => write(cursorConfig(fx), JSON.stringify({ mcpServers: { orchestrator: entry } }));
const registered = (fx: Fixture) => JSON.parse(read(cursorConfig(fx))).mcpServers.orchestrator as { command: string; args: string[] };
const canonical = (fx: Fixture) => ({ command: FAKE_NODE, args: [fx.entry, "mcp"] });

/** A package root with the given package name, holding `dist/cli/main.js` and `dist/cli/mcp.js`. */
function makePackage(root: string, name: string | undefined): { main: string; mcp: string } {
  const main = join(root, "dist/cli/main.js");
  const mcp = join(root, "dist/cli/mcp.js");
  write(main, "// main\n");
  write(mcp, "// mcp\n");
  if (name !== undefined) write(join(root, "package.json"), JSON.stringify({ name }));
  return { main, mcp };
}

/** `binary` found on PATH as the given file path, everything else unknown. */
const onPath = (binary: string, target: string) => (name: string) => (name === binary ? target : undefined);

describe("CLI name constant", () => {
  it("is the single source of the command name", () => {
    expect(CLI_NAME).toBe("agrmcp");
    expect(LEGACY_CLI_NAMES).toEqual(["orch", "orchestrator-mcp", "orchestrate-settings"]);
    expect(LEGACY_CLI_NAMES).not.toContain(CLI_NAME);
    expect((JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { bin: unknown }).bin)
      .toEqual({ [CLI_NAME]: "./dist/cli/main.js" });
  });

  describe("entrypoint output", () => {
    afterEach(() => vi.restoreAllMocks());

    it("prefixes errors and the unknown-command hint with the new name", async () => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const previous = process.exitCode;
      try {
        await runCli(["nope"]);
        expect(stderr.mock.calls.join("")).toBe(`${CLI_NAME}: Unknown command "nope". See ${CLI_NAME} --help.\n`);
      } finally {
        process.exitCode = previous;
      }
    });

    it("documents settings and mcp usage under the new name", async () => {
      const lines: string[] = [];
      vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
      await runCli(["settings", "--help"]);
      await runCli(["--help"]);
      expect(lines[0]).toBe(`Usage: ${CLI_NAME} settings [--no-open] [--port <0-65535>]`);
      expect(lines[1]).toMatch(new RegExp(`^Usage: ${CLI_NAME} <command> \\[options\\]`));
      expect(lines[1]).not.toMatch(/\borch\b|orchestrate-settings|orchestrator-mcp/);
    });
  });
});

describe(`${CLI_NAME} mcp ownership`, () => {
  it("accepts agrmcp that resolves to this build as current, and only while the built file exists", () => {
    const fx = makeFixture();
    const link = join(fx.root, "bin", CLI_NAME);
    mkdirSync(join(fx.root, "bin"));
    symlinkSync(fx.entry, link);
    const ctx: InstallContext = { ...fx.ctx, pathResolver: onPath(CLI_NAME, link) };
    expect(looksOwned([CLI_NAME, "mcp"], ctx)).toBe(true);
    expect(isCurrent([CLI_NAME, "mcp"], ctx)).toBe(true);
    expect(isCurrent([link, "mcp"], ctx)).toBe(true);
    expect(classifyEntry({ argv: [CLI_NAME, "mcp"], disabled: false }, ctx)).toBe("current");
    // Not on PATH at all: still ours by name, but nothing proves it runs this build.
    expect(classifyEntry({ argv: [CLI_NAME, "mcp"], disabled: false }, fx.ctx)).toBe("stale");
    expect(classifyEntry({ argv: [`${CLI_NAME}.cmd`, "mcp"], disabled: false }, fx.ctx)).toBe("stale");
  });

  it("calls agrmcp from another clone of this package owned but stale, and a foreign package a conflict", () => {
    const fx = makeFixture();
    const other = makePackage(join(fx.root, "other-clone"), "agent-router-mcp");
    const foreign = makePackage(join(fx.root, "foreign"), "someone-elses-server");
    const bin = join(fx.root, "bin");
    mkdirSync(bin);
    symlinkSync(other.main, join(bin, "other"));
    symlinkSync(foreign.main, join(bin, "foreign"));
    const view = { argv: [CLI_NAME, "mcp"], disabled: false };
    expect(classifyEntry(view, { ...fx.ctx, pathResolver: onPath(CLI_NAME, join(bin, "other")) })).toBe("stale");
    expect(classifyEntry(view, { ...fx.ctx, pathResolver: onPath(CLI_NAME, join(bin, "foreign")) })).toBe("conflict");
  });

  it("never treats agrmcp as current when its link dangles or the build is missing", () => {
    const fx = makeFixture();
    const bin = join(fx.root, "bin");
    mkdirSync(bin);
    symlinkSync(join(fx.root, "gone/dist/cli/main.js"), join(bin, CLI_NAME));
    const view = { argv: [CLI_NAME, "mcp"], disabled: false };
    expect(classifyEntry(view, { ...fx.ctx, pathResolver: onPath(CLI_NAME, join(bin, CLI_NAME)) })).toBe("stale");

    const missing = makeFixture({ entryPath: join(fx.root, "nope/dist/cli/main.js") });
    expect(isCurrent([FAKE_NODE, missing.ctx.entryPath, "mcp"], missing.ctx)).toBe(false);
    expect(classifyEntry({ argv: [FAKE_NODE, missing.ctx.entryPath, "mcp"], disabled: false }, missing.ctx)).toBe("stale");
    expect(isCurrent([FAKE_NODE, missing.ctx.entryPath, "mcp"], missing.ctx, { assumeEntryExists: true })).toBe(true);
  });

  it("keeps the canonical node argv current only when the built file exists", () => {
    const fx = makeFixture();
    expect(isCurrent([FAKE_NODE, fx.entry, "mcp"], fx.ctx)).toBe(true);
    expect(isCurrent([FAKE_NODE, fx.entry, "other"], fx.ctx)).toBe(false);
    expect(isCurrent(["/opt/other/node", fx.entry, "mcp"], fx.ctx)).toBe(false);
  });

  it.each([
    [["python", "agrmcp", "mcp"]],
    [["/usr/bin/env", "agrmcp", "mcp"]],
    [["bash", "/x/agrmcp", "mcp"]],
    [["agrmcp"]],
    [["agrmcp", "serve"]],
    [["agrmcp", "mcp", "--extra"]],
    [["python", "orch", "mcp"]],
    [["orch"]],
    [["python", "server.py", "/clone/dist/cli/mcp.js"]],
    [["python", "server.py", "/clone/dist/cli/main.js", "mcp"]],
    [["/usr/bin/env", "/clone/dist/cli/mcp.js"]],
    [["/clone/dist/cli/mcp.js"]],
  ])("rejects %j as foreign", async (argv) => {
    expect(looksOwned(argv)).toBe(false);
    const fx = makeFixture();
    const entry = { command: argv[0], args: argv.slice(1) };
    writeEntry(fx, entry);
    expect(await installMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ status: "conflict", action: "skipped" });
    expect(await uninstallMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ status: "conflict", action: "skipped" });
    expect(registered(fx)).toEqual(entry);
  });

  it("does not claim a foreign orch binary on PATH", () => {
    const fx = makeFixture();
    const foreign = join(fx.root, "node_modules/@oxgeneral/orch/dist/cli.js");
    write(foreign, "// foreign orch\n");
    const view = { argv: ["orch", "mcp"], disabled: false };
    expect(classifyEntry(view, { ...fx.ctx, pathResolver: onPath("orch", foreign) })).toBe("conflict");
  });
});

describe("build path ownership", () => {
  it("accepts a build entry only as the script Node runs, after any Node flags", () => {
    const fx = makeFixture();
    const mcp = join(fx.root, "repo/dist/cli/mcp.js");
    write(mcp, "// mcp\n");
    for (const argv of [
      [FAKE_NODE, mcp],
      [FAKE_NODE, fx.entry, "mcp"],
      [FAKE_NODE, "--no-warnings", mcp],
      [FAKE_NODE, "--require", "./preload.js", mcp],
      [FAKE_NODE, "-r", "./preload.js", fx.entry, "mcp"],
    ]) expect(looksOwned(argv), argv.join(" ")).toBe(true);
    for (const argv of [
      [FAKE_NODE, "other.js", mcp],
      [FAKE_NODE, "--require", mcp, "server.js"],
      [FAKE_NODE, fx.entry],
      ["python", "server.py", mcp],
      ["C:\\Python\\python.exe", "server.py", mcp],
    ]) expect(looksOwned(argv), argv.join(" ")).toBe(false);
  });

  it("keeps a foreign entry carrying a build path untouched without --force", async () => {
    const fx = makeFixture();
    const entry = { command: "python", args: ["server.py", fx.entry] };
    writeEntry(fx, entry);
    expect(classifyEntry({ argv: ["python", "server.py", fx.entry], disabled: false }, fx.ctx)).toBe("conflict");
    expect(await installMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ status: "conflict", action: "skipped" });
    expect(registered(fx)).toEqual(entry);
  });
});

describe("npm launcher shims", () => {
  const cmdShim = (target: string) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\n` +
    `IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n` +
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
  const ps1Shim = (target: string) => `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n$exe=""\n` +
    `if (Test-Path "$basedir/node$exe") {\n  & "$basedir/node$exe"  "$basedir/${target}" $args\n} else {\n  & "node$exe"  "$basedir/${target}" $args\n}\nexit $LASTEXITCODE\n`;
  const shShim = (target: string) => `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\n\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/${target}" "$@"\nelse\n  exec node  "$basedir/${target}" "$@"\nfi\n`;

  /** An npm prefix directory next to the fixture's `repo`, so `../repo/dist/cli/main.js` is this build. */
  function prefix(fx: Fixture): string {
    const dir = join(fx.root, "npm");
    mkdirSync(dir);
    write(join(fx.root, "repo/dist/cli/mcp.js"), "// legacy mcp\n");
    return dir;
  }
  const ours = "../repo/dist/cli/main.js";
  const view = (argv: string[]) => ({ argv, disabled: false });

  it.each([
    ["agrmcp.cmd", (target: string) => cmdShim(target.replace(/\//g, "\\"))],
    ["agrmcp.ps1", ps1Shim],
    ["agrmcp", shShim],
  ])("treats %s that runs this build as current", (file, shim) => {
    const fx = makeFixture();
    const shimPath = join(prefix(fx), file);
    write(shimPath, shim(ours));
    const ctx: InstallContext = { ...fx.ctx, pathResolver: onPath(CLI_NAME, shimPath) };
    expect(classifyEntry(view([CLI_NAME, "mcp"]), ctx)).toBe("current");
    expect(classifyEntry(view([shimPath, "mcp"]), fx.ctx)).toBe("current");
  });

  it("follows a symlinked shim and a symlinked target", () => {
    const fx = makeFixture();
    const dir = prefix(fx);
    const real = join(fx.root, "elsewhere/agrmcp.cmd");
    write(real, cmdShim("..\\repo\\dist\\cli\\main.js"));
    symlinkSync(real, join(dir, "agrmcp.cmd"));
    expect(classifyEntry(view([join(dir, "agrmcp.cmd"), "mcp"]), fx.ctx)).toBe("current");
  });

  it("does not call a shim current when its target is another clone, missing, or the build is absent", () => {
    const fx = makeFixture();
    const dir = prefix(fx);
    makePackage(join(fx.root, "other-clone"), "agent-router-mcp");
    write(join(dir, "agrmcp.cmd"), cmdShim("..\\other-clone\\dist\\cli\\main.js"));
    expect(classifyEntry(view([join(dir, "agrmcp.cmd"), "mcp"]), fx.ctx)).toBe("stale");
    write(join(dir, "agrmcp.ps1"), ps1Shim("../gone/dist/cli/main.js"));
    expect(classifyEntry(view([join(dir, "agrmcp.ps1"), "mcp"]), fx.ctx)).toBe("stale");
    const missing = makeFixture({ entryPath: join(fx.root, "nope/dist/cli/main.js") });
    write(join(dir, "agrmcp"), shShim("../nope/dist/cli/main.js"));
    expect(classifyEntry(view([join(dir, "agrmcp"), "mcp"]), missing.ctx)).toBe("stale");
  });

  it.each([
    ["orch.cmd", cmdShim("node_modules\\@oxgeneral\\orch\\dist\\cli.js")],
    ["orch.ps1", ps1Shim("node_modules/@oxgeneral/orch/dist/cli.js")],
    ["orch", shShim("node_modules/@oxgeneral/orch/dist/cli.js")],
    ["orch.cmd", "@echo off\r\nsome-other-tool %*\r\n"],
  ])("never claims a foreign %s", async (file, content) => {
    const fx = makeFixture();
    const shimPath = join(prefix(fx), file);
    write(shimPath, content);
    expect(looksOwned([shimPath, "mcp"], fx.ctx)).toBe(false);
    expect(classifyEntry(view([shimPath, "mcp"]), fx.ctx)).toBe("conflict");
    writeEntry(fx, { command: shimPath, args: ["mcp"] });
    expect(await installMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ status: "conflict", action: "skipped" });
    expect(await uninstallMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ status: "conflict", action: "skipped" });
    expect(registered(fx)).toEqual({ command: shimPath, args: ["mcp"] });
  });

  it.each([
    ["orchestrator-mcp.cmd", cmdShim("..\\repo\\dist\\cli\\mcp.js"), []],
    ["orchestrator-mcp.ps1", ps1Shim("../repo/dist/cli/mcp.js"), []],
    ["orch.cmd", cmdShim("..\\repo\\dist\\cli\\main.js"), ["mcp"]],
    ["orch.ps1", ps1Shim("../repo/dist/cli/main.js"), ["mcp"]],
  ])("treats legacy %s that runs our package as owned and stale, and migrates it", async (file, content, args) => {
    const fx = makeFixture();
    const shimPath = join(prefix(fx), file);
    write(shimPath, content);
    expect(looksOwned([shimPath, ...args], fx.ctx)).toBe(true);
    expect(classifyEntry(view([shimPath, ...args]), fx.ctx)).toBe("stale");
    writeEntry(fx, { command: shimPath, args });
    expect(await installMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ status: "stale", action: "updated", status_after: "current" });
    expect(registered(fx)).toEqual(canonical(fx));
  });

  it("judges a compiled .exe launcher by its name alone", () => {
    const fx = makeFixture();
    const exe = join(prefix(fx), "orch.exe");
    write(exe, "MZ binary");
    expect(classifyEntry(view([exe, "mcp"]), fx.ctx)).toBe("stale");
  });
});

describe("legacy launcher migration", () => {
  const legacyEntries: Array<[string, (fx: Fixture) => { command: string; args: string[] }]> = [
    ["orchestrator-mcp", () => ({ command: "orchestrator-mcp", args: [] })],
    ["orchestrator-mcp.cmd on Windows", () => ({ command: "C:\\bin\\orchestrator-mcp.cmd", args: [] })],
    ["orch mcp", () => ({ command: "orch", args: ["mcp"] })],
    ["node .../dist/cli/mcp.js", (fx) => ({ command: FAKE_NODE, args: [join(fx.root, "repo/dist/cli/mcp.js")] })],
    ["node orchestrator-mcp", () => ({ command: "/usr/bin/node", args: ["/usr/local/bin/orchestrator-mcp"] })],
  ];

  it.each(legacyEntries)("%s is owned and stale, never current", (_name, entry) => {
    const fx = makeFixture();
    write(join(fx.root, "repo/dist/cli/mcp.js"), "// mcp\n");
    const { command, args } = entry(fx);
    const argv = [command, ...args];
    expect(looksOwned(argv)).toBe(true);
    expect(isCurrent(argv, fx.ctx)).toBe(false);
    expect(classifyEntry({ argv, disabled: false }, fx.ctx)).toBe("stale");
    expect(classifyEntry({ argv, disabled: true }, fx.ctx)).toBe("disabled");
  });

  it("a legacy launcher that resolves to this very build is still stale", () => {
    const fx = makeFixture();
    const bin = join(fx.root, "bin");
    mkdirSync(bin);
    for (const name of ["orch", "orchestrator-mcp"]) symlinkSync(fx.entry, join(bin, name));
    for (const [name, argv] of [["orch", ["orch", "mcp"]], ["orchestrator-mcp", ["orchestrator-mcp"]]] as const) {
      const ctx = { ...fx.ctx, pathResolver: onPath(name, join(bin, name)) };
      expect(looksOwned(argv, ctx)).toBe(true);
      expect(classifyEntry({ argv: [...argv], disabled: false }, ctx)).toBe("stale");
    }
  });

  it.each(legacyEntries)("install migrates %s to the canonical argv without --force and keeps a backup", async (_name, entry) => {
    const fx = makeFixture();
    write(join(fx.root, "repo/dist/cli/mcp.js"), "// mcp\n");
    writeEntry(fx, { ...entry(fx), env: { KEEP: "1" } });
    const result = await installMcpClient(CLIENTS.cursor, fx.ctx, REAL);
    expect(result).toMatchObject({ status: "stale", action: "updated", status_after: "current" });
    expect(result.backup_path).toBeDefined();
    expect(registered(fx)).toEqual({ ...canonical(fx), env: { KEEP: "1" } });
    expect(await installMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ action: "unchanged", status: "current" });
  });

  it("status flags a legacy entry as drift and setup repairs it without --force", async () => {
    const fx = makeFixture();
    writeEntry(fx, { command: "orchestrator-mcp", args: [] });
    const before = await inspectClient(CLIENTS.cursor, fx.ctx);
    expect(before).toMatchObject({ mcp_status: "stale", fix_command: `${CLI_NAME} setup --target cursor` });
    expect(hasDrift(before)).toBe(true);

    const result = await setupClient(CLIENTS.cursor, fx.ctx, REAL);
    expect(result).toMatchObject({ ok: true, verified: true });
    expect(result.mcp).toMatchObject({ action: "updated", status_after: "current" });
    expect(registered(fx)).toEqual(canonical(fx));
    expect(hasDrift(await inspectClient(CLIENTS.cursor, fx.ctx))).toBe(false);
  });

  it("uninstall removes a legacy entry", async () => {
    const fx = makeFixture();
    writeEntry(fx, { command: "orch", args: ["mcp"] });
    expect(await uninstallMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ status: "stale", action: "removed" });
    expect(JSON.parse(read(cursorConfig(fx))).mcpServers).toEqual({});
  });

  it("leaves a node mcp.js of an unrelated package alone", async () => {
    const fx = makeFixture();
    const foreign = makePackage(join(fx.root, "foreign"), "someone-elses-server");
    expect(looksOwned([FAKE_NODE, foreign.mcp])).toBe(false);
    writeEntry(fx, { command: FAKE_NODE, args: [foreign.mcp] });
    expect(await installMcpClient(CLIENTS.cursor, fx.ctx, REAL)).toMatchObject({ status: "conflict", action: "skipped" });
  });
});

describe("stale global command links", () => {
  /** A repository with `dist/cli/main.js`, and a PATH made of a bin directory inside a throwaway root. */
  function setup() {
    const fx = makeFixture();
    const repo = join(fx.root, "repo");
    const bin = join(fx.root, "bin");
    const foreignBin = join(fx.root, "foreign-bin");
    mkdirSync(bin);
    mkdirSync(foreignBin);
    return { fx, repo, bin, foreignBin, pathEnv: [bin, foreignBin].join(":") };
  }

  it("reports links that point into the repository, including dangling ones", () => {
    const { fx, repo, bin, pathEnv } = setup();
    symlinkSync(fx.entry, join(bin, "orch"));
    symlinkSync(join(repo, "dist/cli/mcp.js"), join(bin, "orchestrator-mcp"));
    symlinkSync(join(repo, "dist/cli/settings.js"), join(bin, "orchestrate-settings"));
    const links = findStaleCliLinks({ pathEnv, repoRoot: repo, platform: "linux" });
    expect(links.map((link) => link.name)).toEqual(["orch", "orchestrator-mcp", "orchestrate-settings"]);
    expect(links.map((link) => link.path)).toEqual(["orch", "orchestrator-mcp", "orchestrate-settings"].map((name) => join(bin, name)));
    expect(links[0].target).toBe(fx.entry);
    expect(links[2].target).toBe(join(repo, "dist/cli/settings.js"));
  });

  it("follows a chain of links whose last hop is missing", () => {
    const { repo, bin, pathEnv } = setup();
    symlinkSync(join(bin, "hop"), join(bin, "orch"));
    symlinkSync(join(repo, "dist/cli/mcp.js"), join(bin, "hop"));
    expect(findStaleCliLinks({ pathEnv, repoRoot: repo, platform: "linux" })).toMatchObject([{ name: "orch", path: join(bin, "orch") }]);
  });

  it("never flags a foreign orch, the new command, or links into other places", () => {
    const { fx, repo, bin, foreignBin, pathEnv } = setup();
    const foreign = join(fx.root, "node_modules/@oxgeneral/orch/dist/cli.js");
    write(foreign, "// foreign orch\n");
    symlinkSync(foreign, join(foreignBin, "orch"));
    symlinkSync(join(fx.root, "elsewhere/gone.js"), join(foreignBin, "orchestrator-mcp"));
    write(join(foreignBin, "orchestrate-settings"), "#!/bin/sh\n", 0o755);
    symlinkSync(fx.entry, join(bin, CLI_NAME));
    // `repo-sibling` shares the repository's name as a prefix but is outside of it.
    const sibling = join(fx.root, "repo-sibling/dist/cli/main.js");
    write(sibling, "// sibling\n");
    symlinkSync(sibling, join(bin, "orch"));
    expect(findStaleCliLinks({ pathEnv, repoRoot: repo, platform: "linux" })).toEqual([]);
    expect(findStaleCliLinks({ pathEnv: undefined, repoRoot: repo, platform: "linux" })).toEqual([]);
  });

  describe("Windows npm shims and node_modules", () => {
    const cmd = (target: string) => `@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
    const ps1 = (target: string) => `#!/usr/bin/env pwsh\n$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent\n& "node$exe"  "$basedir/${target}" $args\n`;
    const sh = (target: string) => `#!/bin/sh\nexec node  "$basedir/${target}" "$@"\n`;

    it.each(["linux", "win32"] as const)("reports stale .cmd/.ps1/extensionless shims that run this repository (%s)", (platform) => {
      const { repo, bin, foreignBin, pathEnv } = setup();
      write(join(repo, "dist/cli/mcp.js"), "// mcp\n");
      write(join(bin, "orch.cmd"), cmd("..\\repo\\dist\\cli\\main.js"));
      write(join(bin, "orchestrator-mcp.ps1"), ps1("../repo/dist/cli/mcp.js"));
      write(join(bin, "orchestrate-settings"), sh("../repo/dist/cli/settings.js"));
      write(join(foreignBin, "orch.cmd"), cmd("node_modules\\@oxgeneral\\orch\\dist\\cli.js"));
      write(join(foreignBin, "orchestrator-mcp.ps1"), ps1("../elsewhere/dist/cli/mcp.js"));
      const delimiter = platform === "win32" ? ";" : ":";
      const links = findStaleCliLinks({ pathEnv: pathEnv.replace(":", delimiter), repoRoot: repo, platform });
      expect(links.map((link) => link.path).sort()).toEqual(
        ["orch.cmd", "orchestrate-settings", "orchestrator-mcp.ps1"].map((name) => join(bin, name)).sort(),
      );
      expect(links.find((link) => link.name === "orch")?.target).toBe(join(repo, "dist/cli/main.js"));
    });

    it("ignores unrelated binaries inside <repo>/node_modules, links and shims alike", () => {
      const { repo } = setup();
      const nodeBin = join(repo, "node_modules/.bin");
      const foreign = join(repo, "node_modules/orch/dist/cli.js");
      write(foreign, "// unrelated orch\n");
      mkdirSync(nodeBin, { recursive: true });
      symlinkSync(foreign, join(nodeBin, "orch"));
      write(join(nodeBin, "orch.cmd"), cmd("..\\orch\\dist\\cli.js"));
      write(join(nodeBin, "orch.ps1"), ps1("../orch/dist/cli.js"));
      symlinkSync(join(repo, "node_modules/gone/bin.js"), join(nodeBin, "orchestrator-mcp"));
      write(join(repo, "package.json"), "{}");
      expect(findStaleCliLinks({ pathEnv: nodeBin, repoRoot: repo, platform: "linux" })).toEqual([]);
    });

    it("flags a link to the sources under src/cli but not to other repository files", () => {
      const { repo, bin, pathEnv } = setup();
      symlinkSync(join(repo, "src/cli/main.ts"), join(bin, "orch"));
      symlinkSync(join(repo, "README.md"), join(bin, "orchestrator-mcp"));
      expect(findStaleCliLinks({ pathEnv, repoRoot: repo, platform: "linux" }).map((link) => link.name)).toEqual(["orch"]);
    });
  });

  it("lists a link once even when its directory is on PATH twice", () => {
    const { fx, repo, bin } = setup();
    symlinkSync(fx.entry, join(bin, "orch"));
    expect(findStaleCliLinks({ pathEnv: [bin, bin].join(":"), repoRoot: repo, platform: "linux" })).toHaveLength(1);
  });

  it("explains the exact cleanup", () => {
    const warning = staleCliLinkWarning([
      { name: "orch", path: "/home/me/bin/orch", target: "/clone/dist/cli/main.js" },
      { name: "orchestrate-settings", path: "/home/my bin/orchestrate-settings", target: "/clone/dist/cli/settings.js" },
    ]);
    expect(warning).toContain("`rm /home/me/bin/orch` and `rm '/home/my bin/orchestrate-settings'`");
    expect(warning).toContain("npm unlink -g agent-router-mcp && npm link");
    expect(warning).toContain(`\`${CLI_NAME}\``);
  });

  it("uses one PowerShell-safe Remove-Item per link on Windows instead of a multi-path rm", () => {
    const warning = staleCliLinkWarning([
      { name: "orch", path: "C:\\Users\\me\\bin\\orch.cmd", target: "C:\\clone\\dist\\cli\\main.js" },
      { name: "orch", path: "C:\\Users\\it's me\\bin\\orch.ps1", target: "C:\\clone\\dist\\cli\\main.js" },
    ], "win32");
    expect(warning).toContain("`Remove-Item -LiteralPath 'C:\\Users\\me\\bin\\orch.cmd'`; `Remove-Item -LiteralPath 'C:\\Users\\it''s me\\bin\\orch.ps1'`");
    expect(warning).not.toMatch(/\brm\b/);
  });

  describe("agrmcp doctor", () => {
    afterEach(() => vi.unstubAllEnvs());

    async function runDoctor(args: string[], pathEnv: string, repoRoot: string, fx: Fixture): Promise<string> {
      vi.stubEnv("HOME", fx.home);
      vi.stubEnv("XDG_CONFIG_HOME", join(fx.root, "xdg"));
      vi.stubEnv("XDG_STATE_HOME", join(fx.root, "state"));
      vi.stubEnv("ORCH_STATE_DIR", join(fx.root, "orch-state"));
      vi.stubEnv("ORCH_MODELS_PATH", join(fx.root, "models.toml"));
      vi.stubEnv("PATH", join(fx.root, "empty-path"));
      const lines: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
      try {
        await runDoctorCommand(args, fx.ctx, { pathEnv, repoRoot });
      } finally {
        spy.mockRestore();
      }
      return lines.join("\n");
    }

    it("lists stale links in --json and prints a Warning line with cleanup commands", async () => {
      const { fx, repo, bin, pathEnv } = setup();
      symlinkSync(fx.entry, join(bin, "orch"));
      symlinkSync(join(repo, "dist/cli/settings.js"), join(bin, "orchestrate-settings"));
      const report = JSON.parse(await runDoctor(["--json"], pathEnv, repo, fx)) as { stale_cli_links?: unknown[] };
      expect(report.stale_cli_links).toEqual([
        { name: "orch", path: join(bin, "orch"), target: fx.entry },
        { name: "orchestrate-settings", path: join(bin, "orchestrate-settings"), target: join(repo, "dist/cli/settings.js") },
      ]);
      const text = await runDoctor([], pathEnv, repo, fx);
      const warning = text.split("\n").find((line) => line.startsWith("Warning: Stale global command links"));
      expect(warning).toContain(`\`rm ${join(bin, "orch")}\` and \`rm ${join(bin, "orchestrate-settings")}\``);
      expect(warning).toContain("npm unlink -g agent-router-mcp && npm link");
    });

    it("reports a Windows .cmd shim in --json and the warning quotes unsafe paths", async () => {
      const { fx, repo, bin, pathEnv } = setup();
      write(join(bin, "orch.cmd"), `@ECHO off\r\n"%_prog%"  "%dp0%\\..\\repo\\dist\\cli\\main.js" %*\r\n`);
      const report = JSON.parse(await runDoctor(["--json"], pathEnv, repo, fx)) as { stale_cli_links?: Array<{ path: string }> };
      expect(report.stale_cli_links?.map((link) => link.path)).toEqual([join(bin, "orch.cmd")]);
      expect(staleCliLinkWarning([{ name: "orch", path: "/tmp/it's $HOME;x/orch.cmd", target: "/clone/dist/cli/main.js" }]))
        .toContain(`rm '/tmp/it'\\''s $HOME;x/orch.cmd'`);
    });

    it("says nothing when only a foreign orch is installed", async () => {
      const { fx, repo, foreignBin, pathEnv } = setup();
      const foreign = join(fx.root, "node_modules/@oxgeneral/orch/dist/cli.js");
      write(foreign, "// foreign orch\n");
      symlinkSync(foreign, join(foreignBin, "orch"));
      expect(JSON.parse(await runDoctor(["--json"], pathEnv, repo, fx))).not.toHaveProperty("stale_cli_links");
      expect(await runDoctor([], pathEnv, repo, fx)).not.toContain("Stale global command links");
    });
  });
});
