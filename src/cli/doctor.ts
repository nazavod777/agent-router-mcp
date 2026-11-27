import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AdapterRegistry } from "../adapters/registry.js";
import { discoverAllCliLimits } from "../config/cli-limits.js";
import type { DiscoveryEnvironment, DiscoveryHints } from "../discovery/index.js";
import { DRIVER_METADATA, isStockBinary } from "../drivers.js";
import { getStateDir } from "../config/paths.js";
import { ConfigManager, type ConfigSnapshot } from "../config/resolver.js";
import { redactSecrets } from "../logging.js";
import { resolveHarnessConcurrency } from "../runtime/concurrency.js";
import type { HarnessConcurrencyInfo, HarnessHealth } from "../types.js";
import { coldStartBanner } from "./config-cmd.js";
import { createInstallContext, inspectRelevantClients, type ClientStatus, type InstallContext } from "./mcp-install.js";
import { CLI_NAME, LEGACY_CLI_NAMES } from "./name.js";
import { readNpmShimTarget } from "./npm-shim.js";
import { formatTable } from "./table.js";

/** Compact "parallel/depth" cell: `~` marks a fallback cap, depth `off` means native subagents are disabled. */
function formatParallelDepth(info: HarnessConcurrencyInfo | undefined): string {
  if (!info) return "-";
  const depth = info.native_subagents.startsWith("disabled") ? "off" : info.native_subagents === "unknown" ? "-" : String(info.native_max_depth ?? "-");
  return `${info.effective_cap}${info.fallback_used ? "~" : ""}/${depth}`;
}

const DOCTOR_USAGE = `Usage: ${CLI_NAME} doctor [--json]
Checks which harness CLIs are installed and logged in, the configuration, MCP registrations and skill copies.`;

/**
 * One warning per detected (or skill-bearing) client whose MCP registration is not usable, with the exact fix, and one per
 * client whose registration is current but whose skill copy is missing or outdated.
 */
export function mcpClientWarnings(clients: readonly ClientStatus[]): string[] {
  return clients.flatMap((client) => {
    if (client.mcp_status === "current") {
      if (client.skill_status === "current") return [];
      const reason = client.skill_error ? ` (${client.skill_error})` : "";
      return [`${client.label} (${client.client}): MCP registration is current but the skill is ${client.skill_status} at ${client.skill_path}${reason}; run \`${client.fix_command}\`.`];
    }
    const detail = client.mcp_detail ? ` (${client.mcp_detail})` : "";
    const fix = client.mcp_status === "invalid" ? `fix the syntax in ${client.config_path}, then run \`${client.fix_command}\`` : `run \`${client.fix_command}\``;
    return [`${client.label} (${client.client}): MCP registration is ${client.mcp_status}${detail}; ${fix}.`];
  });
}

/**
 * Config fields the harness's driver never reads, and models the driver cannot start, found by comparing the config with
 * the driver capability table. They are hints: the config still loads.
 */
export function configDiagnostics(config: Pick<ConfigSnapshot, "harnesses" | "models">): string[] {
  const diagnostics: string[] = [];
  for (const [id, harness] of Object.entries(config.harnesses)) {
    const driver = DRIVER_METADATA[harness.driver];
    if (harness.profile !== undefined && !driver.supportsProfile) {
      diagnostics.push(`Harness ${JSON.stringify(id)}: profile is ignored by the ${harness.driver} driver; remove it.`);
    }
    if (harness.default_upstream_provider !== undefined && !driver.usesUpstreamProvider) {
      diagnostics.push(`Harness ${JSON.stringify(id)}: default_upstream_provider is ignored by the ${harness.driver} driver; remove it.`);
    }
  }
  for (const [id, model] of Object.entries(config.models)) {
    const harness = Object.hasOwn(config.harnesses, model.harness) ? config.harnesses[model.harness] : undefined;
    if (!harness) continue;
    const driver = DRIVER_METADATA[harness.driver];
    if (model.cli_provider !== undefined && !driver.usesCliProvider) {
      diagnostics.push(`Model ${JSON.stringify(id)}: cli_provider is ignored by the ${harness.driver} driver; remove it.`);
    }
    if (driver.requiresProviderPrefix && model.cli_provider === undefined && !model.cli_model.includes("/")) {
      diagnostics.push(`Model ${JSON.stringify(id)}: the ${harness.driver} driver needs a provider; set cli_provider or use a "provider/model" cli_model.`);
    }
  }
  return diagnostics;
}

/** A harness that runs a custom wrapper binary and is not usable: the probe's own note says why. */
export function customWrapperWarnings(
  harnesses: ReadonlyArray<Pick<HarnessHealth, "harness" | "driver" | "enabled" | "installed" | "auth_status" | "note" | "probe_inconclusive">>,
  config: Pick<ConfigSnapshot, "harnesses">,
): string[] {
  return harnesses.flatMap((health) => {
    const harness = Object.hasOwn(config.harnesses, health.harness) ? config.harnesses[health.harness] : undefined;
    const custom = harness !== undefined && !isStockBinary(health.driver, harness.binary);
    const failed = !health.installed || health.auth_status === "unauthenticated" || health.probe_inconclusive === true;
    if (!custom || !health.enabled || !failed || !health.note) return [];
    return [`Harness ${JSON.stringify(health.harness)} (custom binary ${JSON.stringify(harness.binary)}) is not usable: ${health.note}`];
  });
}

export interface StaleCliLink {
  name: string;
  path: string;
  target: string;
}

export interface StaleLinkOptions {
  /** PATH value to scan. */
  pathEnv: string | undefined;
  /** Root of this repository; only links resolving to one of its own CLI entry points are reported. */
  repoRoot: string;
  platform: NodeJS.Platform;
}

/** This repository's root: `src/cli` and `dist/cli` both sit two levels below it. */
export function defaultRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const MAX_LINK_HOPS = 16;
/** npm writes `.cmd`/`.ps1` shims next to the extensionless one on Windows; a synced or shared PATH can hold them elsewhere too. */
const SHIM_SUFFIXES = ["", ".cmd", ".ps1"];
const WINDOWS_LINK_SUFFIXES = [...SHIM_SUFFIXES, ".exe"];
const DIST_ENTRY_NAMES = ["main.js", "mcp.js", "settings.js"];

function realOrSame(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function isInside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Final target of a link chain; a dangling chain ends at the last path it points to (so it can still be placed in the repo). */
function linkTarget(path: string): string {
  const real = (() => { try { return realpathSync(path); } catch { return undefined; } })();
  if (real !== undefined) return real;
  let current = path;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop += 1) {
    let next: string;
    try {
      if (!lstatSync(current).isSymbolicLink()) break;
      next = resolve(dirname(current), readlinkSync(current));
    } catch {
      break;
    }
    current = next;
  }
  return join(realOrSame(dirname(current)), basename(current));
}

/** What a launcher runs: its link chain's end, replaced by the script an npm `.cmd`/`.ps1`/shell shim points at. */
function launcherTarget(path: string): string {
  const target = linkTarget(path);
  const shimTarget = readNpmShimTarget(target);
  return shimTarget === undefined ? target : realOrSame(shimTarget);
}

/** True for this repository's own CLI entry points only; other files under it (for example `node_modules/`) are not ours. */
function isRepoEntryPoint(root: string, target: string): boolean {
  return DIST_ENTRY_NAMES.some((name) => target === join(root, "dist", "cli", name)) || isInside(join(root, "src", "cli"), target);
}

/**
 * Global `orch`, `orchestrator-mcp` and `orchestrate-settings` links (symlinks, or npm `.cmd`/`.ps1`/shell shims) from earlier
 * releases that still lead to one of this repository's CLI entry points (live, or dangling after a removed build). A
 * same-named binary elsewhere (for example another package's `orch`, or anything under `node_modules/`) is never reported.
 */
export function findStaleCliLinks(options: StaleLinkOptions): StaleCliLink[] {
  const windows = options.platform === "win32";
  const root = realOrSame(resolve(options.repoRoot));
  const rawRoot = resolve(options.repoRoot);
  const found = new Map<string, StaleCliLink>();
  for (const directory of (options.pathEnv ?? "").split(windows ? win32.delimiter : posix.delimiter)) {
    if (!directory) continue;
    for (const name of LEGACY_CLI_NAMES) {
      for (const suffix of windows ? WINDOWS_LINK_SUFFIXES : SHIM_SUFFIXES) {
        const path = join(resolve(directory), name + suffix);
        if (found.has(path)) continue;
        try { lstatSync(path); } catch { continue; }
        const target = launcherTarget(path);
        if (isRepoEntryPoint(root, target) || isRepoEntryPoint(rawRoot, target)) found.set(path, { name, path, target });
      }
    }
  }
  return [...found.values()];
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
const shellQuote = (value: string): string => (SHELL_SAFE.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

const powershellQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** One removal command per link: a multi-path `rm a b` fails in PowerShell, where `rm` is `Remove-Item` and takes one path. */
function removalCommand(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `Remove-Item -LiteralPath ${powershellQuote(path)}` : `rm ${shellQuote(path)}`;
}

export function staleCliLinkWarning(links: readonly StaleCliLink[], platform: NodeJS.Platform = process.platform): string {
  const names = [...new Set(links.map((link) => link.name))].join(", ");
  const removals = links.map((link) => `\`${removalCommand(link.path, platform)}\``).join(platform === "win32" ? "; " : " and ");
  return `Stale global command links from an earlier release still point into this repository (${names}). ` +
    `Remove them with ${removals}, then re-link the current build with ` +
    `\`npm unlink -g agent-router-mcp && npm link\` so \`${CLI_NAME}\` is the only command.`;
}

export interface DoctorOptions {
  /** Overrides the PATH scanned for stale links (defaults to the install context's PATH). */
  pathEnv?: string;
  repoRoot?: string;
  /** Overrides what offline model discovery reads; by default it follows the install context (home, env, platform, cwd). */
  discovery?: Partial<DiscoveryEnvironment>;
}

/** Offline-only discovery summary; a failure here must never break `doctor`, so it simply yields no hint. */
async function discoveryHints(config: ConfigSnapshot, environment: Partial<DiscoveryEnvironment> | undefined): Promise<DiscoveryHints | undefined> {
  try {
    // Loaded on demand so that nothing but `doctor` and `models` ever pulls in model discovery.
    const { offlineDiscoveryHints } = await import("../discovery/index.js");
    return await offlineDiscoveryHints(config, environment);
  } catch {
    return undefined;
  }
}

export function discoveryHintLine(hints: DiscoveryHints): string | undefined {
  const count = hints.unconfigured_models;
  return count > 0
    ? `Discovery hint: ${count} unconfigured ${count === 1 ? "model" : "models"} detected locally — run \`${CLI_NAME} models discover\` to review.`
    : undefined;
}

export async function runDoctorCommand(args: string[], mcpContext: InstallContext = createInstallContext(), options: DoctorOptions = {}): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log(DOCTOR_USAGE);
    return;
  }
  const manager = new ConfigManager();
  const registry = new AdapterRegistry();
  const config = manager.reloadIfChanged();
  const cliLimits = await discoverAllCliLimits(config, { refresh: true });
  const harnesses = await Promise.all(Object.entries(config.harnesses).map(async ([id, harness]) => ({
    ...await registry.probeHarness(id, harness),
    concurrency: resolveHarnessConcurrency({ harnessId: id, harness, defaults: config.defaults, cliLimits: cliLimits[id] }),
    enabled_model_count: Object.values(config.models).filter((model) => model.harness === id && model.enabled).length,
  })));
  const diagnostics = [...configDiagnostics(config), ...customWrapperWarnings(harnesses, config)];
  const hints = await discoveryHints(config, {
    homeDir: mcpContext.homeDir, env: mcpContext.env as NodeJS.ProcessEnv, platform: mcpContext.platform, cwd: mcpContext.cwd,
    ...options.discovery,
  });
  const mcpClients = await inspectRelevantClients(mcpContext);
  const mcpWarnings = mcpClientWarnings(mcpClients);
  const staleLinks = findStaleCliLinks({
    pathEnv: options.pathEnv ?? mcpContext.env.PATH, repoRoot: options.repoRoot ?? defaultRepoRoot(), platform: mcpContext.platform,
  });
  const paths = { catalog_path: manager.defaultPath, user_config_path: manager.userPath, state_dir: resolve(getStateDir()) };

  if (values.json) {
    console.log(JSON.stringify({ ...paths, cold_start_fallback: config.cold_start_fallback, config_warnings: config.config_warnings, config_diagnostics: diagnostics,
      ...(hints !== undefined ? { discovery_hints: hints } : {}), harnesses, mcp_clients: mcpClients, mcp_client_warnings: mcpWarnings,
      ...(staleLinks.length > 0 ? { stale_cli_links: staleLinks } : {}) },
      (_key, value: unknown) => typeof value === "string" ? redactSecrets(value) : value, 2));
    return;
  }
  const headings = ["Harness", "Driver", "Contract", "Enabled", "Installed", "Version", "Auth", "Readonly", "Write", "Parallel/Depth", "Models"];
  // Rows keep catalog order: core harnesses first, then the newer drivers.
  const rows = harnesses.map((health) => [
    health.harness, health.driver, health.contract ?? "-", health.enabled ? "yes" : "no", health.installed ? "yes" : "no",
    health.version ?? "-", health.auth_status, health.security_guarantees.readonly, health.security_guarantees.write,
    formatParallelDepth(health.concurrency), String(health.enabled_model_count),
  ]);
  console.log(redactSecrets([
    ...(config.cold_start_fallback ? [coldStartBanner(paths.user_config_path)] : []),
    `Catalog: ${paths.catalog_path}`, `User config: ${paths.user_config_path}`, `State: ${paths.state_dir}`,
    ...config.config_warnings.map((warning) => `Warning: ${warning}`),
    ...diagnostics.map((diagnostic) => `Warning: ${diagnostic}`),
    ...(hints !== undefined && discoveryHintLine(hints) !== undefined ? [discoveryHintLine(hints) as string] : []), "", formatTable(headings, rows),
    "", "MCP client registrations",
    mcpClients.length > 0
      ? formatTable(["Client", "MCP", "Skill", "Config Path"], mcpClients.map((client) => [client.client, client.mcp_status, client.skill_status, client.config_path]))
      : "No supported CLI client detected on this machine.",
    ...mcpWarnings.map((warning) => `Warning: ${warning}`),
    ...(staleLinks.length > 0 ? [`Warning: ${staleCliLinkWarning(staleLinks, mcpContext.platform)}`] : []),
  ].join("\n")));
}
