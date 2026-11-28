import { existsSync } from "node:fs";
import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, TomlError } from "smol-toml";
import { isMap, isSeq, LineCounter, parseDocument, type Document, type YAMLError, type YAMLMap, type YAMLSeq } from "yaml";
import { redactSecrets } from "../logging.js";
import { atomicWriteFile, readTextIfExists } from "./atomic-file.js";
import { getNodeAt, isPlainObject, nodeToValue, parseJsonc, removeValueAt, setValueAt, type JsonValue } from "./jsonc-edit.js";
import {
  CLIENTS, CLIENT_IDS, DSH_ENTRY_ID, DSH_MCP_PLUGIN, PRIMARY_INSTANCE, SERVER_NAME, assertInstanceConfigWritable, assertInstanceSkillWritable,
  canonicalArgv, classifyEntry, detectClient, expandClientTargets, isClientId,
  toTarget,
  type ClassifyOptions, type ClientId, type ClientLayout, type ClientSpec, type ClientTarget, type ConfigFormat, type EntryView, type InstallContext, type McpStatus,
} from "./mcp-clients.js";
import { CLI_NAME } from "./name.js";
import { inspectSkill, installSkillDir, type SkillAction, type SkillStatus } from "./skill-install.js";
import {
  appendBlock, blockRange, editTableKeys, removeBlock, removeDetachedSubtables, samePath, scanToml, tomlString, tomlStringArray, type TomlKeyEdit,
} from "./toml-edit.js";

export * from "./mcp-clients.js";
export type { SkillAction, SkillStatus } from "./skill-install.js";

export type InstallAction = "created" | "updated" | "unchanged" | "skipped" | "removed" | "error";
type EditMode = "add" | "merge" | "replace";

// ---------------------------------------------------------------------------
// Format adapters: inspect an entry, write the canonical entry, remove it
// ---------------------------------------------------------------------------

type Inspection = { kind: "invalid"; detail: string } | { kind: "ok"; view?: EntryView };

interface Adapter {
  inspect(text: string | undefined): Inspection;
  install(text: string | undefined, mode: EditMode): string;
  remove(text: string): string;
  /** The parsed document without the orchestrator entry (and ancestors that entry leaves empty); used to prove an edit touched nothing else. */
  withoutEntry(text: string | undefined): unknown;
}

/** Every user-visible detail passes through the redactor: a config file may hold other servers' credentials. */
const invalid = (detail: string): Inspection => ({ kind: "invalid", detail: redactSecrets(detail) });
const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0];

/** A parse error reduced to its short summary plus position; parser messages append raw source lines, which can hold secrets. */
function tomlErrorSummary(error: unknown): string {
  if (error instanceof TomlError) return `${firstLine(error.message)} at line ${error.line}, column ${error.column}`;
  return firstLine(error instanceof Error ? error.message : String(error));
}

function yamlErrorSummary(error: YAMLError, lineCounter: LineCounter): string {
  const [offset] = error.pos;
  const { line, col } = lineCounter.linePos(offset);
  return `${firstLine(error.message)} at line ${line}, column ${col}`;
}

/** Parses YAML without `prettyErrors`, which would append raw source lines to every error message. */
function parseYamlDocument(text: string): { doc: Document.Parsed; lineCounter: LineCounter } {
  const lineCounter = new LineCounter();
  return { doc: parseDocument(text, { prettyErrors: false, lineCounter }), lineCounter };
}

/** A copy of `value` without the member at `path`; ancestors that end up empty are dropped too, so "entry added to an empty parent" compares equal. */
function omitPath(value: unknown, path: readonly string[]): unknown {
  if (path.length === 0 || !isPlainObject(value)) return value;
  const [head, ...rest] = path;
  if (!Object.hasOwn(value, head)) return value;
  const copy: Record<string, unknown> = { ...value };
  const child = rest.length === 0 ? undefined : omitPath(copy[head], rest);
  if (rest.length === 0 || (isPlainObject(child) && Object.keys(child).length === 0)) delete copy[head];
  else copy[head] = child;
  return copy;
}
const isBlank = (text: string | undefined): text is undefined | "" => text === undefined || text.trim() === "";

class UnsupportedFormError extends Error {}

/** Reduces a parsed server record (JSON object, TOML table, YAML mapping) to what ownership checks need. */
function viewFromRecord(value: unknown): EntryView {
  if (!isPlainObject(value)) return { argv: [], disabled: false, conflict: "the entry is not an object" };
  const { command, args } = value;
  const strings = (list: unknown): string[] => Array.isArray(list) ? list.map(String) : [];
  const argv = Array.isArray(command) ? [...strings(command), ...strings(args)]
    : typeof command === "string" ? [command, ...strings(args)] : [];
  return { argv, disabled: value.enabled === false || value.disabled === true };
}

type JsonObject = { [key: string]: JsonValue };

/** Keys of an existing entry that the canonical entry makes obsolete: a disable flag, `enabled: false`, and `args` when the command is one array. */
function obsoleteKeys(existing: JsonObject, entry: JsonObject): string[] {
  return [
    ...("disabled" in existing ? ["disabled"] : []),
    ...(!("enabled" in entry) && existing.enabled === false ? ["enabled"] : []),
    ...(!("args" in entry) && "args" in existing ? ["args"] : []),
  ];
}

/**
 * Brings an existing entry in line with `entry` one property at a time, so comments and formatting next to untouched
 * siblings survive. Unknown user keys stay, `preserved` keys keep their existing value, and equal values are not rewritten.
 */
function mergeEntryKeys(text: string, path: readonly string[], existing: JsonObject, entry: JsonObject, preserved: readonly string[]): string {
  let result = text;
  for (const [key, value] of Object.entries(entry)) {
    if (key in existing && (preserved.includes(key) || JSON.stringify(existing[key]) === JSON.stringify(value))) continue;
    result = setValueAt(result, parseJsonc(result), [...path, key], value);
  }
  for (const key of obsoleteKeys(existing, entry)) result = removeValueAt(result, parseJsonc(result), [...path, key]);
  return result;
}

function jsonAdapter(spec: ClientSpec, ctx: InstallContext): Adapter {
  const entryPathOf = (root: JsonValue | undefined) => spec.jsonEntryPath!(root);
  const canonical = (path: string[]) => spec.jsonEntry!(canonicalArgv(ctx), path);
  const nest = (path: readonly string[], value: JsonValue): JsonValue => path.reduceRight<JsonValue>((inner, key) => ({ [key]: inner }), value);
  return {
    inspect(text) {
      if (isBlank(text)) return { kind: "ok" };
      try {
        const root = parseJsonc(text);
        if (root.kind !== "object") return invalid("the top-level JSON value is not an object");
        const path = entryPathOf(nodeToValue(root));
        for (let depth = 1; depth < path.length; depth += 1) {
          const ancestor = getNodeAt(root, path.slice(0, depth));
          if (ancestor && ancestor.kind !== "object") return invalid(`"${path.slice(0, depth).join(".")}" is not an object`);
        }
        const node = getNodeAt(root, path);
        return node ? { kind: "ok", view: viewFromRecord(nodeToValue(node)) } : { kind: "ok" };
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
      }
    },
    install(text, mode) {
      if (isBlank(text)) return `${JSON.stringify(nest(entryPathOf(undefined), canonical(entryPathOf(undefined))), null, 2)}\n`;
      const root = parseJsonc(text);
      const path = entryPathOf(nodeToValue(root));
      const entry = canonical(path);
      const existing = getNodeAt(root, path);
      if (mode === "merge" && existing?.kind === "object" && isPlainObject(entry)) {
        return mergeEntryKeys(text, path, nodeToValue(existing) as JsonObject, entry, spec.preserveOnMerge ?? []);
      }
      return setValueAt(text, root, path, entry);
    },
    remove(text) {
      const root = parseJsonc(text);
      return removeValueAt(text, root, entryPathOf(nodeToValue(root)));
    },
    withoutEntry(text) {
      if (isBlank(text)) return {};
      const value = nodeToValue(parseJsonc(text));
      return omitPath(value, entryPathOf(value));
    },
  };
}

function parseTomlSafe(text: string): { value: Record<string, unknown> } | { error: string } {
  try {
    return { value: parseToml(text) as Record<string, unknown> };
  } catch (error) {
    return { error: tomlErrorSummary(error) };
  }
}

const TABLE_PATH = ["mcp_servers", SERVER_NAME];
const ARRAY_PATH = ["mcp_servers"];

function canonicalTomlLines(ctx: InstallContext): string[] {
  const [node, ...args] = canonicalArgv(ctx);
  return [`command = ${tomlString(node)}`, `args = ${tomlStringArray(args)}`];
}

/** Keys of an existing owned table that must go when the entry is re-enabled. */
function reenableEdits(existing: unknown): TomlKeyEdit[] {
  const record = isPlainObject(existing) ? existing : {};
  return [
    ...(record.enabled === false ? [{ key: "enabled", remove: true } as const] : []),
    ...(record.disabled === true ? [{ key: "disabled", remove: true } as const] : []),
  ];
}

function replaceBlock(text: string, headerIndex: number, block: string): string {
  const scan = scanToml(text);
  const { start, end } = blockRange(scan, scan.headers[headerIndex]);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const body = block.replace(/\n/g, eol) + eol;
  return text.slice(0, start) + body + text.slice(end);
}

function tomlTableAdapter(ctx: InstallContext): Adapter {
  const block = () => [`[mcp_servers.${SERVER_NAME}]`, ...canonicalTomlLines(ctx)].join("\n");
  const headerIndex = (text: string) => scanToml(text).headers.findIndex((header) => !header.isArray && samePath(header.path, TABLE_PATH));
  const existingOf = (text: string): unknown => ((parseToml(text) as Record<string, unknown>).mcp_servers as Record<string, unknown> | undefined)?.[SERVER_NAME];
  return {
    inspect(text) {
      if (isBlank(text)) return { kind: "ok" };
      const parsed = parseTomlSafe(text);
      if ("error" in parsed) return invalid(parsed.error);
      const servers = parsed.value.mcp_servers;
      if (servers !== undefined && !isPlainObject(servers)) return invalid('"mcp_servers" is not a table');
      const entry = (servers as Record<string, unknown> | undefined)?.[SERVER_NAME];
      return entry === undefined ? { kind: "ok" } : { kind: "ok", view: viewFromRecord(entry) };
    },
    install(text, mode) {
      const source = text ?? "";
      const index = headerIndex(source);
      if (index === -1) {
        if (existingOf(source) !== undefined) throw new UnsupportedFormError('the existing "orchestrator" entry uses inline-table or dotted-key TOML; edit it manually');
        return appendBlock(source, block());
      }
      if (mode === "replace") {
        // Sub-tables written elsewhere in the file (`[mcp_servers.orchestrator.env]`) belong to the replaced entry, not to ours.
        const cleaned = removeDetachedSubtables(source, index);
        return replaceBlock(cleaned, headerIndex(cleaned), block());
      }
      const [node, ...args] = canonicalArgv(ctx);
      return editTableKeys(source, index, [
        { key: "command", raw: tomlString(node) }, { key: "args", raw: tomlStringArray(args) }, ...reenableEdits(existingOf(source)),
      ]);
    },
    remove(text) {
      const index = headerIndex(text);
      if (index === -1) throw new UnsupportedFormError('the existing "orchestrator" entry uses inline-table or dotted-key TOML; remove it manually');
      const cleaned = removeDetachedSubtables(text, index);
      return removeBlock(cleaned, headerIndex(cleaned));
    },
    withoutEntry: (text) => (isBlank(text) ? {} : omitPath(parseToml(text), TABLE_PATH)),
  };
}

function tomlArrayAdapter(ctx: InstallContext): Adapter {
  const block = () => ["[[mcp_servers]]", `name = ${tomlString(SERVER_NAME)}`, 'transport = "stdio"', ...canonicalTomlLines(ctx)].join("\n");
  const elementsOf = (text: string): Record<string, unknown>[] => {
    const servers = (parseToml(text) as Record<string, unknown>).mcp_servers;
    return Array.isArray(servers) ? servers as Record<string, unknown>[] : [];
  };
  /** Global header indexes of the `[[mcp_servers]]` elements named orchestrator; throws when headers and parsed data disagree. */
  const matchingHeaders = (text: string): number[] => {
    const elements = elementsOf(text);
    const arrayHeaders = scanToml(text).headers.flatMap((header, index) => header.isArray && samePath(header.path, ARRAY_PATH) ? [index] : []);
    if (arrayHeaders.length !== elements.length) throw new UnsupportedFormError("mcp_servers is declared as an inline array; edit it manually");
    return arrayHeaders.filter((_, position) => elements[position].name === SERVER_NAME);
  };
  /** Removes an element with its sub-tables, including ones an unrelated table separates from it (they would otherwise re-attach to the previous element). */
  const removeElement = (text: string, headerIndex: number): string => removeBlock(removeDetachedSubtables(text, headerIndex), headerIndex);
  return {
    inspect(text) {
      if (isBlank(text)) return { kind: "ok" };
      const parsed = parseTomlSafe(text);
      if ("error" in parsed) return invalid(parsed.error);
      const servers = parsed.value.mcp_servers;
      if (servers !== undefined && !Array.isArray(servers)) return invalid('"mcp_servers" is not an array of tables ([[mcp_servers]])');
      const matches = (Array.isArray(servers) ? servers : []).filter((item) => isPlainObject(item) && item.name === SERVER_NAME);
      if (matches.length === 0) return { kind: "ok" };
      const view = viewFromRecord(matches[0]);
      return { kind: "ok", view: matches.length > 1 ? { ...view, conflict: "several [[mcp_servers]] entries are named orchestrator" } : view };
    },
    install(text, mode) {
      const source = text ?? "";
      const matches = source ? matchingHeaders(source) : [];
      if (matches.length === 0) return appendBlock(source, block());
      let result = source;
      for (const extra of matches.slice(1).reverse()) result = removeElement(result, extra);
      if (mode === "replace") return replaceBlock(removeDetachedSubtables(result, matches[0]), matches[0], block());
      const elementIndex = elementsOf(source).findIndex((item) => item.name === SERVER_NAME);
      const [node, ...args] = canonicalArgv(ctx);
      return editTableKeys(result, matches[0], [
        { key: "transport", raw: '"stdio"' }, { key: "command", raw: tomlString(node) }, { key: "args", raw: tomlStringArray(args) },
        ...reenableEdits(elementsOf(source)[elementIndex]),
      ]);
    },
    remove(text) {
      let result = text;
      for (const index of matchingHeaders(text).reverse()) result = removeElement(result, index);
      return result;
    },
    withoutEntry(text) {
      if (isBlank(text)) return {};
      const root = parseToml(text) as Record<string, unknown>;
      if (!Array.isArray(root.mcp_servers)) return root;
      const others = root.mcp_servers.filter((item) => !(isPlainObject(item) && item.name === SERVER_NAME));
      const { mcp_servers: _servers, ...rest } = root;
      return others.length > 0 ? { ...rest, mcp_servers: others } : rest;
    },
  };
}

/** `yaml` types `get(key, true)` as a Scalar; in practice it returns the child node, so narrow it ourselves. */
const childNode = (map: YAMLMap, key: string): unknown => map.get(key, true);

/** An orchestrator entry found in an `insert` operation, read with YAML aliases resolved. */
interface YamlMatch {
  rootIndex: number;
  index: number;
  plain: Record<string, unknown>;
  /** The editable nodes; undefined when the operation or the entry is reachable only through an alias. */
  nodes?: { seq: YAMLSeq; item: YAMLMap };
}

type EditableYamlMatch = YamlMatch & { nodes: NonNullable<YamlMatch["nodes"]> };

const ALIAS_EDIT_REFUSAL = "the orchestrator entry is defined through a YAML alias; edit it manually";

function plainPatches(doc: Document.Parsed | Document): unknown[] {
  const plain: unknown = doc.toJS();
  return Array.isArray(plain) ? plain : [];
}

function isOrchestratorItem(item: Record<string, unknown>): boolean {
  const { config } = item;
  return item.id === DSH_ENTRY_ID || (isPlainObject(config) && config.serverName === SERVER_NAME);
}

function editableNodes(root: unknown, rootIndex: number, index: number): YamlMatch["nodes"] {
  const patch = isSeq(root) ? root.items[rootIndex] : undefined;
  const insert = isMap(patch) ? childNode(patch, "insert") : undefined;
  const item = isSeq(insert) ? insert.items[index] : undefined;
  return isSeq(insert) && isMap(item) ? { seq: insert, item } : undefined;
}

function yamlMatches(doc: Document.Parsed | Document): YamlMatch[] {
  const matches: YamlMatch[] = [];
  plainPatches(doc).forEach((patch, rootIndex) => {
    const insert = isPlainObject(patch) ? patch.insert : undefined;
    if (!Array.isArray(insert)) return;
    insert.forEach((item, index) => {
      if (isPlainObject(item) && isOrchestratorItem(item)) matches.push({ rootIndex, index, plain: item, nodes: editableNodes(doc.contents, rootIndex, index) });
    });
  });
  return matches;
}

function requireEditable(matches: readonly YamlMatch[]): EditableYamlMatch[] {
  if (matches.some((match) => !match.nodes)) throw new UnsupportedFormError(ALIAS_EDIT_REFUSAL);
  return matches as EditableYamlMatch[];
}

/** Top-level patch items that only switch the entry off (`{ id: mcp-orchestrator, disabled: true }`). */
function disableOverrideIndexes(doc: Document.Parsed | Document): number[] {
  return plainPatches(doc).flatMap((patch, rootIndex) =>
    isPlainObject(patch) && !("insert" in patch) && patch.id === DSH_ENTRY_ID && patch.disabled === true ? [rootIndex] : []);
}

/** Removes the disable overrides that come after patch operation `afterRootIndex`; an override that only held `id` and `disabled` goes entirely. */
function clearDisableOverrides(doc: Document.Parsed | Document, afterRootIndex: number): void {
  const root = doc.contents;
  for (const rootIndex of disableOverrideIndexes(doc).filter((index) => index > afterRootIndex).reverse()) {
    const patch = isSeq(root) ? root.items[rootIndex] : undefined;
    if (!isSeq(root) || !isMap(patch)) throw new UnsupportedFormError(ALIAS_EDIT_REFUSAL);
    patch.delete("disabled");
    if (patch.items.length === 1 && patch.has("id")) root.items.splice(rootIndex, 1);
  }
}

function dshItem(ctx: InstallContext): JsonValue {
  const [node, ...args] = canonicalArgv(ctx);
  return { id: DSH_ENTRY_ID, name: DSH_MCP_PLUGIN, config: { serverName: SERVER_NAME, transport: "stdio", command: node, args } };
}

/** The `insert` list of a patch operation that has no selector keys (profile, group, ...), so an added plugin applies everywhere. */
function unscopedInsert(patch: unknown): YAMLSeq | undefined {
  if (!isMap(patch) || patch.items.length !== 1) return undefined;
  const insert = childNode(patch, "insert");
  return isSeq(insert) ? insert : undefined;
}

/** Patch operations without the orchestrator entry, its disable overrides, and the operations that leave empty. */
function yamlWithoutEntry(doc: Document.Parsed | Document): unknown[] {
  return plainPatches(doc).flatMap((patch): unknown[] => {
    if (!isPlainObject(patch)) return [patch];
    if (Array.isArray(patch.insert)) {
      const insert = patch.insert.filter((item) => !(isPlainObject(item) && isOrchestratorItem(item)));
      if (insert.length === patch.insert.length) return [patch];
      return insert.length === 0 && Object.keys(patch).length === 1 ? [] : [{ ...patch, insert }];
    }
    if (patch.id === DSH_ENTRY_ID && patch.disabled === true) {
      const { disabled: _disabled, ...rest } = patch;
      return Object.keys(rest).length === 1 ? [] : [rest];
    }
    return [patch];
  });
}

function yamlAdapter(ctx: InstallContext): Adapter {
  const toNode = (doc: Document, item: JsonValue): YAMLMap => {
    const node = doc.createNode(item) as YAMLMap;
    const args: unknown = node.getIn(["config", "args"], true);
    if (isSeq(args)) args.flow = true;
    return node;
  };
  const serialize = (doc: Document) => doc.toString({ lineWidth: 0 });
  const addEntry = (doc: Document, item: JsonValue): void => {
    const root = doc.contents;
    const target = isSeq(root) ? root.items.map(unscopedInsert).find((insert) => insert !== undefined) : undefined;
    if (target) {
      target.add(toNode(doc, item));
      return;
    }
    const patch = doc.createNode({ insert: [] }) as YAMLMap;
    (childNode(patch, "insert") as YAMLSeq).add(toNode(doc, item));
    if (isSeq(root)) {
      root.add(patch);
    } else {
      const sequence = doc.createNode([]) as YAMLSeq;
      sequence.add(patch);
      doc.contents = sequence;
    }
  };
  return {
    inspect(text) {
      if (isBlank(text)) return { kind: "ok" };
      const { doc, lineCounter } = parseYamlDocument(text);
      if (doc.errors.length > 0) return invalid(yamlErrorSummary(doc.errors[0], lineCounter));
      if (doc.contents !== null && !isSeq(doc.contents)) return invalid("the top-level YAML value is not a sequence of patch operations");
      try {
        const matches = yamlMatches(doc);
        if (matches.length === 0) return { kind: "ok" };
        const [first] = matches;
        const view = viewFromRecord(first.plain.config);
        const disabledByOverride = disableOverrideIndexes(doc).some((index) => index > first.rootIndex);
        const conflict = matches.length > 1 ? "several plugin entries match orchestrator"
          : first.plain.name !== DSH_MCP_PLUGIN ? `the entry is not a ${DSH_MCP_PLUGIN} plugin` : undefined;
        return { kind: "ok", view: { ...view, disabled: view.disabled || first.plain.disabled === true || disabledByOverride, ...(conflict ? { conflict } : {}) } };
      } catch (error) {
        return invalid(error instanceof Error ? error.message : String(error));
      }
    },
    install(text, mode) {
      const doc = parseDocument(text ?? "", { prettyErrors: false }) as unknown as Document;
      const item = dshItem(ctx);
      const matches = yamlMatches(doc);
      if (matches.length === 0) {
        addEntry(doc, item);
        return serialize(doc);
      }
      const [first, ...extra] = requireEditable(matches);
      for (const duplicate of extra.reverse()) duplicate.nodes.seq.items.splice(duplicate.index, 1);
      const { seq, item: existing } = first.nodes;
      clearDisableOverrides(doc, first.rootIndex);
      if (mode === "replace") {
        seq.items[first.index] = toNode(doc, item);
        return serialize(doc);
      }
      const fresh = toNode(doc, item);
      existing.set("id", DSH_ENTRY_ID);
      existing.set("name", DSH_MCP_PLUGIN);
      existing.delete("disabled");
      const config = childNode(existing, "config");
      const freshConfig = childNode(fresh, "config") as YAMLMap;
      if (!isMap(config)) {
        existing.set("config", freshConfig);
        return serialize(doc);
      }
      for (const key of ["serverName", "transport", "command", "args"]) config.set(key, childNode(freshConfig, key));
      config.delete("disabled");
      return serialize(doc);
    },
    remove(text) {
      const doc = parseDocument(text, { prettyErrors: false }) as unknown as Document;
      const root = doc.contents;
      for (const match of requireEditable(yamlMatches(doc)).reverse()) {
        match.nodes.seq.items.splice(match.index, 1);
        const patch = isSeq(root) ? root.items[match.rootIndex] : undefined;
        if (isSeq(root) && isMap(patch) && match.nodes.seq.items.length === 0 && patch.items.length === 1) root.items.splice(match.rootIndex, 1);
      }
      return serialize(doc);
    },
    withoutEntry: (text) => (isBlank(text) ? [] : yamlWithoutEntry(parseDocument(text, { prettyErrors: false }))),
  };
}

function createAdapter(spec: ClientSpec, ctx: InstallContext): Adapter {
  switch (spec.format) {
    case "json": return jsonAdapter(spec, ctx);
    case "toml-table": return tomlTableAdapter(ctx);
    case "toml-array": return tomlArrayAdapter(ctx);
    case "yaml": return yamlAdapter(ctx);
  }
}

// ---------------------------------------------------------------------------
// Inspection, install, uninstall
// ---------------------------------------------------------------------------

export interface McpInspection {
  target: ClientTarget;
  spec: ClientSpec;
  layout: ClientLayout;
  adapter: Adapter;
  text: string | undefined;
  status: McpStatus;
  detail?: string;
}

const MAX_LAUNCHER_NAME_LENGTH = 64;

/** The launcher's file name only: a `command` written as one shell string must not leak the arguments glued to it. */
function launcherBasename(command: string): string {
  // Split off the first word BEFORE taking the basename: a URL argument (`https://host/sse?token=...`) holds slashes of its own.
  const launcher = command.trim().split(/\s+/, 1)[0];
  const name = posix.basename(launcher.replace(/\\/g, "/")).slice(0, MAX_LAUNCHER_NAME_LENGTH);
  return redactSecrets(name) || "(unnamed)";
}

/** Names the foreign command by launcher and argument count only; argument values (`--api-key`, `?token=`) are never printed. */
function describeEntry(view: EntryView): string {
  if (view.conflict) return redactSecrets(view.conflict);
  const [launcher, ...args] = view.argv;
  if (launcher === undefined) return "existing entry has no command";
  return `existing entry runs "${launcherBasename(launcher)}"${args.length > 0 ? ` (+${args.length} ${args.length === 1 ? "arg" : "args"})` : ""}`;
}

function evaluate(adapter: Adapter, text: string | undefined, ctx: InstallContext, options: ClassifyOptions = {}): { status: McpStatus; detail?: string } {
  const inspection = adapter.inspect(text);
  if (inspection.kind === "invalid") return { status: "invalid", detail: inspection.detail };
  const status = classifyEntry(inspection.view, ctx, options);
  return { status, detail: inspection.view && status !== "current" ? describeEntry(inspection.view) : undefined };
}

export async function inspectMcp(input: ClientSpec | ClientTarget, ctx: InstallContext): Promise<McpInspection> {
  const target = toTarget(input, ctx);
  const { spec, layout } = target;
  const adapter = createAdapter(spec, ctx);
  let text: string | undefined;
  try {
    text = await readTextIfExists(layout.configPath);
  } catch (error) {
    return { target, spec, layout, adapter, text: undefined, status: "invalid", detail: redactSecrets(`cannot read ${layout.configPath}: ${error instanceof Error ? error.message : String(error)}`) };
  }
  return { target, spec, layout, adapter, text, ...evaluate(adapter, text, ctx) };
}

export interface McpTargetResult {
  client: ClientId;
  /** Instance of the client (for example `t3:1a2b3c4d5e6f`); absent for the primary location. */
  instance?: string;
  label: string;
  format: ConfigFormat;
  config_path: string;
  skill_path: string;
  detected: boolean;
  detected_by: string[];
  /** Registration state found before the operation. */
  status: McpStatus;
  /** State after the operation (predicted under `--dry-run`). */
  status_after: McpStatus;
  action: InstallAction;
  message?: string;
  backup_path?: string;
  file_created?: boolean;
}

export interface MutationOptions {
  dryRun: boolean;
  force: boolean;
}

async function baseResult(inspection: McpInspection, ctx: InstallContext): Promise<McpTargetResult> {
  const detection = await detectClient(inspection.target, ctx);
  const { spec, layout, target } = inspection;
  return {
    client: spec.id, ...(target.instance !== undefined ? { instance: target.instance } : {}), label: spec.label, format: spec.format, config_path: layout.configPath,
    skill_path: layout.skillDir, detected: detection.detected, detected_by: detection.reasons,
    status: inspection.status, status_after: inspection.status, action: "unchanged",
  };
}

const errorMessage = (error: unknown): string => redactSecrets(error instanceof Error ? error.message : String(error));

const UNRELATED_CHANGE_REFUSAL = "refusing to write: the edit would change content outside the \"orchestrator\" entry, so the config was left untouched.";

/** Rebuilds parsed data from ordinary objects and arrays, so parser-specific prototypes (smol-toml uses null-prototype tables) never decide equality. */
function plainData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainData);
  if (typeof value !== "object" || value === null || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, plainData(member)]));
}

/** True when the edit changed anything besides the orchestrator entry (compared as parsed data, so formatting is free to change). */
function changesUnrelatedContent(adapter: Adapter, before: string | undefined, after: string): boolean {
  try {
    return !isDeepStrictEqual(plainData(adapter.withoutEntry(before)), plainData(adapter.withoutEntry(after)));
  } catch {
    return true;
  }
}

/** Messages may quote config details; nothing leaves this module unredacted. */
function redactResult<T extends { message?: string }>(result: T): T {
  return result.message === undefined ? result : { ...result, message: redactSecrets(result.message) };
}
/** Validates `next`, then (unless dry-run) writes it atomically with a backup of the previous file. */
async function commit(
  inspection: McpInspection, next: string, expected: McpStatus, options: MutationOptions, ctx: InstallContext, result: McpTargetResult,
): Promise<McpTargetResult> {
  const check = evaluate(inspection.adapter, next, ctx, { assumeEntryExists: options.dryRun });
  if (check.status !== expected) {
    return { ...result, action: "error", message: redactSecrets(`refusing to write: the edited config would be ${check.status}${check.detail ? ` (${check.detail})` : ""}`) };
  }
  if (changesUnrelatedContent(inspection.adapter, inspection.text, next)) return { ...result, action: "error", message: UNRELATED_CHANGE_REFUSAL };
  try {
    assertInstanceConfigWritable(inspection.target, ctx);
  } catch (error) {
    return { ...result, action: "error", message: errorMessage(error) };
  }
  result.status_after = expected;
  result.file_created = inspection.text === undefined;
  if (options.dryRun) return result;
  try {
    const written = await atomicWriteFile(inspection.layout.configPath, next, { backup: inspection.text !== undefined, now: ctx.now, expectedText: inspection.text ?? null });
    result.backup_path = written.backupPath;
  } catch (error) {
    return { ...result, action: "error", status_after: result.status, message: errorMessage(error) };
  }
  const after = await inspectMcp(inspection.target, ctx);
  result.status_after = after.status;
  if (after.status !== expected) return { ...result, action: "error", message: `verification failed: the config reads back as ${after.status}` };
  return result;
}

export async function installMcpClient(target: ClientSpec | ClientTarget, ctx: InstallContext, options: MutationOptions): Promise<McpTargetResult> {
  return redactResult(await installEntry(target, ctx, options));
}

async function installEntry(target: ClientSpec | ClientTarget, ctx: InstallContext, options: MutationOptions): Promise<McpTargetResult> {
  const inspection = await inspectMcp(target, ctx);
  const result = await baseResult(inspection, ctx);
  const { status } = inspection;
  if (status === "current") return result;
  if (status === "invalid") return { ...result, action: "skipped", message: `config is unreadable or malformed, left untouched: ${inspection.detail}` };
  if ((status === "conflict" || status === "disabled") && !options.force) {
    const what = status === "conflict" ? "a different server already uses the name \"orchestrator\"" : "the orchestrator entry is disabled";
    return { ...result, action: "skipped", message: `${what}; left untouched (re-run with --force to overwrite). ${inspection.detail ?? ""}`.trim() };
  }
  if (!options.dryRun && !existsSync(ctx.entryPath)) {
    return { ...result, action: "error", message: `${ctx.entryPath} does not exist; run \`npm run build\` first.` };
  }
  const mode: EditMode = status === "missing" ? "add" : status === "conflict" ? "replace" : "merge";
  let next: string;
  try {
    next = inspection.adapter.install(inspection.text, mode);
  } catch (error) {
    return { ...result, action: "error", message: errorMessage(error) };
  }
  const committed = await commit(inspection, next, "current", options, ctx, { ...result, action: status === "missing" ? "created" : "updated" });
  if (committed.action === "error") return committed;
  return { ...committed, message: inspection.detail };
}

export async function uninstallMcpClient(target: ClientSpec | ClientTarget, ctx: InstallContext, options: MutationOptions): Promise<McpTargetResult> {
  return redactResult(await uninstallEntry(target, ctx, options));
}

async function uninstallEntry(target: ClientSpec | ClientTarget, ctx: InstallContext, options: MutationOptions): Promise<McpTargetResult> {
  const inspection = await inspectMcp(target, ctx);
  const result = await baseResult(inspection, ctx);
  const { status } = inspection;
  if (status === "missing") return { ...result, message: "no orchestrator entry to remove" };
  if (status === "invalid") return { ...result, action: "skipped", message: `config is unreadable or malformed, left untouched: ${inspection.detail}` };
  if (status === "conflict" && !options.force) {
    return { ...result, action: "skipped", message: `the "orchestrator" entry does not look like agent-router-mcp; left untouched (re-run with --force to remove it). ${inspection.detail ?? ""}`.trim() };
  }
  let next: string;
  try {
    next = inspection.adapter.remove(inspection.text ?? "");
  } catch (error) {
    return { ...result, action: "error", message: errorMessage(error) };
  }
  const committed = await commit(inspection, next, "missing", options, ctx, { ...result, action: "removed" });
  return committed;
}

// ---------------------------------------------------------------------------
// Targets, status, setup
// ---------------------------------------------------------------------------

export interface ResolvedTargets {
  /** The primary clients selected (instances are only in `targets`). */
  specs: ClientSpec[];
  /** Every selected location: primaries and instances such as `antigravity:t3:<short>`. */
  targets: ClientTarget[];
  /** True when `all` was requested (only detected clients are returned). */
  auto: boolean;
}

export function parseTargetList(values: readonly string[] | undefined): string[] {
  const list = (values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim());
  if (list.some((value) => value === "")) throw new Error("--target must not be empty.");
  return list.length > 0 ? list : ["all"];
}

export function targetUsage(): string {
  return `${CLIENT_IDS.join("|")}|all`;
}

export interface ResolveTargetsOptions {
  /** Clients that `all` includes even when they are not detected (the skill installer adds the core CLIs this way). */
  alwaysInclude?: (spec: ClientSpec) => boolean;
}

/** `antigravity:t3:1a2b3c4d5e6f` -> client id and instance; a plain id has no instance. */
function splitTarget(value: string): { id: string; instance?: string } {
  const colon = value.indexOf(":");
  return colon === -1 ? { id: value } : { id: value.slice(0, colon), instance: value.slice(colon + 1) };
}

const isKnownTarget = (value: string): boolean => {
  const { id, instance } = splitTarget(value);
  return isClientId(id) && (instance === undefined || (instance !== "" && CLIENTS[id].instances !== undefined));
};

/**
 * `all` selects the clients detected on this machine plus every instance; explicit ids are always honored (a client with
 * instances brings them along); `<client>:<instance>` selects exactly that instance and must exist; `<client>:primary`
 * selects the primary location only, so `--force` on it can never touch an instance.
 */
export async function resolveTargets(ctx: InstallContext, requested: readonly string[], options: ResolveTargetsOptions = {}): Promise<ResolvedTargets> {
  const unknown = requested.filter((value) => value !== "all" && !isKnownTarget(value));
  if (unknown.length > 0) throw new Error(`Unknown target ${unknown.map((value) => JSON.stringify(value)).join(", ")}. Valid targets: ${targetUsage()}.`);
  const auto = requested.includes("all");
  const targets: ClientTarget[] = [];
  const add = (target: ClientTarget): void => {
    if (!targets.some((existing) => existing.targetId === target.targetId)) targets.push(target);
  };
  if (auto) {
    const expanded = await Promise.all(CLIENT_IDS.map(async (id) => {
      const [primary, ...instances] = await expandClientTargets(CLIENTS[id], ctx);
      const wanted = options.alwaysInclude?.(primary.spec) === true || (await detectClient(primary, ctx)).detected;
      return [...(wanted ? [primary] : []), ...instances];
    }));
    expanded.flat().forEach(add);
  }
  for (const value of requested) {
    if (value === "all") continue;
    const { id, instance } = splitTarget(value);
    const spec = CLIENTS[id as ClientId];
    const all = await expandClientTargets(spec, ctx);
    if (instance === undefined) {
      all.forEach(add);
      continue;
    }
    // `<client>:primary` is the client's own location alone; it never brings its instances along.
    if (instance === PRIMARY_INSTANCE) {
      add(all[0]);
      continue;
    }
    const match = all.find((target) => target.instance === instance);
    if (!match) throw new Error(`Unknown target ${JSON.stringify(value)}. Valid targets: ${targetUsage()}.`);
    add(match);
  }
  const specs = [...new Set(targets.filter((target) => target.instance === undefined).map((target) => target.spec))];
  return { specs, targets, auto };
}

export interface ClientStatus {
  client: ClientId;
  /** Instance of the client (for example `t3:1a2b3c4d5e6f`); absent for the primary location. */
  instance?: string;
  label: string;
  detected: boolean;
  detected_by: string[];
  config_path: string;
  skill_path: string;
  mcp_status: McpStatus;
  mcp_detail?: string;
  skill_status: SkillStatus;
  skill_error?: string;
  /** The client is detected, or already has an MCP entry or the skill, so drift matters for it. */
  relevant: boolean;
  fix_command?: string;
}

/**
 * The `--target` value that repairs exactly `target`. A primary location of a client that also has instances is named
 * `<client>:primary`, because the bare client id would expand to every instance and `--force` would overwrite them too.
 */
export async function fixTargetId(target: ClientTarget, ctx: InstallContext): Promise<string> {
  if (target.instance !== undefined || target.spec.instances === undefined) return target.targetId;
  return (await target.spec.instances(ctx)).length > 0 ? `${target.spec.id}:${PRIMARY_INSTANCE}` : target.targetId;
}

/** The command that repairs `mcp` for `client`; undefined when there is nothing to fix. For `invalid` it applies after the file is repaired by hand. */
export function fixCommand(client: string, mcp: McpStatus, skill: SkillStatus): string | undefined {
  switch (mcp) {
    case "missing":
    case "stale":
      return skill === "current" ? `${CLI_NAME} mcp install --target ${client}` : `${CLI_NAME} setup --target ${client}`;
    case "disabled":
    case "conflict":
      return `${CLI_NAME} mcp install --target ${client} --force`;
    case "invalid":
      // `mcp install` skips an unparsable file, so this is the command to run once the syntax error is fixed.
      return `${CLI_NAME} setup --target ${client}`;
    case "current":
      return skill === "current" ? undefined : `${CLI_NAME} setup --target ${client}`;
  }
}

export async function inspectClient(input: ClientSpec | ClientTarget, ctx: InstallContext): Promise<ClientStatus> {
  const target = toTarget(input, ctx);
  const { spec } = target;
  const [mcp, detection] = await Promise.all([inspectMcp(target, ctx), detectClient(target, ctx)]);
  const skill = await inspectSkill(mcp.layout.skillDir, ctx.skillSourcePath);
  return {
    client: spec.id, ...(target.instance !== undefined ? { instance: target.instance } : {}), label: spec.label, detected: detection.detected, detected_by: detection.reasons,
    config_path: mcp.layout.configPath, skill_path: mcp.layout.skillDir, mcp_status: mcp.status, mcp_detail: mcp.detail,
    skill_status: skill.status, skill_error: skill.error,
    relevant: detection.detected || mcp.status !== "missing" || skill.status !== "missing",
    fix_command: fixCommand(await fixTargetId(target, ctx), mcp.status, skill.status),
  };
}

/** Status of every client that is detected or already touched by this tool. */
export async function inspectRelevantClients(ctx: InstallContext): Promise<ClientStatus[]> {
  const targets = (await Promise.all(CLIENT_IDS.map((id) => expandClientTargets(CLIENTS[id], ctx)))).flat();
  const all = await Promise.all(targets.map((target) => inspectClient(target, ctx)));
  return all.filter((status) => status.relevant);
}

/** `mcp status --check` fails unless the MCP entry is current (so a disabled, foreign, invalid, stale or missing one fails) and the skill is current. */
export function hasDrift(status: ClientStatus): boolean {
  return status.mcp_status !== "current" || status.skill_status !== "current";
}

/** What a human should do about `status`; an unparsable config must be repaired by hand before any command can touch it. */
export function fixAdvice(status: Pick<ClientStatus, "mcp_status" | "config_path" | "fix_command">): string | undefined {
  if (status.fix_command === undefined) return undefined;
  return status.mcp_status === "invalid"
    ? `fix the syntax error in ${status.config_path} first, then run \`${status.fix_command}\``
    : `fix with \`${status.fix_command}\``;
}

export interface SetupTargetResult {
  mcp: McpTargetResult;
  skill: { path: string; status: SkillStatus; status_after: SkillStatus; action: SkillAction | "error"; message?: string };
  /** Both registrations read back as current (always false under `--dry-run`). */
  verified: boolean;
  /** Why `verified` is false after a real run, for example a disabled or foreign entry that was left untouched. */
  unverified_reason?: string;
  ok: boolean;
}

export function isMcpFailure(result: McpTargetResult): boolean {
  return result.action === "error" || (result.action === "skipped" && (result.status === "conflict" || result.status === "invalid"));
}

function unverifiedReasonOf(after: ClientStatus, mcp: McpTargetResult): string {
  const parts = [
    ...(after.mcp_status !== "current" ? [`the MCP registration is ${after.mcp_status}${mcp.action === "skipped" ? " and was left untouched" : ""}`] : []),
    ...(after.skill_status !== "current" ? [`the skill is ${after.skill_status}`] : []),
  ];
  return redactSecrets(parts.join("; "));
}

export async function setupClient(input: ClientSpec | ClientTarget, ctx: InstallContext, options: MutationOptions): Promise<SetupTargetResult> {
  const target = toTarget(input, ctx);
  const mcp = await installMcpClient(target, ctx, options);
  const before = await inspectSkill(mcp.skill_path, ctx.skillSourcePath);
  const skill: SetupTargetResult["skill"] = { path: before.path, status: before.status, status_after: before.status, action: "unchanged" };
  try {
    assertInstanceSkillWritable(target, ctx);
    const installed = await installSkillDir(mcp.skill_path, ctx.skillSourcePath, options.dryRun);
    skill.action = installed.action;
    skill.status_after = "current";
  } catch (error) {
    skill.action = "error";
    skill.message = errorMessage(error);
  }
  if (options.dryRun) return { mcp, skill, verified: false, ok: !isMcpFailure(mcp) && skill.action !== "error" };
  const after = await inspectClient(target, ctx);
  skill.status_after = after.skill_status;
  const mcpOk = after.mcp_status === "current" || (after.mcp_status === "disabled" && mcp.action === "skipped");
  const verified = after.mcp_status === "current" && after.skill_status === "current";
  const ok = !isMcpFailure(mcp) && skill.action !== "error" && mcpOk && after.skill_status === "current";
  const unverifiedReason = verified ? undefined : unverifiedReasonOf(after, mcp);
  return { mcp: { ...mcp, status_after: after.mcp_status }, skill, verified, ...(unverifiedReason ? { unverified_reason: unverifiedReason } : {}), ok };
}
