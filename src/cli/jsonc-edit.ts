/**
 * Minimal JSON/JSONC reader that keeps source offsets, so a single property can be inserted, replaced, or removed
 * while every other byte (comments, ordering, whitespace, trailing commas) stays untouched.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface BaseNode {
  start: number;
  end: number;
}
interface Member {
  key: string;
  keyStart: number;
  node: JsonNode;
}
export interface ObjectNode extends BaseNode {
  kind: "object";
  members: Member[];
}
interface ArrayNode extends BaseNode {
  kind: "array";
  items: JsonNode[];
}
interface PrimitiveNode extends BaseNode {
  kind: "primitive";
  value: null | boolean | number | string;
}
export type JsonNode = ObjectNode | ArrayNode | PrimitiveNode;

export class JsoncSyntaxError extends Error {}

const MAX_DEPTH = 64;

class Parser {
  private index = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonNode {
    this.index = this.text.charCodeAt(0) === 0xfeff ? 1 : 0;
    this.skipTrivia();
    if (this.index >= this.text.length) throw this.error("Empty document");
    const node = this.parseValue(0);
    this.skipTrivia();
    if (this.index < this.text.length) throw this.error("Unexpected content after the root value");
    return node;
  }

  private error(message: string): JsoncSyntaxError {
    const upTo = this.text.slice(0, this.index);
    const line = upTo.split("\n").length;
    const column = this.index - upTo.lastIndexOf("\n");
    return new JsoncSyntaxError(`${message} at line ${line}, column ${column}`);
  }

  private skipTrivia(): void {
    for (;;) {
      const char = this.text[this.index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r") {
        this.index += 1;
      } else if (char === "/" && this.text[this.index + 1] === "/") {
        while (this.index < this.text.length && this.text[this.index] !== "\n") this.index += 1;
      } else if (char === "/" && this.text[this.index + 1] === "*") {
        const close = this.text.indexOf("*/", this.index + 2);
        if (close === -1) throw this.error("Unterminated block comment");
        this.index = close + 2;
      } else {
        return;
      }
    }
  }

  private parseValue(depth: number): JsonNode {
    if (depth > MAX_DEPTH) throw this.error("Document is nested too deeply");
    const char = this.text[this.index];
    if (char === "{") return this.parseObject(depth);
    if (char === "[") return this.parseArray(depth);
    if (char === '"') {
      const start = this.index;
      const value = this.parseString();
      return { kind: "primitive", start, end: this.index, value };
    }
    return this.parseLiteral();
  }

  private parseObject(depth: number): ObjectNode {
    const start = this.index;
    this.index += 1;
    const members: Member[] = [];
    for (;;) {
      this.skipTrivia();
      const char = this.text[this.index];
      if (char === "}") {
        this.index += 1;
        return { kind: "object", start, end: this.index, members };
      }
      if (char !== '"') throw this.error("Expected a property name");
      const keyStart = this.index;
      const key = this.parseString();
      this.skipTrivia();
      if (this.text[this.index] !== ":") throw this.error("Expected ':'");
      this.index += 1;
      this.skipTrivia();
      members.push({ key, keyStart, node: this.parseValue(depth + 1) });
      this.skipTrivia();
      if (this.text[this.index] === ",") this.index += 1;
      else if (this.text[this.index] !== "}") throw this.error("Expected ',' or '}'");
    }
  }

  private parseArray(depth: number): ArrayNode {
    const start = this.index;
    this.index += 1;
    const items: JsonNode[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return { kind: "array", start, end: this.index, items };
      }
      items.push(this.parseValue(depth + 1));
      this.skipTrivia();
      if (this.text[this.index] === ",") this.index += 1;
      else if (this.text[this.index] !== "]") throw this.error("Expected ',' or ']'");
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === "\\") this.index += 2;
      else if (char === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index)) as string;
        } catch {
          this.index = start;
          throw this.error("Invalid string");
        }
      } else if (char === "\n") break;
      else this.index += 1;
    }
    this.index = start;
    throw this.error("Unterminated string");
  }

  private parseLiteral(): PrimitiveNode {
    const start = this.index;
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(start, start + 64));
    if (!match) throw this.error("Unexpected token");
    this.index += match[0].length;
    return { kind: "primitive", start, end: this.index, value: JSON.parse(match[0]) as null | boolean | number };
  }
}

export function parseJsonc(text: string): JsonNode {
  return new Parser(text).parseDocument();
}

export function nodeToValue(node: JsonNode): JsonValue {
  if (node.kind === "primitive") return node.value;
  if (node.kind === "array") return node.items.map(nodeToValue);
  const result: { [key: string]: JsonValue } = {};
  for (const member of node.members) Object.defineProperty(result, member.key, { value: nodeToValue(member.node), enumerable: true, writable: true, configurable: true });
  return result;
}

export function isPlainObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findMember(node: ObjectNode, key: string): Member | undefined {
  // Last duplicate wins, matching JSON.parse.
  for (let index = node.members.length - 1; index >= 0; index -= 1) if (node.members[index].key === key) return node.members[index];
  return undefined;
}

/** Walks `path` through nested objects; returns undefined if any step is missing or not an object. */
export function getNodeAt(root: JsonNode, path: readonly string[]): JsonNode | undefined {
  let current: JsonNode = root;
  for (const key of path) {
    if (current.kind !== "object") return undefined;
    const member = findMember(current, key);
    if (!member) return undefined;
    current = member.node;
  }
  return current;
}

/** The deepest object along `path` that exists, plus the number of path segments it consumed. */
function deepestObject(root: JsonNode, path: readonly string[]): { node: ObjectNode; depth: number } | undefined {
  if (root.kind !== "object") return undefined;
  let node: ObjectNode = root;
  let depth = 0;
  while (depth < path.length) {
    const member = findMember(node, path[depth]);
    if (!member) break;
    if (member.node.kind !== "object") return undefined;
    node = member.node;
    depth += 1;
  }
  return { node, depth };
}

interface Splice {
  start: number;
  end: number;
  text: string;
}

function applySplices(text: string, splices: Splice[]): string {
  let result = text;
  for (const splice of [...splices].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
  }
  return result;
}

const DEFAULT_INDENT = "  ";

/** First indentation unit found in the document (tabs or N spaces), used when new lines must be created. */
export function detectIndentUnit(text: string): string {
  const match = /\n([ \t]+)\S/.exec(text);
  if (!match) return DEFAULT_INDENT;
  const indent = match[1];
  if (indent.startsWith("\t")) return "\t";
  return /^ {1,8}$/.test(indent) ? indent : DEFAULT_INDENT;
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(text.slice(lineStart, offset));
  return match ? match[0] : "";
}

function startsOwnLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*$/.test(text.slice(lineStart, offset));
}

function serialize(value: JsonValue, indentUnit: string, baseIndent: string): string {
  return JSON.stringify(value, null, indentUnit).replace(/\n/g, `\n${baseIndent}`);
}

function wrapPath(path: readonly string[], value: JsonValue): JsonValue {
  return path.reduceRight<JsonValue>((inner, key) => ({ [key]: inner }), value);
}

function isMultiline(text: string, node: ObjectNode): boolean {
  return text.slice(node.start, node.end).includes("\n");
}

/**
 * Where a new member goes after the last one: right after its value (or its comma), or after a same-line comment.
 * `commaAt` is set when the last member has no comma yet and one must be added.
 */
function afterLastMember(text: string, node: ObjectNode): { insertAt: number; commaAt: number | undefined } {
  const valueEnd = node.members[node.members.length - 1].node.end;
  let cursor = valueEnd;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  const hasComma = text[cursor] === ",";
  let insertAt = hasComma ? cursor + 1 : valueEnd;
  if (hasComma) cursor += 1;
  while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
  const rest = text.slice(cursor);
  const comment = /^\/\/[^\n]*/.exec(rest) ?? /^\/\*(?:(?!\*\/)[^\n])*\*\//.exec(rest);
  if (comment) insertAt = cursor + comment[0].length;
  return { insertAt, commaAt: hasComma ? undefined : valueEnd };
}

/** Inserts `"key": value` as the last member of `node`, matching the object's indentation. */
function insertMember(text: string, node: ObjectNode, key: string, value: JsonValue, indentUnit: string): Splice[] {
  const keyJson = JSON.stringify(key);
  const objectIndent = lineIndent(text, node.start);
  if (node.members.length === 0) {
    const inner = `${objectIndent}${indentUnit}`;
    const member = `${inner}${keyJson}: ${serialize(value, indentUnit, inner)}`;
    if (/^\s*$/.test(text.slice(node.start + 1, node.end - 1))) {
      return [{ start: node.start + 1, end: node.end - 1, text: `\n${member}\n${objectIndent}` }];
    }
    // Comments inside the empty object stay; the member goes just before the closing brace.
    const close = node.end - 1;
    const lineStart = text.lastIndexOf("\n", close - 1) + 1;
    return /^[ \t]*$/.test(text.slice(lineStart, close))
      ? [{ start: lineStart, end: lineStart, text: `${member}\n` }]
      : [{ start: close, end: close, text: `\n${member}\n${objectIndent}` }];
  }
  if (!isMultiline(text, node)) {
    const last = node.members[node.members.length - 1];
    return [{ start: last.node.end, end: last.node.end, text: `, ${keyJson}: ${JSON.stringify(value)}` }];
  }
  const first = node.members[0];
  const memberIndent = startsOwnLine(text, first.keyStart) ? lineIndent(text, first.keyStart) : `${objectIndent}${indentUnit}`;
  const { insertAt, commaAt } = afterLastMember(text, node);
  const splices: Splice[] = [{ start: insertAt, end: insertAt, text: `\n${memberIndent}${keyJson}: ${serialize(value, indentUnit, memberIndent)}` }];
  if (commaAt !== undefined) splices.push({ start: commaAt, end: commaAt, text: "," });
  return splices;
}

/** Sets `path` to `value`, creating missing intermediate objects. Fails when an existing ancestor is not an object. */
export function setValueAt(text: string, root: JsonNode, path: readonly string[], value: JsonValue): string {
  if (path.length === 0) throw new Error("Cannot replace the document root.");
  const existing = getNodeAt(root, path);
  const indentUnit = detectIndentUnit(text);
  if (existing) {
    const member = parentMember(root, path);
    const indent = member ? lineIndent(text, member.keyStart) : "";
    return applySplices(text, [{ start: existing.start, end: existing.end, text: serialize(value, indentUnit, indent) }]);
  }
  const deepest = deepestObject(root, path);
  if (!deepest) throw new Error(`Cannot set ${path.join(".")}: an ancestor exists but is not an object.`);
  const missing = path.slice(deepest.depth);
  const wrapped = wrapPath(missing.slice(1), value);
  return applySplices(text, insertMember(text, deepest.node, missing[0], wrapped, indentUnit));
}

function parentMember(root: JsonNode, path: readonly string[]): Member | undefined {
  const parent = getNodeAt(root, path.slice(0, -1));
  return parent?.kind === "object" ? findMember(parent, path[path.length - 1]) : undefined;
}

/** Offset of the first `,` after `from` when only whitespace and comments separate them; -1 otherwise. */
function findCommaAfter(text: string, from: number, limit: number): number {
  let index = from;
  while (index < limit) {
    const char = text[index];
    if (char === ",") return index;
    if (char === "/" && text[index + 1] === "*") index = text.indexOf("*/", index + 2) + 2;
    else if (char === "/" && text[index + 1] === "/") index = text.indexOf("\n", index) === -1 ? limit : text.indexOf("\n", index);
    else if (/\s/.test(char)) index += 1;
    else return -1;
  }
  return -1;
}

/** Removes the property at `path`, together with its separating comma and (if it owned the line) the whole line. */
export function removeValueAt(text: string, root: JsonNode, path: readonly string[]): string {
  const parent = getNodeAt(root, path.slice(0, -1));
  if (parent?.kind !== "object") return text;
  const key = path[path.length - 1];
  const member = findMember(parent, key);
  if (!member) return text;
  const index = parent.members.indexOf(member);
  const splices: Splice[] = [];
  let start = member.keyStart;
  let end = member.node.end;

  const nextStart = index + 1 < parent.members.length ? parent.members[index + 1].keyStart : parent.end - 1;
  const comma = findCommaAfter(text, end, nextStart);
  if (comma !== -1) {
    end = comma + 1;
  } else if (index > 0) {
    const previous = parent.members[index - 1];
    const previousComma = findCommaAfter(text, previous.node.end, member.keyStart);
    if (previousComma !== -1) splices.push({ start: previousComma, end: previousComma + 1, text: "" });
  }

  // Swallow a trailing line comment and the line break when the member sat on its own line.
  const tail = /^[ \t]*(?:\/\/[^\n]*)?/.exec(text.slice(end));
  const afterTail = end + (tail ? tail[0].length : 0);
  if (startsOwnLine(text, start) && (text[afterTail] === "\n" || text[afterTail] === "\r" || afterTail >= text.length)) {
    start = text.lastIndexOf("\n", start - 1) + 1;
    end = afterTail;
    if (text[end] === "\r") end += 1;
    if (text[end] === "\n") end += 1;
  }
  splices.push({ start, end, text: "" });
  return applySplices(text, splices);
}
