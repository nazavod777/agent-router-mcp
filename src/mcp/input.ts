import { z } from "zod";
import type { StructuredError } from "../types.js";

/**
 * Lenient wire schemas for MCP tool arguments.
 *
 * Every helper is `z.preprocess(normalize, cleanInnerSchema)`: zod's JSON Schema generator (input mode) emits only the clean
 * inner schema, so `tools/list` stays flat Draft-7 with no `anyOf` and no nullable types, while the call itself accepts the
 * sloppy forms LLM clients really send (`null`, "", numeric strings, "false", aliases). Never use a bare `.transform()` or
 * `z.coerce.boolean()` here: the first breaks schema generation, the second turns the string "false" into `true`.
 */

const MAX_IGNORED_ARGUMENTS = 10;
const MAX_IGNORED_NAME_CHARS = 48;
/** Longer unknown keys get no "did you mean" hint: no declared key is that long, and edit distance costs length x length. */
const MAX_SUGGESTION_KEY_CHARS = 64;
const INTEGER_PATTERN = /^[+-]?\d+$/;
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

type Lenient<Inner extends z.ZodType> = z.ZodPreprocess<Inner, unknown>;
type EnumSchema<Values extends readonly string[]> = z.ZodEnum<z.core.util.ToEnum<Values[number]>>;

/** Structured "the call was malformed" error; never retryable, so callers fix the input instead of re-sending it. */
export function invalidInputError(message: string, missing?: string[], example?: Record<string, unknown>): StructuredError {
  return {
    code: "INVALID_INPUT",
    message,
    retryable: false,
    failure_scope: "job",
    details: { ...(missing ? { missing } : {}), ...(example ? { example } : {}) },
  };
}

function isBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** `null` and blank strings mean "not provided" for every non-string type. */
function treatEmptyAsMissing(value: unknown): unknown {
  return value === null || isBlankString(value) ? undefined : value;
}

/** Optional string. `blank: "keep"` preserves "" and whitespace so a handler can reject it with a precise message. */
export function optStr(options: { blank?: "undefined" | "keep"; max?: number } = {}): Lenient<z.ZodOptional<z.ZodString>> {
  const { blank = "undefined", max } = options;
  const inner = max === undefined ? z.string() : z.string().max(max);
  return z.preprocess((value) => {
    if (value === null) return undefined;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (blank === "undefined" && isBlankString(value)) return undefined;
    return value;
  }, inner.optional());
}

interface NumberOptions {
  min?: number;
}

export interface IntOptions extends NumberOptions {
  max?: number;
  /** Values above this are lowered to it instead of rejected (negative, non-finite, and garbage input still fail). */
  clampMax?: number;
  default?: number;
}

function parseNumeric(value: unknown, pattern: RegExp): unknown {
  const missing = treatEmptyAsMissing(value);
  if (typeof missing !== "string") return missing;
  const text = missing.trim();
  return pattern.test(text) && Number.isFinite(Number(text)) ? Number(text) : value;
}

export function optInt(options: IntOptions & { default: number }): Lenient<z.ZodDefault<z.ZodNumber>>;
export function optInt(options?: IntOptions): Lenient<z.ZodOptional<z.ZodNumber>>;
export function optInt(options: IntOptions = {}): Lenient<z.ZodDefault<z.ZodNumber> | z.ZodOptional<z.ZodNumber>> {
  const { min, max, clampMax, default: fallback } = options;
  let inner = z.number().int();
  if (min !== undefined) inner = inner.min(min);
  if (max !== undefined) inner = inner.max(max);
  return z.preprocess((value) => {
    const parsed = parseNumeric(value, INTEGER_PATTERN);
    return clampMax !== undefined && typeof parsed === "number" && Number.isFinite(parsed) && parsed > clampMax ? clampMax : parsed;
  }, fallback === undefined ? inner.optional() : inner.default(fallback));
}

export function optNum(options: NumberOptions & { positive?: boolean } = {}): Lenient<z.ZodOptional<z.ZodNumber>> {
  const { min, positive } = options;
  let inner = z.number();
  if (positive) inner = inner.positive();
  if (min !== undefined) inner = inner.min(min);
  return z.preprocess((value) => parseNumeric(value, NUMBER_PATTERN), inner.optional());
}

const BOOLEAN_WORDS: ReadonlyMap<string, boolean> = new Map([
  ["true", true], ["false", false], ["1", true], ["0", false], ["yes", true], ["no", false],
]);

/** Anything that is not clearly true/false is left alone and rejected, so an ambiguous flag can never switch a side effect on. */
export function optBool(defaultValue: boolean): Lenient<z.ZodDefault<z.ZodBoolean>>;
export function optBool(): Lenient<z.ZodOptional<z.ZodBoolean>>;
export function optBool(defaultValue?: boolean): Lenient<z.ZodDefault<z.ZodBoolean> | z.ZodOptional<z.ZodBoolean>> {
  return z.preprocess((value) => {
    const present = treatEmptyAsMissing(value);
    if (typeof present === "string") return BOOLEAN_WORDS.get(present.trim().toLowerCase()) ?? value;
    if (present === 1 || present === 0) return present === 1;
    return present;
  }, defaultValue === undefined ? z.boolean().optional() : z.boolean().default(defaultValue));
}

function dropNullish(items: unknown[]): unknown[] {
  return items.filter((item) => item !== null && item !== undefined);
}

/**
 * A single string, a comma-separated string ("codex,claude"), a JSON array string, or an array; null elements are dropped.
 * Blank array elements are kept for the handler, while blank items of a comma-separated string are dropped.
 */
export function optStrList(): Lenient<z.ZodOptional<z.ZodArray<z.ZodString>>> {
  return z.preprocess((value) => {
    if (value === null || isBlankString(value)) return undefined;
    if (Array.isArray(value)) return dropNullish(value);
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (text.startsWith("[")) {
      const parsed = tryParseJson(text);
      if (parsed.ok && Array.isArray(parsed.value)) return dropNullish(parsed.value);
      return [text];
    }
    const items = text.split(",").map((item) => item.trim()).filter((item) => item !== "");
    return items.length > 0 ? items : undefined;
  }, z.array(z.string()).optional());
}

function asObjectList(value: unknown): unknown {
  if (value === null || isBlankString(value)) return undefined;
  if (typeof value === "string") {
    const parsed = tryParseJson(value.trim());
    return parsed.ok && typeof parsed.value !== "string" ? asObjectList(parsed.value) : value;
  }
  if (Array.isArray(value)) return dropNullish(value);
  return isPlainObject(value) ? [value] : value;
}

/** A list of objects given as an array, one bare object, or a JSON string of either. */
export function optObjList<Item extends z.ZodType>(itemSchema: Item): Lenient<z.ZodOptional<z.ZodArray<Item>>> {
  return z.preprocess(asObjectList, z.array(itemSchema).optional());
}

/** One optional object, also accepted as a JSON string. */
export function optObj<Inner extends z.ZodType>(schema: Inner): Lenient<z.ZodOptional<Inner>> {
  return z.preprocess((value) => {
    if (value === null || isBlankString(value)) return undefined;
    if (typeof value !== "string") return value;
    const parsed = tryParseJson(value.trim());
    return parsed.ok ? parsed.value : value;
  }, schema.optional());
}

export function looseEnum<const Values extends readonly [string, ...string[]]>(
  values: Values, aliases: Readonly<Record<string, Values[number]>> | undefined, defaultValue: Values[number],
): Lenient<z.ZodDefault<EnumSchema<Values>>>;
export function looseEnum<const Values extends readonly [string, ...string[]]>(
  values: Values, aliases?: Readonly<Record<string, Values[number]>>,
): Lenient<z.ZodOptional<EnumSchema<Values>>>;
export function looseEnum<const Values extends readonly [string, ...string[]]>(
  values: Values, aliases: Readonly<Record<string, Values[number]>> = {}, defaultValue?: Values[number],
): Lenient<z.ZodDefault<EnumSchema<Values>> | z.ZodOptional<EnumSchema<Values>>> {
  const known = new Set<string>(values);
  const aliasMap = new Map(Object.entries(aliases).map(([from, to]) => [from.toLowerCase(), to]));
  const inner = z.enum(values);
  return z.preprocess((value) => {
    if (value === null || isBlankString(value)) return undefined;
    if (typeof value !== "string") return value;
    const lowered = value.trim().toLowerCase();
    for (const candidate of [lowered, lowered.replace(/[\s-]+/g, "_")]) {
      const resolved = aliasMap.get(candidate) ?? (known.has(candidate) ? candidate : undefined);
      if (resolved !== undefined) return resolved;
    }
    return value;
  }, defaultValue === undefined ? inner.optional() : inner.default(defaultValue));
}

/** Copies only the declared argument keys; a loose input schema must never leak unknown keys into a runner request. */
export function pickKnown<Args extends object>(args: Args, knownKeys: readonly string[]): Args {
  const allowed = new Set(knownKeys);
  return Object.fromEntries(Object.entries(args).filter(([key]) => allowed.has(key))) as Args;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    for (let column = 1; column <= right.length; column++) {
      const substitution = previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current.push(Math.min(previous[column] + 1, current[column - 1] + 1, substitution));
    }
    previous = current;
  }
  return previous[right.length];
}

function squash(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function closestKnownKey(name: string, candidates: readonly string[]): string | undefined {
  if (name.length > MAX_SUGGESTION_KEY_CHARS) return undefined;
  const target = squash(name);
  if (!target) return undefined;
  let best: { key: string; distance: number } | undefined;
  for (const key of candidates) {
    const distance = editDistance(target, squash(key));
    if (!best || distance < best.distance) best = { key, distance };
  }
  // Allow roughly one typo per three characters, never a wild guess for short names.
  return best && best.distance <= Math.max(1, Math.floor(Math.min(target.length, squash(best.key).length) / 3)) ? best.key : undefined;
}

/** A nested object whose own keys are checked too, for example one entry of `subtasks`. */
export interface NestedArgs {
  /** Prefix shown before each unknown key, for example `subtasks[0].`. */
  path: string;
  raw: Record<string, unknown>;
  knownKeys: readonly string[];
  /** Known misplacements: unknown key -> where it belongs (for example `model` -> `override.model`). */
  hints?: Readonly<Record<string, string>>;
}

function unknownKeys(nested: NestedArgs): string[] {
  const known = new Set(nested.knownKeys);
  return Object.keys(nested.raw).filter((key) => !known.has(key));
}

function describeUnknownKey(nested: NestedArgs, key: string): string {
  // A key the caller already filled in cannot be what a stray name was meant for; null counts as not filled.
  const unused = nested.knownKeys.filter((name) => nested.raw[name] === undefined || nested.raw[name] === null);
  const shown = `${nested.path}${key.length > MAX_IGNORED_NAME_CHARS ? `${key.slice(0, MAX_IGNORED_NAME_CHARS)}...` : key}`;
  const suggestion = nested.hints && Object.hasOwn(nested.hints, key) ? nested.hints[key] : closestKnownKey(key, unused);
  return suggestion ? `${shown} (did you mean "${suggestion}"?)` : shown;
}

/**
 * Names the arguments a tool did not declare (typos, wrong casing, invented options) so the caller learns they were ignored.
 * Only key names are reported, never values, so prompts and secrets cannot leak through the warning. Keys past the display
 * cap are only counted: they are never formatted or compared against the declared keys.
 */
export function unknownArgsWarning(
  rawArgs: Record<string, unknown>, knownKeys: readonly string[], nested: readonly NestedArgs[] = [],
): { ignored_arguments: string[] } | undefined {
  const entries: string[] = [];
  let total = 0;
  for (const scope of [{ path: "", raw: rawArgs, knownKeys }, ...nested]) {
    for (const key of unknownKeys(scope)) {
      if (total < MAX_IGNORED_ARGUMENTS) entries.push(describeUnknownKey(scope, key));
      total++;
    }
  }
  if (total === 0) return undefined;
  if (total > MAX_IGNORED_ARGUMENTS) entries.push(`+${total - MAX_IGNORED_ARGUMENTS} more`);
  return { ignored_arguments: entries };
}

export const MAX_CONTEXT_ID_LENGTH = 128;

/** Trims a task-scoped context ID; a blank or oversized one is a caller mistake, not a reason to drop the link silently. */
export function normalizeContextId(contextId: string | undefined): string | undefined {
  if (contextId === undefined) return undefined;
  const trimmed = contextId.trim();
  if (!trimmed) {
    throw invalidInputError("context_id must not be blank; omit it or pass a short task-scoped ID.", ["context_id"], { context_id: "task-1" });
  }
  if (trimmed.length > MAX_CONTEXT_ID_LENGTH) {
    throw invalidInputError(`context_id must be at most ${MAX_CONTEXT_ID_LENGTH} characters.`, undefined, { context_id: "task-1" });
  }
  return trimmed;
}
