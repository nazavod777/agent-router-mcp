import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getStateDir } from "../config/paths.js";
import { ConfigManager, parseUserOverrides, readOptionalConfig, type ConfigSnapshot } from "../config/resolver.js";
import type { DefaultsPatch, HarnessPatch, ModelPatch, PresetPatch } from "../config/schema.js";
import { ConfigWriter } from "../config/writer.js";
import { CLI_NAME } from "./name.js";

const USAGE = `Usage:
  ${CLI_NAME} config path
  ${CLI_NAME} config show [--json]
  ${CLI_NAME} config get <dotted.path>
  ${CLI_NAME} config set <dotted.path> <value>
  ${CLI_NAME} config reset <defaults|harnesses|models|presets|aliases|all|<entity-path>>
  ${CLI_NAME} config get|set|reset --section <defaults|harnesses|models|presets|aliases> --id <id> [--field <field>] [<value>]
  (pass "all" explicitly to wipe every override)

Dotted paths may quote an ID that contains dots: models."acme-1.5".tier
Use --section/--id for IDs with dots, slashes, or colons (acme-1.5, openai/gpt-5, qwen3:32b).
Setting an unknown ID to a JSON object creates a new custom entity.
Aliases: config set aliases.<alias> <model-id>; config reset aliases.<alias> removes your override.
To clear an inherited optional field: config set models.<id>._unset '["cli_provider"]'.`;

/** Banner for a models.toml that failed to parse before any good config was loaded: every number below then comes from the built-in defaults. */
export function coldStartBanner(userPath: string): string {
  return `ERROR: the user config ${userPath} could not be loaded, so the results below show the built-in defaults, not your configuration. Jobs are refused until the file is repaired.`;
}

const ENTITY_SECTIONS = ["harnesses", "models", "presets"] as const;
type EntitySection = (typeof ENTITY_SECTIONS)[number];

function isEntitySection(section: string): section is EntitySection {
  return ENTITY_SECTIONS.some((value) => value === section);
}

function own(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && Object.hasOwn(value, key)) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

const CONFIG_SECTION_NAMES = ["defaults", "aliases", ...ENTITY_SECTIONS] as const;

interface ConfigTarget {
  section: string;
  id?: string;
  fields: string[];
}

/** Splits on dots outside double quotes; a quoted segment may hold dots and JSON escapes. */
function splitDotted(path: string): { segments: string[]; quoted: boolean } {
  const segments: string[] = [];
  let quoted = false;
  let index = 0;
  while (index <= path.length) {
    if (path[index] === '"') {
      let end = index + 1;
      while (end < path.length && path[end] !== '"') end += path[end] === "\\" ? 2 : 1;
      if (end >= path.length) throw new Error(`Unterminated quote in path: ${path}`);
      segments.push(JSON.parse(path.slice(index, end + 1)) as string);
      quoted = true;
      index = end + 1;
      if (index < path.length && path[index] !== ".") throw new Error(`Expected "." after a quoted segment in path: ${path}`);
      index += 1;
      continue;
    }
    const next = path.indexOf(".", index);
    const end = next === -1 ? path.length : next;
    segments.push(path.slice(index, end));
    index = end + 1;
  }
  return { segments, quoted };
}

/**
 * IDs of one section that exist only in the user file (for example a quarantined entity, which is absent from the snapshot),
 * so a dotted ID such as `acme-1.5` still resolves to itself when it is reset or deleted.
 */
function userFileIds(section: EntitySection): string[] {
  try {
    const text = readOptionalConfig(new ConfigManager().userPath)?.toString("utf8") ?? null;
    return Object.keys(parseUserOverrides(text)[section] ?? {});
  } catch {
    return [];
  }
}

function splitPath(config: ConfigSnapshot, path: string, value?: unknown): ConfigTarget {
  const { segments, quoted } = splitDotted(path);
  const [section, ...rest] = segments;
  if ((!isEntitySection(section) && section !== "aliases") || !rest.length) return { section, id: rest[0], fields: rest.slice(1) };
  // An alias has no sub-fields, so everything after "aliases." is its ID.
  if (section === "aliases") return { section, id: rest.join("."), fields: [] };
  if (quoted) return { section, id: rest[0], fields: rest.slice(1) };
  const suffix = rest.join(".");
  // Some model IDs contain dots. Match the longest complete known ID first.
  const known = [...new Set([...Object.keys(config[section]), ...userFileIds(section)])].filter((key) => suffix === key || suffix.startsWith(`${key}.`))
    .sort((a, b) => b.length - a.length)[0];
  if (known) return { section, id: known, fields: suffix === known ? [] : suffix.slice(known.length + 1).split(".") };
  // An unknown ID set to a whole object is a new entity whose ID is the entire suffix (acme-1.5, qwen3:32b).
  if (isPlainObject(value) && !(section === "presets" && rest.includes("roles"))) return { section, id: suffix, fields: [] };
  return { section, id: rest[0], fields: rest.slice(1) };
}

interface StructuredFlags {
  section?: string;
  id?: string;
  field?: string;
}

function structuredTarget(flags: StructuredFlags): ConfigTarget {
  if (!flags.section || !(CONFIG_SECTION_NAMES as readonly string[]).includes(flags.section)) {
    throw new Error(`--section must be one of: ${CONFIG_SECTION_NAMES.join(", ")}`);
  }
  if (!flags.id) throw new Error("--id is required with --section");
  return { section: flags.section, id: flags.id, fields: flags.field ? [flags.field] : [] };
}

function fieldValue(config: ConfigSnapshot, target: ConfigTarget, label: string): unknown {
  const keys = [target.section, ...(target.id === undefined ? [] : [target.id]), ...target.fields];
  const value = keys.reduce<unknown>(own, config);
  if (value === undefined) throw new Error(`Config path not found: ${label}`);
  return value;
}

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    if (/^\s*[[{"]/.test(text)) throw new Error("Use valid JSON for arrays, objects, and quoted strings.");
    return text;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entityPatch(fields: string[], value: unknown): Record<string, unknown> {
  if (fields.length === 1 && fields[0]) return { [fields[0]]: value };
  if (fields.length === 0 && isPlainObject(value)) return value;
  throw new Error("Set an entity field or pass a JSON object for the whole entity.");
}

const ROLE_FIELDS = ["harness", "model", "effort"] as const;

/** An empty role object means "delete this role" inside the writer, so the CLI must never forward it by accident. */
function assertRoleReplacement(path: string, value: Record<string, unknown>): void {
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !(ROLE_FIELDS as readonly string[]).includes(key));
  const invalid = ROLE_FIELDS.filter((key) => key in value && (typeof value[key] !== "string" || !value[key].trim()));
  if (keys.length === 0 || unknown.length || invalid.length) {
    throw new Error(`${path} needs a non-empty JSON object with ${ROLE_FIELDS.join(", ")} as non-empty strings`
      + (keys.length === 0 ? " (an empty {} would delete the role)." : unknown.length ? ` (unknown: ${unknown.join(", ")}).`
        : ` (invalid: ${invalid.join(", ")}).`));
  }
}

async function setField(writer: ConfigWriter, config: ConfigSnapshot, target: ConfigTarget, label: string, value: unknown): Promise<void> {
  const { section, id, fields } = target;
  if (section === "defaults" && id && !fields.length) {
    await writer.updateDefaults({ [id]: value } as DefaultsPatch);
    return;
  }
  if (section === "aliases" && id && !fields.length) {
    if (typeof value !== "string" || !value.trim()) throw new Error("An alias target must be a non-empty model ID.");
    await writer.upsertAlias(id, value);
    return;
  }
  if (!isEntitySection(section) || !id) throw new Error(`Unsupported config path: ${label}`);
  /** A whole object under an unknown ID creates a new custom entity. */
  const wholeEntity = (): Record<string, unknown> => {
    const patch = entityPatch(fields, value);
    return fields.length === 0 && !Object.hasOwn(config[section], id) && patch.custom === undefined ? { ...patch, custom: true } : patch;
  };
  switch (section) {
    case "harnesses":
      await writer.upsertHarnessOverride(id, wholeEntity() as HarnessPatch);
      break;
    case "models":
      await writer.upsertModelOverride(id, wholeEntity() as ModelPatch);
      break;
    case "presets": {
      const [first, role, field] = fields;
      // presets.<id>.roles.<role> '{"harness":...,"model":...,"effort":...}' replaces a whole role atomically.
      const patch = first === "roles" && role && field && fields.length === 3
        ? { roles: { [role]: { [field]: value } } }
        : first === "roles" && role && fields.length === 2 && isPlainObject(value)
          ? (assertRoleReplacement(label, value), { roles: { [role]: value } })
          : wholeEntity();
      await writer.upsertPresetOverride(id, patch as PresetPatch);
      break;
    }
  }
}

async function reset(writer: ConfigWriter, target: ConfigTarget, label: string): Promise<void> {
  const { section, id, fields } = target;
  if (label === "all") await writer.resetAllToDefault();
  else if (id === undefined && (section === "defaults" || section === "aliases" || isEntitySection(section))) await writer.resetSection(section);
  else if (id && !fields.length && section === "aliases") await writer.resetAlias(id);
  else if (id && !fields.length && section === "models") await writer.resetOrDeleteModel(id);
  else if (id && !fields.length && section === "harnesses") await writer.resetOrDeleteHarness(id);
  else if (id && !fields.length && section === "presets") await writer.resetOrDeletePreset(id);
  else if (id && fields.length === 1 && section === "models") await writer.resetModelField(id, fields[0] as keyof ModelPatch);
  else if (id && fields.length === 1 && section === "harnesses") await writer.resetHarnessField(id, fields[0] as keyof HarnessPatch);
  else throw new Error(`Unsupported reset path: ${label}`);
}

function summarize(config: ConfigSnapshot) {
  return {
    revision: config.revision,
    defaults: config.defaults,
    overrides: {
      defaults: Object.keys(config.defaults_provenance).filter((field) => config.defaults_provenance[field] !== "default"),
      aliases: Object.keys(config.aliases_provenance).filter((field) => config.aliases_provenance[field] !== "default"),
      ...Object.fromEntries(ENTITY_SECTIONS.map((section) => [section,
        Object.entries(config[section]).filter(([, entity]) => entity.provenance !== "default")
          .map(([id, entity]) => ({ id, provenance: entity.provenance, default_changed: entity.default_changed })),
      ])),
    },
    quarantined: config.quarantined,
    config_warnings: config.config_warnings,
    /** True when models.toml failed to parse before any good config was loaded: everything above is the built-in defaults, not the user's file. */
    cold_start_fallback: config.cold_start_fallback,
  };
}

export async function runConfigCommand([command, ...args]: string[]): Promise<void> {
  const manager = new ConfigManager();
  if (command === "path" && !args.length) {
    console.log(`Catalog: ${manager.defaultPath}\nUser config: ${manager.userPath}\nState: ${resolve(getStateDir())}`);
    return;
  }
  if (command === "show") {
    const { values } = parseArgs({ args, options: { json: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    if (values.help) {
      console.log(USAGE);
      return;
    }
    const config = summarize(manager.reloadIfChanged());
    if (values.json) console.log(JSON.stringify(config, null, 2));
    else {
      console.log([
        `Revision: ${config.revision}`,
        "Defaults",
        ...Object.entries(config.defaults).map(([name, value]) => `  ${name} = ${JSON.stringify(value)}`),
        "Overrides",
        ...Object.entries(config.overrides).map(([section, values]) => `  ${section}: ${values.map(
          (value: string | { id: string }) => typeof value === "string" ? value : value.id,
        ).join(", ") || "none"}`),
        ...(config.cold_start_fallback ? [coldStartBanner(manager.userPath)] : []),
        ...config.config_warnings.map((warning) => `Warning: ${warning}`),
      ].join("\n"));
    }
    return;
  }
  const structured = args.some((arg) => /^--(?:section|id|field)(?:=|$)/.test(arg));
  const flags = structured ? parseArgs({
    args,
    allowPositionals: true,
    options: { section: { type: "string" }, id: { type: "string" }, field: { type: "string" } },
  }) : undefined;
  const positionals = flags?.positionals ?? args;
  const target = (value?: unknown): { target: ConfigTarget; label: string } => {
    if (flags) return { target: structuredTarget(flags.values), label: [flags.values.section, flags.values.id, flags.values.field].filter(Boolean).join(".") };
    return { target: splitPath(manager.reloadIfChanged(), positionals[0], value), label: positionals[0] };
  };

  if (command === "get" && positionals.length === (flags ? 0 : 1)) {
    const { target: resolved, label } = target();
    const value = fieldValue(manager.reloadIfChanged(), resolved, label);
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return;
  }

  const writer = new ConfigWriter(manager);
  if (command === "set" && positionals.length === (flags ? 1 : 2)) {
    const value = parseValue(positionals[flags ? 0 : 1]);
    const { target: resolved, label } = target(value);
    await setField(writer, manager.reloadIfChanged(), resolved, label, value);
    console.log(`Updated ${label}`);
    return;
  }
  if (command === "reset" && positionals.length === (flags ? 0 : 1)) {
    const { target: resolved, label } = flags ? target() : { target: splitPath(manager.reloadIfChanged(), positionals[0]), label: positionals[0] };
    await reset(writer, resolved, label);
    console.log(`Reset ${label}`);
    return;
  }
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  throw new Error(USAGE);
}
