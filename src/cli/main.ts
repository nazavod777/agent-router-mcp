#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getLocksDir } from "../config/paths.js";
import { logger, redactSecrets } from "../logging.js";
import { runStdioMcpServer } from "../mcp/server.js";
import { startSettingsUi } from "../settings-ui/server.js";
import { runConfigCommand } from "./config-cmd.js";
import { runDoctorCommand } from "./doctor.js";
import { runMcpCommand, runSetupCommand } from "./mcp-cmd.js";
import { CLI_NAME } from "./name.js";
import { runSkillCommand } from "./skill-cmd.js";
import { runWaitCommand } from "./wait-cmd.js";

const HELP = `Usage: ${CLI_NAME} <command> [options]

  mcp                                      Start the stdio MCP server
  mcp install|status|uninstall [--target <cli>|all] [--dry-run] [--force] [--check] [--json]
                                           Register the MCP server in CLI configs (see ${CLI_NAME} mcp --help)
  setup [--target <cli>|all] [--dry-run] [--force] [--json]
                                           Register the MCP server and install the skill in one step
  settings [--no-open] [--port <number>]   Start the local settings UI
  doctor [--json]                          Check CLI availability and configuration
  config path|show|get|set|reset           Inspect or change configuration
  models discover [--harness <id>] [--offline] [--all] [--apply --select <key>|--all-new] [--json]
                                           Find models the installed CLIs offer and import them (see ${CLI_NAME} models --help)
  skill print|path|install [--target <cli>|all] [--dir <dir>]
                                           Read or install the orchestration skill
  wait --job <id> [--until any|all]        Wait for jobs to finish (see ${CLI_NAME} wait --help)

Options: -h, --help, -v, --version`;

async function runSettings(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { "no-open": { type: "boolean" }, port: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help) {
    console.log(`Usage: ${CLI_NAME} settings [--no-open] [--port <0-65535>]`);
    return;
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65_535) {
      throw new Error("--port must be an integer between 0 and 65535.");
    }
  }

  const handle = await startSettingsUi({ port, openBrowser: !values["no-open"], lockDir: getLocksDir() });
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void handle.close().catch((error: unknown) => {
      logger.error("Could not close settings UI.", { message: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  try {
    console.log(`Settings UI: ${handle.url}\nPress Ctrl+C to stop`);
    await handle.waitUntilClosed;
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
  }
}

/**
 * `forcedCommand` is set only by the quiet `dist/cli/mcp.js` entrypoint (kept for hand-written `node .../mcp.js` configs):
 * it always runs `mcp` and treats every argument as an error instead of a subcommand.
 */
export async function runCli(rawArgs: string[], forcedCommand?: string): Promise<void> {
  const [first, ...rest] = rawArgs;
  const command = forcedCommand ?? first;
  const args = forcedCommand !== undefined ? rawArgs : rest;

  try {
    switch (command) {
      case "mcp":
        // Bare `mcp` (and the legacy mcp.js entrypoint) must stay a pure stdio server.
        if (args.length === 0) await runStdioMcpServer();
        else if (forcedCommand !== undefined) throw new Error(`Usage: ${CLI_NAME} mcp`);
        else process.exitCode = await runMcpCommand(args);
        break;
      case "setup":
        process.exitCode = await runSetupCommand(args);
        break;
      case "settings":
        await runSettings(args);
        break;
      case "doctor":
        await runDoctorCommand(args);
        break;
      case "config":
        await runConfigCommand(args);
        break;
      case "models": {
        // Loaded on demand: the MCP server process (`mcp`) must never load model discovery.
        const { runModelsCommand } = await import("./models-cmd.js");
        process.exitCode = await runModelsCommand(args);
        break;
      }
      case "skill":
        process.exitCode = await runSkillCommand(args);
        break;
      case "wait":
        process.exitCode = await runWaitCommand(args);
        break;
      case "-v":
      case "--version": {
        const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
        console.log(version);
        break;
      }
      case "-h":
      case "--help":
      case undefined:
        console.log(HELP);
        break;
      default:
        throw new Error(`Unknown command ${JSON.stringify(command)}. See ${CLI_NAME} --help.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (command === "mcp" && (args.length === 0 || forcedCommand !== undefined)) logger.error("MCP server failed.", { message });
    else process.stderr.write(`${CLI_NAME}: ${redactSecrets(message)}\n`);
    process.exitCode = 1;
  }
}

function isDirectEntrypoint(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntrypoint()) {
  void runCli(process.argv.slice(2));
}
