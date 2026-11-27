import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { canonicalPath } from "./atomic-file.js";
import {
  CLIENTS, CLIENT_IDS, createInstallContext, detectClient, inspectMcp, parseTargetList, targetUsage,
  type ClientId, type InstallContext,
} from "./mcp-install.js";
import { CLI_NAME } from "./name.js";
import { installSkillDir } from "./skill-install.js";
import { processIo, type CliIo } from "./table.js";

function usage(): string {
  return `Usage: ${CLI_NAME} skill print|path|install [--target ${targetUsage()}] [--dir <customDir>]`;
}

interface SkillTarget {
  client?: ClientId;
  skillDir: string;
}

/** `all` = the core CLIs plus every other CLI detected on this machine. */
async function allTargets(ctx: InstallContext): Promise<SkillTarget[]> {
  const targets: SkillTarget[] = [];
  for (const id of CLIENT_IDS) {
    const spec = CLIENTS[id];
    if (spec.core || (await detectClient(spec, ctx)).detected) targets.push({ client: id, skillDir: spec.layout(ctx).skillDir });
  }
  return targets;
}

async function selectTargets(values: { target?: string[]; dir?: string }, ctx: InstallContext): Promise<SkillTarget[]> {
  if (values.dir !== undefined) {
    if (values.dir.trim() === "") throw new Error("--dir must not be empty.");
    if (values.target !== undefined) throw new Error("--dir cannot be combined with --target.");
    return [{ skillDir: resolve(ctx.cwd, values.dir, "orchestrate") }];
  }
  const requested = parseTargetList(values.target);
  const unknown = requested.filter((value) => value !== "all" && !Object.hasOwn(CLIENTS, value));
  if (unknown.length > 0) throw new Error(`Unknown target ${unknown.map((value) => JSON.stringify(value)).join(", ")}. ${usage()}`);
  if (requested.includes("all")) return allTargets(ctx);
  return requested.map((id) => ({ client: id as ClientId, skillDir: CLIENTS[id as ClientId].layout(ctx).skillDir }));
}

/** Drops targets whose real directory was already seen (for example two symlinks to one skills folder). */
async function dedupe(targets: SkillTarget[]): Promise<SkillTarget[]> {
  const seen = new Set<string>();
  const unique: SkillTarget[] = [];
  for (const target of targets) {
    const key = await canonicalPath(target.skillDir);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(target);
  }
  return unique;
}

/** One line per client that now has the skill but no working MCP registration. */
async function driftNotes(clients: ClientId[], ctx: InstallContext): Promise<string[]> {
  const notes: string[] = [];
  for (const id of clients) {
    const { status } = await inspectMcp(CLIENTS[id], ctx);
    if (status === "current") continue;
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
  const targets = await dedupe(await selectTargets(values, ctx));
  let failed = false;
  const installedClients: ClientId[] = [];
  for (const target of targets) {
    try {
      io.out((await installSkillDir(target.skillDir, ctx.skillSourcePath, false)).path);
      if (target.client) installedClients.push(target.client);
    } catch (error) {
      failed = true;
      io.err(`${CLI_NAME}: ${target.client ?? "skill"}: ${error instanceof Error ? error.message : String(error)}`);
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
