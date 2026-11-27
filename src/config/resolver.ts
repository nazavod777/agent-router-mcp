import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { redactSecrets } from "../logging.js";
import type { FieldProvenance } from "../types.js";
import { getDefaultCatalogPath, getUserConfigPath } from "./paths.js";
import {
  CatalogSchema, HarnessSchema, HarnessUnsetSchema, ModelSchema, ModelUnsetSchema, OverridesSchema, PresetSchema,
} from "./schema.js";
import type { Catalog, ConfigOverrides, HarnessConfig, ModelConfig, PresetConfig } from "./schema.js";

type Table = Record<string, unknown>;
type ProvenanceMap = Record<string, FieldProvenance>;

export interface EntityProvenance {
  provenance: FieldProvenance;
  /** Nested fields use dotted paths, such as roles.review.effort. */
  field_provenance: ProvenanceMap;
  default_changed: boolean;
}

export type ResolvedHarness = HarnessConfig & EntityProvenance;
export type ResolvedModel = ModelConfig & EntityProvenance & { is_stale: boolean };
export type ResolvedPreset = PresetConfig & EntityProvenance;

type EntitySection = "harnesses" | "models" | "presets";
export type QuarantineSection = EntitySection | "aliases";

/** One user entity that failed validation and was left out of the resolved config; everything else still applies. */
export interface QuarantinedEntity {
  section: QuarantineSection;
  id: string;
  reason: string;
}

interface ResolvedCatalog extends Omit<Catalog, "harnesses" | "models" | "presets"> {
  harnesses: Record<string, ResolvedHarness>;
  models: Record<string, ModelConfig & EntityProvenance>;
  presets: Record<string, ResolvedPreset>;
  defaults_provenance: ProvenanceMap;
  aliases_provenance: ProvenanceMap;
  quarantined: QuarantinedEntity[];
}

export interface ConfigSnapshot extends Omit<ResolvedCatalog, "models"> {
  models: Record<string, ResolvedModel>;
  revision: string;
  config_warnings: string[];
  /**
   * True when the user config file exists but could not be used and no earlier good config was in memory, so the built-in
   * defaults were loaded instead. Those defaults are NOT what the user configured (a safety setting such as
   * `allow_unsandboxed_write = false` may be lost), so jobs must not run until the file is repaired.
   */
  cold_start_fallback: boolean;
}

function ownValue<T>(table: Record<string, T> | undefined, key: string): T | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!isTable(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}

export function computeEntityHash(entity: object): string {
  return createHash("sha256").update(JSON.stringify(sortedValue(entity))).digest("hex").slice(0, 12);
}

export function computeConfigRevision(defaultText: string, userBytes: Buffer | null): string {
  const hash = createHash("sha256").update(JSON.stringify(defaultText));
  return hash.update(userBytes === null ? "0" : "1").update(userBytes ?? "").digest("hex");
}

const RESERVED_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];
const MAX_TRAILING_STRING_QUOTES = 2;
const ENTITY_SECTIONS = ["aliases", "harnesses", "models", "presets"] as const;

/** An ID that would collide with `Object.prototype` members; it is set aside as a quarantined entity, never used. */
export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.includes(key);
}

const DATE_LITERAL = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/;

function isCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(2000, month - 1, day));
  probe.setUTCFullYear(year);
  return month >= 1 && month <= 12 && day >= 1 && probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Index just past the string or comment that starts at `index`, or `index` itself when none starts there. */
function skipStringOrComment(text: string, index: number): number {
  const char = text[index];
  if (char === "#") {
    const newline = text.indexOf("\n", index);
    return newline < 0 ? text.length : newline;
  }
  if (char !== "\"" && char !== "'") return index;
  const multiline = text.startsWith(char.repeat(3), index);
  const delimiter = multiline ? char.repeat(3) : char;
  let cursor = index + delimiter.length;
  while (cursor < text.length) {
    if (char === "\"" && text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (text.startsWith(delimiter, cursor)) {
      cursor += delimiter.length;
      // A multiline string may end with up to two extra quotes that belong to its content.
      for (let extra = 0; multiline && extra < MAX_TRAILING_STRING_QUOTES && text[cursor] === char; extra++) cursor += 1;
      return cursor;
    }
    if (!multiline && text[cursor] === "\n") return cursor;
    cursor += 1;
  }
  return text.length;
}

/**
 * smol-toml silently rolls an impossible date such as `2026-02-30` over to March 2nd. This quotes every such literal in the
 * text, so the value arrives as a string that the date fields then reject for that one entity (a bare key that looks like a
 * date stays equivalent: quoted and bare keys are the same key). Valid text is returned untouched.
 */
function quoteImpossibleDates(text: string): string {
  let out = "";
  let copiedUpTo = 0;
  let index = 0;
  while (index < text.length) {
    const skipped = skipStringOrComment(text, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    const previous = text[index - 1];
    if (/\d/.test(text[index]) && (previous === undefined || !/[\w-]/.test(previous))) {
      const match = DATE_LITERAL.exec(text.slice(index, index + 40));
      if (match) {
        const [literal, year, month, day] = match;
        if (!isCalendarDate(Number(year), Number(month), Number(day))) {
          out += `${text.slice(copiedUpTo, index)}"${literal}"`;
          copiedUpTo = index + literal.length;
        }
        index += literal.length;
        continue;
      }
    }
    index += 1;
  }
  return copiedUpTo === 0 ? text : out + text.slice(copiedUpTo);
}

/** Reserved names that Zod would silently drop: file-level ones fail loudly, entity-level ones are re-added to be quarantined. */
function reservedKeyProblems(raw: unknown): { fileLevel?: string; entities: Array<{ section: QuarantineSection; id: string; value: unknown }> } {
  const entities: Array<{ section: QuarantineSection; id: string; value: unknown }> = [];
  if (!isTable(raw)) return { entities };
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (isReservedKey(key)) return { entities, fileLevel: `${key} is a reserved name and cannot be a config section` };
  }
  const defaults = raw.defaults;
  if (isTable(defaults)) {
    const key = Object.getOwnPropertyNames(defaults).find(isReservedKey);
    if (key !== undefined) return { entities, fileLevel: `defaults.${key} is a reserved name and cannot be a setting` };
  }
  for (const section of ENTITY_SECTIONS) {
    const table = raw[section];
    if (!isTable(table)) continue;
    for (const id of Object.getOwnPropertyNames(table).filter(isReservedKey)) {
      entities.push({ section, id, value: Object.getOwnPropertyDescriptor(table, id)?.value });
    }
  }
  return { entities };
}

export function parseUserOverrides(text: string | null): ConfigOverrides {
  if (text === null) return {};
  let raw: unknown;
  try {
    raw = parse(quoteImpossibleDates(text));
  } catch (error) {
    throw new Error(describeLoadError(error));
  }
  const reserved = reservedKeyProblems(raw);
  if (reserved.fileLevel !== undefined) throw new Error(reserved.fileLevel);
  const overrides = OverridesSchema.parse(raw);
  for (const { section, id, value } of reserved.entities) {
    // Re-added as an own data property (never assigned), so it stays a plain key; the resolver quarantines it by name.
    const table = { ...overrides[section] };
    Object.defineProperty(table, id, { value, enumerable: true, writable: true, configurable: true });
    overrides[section] = table;
  }
  return overrides;
}

/**
 * Follows aliases to a model ID. When `models` is given, a real model ID always wins over an alias of the same name, at
 * every step, so a custom model can reuse a built-in alias name.
 */
export function resolveModelAlias(id: string, aliases: Catalog["aliases"], models?: object): string {
  const visited = new Set<string>();
  for (;;) {
    if (models && Object.hasOwn(models, id)) return id;
    if (!Object.hasOwn(aliases, id)) return id;
    if (visited.has(id)) throw new Error(`Model alias cycle at ${JSON.stringify(id)}`);
    visited.add(id);
    id = aliases[id];
  }
}

function normalizeCatalog(input: unknown): Catalog {
  const catalog = CatalogSchema.parse(input);
  return {
    ...catalog,
    models: Object.fromEntries(Object.entries(catalog.models).map(([id, model]) => [
      id,
      { ...model, cli_model: model.cli_model ?? id },
    ])),
  };
}

function modelReferenceProblem(id: string, model: { harness: string }, harnesses: object): string | undefined {
  if (Object.hasOwn(harnesses, model.harness)) return undefined;
  return `models.${id}.harness references unknown harness ${JSON.stringify(model.harness)}`;
}

function roleReferenceProblem(
  path: string,
  role: { harness: string; model: string; effort: string },
  harnesses: object,
  models: Record<string, { harness: string; efforts: string[] }>,
  aliases: Catalog["aliases"],
): string | undefined {
  if (!Object.hasOwn(harnesses, role.harness)) {
    return `${path}.harness references unknown harness ${JSON.stringify(role.harness)}`;
  }
  let modelId: string;
  try {
    modelId = resolveModelAlias(role.model, aliases, models);
  } catch (error) {
    return `${path}.model: ${(error as Error).message}`;
  }
  const model = ownValue(models, modelId);
  if (!model) return `${path}.model references unknown model ${JSON.stringify(modelId)}`;
  if (model.harness !== role.harness) {
    return `${path}.harness ${JSON.stringify(role.harness)} does not match model ${JSON.stringify(modelId)} harness ${JSON.stringify(model.harness)}`;
  }
  if (!model.efforts.includes(role.effort)) return `${path}.effort is not supported by model ${JSON.stringify(modelId)}`;
  return undefined;
}

function presetReferenceProblem(
  id: string,
  preset: { enabled: boolean; roles: Record<string, { harness: string; model: string; effort: string }> },
  harnesses: object,
  models: Record<string, { harness: string; efforts: string[] }>,
  aliases: Catalog["aliases"],
): string | undefined {
  if (!preset.enabled) return undefined;
  for (const [name, role] of Object.entries(preset.roles)) {
    const problem = roleReferenceProblem(`presets.${id}.roles.${name}`, role, harnesses, models, aliases);
    if (problem) return problem;
  }
  return undefined;
}

function validateReferences(catalog: Catalog): void {
  for (const [id, model] of Object.entries(catalog.models)) {
    const problem = modelReferenceProblem(id, model, catalog.harnesses);
    if (problem) throw new Error(problem);
  }
  for (const [id, preset] of Object.entries(catalog.presets)) {
    const problem = presetReferenceProblem(id, preset, catalog.harnesses, catalog.models, catalog.aliases);
    if (problem) throw new Error(problem);
  }
}

export function parseDefaultCatalog(text: string): Catalog {
  const catalog = normalizeCatalog(parse(text));
  validateReferences(catalog);
  return catalog;
}

function mergeTables(base: Table, overrides: Table): Table {
  const replacements = Object.entries(overrides).map(([key, value]) => {
    const inherited = ownValue(base, key);
    return [key, isTable(inherited) && isTable(value) ? mergeTables(inherited, value) : value];
  });
  return { ...base, ...Object.fromEntries(replacements) };
}

function mergePreset(base: Table, override: Table): Table {
  const merged = mergeTables(base, override);
  if (!isTable(override.roles) || !isTable(merged.roles)) return merged;
  const roles = { ...merged.roles };
  for (const [name, role] of Object.entries(override.roles)) {
    // TOML has no null literal. An empty role table is its on-disk equivalent.
    if (role === null || (isTable(role) && Object.keys(role).length === 0)) {
      delete roles[name];
    }
  }
  return { ...merged, roles };
}

type ParseResult<T> = { success: true; data: T } | { success: false; error: z.ZodError };

function prefixIssues(error: z.ZodError, prefix: Array<string | number>): z.ZodError {
  return new z.ZodError(error.issues.map((issue) => ({ ...issue, path: [...prefix, ...issue.path] })));
}

/** Applies `_unset` (clears inherited optional fields) and validates the merged entity; `_unset` never reaches the result. */
function parseEntity(section: EntitySection, id: string, merged: Table): ParseResult<unknown> {
  let entity = merged;
  if (section !== "presets" && Object.hasOwn(merged, "_unset")) {
    const { _unset, ...rest } = merged;
    const fields = (section === "harnesses" ? HarnessUnsetSchema : ModelUnsetSchema).safeParse(_unset);
    if (!fields.success) return { success: false, error: prefixIssues(fields.error, [section, id, "_unset"]) };
    const cleared: readonly string[] = fields.data;
    entity = Object.fromEntries(Object.entries(rest).filter(([key]) => !cleared.includes(key)));
  }
  const schema = section === "harnesses" ? HarnessSchema : section === "models" ? ModelSchema : PresetSchema;
  const result = schema.safeParse(entity);
  if (result.success) {
    const data = section === "models" ? { ...(result.data as object), cli_model: (result.data as { cli_model?: string }).cli_model ?? id } : result.data;
    return { success: true, data };
  }
  return { success: false, error: prefixIssues(result.error, [section, id]) };
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`).join("; ");
}

/** The original validation error behind each quarantine record, so a rejected write can rethrow it with its field paths. */
const quarantineFailures = new WeakMap<QuarantinedEntity, Error>();

/** The failure a rejected write rethrows, with every message redacted: a Zod error keeps its field paths, anything else is the reason. */
function redactedFailure(failure: Error, redactedReason: string): Error {
  if (!(failure instanceof z.ZodError)) return new Error(redactedReason);
  return new z.ZodError(failure.issues.map((issue) => ({ ...issue, message: redactSecrets(issue.message) })));
}

/** Quarantine reasons can quote user TOML values, so they are redacted when the record is created. */
function quarantineRecord(section: QuarantineSection, id: string, reason: string, failure?: Error): QuarantinedEntity {
  const record: QuarantinedEntity = { section, id, reason: redactSecrets(reason) };
  if (failure !== undefined) quarantineFailures.set(record, redactedFailure(failure, record.reason));
  return record;
}

/** The error a write should fail with when `entry` is invalid: the original validation error when known, else its reason. */
export function quarantineFailure(entry: QuarantinedEntity): Error {
  return quarantineFailures.get(entry) ?? new Error(entry.reason);
}

/** Decides what happens to an entity that fails validation: it is quarantined (default) or the failure is thrown. */
export type InvalidEntityPolicy = (section: QuarantineSection, id: string) => "quarantine" | "throw";

export interface ResolveOptions {
  onInvalid?: InvalidEntityPolicy;
}

interface SectionResolution<T> {
  entities: Record<string, T>;
  /** User overrides that actually took effect (quarantined ones are dropped). */
  overrides: Record<string, Table>;
}

/**
 * Merges and validates every entity of one section on its own. An entity whose user override is invalid falls back to its
 * built-in definition (and is reported); a custom entity with no built-in to fall back on is left out.
 */
function resolveSection<T>(
  section: EntitySection,
  base: Record<string, Table>,
  overrides: Record<string, Table> | undefined,
  merge: (inherited: Table, override: Table) => Table,
  accept: (id: string, value: T) => string | undefined,
  policy: InvalidEntityPolicy,
  quarantined: QuarantinedEntity[],
): SectionResolution<T> {
  const entities: Record<string, T> = {};
  const effective: Record<string, Table> = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(overrides ?? {})])) {
    const override = ownValue(overrides, id);
    const builtIn = ownValue(base, id);
    const attempt = (userOverride: Table | undefined): { value?: T; error?: z.ZodError; problem?: string } => {
      const inherited = userOverride?.custom === true ? {} : builtIn ?? {};
      const parsed = parseEntity(section, id, merge(inherited, userOverride ?? {}));
      if (!parsed.success) return { error: parsed.error, problem: describeIssues(parsed.error) };
      const problem = accept(id, parsed.data as T);
      return problem ? { problem } : { value: parsed.data as T };
    };

    const first = attempt(override);
    if (first.problem === undefined) {
      entities[id] = first.value as T;
      if (override) effective[id] = override;
      continue;
    }
    if (policy(section, id) === "throw") throw first.error ?? new Error(redactSecrets(first.problem));
    quarantined.push(quarantineRecord(section, id, first.problem, first.error ?? new Error(first.problem)));
    const fallback = override && builtIn ? attempt(undefined) : undefined;
    if (fallback && fallback.problem === undefined) entities[id] = fallback.value as T;
  }
  return { entities, overrides: effective };
}

function fieldProvenance(entity: Table, overrides: Table = {}, custom = false, prefix = ""): ProvenanceMap {
  const fields: Array<[string, FieldProvenance]> = [];
  for (const [key, value] of Object.entries(entity)) {
    const path = `${prefix}${key}`;
    const provenance = custom ? "custom" : Object.hasOwn(overrides, key) ? "overridden" : "default";
    fields.push([path, provenance]);
    if (isTable(value)) {
      const nested = ownValue(overrides, key);
      fields.push(...Object.entries(fieldProvenance(value, isTable(nested) ? nested : {}, custom, `${path}.`)));
    }
  }
  return Object.fromEntries(fields);
}

/** Names listed in the override's `_unset` that the built-in entity actually has. */
function clearedBuiltInFields(override: Table | undefined, base: Table): string[] {
  const unset = override?._unset;
  return Array.isArray(unset)
    ? unset.filter((name): name is string => typeof name === "string" && Object.hasOwn(base, name) && base[name] !== undefined)
    : [];
}

function addProvenance<T extends Table>(
  entities: Record<string, T>,
  defaults: Record<string, T>,
  overrides?: Record<string, Table>,
): Record<string, T & EntityProvenance> {
  return Object.fromEntries(Object.entries(entities).map(([id, entity]) => {
    const base = ownValue(defaults, id);
    const override = ownValue(overrides, id);
    const custom = !base || entity.custom === true;
    const fieldMap = fieldProvenance(entity, override, custom);
    if (!custom && base) {
      // A cleared built-in field has no resolved value, but it is still an override the UI must offer to reset.
      for (const name of clearedBuiltInFields(override, base)) fieldMap[name] = "overridden";
    }
    return [id, {
      ...entity,
      provenance: custom ? "custom" : override ? "overridden" : "default",
      field_provenance: fieldMap,
      default_changed: Boolean(base && !custom && typeof override?._base_hash === "string" &&
        override._base_hash !== computeEntityHash(base)),
    }];
  }));
}

/** The user file with every malformed entity taken out: each remaining entity is a table, each alias a non-empty string. */
interface WellFormedOverrides {
  schema_version?: 1;
  defaults?: Record<string, unknown>;
  aliases: Record<string, string>;
  harnesses: Record<string, Table>;
  models: Record<string, Table>;
  presets: Record<string, Table>;
}

function malformedProblem(section: QuarantineSection, id: string, value: unknown): string | undefined {
  if (isReservedKey(id)) return `${section}.${id} uses a reserved name and cannot be an ID`;
  if (section === "aliases") {
    return typeof value === "string" && value.length > 0 ? undefined : `aliases.${id} must be a non-empty model ID string`;
  }
  return isTable(value) ? undefined : `${section}.${id} must be a table of fields, not ${Array.isArray(value) ? "an array" : value === null ? "null" : typeof value}`;
}

/** Sets aside (or throws, per policy) each entity that is not even the right kind of value; the others are kept. */
function wellFormedOverrides(overrides: ConfigOverrides, policy: InvalidEntityPolicy, quarantined: QuarantinedEntity[]): WellFormedOverrides {
  const clean = <T>(section: QuarantineSection, table: Record<string, unknown> | undefined): Record<string, T> => {
    const kept: Record<string, T> = {};
    for (const [id, value] of Object.entries(table ?? {})) {
      const problem = malformedProblem(section, id, value);
      if (problem === undefined) {
        Object.defineProperty(kept, id, { value, enumerable: true, writable: true, configurable: true });
        continue;
      }
      if (policy(section, id) === "throw") throw new Error(problem);
      quarantined.push(quarantineRecord(section, id, problem));
    }
    return kept;
  };
  return {
    ...(overrides.schema_version !== undefined ? { schema_version: overrides.schema_version } : {}),
    ...(overrides.defaults !== undefined ? { defaults: overrides.defaults } : {}),
    aliases: clean<string>("aliases", overrides.aliases),
    harnesses: clean<Table>("harnesses", overrides.harnesses),
    models: clean<Table>("models", overrides.models),
    presets: clean<Table>("presets", overrides.presets),
  };
}

/** Why a user alias cannot be used: it loops, or it does not end at a model. Shadowed aliases (a model has the ID) never apply. */
function aliasProblem(id: string, aliases: Catalog["aliases"], models: object): string | undefined {
  if (Object.hasOwn(models, id)) return undefined;
  let target: string;
  try {
    target = resolveModelAlias(id, aliases, models);
  } catch (error) {
    return (error as Error).message;
  }
  return Object.hasOwn(models, target) ? undefined : `alias ${JSON.stringify(id)} points to unknown model ${JSON.stringify(target)}`;
}

/**
 * Checks each user alias on its own, after the models and before the presets that use aliases: a loop or a missing target
 * quarantines just that alias (a built-in alias of the same name comes back), so a hand-edited alias cannot crash resolution.
 */
function resolveAliases(
  defaults: Catalog["aliases"], userAliases: Record<string, string>, models: object, policy: InvalidEntityPolicy,
  quarantined: QuarantinedEntity[],
): { aliases: Catalog["aliases"]; effective: Record<string, string> } {
  const combined = { ...defaults, ...userAliases };
  const effective = { ...userAliases };
  for (const id of Object.keys(userAliases)) {
    const problem = aliasProblem(id, combined, models);
    if (problem === undefined) continue;
    if (policy("aliases", id) === "throw") throw new Error(problem);
    quarantined.push(quarantineRecord("aliases", id, problem));
    delete effective[id];
  }
  return { aliases: { ...defaults, ...effective }, effective };
}

function resolveOnce(defaults: Catalog, rawOverrides: ConfigOverrides, options: ResolveOptions): ResolvedCatalog {
  const policy: InvalidEntityPolicy = options.onInvalid ?? (() => "quarantine");
  const quarantined: QuarantinedEntity[] = [];
  const overrides = wellFormedOverrides(rawOverrides, policy, quarantined);
  const head = CatalogSchema.parse({
    schema_version: overrides.schema_version ?? defaults.schema_version,
    defaults: { ...defaults.defaults, ...overrides.defaults },
    aliases: defaults.aliases,
  });

  const harnesses = resolveSection<HarnessConfig>(
    "harnesses", defaults.harnesses, overrides.harnesses, mergeTables, () => undefined, policy, quarantined,
  );
  const models = resolveSection<ModelConfig>(
    "models", defaults.models, overrides.models, mergeTables,
    (id, model) => modelReferenceProblem(id, model, harnesses.entities), policy, quarantined,
  );
  const resolvedAliases = resolveAliases(defaults.aliases, overrides.aliases, models.entities, policy, quarantined);
  head.aliases = resolvedAliases.aliases;
  const presets = resolveSection<PresetConfig>(
    "presets", defaults.presets, overrides.presets, mergePreset,
    (id, preset) => presetReferenceProblem(id, preset, harnesses.entities, models.entities, head.aliases), policy, quarantined,
  );
  for (const preset of Object.values(presets.entities)) {
    if (!preset.enabled) continue;
    for (const role of Object.values(preset.roles)) role.model = resolveModelAlias(role.model, head.aliases, models.entities);
  }

  return {
    ...head,
    harnesses: addProvenance(harnesses.entities, defaults.harnesses, harnesses.overrides),
    models: addProvenance(models.entities, defaults.models, models.overrides),
    presets: addProvenance(presets.entities, defaults.presets, presets.overrides),
    defaults_provenance: fieldProvenance(head.defaults, overrides.defaults),
    aliases_provenance: fieldProvenance(head.aliases, resolvedAliases.effective),
    quarantined,
  };
}

const MAX_CULPRIT_PASSES = 8;

/** One record per entity: when an entity was set aside twice (for example malformed, then its built-in fallback failed too), the first reason wins. */
function onePerEntity(records: QuarantinedEntity[]): QuarantinedEntity[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.section}\0${record.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolves the config. A built-in preset the user never touched can still break because a valid-looking model override
 * removed an effort or moved the model to another harness. Dropping that preset would lose the default preset, so the
 * model override that causes the break is quarantined instead and the built-in preset stays.
 */
export function resolveConfig(defaults: Catalog, overrides: ConfigOverrides = {}, options: ResolveOptions = {}): ResolvedCatalog {
  let current = overrides;
  const blamed: QuarantinedEntity[] = [];
  for (let pass = 0; ; pass++) {
    const result = resolveOnce(defaults, current, options);
    const culprits = pass < MAX_CULPRIT_PASSES ? culpritModels(defaults, current, result) : [];
    if (culprits.length === 0) return { ...result, quarantined: onePerEntity([...blamed, ...result.quarantined]) };
    if (culprits.some((culprit) => options.onInvalid?.("models", culprit.id) === "throw")) return result;
    const remaining = { ...current.models };
    for (const culprit of culprits) {
      delete remaining[culprit.id];
      blamed.push(culprit);
    }
    current = { ...current, models: remaining };
  }
}

/**
 * Models whose user override breaks a built-in preset that has no user override of its own. Only the model of a role that
 * actually fails is blamed: other models of the same preset keep their (valid) overrides, such as `enabled = false`.
 */
function culpritModels(defaults: Catalog, overrides: ConfigOverrides, result: ResolvedCatalog): QuarantinedEntity[] {
  const culprits = new Map<string, QuarantinedEntity>();
  for (const entry of result.quarantined) {
    // A built-in preset that still resolved (its override was set aside and the built-in works) has nothing to blame a model for.
    if (entry.section !== "presets" || Object.hasOwn(result.presets, entry.id)) continue;
    const preset = ownValue(defaults.presets, entry.id);
    if (!preset) continue;
    // A user override of the preset that only changes metadata (such as the description) is not the cause; one that rewrites a role is.
    const override = ownValue(overrides.presets, entry.id);
    const rewrittenRoles = isTable(override) && isTable(override.roles) ? override.roles : {};
    for (const [name, role] of Object.entries(preset.roles)) {
      if (Object.hasOwn(rewrittenRoles, name)) continue;
      const problem = roleReferenceProblem(`presets.${entry.id}.roles.${name}`, role, result.harnesses, result.models, result.aliases);
      if (problem === undefined) continue;
      const modelId = resolveModelAlias(role.model, result.aliases, defaults.models);
      const modelOverride = ownValue(overrides.models, modelId);
      if (modelOverride === undefined || !Object.hasOwn(defaults.models, modelId) || culprits.has(modelId)) continue;
      // Blame the override only when the role works again with the built-in card (an alias or harness override may be the cause).
      const withBuiltIn = { ...result.models, [modelId]: defaults.models[modelId] };
      if (roleReferenceProblem(`presets.${entry.id}.roles.${name}`, role, result.harnesses, withBuiltIn, result.aliases) === undefined) {
        culprits.set(modelId, quarantineRecord(
          "models", modelId,
          `the override breaks the built-in preset ${JSON.stringify(entry.id)} (${problem}); the built-in model is used instead`,
        ));
      }
    }
  }
  return [...culprits.values()];
}

/** A user alias whose key is also a model ID never takes effect (model IDs win), so the user should know. */
export function aliasShadowWarnings(overrides: ConfigOverrides, models: object): string[] {
  return Object.keys(overrides.aliases ?? {}).filter((alias) => Object.hasOwn(models, alias)).map((alias) =>
    `User alias ${JSON.stringify(alias)} is ignored because a model has the same ID (model IDs take precedence over aliases). ` +
    `Remove it with \`config reset aliases.${alias}\` or rename the alias.`);
}

export function quarantineWarning(entry: QuarantinedEntity, userPath: string): string {
  return `Quarantined ${entry.section}.${entry.id} from ${userPath}: ${entry.reason}. ` +
    "The rest of the user config still applies; fix or reset this entity to bring it back.";
}

export function readOptionalConfig(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function fileStamp(path: string): string | undefined {
  try {
    const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
    return stats && `${stats.mtimeNs}:${stats.ctimeNs}:${stats.size}:${stats.ino}`;
  } catch (error) {
    // An unreadable location (for example a parent that is a file) is reported when the file is read, not thrown from here.
    return `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

export interface ConfigManagerOptions {
  defaultPath?: string;
  userPath?: string;
  now?: () => Date;
}

interface LoadedConfig {
  defaultStamp: string | undefined;
  userStamp: string | undefined;
  catalog: ResolvedCatalog;
  revision: string;
  warnings: string[];
  coldStartFallback: boolean;
}

/**
 * A short, secret-free description of why the user config could not be loaded. smol-toml appends raw source lines to its
 * message and Zod messages can quote keys, so neither is passed through: only the summary and the position are kept.
 */
export function describeLoadError(error: unknown): string {
  if (error instanceof z.ZodError) return redactSecrets(describeIssues(error));
  if (!(error instanceof Error)) return "Invalid configuration.";
  const tomlError = error as Error & { line?: unknown; column?: unknown };
  const summary = redactSecrets(error.message.split(/\r?\n\s*\r?\n/, 1)[0].split(/\r?\n/, 1)[0]);
  if (typeof tomlError.line === "number" && typeof tomlError.column === "number") {
    const safeSummary = summary.replace(/"[^"]*"|'[^']*'/g, '"<redacted>"');
    return `TOML syntax error at line ${tomlError.line}, column ${tomlError.column} (${safeSummary}).`;
  }
  return summary;
}

const MILLISECONDS_PER_DAY = 86_400_000;

/** Non-fatal: older user configs that set a smaller max_timeout_sec must keep loading, with the cap applied at run time. */
function timeoutWarnings(defaults: Catalog["defaults"]): string[] {
  const warnings: string[] = [];
  for (const key of ["default_timeout_sec", "high_effort_timeout_sec"] as const) {
    if (defaults[key] > defaults.max_timeout_sec) {
      warnings.push(`defaults.${key} (${defaults[key]}) exceeds defaults.max_timeout_sec (${defaults.max_timeout_sec}); ` +
        `jobs will be capped at ${defaults.max_timeout_sec} seconds. Raise max_timeout_sec or lower ${key}.`);
    }
  }
  if (defaults.host_max_concurrency < defaults.max_concurrency) {
    warnings.push(`defaults.host_max_concurrency (${defaults.host_max_concurrency}) is below defaults.max_concurrency ` +
      `(${defaults.max_concurrency}); the host cap is raised to ${defaults.max_concurrency}. Raise host_max_concurrency or lower max_concurrency.`);
  }
  if (defaults.idle_timeout_sec > 0 && defaults.idle_timeout_sec > defaults.max_timeout_sec) {
    warnings.push(`defaults.idle_timeout_sec (${defaults.idle_timeout_sec}) exceeds defaults.max_timeout_sec (${defaults.max_timeout_sec}); ` +
      "idle detection can never fire before the hard cap. Lower idle_timeout_sec or raise max_timeout_sec.");
  }
  if (defaults.timeout_extension_sec > defaults.max_timeout_sec) {
    warnings.push(`defaults.timeout_extension_sec (${defaults.timeout_extension_sec}) exceeds defaults.max_timeout_sec (${defaults.max_timeout_sec}); ` +
      "one extension always reaches the hard cap. Lower timeout_extension_sec or raise max_timeout_sec.");
  }
  return warnings;
}

export class ConfigManager {
  readonly defaultPath: string;
  readonly userPath: string;
  private readonly now: () => Date;
  private loaded?: LoadedConfig;
  private lastGood?: ResolvedCatalog;

  constructor(options: ConfigManagerOptions = {}) {
    this.defaultPath = resolve(options.defaultPath ?? getDefaultCatalogPath());
    this.userPath = resolve(options.userPath ?? getUserConfigPath());
    this.now = options.now ?? (() => new Date());
  }

  load(): ConfigSnapshot {
    return this.snapshot(this.readCurrent());
  }

  getSnapshot(): ConfigSnapshot {
    return this.snapshot(this.loaded ?? this.readCurrent());
  }

  getRevision(): string {
    return this.readCurrent().revision;
  }

  reloadIfChanged(): ConfigSnapshot {
    return this.load();
  }

  private readCurrent(): LoadedConfig {
    const defaultStamp = fileStamp(this.defaultPath);
    const userStamp = fileStamp(this.userPath);
    if (this.loaded && this.loaded.defaultStamp === defaultStamp && this.loaded.userStamp === userStamp) {
      return this.loaded;
    }

    const defaultText = readFileSync(this.defaultPath, "utf8");
    const defaults = parseDefaultCatalog(defaultText);
    const warnings: string[] = [];
    let userBytes: Buffer | null = null;
    let failure: string | undefined;
    try {
      userBytes = readOptionalConfig(this.userPath);
    } catch (error) {
      failure = `The file cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`;
    }
    let catalog: ResolvedCatalog | undefined;
    if (failure === undefined) {
      try {
        const overrides = parseUserOverrides(userBytes?.toString("utf8") ?? null);
        catalog = resolveConfig(defaults, overrides);
        this.lastGood = catalog;
        warnings.push(...catalog.quarantined.map((entry) => quarantineWarning(entry, this.userPath)),
          ...aliasShadowWarnings(overrides, catalog.models));
      } catch (error) {
        failure = describeLoadError(error);
      }
    }
    // With no earlier good config in memory the built-in defaults are NOT what the user configured, so the snapshot says so.
    const coldStartFallback = failure !== undefined && this.lastGood === undefined;
    if (failure !== undefined) {
      warnings.push(`Invalid user config at ${this.userPath}. Using ${
        this.lastGood ? "last-known-good config" : "built-in defaults (jobs are refused until the file is repaired)"
      }. ${failure}`);
      catalog = this.lastGood ?? resolveConfig(defaults);
    }

    const resolved = catalog as ResolvedCatalog;
    warnings.push(...timeoutWarnings(resolved.defaults));
    this.loaded = {
      defaultStamp, userStamp, catalog: resolved, revision: computeConfigRevision(defaultText, userBytes),
      warnings: warnings.map((warning) => redactSecrets(warning)), coldStartFallback,
    };
    return this.loaded;
  }

  private snapshot(loaded: LoadedConfig): ConfigSnapshot {
    const now = this.now().getTime();
    const maxAge = loaded.catalog.defaults.stale_after_days * MILLISECONDS_PER_DAY;
    const models = Object.fromEntries(Object.entries(loaded.catalog.models).map(([id, model]) => [
      id,
      { ...model, is_stale: model.checked_at !== undefined && now - Date.parse(model.checked_at) > maxAge },
    ]));
    return structuredClone({
      ...loaded.catalog, models, revision: loaded.revision, config_warnings: loaded.warnings, cold_start_fallback: loaded.coldStartFallback,
    });
  }
}
