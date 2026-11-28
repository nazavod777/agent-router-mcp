import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { ZodError } from "zod";
import { AdapterRegistry } from "../adapters/registry.js";
import { CLI_NAME } from "../cli/name.js";
import { ENTITY_ID_MAX_LENGTH, ENTITY_ID_RULES, entityIdProblem } from "../config/ids.js";
import { getStateDir } from "../config/paths.js";
import { ConfigManager, describeLoadError, parseDefaultCatalog } from "../config/resolver.js";
import { DRIVER_KINDS, DRIVER_METADATA } from "../drivers.js";
import type { ConfigSnapshot, QuarantineSection } from "../config/resolver.js";
import { ConfigRevisionConflictError, ConfigWriter } from "../config/writer.js";
import type { ConfigSection } from "../config/writer.js";
import type { HarnessPatch, ModelPatch } from "../config/schema.js";
import type { DiscoverModelsOptions, DiscoveryCandidate, DiscoveryPreviewResult } from "../discovery/types.js";
import type { DiscoveryConfig } from "../discovery/service.js";
import type { ImportModelBatch } from "../config/writer.js";
import { inferVendorFamily } from "../roles/registry.js";
import { resolveWindowsSystemBinary } from "../runtime/process-tree.js";
import { logger, redactSecrets } from "../logging.js";
import type { HarnessHealth } from "../types.js";

/** Produces a discovery preview for the saved config. The default runs `previewDiscovery`; tests inject a deterministic offline runner. */
export type DiscoveryRunner = (config: DiscoveryConfig, options: DiscoverModelsOptions) => Promise<DiscoveryPreviewResult>;

export interface SettingsUiOptions {
  port?: number;
  openBrowser?: boolean;
  idleTimeoutMs?: number;
  configManager?: ConfigManager;
  configWriter?: ConfigWriter;
  adapterRegistry?: AdapterRegistry;
  lockDir?: string;
  /** Replaces the real discovery service behind POST /api/discover. */
  discoverModels?: DiscoveryRunner;
  /** How long a stored discovery preview can be imported from; default 10 minutes. */
  previewTtlMs?: number;
  /** How long the one-time URL token stays usable if it is never opened; default 5 minutes. */
  bootstrapTtlMs?: number;
}

export interface SettingsUiHandle {
  url: string;
  baseUrl: string;
  port: number;
  close: () => Promise<void>;
  waitUntilClosed: Promise<void>;
}

const HOST = "127.0.0.1";
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;
const SESSION_COOKIE = "orch_session";
const CSRF_HEADER = "x-orch-token";
const NONCE_PLACEHOLDER = "__CSP_NONCE__";
const DEFAULT_BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
const MAX_CONNECTIONS = 64;
const MAX_CONCURRENT_BODY_READS = 16;
const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;
const SHUTDOWN_CONNECTION_GRACE_MS = 1_000;
const RECLAIM_GUARD_STALE_MS = 10_000;
const MAX_PUBLIC_MESSAGE_LENGTH = 500;
const SERVER_BUSY_MESSAGE = "Too many concurrent requests. Retry in a moment.";
const SHUTTING_DOWN_MESSAGE = "Server is shutting down.";
const LOCK_FILE_NAME = "settings-ui.lock";
const EMPTY_LOCK_GRACE_MS = 2_000;
const PORT_PROBE_TIMEOUT_MS = 150;
const FORBIDDEN_ENTITY_IDS = new Set(["__proto__", "constructor", "prototype"]);
const FIELD_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const CONFIG_SECTIONS: readonly ConfigSection[] = ["defaults", "harnesses", "models", "presets"];
const QUARANTINE_SECTIONS: readonly QuarantineSection[] = ["harnesses", "models", "presets", "aliases"];
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_STORED_PREVIEWS = 8;
const MAX_CONCURRENT_DISCOVERIES = 2;
const MAX_SELECTION_KEY_LENGTH = 256;
const MAX_HARNESS_ID_LENGTH = 256;
const DISCOVERY_MODES = ["offline", "on_demand"] as const;
const DISCOVERY_PROVIDER_SCOPES = ["configured", "all"] as const;
const PREVIEW_EXPIRED_MESSAGE = "Preview expired; run discovery again.";

const BASE_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const NON_HTML_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Favicon: the brand mark (#i-brand in app.html) on a warm stone tile, as SVG and as a PNG-in-ICO for browsers that ask for /favicon.ico.
// ---------------------------------------------------------------------------
const BRAND_VIEWBOX = 20;
const BRAND_STROKE = 1.5;
const BRAND_INK = [0x16, 0x65, 0x47] as const;
const BRAND_TILE = [0xf5, 0xf4, 0xf2] as const;
const BRAND_TILE_RADIUS = 4.5;
const BRAND_NODES: ReadonlyArray<readonly [number, number, number]> = [[4, 10, 2], [16, 4.5, 2], [16, 15.5, 2]];
const BRAND_LINKS: ReadonlyArray<readonly [number, number, number, number]> = [[6, 10, 9, 10], [9, 10, 14.4, 5.8], [9, 10, 14.4, 14.2]];
const ICON_SIZES = [16, 32] as const;
const ICON_SUPERSAMPLE = 4;

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BRAND_VIEWBOX} ${BRAND_VIEWBOX}" width="32" height="32">` +
  `<rect width="${BRAND_VIEWBOX}" height="${BRAND_VIEWBOX}" rx="${BRAND_TILE_RADIUS}" fill="#f5f4f2"/>` +
  `<g fill="none" stroke="#166547" stroke-width="${BRAND_STROKE}" stroke-linecap="round" stroke-linejoin="round">` +
  BRAND_NODES.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join("") +
  `<path d="M6 10h3m0 0 5.4-4.2M9 10l5.4 4.2"/></g></svg>`;

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const along = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + along * dx), py - (ay + along * dy));
}

function insideRoundedTile(x: number, y: number): boolean {
  const radius = BRAND_TILE_RADIUS;
  const cx = Math.min(Math.max(x, radius), BRAND_VIEWBOX - radius);
  const cy = Math.min(Math.max(y, radius), BRAND_VIEWBOX - radius);
  return x >= 0 && y >= 0 && x <= BRAND_VIEWBOX && y <= BRAND_VIEWBOX && Math.hypot(x - cx, y - cy) <= radius;
}

function insideBrandMark(x: number, y: number): boolean {
  const half = BRAND_STROKE / 2;
  return BRAND_NODES.some(([cx, cy, r]) => Math.abs(Math.hypot(x - cx, y - cy) - r) <= half) ||
    BRAND_LINKS.some(([ax, ay, bx, by]) => distanceToSegment(x, y, ax, ay, bx, by) <= half);
}

/** Supersampled RGBA raster of the brand tile; transparent outside the rounded corners. */
function renderBrandPixels(size: number): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = BRAND_VIEWBOX / size;
  const samples = ICON_SUPERSAMPLE * ICON_SUPERSAMPLE;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let covered = 0;
      let ink = 0;
      for (let sy = 0; sy < ICON_SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < ICON_SUPERSAMPLE; sx++) {
          const x = (column + (sx + 0.5) / ICON_SUPERSAMPLE) * scale;
          const y = (row + (sy + 0.5) / ICON_SUPERSAMPLE) * scale;
          if (!insideRoundedTile(x, y)) continue;
          covered++;
          if (insideBrandMark(x, y)) ink++;
        }
      }
      const offset = (row * size + column) * 4;
      if (covered === 0) continue;
      const inkShare = ink / covered;
      for (let channel = 0; channel < 3; channel++) {
        pixels[offset + channel] = Math.round(BRAND_TILE[channel] * (1 - inkShare) + BRAND_INK[channel] * inkShare);
      }
      pixels[offset + 3] = Math.round((covered / samples) * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const chunk = Buffer.alloc(8 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const scanlines = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row++) rgba.copy(scanlines, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO container (ICONDIR + one ICONDIRENTRY per size) holding PNG images, which every current browser accepts. */
function buildFaviconIco(): Buffer {
  const images = ICON_SIZES.map((size) => ({ size, png: encodePng(size, renderBrandPixels(size)) }));
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    directory[entry] = size;
    directory[entry + 1] = size;
    directory.writeUInt16LE(1, entry + 4); // planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([directory, ...images.map(({ png }) => png)]);
}

interface StaticAsset {
  contentType: string;
  body: Buffer;
}

let faviconAssets: Map<string, StaticAsset> | undefined;
function getFaviconAssets(): Map<string, StaticAsset> {
  faviconAssets ??= new Map([
    ["/favicon.svg", { contentType: "image/svg+xml; charset=utf-8", body: Buffer.from(FAVICON_SVG, "utf8") }],
    ["/favicon.ico", { contentType: "image/vnd.microsoft.icon", body: buildFaviconIco() }],
  ]);
  return faviconAssets;
}

/** An error that maps directly to an HTTP status and JSON body. */
class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Json = {}) {
    super(message);
  }
}

function pageCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = singleHeader(request, "cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function sendRaw(response: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  if (response.headersSent) return;
  response.writeHead(status, { ...BASE_SECURITY_HEADERS, ...headers, "Content-Length": String(Buffer.byteLength(body)) });
  response.end(body);
}

/** Serves a static asset; HEAD gets the same headers (including Content-Length) and no body. */
function sendAsset(response: ServerResponse, method: string, asset: StaticAsset): void {
  response.writeHead(200, {
    ...BASE_SECURITY_HEADERS,
    "Content-Type": asset.contentType,
    "Content-Security-Policy": NON_HTML_CSP,
    "Content-Length": String(asset.body.length),
  });
  response.end(method === "HEAD" ? undefined : asset.body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  sendRaw(response, status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Security-Policy": NON_HTML_CSP,
    ...headers,
  }, JSON.stringify(payload));
}

function sendError(response: ServerResponse, status: number, message: string, extra: Json = {}): void {
  sendJson(response, status, { error: message, ...extra });
}

function sendPlainPage(response: ServerResponse, status: number, title: string, message: string): void {
  const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head>` +
    `<body><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
  sendRaw(response, status, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": NON_HTML_CSP }, body);
}

/**
 * Reads at most MAX_BODY_BYTES. Oversized bodies are drained and discarded (bounded by the request
 * timeout) so the client still receives a clean 413 instead of a reset connection.
 */
function readJsonBody(request: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = Number(singleHeader(request, "content-length") ?? "0") > MAX_BODY_BYTES;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) oversized = true;
      if (!oversized) chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("close", () => {
      if (!request.complete) reject(new HttpError(400, "Request body was not fully received"));
    });
    request.on("end", () => {
      if (oversized) {
        reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      try {
        resolve(parseJsonObject(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseJsonObject(text: string): Json {
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return parsed as Json;
}

function requireRevision(body: Json): string {
  if (typeof body.revision !== "string" || body.revision === "") {
    throw new HttpError(400, "Field 'revision' is required. Reload the page and retry.");
  }
  return body.revision;
}

function requirePatch(body: Json): Json {
  const patch = body.patch;
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new HttpError(400, "Field 'patch' must be a JSON object");
  }
  return patch as Json;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Creating a custom entity requires the shared ID policy (src/config/ids.ts). An entity that already exists in the section may keep any ID it
 * already has (older configs and hand-edited TOML can hold IDs the pattern rejects), so it stays editable, resettable and
 * deletable; the prototype-pollution names, "..", and control characters are refused either way.
 */
function requireEntityId(raw: string, existing?: Record<string, unknown>): string {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "Invalid id encoding");
  }
  if (existing && Object.hasOwn(existing, id) && !FORBIDDEN_ENTITY_IDS.has(id) && !id.includes("..") && !CONTROL_CHARACTERS.test(id)) {
    return id;
  }
  const problem = entityIdProblem(id);
  if (problem) throw new HttpError(400, problem);
  return id;
}

/** One line of text that is safe to show in the browser: URL credentials and token-shaped secrets removed, length capped. */
function publicMessage(text: string): string {
  const scrubbed = scrubText(text);
  return scrubbed.length > MAX_PUBLIC_MESSAGE_LENGTH ? `${scrubbed.slice(0, MAX_PUBLIC_MESSAGE_LENGTH)}…` : scrubbed;
}

/**
 * Error text for an HTTP body. A TOML syntax error keeps only its summary and position: smol-toml appends the offending
 * source lines to its message, and those lines can hold secret values from the user's config file.
 */
function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return publicMessage(String(error));
  const position = error as Error & { line?: unknown; column?: unknown };
  if (typeof position.line === "number" && typeof position.column === "number") return publicMessage(describeLoadError(error));
  return publicMessage(error.message.split(/\r?\n\s*\r?\n/, 1)[0]);
}

/** Maps config-layer failures to HTTP statuses without leaking stack traces. */
function classifyError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ConfigRevisionConflictError) {
    return new HttpError(409, error.message, { code: error.code, currentRevision: error.currentRevision });
  }
  if (error instanceof ZodError) {
    // Messages and paths can quote keys or values from the user's file, so each one is scrubbed and capped before it leaves.
    return new HttpError(400, "Validation failed", {
      issues: error.issues.map((issue) => ({
        path: publicMessage(issue.path.map(String).join(".")),
        message: publicMessage(issue.message),
      })),
    });
  }
  const message = publicErrorMessage(error);
  if (/Timed out acquiring config lock/.test(message)) return new HttpError(503, message);
  if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") {
    return new HttpError(500, message);
  }
  // Reference checks (unknown harness/model, unsupported effort) and TOML errors are user input problems.
  return new HttpError(400, message);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether anything accepts connections on the loopback port; a recycled pid never listens on the recorded UI port. */
function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Lock files held by servers running in this process (a same-pid holder is not stale if listed here). */
const heldLocks = new Set<string>();

interface LockHolder {
  pid: number;
  port?: number;
  /** Random per-acquisition owner token; only the owner that wrote it may remove the lock. Absent in locks written by older versions. */
  token?: string;
}

/** Single-instance guard: one settings server per lock directory. */
class InstanceLock {
  private constructor(private readonly path: string, private readonly token: string) {}

  static async acquire(lockDir: string): Promise<InstanceLock> {
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const path = join(lockDir, LOCK_FILE_NAME);
    const token = randomToken(16);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }));
        } finally {
          closeSync(fd);
        }
        heldLocks.add(path);
        return new InstanceLock(path, token);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const observed = InstanceLock.readRaw(path);
        if (observed === undefined) continue; // released between our open and read: try again
        const holder = InstanceLock.parseHolder(observed);
        if (holder && await InstanceLock.isHolderRunning(path, holder)) {
          const where = holder.port ? ` on http://${HOST}:${holder.port}/` : "";
          throw new Error(`${CLI_NAME} settings is already running (pid ${holder.pid})${where}. ` +
            "Open the URL printed in its terminal or stop it first.");
        }
        if (!holder && InstanceLock.isFresh(path)) {
          throw new Error(`${CLI_NAME} settings is currently starting in another process. Retry in a moment.`);
        }
        if (!InstanceLock.removeIfUnchanged(path, observed)) {
          throw new Error(`${CLI_NAME} settings is currently starting in another process. Retry in a moment.`);
        }
      }
    }
    throw new Error(`Could not acquire settings UI lock ${path}`);
  }

  /**
   * Removes a lock judged stale, but only if it still holds the exact bytes that were judged. Reclaimers take a short-lived
   * guard file first, so two starters that both saw the same stale lock cannot delete each other's freshly created live one.
   */
  private static removeIfUnchanged(path: string, observed: string): boolean {
    const guardPath = `${path}.reclaim`;
    let guard: number;
    try {
      guard = openSync(guardPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A reclaimer that crashed must not wedge every later start: an old guard is cleared and the reclaim is tried once more.
      if (InstanceLock.isFresh(guardPath, RECLAIM_GUARD_STALE_MS)) return false;
      rmSync(guardPath, { force: true });
      return InstanceLock.removeIfUnchanged(path, observed);
    }
    try {
      if (InstanceLock.readRaw(path) !== observed) return false;
      rmSync(path, { force: true });
      return true;
    } finally {
      closeSync(guard);
      rmSync(guardPath, { force: true });
    }
  }

  /**
   * A live pid is not proof: after a crash or reboot the pid may belong to an unrelated process (even one that answers EPERM).
   * When the holder recorded its port, something must still be listening there, otherwise the lock is stale.
   */
  private static async isHolderRunning(path: string, holder: LockHolder): Promise<boolean> {
    if (holder.pid === process.pid) return heldLocks.has(path);
    if (!isProcessAlive(holder.pid)) return false;
    return holder.port === undefined || await isPortListening(holder.port);
  }

  private static readRaw(path: string): string | undefined {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  }

  private static parseHolder(raw: string): LockHolder | undefined {
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; port?: unknown; token?: unknown };
      if (typeof parsed.pid !== "number") return undefined;
      return {
        pid: parsed.pid,
        ...(typeof parsed.port === "number" ? { port: parsed.port } : {}),
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private static isFresh(path: string, graceMs = EMPTY_LOCK_GRACE_MS): boolean {
    try {
      return Date.now() - statSync(path).mtimeMs < graceMs;
    } catch {
      return false;
    }
  }

  write(extra: { port?: number }): void {
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, token: this.token, started_at: new Date().toISOString(), ...extra }), {
      mode: 0o600,
    });
    renameSync(tmp, this.path);
  }

  release(): void {
    heldLocks.delete(this.path);
    const raw = InstanceLock.readRaw(this.path);
    const holder = raw === undefined ? undefined : InstanceLock.parseHolder(raw);
    if (holder?.pid === process.pid && holder.token === this.token) rmSync(this.path, { force: true });
  }
}

/** Test seams of `openInBrowser`. */
export interface BrowserLaunchDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: typeof spawn;
  fileExists?: (path: string) => boolean;
}

interface BrowserLaunch {
  command: string;
  args: string[];
}

const BROWSER_MANUAL_HINT = "Could not open a browser automatically; open the settings URL manually";

/**
 * Programs tried in order to open `url` in the default browser. On Windows these are system binaries resolved through
 * `%SystemRoot%\System32` (never a bare name looked up in PATH): `rundll32 url.dll,FileProtocolHandler` shows no console
 * window and hands the URL over untouched (no `cmd` AutoRun, no `&`/`#` mangling); `cmd /d /c start` is the fallback.
 */
function browserLaunches(url: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, fileExists?: (path: string) => boolean): BrowserLaunch[] {
  if (platform === "darwin") return [{ command: "open", args: [url] }];
  if (platform !== "win32") return [{ command: "xdg-open", args: [url] }];
  const rundll32 = resolveWindowsSystemBinary(["rundll32.exe"], env, fileExists);
  const cmd = resolveWindowsSystemBinary(["cmd.exe"], env, fileExists);
  return [
    ...(rundll32 === undefined ? [] : [{ command: rundll32, args: ["url.dll,FileProtocolHandler", url] }]),
    ...(cmd === undefined ? [] : [{ command: cmd, args: ["/d", "/c", "start", "", url] }]),
  ];
}

export function openInBrowser(url: string, deps: BrowserLaunchDeps = {}): void {
  const spawnProcess = deps.spawnProcess ?? spawn;
  const launches = browserLaunches(url, deps.platform ?? process.platform, deps.env ?? process.env, deps.fileExists);
  const attempt = (index: number): void => {
    const launch = launches[index];
    if (launch === undefined) {
      logger.info(BROWSER_MANUAL_HINT);
      return;
    }
    try {
      const child = spawnProcess(launch.command, launch.args, { detached: true, windowsHide: true, stdio: "ignore" });
      // A launcher can fail by not starting (`error`) or by starting and exiting non-zero (`rundll32` with no handler); either
      // moves on to the next launcher, once, even when both events fire.
      let fellBack = false;
      const fallBack = (): void => {
        if (fellBack) return;
        fellBack = true;
        attempt(index + 1);
      };
      child.on("error", fallBack);
      child.on("exit", (code) => { if (code !== null && code !== 0) fallBack(); });
      child.unref();
    } catch {
      attempt(index + 1);
    }
  };
  attempt(0);
}

function loadAppHtml(): string {
  const html = readFileSync(new URL("./app.html", import.meta.url), "utf8");
  if (!html.includes(NONCE_PLACEHOLDER)) throw new Error("app.html is missing the CSP nonce placeholder");
  // The CSRF token reaches the page only through the URL fragment of the bootstrap redirect, never through the served HTML.
  if (/orch-csrf|__ORCH_CSRF__/.test(html)) throw new Error("app.html must not embed a CSRF token placeholder");
  return html;
}

function listen(server: Server, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.off("error", onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

// ---------------------------------------------------------------------------
// Model discovery preview store (NEW in Wave 3)
// ---------------------------------------------------------------------------

/** What the server keeps of one preview: the candidates it will resolve selected keys against. Never sent back whole. */
interface StoredPreview {
  revision: string;
  expiresAt: number;
  candidates: ReadonlyMap<string, DiscoveryCandidate>;
}

/**
 * Bounded, short-lived store of discovery previews. The oldest preview is dropped when the store is full; everything dies with the server.
 * A single unref'd timer is armed for the earliest expiry, so an expired preview is evicted even if no request ever arrives again.
 */
export class PreviewStore {
  private readonly previews = new Map<string, StoredPreview>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get size(): number {
    return this.previews.size;
  }

  add(revision: string, candidates: readonly DiscoveryCandidate[]): string {
    this.prune();
    while (this.previews.size >= this.maxEntries) {
      const oldest = this.previews.keys().next();
      if (oldest.done) break;
      this.previews.delete(oldest.value);
    }
    const id = randomToken(16);
    this.previews.set(id, {
      revision, expiresAt: Date.now() + this.ttlMs, candidates: new Map(candidates.map((candidate) => [candidate.key, candidate])),
    });
    this.schedule();
    return id;
  }

  get(id: string): StoredPreview | undefined {
    this.prune();
    return this.previews.get(id);
  }

  clear(): void {
    this.previews.clear();
    this.schedule();
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, preview] of this.previews) if (preview.expiresAt <= now) this.previews.delete(id);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.previews.size === 0) return;
    const earliest = Math.min(...[...this.previews.values()].map((preview) => preview.expiresAt));
    this.timer = setTimeout(() => {
      this.prune();
      this.schedule();
    }, Math.max(1, earliest - Date.now()));
    this.timer.unref();
  }
}

function optionalChoice<T extends string>(body: Json, field: string, allowed: readonly T[], fallback: T): T {
  const value = body[field];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new HttpError(400, `Field '${field}' must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * Validated body of POST /api/discover. An omitted (or null) `harness` scans every harness; a string, including "all",
 * always names exactly one harness, so a harness literally called "all" stays addressable.
 */
function parseDiscoverRequest(body: Json): { harness?: string; mode: "offline" | "on_demand"; providers: "configured" | "all"; revision?: string } {
  const harness = body.harness ?? undefined;
  if (harness !== undefined && (typeof harness !== "string" || harness === "" || harness.length > MAX_HARNESS_ID_LENGTH || CONTROL_CHARACTERS.test(harness))) {
    throw new HttpError(400, "Field 'harness' must be a harness ID, or omitted to scan every harness");
  }
  if (body.revision !== undefined && (typeof body.revision !== "string" || body.revision === "")) {
    throw new HttpError(400, "Field 'revision' must be a non-empty string");
  }
  return {
    ...(harness === undefined ? {} : { harness }),
    mode: optionalChoice(body, "mode", DISCOVERY_MODES, "on_demand"),
    providers: optionalChoice(body, "providers", DISCOVERY_PROVIDER_SCOPES, "configured"),
    ...(typeof body.revision === "string" ? { revision: body.revision } : {}),
  };
}

interface ImportSelection {
  key: string;
  enabled?: boolean;
}

/** Validated body of POST /api/models/import: a non-empty list of at most `maxSelections` distinct candidate keys. */
function parseImportRequest(body: Json, maxSelections: number): { previewId: string; revision: string; selections: ImportSelection[] } {
  if (typeof body.preview_id !== "string" || body.preview_id === "") throw new HttpError(400, "Field 'preview_id' is required");
  const revision = requireRevision(body);
  const raw = body.selections;
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, "Field 'selections' must be a non-empty array");
  if (raw.length > maxSelections) {
    throw new HttpError(400, `At most ${maxSelections} models can be imported per request (got ${raw.length}).`);
  }
  const seen = new Set<string>();
  const selections: ImportSelection[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new HttpError(400, "Each selection must be an object");
    const { key, enabled } = entry as Json;
    if (typeof key !== "string" || key === "" || key.length > MAX_SELECTION_KEY_LENGTH) {
      throw new HttpError(400, "Each selection needs a non-empty string 'key'");
    }
    if (enabled !== undefined && typeof enabled !== "boolean") throw new HttpError(400, "Selection field 'enabled' must be a boolean");
    if (seen.has(key)) throw new HttpError(400, "Selections must not repeat a key");
    seen.add(key);
    selections.push(enabled === undefined ? { key } : { key, enabled });
  }
  return { previewId: body.preview_id, revision, selections };
}

/**
 * Maps selected keys onto the server-held candidates (the client never supplies a model payload).
 * An `import` candidate is created (disabled when the selection says `enabled: false`); an `enable` candidate switches an existing card on.
 */
function buildImportBatch(preview: StoredPreview, selections: readonly ImportSelection[]): ImportModelBatch {
  const create: Record<string, ModelPatch> = {};
  const enable: string[] = [];
  for (const { key, enabled } of selections) {
    const candidate = preview.candidates.get(key);
    if (!candidate) throw new HttpError(400, "Selection is not part of this preview. Run discovery again.", { key });
    if (candidate.action === "import" && candidate.proposed_model !== undefined) {
      // Discovery allocates IDs per harness, so candidates of two harnesses can propose the same ID; never let one replace the other.
      if (Object.hasOwn(create, candidate.proposed_id)) {
        throw new HttpError(400, `Two selected models would be imported as ${JSON.stringify(candidate.proposed_id)}. Import them in separate steps.`, { key });
      }
      create[candidate.proposed_id] = enabled === undefined ? candidate.proposed_model : { ...candidate.proposed_model, enabled };
    } else if (candidate.action === "enable" && candidate.existing_model_id !== undefined) {
      if (enabled === false) throw new HttpError(400, "An existing model can only be enabled, not imported as disabled.", { key });
      enable.push(candidate.existing_model_id);
    } else {
      throw new HttpError(400, `Candidate is ${candidate.status} and has nothing to import or enable.`, { key });
    }
  }
  return { create, enable };
}

const URL_WITH_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@]*@)?([^\s?#"'<>]*)(\?[^\s#"'<>]*)?(#[^\s"'<>]*)?/gi;

/** Strips URL userinfo, query strings and #fragments (they carry credentials), then redacts token-shaped secrets. */
function scrubText(text: string): string {
  return redactSecrets(text.replace(URL_WITH_CREDENTIALS, (_match, scheme: string, _userinfo: string | undefined, rest: string) => `${scheme}${rest}`));
}

const optionalScrubbed = <K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> =>
  value === undefined ? {} : ({ [key]: scrubText(value) } as Record<K, string>);

/** Defense in depth: quarantine reasons and config warnings are redacted when created, and again before they leave the server. */
function publicSnapshot(snapshot: ConfigSnapshot): ConfigSnapshot {
  return {
    ...snapshot,
    quarantined: snapshot.quarantined.map((entry) => ({ ...entry, reason: scrubText(entry.reason) })),
    config_warnings: snapshot.config_warnings.map(scrubText),
  };
}

/** Probe notes come from adapters that may echo command output; they are scrubbed before they reach the browser. */
function publicHealth(health: HarnessHealth): HarnessHealth {
  return {
    ...health,
    ...(health.note === undefined ? {} : { note: scrubText(health.note) }),
    ...(health.runtime_warning === undefined ? {} : { runtime_warning: scrubText(health.runtime_warning) }),
  };
}

/**
 * The slice of a preview the page needs: no proposed model payloads, no probe command lines. Every string is scrubbed again
 * here, so even a custom discovery provider cannot leak a credential through this response.
 */
function sanitizePreview(previewId: string, preview: DiscoveryPreviewResult): Json {
  return {
    preview_id: previewId,
    revision: preview.revision,
    mode: preview.mode,
    providers: preview.providers,
    harnesses: preview.harnesses.map((result) => ({
      harness: result.harness,
      driver: result.driver,
      observed_at: result.observed_at,
      status: result.status,
      truncated: result.truncated,
      model_count: result.models.length,
      diagnostics: result.diagnostics.map((diagnostic) => ({
        stage: diagnostic.stage,
        code: diagnostic.code,
        ...optionalScrubbed("message", diagnostic.message),
      })),
    })),
    candidates: preview.candidates.map((candidate) => ({
      key: candidate.key,
      harness: candidate.harness,
      driver: candidate.driver,
      status: candidate.status,
      action: candidate.action,
      proposed_id: scrubText(candidate.proposed_id),
      ...optionalScrubbed("existing_model_id", candidate.existing_model_id),
      metadata_quality: candidate.metadata_quality,
      ...optionalScrubbed("template_id", candidate.template_id),
      discovered: {
        cli_model: scrubText(candidate.discovered.cli_model),
        ...optionalScrubbed("cli_provider", candidate.discovered.cli_provider),
        ...optionalScrubbed("display_name", candidate.discovered.display_name),
        ...(candidate.discovered.context_window === undefined ? {} : { context_window: candidate.discovered.context_window }),
        ...(candidate.discovered.context_precision === undefined ? {} : { context_precision: candidate.discovered.context_precision }),
        availability: candidate.discovered.availability,
        evidence: candidate.discovered.evidence,
      },
    })),
    total_candidates: preview.total_candidates,
    truncated: preview.truncated,
  };
}

type RouteHandler = (body: Json, id: string) => Promise<ConfigSnapshot>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
  /** Set on entity routes: the config section whose existing IDs are accepted as they are. */
  section?: "harnesses" | "models" | "presets";
}

export async function startSettingsUi(options: SettingsUiOptions = {}): Promise<SettingsUiHandle> {
  const configManager = options.configManager ?? new ConfigManager();
  const configWriter = options.configWriter ?? new ConfigWriter(configManager);
  const adapterRegistry = options.adapterRegistry ?? new AdapterRegistry();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const previews = new PreviewStore(options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS, MAX_STORED_PREVIEWS);
  const activeDiscoveries = new Set<AbortController>();
  const activeProbes = new Set<AbortController>();
  /** Config writes (and the responses that report them) still running; shutdown waits for them before it releases the instance lock. */
  const activeWrites = new Set<Promise<unknown>>();
  let activeBodyReads = 0;
  const appHtml = loadAppHtml();
  // Fail fast on a broken built-in catalog instead of serving a half-working page.
  configManager.load();

  const bootstrapToken = randomToken();
  const sessionId = randomToken();
  const csrfToken = randomToken();
  let bootstrapConsumed = false;
  const bootstrapExpiresAt = Date.now() + (options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS);

  const lock = options.lockDir ? await InstanceLock.acquire(options.lockDir) : undefined;
  const server = createServer({ requestTimeout: REQUEST_TIMEOUT_MS, headersTimeout: HEADERS_TIMEOUT_MS });
  server.maxConnections = MAX_CONNECTIONS;
  let address: AddressInfo;
  try {
    address = await listen(server, options.port ?? 0);
    lock?.write({ port: address.port });
  } catch (error) {
    server.close();
    lock?.release();
    throw error;
  }

  const port = address.port;
  const baseUrl = `http://${HOST}:${port}`;
  const expectedHost = `${HOST}:${port}`;

  let closed = false;
  let resolveClosed!: () => void;
  const waitUntilClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let idleTimer: NodeJS.Timeout | undefined;

  const close = async (): Promise<void> => {
    if (closed) return waitUntilClosed;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    for (const discovery of activeDiscoveries) discovery.abort();
    for (const probe of activeProbes) probe.abort();
    previews.clear();
    // No new connections from here on; new requests on kept-alive connections are refused with 503 (see the request handler).
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      // A config write that already started finishes (and answers its client) before the instance lock goes away.
      let drainTimer: NodeJS.Timeout | undefined;
      const drainDeadline = new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, SHUTDOWN_DRAIN_TIMEOUT_MS);
        drainTimer.unref();
      });
      await Promise.race([Promise.allSettled([...activeWrites]), drainDeadline]);
      if (drainTimer) clearTimeout(drainTimer);
      server.closeIdleConnections();
      const forceTimer = setTimeout(() => server.closeAllConnections(), SHUTDOWN_CONNECTION_GRACE_MS);
      forceTimer.unref();
      await stopped;
      clearTimeout(forceTimer);
    } finally {
      try {
        lock?.release();
      } catch (error) {
        logger.error("Could not release the settings UI lock", { error: error instanceof Error ? error.message : String(error) });
      }
      resolveClosed();
    }
  };

  /** Runs one config write so shutdown can wait for it; refuses the write once shutdown has begun. */
  const trackWrite = (work: () => Promise<void>): Promise<void> => {
    if (closed) return Promise.reject(new HttpError(503, SHUTTING_DOWN_MESSAGE));
    const running = work();
    activeWrites.add(running);
    const forget = () => { activeWrites.delete(running); };
    running.then(forget, forget);
    return running;
  };

  /** Reads a request body, with at most MAX_CONCURRENT_BODY_READS in flight so slow uploads cannot hold every connection. */
  const readBody = async (request: IncomingMessage): Promise<Json> => {
    if (activeBodyReads >= MAX_CONCURRENT_BODY_READS) throw new HttpError(429, SERVER_BUSY_MESSAGE);
    activeBodyReads++;
    try {
      return await readJsonBody(request);
    } finally {
      activeBodyReads--;
    }
  };

  const touch = () => {
    if (closed) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.info("Settings UI idle timeout reached; shutting down", { idleTimeoutMs });
      void close();
    }, idleTimeoutMs);
  };

  const hasSession = (request: IncomingMessage) => safeEqual(readCookie(request, SESSION_COOKIE), sessionId);

  const entityRoute = (
    method: string,
    section: "harnesses" | "models" | "presets",
    suffix: string,
    handler: RouteHandler,
  ): Route => ({ method, pattern: new RegExp(`^/api/${section}/([^/]+)${suffix}$`), handler, section });

  const routes: Route[] = [
    { method: "PUT", pattern: /^\/api\/defaults$/, handler: (body) =>
      configWriter.updateDefaults(requirePatch(body), requireRevision(body)) },
    entityRoute("PUT", "models", "", (body, id) =>
      configWriter.upsertModelOverride(id, requirePatch(body) as ModelPatch, requireRevision(body))),
    entityRoute("POST", "models", "/reset-field", (body, id) => {
      if (typeof body.field !== "string" || !FIELD_NAME_PATTERN.test(body.field)) {
        throw new HttpError(400, "Field 'field' must be a model field name");
      }
      return configWriter.resetModelField(id, body.field as keyof ModelPatch, requireRevision(body));
    }),
    entityRoute("POST", "models", "/reset", (body, id) => configWriter.resetOrDeleteModel(id, requireRevision(body))),
    entityRoute("PUT", "harnesses", "", (body, id) =>
      configWriter.upsertHarnessOverride(id, requirePatch(body) as HarnessPatch, requireRevision(body))),
    entityRoute("POST", "harnesses", "/reset-field", (body, id) => {
      if (typeof body.field !== "string" || !FIELD_NAME_PATTERN.test(body.field)) {
        throw new HttpError(400, "Field 'field' must be a harness field name");
      }
      return configWriter.resetHarnessField(id, body.field as keyof HarnessPatch, requireRevision(body));
    }),
    entityRoute("POST", "harnesses", "/reset", (body, id) =>
      configWriter.resetOrDeleteHarness(id, requireRevision(body))),
    entityRoute("PUT", "presets", "", (body, id) =>
      configWriter.upsertPresetOverride(id, requirePatch(body), requireRevision(body))),
    entityRoute("POST", "presets", "/reset", (body, id) => configWriter.resetOrDeletePreset(id, requireRevision(body))),
    { method: "POST", pattern: /^\/api\/reset-section$/, handler: (body) => {
      if (!CONFIG_SECTIONS.includes(body.section as ConfigSection)) {
        throw new HttpError(400, `Field 'section' must be one of: ${CONFIG_SECTIONS.join(", ")}`);
      }
      return configWriter.resetSection(body.section as ConfigSection, requireRevision(body));
    } },
    { method: "POST", pattern: /^\/api\/reset-all$/, handler: (body) =>
      configWriter.resetAllToDefault(requireRevision(body)) },
    { method: "POST", pattern: /^\/api\/quarantined\/reset$/, handler: (body) => resetQuarantined(body) },
  ];

  /**
   * Drops the user override of one quarantined entity. The ID travels in the JSON body, never in the URL: legacy IDs such as "." or ".."
   * would be rewritten by URL path normalization, and prototype-like names are refused by the path-based entity routes.
   */
  const resetQuarantined = (body: Json): Promise<ConfigSnapshot> => {
    const revision = requireRevision(body);
    const { section, id } = body;
    if (typeof section !== "string" || !QUARANTINE_SECTIONS.includes(section as QuarantineSection)) {
      throw new HttpError(400, `Field 'section' must be one of: ${QUARANTINE_SECTIONS.join(", ")}`);
    }
    if (typeof id !== "string" || id === "" || id.length > MAX_HARNESS_ID_LENGTH || CONTROL_CHARACTERS.test(id)) {
      throw new HttpError(400, "Field 'id' must be the ID of a quarantined entry");
    }
    const current = configManager.reloadIfChanged();
    // A stale revision is answered by the writer's 409 (with a fresh snapshot); only an up-to-date page can name a missing entry.
    if (revision === current.revision && !current.quarantined.some((entry) => entry.section === section && entry.id === id)) {
      throw new HttpError(404, `${section}.${id} is not quarantined`);
    }
    switch (section as QuarantineSection) {
      case "harnesses": return configWriter.resetOrDeleteHarness(id, revision);
      case "models": return configWriter.resetOrDeleteModel(id, revision);
      case "presets": return configWriter.resetOrDeletePreset(id, revision);
      case "aliases": return configWriter.resetAlias(id, revision);
    }
  };

  /** The vendor the planner would infer for each model if `vendor_family` were not set, so the UI can show what "auto" means. */
  const inferredVendors = (snapshot: ConfigSnapshot): Record<string, string> => Object.fromEntries(
    Object.entries(snapshot.models).flatMap(([id, model]) => {
      const harness = Object.hasOwn(snapshot.harnesses, model.harness) ? snapshot.harnesses[model.harness] : undefined;
      if (!harness) return [];
      const { vendor_family: _explicit, ...withoutVendor } = model;
      return [[id, inferVendorFamily({ ...withoutVendor, cli_model: model.cli_model ?? id }, harness.driver, harness.default_upstream_provider)]];
    }));

  const statePayload = (): Json => {
    const snapshot = configManager.load();
    // The CSRF token is deliberately absent: it reaches the page only through the `#t=` fragment of the bootstrap redirect.
    return {
      catalogPath: configManager.defaultPath,
      userConfigPath: configManager.userPath,
      stateDir: getStateDir(),
      defaults_catalog: parseDefaultCatalog(readFileSync(configManager.defaultPath, "utf8")),
      // The snapshot carries `quarantined` (entities left out because they failed validation) and `defaults.inherit_mcp`.
      snapshot: publicSnapshot(snapshot),
      supported_drivers: [...DRIVER_KINDS],
      // Every driver's full capability record: supportsProfile, usesUpstreamProvider, usesCliProvider, requiresProviderPrefix,
      // defaultEfforts, effortSupport, writePermissionModes, and the rest of src/drivers.ts.
      driver_metadata: DRIVER_METADATA,
      id_policy: { max_length: ENTITY_ID_MAX_LENGTH, rules: ENTITY_ID_RULES },
      inferred_vendor_family: inferredVendors(snapshot),
    };
  };

  /**
   * Probes every harness. The registry's probes are shared and cannot be cancelled, so shutdown stops waiting for them
   * (the request fails with 503) instead of keeping the server, and its instance lock, alive behind a slow CLI.
   */
  const probeAll = async (refresh: boolean): Promise<Record<string, HarnessHealth>> => {
    const harnesses = Object.entries(configManager.load().harnesses);
    const abort = new AbortController();
    activeProbes.add(abort);
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener("abort", () => reject(new HttpError(503, SHUTTING_DOWN_MESSAGE)), { once: true });
    });
    try {
      const results = await Promise.race([
        Promise.all(harnesses.map(async ([id, harness]) =>
          [id, publicHealth(await adapterRegistry.probeHarness(id, harness, { refresh }))] as const)),
        cancelled,
      ]);
      return Object.fromEntries(results);
    } finally {
      activeProbes.delete(abort);
    }
  };

  const respondFailure = (response: ServerResponse, error: unknown) => {
    const failure = classifyError(error);
    const extra = failure.status === 409 ? { ...failure.extra, snapshot: publicSnapshot(configManager.load()) } : failure.extra;
    sendError(response, failure.status, failure.message, extra);
  };

  /** Runs discovery for the saved config and keeps the candidates server-side; the page gets a sanitized copy and a `preview_id`. */
  const handleDiscover = async (body: Json, response: ServerResponse): Promise<void> => {
    const input = parseDiscoverRequest(body);
    const snapshot = configManager.reloadIfChanged();
    if (input.revision !== undefined && input.revision !== snapshot.revision) {
      throw new ConfigRevisionConflictError(input.revision, snapshot.revision);
    }
    if (input.harness !== undefined && !Object.hasOwn(snapshot.harnesses, input.harness)) {
      throw new HttpError(400, `Unknown harness ${JSON.stringify(input.harness)}. Choose one of: ${Object.keys(snapshot.harnesses).join(", ")}, or omit 'harness' to scan all.`);
    }
    if (activeDiscoveries.size >= MAX_CONCURRENT_DISCOVERIES) {
      throw new HttpError(429, "Model discovery is already running. Wait for it to finish and retry.");
    }
    // The scan stops when the page gives up on it (closed drawer, new scan) or the server shuts down.
    const abort = new AbortController();
    const onClientGone = () => { if (!response.writableEnded) abort.abort(); };
    response.once("close", onClientGone);
    activeDiscoveries.add(abort);
    let preview: DiscoveryPreviewResult;
    try {
      const run = options.discoverModels ?? (await import("../discovery/service.js")).previewDiscovery;
      preview = await run(snapshot, { ...(input.harness === undefined ? {} : { harness: input.harness }), mode: input.mode, providers: input.providers, signal: abort.signal });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, `Model discovery failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
    } finally {
      activeDiscoveries.delete(abort);
      response.off("close", onClientGone);
    }
    if (abort.signal.aborted) throw new HttpError(503, "Model discovery was cancelled.");
    sendJson(response, 200, sanitizePreview(previews.add(preview.revision, preview.candidates), preview));
  };

  /**
   * Applies selected candidates of a stored preview in one atomic write. The preview stays addressable until it expires, so a repeated
   * submit lands on the revision check (409) instead of looking like an unknown preview.
   */
  const handleImport = async (body: Json, response: ServerResponse): Promise<void> => {
    // Loaded on demand: the run path (CLI entry, MCP server) must not reach the discovery modules statically.
    const { MAX_APPLY_BATCH } = await import("../discovery/types.js");
    const input = parseImportRequest(body, MAX_APPLY_BATCH);
    const preview = previews.get(input.previewId);
    if (!preview) throw new HttpError(410, PREVIEW_EXPIRED_MESSAGE);
    if (input.revision !== preview.revision) {
      throw new ConfigRevisionConflictError(input.revision, configManager.reloadIfChanged().revision);
    }
    const batch = buildImportBatch(preview, input.selections);
    const result = await configWriter.importModels(batch, input.revision);
    sendJson(response, 200, {
      snapshot: publicSnapshot(result.snapshot),
      imported: result.imported,
      enabled: result.enabled,
      skipped: result.skipped,
      imported_count: result.imported.length,
      enabled_count: result.enabled.length,
    });
  };

  const discoveryRoutes = new Map<string, (body: Json, response: ServerResponse) => Promise<void>>([
    ["/api/discover", handleDiscover],
    ["/api/models/import", handleImport],
  ]);

  /** Static page: it carries no secret. The session's CSRF token is delivered once, in the URL fragment of the bootstrap redirect. */
  const serveApp = (response: ServerResponse) => {
    const nonce = randomBytes(16).toString("base64");
    sendRaw(response, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": pageCsp(nonce),
    }, appHtml.replaceAll(NONCE_PLACEHOLDER, nonce));
  };

  /**
   * Guards every /api/* call, reads included. The session cookie alone proves nothing: cookies are not port-isolated, so any other
   * service on 127.0.0.1 could receive or replay it. The CSRF token is never sent over HTTP after the bootstrap: it travels in the
   * URL fragment of the one-time redirect (`/#t=<token>`), which browsers never send to a server or in a Referer, and the page keeps
   * it in `sessionStorage`, which is isolated per origin and port. Requiring it on every call therefore binds the API to this origin
   * even when another local server receives the cookie. A browser that labels the request as anything but same-origin (cross-site,
   * same-site, none) is refused; clients that send no label (curl, tests) pass.
   */
  const authorizeApi = (request: IncomingMessage, response: ServerResponse, mutating: boolean): boolean => {
    if (!hasSession(request)) {
      sendError(response, 401, "Unauthorized. Open the URL printed in the terminal.");
      return false;
    }
    const fetchSite = singleHeader(request, "sec-fetch-site");
    if (fetchSite !== undefined && fetchSite !== "same-origin") {
      sendError(response, 403, "Forbidden: cross-origin request");
      return false;
    }
    if (mutating && singleHeader(request, "origin") !== baseUrl) {
      sendError(response, 403, "Forbidden: missing or foreign Origin");
      return false;
    }
    if (!safeEqual(singleHeader(request, CSRF_HEADER), csrfToken)) {
      sendError(response, 403, "Forbidden: missing or invalid X-Orch-Token");
      return false;
    }
    return true;
  };

  const handleGet = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname === "/") {
      const tokens = url.searchParams.getAll("token");
      if (tokens.length > 0) {
        if (!bootstrapConsumed && tokens.length === 1 && safeEqual(tokens[0], bootstrapToken)) {
          if (Date.now() >= bootstrapExpiresAt) {
            sendPlainPage(response, 401, "Link expired",
              `This one-time link was not opened in time. Restart ${CLI_NAME} settings and open the new URL from your terminal.`);
            return;
          }
          bootstrapConsumed = true;
          touch();
          sendRaw(response, 302, {
            Location: `/#t=${csrfToken}`,
            "Set-Cookie": `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
            "Content-Security-Policy": NON_HTML_CSP,
          }, "");
          return;
        }
        // A browser that already holds the session only needs the token stripped from the address bar.
        if (hasSession(request)) {
          sendRaw(response, 302, { Location: "/", "Content-Security-Policy": NON_HTML_CSP }, "");
          return;
        }
        sendPlainPage(response, 401, "Link already used",
          `This one-time link is invalid or has already been opened. Restart ${CLI_NAME} settings and open the new URL from your terminal.`);
        return;
      }
      if (!hasSession(request)) {
        sendPlainPage(response, 401, "Authorization required",
          `Open the tokenized URL printed by ${CLI_NAME} settings in your terminal.`);
        return;
      }
      touch();
      serveApp(response);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!authorizeApi(request, response, false)) return;
      touch();
      if (url.pathname === "/api/state") {
        sendJson(response, 200, statePayload());
        return;
      }
      if (url.pathname === "/api/health") {
        sendJson(response, 200, { harnesses: await probeAll(url.searchParams.get("refresh") === "1") });
        return;
      }
    }
    sendError(response, 404, "Not found");
  };

  const handleMutation = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!authorizeApi(request, response, true)) return;
    const contentType = singleHeader(request, "content-type") ?? "";
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json") {
      sendError(response, 415, "Content-Type must be application/json");
      return;
    }

    const body = await readBody(request);
    touch();
    if (request.method === "POST" && url.pathname === "/api/heartbeat") {
      sendJson(response, 200, { ok: true });
      return;
    }

    const discoveryRoute = request.method === "POST" ? discoveryRoutes.get(url.pathname) : undefined;
    if (discoveryRoute) {
      const run = async () => {
        try {
          await discoveryRoute(body, response);
        } catch (error) {
          respondFailure(response, error);
        }
      };
      // Discovery only reads; the import route is the one that writes config and must be drained on shutdown.
      if (url.pathname === "/api/models/import") await trackWrite(run).catch((error: unknown) => respondFailure(response, error));
      else await run();
      return;
    }

    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const id = match[1] === undefined ? "" : requireEntityId(match[1], route.section && configManager.load()[route.section]);
      await trackWrite(async () => {
        try {
          sendJson(response, 200, { snapshot: publicSnapshot(await route.handler(body, id)) });
        } catch (error) {
          respondFailure(response, error);
        }
      }).catch((error: unknown) => respondFailure(response, error));
      return;
    }
    sendError(response, 404, "Not found");
  };

  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (closed) {
        sendRaw(response, 503, { "Content-Type": "application/json; charset=utf-8", "Content-Security-Policy": NON_HTML_CSP, Connection: "close" },
          JSON.stringify({ error: SHUTTING_DOWN_MESSAGE }));
        return;
      }
      // Exact Host match blocks DNS rebinding: a rebound name never equals the literal loopback address.
      if (singleHeader(request, "host") !== expectedHost) {
        sendError(response, 403, "Forbidden: unexpected Host header");
        return;
      }
      let url: URL;
      try {
        url = new URL(request.url ?? "/", baseUrl);
      } catch {
        sendError(response, 400, "Bad request URL");
        return;
      }

      const method = request.method ?? "GET";
      // Browsers fetch the icon without credentials and outside the page's session: it must not 401, consume the one-time
      // token, or count as activity for the idle shutdown, so it is answered after the Host check and before any auth.
      const favicon = method === "GET" || method === "HEAD" ? getFaviconAssets().get(url.pathname) : undefined;
      if (favicon) {
        sendAsset(response, method, favicon);
        return;
      }
      if (method === "GET") await handleGet(request, response, url);
      else if (MUTATING_METHODS.has(method)) await handleMutation(request, response, url);
      else sendError(response, 405, "Method not allowed");
    })().catch((error: unknown) => {
      const failure = classifyError(error);
      if (failure.status >= 500) logger.error("Settings UI request failed", { error: failure.message });
      sendError(response, failure.status, failure.message, failure.extra);
    });
  });

  touch();
  const url = `${baseUrl}/?token=${bootstrapToken}`;
  if (options.openBrowser !== false) openInBrowser(url);
  return { url, baseUrl, port, close, waitUntilClosed };
}
