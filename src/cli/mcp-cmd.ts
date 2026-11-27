import { parseArgs } from "node:util";
import {
  createInstallContext, fixAdvice, hasDrift, inspectClient, installMcpClient, isMcpFailure, parseTargetList, resolveTargets, setupClient,
  targetUsage, uninstallMcpClient,
  type ClientStatus, type InstallContext, type McpTargetResult, type MutationOptions, type SetupTargetResult,
} from "./mcp-install.js";
import { CLI_NAME } from "./name.js";
import { formatTable, processIo, type CliIo } from "./table.js";

const MCP_USAGE = `Usage:
  ${CLI_NAME} mcp                                                        Start the stdio MCP server
  ${CLI_NAME} mcp install   [--target <cli>|all] [--dry-run] [--force] [--json]
  ${CLI_NAME} mcp status    [--target <cli>|all] [--check] [--json]
  ${CLI_NAME} mcp uninstall [--target <cli>|all] [--dry-run] [--force] [--json]
Targets: ${targetUsage()}`;

const SETUP_USAGE = `Usage: ${CLI_NAME} setup [--target <cli>|all] [--dry-run] [--force] [--json]
Registers the MCP server and installs the orchestrate skill for each target (\`all\` = CLIs detected on this machine).
Targets: ${targetUsage()}`;

const NO_TARGETS_MESSAGE = `No supported CLI was detected on this machine. Name one explicitly, for example: ${CLI_NAME} setup --target claude`;

const OPTIONS = {
  target: { type: "string", multiple: true },
  "dry-run": { type: "boolean" },
  force: { type: "boolean" },
  json: { type: "boolean" },
  check: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function parseOptions(args: string[], allowed: readonly (keyof typeof OPTIONS)[]) {
  const options = Object.fromEntries(allowed.map((name) => [name, OPTIONS[name]]));
  const { values, positionals } = parseArgs({ args, options, allowPositionals: true });
  if (positionals.length > 0) throw new Error(`Unexpected argument ${JSON.stringify(positionals[0])}.`);
  return values as { target?: string[]; "dry-run"?: boolean; force?: boolean; json?: boolean; check?: boolean; help?: boolean };
}

function mutationOptions(values: { "dry-run"?: boolean; force?: boolean }): MutationOptions {
  return { dryRun: values["dry-run"] === true, force: values.force === true };
}

function messageLines(results: { client: string; message?: string }[]): string[] {
  return results.filter((result) => result.message).map((result) => `  ${result.client}: ${result.message}`);
}

function dryRunNote(dryRun: boolean): string[] {
  return dryRun ? ["", "Dry run: nothing was written."] : [];
}

function renderMutation(results: McpTargetResult[], dryRun: boolean): string {
  if (results.length === 0) return NO_TARGETS_MESSAGE;
  const rows = results.map((result) => [result.client, result.status, result.action, result.status_after, result.config_path]);
  return [formatTable(["Client", "Before", "Action", "After", "Config"], rows), ...messageLines(results), ...dryRunNote(dryRun)].join("\n");
}

async function runInstallLike(
  kind: "install" | "uninstall", args: string[], io: CliIo, ctx: InstallContext,
): Promise<number> {
  const values = parseOptions(args, ["target", "dry-run", "force", "json", "help"]);
  if (values.help) {
    io.out(MCP_USAGE);
    return 0;
  }
  const options = mutationOptions(values);
  const { specs } = await resolveTargets(ctx, parseTargetList(values.target));
  const results: McpTargetResult[] = [];
  for (const spec of specs) results.push(await (kind === "install" ? installMcpClient : uninstallMcpClient)(spec, ctx, options));
  const failed = results.some(isMcpFailure);
  if (values.json) {
    io.out(JSON.stringify({ command: kind, dry_run: options.dryRun, force: options.force, node_path: ctx.nodePath, entry_path: ctx.entryPath, ok: !failed, targets: results }, null, 2));
  } else {
    io.out(renderMutation(results, options.dryRun));
  }
  return failed ? 1 : 0;
}

function renderStatus(statuses: ClientStatus[]): string {
  if (statuses.length === 0) return NO_TARGETS_MESSAGE;
  const rows = statuses.map((status) => [status.client, status.detected ? "yes" : "no", status.mcp_status, status.skill_status, status.config_path]);
  const details = statuses.flatMap((status) => [
    ...(status.mcp_detail ? [`  ${status.client}: ${status.mcp_detail}`] : []),
    ...(status.skill_error ? [`  ${status.client}: skill: ${status.skill_error}`] : []),
    ...(fixAdvice(status) ? [`  ${status.client}: ${fixAdvice(status)}`] : []),
  ]);
  return [formatTable(["Client", "Detected", "MCP", "Skill", "Config"], rows), ...details].join("\n");
}

async function runStatus(args: string[], io: CliIo, ctx: InstallContext): Promise<number> {
  const values = parseOptions(args, ["target", "check", "json", "help"]);
  if (values.help) {
    io.out(MCP_USAGE);
    return 0;
  }
  const { specs } = await resolveTargets(ctx, parseTargetList(values.target));
  const statuses = await Promise.all(specs.map((spec) => inspectClient(spec, ctx)));
  const drift = statuses.some(hasDrift);
  io.out(values.json ? JSON.stringify({ command: "status", node_path: ctx.nodePath, entry_path: ctx.entryPath, drift, targets: statuses }, null, 2) : renderStatus(statuses));
  return values.check && drift ? 1 : 0;
}

export async function runMcpCommand(args: string[], io: CliIo = processIo, ctx: InstallContext = createInstallContext()): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "install":
    case "uninstall":
      return runInstallLike(subcommand, rest, io, ctx);
    case "status":
      return runStatus(rest, io, ctx);
    case "-h":
    case "--help":
    case "help":
      io.out(MCP_USAGE);
      return 0;
    default:
      throw new Error(MCP_USAGE);
  }
}

function renderSetup(results: SetupTargetResult[], dryRun: boolean): string {
  if (results.length === 0) return NO_TARGETS_MESSAGE;
  const rows = results.map((result) => [
    result.mcp.client, `${result.mcp.status} -> ${result.mcp.action}`, `${result.skill.status} -> ${result.skill.action}`,
    dryRun ? "n/a" : result.verified ? "yes" : "no", result.mcp.config_path,
  ]);
  const messages = results.flatMap((result) => [
    ...(result.mcp.message ? [`  ${result.mcp.client}: ${result.mcp.message}`] : []),
    ...(result.skill.message ? [`  ${result.mcp.client}: skill: ${result.skill.message}`] : []),
    ...(!dryRun && result.unverified_reason ? [`  ${result.mcp.client}: not verified: ${result.unverified_reason}`] : []),
  ]);
  return [formatTable(["Client", "MCP", "Skill", "Verified", "Config"], rows), ...messages, ...dryRunNote(dryRun)].join("\n");
}

export async function runSetupCommand(args: string[], io: CliIo = processIo, ctx: InstallContext = createInstallContext()): Promise<number> {
  const values = parseOptions(args, ["target", "dry-run", "force", "json", "help"]);
  if (values.help) {
    io.out(SETUP_USAGE);
    return 0;
  }
  const options = mutationOptions(values);
  const { specs } = await resolveTargets(ctx, parseTargetList(values.target));
  const results: SetupTargetResult[] = [];
  for (const spec of specs) results.push(await setupClient(spec, ctx, options));
  const failed = results.some((result) => !result.ok);
  io.out(values.json
    ? JSON.stringify({ command: "setup", dry_run: options.dryRun, force: options.force, node_path: ctx.nodePath, entry_path: ctx.entryPath, ok: !failed, targets: results }, null, 2)
    : renderSetup(results, options.dryRun));
  return failed ? 1 : 0;
}
