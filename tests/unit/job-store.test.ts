import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobStore } from "../../src/runtime/job-store.js";

const HOUR_MS = 60 * 60 * 1_000;
const NOW = Date.parse("2026-06-15T12:00:00Z");
const TERMINAL_STATUSES = ["completed", "failed", "timed_out", "cancelled"];

describe("JobStore.pruneOldRuns terminal status", () => {
  let root: string;
  let store: JobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-job-store-"));
    store = new JobStore(join(root, "runs"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Seeds a run whose metadata is `meta` (raw JSON text) and whose files last changed `hoursAgo` hours before NOW. */
  async function seed(name: string, hoursAgo: number, meta: string): Promise<void> {
    const dir = store.getJobDir(name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "meta.json"), meta);
    await writeFile(join(dir, "result.md"), "x".repeat(32));
    const when = new Date(NOW - hoursAgo * HOUR_MS);
    for (const path of [join(dir, "meta.json"), join(dir, "result.md"), dir]) await utimes(path, when, when);
  }

  const created = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR_MS).toISOString();
  const remaining = async () => (await readdir(join(root, "runs"))).sort();
  const sizePolicy = { retentionDays: 0, maxTotalBytes: 1, now: NOW };
  const agePolicy = { retentionDays: 7, maxTotalBytes: 0, now: NOW };

  it.each([
    ["an unknown status string", { status: "paused" }],
    ["a missing status", {}],
    ["a null status", { status: null }],
    ["a non-string status", { status: 7 }],
  ])("protects a recent run with %s as possibly live and prunes it once the grace period is over", async (_label, fields) => {
    const meta = JSON.stringify({ ...fields, created_at: created(3 * 24) });
    await seed("recent", 23, meta);
    await seed("stale", 25, meta);
    for (const policy of [sizePolicy, agePolicy]) {
      const result = await store.pruneOldRuns(policy);
      expect(result.removed).toBe(policy === sizePolicy ? 1 : 0);
    }
    expect(await remaining()).toEqual(["recent"]);
  });

  it.each(TERMINAL_STATUSES)("prunes a recent %s run immediately by size and an old one by age", async (status) => {
    await seed("finished-recent", 1, JSON.stringify({ status, created_at: created(1) }));
    await seed("finished-old", 10 * 24, JSON.stringify({ status, created_at: created(10 * 24) }));
    await expect(store.pruneOldRuns(agePolicy)).resolves.toMatchObject({ removed: 1 });
    expect(await remaining()).toEqual(["finished-recent"]);
    await expect(store.pruneOldRuns(sizePolicy)).resolves.toMatchObject({ removed: 1 });
    expect(await remaining()).toEqual([]);
  });
});
