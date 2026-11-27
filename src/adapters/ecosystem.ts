import { homedir } from "node:os";
import { join } from "node:path";
import { outputModeFor, withInlineSystemContext, writePromptFile } from "./parsers.js";
import { adapterError, BoundedLines, isExplicitEffort, isObject, mapEffortWith, readOptionalConfigText, tryParseJson } from "./probe-utils.js";
import { createAssistantEventParser, ExperimentalAdapter } from "./vendor-clis.js";
import type { AdapterStreamParser, BuildInvocationInput } from "./types.js";

const MAX_COPILOT_MCP_CONFIG_BYTES = 1024 * 1024;
const MAX_DENIED_MCP_SERVERS = 64;
const MAX_MCP_SERVER_NAME_CHARS = 128;

/**
 * Names of the MCP servers in the user's Copilot config (`$COPILOT_HOME/mcp-config.json`, default `~/.copilot`), to be
 * denied one by one. A missing file means no servers. A file that exists but cannot be read safely (not a regular file,
 * oversized, unreadable, invalid JSON), or that holds servers that cannot be denied by name (more than the cap, empty,
 * overlong or dash-prefixed names, which Copilot would read as another flag), fails closed with an explicit refusal:
 * silently running with some servers callable would break the isolation the run asked for.
 */
export async function readCopilotMcpServerNames(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const path = join(env.COPILOT_HOME || join(homedir(), ".copilot"), "mcp-config.json");
  const refuse = (reason: string) => adapterError("SANDBOX_POLICY_VIOLATION",
    `MCP servers must be denied for this Copilot run (inherit_mcp is false or the run is readonly), but ${path} ${reason}, ` +
    "so its servers cannot all be denied by name. " +
    `Repair the file (valid JSON, at most ${MAX_DENIED_MCP_SERVERS} servers, names of 1-${MAX_MCP_SERVER_NAME_CHARS} characters not starting with "-") ` +
    "or remove it.", false);
  let text: string | undefined;
  try {
    text = await readOptionalConfigText(path, MAX_COPILOT_MCP_CONFIG_BYTES);
  } catch (error) {
    throw refuse(`could not be read safely (${error instanceof Error ? error.message : "unknown error"})`);
  }
  if (text === undefined) return [];
  const config = tryParseJson(text);
  if (!isObject(config)) throw refuse("is not a valid JSON object");
  const servers = config.mcpServers ?? config.servers;
  if (servers === undefined) return [];
  if (!isObject(servers)) throw refuse("has a servers entry that is not an object");
  const names = Object.keys(servers);
  if (names.length > MAX_DENIED_MCP_SERVERS) throw refuse(`defines ${names.length} MCP servers`);
  if (names.some((name) => name === "" || name.length > MAX_MCP_SERVER_NAME_CHARS || name.startsWith("-"))) {
    throw refuse("has an MCP server whose name is empty, too long or starts with a dash");
  }
  return names;
}

export class CopilotAdapter extends ExperimentalAdapter {
  readonly driver = "copilot" as const;

  async buildInvocation(input: BuildInvocationInput) {
    const prompt = this.argvPrompt(input);
    // Anything that grants tools or paths widens a readonly run; --yolo also drops the approvals of a write run.
    this.assertExtraArgs(input,
      /^(--yolo|--allow-all|--allow-all-tools|--allow-all-paths|--allow-all-urls|--allow-tool|--add-dir|--additional-mcp-config)(=|$)/,
      /^(--yolo|--allow-all)(=|$)/);
    const result = this.invocation(input, ["--output-format", "json", "-s"]);
    if (input.model.cli_model !== "default") result.args.push("--model", input.model.cli_model);
    const extra = input.harness.extra_args ?? [];
    if (input.mode === "readonly") {
      // No blanket allow-all and no `--allow-tool`: nothing is granted, so in non-interactive mode (`-p`) Copilot refuses
      // every tool that needs approval instead of asking, and writing and shell are denied explicitly as well (a deny
      // always wins over an allow, even one added later through `extra_args`).
      result.args.push("--deny-tool", "write", "--deny-tool", "shell");
    } else {
      result.args.push("--allow-all-tools");
      this.warnUnsandboxed(result);
    }
    if (!input.inheritMcp || input.mode === "readonly") {
      result.args.push("--disable-builtin-mcps");
      // `--deny-tool mcp` only matches a server literally named "mcp"; the user's servers are denied by their own names.
      // A config that cannot be read or named safely refuses the run (see `readCopilotMcpServerNames`) instead of
      // leaving servers callable without saying so.
      for (const server of await readCopilotMcpServerNames()) result.args.push("--deny-tool", server);
      result.warnings.push("Copilot CLI has no flag that disables user-configured MCP servers; they are denied by name from the user's config, and servers added later may remain callable.");
    }
    result.args.push(...extra, `-p=${prompt}`);
    return this.finalize(result);
  }

  override createStreamParser(): AdapterStreamParser {
    const events = createAssistantEventParser(this.label);
    let firstLine = true;
    let pretty: BoundedLines | undefined;
    return {
      checkpoint: () => events.checkpoint(),
      progressEvents: () => events.progressEvents(),
      pushLine(line) {
        if (!line.trim()) return;
        if (firstLine && line.trim() === "{") pretty = new BoundedLines();
        firstLine = false;
        if (pretty) pretty.push(line);
        else events.pushLine(line);
      },
      finish(input) {
        if (pretty) {
          const buffered = pretty.text();
          const whole = pretty.overflowed ? undefined : tryParseJson(buffered);
          if (isObject(whole)) events.pushLine(JSON.stringify(whole));
          else for (const line of buffered.split("\n")) events.pushLine(line);
        }
        return events.finish(input);
      },
    };
  }
}

export class DroidAdapter extends ExperimentalAdapter {
  readonly driver = "droid" as const;
  protected override readonly authEnv = ["FACTORY_API_KEY"];

  override mapEffort(effort: string) {
    return mapEffortWith({ off: "off", none: "off", minimal: "low", "extra-high": "high", xhigh: "high", max: "high" }, effort);
  }

  async buildInvocation(input: BuildInvocationInput) {
    this.assertExtraArgs(input, /^(--auto|--skip-permissions-unsafe)(=|$)/, /^--skip-permissions-unsafe(=|$)/);
    const result = this.invocation(input, ["exec", "--output-format", "json"]);
    if (input.model.cli_model !== "default") result.args.push("-m", input.model.cli_model);
    if (isExplicitEffort(result.nativeEffort)) result.args.push("--reasoning-effort", result.nativeEffort);
    const extra = input.harness.extra_args ?? [];
    if (input.mode === "write") {
      result.args.push("--auto", input.harness.write_permission_mode ?? "medium");
      this.warnUnsandboxed(result);
    }
    const file = await writePromptFile(input.jobDir, "droid-prompt.txt", withInlineSystemContext(input.prompt, input.systemContext).text);
    result.tempFiles.push(file);
    result.args.push("-f", file, ...extra);
    return this.finalize(result);
  }
}

// Kimi imports built-in tools by qualified name. allowed_tools also limits the visible tool names.
const KIMI_READONLY_AGENT = `version: 1
agent:
  extend: default
  name: orch-readonly
  tools:
    - kimi_cli.tools.file:ReadFile
    - kimi_cli.tools.file:Glob
    - kimi_cli.tools.file:Grep
  allowed_tools: [ReadFile, Glob, Grep]
  subagents: {}
`;

export class KimiAdapter extends ExperimentalAdapter {
  readonly driver = "kimi" as const;
  protected override readonly authEnv = ["MOONSHOT_API_KEY", "KIMI_API_KEY"];

  async buildInvocation(input: BuildInvocationInput) {
    const prompt = this.argvPrompt(input);
    this.assertExtraArgs(input, /^(--agent-file|--agent|--yolo|--auto)(=|$)/);
    const result = this.invocation(input, ["--print", "--output-format", "stream-json"]);
    if (input.model.cli_model !== "default") result.args.push("--model", input.model.cli_model);
    const extra = input.harness.extra_args ?? [];
    if (input.mode === "readonly") {
      const file = await writePromptFile(input.jobDir, "kimi-readonly-agent.yaml", KIMI_READONLY_AGENT);
      result.tempFiles.push(file);
      result.args.push("--agent-file", file);
    } else {
      this.warnUnsandboxed(result);
    }
    result.args.push(...extra, `--prompt=${prompt}`);
    // stream-json emits incremental events: silence means a stall, unlike buffered output (extra_args may change the format).
    result.outputMode = outputModeFor(result.args, ["--output-format"], "stream-json");
    return this.finalize(result);
  }

  override createStreamParser() { return createAssistantEventParser(this.label); }
}

export class VibeAdapter extends ExperimentalAdapter {
  readonly driver = "vibe" as const;
  protected override readonly authEnv = ["MISTRAL_API_KEY"];

  async buildInvocation(input: BuildInvocationInput) {
    const prompt = this.argvPrompt(input);
    this.assertExtraArgs(input, /^(--auto-approve|--enabled-tools|--agent)(=|$)/);
    const result = this.invocation(input, ["--output", "json"]);
    if (input.model.cli_model !== "default") result.args.push("--model", input.model.cli_model);
    const extra = input.harness.extra_args ?? [];
    if (input.mode === "readonly") {
      result.args.push("--enabled-tools", "read_file,grep,list_dir");
    } else {
      result.args.push("--auto-approve");
      this.warnUnsandboxed(result);
    }
    result.args.push(...extra, `--prompt=${prompt}`);
    return this.finalize(result);
  }
}
