import { createHash } from "node:crypto";

/** Upper bound on remembered `client_request_id` values per MCP session; the oldest is dropped first. */
export const MAX_IDEMPOTENT_RUNS = 1_000;

/** Delivery options and the ID itself do not change what a call asks for, so a retry may differ in them. */
const FINGERPRINT_EXCLUDED_KEYS: ReadonlySet<string> = new Set(["client_request_id", "async", "wait_ms"]);

export interface IdempotentRun {
  jobId: string;
  fingerprint: string;
  /** Compact last-seen state of the job, served when the runner has already pruned it from memory. */
  snapshot: object;
}

/** Stable hash of the arguments that define "the same call", independent of key order and of omitted (undefined) fields. */
export function runFingerprint(request: object): string {
  const entries = Object.entries(request)
    .filter(([key, value]) => value !== undefined && !FINGERPRINT_EXCLUDED_KEYS.has(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/**
 * Remembers which job answered each `client_request_id` independently of the runner's plan cache and job pruning, so a replay
 * after the plan was evicted (or the job pruned) still resolves to the original job instead of PLAN_NOT_FOUND or a duplicate run.
 * Bounded: remembering beyond the capacity drops the least recently used entry.
 */
export class RunIdempotencyLedger {
  private readonly entries = new Map<string, IdempotentRun>();

  constructor(private readonly capacity = MAX_IDEMPOTENT_RUNS) {}

  get size(): number {
    return this.entries.size;
  }

  /** The earlier run for this ID, only when the call is identical; a different payload is left for the runner to judge. */
  find(clientRequestId: string, fingerprint: string): IdempotentRun | undefined {
    const run = this.entries.get(clientRequestId);
    if (!run || run.fingerprint !== fingerprint) return undefined;
    this.entries.delete(clientRequestId);
    this.entries.set(clientRequestId, run);
    return run;
  }

  remember(clientRequestId: string, run: IdempotentRun): void {
    this.entries.delete(clientRequestId);
    this.entries.set(clientRequestId, run);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }
}
