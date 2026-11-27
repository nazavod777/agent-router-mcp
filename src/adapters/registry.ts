import type { HarnessConfig } from "../config/schema.js";
import { DRIVER_METADATA } from "../drivers.js";
import { redactSecrets } from "../logging.js";
import type { DriverKind, HarnessHealth, RunMode, SecurityGuarantee } from "../types.js";
import { AntigravityAdapter } from "./antigravity.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import { DshAdapter } from "./dsh.js";
import { CopilotAdapter, DroidAdapter, KimiAdapter, VibeAdapter } from "./ecosystem.js";
import { GeminiAdapter, QwenAdapter } from "./gemini.js";
import { OpenCodeAdapter } from "./opencode.js";
import { PiAdapter } from "./pi.js";
import { healthNow } from "./probe-utils.js";
import { CursorAdapter, FxAdapter, GrokAdapter, KiroAdapter, MuseAdapter } from "./vendor-clis.js";
import type { AdapterRegistryLike, CliAdapter } from "./types.js";

export const DEFAULT_PROBE_CACHE_TTL_MS = 120_000;
const READY_PROBE_CACHE_TTL_MS = 600_000;
const MAX_ACTIVE_PROBES = 4;
const MAX_QUEUED_PROBES = 256;
/** Upper bound for cached health entries (one per distinct harness configuration); the oldest are evicted first. */
export const MAX_PROBE_CACHE_ENTRIES = 256;

const ADAPTER_FACTORIES = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  dsh: () => new DshAdapter(),
  pi: () => new PiAdapter(),
  antigravity: () => new AntigravityAdapter(),
  opencode: () => new OpenCodeAdapter(),
  gemini: () => new GeminiAdapter(),
  cursor: () => new CursorAdapter(),
  grok: () => new GrokAdapter(),
  kiro: () => new KiroAdapter(),
  fx: () => new FxAdapter(),
  muse: () => new MuseAdapter(),
  copilot: () => new CopilotAdapter(),
  droid: () => new DroidAdapter(),
  qwen: () => new QwenAdapter(),
  kimi: () => new KimiAdapter(),
  vibe: () => new VibeAdapter(),
} satisfies Record<DriverKind, () => CliAdapter>;

export function createBuiltinAdapters(): CliAdapter[] {
  return Object.values(ADAPTER_FACTORIES).map((create) => create());
}

/** Static security guarantees per built-in driver (no probing needed). */
export const DRIVER_SECURITY_GUARANTEES: Record<DriverKind, Record<RunMode, SecurityGuarantee>> = Object.fromEntries(
  createBuiltinAdapters().map((adapter) => [adapter.driver, { ...adapter.securityGuarantees }]),
) as Record<DriverKind, Record<RunMode, SecurityGuarantee>>;

export interface AdapterRegistryOptions {
  /** Adapters that replace the built-ins for their driver (tests, custom drivers). */
  adapters?: CliAdapter[];
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  health: HarnessHealth;
  expiresAt: number;
}

export class AdapterRegistry implements AdapterRegistryLike {
  private readonly adapters = new Map<DriverKind, CliAdapter>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<HarnessHealth>>();
  /** Bumped whenever the cache is invalidated; a probe started under an older generation never writes its result. */
  private generation = 0;
  private activeProbes = 0;
  private readonly probeWaiters: Array<() => void> = [];
  private readonly ttlMs?: number;
  private readonly now: () => number;

  constructor(options: AdapterRegistryOptions = {}) {
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? Date.now;
    for (const adapter of [...createBuiltinAdapters(), ...(options.adapters ?? [])]) this.register(adapter);
  }

  register(adapter: CliAdapter): void {
    this.adapters.set(adapter.driver, adapter);
    this.clearCache();
  }

  get(driver: DriverKind): CliAdapter {
    const adapter = this.adapters.get(driver);
    if (!adapter) throw new Error(`No adapter registered for driver ${JSON.stringify(driver)}`);
    return adapter;
  }

  async probeHarness(
    harnessId: string,
    harness: HarnessConfig,
    options: { refresh?: boolean; timeoutMs?: number } = {},
  ): Promise<HarnessHealth> {
    const key = this.cacheKey(harnessId, harness);
    if (!options.refresh) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > this.now()) return this.withEnabled(cached.health, harness);
    }

    // Parallel callers share one probe, including refresh requests that overlap a running probe.
    let pending = this.inFlight.get(key);
    if (!pending) {
      if (this.probeWaiters.length >= MAX_QUEUED_PROBES) {
        const adapter = this.get(harness.driver);
        return healthNow({ harnessId, harness, driver: adapter.driver, securityGuarantees: adapter.securityGuarantees }, {
          note: "Probe queue is full; retry after pending probes finish.",
          probe_inconclusive: true,
        });
      }
      const generation = this.generation;
      const started: Promise<HarnessHealth> = this.runProbe(harnessId, harness, options.timeoutMs).then((health) => {
        // An adapter replacement or cache clear made this result stale; return it to its callers but never cache it.
        if (generation === this.generation) {
          const ttl = this.ttlMs ?? (health.installed && health.auth_status === "ready"
            ? READY_PROBE_CACHE_TTL_MS : DEFAULT_PROBE_CACHE_TTL_MS);
          this.storeHealth(key, { health, expiresAt: this.now() + ttl });
        }
        return health;
      }).finally(() => {
        // A newer probe may already own this key after an invalidation.
        if (this.inFlight.get(key) === started) this.inFlight.delete(key);
      });
      pending = started;
      this.inFlight.set(key, pending);
    }
    return this.withEnabled(await pending, harness);
  }

  /** Returns a non-expired cached health entry synchronously, without starting a probe. */
  getCachedHealth(harnessId: string, harness: HarnessConfig): HarnessHealth | undefined {
    const cached = this.cache.get(this.cacheKey(harnessId, harness));
    if (cached && cached.expiresAt > this.now()) return this.withEnabled(cached.health, harness);
    return undefined;
  }

  clearCache(): void {
    this.generation++;
    this.cache.clear();
    // Probes still running were started against the old state; new callers must start their own.
    this.inFlight.clear();
  }

  /** Inserts as the newest entry and evicts the oldest ones beyond the bound. */
  private storeHealth(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > MAX_PROBE_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
  }

  /** The key covers the config fields a probe depends on, so config edits invalidate it. */
  private cacheKey(harnessId: string, harness: HarnessConfig): string {
    return JSON.stringify([
      harnessId, harness.driver, harness.binary, harness.default_upstream_provider ?? null,
      harness.profile ?? null, harness.extra_args ?? null,
    ]);
  }

  private async runProbe(harnessId: string, harness: HarnessConfig, timeoutMs?: number): Promise<HarnessHealth> {
    const adapter = this.get(harness.driver);
    if (this.activeProbes < MAX_ACTIVE_PROBES) this.activeProbes++;
    else await new Promise<void>((resolve) => this.probeWaiters.push(resolve));
    try {
      return await adapter.probe(harnessId, harness, { timeoutMs: timeoutMs ?? DRIVER_METADATA[harness.driver].probeTimeoutMs });
    } catch (error) {
      return {
        harness: harnessId,
        driver: harness.driver,
        enabled: harness.enabled,
        installed: false,
        auth_status: "unknown",
        security_guarantees: { ...adapter.securityGuarantees },
        checked_at: new Date(this.now()).toISOString(),
        note: redactSecrets(`Probe failed: ${error instanceof Error ? error.message : String(error)}`),
        probe_inconclusive: true,
      };
    } finally {
      // Transfer the occupied slot directly so a new request cannot jump ahead of a waiter.
      const next = this.probeWaiters.shift();
      if (next) next();
      else this.activeProbes--;
    }
  }

  /** Returns a copy whose `enabled` reflects the current config, not the config at probe time. */
  private withEnabled(health: HarnessHealth, harness: HarnessConfig): HarnessHealth {
    return { ...health, enabled: harness.enabled, security_guarantees: { ...health.security_guarantees } };
  }
}
