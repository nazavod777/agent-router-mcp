import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Behavior of the settings page script (src/settings-ui/app.html). Like settings-ui.test.ts, every test extracts the real
 * top-level functions by name and runs them with injected stand-ins for the DOM, the network and the rest of the page.
 */
const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");
const design = readFileSync(new URL("../../DESIGN.md", import.meta.url), "utf8");

function functionSource(name: string): string {
  const match = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m").exec(html);
  expect(match, `function ${name} must exist in app.html`).not.toBeNull();
  return match![0];
}

/** One-line top-level `const NAME = ...;` declaration. */
function constSource(name: string): string {
  const match = new RegExp(`^const ${name} = .*;$`, "m").exec(html);
  expect(match, `const ${name} must exist in app.html`).not.toBeNull();
  return match![0];
}

const PRELUDE = [constSource("clone"), constSource("same")].join("\n");

function load<T>(names: string[], deps: Record<string, unknown> = {}, prelude = PRELUDE, ret = names.join(", ")): T {
  const keys = Object.keys(deps);
  return new Function(...keys, `${prelude}\n${names.map(functionSource).join("\n")}\nreturn { ${ret} };`)(...keys.map((key) => deps[key])) as T;
}

const t = (text: string, ...values: unknown[]) => text.replace(/\{(\d+)\}/g, (_m, index) => String(values[Number(index)]));

class FakeNode {
  attrs = new Map<string, string>();
  classes = new Set<string>();
  children: FakeNode[] = [];
  handlers: Record<string, (event?: unknown) => unknown> = {};
  disabled = false;
  text = "";
  constructor(public tag: string, props: Record<string, any>) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === false || value === undefined) continue;
      if (key.startsWith("on") && typeof value === "function") this.handlers[key] = value;
      else if (key === "class") String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classes.add(name));
      else if (key === "text") this.text = String(value);
      else if (key === "disabled") this.disabled = Boolean(value);
      else this.attrs.set(key, String(value));
    }
  }
  descendants(): FakeNode[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  find(predicate: (node: FakeNode) => boolean): FakeNode | undefined { return this.descendants().find(predicate); }
  allText(): string { return [this.text, ...this.children.map((child) => child.allText())].join(" ").replace(/\s+/g, " ").trim(); }
}

function fakeH(tag: string, props: Record<string, any> | null, ...children: unknown[]): FakeNode {
  const node = new FakeNode(tag, props ?? {});
  const add = (child: unknown): void => {
    if (Array.isArray(child)) child.forEach(add);
    else if (child instanceof FakeNode) node.children.push(child);
    else if (typeof child === "string") node.text += child;
  };
  children.forEach(add);
  return node;
}

class FakeApiError extends Error {
  constructor(public status: number, message: string, public data?: unknown) { super(message); }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// A. Limits conflicts survive Discovery refreshes
// ---------------------------------------------------------------------------
describe("Limits conflicts across Discovery and import", () => {
  const FLOW_FUNCTIONS = ["isDiscoveryDrawer", "abortDiscoveryScan", "detachDrawer", "reconcileSelection", "isActionableCandidate", "discoveryImportFailure",
    "diff", "rebaseObject", "rebaseLimitsDraft", "activeLimitsConflicts", "toastLimitsConflicts", "runDiscovery", "commitDiscoveryImport"];
  const FLOW_PRELUDE = `${PRELUDE}\n${constSource("MAX_IMPORT_SELECTION")}\n${constSource("ALL_HARNESSES")}`;
  const candidate = (key: string) => ({ key, action: "import", status: "new", proposed_id: key, discovered: { cli_model: key } });
  const preview = (revision: string, keys: string[]) => ({ preview_id: "p1", revision, candidates: keys.map(candidate), harnesses: [] });
  const disk = (maxConcurrency: number, queue = 10) => ({ revision: "r2", defaults: { max_concurrency: maxConcurrency, max_queue_size: queue } });

  function flow(responses: Array<unknown | Error>, draft: Record<string, number> = { max_concurrency: 4000, max_queue_size: 10 }) {
    const calls: Array<{ path: string; body: any }> = [];
    const toasts: Array<{ kind: string; text: string }> = [];
    const discovery: any = {
      harness: "claude", mode: "on_demand", preview: null, scanned: null, scanning: false, scanSeq: 0, controller: null, saving: false, locked: null,
      selected: new Set<string>(), query: "", status: "all", provider: "", banner: null, error: "",
    };
    const state: any = {
      busy: false, drawer: { kind: "discover", discovery }, drawerReturn: { from: "models" },
      snap: { revision: "r1", defaults: { max_concurrency: 3000, max_queue_size: 10 } },
      limitsOriginal: { max_concurrency: 3000, max_queue_size: 10 }, limitsDraft: { ...draft }, limitsConflicts: [],
    };
    const queue = [...responses];
    const api = async (_method: string, path: string, body: any) => {
      calls.push({ path, body });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    const page = load<any>(FLOW_FUNCTIONS, {
      state, api, t, countLabel: (count: number, noun: string) => (count === 1 ? noun : `${noun}s`), render: () => undefined,
      toast: (kind: string, get: () => string) => toasts.push({ kind, text: get() }), normalizeFilters: () => undefined, syncUrl: () => undefined,
      restoreDrawerReturn: () => undefined, document: { body: { setAttribute: () => undefined, removeAttribute: () => undefined } },
    }, FLOW_PRELUDE);
    return { ...page, state, discovery, calls, toasts };
  }

  it("keeps the user's 4000 and records the conflict when a Discovery scan hits a 409 with 5000 on disk", async () => {
    const f = flow([new FakeApiError(409, "conflict", { snapshot: disk(5000) }), preview("r2", ["a"])]);
    await f.runDiscovery();
    await tick();
    expect(f.state.limitsDraft.max_concurrency).toBe(4000);
    expect(f.state.limitsOriginal.max_concurrency).toBe(5000);
    expect(f.state.limitsConflicts).toEqual(["max_concurrency"]);
    expect(f.activeLimitsConflicts()).toEqual(["max_concurrency"]);
    expect(f.toasts.find((entry) => entry.kind === "warn")?.text).toContain("max_concurrency");
    expect(f.discovery.preview.revision).toBe("r2");
  });

  it("records the conflict when an import conflicts (409) and when it succeeds (200) on a changed snapshot", async () => {
    const conflicted = flow([new FakeApiError(409, "conflict", { snapshot: disk(5000) })]);
    Object.assign(conflicted.discovery, { preview: preview("r1", ["a"]), selected: new Set(["a"]) });
    await conflicted.commitDiscoveryImport();
    expect(conflicted.state.limitsDraft.max_concurrency).toBe(4000);
    expect(conflicted.state.limitsConflicts).toEqual(["max_concurrency"]);
    expect(conflicted.discovery.locked).toBe("conflict");

    const imported = flow([{ snapshot: disk(5000), imported: ["a"], enabled: [] }]);
    Object.assign(imported.discovery, { preview: preview("r1", ["a"]), selected: new Set(["a"]) });
    await imported.commitDiscoveryImport();
    expect(imported.state.limitsDraft.max_concurrency).toBe(4000);
    expect(imported.state.limitsConflicts).toEqual(["max_concurrency"]);
    expect(imported.toasts.some((entry) => entry.kind === "warn")).toBe(true);
  });

  it("takes a disk-only change silently, and drops a conflict once the draft matches the disk value", async () => {
    const f = flow([new FakeApiError(409, "conflict", { snapshot: disk(3000, 99) }), preview("r2", ["a"])]);
    await f.runDiscovery();
    await tick();
    // max_queue_size changed only on disk: the draft follows it. max_concurrency is the user's own edit and the disk still has the old value.
    expect(f.state.limitsDraft).toEqual({ max_concurrency: 4000, max_queue_size: 99 });
    expect(f.state.limitsConflicts).toEqual([]);

    const g = flow([new FakeApiError(409, "conflict", { snapshot: disk(5000) }), preview("r2", ["a"])]);
    await g.runDiscovery();
    await tick();
    g.state.limitsDraft.max_concurrency = 5000;
    expect(g.activeLimitsConflicts()).toEqual([]);
  });

  it("keeps a recorded conflict through a later snapshot that does not touch it", () => {
    const f = flow([]);
    f.state.snap = { revision: "r2", defaults: { max_concurrency: 5000, max_queue_size: 10 } };
    f.rebaseLimitsDraft();
    f.state.snap = { revision: "r3", defaults: { max_concurrency: 5000, max_queue_size: 11 } };
    f.rebaseLimitsDraft();
    expect(f.state.limitsConflicts).toEqual(["max_concurrency"]);
    expect(f.state.limitsDraft).toEqual({ max_concurrency: 4000, max_queue_size: 11 });
  });

  it("makes the user choose: Save is refused while a conflict is open, Keep mine and Reload from disk resolve it", async () => {
    const mutations: unknown[][] = [];
    const toasts: string[] = [];
    const focused: string[] = [];
    const state: any = {
      busy: false, tab: "limits", snap: { defaults: { max_concurrency: 5000 } }, limitsDraft: { max_concurrency: 4000 }, limitsOriginal: { max_concurrency: 5000 },
      limitsConflicts: ["max_concurrency"],
    };
    const renders: number[] = [];
    const page = load<any>(["activeLimitsConflicts", "clearLimitsDraft", "keepLimitsValues", "reloadLimitsFromDisk", "saveLimits"], {
      state, t, render: () => renders.push(1), toast: (_kind: string, get: () => string) => toasts.push(get()),
      focusByKey: (key: string) => focused.push(key), limitsChanges: () => ({ max_concurrency: 4000 }), blockingLimitsErrors: () => ({}),
      mutate: async (...args: unknown[]) => { mutations.push(args); return true; }, limitsDirty: () => false,
      document: { activeElement: {}, body: {}, querySelector: () => null }, LIMIT_SPECS: [{ key: "max_concurrency" }],
    });
    await page.saveLimits();
    expect(mutations).toEqual([]);
    expect(toasts).toEqual(["Resolve the limit conflicts first: keep your values or reload them from disk."]);
    expect(focused).toEqual(["limits-keep"]);

    page.keepLimitsValues();
    expect(state.limitsDraft.max_concurrency).toBe(4000);
    expect(state.limitsConflicts).toEqual([]);
    await page.saveLimits();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].slice(0, 3)).toEqual(["PUT", "/api/defaults", { patch: { max_concurrency: 4000 } }]);

    // A successful save clears the draft; start a new edit that conflicts again.
    state.limitsDraft = { max_concurrency: 4000 };
    state.limitsConflicts = ["max_concurrency"];
    page.reloadLimitsFromDisk();
    expect(state.limitsDraft.max_concurrency).toBe(5000);
    expect(state.limitsConflicts).toEqual([]);
    expect(page.activeLimitsConflicts()).toEqual([]);
  });

  it("renders a banner listing yours and the disk value with both choices, and nothing without a conflict", () => {
    const state: any = { busy: false, snap: { defaults: { max_concurrency: 5000 } }, limitsDraft: { max_concurrency: 4000 }, limitsConflicts: ["max_concurrency"] };
    const page = load<any>(["activeLimitsConflicts", "limitsConflictBanner"], {
      state, t, h: fakeH, formatValue: (value: unknown) => String(value),
      banner: (kind: string, text: string, ...extra: FakeNode[]) => fakeH("div", { class: `banner ${kind}` }, fakeH("div", { text }), ...extra),
      button: (label: string, props: Record<string, any>) => fakeH("button", { ...props, text: label, class: props.cls }),
      keepLimitsValues: () => undefined, reloadLimitsFromDisk: () => undefined,
    });
    const node = page.limitsConflictBanner() as FakeNode;
    expect(node.allText()).toContain("max_concurrency: yours 4000, on disk 5000");
    expect(node.find((child) => child.attrs.get("data-fk") === "limits-keep")?.allText()).toBe("Keep my values");
    expect(node.find((child) => child.attrs.get("data-fk") === "limits-reload")?.allText()).toBe("Reload from disk");
    state.limitsConflicts = [];
    expect(page.limitsConflictBanner()).toBeNull();
  });

  it("clears the recorded conflicts together with the draft, and every adopted snapshot still goes through the rebase", () => {
    const state: any = { limitsDraft: { a: 1 }, limitsOriginal: { a: 0 }, limitsConflicts: ["a"] };
    load<any>(["clearLimitsDraft"], { state }).clearLimitsDraft();
    expect(state).toEqual({ limitsDraft: null, limitsOriginal: null, limitsConflicts: [] });
    for (const name of ["discardLimits", "saveLimits", "resetAll", "renderLimits"]) {
      expect(functionSource(name), name).not.toMatch(/state\.limitsDraft = null/);
    }
  });
});

// ---------------------------------------------------------------------------
// B. Quarantine reset
// ---------------------------------------------------------------------------
describe("Quarantine reset", () => {
  const banner = (_kind: string, text: string, ...extra: FakeNode[]) => fakeH("div", { text }, ...extra);

  it("offers a Reset button per quarantined entry", () => {
    const state: any = { busy: false, snap: { quarantined: [{ section: "models", id: "orphan", reason: "bad" }, { section: "presets", id: "x", reason: "worse" }] } };
    const { quarantineBanner } = load<any>(["quarantineBanner"], { state, t, banner, h: fakeH });
    const items = (quarantineBanner() as FakeNode).descendants().filter((node) => node.tag === "li");
    expect(items).toHaveLength(2);
    const buttons = items.map((item) => item.find((node) => node.tag === "button")!);
    expect(buttons.map((node) => node.attrs.get("aria-label"))).toEqual(["Reset invalid entry models.orphan", "Reset invalid entry presets.x"]);
    expect(buttons.every((node) => node.allText() === "Reset" && !node.disabled)).toBe(true);
    state.busy = true;
    const busy = (quarantineBanner() as FakeNode).find((node) => node.tag === "button")!;
    expect(busy.disabled).toBe(true);
  });

  it("confirms, then posts the section and ID in the JSON body (never in the URL)", async () => {
    const mutations: unknown[][] = [];
    const confirms: any[] = [];
    let answer = true;
    const { resetQuarantined } = load<any>(["resetQuarantined"], {
      t, confirmDialog: async (options: unknown) => { confirms.push(options); return answer; },
      mutate: async (...args: unknown[]) => { mutations.push(args); return true; },
    });
    await resetQuarantined("harnesses", "my/odd:id");
    expect(confirms[0]).toMatchObject({ danger: true, confirmLabel: "Reset", title: "Reset the invalid entry “harnesses.my/odd:id”?" });
    expect(mutations).toHaveLength(1);
    expect(mutations[0].slice(0, 3)).toEqual(["POST", "/api/quarantined/reset", { section: "harnesses", id: "my/odd:id" }]);
    expect(((mutations[0][3] as () => string)())).toBe("Invalid entry harnesses.my/odd:id was reset.");
    answer = false;
    await resetQuarantined("models", "x");
    expect(mutations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// C. Discovery import lock
// ---------------------------------------------------------------------------
describe("Discovery import lock", () => {
  const FLOW_FUNCTIONS = ["isDiscoveryDrawer", "abortDiscoveryScan", "detachDrawer", "reconcileSelection", "isActionableCandidate", "discoveryImportFailure",
    "runDiscovery", "commitDiscoveryImport"];
  const prelude = `${constSource("MAX_IMPORT_SELECTION")}\n${constSource("ALL_HARNESSES")}`;
  const candidate = (key: string) => ({ key, action: "import", status: "new", proposed_id: key, discovered: { cli_model: key } });
  const preview = (keys: string[]) => ({ preview_id: "p1", revision: "r1", candidates: keys.map(candidate), harnesses: [] });

  function flow(responses: Array<unknown | Error>) {
    const discovery: any = {
      harness: "claude", mode: "on_demand", preview: preview(["a"]), scanned: { harness: "claude", mode: "on_demand" }, scanning: false, scanSeq: 0,
      controller: null, saving: false, locked: null, selected: new Set(["a"]), query: "", status: "all", provider: "", banner: null, error: "",
    };
    const state: any = { busy: false, snap: { revision: "r1" }, drawer: { kind: "discover", discovery }, drawerReturn: null };
    const queue = [...responses];
    const api = async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    const page = load<any>(FLOW_FUNCTIONS, {
      state, api, t, countLabel: () => "models", render: () => undefined, toast: () => undefined, rebaseLimitsDraft: () => [], normalizeFilters: () => undefined,
      syncUrl: () => undefined, restoreDrawerReturn: () => undefined, document: { body: { setAttribute: () => undefined, removeAttribute: () => undefined } },
    }, prelude);
    return { ...page, state, discovery };
  }

  it("keeps the stale-preview lock and its banner through failed rescans and option changes until a rescan succeeds", async () => {
    const f = flow([
      new FakeApiError(409, "conflict", { snapshot: { revision: "r2" } }),
      new FakeApiError(429, "Model discovery is already running. Wait for it to finish and retry."),
      new FakeApiError(0, "The settings server is unavailable."),
      preview(["a"]),
    ]);
    await f.commitDiscoveryImport();
    expect(f.discovery.locked).toBe("conflict");
    expect(f.discovery.banner).toEqual({ kind: "conflict" });

    await f.runDiscovery({ keepSelection: true });
    expect(f.discovery.error).toBe("Model discovery is already running. Wait for it to finish and retry.");
    expect(f.discovery.locked).toBe("conflict");
    expect(f.discovery.banner).toEqual({ kind: "conflict" });

    f.discovery.harness = "codex";
    f.discovery.mode = "offline";
    await f.runDiscovery({ keepSelection: true });
    expect(f.discovery.locked).toBe("conflict");
    expect(f.discovery.banner).toEqual({ kind: "conflict" });

    await f.runDiscovery({ keepSelection: true });
    expect(f.discovery.locked).toBeNull();
    expect(f.discovery.banner).toBeNull();
    expect(f.discovery.scanned).toEqual({ harness: "codex", mode: "offline" });
  });

  it("locks an expired preview the same way", async () => {
    const f = flow([new FakeApiError(410, "Preview expired; run discovery again."), new FakeApiError(500, "boom"), preview(["a"])]);
    await f.commitDiscoveryImport();
    expect(f.discovery.locked).toBe("expired");
    await f.runDiscovery();
    expect(f.discovery.locked).toBe("expired");
    expect(f.discovery.banner).toEqual({ kind: "expired" });
    await f.runDiscovery();
    expect(f.discovery.locked).toBeNull();
  });

  it("disables Import while the lock is set, even when the banner is gone", () => {
    const nodes: Record<string, any> = {
      "discover-summary": { textContent: "", classList: { toggle: () => undefined } },
      "discover-limit": { hidden: false },
      "discover-import": { disabled: false, replaceChildren: () => undefined },
      drawer: { querySelectorAll: () => [] },
    };
    const { syncDiscoveryUi } = load<any>(["selectionSummary", "syncDiscoveryUi"], { $: (id: string) => nodes[id] ?? null, h: fakeH, t, MAX_IMPORT_SELECTION: 50 }, "");
    const d = { preview: preview(["a"]), selected: new Set(["a"]), saving: false, scanning: false, banner: null as unknown, locked: null as unknown };
    syncDiscoveryUi(d);
    expect(nodes["discover-import"].disabled).toBe(false);
    d.locked = "expired";
    syncDiscoveryUi(d);
    expect(nodes["discover-import"].disabled).toBe(true);
    d.locked = null;
    d.banner = { kind: "conflict" };
    syncDiscoveryUi(d);
    expect(nodes["discover-import"].disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. List-field reset clears pending editor text
// ---------------------------------------------------------------------------
describe("Field reset and pending editor text", () => {
  it("drops the text typed into a sentence list editor (<fk>-new) as well as a chip editor (<fk>) for the reset field only", () => {
    const state: any = { drawer: null, snap: null };
    const prelude = `${PRELUDE}\nconst META_KEYS = new Set(["provenance", "field_provenance", "default_changed", "is_stale", "_base_hash", "custom"]);\nconst SECTION_OF = { model: "models", harness: "harnesses", preset: "presets" };`;
    const { applyFieldReset } = load<any>(["strip", "diff", "rebaseObject", "rebaseRoles", "rebaseEntityDraft", "applyFieldReset"], { state, render: () => undefined, closeDrawer: () => undefined }, prelude);
    state.snap = { models: { x: { strengths: ["fresh"], efforts: ["low"], best_for: [] } } };
    const pending = (text: string) => ({ text, commit: () => true });
    const drawer = {
      kind: "model", id: "x", isNew: false, conflicts: [], original: { strengths: ["old"], efforts: ["low"], best_for: [] },
      draft: { strengths: ["old", "mine"], efforts: ["low"], best_for: [] },
      pending: { "m-strengths-new": pending("typed sentence"), "m-strengths": pending("typed"), "m-best_for-new": pending("other field"), "m-efforts": pending("high") },
    };
    state.drawer = drawer;
    applyFieldReset(drawer, "strengths");
    expect(Object.keys(drawer.pending).sort()).toEqual(["m-best_for-new", "m-efforts"]);
  });
});

// ---------------------------------------------------------------------------
// E. Harness filter with a harness literally named "all"
// ---------------------------------------------------------------------------
describe("Models harness filter scope", () => {
  const prelude = `${constSource("ALL_HARNESSES")}\n${constSource("MAX_QUERY_LENGTH")}\nconst TAB_IDS = ["models", "harnesses", "presets", "limits"];\nconst TIERS = ["deep", "standard", "light", "specialist"];\nconst STATUS_FILTER_IDS = ["all", "enabled", "disabled", "modified", "stale"];`;

  it("uses the empty string for 'every harness', so a custom harness named all is a real filter", () => {
    expect(html).toMatch(/harnessFilter: "",/);
    const state: any = { snap: { harnesses: { all: {}, claude: {} }, presets: {} }, harnessFilter: "all", tab: "models", query: "", tierFilter: "all", statusFilter: "all", presetSelected: "" };
    const page = load<any>(["normalizeFilters", "urlForState", "modelMatches", "filtersActive"], {
      state, location: { pathname: "/" }, defaultPresetId: () => "balanced",
    }, prelude);
    page.normalizeFilters();
    expect(state.harnessFilter).toBe("all");
    expect(page.urlForState()).toBe("/?harness=all");
    expect(page.modelMatches("m1", { harness: "all", tier: "deep", enabled: true })).toBe(true);
    expect(page.modelMatches("m2", { harness: "claude", tier: "deep", enabled: true })).toBe(false);
    expect(page.filtersActive()).toBe(true);
    state.harnessFilter = "";
    expect(page.urlForState()).toBe("/");
    expect(page.modelMatches("m2", { harness: "claude", tier: "deep", enabled: true })).toBe(true);
    expect(page.filtersActive()).toBe(false);
  });

  it("reads an old ?harness=all link as every harness when no harness is named all, and as that harness when one is", () => {
    const run = (harnesses: Record<string, unknown>) => {
      const state: any = { snap: { harnesses, presets: {} }, harnessFilter: "", tab: "models", tierFilter: "all", statusFilter: "all", query: "", presetSelected: "" };
      const page = load<any>(["readUrl", "normalizeFilters"], { state, location: { search: "?harness=all" }, URLSearchParams }, prelude);
      page.readUrl();
      expect(state.harnessFilter).toBe("all");
      page.normalizeFilters();
      return state.harnessFilter;
    };
    expect(run({ claude: {} })).toBe("");
    expect(run({ claude: {}, all: {} })).toBe("all");
  });

  it("keeps a harness facet from colliding with the all-harnesses facet key", () => {
    expect(functionSource("renderFacets")).toContain('"facet--all"');
    expect(functionSource("clearModelFilters")).toContain("state.harnessFilter = ALL_HARNESSES");
  });
});

// ---------------------------------------------------------------------------
// F. Names that match Object.prototype members
// ---------------------------------------------------------------------------
describe("Object.prototype-named entities", () => {
  it("never resolves ?preset=toString or ?harness=toString to a prototype member", () => {
    const state: any = {
      snap: { harnesses: { claude: {} }, presets: { balanced: {}, fast: {} } }, harnessFilter: "toString", presetSelected: "toString",
    };
    const page = load<any>(["normalizeFilters", "selectedPresetId", "defaultPresetId"], { state }, `${constSource("ALL_HARNESSES")}\n${constSource("DEFAULT_PRESET")}`);
    page.normalizeFilters();
    expect(state.harnessFilter).toBe("");
    expect(state.presetSelected).toBe("");
    state.presetSelected = "valueOf";
    expect(page.selectedPresetId()).toBe("balanced");
  });

  it("looks entities up by own property only", () => {
    const { entry } = load<any>(["entry"]);
    const map = { real: { a: 1 } };
    expect(entry(map, "real")).toEqual({ a: 1 });
    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]) expect(entry(map, name), name).toBeUndefined();
    expect(entry(Object.assign(Object.create(null), { toString: 1 }), "toString")).toBe(1);
    expect(entry(undefined, "x")).toBeUndefined();
  });

  it("reports a role pointing at a model or harness named toString as missing, and treats a role named toString as an ordinary role", () => {
    const state: any = { snap: { harnesses: { claude: { enabled: true } }, models: { m: { enabled: true, harness: "claude", efforts: ["low"] } } } };
    const { roleIssues, entry } = load<any>(["entry", "roleIssues"], { state, t });
    expect(entry).toBeTypeOf("function");
    expect(roleIssues({ harness: "toString", model: "toString", effort: "low" }).map(([, text]: [string, string]) => text)).toEqual(["Missing harness", "Missing model"]);
    expect(roleIssues({ harness: "claude", model: "m", effort: "low" })).toEqual([]);

    const { rebaseRoles } = load<any>(["rebaseRoles"]);
    const mine = { harness: "claude", model: "m", effort: "low" };
    const result = rebaseRoles({}, { toString: mine }, { other: mine });
    expect(result.merged).toEqual({ other: mine, toString: mine });
    expect(result.conflicts).toEqual([]);
    expect(rebaseRoles({ toString: mine }, {}, { toString: mine }).merged).toEqual({});
  });

  it("treats a stored entity named toString as present, and a missing one as gone", () => {
    const state: any = { snap: { models: { toString: {} } }, drawer: { kind: "model", id: "toString", isNew: false } };
    const { drawerEntityIsGone } = load<any>(["isDiscoveryDrawer", "drawerEntityIsGone"], { state, SECTION_OF: { model: "models" } }, "");
    expect(drawerEntityIsGone()).toBe(false);
    state.drawer.id = "valueOf";
    expect(drawerEntityIsGone()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// G. Models form: provider/model validation, no harness yet
// ---------------------------------------------------------------------------
describe("Model form route validation", () => {
  const driverMeta = { opencode: { requiresProviderPrefix: true, usesCliProvider: true }, claude: {} };
  const state = () => ({ driverMeta, snap: { harnesses: { oc: { driver: "opencode" }, claude: { driver: "claude" } } } });
  const draftOf = (extra: Record<string, unknown>, harness = "oc") => ({ isNew: true, newId: "gpt-5", id: null, original: {}, draft: { harness, ...extra } });

  it("flags a missing provider and a malformed provider/model, in the live hint and before Save", () => {
    const page = load<any>(["driverMetaOf", "modelHints", "modelRouteProblem"], { state: state(), t });
    const missing = "OpenCode expects provider/model — set CLI provider or include '/' in CLI model.";
    const malformed = "CLI model must look like provider/model, with text on both sides of “/”.";
    expect(page.modelHints(draftOf({}))["provider-prefix"]).toBe(missing);
    expect(page.modelHints(draftOf({ cli_model: "openai/" }))["provider-prefix"]).toBe(malformed);
    expect(page.modelHints(draftOf({ cli_model: "/gpt-5" }))["provider-prefix"]).toBe(malformed);
    expect(page.modelHints(draftOf({ cli_model: "openrouter/anthropic/claude" }))["provider-prefix"]).toBe("");
    expect(page.modelHints(draftOf({ cli_provider: "openai", cli_model: "/x" }))["provider-prefix"]).toBe("");
    expect(page.modelHints(draftOf({}, "claude"))["provider-prefix"]).toBe("");

    expect(page.modelRouteProblem(draftOf({}), { harness: "oc" })).toBe(missing);
    expect(page.modelRouteProblem(draftOf({ cli_model: "openai/gpt-5" }), { harness: "oc", cli_model: "openai/gpt-5" })).toBeNull();
    expect(page.modelRouteProblem(draftOf({}, "claude"), { harness: "claude" })).toBeNull();
  });

  it("does not block an unrelated edit of a stored card, but does once its route changes", () => {
    const page = load<any>(["driverMetaOf", "modelHints", "modelRouteProblem"], { state: state(), t });
    const stored = { isNew: false, id: "legacy", newId: "", original: { harness: "oc", display_name: "A" }, draft: { harness: "oc", display_name: "B" } };
    expect(page.modelRouteProblem(stored, { harness: "oc", display_name: "B" })).toBeNull();
    const changed = { ...stored, draft: { harness: "oc", display_name: "B", cli_model: "gpt-5" } };
    expect(page.modelRouteProblem(changed, { harness: "oc", display_name: "B", cli_model: "gpt-5" })).toContain("provider/model");
  });

  it("refuses to save a route the driver cannot use", () => {
    expect(functionSource("saveModel")).toContain("modelDraftProblem(draft) || modelRouteProblem(drawer, draft)");
    expect(functionSource("newIdField")).toContain("refreshModelHints()");
  });

  it("sends the user to create a harness when none exists, instead of opening a model form with a dead dropdown", () => {
    const calls: unknown[][] = [];
    const state: any = { snap: { harnesses: {} } };
    const page = load<any>(["harnessIds", "addModel"], {
      state, t, toast: (...args: unknown[]) => calls.push(["toast", args[0]]), navigate: (tab: string) => calls.push(["navigate", tab]),
      openDrawer: (...args: unknown[]) => calls.push(["openDrawer", ...args]),
    });
    page.addModel();
    expect(calls).toEqual([["toast", "info"], ["navigate", "harnesses"], ["openDrawer", "harness", null]]);
    calls.length = 0;
    state.snap.harnesses = { claude: {} };
    page.addModel();
    expect(calls).toEqual([["openDrawer", "model", null]]);
  });

  it("shows the harness-first empty state on the Models page", () => {
    const state: any = { snap: { harnesses: {} } };
    const page = load<any>(["harnessIds", "modelResults"], {
      state, t, button: (label: string, props: Record<string, any>) => fakeH("button", { ...props, text: label }),
      emptyState: ({ title, text, actions }: any) => fakeH("div", { text: `${title} ${text}` }, ...actions), addModel: () => undefined, navigate: () => undefined,
      openDrawer: () => undefined, clearModelFilters: () => undefined,
    });
    const node = page.modelResults([], []) as FakeNode;
    expect(node.allText()).toContain("Add a harness first");
    expect(node.find((child) => child.attrs.get("data-fk") === "add-harness-first")?.allText()).toBe("Add harness");
  });
});

// ---------------------------------------------------------------------------
// H. Codex write mode
// ---------------------------------------------------------------------------
describe("Write mode of a driver that ignores it", () => {
  it("shows a saved value as ignored, with Clear, instead of 'Passed directly to ...'", () => {
    const state: any = { driverMeta: { codex: { label: "Codex CLI" }, claude: { label: "Claude Code", writePermissionModes: ["acceptEdits", "auto"] } } };
    const page = load<any>(["writePermissionModes", "driverGatedField", "writePermissionField"], {
      h: fakeH, t, state, textInput: (value: string) => fakeH("input", { value }), setDraft: () => undefined,
      clearButton: (key: string) => fakeH("button", { "data-fk": `clear-${key}` }), selectBox: (_options: unknown, value: string) => fakeH("select", { value }),
    }, "");
    const props = (_key: string, _label: string, control: FakeNode) => control;
    expect(page.writePermissionField(props, { driver: "codex" })).toBeNull();
    const saved = page.writePermissionField(props, { driver: "codex", write_permission_mode: "danger-full-access" }) as FakeNode;
    expect(saved.allText()).toContain("Ignored by this driver");
    expect(saved.allText()).not.toContain("Passed directly");
    expect(saved.find((node) => node.attrs.get("data-fk") === "clear-write_permission_mode")).toBeDefined();
    expect(page.writePermissionField(props, { driver: "codex" }, { keep: true })).not.toBeNull();
    const supported = page.writePermissionField((_k: string, _l: string, control: FakeNode) => control, { driver: "claude", write_permission_mode: "auto" }) as FakeNode;
    expect(supported.allText()).not.toContain("Ignored by this driver");
  });
});

// ---------------------------------------------------------------------------
// I. Offline recovery and a restartable heartbeat
// ---------------------------------------------------------------------------
describe("Connection recovery", () => {
  function harness() {
    const state: any = { csrf: "tok", offline: false };
    const events: string[] = [];
    const timers: Array<{ delay: number; run: () => unknown }> = [];
    const responses: Array<Error | { ok: boolean; status?: number; body?: unknown }> = [];
    const fetchStub = async () => {
      const next = responses.shift()!;
      if (next instanceof Error) throw next;
      return { ok: next.ok, status: next.status ?? 200, json: async () => next.body ?? {} };
    };
    const prelude = `${constSource("HEARTBEAT_MS")}\n${constSource("RECONNECT_MS")}\n${html.match(/^class ApiError[\s\S]*?^\}/m)![0]}\nlet heartbeatTimer = 0;`;
    const page = load<any>(["api", "recoverConnection", "scheduleHeartbeat", "setOffline"], {
      state, fetch: fetchStub, t, render: () => events.push("render"), toast: (kind: string) => events.push(`toast:${kind}`),
      setTimeout: (run: () => unknown, delay: number) => { timers.push({ delay, run }); return timers.length; }, clearTimeout: () => undefined,
    }, prelude);
    return { state, events, timers, responses, ...page };
  }

  it("clears the offline state, restarts the heartbeat at its normal pace and says so after the first authorized answer", async () => {
    const h = harness();
    h.responses.push(new TypeError("network down"));
    await expect(h.api("GET", "/api/state")).rejects.toMatchObject({ status: 0 });
    expect(h.state.offline).toBe(true);
    h.events.length = 0;
    h.responses.push({ ok: true, body: { ok: true } });
    await h.api("POST", "/api/heartbeat", {});
    expect(h.state.offline).toBe(false);
    expect(h.events).toEqual(["render", "toast:ok"]);
    expect(h.timers.at(-1)!.delay).toBe(60_000);
  });

  it("does not treat an unauthorized or failed answer as recovery", async () => {
    const h = harness();
    h.state.offline = true;
    h.responses.push({ ok: false, status: 401, body: { error: "Unauthorized." } });
    await expect(h.api("GET", "/api/state")).rejects.toMatchObject({ status: 401 });
    expect(h.state.offline).toBe(true);
  });

  it("keeps probing while offline (faster) and never stops after a failed beat", async () => {
    const h = harness();
    h.state.offline = true;
    h.scheduleHeartbeat();
    expect(h.timers.at(-1)!.delay).toBe(10_000);
    h.responses.push(new TypeError("still down"));
    await h.timers.at(-1)!.run();
    expect(h.timers).toHaveLength(2);
    expect(h.timers.at(-1)!.delay).toBe(10_000);
    h.responses.push({ ok: true });
    await h.timers.at(-1)!.run();
    expect(h.state.offline).toBe(false);
    expect(h.timers.at(-1)!.delay).toBe(60_000);
  });

  it("sends the CSRF header on every request and no longer needs a one-shot interval", () => {
    expect(functionSource("api")).toContain('"X-Orch-Token": state.csrf');
    expect(functionSource("bindChrome")).toContain("scheduleHeartbeat()");
    expect(functionSource("bindChrome")).not.toContain("setInterval");
  });
});

// ---------------------------------------------------------------------------
// J. Readiness with unverified sign-in
// ---------------------------------------------------------------------------
describe("Readiness summary", () => {
  const states = (health: Record<string, any>, enabled: string[]) => ({
    snap: { harnesses: Object.fromEntries(enabled.map((id) => [id, { enabled: true }])) }, health,
  });
  const summaryOf = (state: unknown) => load<any>(["entry", "healthOf", "harnessHealthState", "readinessSummary"], { state }).readinessSummary();

  it("is green only when every enabled harness is installed and verified signed in", () => {
    expect(summaryOf(states({ a: { installed: true, auth_status: "ready" }, b: { installed: true, auth_status: "ready" } }, ["a", "b"])))
      .toMatchObject({ ready: 2, unverified: 0, level: "ok" });
  });

  it("never turns green for unknown auth: it counts as unverified and stays a warning", () => {
    expect(summaryOf(states({ a: { installed: true, auth_status: "unknown" } }, ["a"]))).toMatchObject({ ready: 0, unverified: 1, level: "warn" });
    expect(summaryOf(states({ a: { installed: true, auth_status: "ready" }, b: { installed: true, auth_status: "unknown" } }, ["a", "b"])))
      .toMatchObject({ ready: 1, unverified: 1, level: "warn" });
    expect(summaryOf(states({ a: { installed: false }, b: { installed: true, auth_status: "unauthenticated" } }, ["a", "b"]))).toMatchObject({ ready: 0, level: "bad" });
  });

  function renderNote(health: Record<string, any>, enabled: string[]) {
    const state: any = { ...states(health, enabled), healthLoading: false };
    const box: any = { className: "", children: [] as FakeNode[], replaceChildren(...children: FakeNode[]) { this.children = children; } };
    const page = load<any>(["entry", "healthOf", "harnessHealthState", "readinessSummary", "renderReadiness"], {
      state, t, h: fakeH, $: () => box, urlForState: () => "/?tab=harnesses", navigate: () => undefined,
      railLink: (_href: string, _go: unknown, props: Record<string, any>, ...children: unknown[]) => fakeH("a", props, ...children),
    });
    page.renderReadiness();
    return { box, text: box.children.map((node: FakeNode) => node.allText()).join(" ") };
  }

  it("says the sign-in is unverified instead of 'Ready to delegate'", () => {
    const unknown = renderNote({ a: { installed: true, auth_status: "unknown" } }, ["a"]);
    expect(unknown.box.className).toBe("readiness warn");
    expect(unknown.text).toContain("Installed, but sign-in could not be verified");
    expect(unknown.text).not.toContain("Ready to delegate");
    expect(renderNote({ a: { installed: true, auth_status: "ready" } }, ["a"]).text).toContain("Ready to delegate");
  });

  it("updates the open harness drawer's health block in place, without rebuilding the drawer", () => {
    const replaced: unknown[] = [];
    const current = { replaceWith: (node: unknown) => replaced.push(node) };
    const page = load<any>(["refreshDrawerHealth"], {
      state: { drawer: { kind: "harness", id: "claude", isNew: false } }, healthBlock: (id: string) => `block:${id}`,
      document: { querySelector: (selector: string) => (selector === "#drawer [data-health]" ? current : null) },
    });
    page.refreshDrawerHealth();
    expect(replaced).toEqual(["block:claude"]);
    const untouched = load<any>(["refreshDrawerHealth"], {
      state: { drawer: { kind: "model", id: "m", isNew: false } }, healthBlock: () => { throw new Error("must not run"); }, document: { querySelector: () => current },
    });
    untouched.refreshDrawerHealth();
    expect(replaced).toHaveLength(1);
    const render = functionSource("render");
    expect(render).toMatch(/if \(!options\.skipDrawer\) renderDrawer\(\);\n\s*else refreshDrawerHealth\(\);/);
    expect(functionSource("harnessEditor")).toContain("entity ? healthBlock(drawer.id) : null");
  });
});

// ---------------------------------------------------------------------------
// K. Focus stays in the drawer; the skip link goes inert behind modal layers
// ---------------------------------------------------------------------------
describe("Drawer focus and skip link", () => {
  function focusHarness() {
    const doc: any = { activeElement: null };
    const drawerEl: any = { focused: 0, contains: (el: unknown) => el === drawerEl || inside.has(el), focus() { this.focused++; doc.activeElement = drawerEl; } };
    const inside = new Set<unknown>();
    const enabled = new Map<string, any>();
    const state: any = { drawer: {} };
    const page = load<any>(["keepDrawerFocus"], {
      state, $: () => drawerEl, document: doc,
      focusByKey: (key: string) => {
        const el = enabled.get(key);
        if (!el || el.disabled) return false;
        doc.activeElement = el;
        return true;
      },
    }, "");
    return { doc, drawerEl, inside, enabled, state, ...page };
  }

  it("parks focus on the drawer when the focused control disables itself, and gives it back once enabled", () => {
    const f = focusHarness();
    const scan: any = { disabled: true };
    f.enabled.set("d-scan", scan);
    f.doc.activeElement = { isBody: true };
    f.keepDrawerFocus({ key: "d-scan" });
    expect(f.doc.activeElement).toBe(f.drawerEl);
    expect(f.state.drawer.refocusKey).toBe("d-scan");
    // The scan finished: the next render finds focus on the panel and returns it to the control.
    scan.disabled = false;
    f.keepDrawerFocus(null);
    expect(f.doc.activeElement).toBe(scan);
    expect(f.state.drawer.refocusKey).toBeNull();
  });

  it("leaves focus alone when the control inside the drawer was restored", () => {
    const f = focusHarness();
    const input = { disabled: false };
    f.inside.add(input);
    f.doc.activeElement = input;
    f.keepDrawerFocus({ key: "m-name" });
    expect(f.doc.activeElement).toBe(input);
    expect(f.drawerEl.focused).toBe(0);
  });

  it("wires the fallback into render() and focuses the panel inside the Tab trap", () => {
    expect(functionSource("render")).toContain("if (focusWasInDrawer) keepDrawerFocus(focus);");
    expect(html).toMatch(/<aside class="drawer" id="drawer"[^>]*tabindex="-1"/);
    const trap = functionSource("trapDrawerTab");
    expect(trap).toContain("document.activeElement === drawerEl");
  });

  it("makes the skip link inert, aria-hidden and untabbable behind a modal layer, and reachable again afterwards", () => {
    const skipAttrs = new Map<string, string>();
    const skip: any = { inert: false, setAttribute: (k: string, v: string) => skipAttrs.set(k, v), removeAttribute: (k: string) => skipAttrs.delete(k) };
    const shell: any = { inert: false };
    const page = load<any>(["setShellInert", "setSkipLinkInert"], { $: () => shell, document: { querySelector: () => skip } }, "");
    page.setShellInert(true);
    expect(shell.inert).toBe(true);
    expect(skip.inert).toBe(true);
    expect(skipAttrs.get("aria-hidden")).toBe("true");
    expect(skipAttrs.get("tabindex")).toBe("-1");
    page.setShellInert(false);
    expect(skip.inert).toBe(false);
    expect([...skipAttrs.keys()]).toEqual([]);
    expect(functionSource("confirmDialog")).toContain("setShellInert(true)");
    expect(functionSource("syncOverlays")).toContain("setShellInert(Boolean(state.drawer))");
    expect(functionSource("syncOverlays")).toContain("if (railOpen) setSkipLinkInert(true);");
  });
});

// ---------------------------------------------------------------------------
// L. Touch targets
// ---------------------------------------------------------------------------
describe("Coarse-pointer touch targets", () => {
  const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(html)![1];

  it("declares the 44px token and applies it to the toggle, selects, switches and chip remove buttons", () => {
    expect(html).toMatch(/--touch-target: 44px;/);
    for (const selector of [".lang-switch button", ".select-trigger", ".switch", ".chip button", ".btn", ".icon-btn"]) expect(coarse, selector).toContain(selector);
    expect(coarse).toMatch(/min-height: var\(--touch-target\)/);
    expect(coarse).toMatch(/min-width: var\(--touch-target\)/);
    expect(coarse).not.toMatch(/style\s*=|!important/);
  });

  it("raises the fixed-height chip and select rules instead of fighting them", () => {
    // min-height wins over the fixed `height` of the base rules, so these base rules stay valid on fine pointers.
    expect(html).toMatch(/\.lang-switch button \{[^}]*height: 24px/);
    expect(coarse).toMatch(/\.chip \{ height: auto; min-height: var\(--touch-target\); \}/);
  });
});

// ---------------------------------------------------------------------------
// M. Russian translations of server errors
// ---------------------------------------------------------------------------
describe("Server error translations", () => {
  const dictionary = /^const russian = \{[\s\S]*?^\};/m.exec(html)![0];
  const patterns = /^const RUSSIAN_PATTERNS = \[[\s\S]*?^\];/m.exec(html)![0];
  function translator(language: "en" | "ru") {
    return new Function(`let language = ${JSON.stringify(language)};\n${dictionary}\n${patterns}\n${functionSource("russianForPattern")}\n${functionSource("t")}\nreturn t;`)() as
      (english: string, ...values: unknown[]) => string;
  }

  it.each([
    ["Validation failed", "Проверка не пройдена"],
    ["Model discovery is already running. Wait for it to finish and retry.", "Поиск моделей уже выполняется. Дождитесь завершения и повторите."],
    ["Preview expired; run discovery again.", "Предпросмотр устарел — запустите поиск моделей заново."],
    ["Model discovery was cancelled.", "Поиск моделей отменён."],
    ["Unauthorized. Open the URL printed in the terminal.", "Нет доступа. Откройте адрес, который выведен в терминале."],
    ["Forbidden: missing or invalid X-Orch-Token", "Запрещено: заголовок X-Orch-Token отсутствует или неверен."],
    ["Server is shutting down.", "Сервер останавливается."],
    ["Too many concurrent requests.", "Слишком много одновременных запросов."],
    ["Request body exceeds 1048576 bytes", "Тело запроса больше 1048576 байт."],
    ["models.orphan is not quarantined", "models.orphan не отложена как некорректная"],
    ["At most 50 models can be imported per request (got 60).", "За один раз можно импортировать не больше 50 моделей (получено 60)."],
  ])("translates %j for the Russian page and leaves English alone", (english, russian) => {
    expect(translator("ru")(english)).toBe(russian);
    expect(translator("en")(english)).toBe(english);
  });

  it("passes an unknown server message through unchanged", () => {
    expect(translator("ru")("Something nobody translated")).toBe("Something nobody translated");
  });
});

// ---------------------------------------------------------------------------
// N. DESIGN.md
// ---------------------------------------------------------------------------
describe("DESIGN.md references", () => {
  it("names the current command and verification, and documents the 44px coarse-pointer targets", () => {
    expect(design).not.toContain("orchestrate-settings");
    expect(design).not.toContain("ui-lint.sh");
    expect(design).toContain("`agrmcp settings`");
    expect(design).toContain("npm test -- tests/integration/settings-ui.test.ts");
    expect(design).toMatch(/44px/);
    expect(design).toContain("--touch-target");
  });
});

// ---------------------------------------------------------------------------
// Session token hand-off: URL fragment -> sessionStorage, never the served HTML
// ---------------------------------------------------------------------------
describe("Session token hand-off", () => {
  const TOKEN = "ab".repeat(32);

  function pageWith(options: { hash: string; stored?: string; storageThrows?: boolean }) {
    const store = new Map<string, string>(options.stored === undefined ? [] : [["orch_token", options.stored]]);
    const sessionStorage = {
      setItem: (key: string, value: string) => { if (options.storageThrows) throw new Error("denied"); store.set(key, value); },
      getItem: (key: string) => { if (options.storageThrows) throw new Error("denied"); return store.get(key) ?? null; },
    };
    const replaced: unknown[][] = [];
    const location = { hash: options.hash, pathname: "/", search: "?tab=models" };
    const history = { replaceState: (...args: unknown[]) => { replaced.push(args); } };
    const prelude = `${constSource("TOKEN_STORAGE_KEY")}\n${constSource("TOKEN_FRAGMENT")}`;
    const page = load<any>(["acquireToken"], { sessionStorage, location, history }, prelude);
    return { ...page, store, replaced };
  }

  it("stores the token from #t=, clears the fragment at once and keeps the path and query", () => {
    const page = pageWith({ hash: `#t=${TOKEN}` });
    expect(page.acquireToken()).toBe(TOKEN);
    expect(page.store.get("orch_token")).toBe(TOKEN);
    expect(page.replaced).toEqual([[null, "", "/?tab=models"]]);
  });

  it("reads the token from sessionStorage on a reload without a fragment", () => {
    const page = pageWith({ hash: "", stored: TOKEN });
    expect(page.acquireToken()).toBe(TOKEN);
    expect(page.replaced).toEqual([]);
  });

  it("returns no token for a fresh tab, a malformed fragment (cleared anyway) or unusable storage", () => {
    expect(pageWith({ hash: "" }).acquireToken()).toBe("");
    const malformed = pageWith({ hash: "#t=not-a-token" });
    expect(malformed.acquireToken()).toBe("");
    expect(malformed.replaced).toHaveLength(1);
    expect(malformed.store.size).toBe(0);
    expect(pageWith({ hash: "", storageThrows: true }).acquireToken()).toBe("");
    expect(pageWith({ hash: `#t=${TOKEN}`, storageThrows: true }).acquireToken()).toBe(TOKEN);
  });

  it("shows a translated instruction when the page has no token, and the HTML carries no token placeholder", () => {
    const message = "This page has no session token. Open the settings URL printed in your terminal; if it was already used, restart agrmcp settings.";
    expect(functionSource("loadState")).toContain(`throw new Error(${JSON.stringify(message)})`);
    expect(html).toContain(`"${message}": "`);
    expect(html).not.toMatch(/orch-csrf|__ORCH_CSRF__/);
  });
});
