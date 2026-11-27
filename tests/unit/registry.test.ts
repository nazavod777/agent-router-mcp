import { describe, expect, it } from "vitest";
import type { HarnessConfig } from "../../src/config/schema.js";
import { AdapterRegistry, MAX_PROBE_CACHE_ENTRIES } from "../../src/adapters/registry.js";
import type { CliAdapter } from "../../src/adapters/types.js";
import type { HarnessHealth } from "../../src/types.js";

const GUARANTEES = { readonly: "os_sandbox", write: "os_sandbox" } as const;

function harness(binary = "fake-cli"): HarnessConfig {
  return { driver: "dsh", display_name: "Fake", binary, enabled: true } as HarnessConfig;
}

function health(harnessId: string, note: string): HarnessHealth {
  return {
    harness: harnessId, driver: "dsh", enabled: true, installed: true, auth_status: "ready",
    security_guarantees: { ...GUARANTEES }, checked_at: new Date(0).toISOString(), note,
  };
}

/** An adapter whose probes finish only when the test resolves them, so a probe can be in flight during a change. */
function controllableAdapter(label: string) {
  const pending: Array<(note: string) => void> = [];
  let calls = 0;
  const adapter: CliAdapter = {
    driver: "dsh",
    securityGuarantees: { ...GUARANTEES },
    mapEffort: (effort) => effort,
    probe: (harnessId) => new Promise((resolve) => {
      calls++;
      pending.push((note) => resolve(health(harnessId, `${label}:${note}`)));
    }),
    buildInvocation: async () => { throw new Error("unused"); },
    createStreamParser: () => { throw new Error("unused"); },
  };
  return { adapter, calls: () => calls, finishNext: (note: string) => pending.shift()!(note) };
}

function instantAdapter(): CliAdapter {
  return {
    driver: "dsh",
    securityGuarantees: { ...GUARANTEES },
    mapEffort: (effort) => effort,
    probe: async (harnessId, config) => health(harnessId, config.binary),
    buildInvocation: async () => { throw new Error("unused"); },
    createStreamParser: () => { throw new Error("unused"); },
  };
}

describe("AdapterRegistry probe cache", () => {
  it("does not cache a probe that finished after the cache was cleared", async () => {
    const slow = controllableAdapter("old");
    const registry = new AdapterRegistry({ adapters: [slow.adapter] });
    const config = harness();
    const stale = registry.probeHarness("dsh", config);
    registry.clearCache();
    slow.finishNext("late");
    // The caller still gets its result, but nothing stale is served to later callers.
    expect((await stale).note).toBe("old:late");
    expect(registry.getCachedHealth("dsh", config)).toBeUndefined();
  });

  it("never lets a probe of a replaced adapter overwrite the cache, and starts a fresh probe for new callers", async () => {
    const before = controllableAdapter("before");
    const after = controllableAdapter("after");
    const registry = new AdapterRegistry({ adapters: [before.adapter] });
    const config = harness();
    const stale = registry.probeHarness("dsh", config);
    registry.register(after.adapter);
    // A new caller must not share the probe that runs against the replaced adapter.
    const fresh = registry.probeHarness("dsh", config);
    expect(before.calls()).toBe(1);
    expect(after.calls()).toBe(1);

    after.finishNext("new");
    expect((await fresh).note).toBe("after:new");
    before.finishNext("old");
    expect((await stale).note).toBe("before:old");
    // The slower, stale probe finished last and must not have replaced the newer entry.
    expect(registry.getCachedHealth("dsh", config)?.note).toBe("after:new");
  });

  it("keeps at most MAX_PROBE_CACHE_ENTRIES entries and evicts the oldest first", async () => {
    const registry = new AdapterRegistry({ adapters: [instantAdapter()] });
    const total = MAX_PROBE_CACHE_ENTRIES + 5;
    for (let index = 0; index < total; index++) await registry.probeHarness("dsh", harness(`cli-${index}`));
    expect(registry.getCachedHealth("dsh", harness("cli-0"))).toBeUndefined();
    expect(registry.getCachedHealth("dsh", harness("cli-4"))).toBeUndefined();
    expect(registry.getCachedHealth("dsh", harness("cli-5"))?.note).toBe("cli-5");
    expect(registry.getCachedHealth("dsh", harness(`cli-${total - 1}`))?.note).toBe(`cli-${total - 1}`);
  });
});
