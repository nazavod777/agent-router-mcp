import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalPath } from "./atomic-file.js";
import {
  assertInstanceSkillWritable, createInstallContext, fixTargetId, inspectMcp, parseTargetList, resolveTargets, targetUsage,
  type ClientTarget, type InstallContext,
} from "./mcp-install.js";
import { CLI_NAME } from "./name.js";
import { installSkillDir } from "./skill-install.js";
import { processIo, type CliIo } from "./table.js";

function usage(): string {
  return `Usage: ${CLI_NAME} skill print|path|install [--target ${targetUsage()}] [--dir <customDir>]`;
}

interface SkillTarget {
  /** The resolved client location; absent for `--dir`. */
  client?: ClientTarget;
  skillDir: string;
}

/** `all` = the core CLIs plus every other CLI detected on this machine (and every instance); `antigravity` also brings its instances. */
async function selectTargets(values: { target?: string[]; dir?: string }, ctx: InstallContext): Promise<SkillTarget[]> {
  if (values.dir !== undefined) {
    if (values.dir.trim() === "") throw new Error("--dir must not be empty.");
    if (values.target !== undefined) throw new Error("--dir cannot be combined with --target.");
    return [{ skillDir: resolve(ctx.cwd, values.dir, "orchestrate") }];
  }
  const { targets } = await resolveTargets(ctx, parseTargetList(values.target), { alwaysInclude: (spec) => spec.core });
  return targets.map((target) => ({ client: target, skillDir: target.layout.skillDir }));
}

/** Drops targets whose real directory was already seen (for example two symlinks to one skills folder); Windows paths compare case-insensitively. */
async function dedupe(targets: SkillTarget[], ctx: InstallContext): Promise<SkillTarget[]> {
  const seen = new Set<string>();
  const unique: SkillTarget[] = [];
  for (const target of targets) {
    const real = await canonicalPath(target.skillDir);
    const key = ctx.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

/** One line per client that now has the skill but no working MCP registration. */
async function driftNotes(clients: ClientTarget[], ctx: InstallContext): Promise<string[]> {
  const notes: string[] = [];
  for (const client of clients) {
    const { status } = await inspectMcp(client, ctx);
    if (status === "current") continue;
    const id = await fixTargetId(client, ctx);
    const fix = status === "missing" || status === "stale"
      ? `Run: ${CLI_NAME} mcp install --target ${id}  (or: ${CLI_NAME} setup --target ${id})`
      : `Run: ${CLI_NAME} mcp status --target ${id}`;
    notes.push(`Note: ${id}: the skill is installed but its MCP registration is ${status}. ${fix}`);
  }
  return notes;
}

async function runInstall(args: string[], io: CliIo, ctx: InstallContext): Promise<number> {
  const { values } = parseArgs({ args, options: { target: { type: "string", multiple: true }, dir: { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    io.out(usage());
    return 0;
  }
  const targets = await dedupe(await selectTargets(values, ctx), ctx);
  let failed = false;
  const installedClients: ClientTarget[] = [];
  for (const target of targets) {
    try {
      if (target.client) assertInstanceSkillWritable(target.client, ctx);
      io.out((await installSkillDir(target.skillDir, ctx.skillSourcePath, false)).path);
      if (target.client) installedClients.push(target.client);
    } catch (error) {
      failed = true;
      io.err(`${CLI_NAME}: ${target.client?.targetId ?? "skill"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const note of await driftNotes(installedClients, ctx)) io.err(note);
  return failed ? 1 : 0;
}

export async function runSkillCommand(
  [command, ...args]: string[], io: CliIo = processIo, ctx: InstallContext = createInstallContext(),
): Promise<number> {
  if ((command === "path" || command === "print") && args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    io.out(usage());
  } else if (command === "path" && !args.length) {
    io.out(ctx.skillSourcePath);
  } else if (command === "print" && !args.length) {
    process.stdout.write(await readFile(ctx.skillSourcePath, "utf8"));
  } else if (command === "install") {
    return runInstall(args, io, ctx);
  } else if (command === undefined || command === "--help" || command === "-h") {
    io.out(usage());
  } else {
    throw new Error(usage());
  }
  return 0;
}
