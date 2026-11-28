import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { OutgoingHttpHeaders } from "node:http";
import { connect as netConnect, createServer as createTcpServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { parse, stringify } from "smol-toml";
import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLI_NAME } from "../../src/cli/name.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { entityIdProblem, isValidEntityId } from "../../src/config/ids.js";
import { DefaultsSchema, type HarnessConfig } from "../../src/config/schema.js";
import { ConfigManager } from "../../src/config/resolver.js";
import { ConfigWriter } from "../../src/config/writer.js";
import { MAX_APPLY_BATCH, previewDiscovery } from "../../src/discovery/index.js";
import type { DiscoveredModel, DiscoveryCandidate, DiscoveryObservation } from "../../src/discovery/index.js";
import { PreviewStore, startSettingsUi } from "../../src/settings-ui/server.js";
import type { DiscoveryRunner, SettingsUiHandle } from "../../src/settings-ui/server.js";
import { DRIVER_KINDS } from "../../src/drivers.js";
import type { HarnessHealth } from "../../src/types.js";

const DEFAULT_CATALOG = fileURLToPath(new URL("../../defaults/catalog.toml", import.meta.url));
const MODEL_ID = "claude-opus-5-5";

it("covers every default in the offline settings UI and uses the shared SVG sprite without inline styles", () => {
  const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");
  const groups = html.match(/^const DEFAULT_GROUPS = \[([\s\S]*?)^\];/m);
  expect(groups).not.toBeNull();
  const keys = [...groups![1].matchAll(/\bkey:\s*"([^"]+)"/g)].map((match) => match[1]);
  expect(keys.sort()).toEqual(Object.keys(DefaultsSchema.shape).sort());
  expect(html).not.toMatch(/\sstyle\s*=/i);
  expect(html).toContain('<svg class="svg-sprite"');
});

it("keeps the settings UI stylesheet within the DESIGN.md token invariants", () => {
  const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");
  const outsideRoot = html.replace(/:root[^{]*\{[^}]*\}/g, "");
  // Every font size comes from a token declared in :root.
  expect(outsideRoot.match(/font-size\s*:\s*[^;{}]*\d(?:px|rem|em|pt|%)/g) ?? []).toEqual([]);
  expect(html).not.toMatch(/text-transform\s*:\s*uppercase/i);
  const weights = new Set([...html.matchAll(/font-weight\s*:\s*(\d+)/g)].map((match) => match[1]));
  expect(weights.size).toBeLessThanOrEqual(3);
  expect(html.match(/border-radius\s*:[^;]*\b50%/g) ?? []).toEqual([]);
});

it("keeps the page free of inline styles, script-driven style writes, HTML string injection and inline handlers (strict nonce CSP)", () => {
  const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");
  expect(html).not.toMatch(/\sstyle\s*=/i);
  expect(html).not.toMatch(/\.style\s*(?:\.|\[|=)/);
  expect(html).not.toMatch(/setAttribute\(\s*["']style["']/);
  expect(html).not.toMatch(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  // The page script must at least parse; the other tests only extract single functions from it.
  const script = /<script nonce="__CSP_NONCE__">([\s\S]*)<\/script>/.exec(html)?.[1];
  expect(script).toBeTruthy();
  expect(() => new Function(script!)).not.toThrow();
});

it("declares the favicon links and ships a translation for every new save, combobox and lifecycle string", () => {
  const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");
  expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">');
  expect(html).toContain('<link rel="alternate icon" href="/favicon.ico" sizes="any">');
  const russianBlock = /^const russian = \{([\s\S]*?)^\};/m.exec(html)![1];
  for (const text of [
    "Switches save immediately. Open an entry to edit and save its settings.", "All changes saved", "Unsaved changes ({0})", "Saving…",
    "Review conflicts", "Not saved yet", "Reset and delete apply immediately, after you confirm.", "Select…", "No options available",
    "{0} (unavailable)", "“{0}” is already in the list.", "Enable preset {0}", "--flag or value, Enter", "RO", "Save changes bar",
  ]) {
    expect(russianBlock, text).toContain(`${JSON.stringify(text)}:`);
  }
  expect(html).toContain("saveRule: true");
});

it("names the renamed command in every restart hint and keeps each Russian translation in step", () => {
  const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");
  expect(html).not.toContain("orchestrate-settings");
  const russianBlock = /^const russian = \{([\s\S]*?)^\};/m.exec(html)![1];
  const hints = [...russianBlock.matchAll(/^\s*("(?:[^"\\]|\\.)*"):\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)]
    .filter(([, english]) => (JSON.parse(english) as string).includes(`${CLI_NAME} settings`));
  expect(hints).toHaveLength(3);
  for (const [, english, russian] of hints) {
    expect(JSON.parse(russian) as string).toContain(`${CLI_NAME} settings`);
    // The English key must still be what the page passes to t(), or the Russian text would never be shown.
    expect(html.split(JSON.parse(english) as string).length, english).toBeGreaterThan(2);
  }
});

describe("settings UI health probes", () => {
  const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");

  /** Returns the source of a top-level function declaration from the page script. */
  function functionSource(name: string): string {
    const match = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m").exec(html);
    expect(match, `function ${name} must exist in app.html`).not.toBeNull();
    return match![0];
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function loadHealthHarness() {
    const state = { health: null as unknown, healthLoading: false, probeSeq: 0 };
    const pending: Array<{ url: string; reply: (value: unknown) => void }> = [];
    const toasts: string[] = [];
    const api = (_method: string, url: string) => {
      const reply = deferred<unknown>();
      pending.push({ url, reply: reply.resolve });
      return reply.promise;
    };
    const loadHealth = new Function("state", "api", "render", "toast", "t",
      `${functionSource("loadHealth")}\nreturn loadHealth;`)(
      state, api, () => undefined, (kind: string) => toasts.push(kind), (text: string) => text,
    ) as (refresh: boolean, options?: { quiet?: boolean }) => Promise<void>;
    return { state, pending, toasts, loadHealth };
  }

  it("applies only the response of the latest probe, so a stale pre-save probe cannot overwrite fresh health", async () => {
    const { state, pending, loadHealth, toasts } = loadHealthHarness();
    const stale = loadHealth(false, { quiet: true });
    const fresh = loadHealth(true, { quiet: true });
    expect(pending.map((call) => call.url)).toEqual(["/api/health", "/api/health?refresh=1"]);
    pending[1].reply({ harnesses: { claude: "fresh" } });
    await fresh;
    expect(state.healthLoading).toBe(false);
    pending[0].reply({ harnesses: { claude: "stale" } });
    await stale;
    expect(state.health).toEqual({ claude: "fresh" });
    expect(state.healthLoading).toBe(false);
    expect(toasts).toEqual([]);
  });

  it("keeps the busy flag while the latest probe runs when an earlier one finishes", async () => {
    const { state, pending, loadHealth } = loadHealthHarness();
    const first = loadHealth(false);
    const second = loadHealth(true, { quiet: true });
    pending[0].reply({ harnesses: { claude: "stale" } });
    await first;
    expect(state.health).toBeNull();
    expect(state.healthLoading).toBe(true);
    pending[1].reply({ harnesses: { claude: "fresh" } });
    await second;
    expect(state.health).toEqual({ claude: "fresh" });
    expect(state.healthLoading).toBe(false);
  });

  it("skips a non-refresh probe while one runs", () => {
    const { state, pending, loadHealth } = loadHealthHarness();
    void loadHealth(false);
    void loadHealth(false);
    expect(pending).toHaveLength(1);
    expect(state.probeSeq).toBe(1);
  });

  /** Runs the real `saveHarness` and `loadHealth` from the page against stubbed network, drawer and mutation helpers. */
  function saveHarnessHarness(mutateResult: boolean) {
    const state = {
      health: null as unknown, healthLoading: false, probeSeq: 0,
      drawer: {
        id: "claude", isNew: false,
        draft: { driver: "claude", display_name: "Claude", binary: "/opt/claude-next" },
        original: { driver: "claude", display_name: "Claude", binary: "/opt/claude" },
      },
    };
    const pending: Array<{ url: string; reply: (value: unknown) => void }> = [];
    const mutations: Array<{ method: string; path: string; patch: unknown }> = [];
    const opened: string[][] = [];
    const toasts: string[] = [];
    const api = (_method: string, url: string) => {
      const reply = deferred<unknown>();
      pending.push({ url, reply: reply.resolve });
      return reply.promise;
    };
    const mutate = async (method: string, path: string, body: { patch: unknown }) => {
      mutations.push({ method, path, patch: body.patch });
      return mutateResult;
    };
    const { saveHarness, loadHealth } = new Function(
      "state", "api", "render", "toast", "t", "mutate", "validateNewId", "openDrawer",
      `const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const HARNESS_OPTIONAL_KEYS = ["profile", "default_upstream_provider", "write_permission_mode", "inherit_mcp", "max_concurrency", "model_discovery"];
const MAX_CONCURRENCY_LIMIT = 64;
${["loadHealth", "buildPatch", "dropBlankOptionals", "cleanHarnessDraft", "harnessDraftProblem", "saveHarness"].map(functionSource).join("\n")}
return { saveHarness, loadHealth };`,
    )(
      state, api, () => undefined, (kind: string) => toasts.push(kind), (text: string) => text, mutate,
      () => undefined, (...args: string[]) => opened.push(args),
    ) as { saveHarness: () => Promise<void>; loadHealth: (refresh: boolean, options?: { quiet?: boolean }) => Promise<void> };
    return { state, pending, mutations, opened, toasts, saveHarness, loadHealth };
  }

  it("saving a harness launches a fresh quiet probe that supersedes any older one", async () => {
    const { state, pending, mutations, opened, toasts, saveHarness, loadHealth } = saveHarnessHarness(true);
    const stale = loadHealth(false, { quiet: true });
    expect(pending.map((call) => call.url)).toEqual(["/api/health"]);

    await saveHarness();
    expect(mutations).toEqual([{ method: "PUT", path: "/api/harnesses/claude", patch: { binary: "/opt/claude-next" } }]);
    expect(opened).toEqual([["harness", "claude"]]);
    // A second, cache-bypassing probe started right after the successful save and took over the probe sequence.
    expect(pending.map((call) => call.url)).toEqual(["/api/health", "/api/health?refresh=1"]);
    expect(state.probeSeq).toBe(2);
    expect(state.healthLoading).toBe(true);

    pending[1].reply({ harnesses: { claude: "fresh" } });
    await vi.waitFor(() => expect(state.healthLoading).toBe(false));
    pending[0].reply({ harnesses: { claude: "stale-pre-save" } });
    await stale;
    expect(state.health).toEqual({ claude: "fresh" });
    // The probe is quiet: neither success nor failure raises a toast.
    expect(toasts).toEqual([]);
  });

  it("does not probe again when the save fails or changes nothing", async () => {
    const failed = saveHarnessHarness(false);
    await failed.saveHarness();
    expect(failed.mutations).toHaveLength(1);
    expect(failed.pending).toEqual([]);
    expect(failed.state.probeSeq).toBe(0);
    expect(failed.opened).toEqual([]);

    const unchanged = saveHarnessHarness(true);
    unchanged.state.drawer.draft = { ...unchanged.state.drawer.original };
    await unchanged.saveHarness();
    expect(unchanged.mutations).toEqual([]);
    expect(unchanged.pending).toEqual([]);
    expect(unchanged.toasts).toEqual(["info"]);
  });
});

/** Probes nothing real: every harness reports a deterministic healthy status. */
class MockRegistry extends AdapterRegistry {
  readonly calls: Array<{ id: string; refresh: boolean }> = [];

  override async probeHarness(
    harnessId: string,
    harness: HarnessConfig,
    options: { refresh?: boolean } = {},
  ): Promise<HarnessHealth> {
    this.calls.push({ id: harnessId, refresh: options.refresh === true });
    return {
      harness: harnessId,
      driver: harness.driver,
      enabled: harness.enabled,
      installed: harnessId !== "pi",
      version: harnessId === "pi" ? undefined : "1.2.3",
      auth_status: harnessId === "pi" ? "unknown" : "ready",
      security_guarantees: { readonly: "os_sandbox", write: "os_sandbox" },
      checked_at: "2026-11-25T00:00:00.000Z",
    };
  }
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => any;
}

function send(port: number, method: string, path: string, headers: OutgoingHttpHeaders = {}, body?: string | Buffer):
Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) });
        });
        res.on("error", reject);
      });
    req.on("error", reject);
    req.end(body);
  });
}

const csrfByCookie = new Map<string, string>();

/**
 * Exchanges the one-time bootstrap token like the browser does: the CSRF token is delivered only in the `#t=` fragment of
 * the 302 `Location` (a fragment is never sent to a server), never in the served HTML or an API response.
 */
async function bootstrapLogin(port: number, bootstrapToken: string): Promise<{ cookie: string; csrf: string; response: RawResponse }> {
  const response = await send(port, "GET", `/?token=${bootstrapToken}`);
  expect(response.status).toBe(302);
  const cookie = String(response.headers["set-cookie"]).split(";")[0];
  const csrf = /^\/#t=([0-9a-f]{64})$/.exec(String(response.headers.location))?.[1];
  expect(csrf, "the bootstrap redirect must carry the CSRF token in the URL fragment").toBeTruthy();
  csrfByCookie.set(cookie, csrf!);
  return { cookie, csrf: csrf!, response };
}

/** The CSRF token the browser holds for a session cookie (from `bootstrapLogin`); the page itself never contains it. */
function pageCsrf(cookie: string): string {
  const token = csrfByCookie.get(cookie);
  expect(token, "no CSRF token was captured for this cookie").toBeTruthy();
  return token!;
}

/** Headers of an authorized same-origin API call from the page: session cookie plus the CSRF token. */
const authHeaders = (auth: { cookie: string; csrf: string }): OutgoingHttpHeaders => ({ cookie: auth.cookie, "x-orch-token": auth.csrf });

describe("settings UI server", () => {
  let dir: string;
  let userPath: string;
  let manager: ConfigManager;
  let registry: MockRegistry;
  let ui: SettingsUiHandle;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-settings-ui-"));
    userPath = join(dir, "config", "models.toml");
    manager = new ConfigManager({ defaultPath: DEFAULT_CATALOG, userPath });
    registry = new MockRegistry();
    ui = await startSettingsUi({
      port: 0,
      openBrowser: false,
      configManager: manager,
      configWriter: new ConfigWriter(manager),
      adapterRegistry: registry,
      lockDir: join(dir, "locks"),
    });
    port = ui.port;
  });

  afterEach(async () => {
    await ui.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    return (await bootstrapLogin(port, new URL(ui.url).searchParams.get("token") ?? "")).cookie;
  }

  async function session(): Promise<{ cookie: string; csrf: string; state: any }> {
    const cookie = await login();
    const csrf = pageCsrf(cookie);
    const res = await send(port, "GET", "/api/state", authHeaders({ cookie, csrf }));
    expect(res.status).toBe(200);
    return { cookie, csrf, state: res.json() };
  }

  function mutate(
    auth: { cookie: string; csrf: string },
    method: string,
    path: string,
    payload: unknown,
    headers: OutgoingHttpHeaders = {},
  ): Promise<RawResponse> {
    return send(port, method, path, {
      cookie: auth.cookie,
      origin: `http://127.0.0.1:${port}`,
      "x-orch-token": auth.csrf,
      "content-type": "application/json",
      ...headers,
    }, JSON.stringify(payload));
  }

  function userToml(): Record<string, any> {
    return parse(readFileSync(userPath, "utf8")) as Record<string, any>;
  }

  it("binds to loopback, exposes a tokenized URL and rejects foreign Host headers", async () => {
    expect(ui.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(ui.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?token=[0-9a-f]{64}$`));

    const token = new URL(ui.url).searchParams.get("token") ?? "";
    const rebound = await send(port, "GET", `/?token=${token}`, { host: `evil.example:${port}` });
    expect(rebound.status).toBe(403);
    expect((await send(port, "GET", "/", { host: `localhost:${port}` })).status).toBe(403);
    // The rejected attempt must not burn the one-time token.
    expect((await send(port, "GET", `/?token=${token}`)).status).toBe(302);
  });

  it("requires a session for the page and the API", async () => {
    const page = await send(port, "GET", "/");
    expect(page.status).toBe(401);
    expect(page.text).toContain("Authorization required");
    expect(page.text).toContain(`printed by ${CLI_NAME} settings in your terminal`);
    expect((await send(port, "GET", "/api/state")).status).toBe(401);
    expect((await send(port, "GET", "/api/state", { cookie: "orch_session=forged" })).status).toBe(401);
    expect((await send(port, "GET", "/?token=0000")).status).toBe(401);
  });

  it("exchanges the bootstrap token exactly once for an HttpOnly SameSite=Strict cookie", async () => {
    const token = new URL(ui.url).searchParams.get("token") ?? "";
    const first = await send(port, "GET", `/?token=${token}`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toMatch(/^\/#t=[0-9a-f]{64}$/);
    const setCookie = String(first.headers["set-cookie"]);
    expect(setCookie).toMatch(/^orch_session=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/$/);

    const reused = await send(port, "GET", `/?token=${token}`);
    expect(reused.status).toBe(401);
    expect(reused.text).toContain("Link already used");
    expect(reused.text).toContain(`Restart ${CLI_NAME} settings and open the new URL`);
    expect(reused.text).not.toContain("orchestrate-settings");

    const cookie = setCookie.split(";")[0];
    const page = await send(port, "GET", "/", { cookie });
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
  });

  it("never embeds the CSRF token in GET /, so a cookie-only caller (another local server) cannot harvest it", async () => {
    const { cookie, csrf, response } = await bootstrapLogin(port, new URL(ui.url).searchParams.get("token") ?? "");
    // Only the browser sees the fragment; it is never sent over HTTP.
    expect(response.headers.location).toBe(`/#t=${csrf}`);
    expect(response.text).not.toContain(csrf);

    // A server-side GET / that replays only the stolen cookie (no Sec-Fetch-Site label) gets a static page.
    const page = await send(port, "GET", "/", { cookie });
    expect(page.status).toBe(200);
    expect(page.text).not.toContain(csrf);
    expect(page.text).not.toMatch(/orch-csrf|csrfToken|[0-9a-f]{64}/);
    expect(JSON.stringify(page.headers)).not.toContain(csrf);

    // The cookie alone is not enough for the API either.
    expect((await send(port, "GET", "/api/state", { cookie })).status).toBe(403);
    expect((await send(port, "GET", "/api/state", { cookie, "x-orch-token": csrf })).status).toBe(200);

    // A cookie holder replaying a ?token= URL is only redirected home: that redirect must not carry the token either.
    const replay = await send(port, "GET", "/?token=bogus", { cookie });
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toBe("/");
  });

  it("serves the page with a strict nonce CSP and no CORS headers", async () => {
    const cookie = await login();
    const page = await send(port, "GET", "/", { cookie, origin: "http://evil.example" });
    const csp = String(page.headers["content-security-policy"]);
    const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(page.text).toContain(`<script nonce="${nonce}">`);
    expect(page.text).toContain(`<style nonce="${nonce}">`);
    expect(page.text).not.toContain("__CSP_NONCE__");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["cache-control"]).toBe("no-store");

    const second = await send(port, "GET", "/", { cookie });
    expect(second.headers["content-security-policy"]).not.toBe(csp);

    const api = await send(port, "GET", "/api/state", { ...authHeaders({ cookie, csrf: pageCsrf(cookie) }), origin: "http://evil.example" });
    for (const response of [page, api]) {
      expect(Object.keys(response.headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
    }
    const preflight = await send(port, "OPTIONS", "/api/defaults", { origin: "http://evil.example" });
    expect(preflight.status).toBe(405);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects mutations without a valid Origin, CSRF token, Content-Type or within body limits", async () => {
    const auth = await session();
    const payload = { patch: { max_concurrency: 5 }, revision: auth.state.snapshot.revision };
    const noOrigin = await send(port, "PUT", "/api/defaults", {
      cookie: auth.cookie, "x-orch-token": auth.csrf, "content-type": "application/json",
    }, JSON.stringify(payload));
    expect(noOrigin.status).toBe(403);

    expect((await mutate(auth, "PUT", "/api/defaults", payload, { origin: "http://evil.example" })).status).toBe(403);
    expect((await mutate(auth, "PUT", "/api/defaults", payload, { origin: `http://localhost:${port}` })).status).toBe(403);
    expect((await mutate(auth, "PUT", "/api/defaults", payload, { "x-orch-token": "wrong" })).status).toBe(403);
    expect((await mutate(auth, "PUT", "/api/defaults", payload, { "x-orch-token": "" })).status).toBe(403);
    expect((await mutate(auth, "PUT", "/api/defaults", payload, { "content-type": "text/plain" })).status).toBe(415);
    expect((await mutate({ cookie: "orch_session=forged", csrf: auth.csrf }, "PUT", "/api/defaults", payload))
      .status).toBe(401);

    const huge = await mutate(auth, "PUT", "/api/defaults", { patch: {}, revision: "x", pad: "a".repeat(300 * 1024) });
    expect(huge.status).toBe(413);
    const malformed = await send(port, "PUT", "/api/defaults", {
      cookie: auth.cookie, origin: `http://127.0.0.1:${port}`, "x-orch-token": auth.csrf,
      "content-type": "application/json",
    }, "{not json");
    expect(malformed.status).toBe(400);

    expect(existsSync(userPath)).toBe(false);
    const getMutation = await send(port, "GET", "/api/reset-all", authHeaders(auth));
    expect(getMutation.status).toBe(404);
  });

  it("returns state with defaults, provenance and a CSRF token", async () => {
    const { state, csrf } = await session();
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(state).not.toHaveProperty("csrfToken");
    expect(JSON.stringify(state)).not.toContain(csrf);
    expect(state.catalogPath).toBe(DEFAULT_CATALOG);
    expect(state.userConfigPath).toBe(userPath);
    expect(typeof state.stateDir).toBe("string");
    expect(state.defaults_catalog.models[MODEL_ID].tier).toBe("deep");
    expect(state.snapshot.models[MODEL_ID].provenance).toBe("default");
    expect(state.snapshot.harnesses.claude.provenance).toBe("default");
    expect(typeof state.snapshot.revision).toBe("string");
  });

  it("saves, resets a field and resets a whole built-in model", async () => {
    const auth = await session();
    const saved = await mutate(auth, "PUT", `/api/models/${MODEL_ID}`, {
      patch: { tier: "standard", strengths: ["Тестовая сила"], cost_note: "Тестовая заметка" },
      revision: auth.state.snapshot.revision,
    });
    expect(saved.status).toBe(200);
    let model = saved.json().snapshot.models[MODEL_ID];
    expect(model.provenance).toBe("overridden");
    expect(model.field_provenance.tier).toBe("overridden");
    expect(model.field_provenance.display_name).toBe("default");
    const stored = userToml().models[MODEL_ID];
    expect(stored).toMatchObject({ tier: "standard", strengths: ["Тестовая сила"], cost_note: "Тестовая заметка" });
    expect(stored.display_name).toBeUndefined();

    const fieldReset = await mutate(auth, "POST", `/api/models/${MODEL_ID}/reset-field`, {
      field: "tier", revision: saved.json().snapshot.revision,
    });
    expect(fieldReset.status).toBe(200);
    model = fieldReset.json().snapshot.models[MODEL_ID];
    expect(model.tier).toBe("deep");
    expect(model.field_provenance.tier).toBe("default");
    expect(model.field_provenance.cost_note).toBe("overridden");

    const reset = await mutate(auth, "POST", `/api/models/${MODEL_ID}/reset`, {
      revision: fieldReset.json().snapshot.revision,
    });
    expect(reset.status).toBe(200);
    model = reset.json().snapshot.models[MODEL_ID];
    expect(model.provenance).toBe("default");
    expect(model.cost_note).toBe(auth.state.defaults_catalog.models[MODEL_ID].cost_note);
    expect(userToml().models).toBeUndefined();
  });

  it("adds and deletes a custom model and rejects invalid input", async () => {
    const auth = await session();
    const custom = {
      harness: "codex", display_name: "Local Test Model", tier: "light", efforts: ["low", "medium"],
      default_effort: "low", cost_tier: "low", cost_note: "", speed_note: "", context_window: 128000,
      strengths: [], weaknesses: [], best_for: [], avoid_for: [], checked_at: "2026-11-25", enabled: true, custom: true,
    };
    const invalid = await mutate(auth, "PUT", "/api/models/local-test", {
      patch: { ...custom, default_effort: "max" }, revision: auth.state.snapshot.revision,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json().error).toBe("Validation failed");

    const badId = await mutate(auth, "PUT", "/api/models/..%2Fescape", { patch: custom, revision: "x" });
    expect(badId.status).toBe(400);

    const created = await mutate(auth, "PUT", "/api/models/local-test", {
      patch: custom, revision: auth.state.snapshot.revision,
    });
    expect(created.status).toBe(200);
    expect(created.json().snapshot.models["local-test"].provenance).toBe("custom");
    expect(userToml().models["local-test"].display_name).toBe("Local Test Model");

    const deleted = await mutate(auth, "POST", "/api/models/local-test/reset", {
      revision: created.json().snapshot.revision,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.json().snapshot.models["local-test"]).toBeUndefined();
  });

  it("edits a harness, a preset and the defaults, and reports revision conflicts", async () => {
    const auth = await session();
    let revision = auth.state.snapshot.revision;

    const harness = await mutate(auth, "PUT", "/api/harnesses/codex", {
      patch: { display_name: "Codex (work)", extra_args: ["--foo"] }, revision,
    });
    expect(harness.status).toBe(200);
    expect(harness.json().snapshot.harnesses.codex.provenance).toBe("overridden");
    revision = harness.json().snapshot.revision;

    const preset = await mutate(auth, "PUT", "/api/presets/balanced", {
      patch: { roles: { quick: { harness: "codex", model: "gpt-6-luna", effort: "low" }, writing: null } }, revision,
    });
    expect(preset.status).toBe(200);
    const balanced = preset.json().snapshot.presets.balanced;
    expect(balanced.roles.quick).toEqual({ harness: "codex", model: "gpt-6-luna", effort: "low" });
    expect(balanced.roles.writing).toBeUndefined();
    revision = preset.json().snapshot.revision;

    const defaults = await mutate(auth, "PUT", "/api/defaults", { patch: { max_concurrency: 5 }, revision });
    expect(defaults.status).toBe(200);
    expect(defaults.json().snapshot.defaults.max_concurrency).toBe(5);
    expect(defaults.json().snapshot.defaults_provenance.max_concurrency).toBe("overridden");

    const stale = await mutate(auth, "PUT", "/api/defaults", { patch: { max_queue_size: 20 }, revision });
    expect(stale.status).toBe(409);
    expect(stale.json().error).toMatch(/revision conflict/i);
    expect(stale.json().snapshot.revision).toBe(defaults.json().snapshot.revision);
    expect(userToml().defaults.max_queue_size).toBeUndefined();

    const missingRevision = await mutate(auth, "PUT", "/api/defaults", { patch: { max_queue_size: 20 } });
    expect(missingRevision.status).toBe(400);

    const badSection = await mutate(auth, "POST", "/api/reset-section", {
      section: "aliases", revision: defaults.json().snapshot.revision,
    });
    expect(badSection.status).toBe(400);
    const section = await mutate(auth, "POST", "/api/reset-section", {
      section: "harnesses", revision: defaults.json().snapshot.revision,
    });
    expect(section.status).toBe(200);
    expect(section.json().snapshot.harnesses.codex.provenance).toBe("default");
    expect(section.json().snapshot.defaults.max_concurrency).toBe(5);

    const presetReset = await mutate(auth, "POST", "/api/presets/balanced/reset", {
      revision: section.json().snapshot.revision,
    });
    expect(presetReset.json().snapshot.presets.balanced.provenance).toBe("default");
    const harnessReset = await mutate(auth, "POST", "/api/harnesses/codex/reset", {
      revision: presetReset.json().snapshot.revision,
    });
    expect(harnessReset.status).toBe(200);
  });

  describe("favicon", () => {
    const ASSETS = [
      { path: "/favicon.svg", type: "image/svg+xml" },
      { path: "/favicon.ico", type: "image/vnd.microsoft.icon" },
    ] as const;

    function expectAssetHeaders(res: RawResponse, type: string): void {
      expect(res.status).toBe(200);
      expect(String(res.headers["content-type"])).toContain(type);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(res.headers["content-security-policy"]).toBeTruthy();
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }

    it.each(ASSETS)("serves GET and HEAD $path without a session and without consuming the bootstrap token", async ({ path, type }) => {
      const get = await send(port, "GET", path);
      expectAssetHeaders(get, type);
      expect(get.text.length).toBeGreaterThan(0);
      const head = await send(port, "HEAD", path);
      expectAssetHeaders(head, type);
      expect(head.text).toBe("");
      expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
      // Still unauthenticated for everything else, and the one-time token is intact.
      expect((await send(port, "GET", "/api/state")).status).toBe(401);
      const cookie = await login();
      // After login the same assets are still served, with or without the cookie.
      expectAssetHeaders(await send(port, "GET", path, { cookie }), type);
      expectAssetHeaders(await send(port, "GET", path), type);
    });

    it("keeps the Host check in front of the favicon and rejects other methods", async () => {
      expect((await send(port, "GET", "/favicon.svg", { host: `evil.example:${port}` })).status).toBe(403);
      expect((await send(port, "GET", "/favicon.ico", { host: `evil.example:${port}` })).status).toBe(403);
      const auth = await session();
      const post = await mutate(auth, "POST", "/favicon.svg", {});
      expect(post.status).toBe(404);
      expect((await send(port, "GET", "/favicon.png")).status).toBe(404);
    });

    it("serves a self-contained SVG and an ICO whose 16px and 32px entries are valid PNGs", async () => {
      const svg = (await send(port, "GET", "/favicon.svg")).text;
      expect(svg).toMatch(/^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg).not.toMatch(/<script|href=|on[a-z]+=/i);

      const ico = await new Promise<Buffer>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path: "/favicon.ico", headers: { host: `127.0.0.1:${port}` } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          });
        req.on("error", reject);
        req.end();
      });
      expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
      const count = ico.readUInt16LE(4);
      expect(count).toBe(2);
      const sizes: number[] = [];
      for (let entry = 0; entry < count; entry++) {
        const at = 6 + entry * 16;
        const width = ico[at] || 256;
        const bytes = ico.readUInt32LE(at + 8);
        const offset = ico.readUInt32LE(at + 12);
        const png = ico.subarray(offset, offset + bytes);
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(png.readUInt32BE(16)).toBe(width);
        expect(png.readUInt32BE(20)).toBe(width);
        // Every chunk CRC must match, and the pixel data must inflate to height*(1 + width*4) bytes.
        let cursor = 8;
        const idat: Buffer[] = [];
        while (cursor < png.length) {
          const length = png.readUInt32BE(cursor);
          const kind = png.subarray(cursor + 4, cursor + 8).toString("latin1");
          const body = png.subarray(cursor + 8, cursor + 8 + length);
          expect(png.readUInt32BE(cursor + 8 + length), `${kind} CRC`).toBe(crc32(png.subarray(cursor + 4, cursor + 8 + length)));
          if (kind === "IDAT") idat.push(body);
          cursor += 12 + length;
        }
        expect(cursor).toBe(png.length);
        expect(inflateSync(Buffer.concat(idat)).length).toBe(width * (1 + width * 4));
        sizes.push(width);
      }
      expect(sizes.sort((a, b) => a - b)).toEqual([16, 32]);
    });
  });

  it("adds and deletes a custom harness together with its model, leaving no trace in the user file", async () => {
    const auth = await session();
    const harness = {
      custom: true, driver: "claude", display_name: "Claude Code (custom wrapper)", binary: "/usr/local/bin/claude-wrapper",
      enabled: true, write_permission_mode: "acceptEdits", inherit_mcp: false, extra_args: [],
    };
    const created = await mutate(auth, "PUT", "/api/harnesses/claude-custom", { patch: harness, revision: auth.state.snapshot.revision });
    expect(created.status).toBe(200);
    expect(created.json().snapshot.harnesses["claude-custom"].provenance).toBe("custom");

    const model = {
      harness: "claude-custom", display_name: "Custom Sonnet", tier: "standard", efforts: ["low"], default_effort: "low",
      cost_tier: "medium", cost_note: "", speed_note: "", context_window: 200000, strengths: [], weaknesses: [], best_for: [],
      avoid_for: [], checked_at: "2026-11-25", enabled: true, custom: true,
    };
    const withModel = await mutate(auth, "PUT", "/api/models/claude-custom-sonnet", { patch: model, revision: created.json().snapshot.revision });
    expect(withModel.status).toBe(200);

    const modelGone = await mutate(auth, "POST", "/api/models/claude-custom-sonnet/reset", { revision: withModel.json().snapshot.revision });
    expect(modelGone.status).toBe(200);
    expect(modelGone.json().snapshot.models["claude-custom-sonnet"]).toBeUndefined();
    const harnessGone = await mutate(auth, "POST", "/api/harnesses/claude-custom/reset", { revision: modelGone.json().snapshot.revision });
    expect(harnessGone.status).toBe(200);
    expect(harnessGone.json().snapshot.harnesses["claude-custom"]).toBeUndefined();
    expect(harnessGone.json().snapshot.models[MODEL_ID]).toBeDefined();
    const user = userToml();
    expect(user.harnesses?.["claude-custom"]).toBeUndefined();
    expect(user.models?.["claude-custom-sonnet"]).toBeUndefined();
  });

  it("resets everything to defaults and keeps a .bak backup", async () => {
    const auth = await session();
    const saved = await mutate(auth, "PUT", "/api/defaults", {
      patch: { max_concurrency: 7 }, revision: auth.state.snapshot.revision,
    });
    expect(saved.status).toBe(200);
    const before = readFileSync(userPath, "utf8");

    const reset = await mutate(auth, "POST", "/api/reset-all", { revision: saved.json().snapshot.revision });
    expect(reset.status).toBe(200);
    expect(reset.json().snapshot.defaults.max_concurrency).toBe(8);
    const backups = readdirSync(join(dir, "config")).filter((name) => name.startsWith("models.toml.bak."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(dir, "config", backups[0]), "utf8")).toBe(before);
    expect(userToml().defaults).toBeUndefined();
  });

  it("reports all supported drivers with their metadata in /api/state", async () => {
    const { state } = await session();
    expect(state.supported_drivers).toEqual([...DRIVER_KINDS]);
    expect(state.supported_drivers).toEqual(expect.arrayContaining([
      "claude", "codex", "dsh", "pi", "antigravity", "opencode", "gemini", "cursor", "grok", "kiro", "fx", "muse",
      "copilot", "droid", "qwen", "kimi", "vibe",
    ]));
    expect(state.supported_drivers).toHaveLength(17);
    expect(state.driver_metadata.cursor).toMatchObject({ kind: "cursor", contract: "experimental" });
    expect(state.driver_metadata.antigravity).toMatchObject({ contract: "verified", writePermissionModes: ["accept-edits", "auto"] });
    expect(state.driver_metadata.fx.supportsReadonly).toBe(false);
    expect(Object.keys(state.snapshot.harnesses)).toEqual(expect.arrayContaining([...DRIVER_KINDS]));
  });

  it("probes harness health through the adapter registry", async () => {
    const auth = await session();
    const res = await send(port, "GET", "/api/health?refresh=1", authHeaders(auth));
    expect(res.status).toBe(200);
    const { harnesses } = res.json();
    expect(Object.keys(harnesses)).toEqual(expect.arrayContaining(["claude", "codex", "dsh", "pi"]));
    expect(harnesses.claude).toMatchObject({ installed: true, auth_status: "ready", version: "1.2.3" });
    expect(harnesses.pi.installed).toBe(false);
    expect(registry.calls.every((call) => call.refresh)).toBe(true);
    expect((await send(port, "GET", "/api/health")).status).toBe(401);
  });

  it("answers heartbeats and allows only one instance per lock directory", async () => {
    const auth = await session();
    const beat = await mutate(auth, "POST", "/api/heartbeat", {});
    expect(beat.status).toBe(200);
    expect(beat.json()).toEqual({ ok: true });

    await expect(startSettingsUi({
      port: 0, openBrowser: false, configManager: manager, adapterRegistry: registry, lockDir: join(dir, "locks"),
    })).rejects.toThrow(new RegExp(`^${CLI_NAME} settings is already running`));
  });

  it("enforces exact application/json media type and supports slash-containing model IDs", async () => {
    const auth = await session();
    const badCt = await send(port, "POST", "/api/heartbeat", {
      cookie: auth.cookie,
      origin: `http://127.0.0.1:${port}`,
      "x-orch-token": auth.csrf,
      "content-type": "application/jsonx",
    }, "{}");
    expect(badCt.status).toBe(415);

    const added = await mutate(auth, "PUT", `/api/models/${encodeURIComponent("vendor/model-1")}`, {
      patch: {
        custom: true,
        harness: "pi",
        cli_model: "model-1",
        cli_provider: "vendor",
        display_name: "Vendor Model 1",
        tier: "standard",
        efforts: ["low", "high"],
        default_effort: "high",
        cost_tier: "low",
        cost_note: "low",
        speed_note: "fast",
        context_window: 128000,
        strengths: ["fast"],
        weaknesses: ["small"],
        best_for: ["quick"],
        avoid_for: ["security"],
        checked_at: "2026-11-25",
      },
      revision: auth.state.snapshot.revision,
    });
    expect(added.status).toBe(200);
    expect(added.json().snapshot.models["vendor/model-1"]).toBeDefined();
  });

  describe("entity IDs", () => {
    const customModel = {
      custom: true, harness: "codex", display_name: "Legacy Model", tier: "light", efforts: ["low"], default_effort: "low",
      cost_tier: "low", cost_note: "", speed_note: "", context_window: 128000, strengths: [], weaknesses: [], best_for: [],
      avoid_for: [], checked_at: "2026-11-25", enabled: true,
    };
    // IDs that the strict creation pattern rejects but a hand-edited config can legitimately hold.
    const LEGACY_IDS = ["my model", "legacy_é", "-leading-dash"];

    function writeLegacyConfig(): void {
      mkdirSync(join(dir, "config"), { recursive: true });
      writeFileSync(userPath, stringify({ schema_version: 1, models: Object.fromEntries(LEGACY_IDS.map((id) => [id, customModel])) }));
    }

    it("keeps existing entities with non-pattern IDs editable, resettable and deletable", async () => {
      writeLegacyConfig();
      const auth = await session();
      let revision = auth.state.snapshot.revision;
      for (const id of LEGACY_IDS) expect(auth.state.snapshot.models[id], id).toBeDefined();
      const path = (id: string, suffix = "") => `/api/models/${encodeURIComponent(id)}${suffix}`;

      const edited = await mutate(auth, "PUT", path(LEGACY_IDS[0]), { patch: { display_name: "Edited" }, revision });
      expect(edited.status).toBe(200);
      expect(edited.json().snapshot.models[LEGACY_IDS[0]].display_name).toBe("Edited");
      revision = edited.json().snapshot.revision;

      for (const id of LEGACY_IDS) {
        const deleted = await mutate(auth, "POST", path(id, "/reset"), { revision });
        expect(deleted.status, id).toBe(200);
        revision = deleted.json().snapshot.revision;
        expect(deleted.json().snapshot.models[id]).toBeUndefined();
      }
    });

    it("keeps the strict pattern for creating a new entity with the same kind of ID", async () => {
      writeLegacyConfig();
      const auth = await session();
      for (const id of ["new model", "-new", "caf\u00e9"]) {
        const created = await mutate(auth, "PUT", `/api/models/${encodeURIComponent(id)}`, {
          patch: customModel, revision: auth.state.snapshot.revision,
        });
        expect(created.status, id).toBe(400);
      }
    });

    it("rejects prototype names, dot-dot and control characters even for IDs that exist", async () => {
      writeLegacyConfig();
      const auth = await session();
      for (const id of ["__proto__", "constructor", "prototype", "a..b", "a\u0001b", "a\nb"]) {
        for (const [method, suffix] of [["PUT", ""], ["POST", "/reset"]] as const) {
          const reply = await mutate(auth, method, `/api/models/${encodeURIComponent(id)}${suffix}`, {
            patch: customModel, revision: auth.state.snapshot.revision,
          });
          expect(reply.status, `${method} ${JSON.stringify(id)}`).toBe(400);
        }
      }
    });

    it("applies the same rule to harnesses and presets", async () => {
      mkdirSync(join(dir, "config"), { recursive: true });
      writeFileSync(userPath, stringify({ schema_version: 1,
        harnesses: { "my harness": { custom: true, driver: "codex", display_name: "Mine", binary: "codex", enabled: true } },
        presets: { "my preset": { description: "Legacy", enabled: true, roles: {} } } }));
      const auth = await session();
      expect(auth.state.snapshot.harnesses["my harness"]).toBeDefined();
      expect(auth.state.snapshot.presets["my preset"]).toBeDefined();
      const toggled = await mutate(auth, "PUT", "/api/harnesses/my%20harness", {
        patch: { enabled: false }, revision: auth.state.snapshot.revision,
      });
      expect(toggled.status).toBe(200);
      const preset = await mutate(auth, "PUT", "/api/presets/my%20preset", {
        patch: { description: "Edited" }, revision: toggled.json().snapshot.revision,
      });
      expect(preset.status).toBe(200);
      const created = await mutate(auth, "PUT", "/api/harnesses/another%20harness", {
        patch: { custom: true, driver: "codex", display_name: "Other", binary: "codex" }, revision: preset.json().snapshot.revision,
      });
      expect(created.status).toBe(400);
    });
  });

  describe("Wave 1B: shared ID policy, optional-field clearing and exposed capabilities", () => {
    const modelPatch = (harness: string, extra: Record<string, unknown> = {}) => ({
      custom: true, harness, display_name: "Slash Model", tier: "light", efforts: ["low"], default_effort: "low",
      cost_tier: "low", cost_note: "", speed_note: "", context_window: 128000, strengths: [], weaknesses: [], best_for: [],
      avoid_for: [], checked_at: "2026-11-25", enabled: true, ...extra,
    });
    const modelPath = (id: string, suffix = "") => `/api/models/${encodeURIComponent(id)}${suffix}`;
    const harnessPath = (id: string, suffix = "") => `/api/harnesses/${encodeURIComponent(id)}${suffix}`;

    it("exposes the full driver capabilities, quarantine list, inherited MCP default, ID policy and inferred vendors in /api/state", async () => {
      mkdirSync(join(dir, "config"), { recursive: true });
      writeFileSync(userPath, stringify({ schema_version: 1,
        models: { orphan: modelPatch("no-such-harness") } }));
      const { state } = await session();
      expect(state.driver_metadata.dsh).toMatchObject({ supportsProfile: true, usesUpstreamProvider: true, usesCliProvider: true });
      expect(state.driver_metadata.opencode).toMatchObject({
        usesCliProvider: true, requiresProviderPrefix: true, defaultEfforts: ["default"], effortSupport: "model-variant",
      });
      expect(state.driver_metadata.claude).toMatchObject({
        supportsProfile: false, usesUpstreamProvider: false, usesCliProvider: false, defaultEfforts: ["low", "medium", "high"],
        effortSupport: "native", writePermissionModes: ["acceptEdits", "auto"],
      });
      for (const driver of DRIVER_KINDS) {
        expect(state.driver_metadata[driver], driver).toEqual(expect.objectContaining({
          supportsProfile: expect.any(Boolean), usesUpstreamProvider: expect.any(Boolean), usesCliProvider: expect.any(Boolean),
          defaultEfforts: expect.any(Array), effortSupport: expect.any(String),
        }));
      }
      expect(state.snapshot.quarantined).toEqual([expect.objectContaining({ section: "models", id: "orphan" })]);
      expect(state.snapshot.defaults.inherit_mcp).toBe(false);
      expect(state.id_policy.max_length).toBe(128);
      expect(state.id_policy.rules).toContain("':'");
      expect(state.inferred_vendor_family[MODEL_ID]).toBe("anthropic");
      expect(state.inferred_vendor_family.orphan).toBeUndefined();
    });

    it.each(["openai/gpt-5", "qwen3:32b", "team@host/model:v1.2"])("creates, edits and deletes the custom model %s over HTTP", async (id) => {
      const auth = await session();
      const created = await mutate(auth, "PUT", modelPath(id), { patch: modelPatch("codex"), revision: auth.state.snapshot.revision });
      expect(created.status).toBe(200);
      expect(created.json().snapshot.models[id].provenance).toBe("custom");
      expect(userToml().models[id].display_name).toBe("Slash Model");

      const edited = await mutate(auth, "PUT", modelPath(id), { patch: { display_name: "Edited" }, revision: created.json().snapshot.revision });
      expect(edited.status).toBe(200);
      expect(edited.json().snapshot.models[id].display_name).toBe("Edited");

      const deleted = await mutate(auth, "POST", modelPath(id, "/reset"), { revision: edited.json().snapshot.revision });
      expect(deleted.status).toBe(200);
      expect(deleted.json().snapshot.models[id]).toBeUndefined();
      expect(userToml().models).toBeUndefined();
    });

    it("creates a harness with ':' and '@' in its ID and still rejects traversal, doubled slashes and reserved names", async () => {
      const auth = await session();
      const patch = { custom: true, driver: "codex", display_name: "Colon", binary: "codex", enabled: true };
      const created = await mutate(auth, "PUT", harnessPath("codex:work@v2"), { patch, revision: auth.state.snapshot.revision });
      expect(created.status).toBe(200);
      expect(created.json().snapshot.harnesses["codex:work@v2"].provenance).toBe("custom");
      for (const id of ["a//b", "a..b", "trail/", "__proto__", "constructor", "prototype", "has space", ":lead"]) {
        const rejected = await mutate(auth, "PUT", harnessPath(id), { patch, revision: created.json().snapshot.revision });
        expect(rejected.status, id).toBe(400);
      }
    });

    it("keeps the page's new-ID validator in step with the shared policy in src/config/ids.ts", () => {
      const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");
      const source = (name: string) => new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "m").exec(html)![0];
      const pattern = /^const ID_PATTERN = (.+);$/m.exec(html)![1];
      const reserved = /^const RESERVED_IDS = (.+);$/m.exec(html)![1];
      const isValidNewId = new Function(`const ID_PATTERN = ${pattern}; const RESERVED_IDS = ${reserved};\n${source("isValidNewId")}\nreturn isValidNewId;`)() as (id: string) => boolean;
      const samples = ["openai/gpt-5", "qwen3:32b", "a@b", "a.b_c-d", "x".repeat(128), "x".repeat(129), "", "-x", ".x", "/x", "a//b", "a/", "a..b",
        "__proto__", "constructor", "prototype", "has space", "caf\u00e9", "tab\tid", "a\nb", "a#b", "a?b"];
      for (const id of samples) expect(isValidNewId(id), JSON.stringify(id)).toBe(isValidEntityId(id));
      expect(entityIdProblem("qwen3:32b")).toBeUndefined();
    });

    it("clears optional fields with _unset on a custom harness, and the writer drops them from the file", async () => {
      const auth = await session();
      const created = await mutate(auth, "PUT", harnessPath("dsh-custom"), {
        patch: { custom: true, driver: "dsh", display_name: "DSH custom", binary: "dsh", enabled: true, profile: "fast",
          default_upstream_provider: "deepseek", inherit_mcp: true, max_concurrency: 3, model_discovery: "wrapper" },
        revision: auth.state.snapshot.revision,
      });
      expect(created.status).toBe(200);
      expect(userToml().harnesses["dsh-custom"]).toMatchObject({ profile: "fast", inherit_mcp: true, max_concurrency: 3, model_discovery: "wrapper" });

      const cleared = await mutate(auth, "PUT", harnessPath("dsh-custom"), {
        patch: { _unset: ["profile", "inherit_mcp", "max_concurrency", "model_discovery"] }, revision: created.json().snapshot.revision,
      });
      expect(cleared.status).toBe(200);
      const harness = cleared.json().snapshot.harnesses["dsh-custom"];
      for (const key of ["profile", "inherit_mcp", "max_concurrency", "model_discovery"]) expect(harness[key], key).toBeUndefined();
      expect(harness.default_upstream_provider).toBe("deepseek");
      const stored = userToml().harnesses["dsh-custom"];
      expect(stored.profile).toBeUndefined();
      expect(stored._unset).toBeUndefined();

      const badUnset = await mutate(auth, "PUT", harnessPath("dsh-custom"), { patch: { _unset: "profile" }, revision: cleared.json().snapshot.revision });
      expect(badUnset.status).toBe(400);
    });

    it("supports a 3-state inherit_mcp and max_concurrency on a harness: inherit, true, false", async () => {
      const auth = await session();
      let revision = auth.state.snapshot.revision;
      const states: Array<[Record<string, unknown>, boolean | undefined]> = [
        [{ inherit_mcp: true, max_concurrency: 7 }, true],
        [{ inherit_mcp: false }, false],
        [{ _unset: ["inherit_mcp", "max_concurrency"] }, undefined],
      ];
      for (const [patch, expected] of states) {
        const reply = await mutate(auth, "PUT", harnessPath("codex"), { patch, revision });
        expect(reply.status, JSON.stringify(patch)).toBe(200);
        revision = reply.json().snapshot.revision;
        expect(reply.json().snapshot.harnesses.codex.inherit_mcp).toBe(expected);
      }
      const tooMany = await mutate(auth, "PUT", harnessPath("codex"), { patch: { max_concurrency: 65 }, revision });
      expect(tooMany.status).toBe(400);
    });

    it("POST /api/harnesses/:id/reset-field resets one overridden field of a built-in harness and keeps the others", async () => {
      const auth = await session();
      const baseline = auth.state.snapshot.harnesses.codex;
      const changed = await mutate(auth, "PUT", harnessPath("codex"), {
        patch: { display_name: "Codex (work)", max_concurrency: 4, model_discovery: "manual", profile: "work" }, revision: auth.state.snapshot.revision,
      });
      expect(changed.status).toBe(200);
      const reset = await mutate(auth, "POST", harnessPath("codex", "/reset-field"), { field: "max_concurrency", revision: changed.json().snapshot.revision });
      expect(reset.status).toBe(200);
      const codex = reset.json().snapshot.harnesses.codex;
      expect(codex.max_concurrency).toBeUndefined();
      expect(codex).toMatchObject({ display_name: "Codex (work)", model_discovery: "manual", profile: "work" });
      expect(userToml().harnesses.codex.max_concurrency).toBeUndefined();

      const lastFields = await mutate(auth, "POST", harnessPath("codex", "/reset-field"), { field: "model_discovery", revision: reset.json().snapshot.revision });
      const profileGone = await mutate(auth, "POST", harnessPath("codex", "/reset-field"), { field: "profile", revision: lastFields.json().snapshot.revision });
      const nameGone = await mutate(auth, "POST", harnessPath("codex", "/reset-field"), { field: "display_name", revision: profileGone.json().snapshot.revision });
      expect(nameGone.json().snapshot.harnesses.codex).toMatchObject({ display_name: baseline.display_name, provenance: "default" });
      expect(userToml().harnesses).toBeUndefined();

      const badField = await mutate(auth, "POST", harnessPath("codex", "/reset-field"), { field: "../x", revision: nameGone.json().snapshot.revision });
      expect(badField.status).toBe(400);
      const noField = await mutate(auth, "POST", harnessPath("codex", "/reset-field"), { revision: nameGone.json().snapshot.revision });
      expect(noField.status).toBe(400);
      const stale = await mutate(auth, "POST", harnessPath("codex", "/reset-field"), { field: "profile", revision: "old" });
      expect(stale.status).toBe(409);
    });

    it("clears an inherited optional field of a built-in harness with _unset, and reset-field brings the built-in value back", async () => {
      const auth = await session();
      const field = "write_permission_mode";
      const inherited = auth.state.defaults_catalog.harnesses.claude[field];
      expect(inherited).toBe("acceptEdits");
      const cleared = await mutate(auth, "PUT", harnessPath("claude"), { patch: { _unset: [field] }, revision: auth.state.snapshot.revision });
      expect(cleared.status).toBe(200);
      expect(cleared.json().snapshot.harnesses.claude[field]).toBeUndefined();
      expect(userToml().harnesses.claude._unset).toEqual([field]);
      const restored = await mutate(auth, "POST", harnessPath("claude", "/reset-field"), { field, revision: cleared.json().snapshot.revision });
      expect(restored.status).toBe(200);
      expect(restored.json().snapshot.harnesses.claude[field]).toEqual(inherited);
    });

    it("keeps field_provenance \"overridden\" for a built-in field cleared with _unset, so the page can offer Reset", async () => {
      const auth = await session();
      const field = "write_permission_mode";
      const cleared = await mutate(auth, "PUT", harnessPath("claude"), { patch: { _unset: [field] }, revision: auth.state.snapshot.revision });
      expect(cleared.status).toBe(200);
      for (const claude of [cleared.json().snapshot.harnesses.claude, (await send(port, "GET", "/api/state", authHeaders(auth))).json().snapshot.harnesses.claude]) {
        expect(claude[field]).toBeUndefined();
        expect(claude.field_provenance[field]).toBe("overridden");
      }
      const restored = await mutate(auth, "POST", harnessPath("claude", "/reset-field"), { field, revision: cleared.json().snapshot.revision });
      expect(restored.status).toBe(200);
      expect(restored.json().snapshot.harnesses.claude[field]).toBe("acceptEdits");
      expect(restored.json().snapshot.harnesses.claude.field_provenance[field]).not.toBe("overridden");

      // A built-in card may drop optional fields too (context_window and checked_at stay required there).
      const modelField = "cli_model";
      const modelCleared = await mutate(auth, "PUT", `/api/models/${encodeURIComponent(MODEL_ID)}`, { patch: { _unset: [modelField] }, revision: restored.json().snapshot.revision });
      expect(modelCleared.status).toBe(200);
      expect(modelCleared.json().snapshot.models[MODEL_ID].field_provenance[modelField]).toBe("overridden");
      expect(userToml().models[MODEL_ID]._unset).toEqual([modelField]);
      const modelRestored = await mutate(auth, "POST", `/api/models/${encodeURIComponent(MODEL_ID)}/reset-field`, { field: modelField, revision: modelCleared.json().snapshot.revision });
      expect(modelRestored.status).toBe(200);
      expect(modelRestored.json().snapshot.models[MODEL_ID][modelField]).toBe(auth.state.defaults_catalog.models[MODEL_ID][modelField]);
      expect(modelRestored.json().snapshot.models[MODEL_ID].field_provenance[modelField]).not.toBe("overridden");
    });

    it("clears cli_provider and vendor_family with _unset on a custom model and on a built-in model", async () => {
      const auth = await session();
      const created = await mutate(auth, "PUT", modelPath("custom-routed"), {
        patch: modelPatch("pi", { cli_model: "routed", cli_provider: "vendor", vendor_family: "acme" }), revision: auth.state.snapshot.revision,
      });
      expect(created.status).toBe(200);
      const cleared = await mutate(auth, "PUT", modelPath("custom-routed"), {
        patch: { _unset: ["cli_provider", "vendor_family"] }, revision: created.json().snapshot.revision,
      });
      expect(cleared.status).toBe(200);
      const custom = cleared.json().snapshot.models["custom-routed"];
      expect(custom.cli_provider).toBeUndefined();
      expect(custom.vendor_family).toBeUndefined();
      expect(custom.cli_model).toBe("routed");

      const overridden = await mutate(auth, "PUT", modelPath(MODEL_ID), { patch: { vendor_family: "acme" }, revision: cleared.json().snapshot.revision });
      expect(overridden.json().snapshot.models[MODEL_ID].vendor_family).toBe("acme");
      const reverted = await mutate(auth, "PUT", modelPath(MODEL_ID), { patch: { _unset: ["vendor_family"] }, revision: overridden.json().snapshot.revision });
      expect(reverted.status).toBe(200);
      expect(reverted.json().snapshot.models[MODEL_ID].vendor_family).toBe(auth.state.defaults_catalog.models[MODEL_ID].vendor_family);
      expect(reverted.json().snapshot.models[MODEL_ID].provenance).toBe("default");
    });

    it("rejects an empty cli_model and accepts a discovered card without context_window or checked_at", async () => {
      const auth = await session();
      const empty = await mutate(auth, "PUT", modelPath("blank-cli"), { patch: modelPatch("codex", { cli_model: "" }), revision: auth.state.snapshot.revision });
      expect(empty.status).toBe(400);
      const { context_window: _context, checked_at: _checked, ...facts } = modelPatch("codex");
      const reviewedOnly = await mutate(auth, "PUT", modelPath("no-facts"), { patch: facts, revision: auth.state.snapshot.revision });
      expect(reviewedOnly.status).toBe(400);
      const discovered = await mutate(auth, "PUT", modelPath("found-one"), {
        patch: { ...facts, source: "discovered" }, revision: auth.state.snapshot.revision,
      });
      expect(discovered.status).toBe(200);
      const card = discovered.json().snapshot.models["found-one"];
      expect(card.context_window).toBeUndefined();
      expect(card.checked_at).toBeUndefined();
      expect(card.is_stale).toBe(false);
    });
  });

  describe("single-instance lock", () => {
    const options = () => ({ port: 0, openBrowser: false, configManager: manager, adapterRegistry: registry });
    let lockDir: string;
    const closers: Array<() => Promise<void>> = [];

    beforeEach(() => {
      lockDir = join(dir, "other-locks");
      mkdirSync(lockDir, { recursive: true });
    });

    afterEach(async () => {
      for (const close of closers.splice(0)) await close();
    });

    function plantHolder(holder: Record<string, unknown>): void {
      writeFileSync(join(lockDir, "settings-ui.lock"), JSON.stringify({ started_at: new Date().toISOString(), ...holder }));
    }

    async function listeningPort(): Promise<number> {
      const server = createTcpServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      closers.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
      return (server.address() as { port: number }).port;
    }

    async function unusedPort(): Promise<number> {
      const server = createTcpServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as { port: number };
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
      return port;
    }

    it("treats a live pid whose recorded port nothing listens on as a stale lock", async () => {
      // pid 1 is alive for any caller (EPERM or success): exactly the recycled-pid case after a crash or reboot.
      plantHolder({ pid: 1, port: await unusedPort() });
      const second = await startSettingsUi({ ...options(), lockDir });
      closers.push(() => second.close());
      expect(second.port).toBeGreaterThan(0);
      expect(JSON.parse(readFileSync(join(lockDir, "settings-ui.lock"), "utf8"))).toMatchObject({ pid: process.pid, port: second.port });
    });

    it("still refuses to start when the live holder's recorded port accepts connections", async () => {
      const port = await listeningPort();
      plantHolder({ pid: process.ppid, port });
      await expect(startSettingsUi({ ...options(), lockDir })).rejects.toThrow(new RegExp(`already running.*127\\.0\\.0\\.1:${port}`));
    });

    it("trusts a live pid that has not recorded a port yet", async () => {
      plantHolder({ pid: process.ppid });
      await expect(startSettingsUi({ ...options(), lockDir })).rejects.toThrow(/already running/);
    });

    it("takes over a lock whose pid no longer exists", async () => {
      plantHolder({ pid: 2 ** 22 + 12_345, port: await listeningPort() });
      const second = await startSettingsUi({ ...options(), lockDir });
      closers.push(() => second.close());
      expect(second.port).toBeGreaterThan(0);
    });

    it("lets exactly one of two concurrent starts reclaim a stale lock, and never deletes the winner's live lock", async () => {
      plantHolder({ pid: 2 ** 22 + 12_345, token: "dead-owner" });
      const starts = await Promise.allSettled([startSettingsUi({ ...options(), lockDir }), startSettingsUi({ ...options(), lockDir })]);
      const winners = starts.filter((result): result is PromiseFulfilledResult<SettingsUiHandle> => result.status === "fulfilled");
      const losers = starts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      for (const winner of winners) closers.push(() => winner.value.close());
      expect(winners).toHaveLength(1);
      expect(String(losers[0].reason)).toMatch(/already running|currently starting/);
      const held = JSON.parse(readFileSync(join(lockDir, "settings-ui.lock"), "utf8"));
      expect(held).toMatchObject({ pid: process.pid, port: winners[0].value.port });
      expect(held.token).toMatch(/^[0-9a-f]{32}$/);
      expect(existsSync(join(lockDir, "settings-ui.lock.reclaim"))).toBe(false);
    });

    it("recovers from a reclaim guard left behind by a crashed starter once it is old enough", async () => {
      plantHolder({ pid: 2 ** 22 + 12_345 });
      const guard = join(lockDir, "settings-ui.lock.reclaim");
      writeFileSync(guard, "");
      const longAgo = new Date(Date.now() - 60_000);
      utimesSync(guard, longAgo, longAgo);
      const second = await startSettingsUi({ ...options(), lockDir });
      closers.push(() => second.close());
      expect(second.port).toBeGreaterThan(0);
      expect(existsSync(guard)).toBe(false);
    });

    it("does not reclaim a stale lock while a fresh reclaim guard shows another starter is doing it", async () => {
      plantHolder({ pid: 2 ** 22 + 12_345 });
      writeFileSync(join(lockDir, "settings-ui.lock.reclaim"), "");
      await expect(startSettingsUi({ ...options(), lockDir })).rejects.toThrow(/currently starting/);
    });

    it("removes only a lock it still owns: a lock rewritten by another owner survives shutdown", async () => {
      const handle = await startSettingsUi({ ...options(), lockDir });
      const lockPath = join(lockDir, "settings-ui.lock");
      const mine = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(mine.token).toMatch(/^[0-9a-f]{32}$/);
      writeFileSync(lockPath, JSON.stringify({ ...mine, token: "another-owner" }));
      await handle.close();
      expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("another-owner");
    });
  });
});

describe("settings UI idle shutdown", () => {
  it("closes itself after the idle timeout and releases its lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-settings-idle-"));
    try {
      const manager = new ConfigManager({ defaultPath: DEFAULT_CATALOG, userPath: join(dir, "models.toml") });
      const ui = await startSettingsUi({
        port: 0, openBrowser: false, idleTimeoutMs: 150, configManager: manager,
        adapterRegistry: new MockRegistry(), lockDir: join(dir, "locks"),
      });
      expect(existsSync(join(dir, "locks", "settings-ui.lock"))).toBe(true);
      await ui.waitUntilClosed;
      expect(existsSync(join(dir, "locks", "settings-ui.lock"))).toBe(false);
      await expect(send(ui.port, "GET", "/")).rejects.toThrow();
      await ui.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not treat favicon requests as activity, so a browser tab asking for its icon cannot keep the server alive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orch-settings-idle-"));
    try {
      const manager = new ConfigManager({ defaultPath: DEFAULT_CATALOG, userPath: join(dir, "models.toml") });
      const ui = await startSettingsUi({
        port: 0, openBrowser: false, idleTimeoutMs: 300, configManager: manager,
        adapterRegistry: new MockRegistry(), lockDir: join(dir, "locks"),
      });
      let closed = false;
      void ui.waitUntilClosed.then(() => { closed = true; });
      const deadline = Date.now() + 5000;
      while (!closed && Date.now() < deadline) {
        await send(ui.port, "GET", "/favicon.svg").catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(closed).toBe(true);
      await ui.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("settings UI drawer field reset", () => {
  const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");

  function functionSource(name: string): string {
    const match = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m").exec(html);
    expect(match, `function ${name} must exist in app.html`).not.toBeNull();
    return match![0];
  }

  function loadPageHelpers() {
    const state = { drawer: null as any, snap: null as any };
    const calls = { render: 0, closeDrawer: [] as unknown[] };
    const names = ["strip", "diff", "rebaseObject", "rebaseRoles", "rebaseEntityDraft", "applyFieldReset"];
    const factory = new Function("state", "render", "closeDrawer",
      `const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const META_KEYS = new Set(["provenance", "field_provenance", "default_changed", "is_stale", "_base_hash", "custom"]);
const SECTION_OF = { model: "models", harness: "harnesses", preset: "presets" };
${names.map(functionSource).join("\n")}
return { applyFieldReset, rebaseEntityDraft };`);
    const helpers = factory(state, () => { calls.render++; }, (force: unknown) => { calls.closeDrawer.push(force); }) as {
      applyFieldReset: (drawer: unknown, key: string) => void;
    };
    return { state, calls, ...helpers };
  }

  it.each(["model", "harness"] as const)("keeps unsaved edits of the other %s fields and takes only the reset field from the server", (kind) => {
    const { state, calls, applyFieldReset } = loadPageHelpers();
    const section = kind === "model" ? "models" : "harnesses";
    state.snap = { [section]: { x: { provenance: "overridden", display_name: "Default", tier: "deep", cost_note: "server note" } } };
    const drawer = {
      kind, id: "x", isNew: false, conflicts: ["stale"],
      original: { display_name: "Default", tier: "light", cost_note: "server note" },
      draft: { display_name: "Typed but unsaved", tier: "standard", cost_note: "server note" },
    };
    state.drawer = drawer;

    applyFieldReset(drawer, "tier");

    expect(drawer.draft).toEqual({ display_name: "Typed but unsaved", tier: "deep", cost_note: "server note" });
    expect(drawer.original).toEqual({ display_name: "Default", tier: "deep", cost_note: "server note" });
    expect(drawer.conflicts).toEqual([]);
    expect(calls.render).toBe(1);
    expect(calls.closeDrawer).toEqual([]);
    // Only the typed display_name remains a pending change.
    expect(Object.keys(drawer.draft).filter((key) => (drawer.draft as any)[key] !== (drawer.original as any)[key])).toEqual(["display_name"]);
  });

  it("drops a reset field that the server no longer stores, closes a drawer whose entity vanished, and ignores a replaced drawer", () => {
    const { state, calls, applyFieldReset } = loadPageHelpers();
    state.snap = { models: { x: { display_name: "Default" } } };
    const drawer = { kind: "model", id: "x", isNew: false, conflicts: [], original: { display_name: "Default", note: "a" },
      draft: { display_name: "Default", note: "typed" } };
    state.drawer = drawer;
    applyFieldReset(drawer, "note");
    expect(drawer.draft).toEqual({ display_name: "Default" });

    state.snap = { models: {} };
    applyFieldReset(drawer, "note");
    expect(calls.closeDrawer).toEqual([true]);

    const renders = calls.render;
    state.drawer = { ...drawer };
    applyFieldReset(drawer, "note");
    expect(calls.render).toBe(renders);
  });

  it.each([["model", "m", "efforts"], ["harness", "h", "extra_args"]] as const)(
    "a %s field reset discards that field's pending add-input text so Save cannot re-append it",
    (kind, initial, key) => {
      const { state, applyFieldReset } = loadPageHelpers();
      const section = kind === "model" ? "models" : "harnesses";
      state.snap = { [section]: { x: { provenance: "overridden", [key]: ["default"] } } };
      const commit = () => true;
      const drawer = {
        kind, id: "x", isNew: false, conflicts: [], original: { [key]: ["custom"] }, draft: { [key]: ["custom"] },
        pending: { [`${initial}-${key}`]: { text: "stale-typed", commit }, [`${initial}-other`]: { text: "keep me", commit } },
      };
      state.drawer = drawer;

      applyFieldReset(drawer, key);

      expect(drawer.draft).toEqual({ [key]: ["default"] });
      expect(Object.keys(drawer.pending)).toEqual([`${initial}-other`]);
    },
  );

  it("wires the per-field reset of models and harnesses to the rebase instead of reopening the drawer", () => {
    for (const editor of [functionSource("modelEditor"), functionSource("harnessEditor")]) {
      expect(editor).toContain("applyFieldReset(drawer, key)");
      expect(editor).not.toMatch(/\.then\(\(ok\) => ok && openDrawer\(/);
    }
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });
});

describe("settings UI page behavior (functions extracted from app.html)", () => {
  const html = readFileSync(new URL("../../src/settings-ui/app.html", import.meta.url), "utf8");

  function functionSource(name: string): string {
    const match = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m").exec(html);
    expect(match, `function ${name} must exist in app.html`).not.toBeNull();
    return match![0];
  }

  /** The smallest DOM that the page's `h()` call sites need: tree, attributes, classes, `on*` handlers. */
  class FakeNode {
    attrs = new Map<string, string>();
    classes = new Set<string>();
    children: FakeNode[] = [];
    handlers: Record<string, (event: any) => void> = {};
    hidden = false;
    disabled = false;
    isConnected = true;
    offsetHeight = 100;
    focused = 0;
    text = "";
    constructor(public tag: string, public props: Record<string, any>) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === false || value === undefined) continue;
        if (key.startsWith("on") && typeof value === "function") this.handlers[key] = value;
        else if (key === "class") String(value).split(/\s+/).filter(Boolean).forEach((name) => this.classes.add(name));
        else if (key === "text") this.text = String(value);
        else if (key === "hidden") this.hidden = Boolean(value);
        else if (key === "disabled") this.disabled = Boolean(value);
        else this.attrs.set(key, String(value));
      }
    }
    classList = {
      add: (name: string) => { this.classes.add(name); },
      remove: (name: string) => { this.classes.delete(name); },
      toggle: (name: string, force?: boolean) => { (force ?? !this.classes.has(name)) ? this.classes.add(name) : this.classes.delete(name); },
      contains: (name: string) => this.classes.has(name),
    };
    get id(): string { return this.attrs.get("id") ?? ""; }
    setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
    removeAttribute(name: string): void { this.attrs.delete(name); }
    getAttribute(name: string): string | undefined { return this.attrs.get(name); }
    contains(node: unknown): boolean { return node === this || this.children.some((child) => child.contains(node)); }
    focus(): void { this.focused++; }
    scrollIntoView(): void {}
    getBoundingClientRect() { return { top: 500, bottom: 534 }; }
    showPopover(): void { this.attrs.set("popover-open", "true"); }
    hidePopover(): void { this.attrs.delete("popover-open"); }
    matches(selector: string): boolean { return selector === ":popover-open" && this.attrs.has("popover-open"); }
    descendants(): FakeNode[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
    allText(): string { return [this.text, ...this.children.map((child) => child.allText())].join(" ").replace(/\s+/g, " ").trim(); }
    find(predicate: (node: FakeNode) => boolean): FakeNode | undefined { return this.descendants().find(predicate); }
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

  function key(trigger: FakeNode, name: string, extra: Record<string, unknown> = {}) {
    const event = { key: name, ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...extra };
    trigger.handlers.onkeydown!(event);
    return event;
  }

  describe.each([{ anchored: true }, { anchored: false }])("selectBox combobox (anchor positioning: $anchored)", ({ anchored }) => {
    type SelectApi = { selectBox: (...args: unknown[]) => FakeNode; closeActiveSelect: () => void };
    function build(options: unknown[], value: string | undefined, opts: Record<string, unknown> = {}, shared?: SelectApi) {
      const changes: string[] = [];
      const listeners = new Map<string, number>();
      const registered = new Map<string, (event: unknown) => void>();
      const documentStub = {
        addEventListener: (name: string, handler: (event: unknown) => void) => {
          registered.set(name, handler);
          listeners.set(name, (listeners.get(name) ?? 0) + 1);
        },
        removeEventListener: (name: string) => listeners.set(name, (listeners.get(name) ?? 0) - 1),
      };
      const windowStub = { ...documentStub, innerHeight: 800 };
      const factory = shared ? null : new Function("h", "icon", "t", "document", "window", "performance", "SUPPORTS_POPOVER_ANCHOR",
        "SELECT_TYPEAHEAD_MS", "SELECT_SCROLL_GUARD_MS", "setTimeout", "clearTimeout",
        `let activeSelect = null; let selectSeq = 0;
${functionSource("swallowNextClick")}
${functionSource("closeActiveSelect")}
${functionSource("selectBox")}
return { selectBox, closeActiveSelect };`);
      const api = shared ?? factory!(
        fakeH, (name: string) => fakeH("svg", { "data-icon": name }),
        (text: string, ...values: unknown[]) => text.replace(/\{(\d+)\}/g, (_m, index) => String(values[Number(index)])),
        documentStub, windowStub, { now: () => 0 }, anchored, 700, 0, () => 0, () => {},
      ) as SelectApi;
      const wrap = api.selectBox(options, value, (next: string) => changes.push(next), { fk: "fk-test", label: "Tier", ...opts });
      return { ...api, wrap, changes, listeners, registered, trigger: wrap.children[0]!, menu: wrap.children[1]! };
    }

    it("renders an ARIA select-only combobox with a listbox, never a native <select>", () => {
      const { wrap, trigger, menu } = build([["light", "Light"], ["deep", "Deep"]], "deep");
      expect(wrap.find((node) => node.tag === "select")).toBeUndefined();
      expect(trigger.tag).toBe("button");
      expect(trigger.attrs.get("role")).toBe("combobox");
      expect(trigger.attrs.get("aria-haspopup")).toBe("listbox");
      expect(trigger.attrs.get("aria-expanded")).toBe("false");
      expect(trigger.attrs.get("aria-controls")).toBe(menu.id);
      expect(trigger.attrs.get("aria-label")).toBe("Tier");
      expect(trigger.allText()).toBe("Deep");
      expect(menu.attrs.get("role")).toBe("listbox");
      expect(menu.attrs.get("popover")).toBe(anchored ? "manual" : undefined);
      expect(menu.hidden).toBe(!anchored);
      const options = menu.children;
      expect(options.map((option) => option.attrs.get("role"))).toEqual(["option", "option"]);
      expect(options.map((option) => option.attrs.get("aria-selected"))).toEqual(["false", "true"]);
    });

    it("opens with the arrow keys, steps, jumps, and commits only the chosen value", () => {
      const { trigger, menu, changes } = build([["a", "Alpha"], ["b", "Beta"], ["c", "Gamma"]], "a");
      expect(key(trigger, "ArrowDown").defaultPrevented).toBe(true);
      expect(trigger.attrs.get("aria-expanded")).toBe("true");
      expect(anchored ? menu.attrs.has("popover-open") : !menu.hidden).toBe(true);
      expect(trigger.attrs.get("aria-activedescendant")).toBe(menu.children[0]!.id);
      key(trigger, "ArrowDown");
      key(trigger, "ArrowDown");
      key(trigger, "ArrowDown"); // clamps at the last option
      expect(trigger.attrs.get("aria-activedescendant")).toBe(menu.children[2]!.id);
      key(trigger, "Home");
      expect(trigger.attrs.get("aria-activedescendant")).toBe(menu.children[0]!.id);
      key(trigger, "End");
      key(trigger, "ArrowUp");
      expect(trigger.attrs.get("aria-activedescendant")).toBe(menu.children[1]!.id);
      expect(changes).toEqual([]);
      key(trigger, "Enter");
      expect(changes).toEqual(["b"]);
      expect(trigger.attrs.get("aria-expanded")).toBe("false");
      expect(trigger.attrs.has("aria-activedescendant")).toBe(false);
      expect(trigger.focused).toBeGreaterThan(0);
    });

    it("Escape closes only the list (and stops there), choosing nothing; Tab commits without taking focus back", () => {
      const { trigger, changes } = build([["a", "Alpha"], ["b", "Beta"]], "a");
      key(trigger, "ArrowDown");
      key(trigger, "ArrowDown");
      const escape = key(trigger, "Escape");
      expect(escape.propagationStopped).toBe(true);
      expect(trigger.attrs.get("aria-expanded")).toBe("false");
      expect(changes).toEqual([]);

      key(trigger, "ArrowDown");
      key(trigger, "ArrowDown");
      const focusBefore = trigger.focused;
      key(trigger, "Tab");
      expect(changes).toEqual(["b"]);
      expect(trigger.focused).toBe(focusBefore);
      expect(trigger.attrs.get("aria-expanded")).toBe("false");
    });

    it("supports typeahead from a closed trigger and ignores Ctrl/Meta shortcuts such as Ctrl+S", () => {
      const { trigger, menu, changes } = build([["a", "Alpha"], ["b", "Beta"], ["g", "Gamma"]], "a");
      const save = key(trigger, "s", { ctrlKey: true });
      expect(save.defaultPrevented).toBe(false);
      expect(trigger.attrs.get("aria-expanded")).toBe("false");
      key(trigger, "g");
      expect(trigger.attrs.get("aria-expanded")).toBe("true");
      expect(trigger.attrs.get("aria-activedescendant")).toBe(menu.children[2]!.id);
      key(trigger, "Enter");
      expect(changes).toEqual(["g"]);
    });

    it("commits a pointer click, does not call onChange for the current value, and cleans its global listeners on close", () => {
      const { trigger, menu, changes, listeners } = build([["a", "Alpha"], ["b", "Beta"]], "a");
      trigger.handlers.onclick!({});
      expect(listeners.get("pointerdown")).toBe(1);
      expect(listeners.get("scroll")).toBe(1);
      menu.children[0]!.handlers.onclick!({});
      expect(changes).toEqual([]);
      expect([...listeners.values()]).toEqual([0, 0, 0]);
      trigger.handlers.onclick!({});
      menu.children[1]!.handlers.onclick!({});
      expect(changes).toEqual(["b"]);
    });

    it("a press on the field's own label does not close the list through the trigger blur, so the label click toggles it", () => {
      const { trigger, registered } = build([["a", "Alpha"], ["b", "Beta"]], "a");
      trigger.handlers.onclick!({});
      registered.get("pointerdown")!({ target: { id: "", closest: () => ({ htmlFor: "fk-test" }) } });
      trigger.handlers.onblur!({});
      expect(trigger.attrs.get("aria-expanded")).toBe("true");
      trigger.handlers.onclick!({}); // the label's synthesized click
      expect(trigger.attrs.get("aria-expanded")).toBe("false");
      // A plain blur (focus moved elsewhere) still closes the list.
      trigger.handlers.onclick!({});
      trigger.handlers.onblur!({});
      expect(trigger.attrs.get("aria-expanded")).toBe("false");
    });

    it("keeps one list open at a time and closes it through closeActiveSelect (used before every re-render)", () => {
      const first = build([["a", "A"], ["b", "B"]], "a");
      const second = build([["x", "X"], ["y", "Y"]], "x", {}, first);
      first.trigger.handlers.onclick!({});
      expect(first.trigger.attrs.get("aria-expanded")).toBe("true");
      second.trigger.handlers.onclick!({});
      expect(first.trigger.attrs.get("aria-expanded")).toBe("false");
      expect(second.trigger.attrs.get("aria-expanded")).toBe("true");
      first.closeActiveSelect();
      expect(second.trigger.attrs.get("aria-expanded")).toBe("false");
    });

    it("shows an unavailable stored value, a placeholder for an unset one, and disables an empty list", () => {
      const stale = build([["a", "Alpha"]], "gone");
      expect(stale.trigger.allText()).toBe("gone (unavailable)");
      expect(stale.menu.children).toHaveLength(2);
      const unset = build([["a", "Alpha"]], undefined);
      expect(unset.trigger.allText()).toBe("Select…");
      const empty = build([], "");
      expect(empty.trigger.disabled).toBe(true);
      expect(empty.trigger.allText()).toBe("No options available");
      const disabled = build([["a", "Alpha"]], "a", { disabled: true });
      expect(disabled.trigger.disabled).toBe(true);
    });
  });

  it("limitsSaveBar is persistent: clean shows 'All changes saved' with Save disabled; dirty shows the count, Discard and an enabled Save", () => {
    const state = { busy: false, limitsDraft: {} };
    let patch: Record<string, unknown> = {};
    let problems: Record<string, string> = {};
    const factory = new Function("h", "icon", "t", "button", "state", "limitsChanges", "blockingLimitsErrors", "discardLimits", "saveLimits", "SAVE_SHORTCUT",
      `${functionSource("limitsSaveBar")}\nreturn limitsSaveBar;`);
    const limitsSaveBar = factory(
      fakeH, (name: string) => fakeH("svg", { "data-icon": name }),
      (text: string, ...values: unknown[]) => text.replace(/\{(\d+)\}/g, (_m, index) => String(values[Number(index)])),
      (label: string, props: Record<string, any>) => fakeH("button", { ...props, text: label, class: props.cls }),
      state, () => patch, () => problems, () => {}, () => {}, "Ctrl+S",
    ) as () => FakeNode;

    let bar = limitsSaveBar();
    expect(bar.attrs.get("role")).toBe("region");
    expect(bar.classes.has("is-dirty")).toBe(false);
    expect(bar.allText()).toContain("All changes saved");
    expect(bar.find((node) => node.attrs.get("data-fk") === "limits-save")!.disabled).toBe(true);
    expect(bar.find((node) => node.attrs.get("data-fk") === "limits-discard")).toBeUndefined();

    patch = { max_concurrency: 4, max_queue_size: 9 };
    bar = limitsSaveBar();
    expect(bar.classes.has("is-dirty")).toBe(true);
    expect(bar.classes.has("is-invalid")).toBe(false);
    expect(bar.allText()).toContain("Unsaved changes (2)");
    expect(bar.find((node) => node.attrs.get("data-fk") === "limits-save")!.disabled).toBe(false);
    expect(bar.find((node) => node.attrs.get("data-fk") === "limits-discard")).toBeDefined();

    problems = { max_queue_size: "Must be at least 1" };
    bar = limitsSaveBar();
    expect(bar.classes.has("is-invalid")).toBe(true);
    expect(bar.allText()).toContain("Fix the highlighted fields before saving.");
    expect(bar.allText()).toContain("Must be at least 1");

    state.busy = true;
    bar = limitsSaveBar();
    expect(bar.allText()).toContain("Saving…");
    expect(bar.find((node) => node.attrs.get("data-fk") === "limits-save")!.disabled).toBe(true);
  });

  it("pageHead renders the save-rule cue only when asked, and Models, Harnesses and Presets ask for it", () => {
    const factory = new Function("h", "icon", "t", `${functionSource("pageHead")}\nreturn pageHead;`);
    const pageHead = factory(fakeH, () => fakeH("svg", {}), (text: string) => text) as (...args: unknown[]) => FakeNode;
    const cue = "Switches save immediately. Open an entry to edit and save its settings.";
    expect(pageHead("Models", "sub", [], { saveRule: true }).allText()).toContain(cue);
    expect(pageHead("Limits", "sub", []).allText()).not.toContain(cue);
    expect(html.match(/saveRule: true/g)).toHaveLength(3);
    expect(html).toContain("Reset and delete apply immediately, after you confirm.");
  });

  describe("deleting an entity while its drawer is open", () => {
    function load(options: { confirm: boolean; entityGoneAfter: boolean; replaceDrawer?: boolean }) {
      const calls = { render: 0, restore: [] as unknown[], opened: [] as unknown[], toasts: [] as unknown[] };
      const drawer = { kind: "model", id: "x", isNew: false };
      const state: any = {
        busy: false, drawer, drawerReturn: { from: "matrix" },
        snap: { revision: "r1", models: { x: {} }, harnesses: {}, presets: {} },
      };
      const api = async () => {
        if (options.replaceDrawer) state.drawer = { kind: "model", id: "y", isNew: true };
        return { snapshot: { revision: "r2", models: options.entityGoneAfter ? {} : { x: {} }, harnesses: {}, presets: {} } };
      };
      const document = { body: { setAttribute() {}, removeAttribute() {} }, activeElement: {} };
      const factory = new Function(
        "state", "api", "document", "captureFocus", "syncSaveUi", "rebaseLimitsDraft", "toast", "syncDraftsAfterConflict", "normalizeFilters",
        "syncUrl", "render", "restoreDrawerReturn", "restoreFocus", "confirmDialog", "openDrawer", "t", "SECTION_OF",
        `${["mutate", "isDiscoveryDrawer", "drawerEntityIsGone", "abortDiscoveryScan", "detachDrawer", "resetEntity"].map(functionSource).join("\n")}\nreturn resetEntity;`);
      const resetEntity = factory(
        state, api, document, () => null, () => {}, () => {}, (...args: unknown[]) => calls.toasts.push(args), () => [], () => {},
        () => {}, () => { calls.render++; }, (back: unknown) => calls.restore.push(back), () => {},
        async () => options.confirm, (...args: unknown[]) => calls.opened.push(args), (text: string) => text,
        { model: "models", harness: "harnesses", preset: "presets" },
      ) as (kind: string, id: string, isCustom: boolean, name: string) => Promise<void>;
      return { state, calls, resetEntity, drawer };
    }

    it("closes the drawer of a deleted custom entry without crashing, restores the previous view and does not reopen it", async () => {
      const { state, calls, resetEntity } = load({ confirm: true, entityGoneAfter: true });
      await resetEntity("model", "x", true, "X");
      expect(state.drawer).toBeNull();
      expect(state.drawerReturn).toBeNull();
      expect(calls.restore).toEqual([{ from: "matrix" }]);
      expect(calls.opened).toEqual([]);
      expect(calls.render).toBe(1);
      expect(state.busy).toBe(false);
    });

    it("reopens the drawer with the fresh values after a built-in reset, and does nothing when the user declines", async () => {
      const reset = load({ confirm: true, entityGoneAfter: false });
      await reset.resetEntity("model", "x", false, "X");
      expect(reset.state.drawer).toBe(reset.drawer);
      expect(reset.calls.opened).toEqual([["model", "x"]]);
      expect(reset.calls.restore).toEqual([]);

      const declined = load({ confirm: false, entityGoneAfter: true });
      await declined.resetEntity("model", "x", true, "X");
      expect(declined.state.drawer).toBe(declined.drawer);
      expect(declined.calls.render).toBe(0);
    });

    it("leaves a drawer that the user replaced during the request alone", async () => {
      const { state, calls, resetEntity } = load({ confirm: true, entityGoneAfter: false, replaceDrawer: true });
      await resetEntity("model", "x", false, "X");
      expect(state.drawer).toMatchObject({ id: "y", isNew: true });
      expect(calls.opened).toEqual([]);
    });
  });
  describe("Wave 1B: custom harness and model editors", () => {
    const t = (text: string, ...values: unknown[]) => text.replace(/\{(\d+)\}/g, (_m, index) => String(values[Number(index)]));
    const icon = (name: string) => fakeH("svg", { "data-icon": name });
    const iconButton = (name: string, label: string, props: Record<string, any> = {}) =>
      fakeH("button", { ...props, class: props.cls ?? "icon-btn", "aria-label": label, "data-icon": name });
    const button = (label: string, props: Record<string, any> = {}) => fakeH("button", { ...props, class: props.cls ?? "btn", text: label });
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const DRIVER_META = {
      claude: { label: "Claude Code", defaultEfforts: ["low", "medium", "high"], effortSupport: "native", writePermissionModes: ["acceptEdits", "auto"] },
      codex: { label: "Codex CLI", supportsProfile: true, defaultEfforts: ["low", "medium", "high"], effortSupport: "native" },
      gemini: { label: "Gemini CLI", defaultEfforts: ["default"], effortSupport: "none", writePermissionModes: ["auto_edit", "yolo"] },
      opencode: { label: "OpenCode", usesCliProvider: true, requiresProviderPrefix: true, defaultEfforts: ["default"], effortSupport: "model-variant" },
      antigravity: { label: "Antigravity", defaultEfforts: ["low", "medium", "high"], effortSupport: "native", writePermissionModes: ["accept-edits", "auto"] },
    };

    /** Builds the named page functions with the shared constants and the given extra dependencies in scope. */
    function load<T>(names: string[], deps: Record<string, unknown> = {}, ret = names.join(", ")): T {
      const keys = Object.keys(deps);
      const prelude = `const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ID_PATTERN = ${/^const ID_PATTERN = (.+);$/m.exec(html)![1]};
const RESERVED_IDS = ${/^const RESERVED_IDS = (.+);$/m.exec(html)![1]};
const FALLBACK_EFFORTS = ["low", "medium", "high"];
const EFFORT_SUGGESTIONS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const MAX_LISTED_IDS = 8;
const MAX_CONCURRENCY_LIMIT = 64;
const MODEL_OPTIONAL_KEYS = ["cli_model", "cli_provider", "vendor_family", "context_window", "checked_at"];
const HARNESS_OPTIONAL_KEYS = ["profile", "default_upstream_provider", "write_permission_mode", "inherit_mcp", "max_concurrency", "model_discovery"];
const inheritMcpValue = (value) => (value === true ? "true" : value === false ? "false" : "");
const parseInheritMcp = (value) => (value === "true" ? true : value === "false" ? false : undefined);`;
      return new Function(...keys, `${prelude}\n${names.map(functionSource).join("\n")}\nreturn { ${ret} };`)(...keys.map((key) => deps[key])) as T;
    }

    function pageState(extra: Record<string, unknown> = {}) {
      return {
        driverMeta: DRIVER_META,
        snap: {
          defaults: { inherit_mcp: false, default_harness_concurrency: 5 },
          harnesses: { claude: { driver: "claude" }, gem: { driver: "gemini" }, oc: { driver: "opencode" } },
          models: {}, presets: {}, quarantined: [], config_warnings: [],
        },
        harnessFilter: "all",
        ...extra,
      } as any;
    }

    describe("argvEditor", () => {
      function build(items: string[]) {
        const changes: Array<[string[], boolean | undefined]> = [];
        const pending = new Map<string, () => boolean>();
        const cleared: string[] = [];
        const { argvEditor } = load<{ argvEditor: (...args: unknown[]) => FakeNode }>(["argvEditor"], {
          h: fakeH, iconButton, button, t,
          clearPending: (fk: string) => cleared.push(fk),
          trackPending: (fk: string, _input: unknown, commit: () => boolean) => pending.set(fk, commit),
        });
        const root = argvEditor(items, (next: string[], rerender?: boolean) => changes.push([next, rerender]), { fk: "h-extra_args", placeholder: "--flag or value, Enter" });
        const rows = root.children.filter((node) => node.classes.has("argv-row"));
        const adderRow = root.children.find((node) => node.classes.has("input-row"))!;
        const adder = adderRow.children[0] as any;
        return { root, rows, adder, addButton: adderRow.children[1], changes, pending, cleared };
      }
      const rowInput = (row: FakeNode) => row.children[0] as any;
      const rowButton = (row: FakeNode, label: string) => row.children.find((node) => node.attrs.get("aria-label") === label)!;

      it("renders one input row per token and never splits a token on a comma", () => {
        const { rows } = build(["--enabled-tools", "a,b"]);
        expect(rows.map((row) => rowInput(row).value)).toEqual(["--enabled-tools", "a,b"]);
        expect(rows.map((row) => rowInput(row).attrs.get("data-fk"))).toEqual(["h-extra_args-0", "h-extra_args-1"]);
      });

      it("keeps a typed comma inside the token and reports in-place edits without a re-render", () => {
        const { rows, changes } = build(["--enabled-tools", "a"]);
        rowInput(rows[1]).handlers.oninput({ target: { value: "a,b" } });
        expect(changes).toEqual([[["--enabled-tools", "a,b"], false]]);
      });

      it("adds on Enter with duplicates allowed and without splitting commas", () => {
        const { adder, changes, cleared } = build(["-c", "a=1"]);
        adder.value = "-c";
        const event = key(adder, "Enter", { target: adder });
        expect(event.defaultPrevented).toBe(true);
        adder.value = "--enabled-tools a,b";
        key(adder, "Enter", { target: adder });
        expect(changes.map(([items]) => items)).toEqual([["-c", "a=1", "-c"], ["-c", "a=1", "--enabled-tools a,b"]]);
        expect(changes.every(([, rerender]) => rerender === true)).toBe(true);
        expect(cleared).toEqual(["h-extra_args", "h-extra_args"]);
        // A comma key is plain text here, not a separator.
        const comma = key(adder, "Backspace", { target: { value: "" } });
        expect(comma.defaultPrevented).toBe(false);
      });

      it("ignores Enter on empty text and keeps the typed text pending for Save through trackPending", () => {
        const { adder, changes, pending, addButton } = build(["x"]);
        adder.value = "";
        const event = key(adder, "Enter", { target: adder });
        expect(event.defaultPrevented).toBe(false);
        expect(changes).toEqual([]);
        expect([...pending.keys()]).toEqual(["h-extra_args"]);
        expect(pending.get("h-extra_args")!()).toBe(true);
        expect(changes).toEqual([]);
        adder.value = " -c ";
        expect(pending.get("h-extra_args")!()).toBe(true);
        expect(changes).toEqual([[["x", " -c "], true]]);
        adder.value = "--dup";
        addButton.handlers.onclick({});
        expect(changes.at(-1)).toEqual([["x", "--dup"], true]);
      });

      it("reorders with up and down buttons, disables them at the ends, and removes a row", () => {
        const { rows, changes } = build(["-c", "k=v", "--add-dir", "a"]);
        expect(rowButton(rows[0], "Move up").disabled).toBe(true);
        expect(rowButton(rows[3], "Move down").disabled).toBe(true);
        expect(rowButton(rows[1], "Move up").disabled).toBe(false);
        rowButton(rows[0], "Move down").handlers.onclick({});
        rowButton(rows[3], "Move up").handlers.onclick({});
        rowButton(rows[1], "Remove item").handlers.onclick({});
        expect(changes.map(([items]) => items)).toEqual([
          ["k=v", "-c", "--add-dir", "a"], ["-c", "k=v", "a", "--add-dir"], ["-c", "--add-dir", "a"],
        ]);
      });

      it("allows duplicate flags to be reordered without merging them", () => {
        const { rows, changes } = build(["-c", "a=1", "-c", "b=2"]);
        rowButton(rows[2], "Move up").handlers.onclick({});
        expect(changes[0][0]).toEqual(["-c", "-c", "a=1", "b=2"]);
      });

      it("matches the 34px control height and ships its hint and translation", () => {
        expect(html).toMatch(/\.argv-row > \.input \{[^}]*height: var\(--control-h\)/);
        expect(html).toContain("One CLI argument per row (flag and value as separate rows, e.g. -c then key=val).");
        expect(functionSource("harnessEditor")).toContain("argvEditor(");
        expect(functionSource("harnessEditor")).not.toMatch(/chipEditor\(d\.extra_args/);
      });
    });

    describe("harness drafts", () => {
      it("does not seed inherit_mcp or other optional fields on a new harness, so it inherits the global default", () => {
        const { newEntity } = load<{ newEntity: (kind: string) => Record<string, unknown> }>(["newEntity"], {
          state: pageState(), harnessIds: () => ["claude"], today: () => "2026-11-26",
          defaultEffortsFor: () => ["low"], preferredDefaultEffort: () => "low",
        });
        const harness = newEntity("harness");
        expect(Object.hasOwn(harness, "inherit_mcp")).toBe(false);
        for (const key of ["profile", "default_upstream_provider", "max_concurrency", "model_discovery", "write_permission_mode"]) expect(harness, key).not.toHaveProperty(key);
        expect(harness).toMatchObject({ driver: "claude", extra_args: [], enabled: true });
      });

      it("offers inherit / yes / no for inherit_mcp, showing the live global default in the inherit label", () => {
        const state = pageState();
        const { inheritMcpOptions } = load<{ inheritMcpOptions: () => string[][] }>(["inheritMcpOptions"], { state, t });
        expect(inheritMcpOptions()).toEqual([["", "Inherit default (Off)"], ["true", "Yes (override)"], ["false", "No (override)"]]);
        state.snap.defaults.inherit_mcp = true;
        expect(inheritMcpOptions()[0]).toEqual(["", "Inherit default (On)"]);
      });

      it("round-trips the 3-state inherit_mcp control and clears it through _unset, never by sending an empty string", () => {
        const { buildPatch, cleanHarnessDraft, inheritMcpValue, parseInheritMcp } = load<any>(
          ["buildPatch", "dropBlankOptionals", "cleanHarnessDraft"], {}, "buildPatch, cleanHarnessDraft, inheritMcpValue, parseInheritMcp");
        expect([true, false, undefined].map(inheritMcpValue)).toEqual(["true", "false", ""]);
        expect(["true", "false", ""].map(parseInheritMcp)).toEqual([true, false, undefined]);
        const original = { driver: "claude", display_name: "C", binary: "claude", inherit_mcp: false, max_concurrency: 4 };
        const optional = ["profile", "default_upstream_provider", "write_permission_mode", "inherit_mcp", "max_concurrency", "model_discovery"];
        expect(buildPatch(original, cleanHarnessDraft({ ...original, inherit_mcp: undefined, max_concurrency: "" }), optional))
          .toEqual({ _unset: ["inherit_mcp", "max_concurrency"] });
        expect(buildPatch(original, cleanHarnessDraft({ ...original, inherit_mcp: true }), optional)).toEqual({ inherit_mcp: true });
        expect(buildPatch(original, cleanHarnessDraft({ ...original }), optional)).toEqual({});
        // A new harness that never set the field sends nothing for it.
        expect(cleanHarnessDraft({ driver: "claude", display_name: "N", binary: "n", extra_args: [], profile: "  " })).toEqual(
          { driver: "claude", display_name: "N", binary: "n", extra_args: [] });
      });

      it("validates max_concurrency (1-64, whole) and requires a name and an executable", () => {
        const { harnessDraftProblem } = load<any>(["harnessDraftProblem"], { t });
        expect(harnessDraftProblem({ display_name: "A", binary: "a" })).toBeNull();
        expect(harnessDraftProblem({ display_name: "A", binary: "a", max_concurrency: 64 })).toBeNull();
        for (const bad of [0, 65, 2.5, Number.NaN]) {
          expect(harnessDraftProblem({ display_name: "A", binary: "a", max_concurrency: bad }), String(bad)).toBe("Max parallel jobs must be a whole number from 1 to 64.");
        }
        expect(harnessDraftProblem({ display_name: "A" })).toBe("Enter a name and an executable.");
      });

      it("drops only empty argv rows on save and keeps every other token verbatim, whitespace, commas and duplicates included", () => {
        const { cleanHarnessDraft } = load<any>(["dropBlankOptionals", "cleanHarnessDraft"], {}, "cleanHarnessDraft");
        const cleaned = cleanHarnessDraft({ display_name: "A", binary: "a", extra_args: ["-c", "", "k=v", "  ", "-c", " --flag ", "--enabled-tools a,b"] });
        expect(cleaned.extra_args).toEqual(["-c", "k=v", "  ", "-c", " --flag ", "--enabled-tools a,b"]);
      });

      it("clears a write mode that the newly chosen driver does not know and keeps a compatible one", () => {
        const state = pageState();
        const { applyDriverChange } = load<any>(["writePermissionModes", "applyDriverChange"], { state }, "applyDriverChange");
        const incompatible = { driver: "claude", write_permission_mode: "acceptEdits" };
        applyDriverChange(incompatible, "gemini");
        expect(incompatible).toEqual({ driver: "gemini", write_permission_mode: undefined });
        const shared = { driver: "claude", write_permission_mode: "auto" };
        applyDriverChange(shared, "antigravity");
        expect(shared).toEqual({ driver: "antigravity", write_permission_mode: "auto" });
        const noModes = { driver: "claude", write_permission_mode: "acceptEdits" };
        applyDriverChange(noModes, "codex");
        expect(noModes.write_permission_mode).toBe("acceptEdits");
        const unset = { driver: "claude" };
        applyDriverChange(unset, "gemini");
        expect(unset).toEqual({ driver: "gemini" });
      });

      it("shows profile and default provider only for supporting drivers or when already set, with an ignored warning and Clear", () => {
        const state = pageState();
        const cleared: string[] = [];
        const { driverGatedField } = load<any>(["driverGatedField"], {
          h: fakeH, t, button, textInput: (value: string) => fakeH("input", { value }),
          setDraft: () => undefined, clearButton: (key: string) => { cleared.push(key); return fakeH("button", { "data-fk": `clear-${key}` }); },
        });
        const props = (_key: string, _label: string, control: FakeNode) => control;
        const spec = { key: "profile", label: "Profile", fk: "h-profile", placeholder: "optional" };
        expect(driverGatedField(props, { driver: "claude" }, { ...spec, supported: false })).toBeNull();
        const supported = driverGatedField(props, { driver: "codex" }, { ...spec, supported: true }) as FakeNode;
        expect(supported.tag).toBe("input");
        const ignored = driverGatedField(props, { driver: "claude", profile: "work" }, { ...spec, supported: false }) as FakeNode;
        expect(ignored.allText()).toContain("Ignored by this driver");
        expect(ignored.find((node) => node.attrs.get("data-fk") === "clear-profile")).toBeDefined();
        expect(cleared).toEqual(["profile"]);
        expect(state.driverMeta.codex.supportsProfile).toBe(true);
        const editor = functionSource("harnessEditor");
        expect(editor).toContain("supported: Boolean(meta.supportsProfile)");
        expect(editor).toContain("supported: Boolean(meta.usesUpstreamProvider)");
      });

      it("wires max_concurrency, model_discovery, reset-field and the driver change into the harness editor", () => {
        const editor = functionSource("harnessEditor");
        expect(editor).toMatch(/type: "number", min: 1, max: MAX_CONCURRENCY_LIMIT/);
        expect(editor).toContain("/reset-field");
        expect(editor).toContain("applyDriverChange(d, v)");
        expect(editor).toContain("MODEL_DISCOVERY_MODES");
        expect(editor).not.toContain("toggle(Boolean(d.inherit_mcp)");
        expect(html).toMatch(/const MODEL_DISCOVERY_MODES = \["manual", "native", "wrapper"\]/);
      });

      it("warns with the exact count and IDs when a custom harness still has models, and says nothing otherwise", () => {
        const state = pageState();
        state.snap.models = { "m-1": { harness: "mine" }, "m-2": { harness: "mine" }, other: { harness: "claude" } };
        const countLabel = (count: number, noun: string) => (count === 1 ? noun : `${noun}s`);
        const { harnessDeleteNote } = load<any>(["modelsFor", "harnessDeleteNote"], { state, t, countLabel }, "harnessDeleteNote");
        expect(harnessDeleteNote("mine")).toBe("2 models still use this harness: m-1, m-2. They stop working until you move or delete them.");
        expect(harnessDeleteNote("claude")).toBe("1 model still use this harness: other. They stop working until you move or delete them.");
        expect(harnessDeleteNote("empty")).toBeUndefined();
        state.snap.models = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`m${i}`, { harness: "mine" }]));
        expect(harnessDeleteNote("mine")).toContain("m7…");
        expect(functionSource("resetEntity")).toContain('note: kind === "harness" && isCustom ? harnessDeleteNote(id) : undefined');
      });
    });

    describe("model drafts", () => {
      it("seeds a new model's efforts and default effort from the harness driver instead of low/medium/high", () => {
        const state = pageState();
        const deps = { state, harnessIds: () => Object.keys(state.snap.harnesses), today: () => "2026-11-26" };
        const helpers = load<any>(["driverMetaOf", "defaultEffortsFor", "preferredDefaultEffort", "newEntity"], deps, "newEntity, defaultEffortsFor");
        state.harnessFilter = "oc";
        expect(helpers.newEntity("model")).toMatchObject({ harness: "oc", efforts: ["default"], default_effort: "default" });
        state.harnessFilter = "claude";
        expect(helpers.newEntity("model")).toMatchObject({ harness: "claude", efforts: ["low", "medium", "high"], default_effort: "medium" });
        // An unknown driver (older server without metadata) falls back to the usual levels, and the seed is a copy.
        state.snap.harnesses.mystery = { driver: "mystery" };
        const fallback = helpers.defaultEffortsFor("mystery");
        expect(fallback).toEqual(["low", "medium", "high"]);
        fallback.push("x");
        expect(helpers.defaultEffortsFor("mystery")).toEqual(["low", "medium", "high"]);
        const model = helpers.newEntity("model");
        for (const key of ["cli_model", "cli_provider", "vendor_family"]) expect(model, key).not.toHaveProperty(key);
      });

      it("reseeds efforts when a NEW model switches harness untouched, and keeps efforts the user changed", () => {
        const state = pageState();
        const { applyHarnessChange } = load<any>(["driverMetaOf", "defaultEffortsFor", "preferredDefaultEffort", "effortsAreSeeded", "applyHarnessChange"], { state }, "applyHarnessChange");
        const untouched = { harness: "claude", efforts: ["low", "medium", "high"], default_effort: "medium" };
        applyHarnessChange(untouched, "oc", { reseedEfforts: true });
        expect(untouched).toEqual({ harness: "oc", efforts: ["default"], default_effort: "default" });
        applyHarnessChange(untouched, "claude", { reseedEfforts: true });
        expect(untouched).toEqual({ harness: "claude", efforts: ["low", "medium", "high"], default_effort: "medium" });
        const edited = { harness: "claude", efforts: ["low", "high", "max"], default_effort: "high" };
        applyHarnessChange(edited, "oc", { reseedEfforts: true });
        expect(edited).toEqual({ harness: "oc", efforts: ["low", "high", "max"], default_effort: "high" });
        const existing = { harness: "claude", efforts: ["low", "medium", "high"], default_effort: "medium" };
        applyHarnessChange(existing, "oc", { reseedEfforts: false });
        expect(existing.efforts).toEqual(["low", "medium", "high"]);
      });

      it("suggests only the driver's own levels where effort is not configurable, and the usual ones elsewhere", () => {
        const state = pageState();
        const { effortSuggestionsFor } = load<any>(["driverMetaOf", "defaultEffortsFor", "effortSuggestionsFor"], { state }, "effortSuggestionsFor");
        expect(effortSuggestionsFor("oc")).toEqual(["default"]);
        expect(effortSuggestionsFor("gem")).toEqual(["default"]);
        expect(effortSuggestionsFor("claude")).toEqual(["low", "medium", "high", "minimal", "xhigh", "max"]);
      });

      const modelHelpers = () => load<any>(["dropBlankOptionals", "buildPatch", "modelMayOmitCardFacts", "cleanModelDraft", "modelDraftProblem"], { t },
        "buildPatch, cleanModelDraft, modelDraftProblem");
      const reviewed = { display_name: "M", harness: "claude", tier: "standard", cost_tier: "low", efforts: ["low"], default_effort: "low",
        context_window: 1000, checked_at: "2026-11-26", strengths: [], weaknesses: [], best_for: [], avoid_for: [] };

      it("never sends an empty cli_model: blank means use the model ID, through _unset when one was stored", () => {
        const { buildPatch, cleanModelDraft } = modelHelpers();
        const optional = ["cli_model", "cli_provider", "vendor_family", "context_window", "checked_at"];
        expect(cleanModelDraft({ ...reviewed, cli_model: "   ", cli_provider: "", vendor_family: " " })).not.toHaveProperty("cli_model");
        expect(cleanModelDraft({ ...reviewed, cli_model: "  real  " }).cli_model).toBe("real");
        const stored = { ...reviewed, cli_model: "real", cli_provider: "p", vendor_family: "acme" };
        const patch = buildPatch(stored, cleanModelDraft({ ...stored, cli_model: "", cli_provider: "", vendor_family: "" }), optional);
        expect(patch).toEqual({ _unset: ["cli_model", "cli_provider", "vendor_family"] });
        expect(JSON.stringify(patch)).not.toContain('""');
        const created = cleanModelDraft({ ...reviewed, cli_model: "", cli_provider: "" });
        expect(Object.keys(created)).not.toEqual(expect.arrayContaining(["cli_model", "cli_provider"]));
      });

      it("requires context_window and checked_at except on unreviewed discovered cards, and never produces NaN", () => {
        const { cleanModelDraft, modelDraftProblem, buildPatch } = modelHelpers();
        const problem = (draft: Record<string, unknown>) => modelDraftProblem(cleanModelDraft(draft));
        expect(problem(reviewed)).toBeNull();
        expect(problem({ ...reviewed, context_window: "" })).toBe("The context window must be a positive whole number of tokens.");
        expect(problem({ ...reviewed, context_window: undefined })).toBe("The context window must be a positive whole number of tokens.");
        expect(problem({ ...reviewed, context_window: Number.NaN })).toBe("The context window must be a positive whole number of tokens.");
        expect(problem({ ...reviewed, context_window: 1.5 })).toBe("The context window must be a positive whole number of tokens.");
        expect(problem({ ...reviewed, checked_at: "" })).toBe("Enter the date the card was last checked.");
        expect(problem({ ...reviewed, display_name: " " })).toBe("Enter a model name.");
        expect(problem({ ...reviewed, efforts: [] })).toBe("Add at least one effort level.");
        const discovered = { ...reviewed, source: "discovered", context_window: "", checked_at: "" };
        expect(problem(discovered)).toBeNull();
        expect(problem({ ...discovered, metadata_quality: "reviewed" })).not.toBeNull();
        const patch = buildPatch(reviewed, cleanModelDraft(discovered), ["context_window", "checked_at"]);
        expect(patch._unset).toEqual(["context_window", "checked_at"]);
      });

      it("renders a card without context_window or checked_at as an em dash and an Unreviewed badge, never NaN", () => {
        const state = pageState();
        const formatted = load<any>(["formatContext", "modelRow"], {
          h: fakeH, t, state, openDrawer: () => undefined, provenancePill: () => null, statusPill: (kind: string, text: string) => fakeH("span", { class: `status-pill ${kind}`, text }),
          rowOpener: () => () => undefined, toggle: () => fakeH("label", {}), mutate: async () => true, effortLabel: (e: string) => e,
          countLabel: () => "levels", iconButton, badge: (text: string, kind: string, extra: Record<string, any> = {}) => fakeH("span", { ...extra, class: `badge ${kind}`, text }),
        }, "modelRow");
        const baseModel = { display_name: "Found", harness: "claude", tier: "light", cost_tier: "low", enabled: true, provenance: "custom", efforts: ["default"], default_effort: "default", is_stale: false };
        state.snap.defaults.stale_after_days = 90;
        const row = formatted.modelRow("found", baseModel) as FakeNode;
        const cells = row.children;
        const context = cells.find((cell) => cell.attrs.get("data-label") === "Context")!;
        const checked = cells.find((cell) => cell.attrs.get("data-label") === "Checked")!;
        expect(context.allText()).toBe("—");
        expect(context.attrs.has("title")).toBe(false);
        expect(checked.allText()).toBe("Unreviewed");
        expect(row.allText()).not.toMatch(/NaN|undefined|null/);
        const reviewedRow = formatted.modelRow("ok", { ...baseModel, context_window: 200000, checked_at: "2026-11-26" }) as FakeNode;
        expect(reviewedRow.find((n) => n.attrs.get("data-label") === "Context")!.allText()).toBe("200K");
        expect(reviewedRow.find((n) => n.attrs.get("data-label") === "Checked")!.allText()).toBe("2026-11-26");
      });

      it("keeps the optional card facts blank in the editor inputs and the hint free of NaN", () => {
        const editor = functionSource("modelEditor");
        expect(editor).toContain('setDraft("context_window", v === "" ? undefined : Number(v), false)');
        expect(editor).toContain("formatContext(d.context_window)");
        expect(editor).not.toContain("formatContext(Number(d.context_window))");
        expect(editor).toContain('badge(t("Unreviewed"), "outline")');
      });

      it("warns when an opencode model lacks provider/model, and when an explicit vendor family meets an edited CLI model or harness", () => {
        const state = pageState();
        const { modelHints } = load<any>(["driverMetaOf", "modelHints"], { state, t }, "modelHints");
        const expected = "OpenCode expects provider/model — set CLI provider or include '/' in CLI model.";
        const draft = (extra: Record<string, unknown>) => ({ isNew: true, newId: "gpt-5", id: null, original: {}, draft: { harness: "oc", ...extra } });
        expect(modelHints(draft({}))["provider-prefix"]).toBe(expected);
        expect(modelHints(draft({ cli_provider: "openai" }))["provider-prefix"]).toBe("");
        expect(modelHints(draft({ cli_model: "openai/gpt-5" }))["provider-prefix"]).toBe("");
        expect(modelHints({ ...draft({}), newId: "openai/gpt-5" })["provider-prefix"]).toBe("");
        expect(modelHints({ ...draft({ harness: "claude" }) })["provider-prefix"]).toBe("");

        const existing = (extra: Record<string, unknown>) => ({ isNew: false, id: "m", newId: "", original: { harness: "claude", cli_model: "a", vendor_family: "acme" },
          draft: { harness: "claude", cli_model: "a", vendor_family: "acme", ...extra } });
        expect(modelHints(existing({}))["vendor-edit"]).toBe("");
        expect(modelHints(existing({ cli_model: "b" }))["vendor-edit"]).toContain("explicit vendor family");
        expect(modelHints(existing({ harness: "oc" }))["vendor-edit"]).toContain("explicit vendor family");
        expect(modelHints(existing({ cli_model: "b", vendor_family: "" }))["vendor-edit"]).toBe("");
      });

      it("updates the advice nodes in place without re-rendering", () => {
        const nodes: Record<string, { hidden: boolean; textContent: string }> = {
          "provider-prefix": { hidden: true, textContent: "" }, "vendor-edit": { hidden: true, textContent: "" },
        };
        const state: any = { drawer: { kind: "model" } };
        const document = { querySelector: (selector: string) => nodes[/data-hint="([^"]+)"/.exec(selector)![1]] };
        const { refreshModelHints } = load<any>(["refreshModelHints"], {
          state, document, modelHints: () => ({ "provider-prefix": "advice", "vendor-edit": "" }),
        }, "refreshModelHints");
        refreshModelHints();
        expect(nodes["provider-prefix"]).toEqual({ hidden: false, textContent: "advice" });
        expect(nodes["vendor-edit"]).toEqual({ hidden: true, textContent: "" });
        state.drawer = { kind: "harness" };
        nodes["provider-prefix"].textContent = "kept";
        refreshModelHints();
        expect(nodes["provider-prefix"].textContent).toBe("kept");
      });

      it("shows a quiet hint for a custom model that no enabled preset uses, and exposes vendor_family with a Clear action", () => {
        const state = pageState();
        state.snap.presets = {
          off: { enabled: false, roles: { quick: { harness: "claude", model: "mine" } } },
          on: { enabled: true, roles: { quick: { harness: "claude", model: "other" }, deep: null } },
        };
        const { modelReferencedByEnabledPreset } = load<any>(["modelReferencedByEnabledPreset"], { state }, "modelReferencedByEnabledPreset");
        expect(modelReferencedByEnabledPreset("mine")).toBe(false);
        expect(modelReferencedByEnabledPreset("other")).toBe(true);
        const editor = functionSource("modelEditor");
        expect(editor).toContain("Enabled for explicit selection or fallback; add to a preset role for automatic routing.");
        expect(editor).toContain('t("auto (inferred)")');
        expect(editor).toContain('clearButton("vendor_family")');
        expect(editor).toContain("meta.usesCliProvider || hasProvider");
        expect(editor).toContain('applyHarnessChange(d, v, { reseedEfforts: drawer.isNew })');
      });
    });

    describe("quarantine banner", () => {
      const banner = (kind: string, text: string, ...extra: FakeNode[]) => fakeH("div", { class: `banner ${kind}` }, fakeH("div", { text }), ...extra);

      it("lists every quarantined (section, id, reason) and says the rest stays active", () => {
        const state = pageState();
        state.snap.quarantined = [
          { section: "models", id: "orphan", reason: "unknown harness no-such-harness" },
          { section: "harnesses", id: "bad:id", reason: "binary must not be empty" },
        ];
        const { quarantineBanner } = load<any>(["quarantineBanner"], { state, t, banner, h: fakeH }, "quarantineBanner");
        const node = quarantineBanner() as FakeNode;
        const text = node.allText();
        expect(text).toContain("All other valid settings stay active");
        const items = node.descendants().filter((n) => n.tag === "li");
        // FakeNode keeps a node's own text apart from its children, so read the code label and the reason separately.
        expect(items.map((item) => [item.children[0].text, item.text])).toEqual([
          ["models.orphan", ": unknown harness no-such-harness"], ["harnesses.bad:id", ": binary must not be empty"],
        ]);
      });

      it("renders nothing without quarantined entries, and hides the duplicate server warning for the ones it lists", () => {
        const state = pageState();
        const { quarantineBanner, visibleConfigWarnings } = load<any>(["quarantineBanner", "visibleConfigWarnings"], { state, t, banner, h: fakeH },
          "quarantineBanner, visibleConfigWarnings");
        expect(quarantineBanner()).toBeNull();
        state.snap.quarantined = [{ section: "models", id: "orphan", reason: "r" }];
        state.snap.config_warnings = ["Quarantined models.orphan from /x/models.toml: r. The rest applies.", "Some other warning"];
        expect(visibleConfigWarnings()).toEqual(["Some other warning"]);
        expect(functionSource("render")).toContain("quarantineBanner()");
      });
    });

    describe("Settings UI P2 review fixes", () => {
      it("never leaves a snapshot adopted without rebasing the Limits draft", () => {
        const lines = html.split("\n");
        const adopters: string[] = [];
        lines.forEach((line, index) => {
          if (!/\bstate\.snap = (?!null)/.test(line)) return;
          const window = lines.slice(index, index + 4).join("\n");
          if (/rebaseLimitsDraft\(\)|syncDraftsAfterConflict\(\)/.test(window)) return;
          adopters.push(`${index + 1}: ${line.trim()}`);
        });
        // Only the initial page load adopts a snapshot before any Limits draft can exist.
        expect(adopters).toHaveLength(1);
        expect(adopters[0]).toContain("state.snap = data.snapshot;");
        expect(functionSource("loadState")).toContain("state.snap = data.snapshot;");
      });

      it("shows the Reset-to-default button for an overridden field even when its value is cleared", () => {
        const field = load<any>(["field"], { h: fakeH, t, iconButton, formatValue: (value: unknown) => String(value) }, "field").field;
        const reset = () => undefined;
        const render = (provenance: string | undefined, onReset: unknown) => field({
          label: "Write mode", key: "write_permission_mode", control: fakeH("div", {}), provenance, hasDefault: true, defaultValue: "acceptEdits", onReset,
        }) as FakeNode;
        expect(render("overridden", reset).find((node) => node.classes.has("reset-field"))).toBeDefined();
        expect(render("default", reset).find((node) => node.classes.has("reset-field"))).toBeUndefined();
        expect(render("overridden", null).find((node) => node.classes.has("reset-field"))).toBeUndefined();
        // The value is never consulted, so a cleared (undefined) field keeps the button.
        expect(functionSource("field")).not.toMatch(/value\s*!==\s*undefined/);
      });

      it("keeps driver-gated harness rows visible while a built-in field is overridden, so a cleared one can be reset", () => {
        const props = (_key: string, _label: string, control: FakeNode) => control;
        const { driverGatedField, writePermissionField } = load<any>(["driverGatedField", "writePermissionField", "writePermissionModes"], {
          h: fakeH, t, textInput: (value: string) => fakeH("input", { value }), setDraft: () => undefined,
          clearButton: (key: string) => fakeH("button", { "data-fk": `clear-${key}` }),
          state: pageState(),
          driverMetaOf: () => ({}),
        }, "driverGatedField, writePermissionField");
        const spec = { key: "profile", label: "Profile", fk: "h-profile", placeholder: "optional", supported: false };
        expect(driverGatedField(props, { driver: "claude" }, spec)).toBeNull();
        const kept = driverGatedField(props, { driver: "claude" }, { ...spec, keep: true }) as FakeNode;
        expect(kept.allText()).toContain("Ignored by this driver");
        expect(kept.find((node) => node.attrs.get("data-fk") === "clear-profile")).toBeUndefined();
        // A driver without known write modes shows no row for an empty value, unless the built-in field is overridden.
        expect(writePermissionField(props, { driver: "codex" })).toBeNull();
        expect(writePermissionField(props, { driver: "codex" }, { keep: true })).not.toBeNull();
        const editor = functionSource("harnessEditor");
        for (const key of ["profile", "default_upstream_provider", "write_permission_mode"]) expect(editor).toContain(`overriddenField("${key}")`);
      });

      it("wires Reset for every built-in model and harness field without gating it on the field value", () => {
        const model = functionSource("modelEditor");
        expect(model).toMatch(/onReset: \(\) => void mutate\("POST", `\/api\/models\/\$\{encodeURIComponent\(drawer\.id\)\}\/reset-field`/);
        expect(model).toContain('provenanceOf("cli_provider") === "overridden"');
        const harness = functionSource("harnessEditor");
        expect(harness).toMatch(/onReset: base && !isCustom \? \(\) => void mutate\("POST", `\/api\/harnesses\/\$\{encodeURIComponent\(drawer\.id\)\}\/reset-field`/);
        for (const source of [model, harness]) expect(source).not.toMatch(/onReset:[^\n]*(!== undefined|=== undefined)/);
        for (const key of ["display_name", "harness", "cli_model", "vendor_family", "tier", "cost_tier", "context_window", "checked_at", "enabled", "efforts", "default_effort"]) {
          expect(model, key).toContain(`props("${key}"`);
        }
        for (const key of ["display_name", "driver", "binary", "inherit_mcp", "max_concurrency", "model_discovery", "enabled", "extra_args"]) {
          expect(harness, key).toContain(`props("${key}"`);
        }
      });

      it("renders quarantine reasons as text nodes only", () => {
        const source = functionSource("quarantineBanner");
        expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
        const state = pageState();
        state.snap.quarantined = [{ section: "models", id: "x", reason: "<img src=x onerror=alert(1)>" }];
        const { quarantineBanner } = load<any>(["quarantineBanner"], { state, t, banner: (_kind: string, text: string, ...extra: FakeNode[]) => fakeH("div", { text }, ...extra), h: fakeH });
        const item = (quarantineBanner() as FakeNode).descendants().find((node) => node.tag === "li")!;
        expect(item.tag).toBe("li");
        expect(item.text).toBe(": <img src=x onerror=alert(1)>");
        // The per-item Reset button sits beside the text; everything else stays a <code> text node.
        expect(item.children.filter((child) => child.tag !== "button").every((child) => child.tag === "code")).toBe(true);
      });
    });

    describe("new-ID validation", () => {
      it("accepts IDs with '/', ':' and '@' and rejects the shapes the shared policy rejects", () => {
        const { isValidNewId } = load<any>(["isValidNewId"], {}, "isValidNewId");
        for (const id of ["openai/gpt-5", "qwen3:32b", "team@host", "a.b_c-d", "x".repeat(128)]) expect(isValidNewId(id), id).toBe(true);
        for (const id of ["", "-x", "/x", "a//b", "trail/", "a..b", "__proto__", "constructor", "prototype", "has space", "café", "x".repeat(129)]) {
          expect(isValidNewId(id), id).toBe(false);
        }
      });

      it("uses the shared validator for new IDs and still rejects an ID that is already in use", () => {
        const toasts: string[] = [];
        const state: any = { drawer: { newId: " qwen3:32b " }, snap: { models: {} } };
        const { validateNewId } = load<any>(["isValidNewId", "validateNewId"], { state, t, toast: (_kind: string, get: () => string) => toasts.push(get()) }, "validateNewId");
        expect(validateNewId("models")).toBe("qwen3:32b");
        state.drawer.newId = "openai/gpt-5";
        state.snap.models["openai/gpt-5"] = {};
        expect(validateNewId("models")).toBeNull();
        expect(toasts).toEqual(["ID “openai/gpt-5” is already in use."]);
        state.drawer.newId = "a//b";
        expect(validateNewId("models")).toBeNull();
        expect(toasts[1]).toContain("Start the ID with a letter or digit.");
      });
    });

    describe("translations and page invariants", () => {
      it("ships a Russian translation for every literal t() string in the page, including all Wave 1B strings", () => {
        const russianBlock = /^const russian = \{([\s\S]*?)^\};/m.exec(html)![1];
        const keys = new Set([...russianBlock.matchAll(/^\s*("(?:[^"\\]|\\.)*"):/gm)].map((match) => JSON.parse(match[1]) as string));
        const code = html.slice(html.indexOf("function t(english"));
        const used = [...code.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]) as string);
        expect(used.length).toBeGreaterThan(200);
        expect(used.filter((text) => !keys.has(text))).toEqual([]);
        for (const text of [
          "One CLI argument per row (flag and value as separate rows, e.g. -c then key=val).", "Inherit default (On)", "Inherit default (Off)",
          "Yes (override)", "No (override)", "Max parallel jobs", "Model discovery", "manual", "native", "wrapper", "Ignored by this driver", "Clear",
          "Vendor family", "Unreviewed", "OpenCode expects provider/model — set CLI provider or include '/' in CLI model.",
          "Enabled for explicit selection or fallback; add to a preset role for automatic routing.", "Move up", "Move down", "Argument",
          "Some entries are invalid and set aside. All other valid settings stay active. Fix or reset these entries to bring them back.",
          "{0} still use this harness: {1}. They stop working until you move or delete them.",
        ]) expect(keys.has(text), text).toBe(true);
        // Every Russian value keeps the placeholders of its English key.
        for (const [, english, russian] of russianBlock.matchAll(/^\s*("(?:[^"\\]|\\.)*"):\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)) {
          const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
          expect(placeholders(JSON.parse(russian)), english).toEqual(placeholders(JSON.parse(english)));
        }
      });

      it("removes the dead-end 'use the reset button' errors for custom entities", () => {
        expect(html).not.toContain("To remove {0}, use the reset button");
        expect(html).not.toContain("To remove the provider, use the reset button");
        expect(functionSource("saveModel")).toContain("MODEL_OPTIONAL_KEYS");
        expect(functionSource("saveHarness")).toContain("HARNESS_OPTIONAL_KEYS");
      });

      it("writes every new control through DOM helpers: no inline style, .style writes, innerHTML or inline handlers in the new code", () => {
        for (const name of ["argvEditor", "harnessEditor", "modelEditor", "quarantineBanner", "driverGatedField", "refreshModelHints", "modelRow"]) {
          const source = functionSource(name);
          expect(source, name).not.toMatch(/\sstyle\s*=|\.style\s*(?:\.|\[|=)|setAttribute\(\s*["']style["']|innerHTML|outerHTML|insertAdjacentHTML/);
        }
        const css = html.slice(html.indexOf(".argv-row"), html.indexOf(".quarantine-list") + 200);
        expect(css).not.toMatch(/font-size\s*:\s*[^;{}]*\d(?:px|rem|em|pt|%)/);
        expect(css).not.toMatch(/border-radius\s*:[^;]*50%|text-transform|font-weight\s*:\s*\d/);
      });
    });
  });

  describe("Wave 3: model discovery review drawer", () => {
    const t = (text: string, ...values: unknown[]) => text.replace(/\{(\d+)\}/g, (_m, index) => String(values[Number(index)]));
    const constants = html.slice(html.indexOf("const MAX_IMPORT_SELECTION"), html.indexOf("function newDiscoveryState"));

    function load<T>(names: string[], deps: Record<string, unknown> = {}, ret = names.join(", ")): T {
      const keys = Object.keys(deps);
      return new Function(...keys, `${constants}\n${names.map(functionSource).join("\n")}\nreturn { ${ret} };`)(...keys.map((key) => deps[key])) as T;
    }

    function candidate(key: string, overrides: Record<string, unknown> = {}): any {
      return {
        key, harness: "claude", driver: "claude", status: "new", action: "import", proposed_id: `model-${key}`, metadata_quality: "baseline",
        discovered: { cli_model: `model-${key}`, availability: "reported_available", evidence: "cli_listing" }, ...overrides,
      };
    }

    const helpers = () => load<any>([
      "isActionableCandidate", "discoveryProviders", "discoveryStatusCounts", "candidateMatches", "formatContext", "discoveryContext", "reconcileSelection",
      "selectionSummary", "selectionToggleMode", "selectActionable", "discoveryDiagnosticNotes", "discoveryImportFailure",
    ]);

    it("offers Discover models on the Models page header and in the saved harness drawer (disabled while the harness is unsaved)", () => {
      const models = functionSource("renderModels") + functionSource("harnessEditor");
      expect(functionSource("renderModels")).toMatch(/button\(t\("Discover models"\)[\s\S]*?openDiscoveryDrawer\(state\.harnessFilter\)/);
      expect(functionSource("renderModels").indexOf('t("Discover models")')).toBeLessThan(functionSource("renderModels").indexOf('t("Add model")'));
      expect(functionSource("harnessEditor")).toMatch(/button\(t\("Discover models"\)[\s\S]*?disabled: drawer\.isNew[\s\S]*?discoverFromHarnessDrawer\(\)/);
      expect(models).not.toContain("innerHTML");
      expect(functionSource("renderDrawer")).toContain("discoveryEditor(drawer)");
    });

    it("asks before a harness drawer with unsaved edits is replaced by discovery, and opens discovery scoped to that harness", async () => {
      const opened: string[] = [];
      let confirmed = false;
      const state: any = { drawer: { kind: "harness", id: "claude", isNew: false } };
      const { discoverFromHarnessDrawer } = load<any>(["discoverFromHarnessDrawer"], {
        state, t, drawerDirty: () => true, confirmDialog: async () => confirmed, openDiscoveryDrawer: (id: string) => opened.push(id),
      });
      await discoverFromHarnessDrawer();
      expect(opened).toEqual([]);
      confirmed = true;
      await discoverFromHarnessDrawer();
      expect(opened).toEqual(["claude"]);
      state.drawer = { kind: "harness", id: null, isNew: true };
      await discoverFromHarnessDrawer();
      expect(opened).toEqual(["claude"]);
    });

    it("filters by status, provider and words, counts statuses, and lists providers once", () => {
      const { candidateMatches, discoveryProviders, discoveryStatusCounts } = helpers();
      const list = [
        candidate("a", { discovered: { cli_model: "gpt-5", cli_provider: "openai" } }),
        candidate("b", { status: "disabled_in_catalog", action: "enable", discovered: { cli_model: "glm-5", cli_provider: "zai" } }),
        candidate("c", { status: "already_configured", action: "none", discovered: { cli_model: "kimi" } }),
        candidate("d", { status: "ambiguous", action: "none", discovered: { cli_model: "gpt-5", cli_provider: "openai" } }),
      ];
      const all = { query: "", status: "all", provider: "" };
      expect(list.filter((item) => candidateMatches(item, all))).toHaveLength(4);
      expect(list.filter((item) => candidateMatches(item, { ...all, status: "new" })).map((item) => item.key)).toEqual(["a"]);
      expect(list.filter((item) => candidateMatches(item, { ...all, provider: "openai" })).map((item) => item.key)).toEqual(["a", "d"]);
      expect(list.filter((item) => candidateMatches(item, { ...all, query: "  GPT  5 " })).map((item) => item.key)).toEqual(["a", "d"]);
      expect(list.filter((item) => candidateMatches(item, { ...all, query: "nothing-like-this" }))).toEqual([]);
      expect(discoveryProviders(list)).toEqual(["openai", "zai"]);
      expect(discoveryStatusCounts(list)).toEqual({ all: 4, new: 1, disabled_in_catalog: 1, already_configured: 1 });
    });

    it("formats the context window like the model table and marks rounded figures with ~", () => {
      const { discoveryContext } = helpers();
      expect(discoveryContext({ context_window: 272_000, context_precision: "exact" })).toBe("272K");
      expect(discoveryContext({ context_window: 1_000_000, context_precision: "exact" })).toBe("1M");
      expect(discoveryContext({ context_window: 272_000, context_precision: "rounded" })).toBe("~272K");
      expect(discoveryContext({})).toBe("—");
      expect(discoveryContext({ context_precision: "rounded" })).toBe("—");
    });

    it("respects the 50-model batch limit when selecting, keeps valid selections on refresh and reports the dropped ones", () => {
      const { selectActionable, reconcileSelection, selectionSummary, selectionToggleMode } = helpers();
      const many = Array.from({ length: 70 }, (_, index) => candidate(`k${index}`, index % 2 ? { status: "disabled_in_catalog", action: "enable" } : {}));
      const passive = candidate("done", { status: "already_configured", action: "none" });
      const picked = selectActionable(new Set(), [passive, ...many]);
      expect(picked.selected.size).toBe(MAX_APPLY_BATCH);
      expect(picked.capped).toBe(true);
      expect(picked.selected.has("done")).toBe(false);
      expect(selectActionable(new Set(["k0"]), [candidate("k0"), candidate("k1")]).capped).toBe(false);

      expect(selectionSummary(many, new Set(["k0", "k1", "k2", "missing"]))).toEqual({ total: 3, fresh: 2, enable: 1 });
      expect(selectionToggleMode(new Set(), many)).toBe("select");
      expect(selectionToggleMode(new Set(["k0"]), [candidate("k0"), candidate("k2")])).toBe("select");
      expect(selectionToggleMode(new Set(["k0", "k2"]), [candidate("k0"), candidate("k2")])).toBe("clear");

      const fresh = [candidate("k0"), candidate("k1", { status: "already_configured", action: "none" }), candidate("k5")];
      const reconciled = reconcileSelection(new Set(["k0", "k1", "gone"]), fresh);
      expect([...reconciled.kept]).toEqual(["k0"]);
      expect(reconciled.dropped).toBe(2);
    });

    it("turns scan diagnostics into one short note per harness and problem", () => {
      const { discoveryDiagnosticNotes } = helpers();
      const notes = discoveryDiagnosticNotes({ harnesses: [
        { harness: "custom-wrapper", status: "unsupported", truncated: false, diagnostics: [{ stage: "probe", code: "manual_only", message: "custom wrapper" }, { stage: "probe", code: "manual_only" }] },
        { harness: "gemini", status: "unavailable", truncated: false, diagnostics: [{ stage: "probe", code: "binary_missing" }, { stage: "probe", code: "timeout" }] },
        { harness: "pi", status: "unsupported", truncated: true, diagnostics: [] },
        { harness: "codex", status: "ok", truncated: false, diagnostics: [{ stage: "offline", code: "brand_new_code" }] },
      ] });
      expect(notes.map((note: any) => `${note.harness}|${note.kind}|${note.label}`)).toEqual([
        "custom-wrapper|muted|Manual only (custom wrapper)", "gemini|danger|CLI not found", "gemini|warn|Timed out",
        "pi|muted|Unsupported", "pi|warn|Truncated", "codex|warn|brand_new_code",
      ]);
      expect(notes[0].title).toBe("custom wrapper");
    });

    it("renders a checkbox only for new and disabled-in-catalog rows; the others get a quiet status pill", () => {
      const { ledgerRow } = load<any>(["isActionableCandidate", "formatContext", "discoveryContext", "badge", "statusPill", "ledgerRow"], {
        h: fakeH, t, toggleDiscoverySelection: () => undefined,
      });
      const d = { selected: new Set(["n"]), saving: false };
      const rows = {
        n: ledgerRow(d, candidate("n", { harness: "pi", proposed_id: "pi-glm-5", discovered: { cli_model: "glm-5", cli_provider: "zai", context_window: 200_000, context_precision: "rounded", evidence: "local_cache" } })),
        e: ledgerRow(d, candidate("e", { status: "disabled_in_catalog", action: "enable", metadata_quality: "curated" })),
        c: ledgerRow(d, candidate("c", { status: "already_configured", action: "none" })),
        a: ledgerRow(d, candidate("a", { status: "ambiguous", action: "none" })),
      } as Record<string, FakeNode>;
      const checkboxes = (row: FakeNode) => row.descendants().filter((node) => node.tag === "input");
      expect(checkboxes(rows.n)).toHaveLength(1);
      expect(checkboxes(rows.e)).toHaveLength(1);
      expect(checkboxes(rows.c)).toHaveLength(0);
      expect(checkboxes(rows.a)).toHaveLength(0);
      expect(checkboxes(rows.n)[0].attrs.get("aria-label")).toBe("Import pi-glm-5");
      expect(checkboxes(rows.e)[0].attrs.get("aria-label")).toBe("Enable model-e");
      expect(rows.n.children[0].classes.has("is-selected")).toBe(true);
      expect(rows.e.children[0].classes.has("is-selected")).toBe(false);
      expect(rows.c.children[0].tag).toBe("div");
      const text = rows.n.allText();
      for (const part of ["pi-glm-5", "zai / glm-5", "pi", "~200K", "New", "Baseline", "Local cache"]) expect(text, part).toContain(part);
      expect(rows.e.allText()).toContain("Disabled in catalog");
      expect(rows.e.allText()).toContain("Curated");
      expect(rows.c.allText()).toContain("Already enabled");
      expect(rows.a.allText()).toContain("Ambiguous");
    });

    describe("scan and import flow", () => {
      class FakeApiError extends Error {
        constructor(public status: number, message: string, public data?: unknown) { super(message); }
      }
      function flow(responses: Array<unknown | Error>) {
        const calls: Array<{ method: string; path: string; body: any; signal?: AbortSignal }> = [];
        const toasts: string[] = [];
        const log = { renders: 0, restored: [] as unknown[], limitsRebased: 0 };
        const discovery: any = {
          harness: "claude", mode: "on_demand", preview: null, scanned: null, scanning: false, scanSeq: 0, controller: null, saving: false,
          selected: new Set<string>(), query: "", status: "all", provider: "", banner: null, error: "",
        };
        const state: any = { busy: false, snap: { revision: "r1" }, drawer: { kind: "discover", discovery }, drawerReturn: { from: "models" } };
        const queue = [...responses];
        const api = async (method: string, path: string, body: any, signal?: AbortSignal) => {
          calls.push({ method, path, body, signal });
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return next;
        };
        const api_ = load<any>(["isDiscoveryDrawer", "abortDiscoveryScan", "detachDrawer", "reconcileSelection", "isActionableCandidate", "discoveryImportFailure",
          "runDiscovery", "commitDiscoveryImport"], {
          state, api, t, countLabel: (count: number, noun: string) => (count === 1 ? noun : `${noun}s`),
          render: () => { log.renders++; }, toast: (_kind: string, get: () => string) => toasts.push(get()),
          rebaseLimitsDraft: () => { log.limitsRebased++; }, normalizeFilters: () => undefined, syncUrl: () => undefined,
          restoreDrawerReturn: (back: unknown) => log.restored.push(back),
          document: { body: { setAttribute: () => undefined, removeAttribute: () => undefined } },
        });
        return { ...api_, state, discovery, calls, toasts, log };
      }
      const preview = (revision: string, keys: string[]) => ({ preview_id: "p1", revision, candidates: keys.map((key) => candidate(key)), harnesses: [] });

      it("scans with the chosen scope, drops stale selections on rescan and reports how many", async () => {
        const f = flow([preview("r1", ["a", "b"]), preview("r1", ["b", "c"])]);
        f.discovery.mode = "offline";
        await f.runDiscovery();
        expect(f.calls[0]).toMatchObject({ method: "POST", path: "/api/discover", body: { harness: "claude", mode: "offline", providers: "configured", revision: "r1" } });
        expect(f.calls[0].signal).toBeInstanceOf(AbortSignal);
        expect(f.discovery.preview.candidates).toHaveLength(2);
        expect(f.discovery.scanning).toBe(false);
        f.discovery.selected = new Set(["a", "b"]);
        await f.runDiscovery({ keepSelection: true });
        expect([...f.discovery.selected]).toEqual(["b"]);
        expect(f.toasts).toEqual(["1 selected models are no longer available."]);
        f.discovery.selected = new Set(["b"]);
        await f.runDiscovery();
        expect(f.discovery.selected.size).toBe(0);
      });

      it("omits `harness` from the scan request for all harnesses and sends the exact ID otherwise, including \"all\"", async () => {
        const f = flow([preview("r1", ["a"]), preview("r1", ["a"]), preview("r1", ["a"])]);
        f.discovery.harness = "";
        await f.runDiscovery();
        expect(f.calls[0].body).not.toHaveProperty("harness");
        expect(f.calls[0].body).toMatchObject({ mode: "on_demand", providers: "configured", revision: "r1" });
        f.discovery.harness = "all";
        await f.runDiscovery();
        expect(f.calls[1].body).toMatchObject({ harness: "all" });
        f.discovery.harness = "claude";
        await f.runDiscovery();
        expect(f.calls[2].body).toMatchObject({ harness: "claude" });
        expect(f.discovery.scanned).toEqual({ harness: "claude", mode: "on_demand" });
      });

      it("adopts the fresh snapshot and retries once when the config changed before the scan", async () => {
        const f = flow([new FakeApiError(409, "conflict", { snapshot: { revision: "r2" } }), preview("r2", ["a"])]);
        await f.runDiscovery();
        expect(f.calls.map((call) => call.body.revision)).toEqual(["r1", "r2"]);
        expect(f.state.snap.revision).toBe("r2");
        expect(f.discovery.preview.revision).toBe("r2");
        expect(f.discovery.error).toBe("");
        expect(f.log.limitsRebased).toBe(1);
      });

      it("shows a scan failure inline and ignores the response of a drawer that was closed meanwhile", async () => {
        const failed = flow([new FakeApiError(0, "The settings server is unavailable.")]);
        await failed.runDiscovery();
        expect(failed.discovery.error).toBe("The settings server is unavailable.");
        expect(failed.discovery.scanning).toBe(false);

        const closed = flow([preview("r1", ["a"])]);
        const run = closed.runDiscovery();
        closed.state.drawer = null;
        await run;
        expect(closed.discovery.preview).toBeNull();
      });

      it("imports the selected keys of the previewed revision, reports counts, closes the drawer and refreshes the page", async () => {
        const f = flow([{ snapshot: { revision: "r3" }, imported: ["x1", "x2"], enabled: ["y1"] }]);
        Object.assign(f.discovery, { preview: preview("r1", ["a", "b"]), selected: new Set(["a", "b"]) });
        await f.commitDiscoveryImport();
        expect(f.calls[0]).toMatchObject({ method: "POST", path: "/api/models/import", body: {
          preview_id: "p1", revision: "r1", selections: [{ key: "a" }, { key: "b" }],
        } });
        expect(f.state.snap.revision).toBe("r3");
        expect(f.log.limitsRebased).toBe(1);
        expect(f.toasts).toEqual(["Imported 2 models, enabled 1 model"]);
        expect(f.state.drawer).toBeNull();
        expect(f.log.restored).toEqual([{ from: "models" }]);
        expect(f.state.busy).toBe(false);
      });

      it("keeps the selection and offers a refresh on a 409 conflict, then refreshing keeps the keys that still apply", async () => {
        const f = flow([new FakeApiError(409, "conflict", { snapshot: { revision: "r2" } }), preview("r2", ["a", "c"])]);
        Object.assign(f.discovery, { preview: preview("r1", ["a", "b"]), selected: new Set(["a", "b"]) });
        await f.commitDiscoveryImport();
        expect(f.discovery.banner).toEqual({ kind: "conflict" });
        expect([...f.discovery.selected]).toEqual(["a", "b"]);
        expect(f.state.drawer).not.toBeNull();
        expect(f.state.snap.revision).toBe("r2");
        // The adopted snapshot must also rebase the Limits draft, or a later Limits save could undo a concurrent edit.
        expect(f.log.limitsRebased).toBe(1);
        expect(f.discovery.saving).toBe(false);
        await f.runDiscovery({ keepSelection: true });
        expect(f.discovery.banner).toBeNull();
        expect([...f.discovery.selected]).toEqual(["a"]);
        expect(f.discovery.preview.revision).toBe("r2");
      });

      it("shows an expired-preview banner on 410 and a plain error banner on other failures, keeping the selection", async () => {
        const f = flow([new FakeApiError(410, "Preview expired; run discovery again."), new FakeApiError(400, "Selection is not part of this preview. Run discovery again.")]);
        Object.assign(f.discovery, { preview: preview("r1", ["a"]), selected: new Set(["a"]) });
        await f.commitDiscoveryImport();
        expect(f.discovery.banner).toEqual({ kind: "expired" });
        await f.commitDiscoveryImport();
        expect(f.discovery.banner).toEqual({ kind: "error", text: "Selection is not part of this preview. Run discovery again." });
        expect([...f.discovery.selected]).toEqual(["a"]);
        expect(f.state.drawer).not.toBeNull();
      });

      it("never imports an empty selection or while another import runs", async () => {
        const f = flow([]);
        Object.assign(f.discovery, { preview: preview("r1", ["a"]) });
        await f.commitDiscoveryImport();
        f.discovery.selected = new Set(["a"]);
        f.state.busy = true;
        await f.commitDiscoveryImport();
        expect(f.calls).toEqual([]);
      });
    });

    describe("collision-free all-harnesses scope", () => {
      const snapWith = (...ids: string[]) => ({ harnesses: Object.fromEntries(ids.map((id) => [id, { display_name: id, enabled: true }])) });

      it("uses the empty string, which no harness ID can equal, as the all-harnesses scope", () => {
        expect(constants).toMatch(/const ALL_HARNESSES = "";/);
        expect(isValidEntityId("")).toBe(false);
        const { discoveryHarnessOptions } = load<any>(["discoveryHarnessOptions"], { state: { snap: snapWith("claude", "all") }, t });
        const options = discoveryHarnessOptions() as Array<[string, string]>;
        expect(options[0]).toEqual(["", "All enabled harnesses"]);
        expect(options.filter(([value]) => value === "all")).toEqual([["all", "all"]]);
      });

      it("opens scoped to a harness literally named all, and to every harness only when asked for it", () => {
        const opened: any[] = [];
        const state: any = { snap: snapWith("claude", "all"), drawer: null, drawerReturn: null };
        const { openDiscoveryDrawer } = load<any>(["openDiscoveryDrawer", "newDiscoveryState"], {
          state, render: () => undefined, document: { activeElement: null }, requestAnimationFrame: () => undefined, focusDrawerStart: () => undefined,
        }, "openDiscoveryDrawer");
        openDiscoveryDrawer("all");
        opened.push(state.drawer.discovery.harness);
        state.drawer = null;
        openDiscoveryDrawer();
        opened.push(state.drawer.discovery.harness);
        state.drawer = null;
        openDiscoveryDrawer("claude");
        opened.push(state.drawer.discovery.harness);
        state.drawer = null;
        openDiscoveryDrawer("gone");
        opened.push(state.drawer.discovery.harness);
        expect(opened).toEqual(["all", "", "claude", ""]);
        // Without a harness literally named "all" the word is not special: it falls back to every harness.
        state.snap = snapWith("claude");
        state.drawer = null;
        openDiscoveryDrawer("all");
        expect(state.drawer.discovery.harness).toBe("");
      });

      it("titles the all-harnesses drawer plainly and a literal \"all\" harness by its name", () => {
        const { discoveryTitle } = load<any>(["discoveryTitle"], { state: { snap: { harnesses: { all: { display_name: "Literally all" } } } }, t });
        expect(discoveryTitle({ harness: "" })).toBe("Discover models");
        expect(discoveryTitle({ harness: "all" })).toBe("Discover models — Literally all");
      });
    });

    describe("actionable-first order and truncation note", () => {
      it("keeps the order the server chose (new, disabled, ambiguous, already configured) through filtering and rendering", () => {
        const { visibleCandidates } = load<any>(["visibleCandidates", "candidateMatches"], {}, "visibleCandidates");
        const ordered = [
          candidate("n1", { status: "new" }), candidate("n2", { status: "new", action: "import" }),
          candidate("d1", { status: "disabled_in_catalog", action: "enable" }), candidate("m1", { status: "ambiguous", action: "none" }),
          candidate("c1", { status: "already_configured", action: "none" }),
        ];
        const d = { preview: { candidates: ordered }, query: "", status: "all", provider: "" };
        expect(visibleCandidates(d).map((entry: any) => entry.key)).toEqual(["n1", "n2", "d1", "m1", "c1"]);
        expect(visibleCandidates({ ...d, query: "model" }).map((entry: any) => entry.key)).toEqual(["n1", "n2", "d1", "m1", "c1"]);
        for (const name of ["visibleCandidates", "candidateMatches", "discoveryList"]) {
          expect(functionSource(name), name).not.toMatch(/\.sort\(|\.toSorted\(|\.reverse\(/);
        }
      });

      it("shows the truncation note with the shown and total counts only when the preview was truncated", () => {
        const statusPill = (kind: string, text: string) => fakeH("span", { class: `pill ${kind}`, text });
        const { discoveryNotes } = load<any>(["discoveryNotes"], { t, statusPill, h: fakeH, discoveryDiagnosticNotes: () => [] });
        expect(discoveryNotes({ truncated: false, candidates: [], total_candidates: 0 })).toBeNull();
        const note = discoveryNotes({ truncated: true, candidates: new Array(1000).fill(0), total_candidates: 1500 }) as FakeNode;
        expect(note.allText()).toBe("Preview limited to the first 1000 of 1500 models.");
        expect(html).toContain('"Preview limited to the first {0} of {1} models.": "Предпросмотр ограничен первыми {0} из {1} моделей."');
      });
    });

    it("keeps the discovery drawer out of entity-only code paths and blocks closing while an import runs", () => {
      expect(functionSource("drawerDirty")).toContain("isDiscoveryDrawer(drawer)");
      expect(functionSource("drawerEntityIsGone")).toContain("!isDiscoveryDrawer(drawer)");
      expect(functionSource("syncDraftsAfterConflict")).toContain("!isDiscoveryDrawer(drawer)");
      expect(functionSource("syncDirtyIndicator")).toContain("isDiscoveryDrawer(state.drawer)");
      expect(functionSource("closeDrawer")).toMatch(/isDiscoveryDrawer\(state\.drawer\) && state\.drawer\.discovery\.saving\) return/);
      expect(functionSource("detachDrawer")).toContain("abortDiscoveryScan");
    });

    it("ships a Russian translation for every discovery label, status, diagnostic, button and toast", () => {
      const russianBlock = /^const russian = \{([\s\S]*?)^\};/m.exec(html)![1];
      const translated = new Map([...russianBlock.matchAll(/^\s*("(?:[^"\\]|\\.)*"):\s*("(?:[^"\\]|\\.)*"),?\s*$/gm)]
        .map(([, english, russian]) => [JSON.parse(english) as string, JSON.parse(russian) as string]));
      const constantsValues = new Function(`${constants}\nreturn { DISCOVERY_MODE_OPTIONS, DISCOVERY_STATUS_FILTERS, DISCOVERY_STATUS_LABEL, DISCOVERY_QUALITY_LABEL, DISCOVERY_QUALITY_HINT, DISCOVERY_EVIDENCE_LABEL, DISCOVERY_DIAGNOSTIC_LABEL };`)();
      const labels = new Set<string>(["Unsupported", "Truncated", "The request was cancelled."]);
      // Mode, status and diagnostic maps also hold machine codes; only human labels start with a capital letter.
      const humanLabels = (value: unknown): string[] => {
        const found = new Set<string>();
        const walk = (item: unknown): void => {
          if (typeof item === "string") { if (/^[A-Z]/.test(item)) found.add(item); }
          else if (Array.isArray(item)) item.forEach(walk);
          else if (item && typeof item === "object") Object.values(item).forEach(walk);
        };
        walk(value);
        return [...found];
      };
      for (const label of humanLabels(constantsValues)) labels.add(label);
      expect(labels.size).toBeGreaterThan(25);
      expect([...labels].filter((label) => !translated.has(label))).toEqual([]);
      for (const text of [
        "Discover models", "Discover models — {0}", "Scan", "Rescan", "Scanning…", "Select all actionable", "Clear selection", "Import selected",
        "Refresh preview", "Imported {0} {1}, enabled {2} {3}", "{0} selected ({1} new, {2} to enable)", "Select models to import or enable",
        "This preview expired. Scan again to continue.", "Manual only (custom wrapper)", "Discard and discover",
      ]) expect(translated.get(text), text).toBeTruthy();
    });

    it("styles the review list with design tokens only: no literal font sizes, uppercase, extra weights or 50% radii", () => {
      const css = html.slice(html.indexOf("/* Discovery drawer */"), html.indexOf("/* Confirm dialog */"));
      expect(css).toContain(".ledger-row");
      expect(css).not.toMatch(/font-size\s*:\s*[^;{}]*\d(?:px|rem|em|pt|%)/);
      expect(css).not.toMatch(/border-radius\s*:[^;]*50%|text-transform|\sstyle\s*=/);
      expect([...css.matchAll(/font-weight\s*:\s*(\d+)/g)].every(([, weight]) => ["400", "500", "600"].includes(weight))).toBe(true);
      const code = html.slice(html.indexOf("function newDiscoveryState"), html.indexOf("// Presets view: master-detail role matrix"));
      expect(code).not.toMatch(/\sstyle\s*=|\.style\s*(?:\.|\[|=)|setAttribute\(\s*["']style["']|innerHTML|outerHTML|insertAdjacentHTML/);
    });
  });
});

describe("settings UI model discovery and atomic import (Wave 3)", () => {
  const FRESH_MODEL = "claude-fresh-9";
  let dir: string;
  let userPath: string;
  let manager: ConfigManager;
  let ui: SettingsUiHandle;
  let port: number;
  let runnerCalls: Array<Parameters<DiscoveryRunner>[1]>;
  let found: Record<string, DiscoveredModel[]>;

  const observation = (models: DiscoveredModel[]): DiscoveryObservation => ({ models, diagnostics: [], truncated: false });
  const listed = (cli_model: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel =>
    ({ cli_model, availability: "reported_available", evidence: "cli_listing", ...extra });

  /** The real preview pipeline over fake local/CLI sources: nothing here reads the home directory or starts a CLI. */
  const runner: DiscoveryRunner = async (config, options) => {
    runnerCalls.push(options);
    return previewDiscovery(config, options, {
      readLocal: async (input) => observation(found[input.harnessId] ?? []),
      probe: async () => observation([]),
    });
  };

  async function start(extra: Parameters<typeof startSettingsUi>[0] = {}): Promise<void> {
    ui = await startSettingsUi({
      port: 0, openBrowser: false, configManager: manager, configWriter: new ConfigWriter(manager), adapterRegistry: new AdapterRegistry(),
      lockDir: join(dir, "locks"), discoverModels: runner, ...extra,
    });
    port = ui.port;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "orch-settings-discovery-"));
    userPath = join(dir, "config", "models.toml");
    manager = new ConfigManager({ defaultPath: DEFAULT_CATALOG, userPath });
    runnerCalls = [];
    found = { claude: [listed(FRESH_MODEL, { context_window: 272_000, context_precision: "rounded" }), listed(MODEL_ID)] };
    await start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ui.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function session(): Promise<{ cookie: string; csrf: string; revision: string }> {
    const { cookie, csrf } = await bootstrapLogin(port, new URL(ui.url).searchParams.get("token") ?? "");
    const state = (await send(port, "GET", "/api/state", authHeaders({ cookie, csrf }))).json();
    return { cookie, csrf, revision: state.snapshot.revision };
  }

  const post = (auth: { cookie: string; csrf: string }, path: string, payload: unknown, headers: OutgoingHttpHeaders = {}) =>
    send(port, "POST", path, {
      cookie: auth.cookie, origin: `http://127.0.0.1:${port}`, "x-orch-token": auth.csrf, "content-type": "application/json", ...headers,
    }, JSON.stringify(payload));

  const put = (auth: { cookie: string; csrf: string }, path: string, payload: unknown) =>
    send(port, "PUT", path, {
      cookie: auth.cookie, origin: `http://127.0.0.1:${port}`, "x-orch-token": auth.csrf, "content-type": "application/json",
    }, JSON.stringify(payload));

  const fileText = () => (existsSync(userPath) ? readFileSync(userPath, "utf8") : null);
  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const userToml = () => parse(readFileSync(userPath, "utf8")) as Record<string, any>;

  /** Disables the built-in model through the API, so discovery reports it as "disabled in catalog" (enable) next to one brand-new model. */
  async function disabledBuiltInSession() {
    const auth = await session();
    const disabled = await put(auth, `/api/models/${MODEL_ID}`, { patch: { enabled: false }, revision: auth.revision });
    expect(disabled.status).toBe(200);
    return { auth, revision: disabled.json().snapshot.revision as string };
  }

  const discover = (auth: { cookie: string; csrf: string }, revision: string, extra: Record<string, unknown> = {}) =>
    post(auth, "/api/discover", { harness: "claude", mode: "offline", revision, ...extra });

  it("enforces Host, session, Origin, CSRF and JSON on both endpoints before any scan or write", async () => {
    const auth = await session();
    const discoverBody = { harness: "claude", mode: "offline" };
    const importBody = { preview_id: "x", revision: auth.revision, selections: [{ key: "k" }] };
    for (const [path, payload] of [["/api/discover", discoverBody], ["/api/models/import", importBody]] as const) {
      const noOrigin = await send(port, "POST", path, { cookie: auth.cookie, "x-orch-token": auth.csrf, "content-type": "application/json" }, JSON.stringify(payload));
      expect(noOrigin.status, `${path} without Origin`).toBe(403);
      expect((await post(auth, path, payload, { origin: "http://evil.example" })).status).toBe(403);
      expect((await post(auth, path, payload, { origin: `http://localhost:${port}` })).status).toBe(403);
      expect((await post(auth, path, payload, { "x-orch-token": "wrong" })).status).toBe(403);
      expect((await post(auth, path, payload, { "x-orch-token": "" })).status).toBe(403);
      expect((await post(auth, path, payload, { "content-type": "text/plain" })).status).toBe(415);
      expect((await post({ cookie: "orch_session=forged", csrf: auth.csrf }, path, payload)).status).toBe(401);
      expect((await send(port, "POST", path, { cookie: auth.cookie, origin: `http://127.0.0.1:${port}`, "x-orch-token": auth.csrf,
        "content-type": "application/json", host: `evil.example:${port}` }, JSON.stringify(payload))).status).toBe(403);
      expect((await send(port, "GET", path, authHeaders(auth))).status).toBe(404);
    }
    expect(runnerCalls).toEqual([]);
    expect(fileText()).toBeNull();
  });

  it("defaults to all harnesses, on-demand and configured providers, and rejects unknown scopes without scanning", async () => {
    const auth = await session();
    const defaults = await post(auth, "/api/discover", {});
    expect(defaults.status).toBe(200);
    expect(runnerCalls).toHaveLength(1);
    // "all" in the page's request means no harness filter: discovery gets the option omitted, never the literal "all".
    expect(runnerCalls[0]).toMatchObject({ mode: "on_demand", providers: "configured" });
    expect(runnerCalls[0]).not.toHaveProperty("harness");
    expect(runnerCalls[0].signal).toBeInstanceOf(AbortSignal);

    for (const body of [{ harness: "no-such-harness" }, { harness: "" }, { harness: 7 }, { mode: "online" }, { providers: "everything" }, { revision: "" }]) {
      const rejected = await post(auth, "/api/discover", body);
      expect(rejected.status, JSON.stringify(body)).toBe(400);
    }
    expect(runnerCalls).toHaveLength(1);
    const stale = await post(auth, "/api/discover", { harness: "claude", revision: "stale-revision" });
    expect(stale.status).toBe(409);
    expect(stale.json().snapshot.revision).toBe(auth.revision);
    expect(runnerCalls).toHaveLength(1);
    expect(fileText()).toBeNull();
  });

  it("targets only a harness literally named \"all\" when the ID is given, and every harness when `harness` is omitted or null", async () => {
    mkdirSync(join(dir, "config"), { recursive: true });
    writeFileSync(userPath, stringify({ schema_version: 1, harnesses: {
      all: { custom: true, driver: "pi", display_name: "Literally all", binary: "pi", model_discovery: "native" },
    } }));
    found.all = [listed("literal-all-model")];
    const auth = await session();

    const literal = await post(auth, "/api/discover", { harness: "all", mode: "offline" });
    expect(literal.status).toBe(200);
    expect(runnerCalls[0]).toMatchObject({ harness: "all", mode: "offline" });
    expect(literal.json().candidates.map((entry: any) => entry.harness)).toEqual(["all"]);
    expect(literal.json().harnesses.map((entry: any) => entry.harness)).toEqual(["all"]);

    for (const body of [{ mode: "offline" }, { harness: null, mode: "offline" }]) {
      const everything = await post(auth, "/api/discover", body);
      expect(everything.status, JSON.stringify(body)).toBe(200);
      const call = runnerCalls.at(-1)!;
      expect(call).not.toHaveProperty("harness");
      const harnesses = everything.json().harnesses.map((entry: any) => entry.harness);
      expect(harnesses).toEqual(expect.arrayContaining(["all", "claude"]));
      expect(everything.json().candidates.map((entry: any) => entry.harness)).toEqual(expect.arrayContaining(["all", "claude"]));
    }

    // Without such a harness, "all" is just an unknown ID.
    writeFileSync(userPath, stringify({ schema_version: 1 }));
    const unknown = await post(auth, "/api/discover", { harness: "all", mode: "offline" });
    expect(unknown.status).toBe(400);
    expect(runnerCalls).toHaveLength(3);
  });

  it("scrubs every candidate string and diagnostic from a custom discovery provider, including URL credentials", async () => {
    await ui.close();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const urlSecret = "hunter2-user-password";
    const querySecret = "q-api-key-value-123";
    const dirty = `https://svc:${urlSecret}@models.example/v1/m?api_key=${querySecret}`;
    const clean = "https://models.example/v1/m";
    await start({
      discoverModels: async (config, options) => {
        const preview = await runner(config, options);
        return {
          ...preview,
          harnesses: preview.harnesses.map((entry) => ({ ...entry, diagnostics: [{ stage: "probe" as const, code: "invalid_output" as const, message: `from ${dirty} using Bearer ${secret}` }] })),
          candidates: preview.candidates.map((entry) => ({
            ...entry,
            proposed_id: `${entry.proposed_id}-${secret}`,
            ...(entry.existing_model_id === undefined ? {} : { existing_model_id: `${entry.existing_model_id}-${secret}` }),
            template_id: `tpl-${secret}`,
            discovered: { ...entry.discovered, cli_model: dirty, cli_provider: dirty, display_name: `Name ${secret} ${dirty}` },
          })),
        };
      },
    });
    const { auth, revision } = await disabledBuiltInSession();
    const res = await discover(auth, revision);
    expect(res.status).toBe(200);
    for (const leaked of [secret, urlSecret, querySecret, "svc:", "api_key="]) expect(res.text, leaked).not.toContain(leaked);
    const body = res.json();
    expect(body.candidates.length).toBeGreaterThan(1);
    for (const entry of body.candidates) {
      expect(entry.discovered.cli_model).toBe(clean);
      expect(entry.discovered.cli_provider).toBe(clean);
      expect(entry.discovered.display_name).toBe(`Name [REDACTED] ${clean}`);
      expect(entry.proposed_id).toContain("[REDACTED]");
      expect(entry.template_id).toBe("tpl-[REDACTED]");
    }
    expect(body.candidates.find((entry: any) => entry.existing_model_id)?.existing_model_id).toContain("[REDACTED]");
    expect(body.harnesses[0].diagnostics[0].message).toBe(`from ${clean} using Bearer [REDACTED]`);
    // The importable keys still resolve against the server-held candidates, untouched by the display scrubbing.
    expect((await post(auth, "/api/models/import", { preview_id: body.preview_id, revision, selections: [{ key: body.candidates[0].key }] })).status).toBe(200);
  });

  it("redacts quarantine reasons again in /api/state, route results, import results and 409 snapshots", async () => {
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const real = manager.load.bind(manager);
    vi.spyOn(manager, "load").mockImplementation(() => ({
      ...real(), quarantined: [{ section: "models", id: "orphan", reason: `bad value ${secret} at https://u:pw-secret-9@h.example/p?token=tok-secret-9` }],
    }));
    const auth = await session();
    const state = await send(port, "GET", "/api/state", authHeaders(auth));
    expect(state.status).toBe(200);
    for (const leaked of [secret, "pw-secret-9", "tok-secret-9"]) expect(state.text, leaked).not.toContain(leaked);
    expect(state.json().snapshot.quarantined).toEqual([{ section: "models", id: "orphan", reason: "bad value [REDACTED] at https://h.example/p" }]);

    const stale = await put(auth, `/api/models/${MODEL_ID}`, { patch: { enabled: false }, revision: "stale" });
    expect(stale.status).toBe(409);
    expect(stale.text).not.toContain(secret);
    expect(stale.json().snapshot.quarantined[0].reason).toBe("bad value [REDACTED] at https://h.example/p");

    const saved = await put(auth, `/api/models/${MODEL_ID}`, { patch: { enabled: false }, revision: auth.revision });
    expect(saved.status).toBe(200);
    expect(saved.text).not.toContain(secret);
    expect(saved.json().snapshot.quarantined[0].reason).toBe("bad value [REDACTED] at https://h.example/p");
  });

  it("returns a sanitized preview and keeps the model payloads, secrets and raw probe data on the server", async () => {
    const { auth, revision } = await disabledBuiltInSession();
    found.claude.push(listed("with-secret", { display_name: "x" }));
    const res = await discover(auth, revision);
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.preview_id).toMatch(/^[0-9a-f]{32}$/);
    expect(body).toMatchObject({ revision, mode: "offline", providers: "configured", truncated: false });
    expect(body.total_candidates).toBe(body.candidates.length);
    const fresh = body.candidates.find((entry: any) => entry.discovered.cli_model === FRESH_MODEL);
    expect(fresh).toMatchObject({ harness: "claude", status: "new", action: "import", metadata_quality: "baseline",
      discovered: { cli_model: FRESH_MODEL, context_window: 272_000, context_precision: "rounded", evidence: "cli_listing" } });
    const reenable = body.candidates.find((entry: any) => entry.proposed_id === MODEL_ID);
    expect(reenable).toMatchObject({ status: "disabled_in_catalog", action: "enable", existing_model_id: MODEL_ID });
    for (const entry of body.candidates) {
      expect(Object.keys(entry)).not.toContain("proposed_model");
      expect(entry.key).toMatch(/^[0-9a-f]+$/);
    }
    expect(body.harnesses.find((entry: any) => entry.harness === "claude")).toMatchObject({ harness: "claude", driver: "claude", model_count: 3 });
    expect(JSON.stringify(body)).not.toMatch(/proposed_model|"env"|stdout|stderr/);
    expect(runnerCalls[0]).toMatchObject({ harness: "claude", mode: "offline" });
  });

  it("redacts secrets from diagnostics and reports a failing scan as a 500 without leaking its message", async () => {
    await ui.close();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    let fail = false;
    await start({
      discoverModels: async (config, options) => {
        if (fail) throw new Error(`probe crashed with key ${secret}`);
        const preview = await runner(config, options);
        return { ...preview, harnesses: preview.harnesses.map((entry) => ({ ...entry, diagnostics: [...entry.diagnostics, { stage: "probe" as const, code: "invalid_output" as const, message: `bad output ${secret}` }] })) };
      },
    });
    const auth = await session();
    const ok = await post(auth, "/api/discover", { harness: "claude", mode: "offline" });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain(secret);
    expect(ok.json().harnesses[0].diagnostics.at(-1)).toMatchObject({ stage: "probe", code: "invalid_output" });
    fail = true;
    const failed = await post(auth, "/api/discover", { harness: "claude", mode: "offline" });
    expect(failed.status).toBe(500);
    expect(failed.text).not.toContain(secret);
    expect(failed.json().error).toMatch(/^Model discovery failed:/);
  });

  it("imports new models and re-enables a disabled built-in one in one atomic write, leaving the built-in catalog untouched", async () => {
    const { auth, revision } = await disabledBuiltInSession();
    const catalogBefore = sha(DEFAULT_CATALOG);
    const preview = (await discover(auth, revision)).json();
    const fresh = preview.candidates.find((entry: any) => entry.status === "new" && entry.discovered.cli_model === FRESH_MODEL);
    const reenable = preview.candidates.find((entry: any) => entry.action === "enable");
    expect(fresh && reenable).toBeTruthy();

    const imported = await post(auth, "/api/models/import", {
      preview_id: preview.preview_id, revision,
      // A client-supplied payload must be ignored: the server resolves the key against its own preview.
      selections: [{ key: fresh.key, proposed_model: { cli_model: "evil", display_name: "Evil" } }, { key: reenable.key }],
    });
    expect(imported.status).toBe(200);
    const result = imported.json();
    expect(result.imported).toEqual([fresh.proposed_id]);
    expect(result.enabled).toEqual([MODEL_ID]);
    expect(result).toMatchObject({ imported_count: 1, enabled_count: 1, skipped: [] });
    expect(result.snapshot.models[fresh.proposed_id]).toMatchObject({ enabled: true, harness: "claude", cli_model: FRESH_MODEL, provenance: "custom" });
    expect(result.snapshot.models[fresh.proposed_id].cli_model).not.toBe("evil");
    expect(result.snapshot.models[MODEL_ID].enabled).toBe(true);

    const stored = userToml().models;
    expect(stored[fresh.proposed_id]).toMatchObject({ custom: true, cli_model: FRESH_MODEL, harness: "claude" });
    expect(stored[MODEL_ID]?.enabled).not.toBe(false);
    expect(sha(DEFAULT_CATALOG)).toBe(catalogBefore);

    const state = (await send(port, "GET", "/api/state", authHeaders(auth))).json();
    expect(state.snapshot.revision).toBe(result.snapshot.revision);
  });

  it("creates a disabled model when a selection says enabled:false, and refuses that for an existing card", async () => {
    const { auth, revision } = await disabledBuiltInSession();
    const preview = (await discover(auth, revision)).json();
    const fresh = preview.candidates.find((entry: any) => entry.status === "new");
    const reenable = preview.candidates.find((entry: any) => entry.action === "enable");
    const before = fileText();
    const refused = await post(auth, "/api/models/import", { preview_id: preview.preview_id, revision, selections: [{ key: reenable.key, enabled: false }] });
    expect(refused.status).toBe(400);
    expect(fileText()).toBe(before);

    const created = await post(auth, "/api/models/import", { preview_id: preview.preview_id, revision, selections: [{ key: fresh.key, enabled: false }] });
    expect(created.status).toBe(200);
    expect(created.json().snapshot.models[fresh.proposed_id].enabled).toBe(false);
    expect(created.json().enabled).toEqual([]);
  });

  it("answers 409 with the fresh snapshot when the config changed between discover and import, leaving the file as the other writer left it", async () => {
    const { auth, revision } = await disabledBuiltInSession();
    const preview = (await discover(auth, revision)).json();
    const fresh = preview.candidates.find((entry: any) => entry.status === "new");
    const other = await put(auth, "/api/defaults", { patch: { max_concurrency: 3 }, revision });
    expect(other.status).toBe(200);
    const afterOther = fileText();

    const stale = await post(auth, "/api/models/import", { preview_id: preview.preview_id, revision, selections: [{ key: fresh.key }] });
    expect(stale.status).toBe(409);
    expect(stale.json()).toMatchObject({ code: "REVISION_CONFLICT", snapshot: { revision: other.json().snapshot.revision } });
    // Sending the page's newer revision does not make an older preview importable either.
    const mismatched = await post(auth, "/api/models/import", {
      preview_id: preview.preview_id, revision: other.json().snapshot.revision, selections: [{ key: fresh.key }],
    });
    expect(mismatched.status).toBe(409);
    expect(fileText()).toBe(afterOther);

    // A refreshed preview works again.
    const again = (await discover(auth, other.json().snapshot.revision)).json();
    const retry = await post(auth, "/api/models/import", {
      preview_id: again.preview_id, revision: again.revision, selections: [{ key: again.candidates.find((entry: any) => entry.status === "new").key }],
    });
    expect(retry.status).toBe(200);
  });

  it("lets exactly one of two concurrent imports on the same revision win and reports the other as 409", async () => {
    const { auth, revision } = await disabledBuiltInSession();
    const preview = (await discover(auth, revision)).json();
    const fresh = preview.candidates.find((entry: any) => entry.status === "new");
    const request = () => post(auth, "/api/models/import", { preview_id: preview.preview_id, revision, selections: [{ key: fresh.key }] });
    const results = await Promise.all([request(), request()]);
    expect(results.map((entry) => entry.status).sort()).toEqual([200, 409]);
    const loser = results.find((entry) => entry.status === 409)!;
    expect(loser.json().snapshot.models[fresh.proposed_id]).toBeDefined();
    expect(Object.keys(userToml().models).filter((id) => id === fresh.proposed_id)).toHaveLength(1);
    // Repeating the submit after the fact is a conflict too, never a duplicate card.
    expect((await request()).status).toBe(409);
  });

  it("answers 410 for an unknown, expired or evicted preview without writing", async () => {
    const auth = await session();
    const unknown = await post(auth, "/api/models/import", { preview_id: "0".repeat(32), revision: auth.revision, selections: [{ key: "k" }] });
    expect(unknown.status).toBe(410);
    expect(unknown.json().error).toBe("Preview expired; run discovery again.");

    const first = (await discover(auth, auth.revision)).json();
    const key = first.candidates.find((entry: any) => entry.status === "new").key;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 11 * 60 * 1000);
    const expired = await post(auth, "/api/models/import", { preview_id: first.preview_id, revision: first.revision, selections: [{ key }] });
    expect(expired.status).toBe(410);
    vi.restoreAllMocks();
    expect(fileText()).toBeNull();

    // At most 8 previews are kept: the oldest one is dropped when a ninth arrives.
    const ids: string[] = [];
    for (let index = 0; index < 9; index++) ids.push((await discover(auth, auth.revision)).json().preview_id);
    expect((await post(auth, "/api/models/import", { preview_id: ids[0], revision: auth.revision, selections: [{ key }] })).status).toBe(410);
    expect((await post(auth, "/api/models/import", { preview_id: ids[8], revision: auth.revision, selections: [{ key }] })).status).toBe(200);
  });

  it("honours a configured preview lifetime", async () => {
    await ui.close();
    await start({ previewTtlMs: 1 });
    const auth = await session();
    const preview = (await discover(auth, auth.revision)).json();
    const key = preview.candidates.find((entry: any) => entry.status === "new").key;
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5);
    expect((await post(auth, "/api/models/import", { preview_id: preview.preview_id, revision: preview.revision, selections: [{ key }] })).status).toBe(410);
  });

  it("rejects empty, malformed, unknown, repeated, non-actionable and oversized selections with 400 and untouched file bytes", async () => {
    const { auth, revision } = await disabledBuiltInSession();
    found.claude.push(listed("claude-sonnet-never-disabled"));
    const preview = (await discover(auth, revision)).json();
    const fresh = preview.candidates.find((entry: any) => entry.status === "new");
    // Make one candidate non-actionable by importing it elsewhere is not needed: a synthetic "already configured" key comes from a second preview.
    const before = fileText();
    const bad = (selections: unknown, extra: Record<string, unknown> = {}) =>
      post(auth, "/api/models/import", { preview_id: preview.preview_id, revision, selections, ...extra });

    expect((await bad([])).status).toBe(400);
    expect((await bad("all")).status).toBe(400);
    expect((await bad({ key: fresh.key })).status).toBe(400);
    expect((await bad([null])).status).toBe(400);
    expect((await bad(["a-key"])).status).toBe(400);
    expect((await bad([{ key: "" }])).status).toBe(400);
    expect((await bad([{ key: 7 }])).status).toBe(400);
    expect((await bad([{ key: fresh.key, enabled: "yes" }])).status).toBe(400);
    expect((await bad([{ key: "no-such-key" }])).status).toBe(400);
    expect((await bad([{ key: fresh.key }, { key: fresh.key }])).status).toBe(400);
    expect((await bad([{ key: fresh.key }], { preview_id: "" })).status).toBe(400);
    expect((await bad([{ key: fresh.key }], { preview_id: undefined })).status).toBe(400);
    expect((await bad([{ key: fresh.key }], { revision: undefined })).status).toBe(400);
    expect((await bad([{ key: fresh.key }, { key: "no-such-key" }])).status).toBe(400);
    const tooMany = await bad(Array.from({ length: MAX_APPLY_BATCH + 1 }, (_, index) => ({ key: `k${index}` })));
    expect(tooMany.status).toBe(400);
    expect(tooMany.json().error).toContain(String(MAX_APPLY_BATCH));
    expect(fileText()).toBe(before);

    // A candidate with nothing to apply cannot be selected: import the card, rescan, and select the now-configured one.
    const done = await bad([{ key: fresh.key }]);
    expect(done.status).toBe(200);
    const rescan = (await discover(auth, done.json().snapshot.revision)).json();
    const configured = rescan.candidates.find((entry: any) => entry.status === "already_configured");
    expect(configured).toMatchObject({ action: "none" });
    const afterImport = fileText();
    const nothing = await post(auth, "/api/models/import", { preview_id: rescan.preview_id, revision: rescan.revision, selections: [{ key: configured.key }] });
    expect(nothing.status).toBe(400);
    expect(fileText()).toBe(afterImport);
  });

  it("accepts exactly the batch limit of keys in one request (all resolved against the server preview)", async () => {
    const auth = await session();
    found.claude = Array.from({ length: MAX_APPLY_BATCH + 5 }, (_, index) => listed(`claude-bulk-${index}`));
    const preview = (await discover(auth, auth.revision)).json();
    const keys = preview.candidates.filter((entry: any) => entry.status === "new").map((entry: any) => entry.key);
    expect(keys.length).toBe(MAX_APPLY_BATCH + 5);
    const imported = await post(auth, "/api/models/import", {
      preview_id: preview.preview_id, revision: preview.revision, selections: keys.slice(0, MAX_APPLY_BATCH).map((key: string) => ({ key })),
    });
    expect(imported.status).toBe(200);
    expect(imported.json().imported_count).toBe(MAX_APPLY_BATCH);
    expect(Object.keys(userToml().models)).toHaveLength(MAX_APPLY_BATCH);
  });

  it("refuses to import two selected candidates that propose the same model ID instead of overwriting the first", async () => {
    await ui.close();
    // Discovery allocates IDs per harness, so two harnesses can legitimately propose the same ID for different models.
    await start({
      discoverModels: async (config, options) => {
        const preview = await runner(config, options);
        const fresh = preview.candidates.find((entry) => entry.status === "new")!;
        const clash: DiscoveryCandidate = {
          ...fresh, key: `${fresh.key}-other-harness`, harness: "codex", driver: "codex",
          proposed_model: { ...fresh.proposed_model!, harness: "codex", cli_model: "gpt-clash-1" },
        };
        return { ...preview, candidates: [...preview.candidates, clash] };
      },
    });
    const auth = await session();
    const preview = (await discover(auth, auth.revision)).json();
    const clashing = preview.candidates.filter((entry: any) => entry.action === "import" && entry.proposed_id === preview.candidates.find((c: any) => c.status === "new").proposed_id);
    expect(clashing).toHaveLength(2);
    const before = fileText();

    const refused = await post(auth, "/api/models/import", {
      preview_id: preview.preview_id, revision: auth.revision, selections: clashing.map((entry: any) => ({ key: entry.key })),
    });
    expect(refused.status).toBe(400);
    expect(refused.json().error).toContain(clashing[0].proposed_id);
    expect(fileText()).toBe(before);

    // Either one alone is still importable, and keeps its own model payload.
    const single = await post(auth, "/api/models/import", {
      preview_id: preview.preview_id, revision: auth.revision, selections: [{ key: clashing[0].key }],
    });
    expect(single.status).toBe(200);
    expect(single.json().imported).toEqual([clashing[0].proposed_id]);
  });

  it("limits concurrent scans, cancels a scan when the client leaves, and aborts running scans on shutdown", async () => {
    await ui.close();
    const signals: AbortSignal[] = [];
    const release: Array<() => void> = [];
    await start({
      discoverModels: (config, options) => new Promise((resolve, reject) => {
        signals.push(options.signal!);
        options.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        release.push(() => { runner(config, options).then(resolve, reject); });
      }),
    });
    const auth = await session();
    const scans = [0, 1].map(() => post(auth, "/api/discover", { harness: "claude", mode: "offline" }));
    scans.forEach((scan) => scan.catch(() => undefined));
    while (signals.length < 2) await new Promise((resolve) => setImmediate(resolve));
    const third = await post(auth, "/api/discover", { harness: "claude", mode: "offline" });
    expect(third.status).toBe(429);
    expect(signals).toHaveLength(2);

    await ui.close();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await Promise.allSettled(scans);
  });
});

describe("settings UI server hardening (Wave 4B)", () => {
  let dir: string;
  let userPath: string;
  let manager: ConfigManager;
  const handles: SettingsUiHandle[] = [];

  /** Starts a server with its own lock directory; every handle is closed after the test. */
  async function start(extra: Parameters<typeof startSettingsUi>[0] = {}): Promise<SettingsUiHandle> {
    const handle = await startSettingsUi({
      port: 0, openBrowser: false, configManager: manager, configWriter: new ConfigWriter(manager), adapterRegistry: new MockRegistry(),
      lockDir: join(dir, `locks-${handles.length}`), ...extra,
    });
    handles.push(handle);
    return handle;
  }

  async function sessionOn(handle: SettingsUiHandle): Promise<{ cookie: string; csrf: string; revision: string }> {
    const { cookie, csrf } = await bootstrapLogin(handle.port, new URL(handle.url).searchParams.get("token") ?? "");
    const state = await send(handle.port, "GET", "/api/state", authHeaders({ cookie, csrf }));
    expect(state.status).toBe(200);
    return { cookie, csrf, revision: state.json().snapshot.revision };
  }

  const postJson = (handle: SettingsUiHandle, auth: { cookie: string; csrf: string }, path: string, payload: unknown, headers: OutgoingHttpHeaders = {}) =>
    send(handle.port, "POST", path, {
      ...authHeaders(auth), origin: `http://127.0.0.1:${handle.port}`, "content-type": "application/json", ...headers,
    }, JSON.stringify(payload));

  const userToml = () => parse(readFileSync(userPath, "utf8")) as Record<string, any>;
  const lockFile = (index: number) => join(dir, `locks-${index}`, "settings-ui.lock");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orch-settings-wave4b-"));
    userPath = join(dir, "config", "models.toml");
    manager = new ConfigManager({ defaultPath: DEFAULT_CATALOG, userPath });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const handle of handles.splice(0)) await handle.close();
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  describe("origin-bound API access", () => {
    it("rejects a session cookie without the page's CSRF token on GET /api/state and GET /api/health", async () => {
      const handle = await start();
      const auth = await sessionOn(handle);
      for (const path of ["/api/state", "/api/health"]) {
        expect((await send(handle.port, "GET", path, { cookie: auth.cookie })).status, `${path} cookie only`).toBe(403);
        expect((await send(handle.port, "GET", path, { cookie: auth.cookie, "x-orch-token": "wrong" })).status, `${path} wrong token`).toBe(403);
        expect((await send(handle.port, "GET", path, { cookie: auth.cookie, "x-orch-token": "" })).status, `${path} empty token`).toBe(403);
        expect((await send(handle.port, "GET", path, { "x-orch-token": auth.csrf })).status, `${path} token only`).toBe(401);
        expect((await send(handle.port, "GET", path, authHeaders({ cookie: "orch_session=forged", csrf: auth.csrf }))).status, `${path} forged cookie`).toBe(401);
        expect((await send(handle.port, "GET", path, authHeaders(auth))).status, `${path} cookie + token`).toBe(200);
      }
    });

    it("rejects every browser-declared fetch site except same-origin on reads and writes", async () => {
      const handle = await start();
      const auth = await sessionOn(handle);
      for (const site of ["cross-site", "same-site", "none", "bogus"]) {
        const read = await send(handle.port, "GET", "/api/state", { ...authHeaders(auth), "sec-fetch-site": site });
        expect(read.status, `GET with ${site}`).toBe(403);
        const write = await postJson(handle, auth, "/api/heartbeat", {}, { "sec-fetch-site": site });
        expect(write.status, `POST with ${site}`).toBe(403);
      }
      expect((await send(handle.port, "GET", "/api/state", { ...authHeaders(auth), "sec-fetch-site": "same-origin" })).status).toBe(200);
      expect((await postJson(handle, auth, "/api/heartbeat", {}, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    });

    it("hands the token out only in the bootstrap redirect fragment, a different one for every server, and never in a page or API response", async () => {
      const first = await start();
      const second = await start();
      const firstAuth = await sessionOn(first);
      const secondAuth = await sessionOn(second);
      expect(firstAuth.csrf).not.toBe(secondAuth.csrf);

      const page = await send(first.port, "GET", "/", { cookie: firstAuth.cookie });
      expect(page.text).not.toContain("__ORCH_CSRF__");
      expect(page.text).not.toContain("orch-csrf");
      // The served page carries no copy of the token at all.
      expect(page.text).not.toContain(firstAuth.csrf);

      const responses = [
        await send(first.port, "GET", "/api/state", authHeaders(firstAuth)),
        await send(first.port, "GET", "/api/health", authHeaders(firstAuth)),
        await postJson(first, firstAuth, "/api/heartbeat", {}),
        await send(first.port, "GET", `/?token=${new URL(first.url).searchParams.get("token")}`, { cookie: firstAuth.cookie }),
      ];
      for (const response of responses) {
        expect(response.text).not.toContain(firstAuth.csrf);
        expect(JSON.stringify(response.headers)).not.toContain(firstAuth.csrf);
      }
      // A cookie carried over to another port (cookies ignore ports) opens nothing there.
      expect((await send(second.port, "GET", "/api/state", authHeaders({ cookie: firstAuth.cookie, csrf: secondAuth.csrf }))).status).toBe(401);
    });

    it("expires an unused bootstrap link after the configured lifetime, and keeps it valid until then", async () => {
      const fresh = await start({ bootstrapTtlMs: 60_000 });
      const stale = await start({ bootstrapTtlMs: 60_000 });
      const freshToken = new URL(fresh.url).searchParams.get("token");
      const staleToken = new URL(stale.url).searchParams.get("token");
      const realNow = Date.now;
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 59_000);
      expect((await send(fresh.port, "GET", `/?token=${freshToken}`)).status).toBe(302);
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
      const expired = await send(stale.port, "GET", `/?token=${staleToken}`);
      expect(expired.status).toBe(401);
      expect(expired.text).toContain("Link expired");
      expect(expired.headers["set-cookie"]).toBeUndefined();
    });

    it("defaults the bootstrap lifetime to five minutes", async () => {
      const handle = await start();
      const token = new URL(handle.url).searchParams.get("token");
      const realNow = Date.now;
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5 * 60_000 + 1_000);
      expect((await send(handle.port, "GET", `/?token=${token}`)).status).toBe(401);
    });
  });

  describe("scrubbing at the HTTP boundary", () => {
    const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const URL_WITH_SECRETS = "https://user:pw-secret-9@h.example/p?token=tok-secret-9#frag-secret-9";

    it("scrubs config warnings and quarantine reasons, including URL fragments, in state and 409 snapshots", async () => {
      const real = manager.load.bind(manager);
      vi.spyOn(manager, "load").mockImplementation(() => ({
        ...real(),
        config_warnings: [`warning ${SECRET} ${URL_WITH_SECRETS}`],
        quarantined: [{ section: "models", id: "orphan", reason: `bad ${URL_WITH_SECRETS}` }],
      }));
      const handle = await start();
      const auth = await sessionOn(handle);
      const state = await send(handle.port, "GET", "/api/state", authHeaders(auth));
      for (const leaked of [SECRET, "pw-secret-9", "tok-secret-9", "frag-secret-9"]) expect(state.text, leaked).not.toContain(leaked);
      expect(state.json().snapshot.config_warnings).toEqual(["warning [REDACTED] https://h.example/p"]);
      expect(state.json().snapshot.quarantined[0].reason).toBe("bad https://h.example/p");

      const stale = await send(handle.port, "PUT", "/api/defaults", {
        ...authHeaders(auth), origin: `http://127.0.0.1:${handle.port}`, "content-type": "application/json",
      }, JSON.stringify({ patch: { max_concurrency: 3 }, revision: "stale" }));
      expect(stale.status).toBe(409);
      for (const leaked of [SECRET, "pw-secret-9", "tok-secret-9", "frag-secret-9"]) expect(stale.text, leaked).not.toContain(leaked);
      expect(stale.json().snapshot.config_warnings).toEqual(["warning [REDACTED] https://h.example/p"]);
    });

    it("scrubs health notes before they reach the browser", async () => {
      class NotedRegistry extends MockRegistry {
        override async probeHarness(id: string, harness: HarnessConfig, options: { refresh?: boolean } = {}): Promise<HarnessHealth> {
          const health = await super.probeHarness(id, harness, options);
          return { ...health, note: `probe said ${SECRET} via ${URL_WITH_SECRETS}`, runtime_warning: `warn ${URL_WITH_SECRETS}` };
        }
      }
      const handle = await start({ adapterRegistry: new NotedRegistry() });
      const auth = await sessionOn(handle);
      const health = await send(handle.port, "GET", "/api/health", authHeaders(auth));
      expect(health.status).toBe(200);
      for (const leaked of [SECRET, "pw-secret-9", "tok-secret-9", "frag-secret-9"]) expect(health.text, leaked).not.toContain(leaked);
      expect(health.json().harnesses.claude.note).toBe("probe said [REDACTED] via https://h.example/p");
      expect(health.json().harnesses.claude.runtime_warning).toBe("warn https://h.example/p");
    });

    it("sanitizes Zod validation issues and keeps TOML source lines out of 400 and 500 responses", async () => {
      const handle = await start();
      const auth = await sessionOn(handle);
      const defaults = (revision: string) => ({ patch: { max_concurrency: 3 }, revision });

      let tomlError: unknown;
      try { parse(`api_key = hunter2-plain-secret\n`); } catch (error) { tomlError = error; }
      expect(String((tomlError as Error).message), "control: smol-toml quotes the source line").toContain("hunter2-plain-secret");
      vi.spyOn(ConfigWriter.prototype, "updateDefaults").mockRejectedValueOnce(tomlError);
      const toml = await postLikePut(handle, auth, "/api/defaults", defaults(auth.revision));
      expect(toml.status).toBe(400);
      expect(toml.text).not.toContain("hunter2-plain-secret");
      expect(toml.json().error).toMatch(/^TOML syntax error at line 1, column \d+/);

      const longMessage = `${URL_WITH_SECRETS} ${SECRET} ${"x".repeat(2_000)}`;
      vi.spyOn(ConfigWriter.prototype, "updateDefaults").mockRejectedValueOnce(
        new ZodError([{ code: "custom", path: ["models", `id-${SECRET}`], message: longMessage }]),
      );
      const zod = await postLikePut(handle, auth, "/api/defaults", defaults(auth.revision));
      expect(zod.status).toBe(400);
      expect(zod.json().error).toBe("Validation failed");
      for (const leaked of [SECRET, "pw-secret-9", "tok-secret-9", "frag-secret-9"]) expect(zod.text, leaked).not.toContain(leaked);
      const [issue] = zod.json().issues as Array<{ path: string; message: string }>;
      expect(issue.message.length).toBeLessThanOrEqual(501);
      expect(issue.path).toContain("models");

      const failure = Object.assign(new Error(`EACCES: write failed for ${URL_WITH_SECRETS} ${SECRET}\n\n  source line: password = hunter2-plain-secret`), { code: "EACCES" });
      vi.spyOn(ConfigWriter.prototype, "updateDefaults").mockRejectedValueOnce(failure);
      const system = await postLikePut(handle, auth, "/api/defaults", defaults(auth.revision));
      expect(system.status).toBe(500);
      for (const leaked of [SECRET, "pw-secret-9", "tok-secret-9", "frag-secret-9", "hunter2-plain-secret"]) expect(system.text, leaked).not.toContain(leaked);
    });

    function postLikePut(handle: SettingsUiHandle, auth: { cookie: string; csrf: string }, path: string, payload: unknown) {
      return send(handle.port, "PUT", path, {
        ...authHeaders(auth), origin: `http://127.0.0.1:${handle.port}`, "content-type": "application/json",
      }, JSON.stringify(payload));
    }
  });

  describe("per-item quarantine reset", () => {
    const brokenModel = (harness: string) => ({
      custom: true, harness, display_name: "Broken", tier: "light", efforts: ["low"], default_effort: "low", cost_tier: "low", cost_note: "",
      speed_note: "", context_window: 128000, strengths: [], weaknesses: [], best_for: [], avoid_for: [], checked_at: "2026-11-25", enabled: true,
    });

    function writeBrokenConfig(): void {
      mkdirSync(join(dir, "config"), { recursive: true });
      writeFileSync(userPath, [
        "schema_version = 1",
        "[models.orphan-a]", ...Object.entries(brokenModel("no-such-harness")).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
        '[models."."]', ...Object.entries(brokenModel("no-such-harness")).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
        '[models."__proto__"]', ...Object.entries(brokenModel("no-such-harness")).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
        "[harnesses.broken-harness]", 'driver = "no-such-driver"',
        "[aliases]", 'dangling = "no-such-model"',
        "",
      ].join("\n"));
    }

    const quarantinedKeys = (snapshot: any) => snapshot.quarantined.map((entry: any) => `${entry.section}.${entry.id}`).sort();

    it("removes exactly one quarantined entry per call, for every section and for IDs a URL path would mangle", async () => {
      writeBrokenConfig();
      const handle = await start();
      const auth = await sessionOn(handle);
      let snapshot = (await send(handle.port, "GET", "/api/state", authHeaders(auth))).json().snapshot;
      const all = quarantinedKeys(snapshot);
      expect(all).toEqual(expect.arrayContaining(["models.orphan-a", "models..", "models.__proto__", "harnesses.broken-harness", "aliases.dangling"]));

      let remaining = [...all];
      for (const [section, id] of [["models", "."], ["models", "__proto__"], ["models", "orphan-a"], ["harnesses", "broken-harness"], ["aliases", "dangling"]]) {
        const reset = await postJson(handle, auth, "/api/quarantined/reset", { section, id, revision: snapshot.revision });
        expect(reset.status, `${section}.${id}: ${reset.text}`).toBe(200);
        snapshot = reset.json().snapshot;
        remaining = remaining.filter((key) => key !== `${section}.${id}`);
        expect(quarantinedKeys(snapshot), `after ${section}.${id}`).toEqual(remaining);
      }
      expect(quarantinedKeys(snapshot)).toEqual([]);
      const stored = userToml();
      expect(stored.models ?? {}).toEqual({});
      expect(stored.harnesses ?? {}).toEqual({});
      expect(stored.aliases ?? {}).toEqual({});
    });

    it("resets a quarantined override of a built-in harness back to the built-in definition", async () => {
      mkdirSync(join(dir, "config"), { recursive: true });
      writeFileSync(userPath, 'schema_version = 1\n[harnesses.claude]\nmax_concurrency = 9999\n');
      const handle = await start();
      const auth = await sessionOn(handle);
      const before = (await send(handle.port, "GET", "/api/state", authHeaders(auth))).json().snapshot;
      expect(quarantinedKeys(before)).toEqual(["harnesses.claude"]);
      const reset = await postJson(handle, auth, "/api/quarantined/reset", { section: "harnesses", id: "claude", revision: before.revision });
      expect(reset.status).toBe(200);
      expect(reset.json().snapshot.quarantined).toEqual([]);
      expect(reset.json().snapshot.harnesses.claude.provenance).toBe("default");
    });

    it("validates the request and applies the same Origin, token and revision guards as every other write", async () => {
      writeBrokenConfig();
      const handle = await start();
      const auth = await sessionOn(handle);
      const { revision } = (await send(handle.port, "GET", "/api/state", authHeaders(auth))).json().snapshot;
      const fileBefore = readFileSync(userPath, "utf8");
      const reset = (payload: unknown, headers: OutgoingHttpHeaders = {}) => postJson(handle, auth, "/api/quarantined/reset", payload, headers);

      expect((await reset({ section: "defaults", id: "x", revision })).status).toBe(400);
      expect((await reset({ section: "models", revision })).status).toBe(400);
      expect((await reset({ section: "models", id: "", revision })).status).toBe(400);
      expect((await reset({ section: "models", id: 7, revision })).status).toBe(400);
      expect((await reset({ section: "models", id: "bad\nid", revision })).status).toBe(400);
      expect((await reset({ section: "models", id: "orphan-a" })).status).toBe(400);
      // An entry that is not quarantined (here a healthy built-in) is never touched.
      const healthy = await reset({ section: "models", id: MODEL_ID, revision });
      expect(healthy.status).toBe(404);
      expect((await reset({ section: "models", id: "orphan-a", revision }, { origin: "http://evil.example" })).status).toBe(403);
      expect((await reset({ section: "models", id: "orphan-a", revision }, { "x-orch-token": "wrong" })).status).toBe(403);
      expect((await reset({ section: "models", id: "orphan-a", revision }, { "content-type": "text/plain" })).status).toBe(415);
      expect(readFileSync(userPath, "utf8")).toBe(fileBefore);

      const stale = await reset({ section: "models", id: "orphan-a", revision: "stale" });
      expect(stale.status).toBe(409);
      expect(stale.json()).toMatchObject({ code: "REVISION_CONFLICT", snapshot: { revision } });
      expect(readFileSync(userPath, "utf8")).toBe(fileBefore);
    });
  });

  describe("graceful shutdown", () => {
    it("lets a running config write finish before the lock is released, and refuses new writes with 503", async () => {
      const gate = deferredValue<void>();
      const started = deferredValue<void>();
      class SlowWriter extends ConfigWriter {
        override async resetAllToDefault(expectedRevision?: string) {
          started.resolve();
          await gate.promise;
          return super.resetAllToDefault(expectedRevision);
        }
      }
      const handle = await start({ configWriter: new SlowWriter(manager) });
      const auth = await sessionOn(handle);
      const write = postJson(handle, auth, "/api/reset-all", { revision: auth.revision });
      await started.promise;

      // A second write is still in the middle of its upload when shutdown begins.
      const body = JSON.stringify({ patch: { max_concurrency: 3 }, revision: auth.revision });
      const late = await openRawRequest(handle.port, {
        method: "PUT", path: "/api/defaults", body,
        headers: { ...authHeaders(auth), origin: `http://127.0.0.1:${handle.port}`, "content-type": "application/json" },
      });
      await late.sendHead();
      await late.sendBodyPart(0, 5);
      await new Promise((resolve) => setTimeout(resolve, 100));

      let closedAt: "pending" | "done" = "pending";
      const closing = handle.close().then(() => { closedAt = "done"; });
      const waited = handle.waitUntilClosed.then(() => "closed");
      // Longer than the connection grace period, so only the write drain (not the open socket) can be what holds shutdown back.
      await new Promise((resolve) => setTimeout(resolve, 1_300));
      expect(closedAt, "close() must wait for the running write").toBe("pending");
      expect(existsSync(lockFile(0)), "the lock must outlive the running write").toBe(true);

      await late.sendBodyPart(5);
      const refused = await late.response;
      expect(refused.status).toBe(503);
      expect(refused.text).toContain("shutting down");

      gate.resolve();
      expect((await write).status).toBe(200);
      await closing;
      expect(await waited).toBe("closed");
      expect(existsSync(lockFile(0))).toBe(false);
      // The drained write (reset-all) landed; the refused one (max_concurrency) did not.
      expect(readFileSync(userPath, "utf8")).not.toContain("max_concurrency");
    });

    it.skipIf(process.getuid?.() === 0)("resolves waitUntilClosed even when releasing the lock fails", async () => {
      const handle = await start();
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      chmodSync(join(dir, "locks-0"), 0o500); // removing the lock file now fails with EACCES
      await expect(handle.close()).resolves.toBeUndefined();
      await expect(handle.waitUntilClosed).resolves.toBeUndefined();
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("Could not release the settings UI lock");
      chmodSync(join(dir, "locks-0"), 0o700);
    });

    it("stops waiting for a health probe on shutdown instead of holding the server open", async () => {
      const probeStarted = deferredValue<void>();
      class StuckRegistry extends MockRegistry {
        override async probeHarness(): Promise<HarnessHealth> {
          probeStarted.resolve();
          return new Promise<HarnessHealth>(() => undefined);
        }
      }
      const handle = await start({ adapterRegistry: new StuckRegistry() });
      const auth = await sessionOn(handle);
      const health = send(handle.port, "GET", "/api/health?refresh=1", authHeaders(auth));
      await probeStarted.promise;
      await handle.close();
      const response = await health;
      expect(response.status).toBe(503);
      expect(response.json().error).toBe("Server is shutting down.");
    });
  });

  describe("connection and body limits", () => {
    const openSockets: Socket[] = [];
    afterEach(() => { for (const socket of openSockets.splice(0)) socket.destroy(); });

    function connectRaw(port: number): Promise<Socket> {
      return new Promise((resolve, reject) => {
        const socket = netConnect({ host: "127.0.0.1", port }, () => resolve(socket));
        socket.on("error", () => undefined);
        socket.once("error", reject);
        openSockets.push(socket);
      });
    }

    /** Polls until `check` passes or the deadline passes; it throws the last failure on timeout. */
    async function eventually<T>(check: () => Promise<T>, timeoutMs = 3_000): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          return await check();
        } catch (error) {
          if (Date.now() > deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }

    it("answers 429 once 16 request bodies are being read at the same time, and recovers when they end", async () => {
      const handle = await start();
      const auth = await sessionOn(handle);
      const stalled: Socket[] = [];
      for (let index = 0; index < 16; index++) {
        const socket = await connectRaw(handle.port);
        socket.write([
          "POST /api/heartbeat HTTP/1.1", `Host: 127.0.0.1:${handle.port}`, `Cookie: ${auth.cookie}`, `X-Orch-Token: ${auth.csrf}`,
          `Origin: http://127.0.0.1:${handle.port}`, "Content-Type: application/json", "Content-Length: 100", "", "{",
        ].join("\r\n"));
        stalled.push(socket);
      }
      const busy = await eventually(async () => {
        const response = await postJson(handle, auth, "/api/heartbeat", {});
        if (response.status !== 429) throw new Error(`expected 429, got ${response.status}`);
        return response;
      });
      expect(busy.json().error).toMatch(/Too many concurrent requests/);

      for (const socket of stalled) socket.destroy();
      const recovered = await eventually(async () => {
        const response = await postJson(handle, auth, "/api/heartbeat", {});
        if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
        return response;
      });
      expect(recovered.json()).toEqual({ ok: true });
    });

    it("drops connections beyond 64 and keeps serving afterwards", async () => {
      const handle = await start();
      const auth = await sessionOn(handle);
      const attempts = 80;
      let dropped = 0;
      const sockets: Socket[] = [];
      for (let index = 0; index < attempts; index++) {
        const socket = await connectRaw(handle.port);
        socket.once("close", () => { dropped++; });
        sockets.push(socket);
      }
      await eventually(async () => {
        if (dropped < attempts - 64) throw new Error(`only ${dropped} of the surplus connections were dropped`);
      });
      expect(dropped).toBeGreaterThanOrEqual(attempts - 64);
      expect(dropped, "the cap must not reject connections below the limit").toBeLessThanOrEqual(attempts - 40);
      for (const socket of sockets) socket.destroy();
      const state = await eventually(async () => {
        const response = await send(handle.port, "GET", "/api/state", authHeaders(auth));
        if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
        return response;
      });
      expect(state.status).toBe(200);
    });
  });

  describe("preview store expiry timer", () => {
    it("evicts an expired preview without any further request, and clear() cancels the timer", async () => {
      const store = new PreviewStore(30, 8);
      store.add("rev-1", []);
      store.add("rev-2", []);
      expect(store.size).toBe(2);
      await vi.waitFor(() => expect(store.size).toBe(0), { timeout: 2_000, interval: 10 });

      const timers = vi.spyOn(globalThis, "setTimeout");
      store.add("rev-3", []);
      const timer = timers.mock.results.map((result) => result.value as NodeJS.Timeout).at(-1)!;
      expect(timer.hasRef(), "the eviction timer must not keep the process alive").toBe(false);
      store.clear();
      expect(store.size).toBe(0);
      expect(timers.mock.results.length).toBeGreaterThan(0);
    });

    it("rearms for the next earliest expiry", async () => {
      const store = new PreviewStore(60, 8);
      store.add("old", []);
      await new Promise((resolve) => setTimeout(resolve, 30));
      store.add("newer", []);
      await vi.waitFor(() => expect(store.size).toBe(1), { timeout: 2_000, interval: 5 });
      await vi.waitFor(() => expect(store.size).toBe(0), { timeout: 2_000, interval: 5 });
      store.clear();
    });
  });
});

function deferredValue<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A hand-driven HTTP request, so a test can keep an upload half-sent while the server shuts down. */
async function openRawRequest(port: number, input: { method: string; path: string; body: string; headers: OutgoingHttpHeaders }) {
  const socket = netConnect({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const chunks: Buffer[] = [];
  const response = new Promise<{ status: number; text: string }>((resolve) => {
    const finish = () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0), text: raw });
    };
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", () => undefined);
  });
  const bytes = Buffer.from(input.body);
  const headerLines = Object.entries({
    host: `127.0.0.1:${port}`, "content-length": String(bytes.length), connection: "close", ...input.headers,
  }).map(([name, value]) => `${name}: ${String(value)}`);
  return {
    response,
    sendHead: async () => { socket.write(`${input.method} ${input.path} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`); },
    sendBodyPart: async (from: number, to?: number) => { socket.write(bytes.subarray(from, to)); },
  };
}
