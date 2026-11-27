import { parseArgs } from "node:util";
import { ConfigManager } from "../config/resolver.js";
import { ConfigWriter } from "../config/writer.js";
import {
  MAX_APPLY_BATCH, applyDiscovery, previewDiscovery,
  type DiscoverModelsOptions, type DiscoveryCandidate, type DiscoveryDeps, type DiscoveryEnvironment, type DiscoveryPreviewResult,
} from "../discovery/index.js";
import { createSecretRedactor, redactSecrets } from "../logging.js";
import { CLI_NAME } from "./name.js";
import { formatTable, processIo, type CliIo } from "./table.js";

const USAGE = `Usage:
  ${CLI_NAME} models discover [--harness <id>] [--offline] [--all] [--json]
  ${CLI_NAME} models discover --apply [--select <key> ...] [--all-new] [--revision <rev>] [--harness <id>] [--offline] [--json]

Without --apply nothing is written: the command lists models the installed CLIs report or have in their own config.
--offline reads local config and cache files only (no CLI is started). --all also shows models from providers the CLI
reports as not connected (a source must report that; many report nothing, so --all can change nothing).
--apply imports the models named by --select (repeatable or comma-separated), or every new model with --all-new
(at most ${MAX_APPLY_BATCH} per call). Pass the same --harness/--offline/--all flags as the preview, and --revision to
make the change fail when the config changed since the preview.`;

export interface ModelsCommandDeps {
  manager?: ConfigManager;
  environment?: Partial<DiscoveryEnvironment>;
  discovery?: DiscoveryDeps;
  io?: CliIo;
}

function formatContext(candidate: DiscoveryCandidate): string {
  const { context_window: tokens, context_precision: precision } = candidate.discovered;
  if (tokens === undefined) return "-";
  return `${precision === "rounded" ? "~" : ""}${tokens}`;
}

function idCell(candidate: DiscoveryCandidate): string {
  if (candidate.action === "import") return candidate.proposed_id;
  return candidate.existing_model_id ?? "-";
}

function renderPreview(preview: DiscoveryPreviewResult, flags: string): string {
  const lines: string[] = [];
  if (preview.candidates.length > 0) {
    lines.push(formatTable(
      ["Harness", "Provider", "Model", "Status", "Proposed ID", "Quality", "Context", "Key"],
      preview.candidates.map((candidate) => [
        candidate.harness, candidate.discovered.cli_provider ?? "-", candidate.discovered.cli_model, candidate.status,
        idCell(candidate), candidate.metadata_quality, formatContext(candidate), candidate.key,
      ]),
    ), "");
  }
  for (const harness of preview.harnesses) {
    for (const diagnostic of harness.diagnostics) {
      lines.push(`Note: ${harness.harness}: ${diagnostic.code}${diagnostic.message ? ` (${diagnostic.message})` : ""}`);
    }
  }
  const count = (status: DiscoveryCandidate["status"]) => preview.candidates.filter((candidate) => candidate.status === status).length;
  lines.push(
    `Summary: ${preview.total_candidates} model(s): ${count("new")} new, ${count("disabled_in_catalog")} disabled in catalog, ` +
    `${count("already_configured")} already configured, ${count("ambiguous")} ambiguous.` +
    (preview.truncated ? ` Showing the first ${preview.candidates.length}.` : ""),
  );
  lines.push(`Revision: ${preview.revision}`);
  if (preview.candidates.some((candidate) => candidate.action !== "none")) {
    lines.push(`Apply: ${CLI_NAME} models discover${flags} --apply --select <key>[,<key>...] --revision ${preview.revision}`,
      `   or: ${CLI_NAME} models discover${flags} --apply --all-new --revision ${preview.revision}`);
  }
  return lines.join("\n");
}

/**
 * Pretty JSON whose string VALUES are redacted one by one. Redacting the serialized text instead lets a pattern that runs to
 * the end of a line (`Authorization: ...`) swallow the closing quote and comma of a value and corrupt the document; here
 * keys, quotes, and structure are never touched.
 */
function redactedJson(value: unknown): string {
  const redact = createSecretRedactor();
  return JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? redact(item) : item, 2);
}

function selectedKeys(values: string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(",")).map((key) => key.trim()).filter(Boolean);
}

/** Returns the process exit code; failures throw so `main` prints them once. */
export async function runModelsCommand(args: string[], deps: ModelsCommandDeps = {}): Promise<number> {
  const io = deps.io ?? processIo;
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h") {
    io.out(USAGE);
    return 0;
  }
  if (command !== "discover") throw new Error(`Unknown models command ${JSON.stringify(command)}.\n${USAGE}`);

  const { values } = parseArgs({
    args: rest,
    options: {
      harness: { type: "string" }, offline: { type: "boolean" }, all: { type: "boolean" }, json: { type: "boolean" },
      apply: { type: "boolean" }, select: { type: "string", multiple: true }, "all-new": { type: "boolean" },
      revision: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const keys = selectedKeys(values.select);
  if (!values.apply && (keys.length > 0 || values["all-new"] || values.revision !== undefined)) {
    throw new Error("--select, --all-new and --revision only work together with --apply.");
  }
  if (values.apply && keys.length === 0 && !values["all-new"]) {
    throw new Error("--apply needs --select <key> or --all-new. Run without --apply first to see the keys.");
  }

  const options: DiscoverModelsOptions = {
    // Omitted means every enabled harness; a given value is that exact harness ID (even one literally named "all").
    ...(values.harness !== undefined ? { harness: values.harness } : {}),
    mode: values.offline ? "offline" : "on_demand",
    providers: values.all ? "all" : "configured",
    ...deps.environment,
  };
  const manager = deps.manager ?? new ConfigManager();
  const discoveryDeps = deps.discovery ?? {};
  // The flags the preview used, repeated in the apply hint so both commands see the same candidates.
  const flags = `${values.harness !== undefined ? ` --harness ${values.harness}` : ""}${values.offline ? " --offline" : ""}${values.all ? " --all" : ""}`;

  if (values.apply) {
    const result = await applyDiscovery(manager, new ConfigWriter(manager), options,
      { select: keys, allNew: values["all-new"] === true, revision: values.revision }, discoveryDeps);
    if (values.json) {
      io.out(redactedJson({
        revision: result.snapshot.revision, imported: result.imported, enabled: result.enabled, skipped: result.skipped,
        remaining_new: result.remaining_new, more_may_exist: result.more_may_exist,
      }));
      return 0;
    }
    io.out(redactSecrets([
      `Imported ${result.imported.length}: ${result.imported.join(", ") || "none"}`,
      `Enabled ${result.enabled.length}: ${result.enabled.join(", ") || "none"}`,
      ...(result.skipped.length > 0 ? [`Skipped (ID already exists): ${result.skipped.join(", ")}`] : []),
      ...(result.remaining_new > 0 || result.more_may_exist
        ? [`More new models remain (${result.remaining_new}${result.more_may_exist ? "+" : ""}). Next batch: ` +
          `${CLI_NAME} models discover${flags} --apply --all-new --revision ${result.snapshot.revision}`]
        : []),
      `Revision: ${result.snapshot.revision}`,
    ].join("\n")));
    return 0;
  }

  const preview = await previewDiscovery(manager.reloadIfChanged(), options, discoveryDeps);
  io.out(values.json ? redactedJson(preview) : redactSecrets(renderPreview(preview, flags)));
  return 0;
}
