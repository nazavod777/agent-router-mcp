/**
 * Line-oriented TOML scanner for surgical edits: it finds table headers and `key = value` statements (including
 * multi-line strings and arrays) so single keys or whole tables can be changed while comments and every unrelated
 * table stay byte-for-byte intact. Callers must validate the edited text with a real TOML parser before writing.
 */

export interface TomlHeader {
  path: string[];
  isArray: boolean;
  /** Offset of the header line start. */
  lineStart: number;
  /** Offset just after the header line (including its line break). */
  lineEnd: number;
}

export interface TomlStatement {
  /** Dotted key as written, split into segments. */
  key: string[];
  start: number;
  end: number;
}

interface TomlLine {
  start: number;
  end: number;
  /** True when no multi-line string or bracketed value is open at the start of this line. */
  neutralStart: boolean;
}

export interface TomlScan {
  text: string;
  lines: TomlLine[];
  headers: TomlHeader[];
}

/** Parses a dotted key (`a."b c".d`) from `source` at `from`; stops at the first unquoted character that is not part of a key. */
export function parseKeyPath(source: string, from = 0): { path: string[]; end: number } | undefined {
  const path: string[] = [];
  let index = from;
  for (;;) {
    while (source[index] === " " || source[index] === "\t") index += 1;
    const char = source[index];
    if (char === '"' || char === "'") {
      const close = findClosingQuote(source, index);
      if (close === -1) return undefined;
      const raw = source.slice(index + 1, close);
      path.push(char === '"' ? unescapeBasic(raw) : raw);
      index = close + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return undefined;
      path.push(match[0]);
      index += match[0].length;
    }
    while (source[index] === " " || source[index] === "\t") index += 1;
    if (source[index] !== ".") return { path, end: index };
    index += 1;
  }
}

function findClosingQuote(source: string, open: number): number {
  const quote = source[open];
  for (let index = open + 1; index < source.length; index += 1) {
    if (quote === '"' && source[index] === "\\") index += 1;
    else if (source[index] === quote) return index;
  }
  return -1;
}

function unescapeBasic(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

function scanLines(text: string): TomlLine[] {
  const lines: TomlLine[] = [];
  let multiline: "" | '"""' | "'''" = "";
  let depth = 0;
  let position = 0;
  while (position < text.length) {
    const newline = text.indexOf("\n", position);
    const contentEnd = newline === -1 ? text.length : newline;
    const next = newline === -1 ? text.length : newline + 1;
    const neutralStart = multiline === "" && depth === 0;
    let index = position;
    while (index < contentEnd) {
      if (multiline !== "") {
        if (multiline === '"""' && text[index] === "\\") index += 2;
        else if (text.startsWith(multiline, index)) {
          multiline = "";
          index += 3;
        } else index += 1;
        continue;
      }
      const char = text[index];
      if (char === "#") break;
      if (char === '"' || char === "'") {
        const triple = char.repeat(3) as '"""' | "'''";
        if (text.startsWith(triple, index)) {
          multiline = triple;
          index += 3;
          continue;
        }
        index += 1;
        while (index < contentEnd && text[index] !== char) index += char === '"' && text[index] === "\\" ? 2 : 1;
        index += 1;
        continue;
      }
      if (char === "[" || char === "{") depth += 1;
      else if ((char === "]" || char === "}") && depth > 0) depth -= 1;
      index += 1;
    }
    lines.push({ start: position, end: next, neutralStart });
    position = next;
  }
  return lines;
}

function parseHeader(line: string): { path: string[]; isArray: boolean } | undefined {
  const trimmed = line.trimStart();
  const isArray = trimmed.startsWith("[[");
  const parsed = parseKeyPath(trimmed, isArray ? 2 : 1);
  if (!parsed) return undefined;
  const rest = trimmed.slice(parsed.end);
  return rest.startsWith(isArray ? "]]" : "]") ? { path: parsed.path, isArray } : undefined;
}

export function scanToml(text: string): TomlScan {
  const lines = scanLines(text);
  const headers: TomlHeader[] = [];
  for (const line of lines) {
    if (!line.neutralStart) continue;
    const content = text.slice(line.start, line.end);
    if (!content.trimStart().startsWith("[")) continue;
    const header = parseHeader(content);
    if (header) headers.push({ ...header, lineStart: line.start, lineEnd: line.end });
  }
  return { text, lines, headers };
}

export function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

/** Offset where the table owned by `header` stops listing its own keys (the next header of any kind, or EOF). */
function bodyEnd(scan: TomlScan, header: TomlHeader): number {
  const next = scan.headers.find((candidate) => candidate.lineStart > header.lineStart);
  return next ? next.lineStart : scan.text.length;
}

/**
 * The header's block: itself plus every following sub-table. Trailing blank and comment-only lines are left out
 * because they usually introduce the next table.
 */
export function blockRange(scan: TomlScan, header: TomlHeader): { start: number; end: number } {
  const next = scan.headers.find((candidate) => candidate.lineStart > header.lineStart
    && !(candidate.path.length > header.path.length && header.path.every((segment, index) => candidate.path[index] === segment)));
  let end = next ? next.lineStart : scan.text.length;
  const floor = header.lineEnd;
  for (let index = scan.lines.length - 1; index >= 0; index -= 1) {
    const line = scan.lines[index];
    if (line.end > end || line.start < floor) continue;
    const content = scan.text.slice(line.start, line.end).trim();
    if (!line.neutralStart || (content !== "" && !content.startsWith("#"))) break;
    end = line.start;
  }
  return { start: header.lineStart, end };
}

export function statementsOf(scan: TomlScan, header: TomlHeader): TomlStatement[] {
  const end = bodyEnd(scan, header);
  const statements: TomlStatement[] = [];
  for (const line of scan.lines) {
    if (line.start < header.lineEnd || line.start >= end) continue;
    if (!line.neutralStart) {
      const last = statements[statements.length - 1];
      if (last) last.end = line.end;
      continue;
    }
    const content = scan.text.slice(line.start, line.end).trim();
    if (!content || content.startsWith("#")) continue;
    const key = parseKeyPath(content);
    if (key) statements.push({ key: key.path, start: line.start, end: line.end });
  }
  return statements;
}

function lineBreak(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export type TomlKeyEdit = { key: string; raw: string } | { key: string; remove: true };

/** Applies key edits to the table owned by the `headerIndex`-th header; rescans after each edit so offsets stay valid. */
export function editTableKeys(text: string, headerIndex: number, edits: readonly TomlKeyEdit[]): string {
  let current = text;
  const eol = lineBreak(text);
  for (const edit of edits) {
    const scan = scanToml(current);
    const header = scan.headers[headerIndex];
    if (!header) throw new Error("TOML table disappeared during editing.");
    const statements = statementsOf(scan, header);
    const existing = statements.find((statement) => statement.key.length === 1 && statement.key[0] === edit.key);
    if ("remove" in edit) {
      if (existing) current = current.slice(0, existing.start) + current.slice(existing.end);
      continue;
    }
    if (existing) {
      const indent = /^[ \t]*/.exec(current.slice(existing.start, existing.end))?.[0] ?? "";
      const hadBreak = current.slice(existing.start, existing.end).endsWith("\n");
      current = current.slice(0, existing.start) + `${indent}${edit.key} = ${edit.raw}${hadBreak ? eol : ""}` + current.slice(existing.end);
      continue;
    }
    const last = statements[statements.length - 1];
    const insertAt = last ? last.end : header.lineEnd;
    const prefix = insertAt > 0 && current[insertAt - 1] !== "\n" ? eol : "";
    current = `${current.slice(0, insertAt)}${prefix}${edit.key} = ${edit.raw}${eol}${current.slice(insertAt)}`;
  }
  return current;
}

/** Appends a block at the end of the file, separated from the previous content by one blank line. */
export function appendBlock(text: string, block: string): string {
  const eol = lineBreak(text);
  let base = text;
  if (base.length > 0 && !base.endsWith("\n")) base += eol;
  if (base.length > 0 && !/\n[ \t]*\r?\n$/.test(base)) base += eol;
  return `${base}${block.replace(/\n/g, eol)}${eol}`;
}

function isDescendantPath(path: readonly string[], ancestor: readonly string[]): boolean {
  return path.length > ancestor.length && ancestor.every((segment, index) => path[index] === segment);
}

/**
 * Indexes of the sub-tables that belong to the table at `headerIndex` but sit apart from it. For an array element
 * (`[[a]]`) these are the `[a.sub]` tables behind an unrelated table: TOML gives them to the latest `[[a]]` element before
 * them, so they belong to it until the next `[[a]]` header. A plain table (`[a]`) owns every `[a.sub]` table anywhere in the
 * file, before or after it. Sub-tables already inside `blockRange` are not listed.
 */
function detachedSubtableIndexes(scan: TomlScan, headerIndex: number): number[] {
  const header = scan.headers[headerIndex];
  if (!header) return [];
  const { start: blockStart, end: blockEnd } = blockRange(scan, header);
  const indexes: number[] = [];
  let coveredUntil = 0;
  for (let index = 0; index < scan.headers.length; index += 1) {
    if (index === headerIndex || (header.isArray && index < headerIndex)) continue;
    const candidate = scan.headers[index];
    if (header.isArray && candidate.isArray && samePath(candidate.path, header.path)) break;
    if (!isDescendantPath(candidate.path, header.path)) continue;
    if ((candidate.lineStart >= blockStart && candidate.lineStart < blockEnd) || candidate.lineStart < coveredUntil) continue;
    indexes.push(index);
    coveredUntil = blockRange(scan, candidate).end;
  }
  return indexes;
}

/** Removes the sub-tables of the table at `headerIndex` that are separated from it; the table itself stays (its header index may shift when some sat before it). */
export function removeDetachedSubtables(text: string, headerIndex: number): string {
  let result = text;
  for (const index of detachedSubtableIndexes(scanToml(text), headerIndex).reverse()) result = removeBlock(result, index);
  return result;
}

/** Removes a header's whole block (and one blank separator line) while leaving comments that belong to what follows. */
export function removeBlock(text: string, headerIndex: number): string {
  const scan = scanToml(text);
  const header = scan.headers[headerIndex];
  if (!header) return text;
  const { start, end: blockEnd } = blockRange(scan, header);
  let end = blockEnd;
  const precededByBlank = start === 0 || /\n[ \t]*\r?\n$/.test(text.slice(0, start)) || /^[ \t]*\r?\n$/.test(text.slice(0, start));
  while (precededByBlank && end < text.length) {
    const blank = /^[ \t]*\r?\n/.exec(text.slice(end));
    if (!blank) break;
    end += blank[0].length;
  }
  const result = text.slice(0, start) + text.slice(end);
  return end >= text.length ? result.replace(/(?:\r?\n[ \t]*)+$/, (match) => (match.includes("\n") ? lineBreak(text) : "")) : result;
}

/** A TOML basic string literal. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

export function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}
