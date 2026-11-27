import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { JsoncSyntaxError, nodeToValue, parseJsonc, removeValueAt, setValueAt } from "../../src/cli/jsonc-edit.js";
import { appendBlock, editTableKeys, removeBlock, scanToml, tomlString } from "../../src/cli/toml-edit.js";

const setJson = (text: string, path: string[], value: unknown) => setValueAt(text, parseJsonc(text), path, value as never);
const removeJson = (text: string, path: string[]) => removeValueAt(text, parseJsonc(text), path);

describe("jsonc-edit", () => {
  it("parses comments, trailing commas and a BOM, and reports syntax errors with a position", () => {
    expect(nodeToValue(parseJsonc('\uFEFF{ /* a */ "a": [1, 2,], // b\n "c": null, }'))).toEqual({ a: [1, 2], c: null });
    expect(() => parseJsonc('{ "a": }')).toThrow(JsoncSyntaxError);
    expect(() => parseJsonc('{ "a": 1 } x')).toThrow(/line 1/);
    expect(() => parseJsonc("")).toThrow(/Empty/);
  });

  it("sets values in an empty object, an inline object and nested missing objects", () => {
    expect(JSON.parse(setJson("{}", ["a", "b"], { c: 1 }))).toEqual({ a: { b: { c: 1 } } });
    expect(setJson('{"x":1}', ["y"], 2)).toBe('{"x":1, "y": 2}');
    expect(JSON.parse(setJson('{\n  "a": {}\n}', ["a", "k"], "v"))).toEqual({ a: { k: "v" } });
  });

  it("replaces an existing value in place and refuses to descend through a non-object", () => {
    expect(setJson('{ "a": { "b": 1 }, "z": 0 }', ["a", "b"], 2)).toBe('{ "a": { "b": 2 }, "z": 0 }');
    expect(() => setJson('{ "a": 1 }', ["a", "b"], 2)).toThrow(/not an object/);
  });

  it("removes members with the right comma handling", () => {
    expect(removeJson('{ "a": 1, "b": 2 }', ["a"])).toBe('{  "b": 2 }');
    expect(JSON.parse(removeJson('{ "a": 1, "b": 2 }', ["b"]))).toEqual({ a: 1 });
    expect(removeJson('{\n  "a": 1, // note\n  "b": 2\n}\n', ["a"])).toBe('{\n  "b": 2\n}\n');
    expect(removeJson('{\n  "a": 1,\n  "b": 2,\n}\n', ["b"])).toBe('{\n  "a": 1,\n}\n');
    expect(removeJson('{ "a": 1 }', ["missing"])).toBe('{ "a": 1 }');
  });

  it("keeps CRLF files valid", () => {
    const text = '{\r\n  "a": {\r\n    "b": 1\r\n  }\r\n}\r\n';
    expect(JSON.parse(setJson(text, ["a", "c"], 2))).toEqual({ a: { b: 1, c: 2 } });
    expect(JSON.parse(removeJson(text, ["a", "b"]))).toEqual({ a: {} });
  });
});

describe("toml-edit", () => {
  it("finds headers with quoted and dotted keys while skipping strings and arrays", () => {
    const text = ['["a.b"."c d"]', "x = 1", "[[list]]", 'v = """', "[not.a.header]", '"""', "nested = [", "  [1],", "]", "[plain]"].join("\n");
    expect(scanToml(text).headers.map((header) => [header.path.join("|"), header.isArray])).toEqual([
      ["a.b|c d", false], ["list", true], ["plain", false],
    ]);
  });

  it("edits keys in place, inserts missing ones after the last statement, and removes keys", () => {
    const text = "[t]\n# c\na = 1\nb = [\n  1,\n]\n\n[u]\nz = 1\n";
    const edited = editTableKeys(text, 0, [{ key: "a", raw: "2" }, { key: "b", raw: "[3]" }, { key: "n", raw: '"new"' }, { key: "gone", remove: true }]);
    expect(edited).toBe('[t]\n# c\na = 2\nb = [3]\nn = "new"\n\n[u]\nz = 1\n');
    expect(editTableKeys("[t]\na = 1\n", 0, [{ key: "a", remove: true }])).toBe("[t]\n");
  });

  it("appends and removes blocks while keeping CRLF line endings", () => {
    const base = "[a]\r\nx = 1\r\n";
    const withBlock = appendBlock(base, "[b]\nk = 1");
    expect(withBlock).toBe("[a]\r\nx = 1\r\n\r\n[b]\r\nk = 1\r\n");
    expect(removeBlock(withBlock, 1)).toBe(base);
    expect(appendBlock("", "[b]\nk = 1")).toBe("[b]\nk = 1\n");
    expect(appendBlock("x = 1", "[b]")).toBe("x = 1\n\n[b]\n");
  });

  it("writes strings that a TOML parser reads back unchanged", () => {
    for (const value of ['C:\\Program Files\\node.exe', 'quote"d', "tab\there", "unicode é 日本", "\u007f"]) {
      expect(parseToml(`k = ${tomlString(value)}`)).toEqual({ k: value });
    }
  });
});
