/**
 * Model auto-discovery service (NEW in Wave 2): orchestrates Layer 1 (local readers) and Layer 2 (CLI listing probes),
 * enriches the result into candidates, and applies a selection through `ConfigWriter.importModels`.
 *
 * This module must stay out of the run path: `orch_plan_preview` and `orch_run` never import or call it.
 */
import { homedir } from "node:os";
import type { ConfigManager, ConfigSnapshot } from "../config/resolver.js";
import type { HarnessConfig } from "../config/schema.js";
import { ConfigRevisionConflictError, type ConfigWriter, type ImportModelBatch, type ImportModelsResult } from "../config/writer.js";
import { DRIVER_METADATA, isStockBinary, type DriverKind } from "../drivers.js";
import {
  KEY_TAG_LENGTH, buildCandidates, compareText, harnessKeyTag, mergeDiscoveredModels, normalizeRoute, routeKey,
  type BuildCandidatesOutput,
} from "./enrich.js";
import { createDiscoveryScrubber, scrubDiscoveredModel } from "./sanitize.js";
import { probeCliModels } from "./cli-probes.js";
import { readLocalModels } from "./local-readers.js";
import {
  DEFAULT_OVERALL_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  MAX_APPLY_BATCH,
  MAX_CONCURRENT_PROBES,
  MAX_MODELS_PER_SOURCE,
  type DiscoverModelsOptions,
  type DiscoveredModel,
  type DiscoveryCandidate,
  type DiscoveryDiagnostic,
  type DiscoveryEnvironment,
  type DiscoveryObservation,
  type DiscoveryPreviewResult,
  type ExecProbe,
  type HarnessDiscoveryResult,
  type ModelDiscoveryMode,
} from "./types.js";

/** Budget of the offline stage in `agrmcp doctor` and other hint-only callers. */
export const OFFLINE_HINT_DEADLINE_MS = 45;
/** Drivers whose only model source is a CLI listing: offline discovery has nothing to read for them. */
const PROBE_ONLY_DRIVERS: ReadonlySet<DriverKind> = new Set<DriverKind>(["cursor", "kiro", "muse"]);
const FAILURE_CODES: ReadonlySet<DiscoveryDiagnostic["code"]> = new Set([
  "timeout", "cancelled", "busy", "output_limit", "invalid_output", "source_unreadable", "binary_missing", "unsupported_version",
]);

export interface DiscoveryDeps {
  readLocal?: typeof readLocalModels;
  probe?: typeof probeCliModels;
  execProbe?: ExecProbe;
  now?: () => Date;
}

/** Discovery config view: the resolved snapshot (only these fields are read). */
export type DiscoveryConfig = Pick<ConfigSnapshot, "harnesses" | "models" | "aliases" | "revision"> & Partial<Pick<ConfigSnapshot, "quarantined">>;

/**
 * True for a user-made wrapper: marked `custom`, or its binary is anything but the driver's own executable looked up by
 * bare name. A path (`./tools/pi`, `/opt/x/pi`) is a wrapper even when its file name matches. An explicit
 * `model_discovery = "native"` makes it read the driver's local model sources only; running the binary to list models
 * (Layer 2 probe) additionally requires `model_discovery = "wrapper"`.
 */
export function isCustomHarness(harness: Pick<HarnessConfig, "driver" | "binary" | "custom">): boolean {
  return harness.custom === true || !isStockBinary(harness.driver, harness.binary);
}

/** Built-in harnesses are discovered natively; custom wrappers stay manual unless the user opts in explicitly. */
export function effectiveDiscovery(harness: Pick<HarnessConfig, "driver" | "binary" | "custom" | "model_discovery">): ModelDiscoveryMode {
  return harness.model_discovery ?? (isCustomHarness(harness) ? "manual" : "native");
}

function resolveEnvironment(options: DiscoverModelsOptions): DiscoveryEnvironment {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const envHome = platform === "win32" ? env.USERPROFILE : env.HOME;
  return { env, platform, cwd: options.cwd ?? process.cwd(), homeDir: options.homeDir ?? (envHome || homedir()) };
}

/** An omitted harness means every enabled harness; a given string is always that one literal harness ID, whatever it is called. */
function selectHarnesses(config: DiscoveryConfig, harness: string | undefined): Array<[string, HarnessConfig]> {
  if (harness === undefined) return Object.entries(config.harnesses).filter(([, entry]) => entry.enabled);
  if (!Object.hasOwn(config.harnesses, harness)) {
    throw new Error(`Unknown harness ${JSON.stringify(harness)}. Configured harnesses: ${Object.keys(config.harnesses).join(", ")}.`);
  }
  return [[harness, config.harnesses[harness]]];
}

const emptyObservation = (): DiscoveryObservation => ({ models: [], diagnostics: [], truncated: false });

/** Resolves with `fallback` when `work` does not settle within `ms`; the timer never outlives the race. */
async function withDeadline<T>(work: Promise<T>, ms: number | undefined, fallback: () => T): Promise<T> {
  if (ms === undefined) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback()), ms); });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Counting semaphore: at most `limit` tasks run at once; a finishing task hands its slot straight to the next waiter. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve)); // The releaser transfers its slot to us.
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/** Harnesses with a probe in flight in this process: a second concurrent discovery reports `busy` instead of double-spawning. */
const probesInFlight = new Set<string>();

function statusOf(models: number, diagnostics: readonly DiscoveryDiagnostic[], truncated: boolean): HarnessDiscoveryResult["status"] {
  const failed = diagnostics.some((diagnostic) => FAILURE_CODES.has(diagnostic.code));
  if (models > 0) return failed || truncated ? "partial" : "ok";
  if (failed) return "unavailable";
  return diagnostics.some((diagnostic) => diagnostic.code === "manual_only" || diagnostic.code === "scope_unknown") ? "unsupported" : "ok";
}

interface RunContext {
  options: DiscoverModelsOptions;
  environment: DiscoveryEnvironment;
  deps: DiscoveryDeps;
  semaphore: Semaphore;
  signal: AbortSignal;
  overallDeadlineAt: number;
  overallExpired: () => boolean;
  /**
   * The ONE absolute `performance.now()` deadline of the whole offline stage (every harness's reader and the hint counter
   * share it), or undefined when no budget was asked for. A budget also means hint mode: readers use their smaller caps.
   */
  offlineDeadlineAtMs?: number;
  now: () => Date;
}

async function readLayerOne(ctx: RunContext, id: string, harness: HarnessConfig, discovery: ModelDiscoveryMode): Promise<DiscoveryObservation> {
  const { offlineDeadlineAtMs } = ctx;
  const hinting = offlineDeadlineAtMs !== undefined;
  const read = (ctx.deps.readLocal ?? readLocalModels)({
    ...ctx.environment, harnessId: id, harness, driver: harness.driver, discovery,
    signal: ctx.signal, ...(hinting ? { deadlineAtMs: offlineDeadlineAtMs, hintMode: true } : {}),
  }).catch((): DiscoveryObservation => ({
    models: [], truncated: false, diagnostics: [{ stage: "offline", code: "source_unreadable", message: "A local config reader failed." }],
  }));
  return withDeadline(read, hinting ? Math.max(0, offlineDeadlineAtMs - performance.now()) : undefined, (): DiscoveryObservation => ({
    models: [], truncated: true, diagnostics: [{ stage: "offline", code: "timeout", message: "Offline discovery budget exceeded." }],
  }));
}

async function runLayerTwo(ctx: RunContext, id: string, harness: HarnessConfig, discovery: "native" | "wrapper"): Promise<DiscoveryObservation> {
  if (probesInFlight.has(id)) {
    return { ...emptyObservation(), diagnostics: [{ stage: "probe", code: "busy", message: "Another discovery of this harness is already running." }] };
  }
  probesInFlight.add(id);
  try {
    return await ctx.semaphore.run(async () => {
      const remaining = ctx.overallDeadlineAt - performance.now();
      if (ctx.signal.aborted || remaining <= 0) {
        const code = ctx.overallExpired() || remaining <= 0 ? "timeout" : "cancelled";
        return { ...emptyObservation(), diagnostics: [{ stage: "probe" as const, code, message: "Probe was not started." }] };
      }
      const observation = await (ctx.deps.probe ?? probeCliModels)({
        ...ctx.environment, harnessId: id, harness, driver: harness.driver, discovery,
        probeTimeoutMs: Math.max(1, Math.min(ctx.options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, remaining)),
        signal: ctx.signal, ...(ctx.deps.execProbe !== undefined ? { execProbe: ctx.deps.execProbe } : {}),
      });
      // The shared deadline aborts the probe through the signal; report it as what it was.
      return ctx.overallExpired()
        ? { ...observation, diagnostics: observation.diagnostics.map((d) => d.code === "cancelled" ? { ...d, code: "timeout" as const } : d) }
        : observation;
    });
  } catch {
    return { ...emptyObservation(), diagnostics: [{ stage: "probe", code: "invalid_output", message: "The model listing probe failed." }] };
  } finally {
    probesInFlight.delete(id);
  }
}

interface HarnessObservation {
  /** Everything the sources reported, not yet merged by route. */
  observed: DiscoveredModel[];
  diagnostics: DiscoveryDiagnostic[];
  truncated: boolean;
}

/** Layer 1 (always) and, for `on_demand`, Layer 2 of one harness; no merging, so a hint-only caller can skip that cost. */
async function observeHarness(ctx: RunContext, id: string, harness: HarnessConfig): Promise<HarnessObservation> {
  const discovery = effectiveDiscovery(harness);
  const custom = isCustomHarness(harness);
  const diagnostics: DiscoveryDiagnostic[] = [];
  let truncated = false;
  const layers: DiscoveryObservation[] = [await readLayerOne(ctx, id, harness, discovery)];

  if (ctx.options.mode === "on_demand") {
    if (discovery === "wrapper" || (discovery === "native" && !custom)) {
      layers.push(await runLayerTwo(ctx, id, harness, discovery));
    } else if (discovery === "native") {
      diagnostics.push({ stage: "probe", code: "scope_unknown", message: "A custom binary is not probed; set model_discovery = \"wrapper\" to probe it." });
    }
  } else if (PROBE_ONLY_DRIVERS.has(harness.driver) && discovery === "native") {
    diagnostics.push({ stage: "offline", code: "scope_unknown", message: `${harness.driver} has no local model source; run without --offline to list models.` });
  }

  for (const layer of layers) {
    diagnostics.push(...layer.diagnostics);
    truncated = truncated || layer.truncated;
  }
  const scrub = createDiscoveryScrubber();
  return {
    observed: layers.flatMap((layer) => layer.models).map((model) => scrubDiscoveredModel(model, scrub)).filter((model) => model !== undefined),
    truncated,
    diagnostics: diagnostics.map((diagnostic) => diagnostic.message === undefined ? diagnostic : { ...diagnostic, message: scrub(diagnostic.message) }),
  };
}

async function discoverOne(ctx: RunContext, id: string, harness: HarnessConfig): Promise<HarnessDiscoveryResult> {
  const { observed, diagnostics, truncated } = await observeHarness(ctx, id, harness);
  const models = mergeDiscoveredModels(harness.driver, harness, observed);
  return {
    harness: id, driver: harness.driver, observed_at: ctx.now().toISOString(),
    status: statusOf(models.length, diagnostics, truncated), models, diagnostics, truncated,
  };
}

/** Builds the run context (overall deadline, shared offline deadline, abort signal, probe semaphore) around `work` and always clears its timer. */
async function withRunContext<T>(
  config: DiscoveryConfig, options: DiscoverModelsOptions, deps: DiscoveryDeps,
  work: (ctx: RunContext, selected: Array<[string, HarnessConfig]>) => Promise<T>,
): Promise<T> {
  const selected = selectHarnesses(config, options.harness);
  const overall = options.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const timeout = new AbortController();
  let expired = false;
  const timer = setTimeout(() => { expired = true; timeout.abort(); }, overall);
  const signal = options.signal === undefined ? timeout.signal : AbortSignal.any([options.signal, timeout.signal]);
  const ctx: RunContext = {
    options, environment: resolveEnvironment(options), deps, semaphore: new Semaphore(MAX_CONCURRENT_PROBES), signal,
    overallDeadlineAt: performance.now() + overall, overallExpired: () => expired, now: deps.now ?? (() => new Date()),
    ...(options.offlineDeadlineMs !== undefined ? { offlineDeadlineAtMs: performance.now() + options.offlineDeadlineMs } : {}),
  };
  try {
    return await work(ctx, selected);
  } finally {
    clearTimeout(timer);
  }
}

/** Narrows a run to some of the harnesses `options.harness` selected (used to probe only what a selection needs). */
type HarnessFilter = (harnessId: string) => boolean;

async function discoverFiltered(
  config: DiscoveryConfig, options: DiscoverModelsOptions, deps: DiscoveryDeps, filter?: HarnessFilter,
): Promise<HarnessDiscoveryResult[]> {
  return withRunContext(config, options, deps, (ctx, selected) =>
    Promise.all(selected.filter(([id]) => filter?.(id) ?? true).map(([id, harness]) => discoverOne(ctx, id, harness))));
}

/** Layer 1 (always) plus Layer 2 (`on_demand` only) for the selected harnesses; never writes anything. */
export async function discoverModels(
  config: DiscoveryConfig, options: DiscoverModelsOptions, deps: DiscoveryDeps = {},
): Promise<HarnessDiscoveryResult[]> {
  return discoverFiltered(config, options, deps);
}

/** Notes about models the candidate builder had to skip, appended to the diagnostics of the harness they came from. */
function skipNotes(result: HarnessDiscoveryResult, built: BuildCandidatesOutput): DiscoveryDiagnostic[] {
  const unroutable = built.unroutable[result.harness] ?? 0;
  const invalid = built.invalid[result.harness] ?? 0;
  return [
    ...(unroutable > 0 ? [{
      stage: "offline" as const, code: "scope_unknown" as const, message: `${unroutable} model(s) skipped: ${result.driver} needs a provider for each model.`,
    }] : []),
    ...(invalid > 0 ? [{
      stage: "offline" as const, code: "invalid_output" as const, message: `${invalid} model(s) skipped: no valid model entry can be built for them.`,
    }] : []),
  ];
}

async function previewFiltered(
  config: DiscoveryConfig, options: DiscoverModelsOptions, deps: DiscoveryDeps, filter?: HarnessFilter,
): Promise<DiscoveryPreviewResult> {
  const now = deps.now ?? (() => new Date());
  const harnesses = await discoverFiltered(config, options, deps, filter);
  const built = buildCandidates({ config, results: harnesses, providers: options.providers, now: now() });
  const withNotes = harnesses.map((result) => {
    const notes = skipNotes(result, built);
    return notes.length === 0 ? result : { ...result, diagnostics: [...result.diagnostics, ...notes] };
  });
  return {
    revision: config.revision, mode: options.mode, providers: options.providers, harnesses: withNotes,
    candidates: built.candidates, total_candidates: built.total, truncated: built.truncated,
  };
}

/** Read-only preview: observations, enrichment, and the exact candidates a later `apply` can select by key. */
export async function previewDiscovery(
  config: DiscoveryConfig, options: DiscoverModelsOptions, deps: DiscoveryDeps = {},
): Promise<DiscoveryPreviewResult> {
  return previewFiltered(config, options, deps);
}

export interface ApplyDiscoverySelection {
  /** Candidate keys from a preview with the same options. */
  select?: readonly string[];
  /** Every new importable candidate, capped at MAX_APPLY_BATCH per call. */
  allNew?: boolean;
  /** Config revision the preview was made at. */
  revision?: string;
}

export interface ApplyDiscoveryResult extends ImportModelsResult {
  /** Importable new candidates left over because of the per-batch cap (counted among the previewed candidates). */
  remaining_new: number;
  /** The preview itself was cut at its cap, so more new models than `remaining_new` may exist. */
  more_may_exist: boolean;
}

/** Two selected imports with the same ID would silently overwrite each other; refuse the selection instead. */
function assertDistinctProposedIds(chosen: readonly DiscoveryCandidate[]): void {
  const owners = new Map<string, DiscoveryCandidate>();
  for (const candidate of chosen) {
    if (candidate.action !== "import") continue;
    const id = candidate.proposed_id.toLowerCase();
    const other = owners.get(id);
    if (other !== undefined) {
      throw new Error(`Candidates ${other.key} and ${candidate.key} both propose the model ID ${JSON.stringify(candidate.proposed_id)}. Apply them in separate calls.`);
    }
    owners.set(id, candidate);
  }
}

/**
 * Recomputes the candidates from the current config and applies the selection atomically. A key that no longer exists
 * (stale preview) or a revision mismatch rejects the whole call before anything is written.
 */
export async function applyDiscovery(
  manager: ConfigManager, writer: ConfigWriter, options: DiscoverModelsOptions, selection: ApplyDiscoverySelection, deps: DiscoveryDeps = {},
): Promise<ApplyDiscoveryResult> {
  const snapshot = manager.reloadIfChanged();
  if (selection.revision !== undefined && selection.revision !== snapshot.revision) {
    throw new ConfigRevisionConflictError(selection.revision, snapshot.revision);
  }
  const select = [...new Set(selection.select ?? [])];
  if (select.length === 0 && selection.allNew !== true) throw new Error("Nothing selected: pass --select <key> or --all-new.");
  if (select.length > 0 && selection.allNew === true) throw new Error("Use either --select or --all-new, not both.");
  if (select.length > MAX_APPLY_BATCH) throw new Error(`At most ${MAX_APPLY_BATCH} models can be applied per call (got ${select.length}).`);

  // A key starts with its harness's tag, so a selection re-probes only the harnesses it names (`--all-new` needs them all).
  const wantedTags = selection.allNew === true ? undefined : new Set(select.map((key) => key.slice(0, KEY_TAG_LENGTH)));
  const preview = await previewFiltered(snapshot, options, deps, wantedTags === undefined ? undefined : (id) => wantedTags.has(harnessKeyTag(id)));
  const byKey = new Map(preview.candidates.map((candidate) => [candidate.key, candidate]));
  const chosen: DiscoveryCandidate[] = [];
  let remaining = 0;
  if (selection.allNew === true) {
    // Harnesses propose IDs independently, so two of them can propose the same one; the first (in preview order) takes it and
    // the other waits for the next run, whose preview sees the taken ID and proposes a different one.
    const takenIds = new Set<string>();
    for (const candidate of preview.candidates.filter((entry) => entry.action === "import")) {
      const id = candidate.proposed_id.toLowerCase();
      if (chosen.length >= MAX_APPLY_BATCH || takenIds.has(id)) {
        remaining += 1;
        continue;
      }
      takenIds.add(id);
      chosen.push(candidate);
    }
  } else {
    const missing = select.filter((key) => !byKey.has(key));
    if (missing.length > 0) {
      throw new Error(`Selection is stale or unknown (${missing.join(", ")}). Run \`models discover\` again and use the new keys.`);
    }
    for (const key of select) {
      const candidate = byKey.get(key) as DiscoveryCandidate;
      if (candidate.action === "none") {
        throw new Error(`Candidate ${key} (${candidate.status}) has nothing to apply.`);
      }
      chosen.push(candidate);
    }
    assertDistinctProposedIds(chosen);
  }
  if (chosen.length === 0) throw new Error("No importable models were found for this selection.");

  const create: NonNullable<ImportModelBatch["create"]> = {};
  const enable: string[] = [];
  for (const candidate of chosen) {
    if (candidate.action === "import" && candidate.proposed_model !== undefined) create[candidate.proposed_id] = candidate.proposed_model;
    else if (candidate.action === "enable" && candidate.existing_model_id !== undefined) enable.push(candidate.existing_model_id);
  }
  const result = await writer.importModels({ create, enable }, selection.revision ?? snapshot.revision);
  return { ...result, remaining_new: remaining, more_may_exist: preview.truncated };
}

export interface DiscoveryHints {
  mode: "offline";
  /** Models found locally that have no card yet. */
  unconfigured_models: number;
  /** Models found locally whose card exists but is disabled. */
  disabled_models: number;
  harnesses: Array<{ harness: string; new_models: number; disabled_models: number }>;
  /** Present (true) when the time budget or the per-harness cap cut the count short, so the numbers are lower bounds. */
  truncated?: boolean;
}

/** The hint counter looks at the deadline once per this many observations: a clock read per model would dominate the loop. */
const HINT_DEADLINE_CHECK_INTERVAL = 128;

interface ConfiguredRoutes {
  enabled: Set<string>;
  /** Route key -> how many disabled cards use it (two or more make the match ambiguous, which is not a hint). */
  disabled: Map<string, number>;
}

function configuredRoutesByHarness(config: DiscoveryConfig, deadlineAt: number | undefined): { routes: Map<string, ConfiguredRoutes>; complete: boolean } {
  const routes = new Map<string, ConfiguredRoutes>();
  let visited = 0;
  for (const model of Object.values(config.models)) {
    if (++visited % HINT_DEADLINE_CHECK_INTERVAL === 0 && deadlineAt !== undefined && performance.now() >= deadlineAt) return { routes, complete: false };
    if (!Object.hasOwn(config.harnesses, model.harness)) continue;
    const harness = config.harnesses[model.harness];
    const key = routeKey(normalizeRoute(harness.driver, harness, model));
    const entry = routes.get(model.harness) ?? { enabled: new Set<string>(), disabled: new Map<string, number>() };
    if (model.enabled) entry.enabled.add(key);
    else entry.disabled.set(key, (entry.disabled.get(key) ?? 0) + 1);
    routes.set(model.harness, entry);
  }
  return { routes, complete: true };
}

interface HintCounter {
  configured: Map<string, ConfiguredRoutes>;
  deadlineAt: number | undefined;
  /** Observations looked at so far across all harnesses; the clock is read once per HINT_DEADLINE_CHECK_INTERVAL of them. */
  visited: number;
  truncated: boolean;
  harnesses: DiscoveryHints["harnesses"];
}

/**
 * Counts the new and disabled-in-catalog models of ONE harness without building candidates: no merge, no sort, no ID
 * allocation. At most MAX_MODELS_PER_SOURCE observations are looked at, and counting stops at the absolute deadline.
 */
function countHarnessHints(counter: HintCounter, id: string, harness: HarnessConfig, observation: HarnessObservation): void {
  const known = counter.configured.get(id);
  const counted = new Set<string>();
  const counts = { new_models: 0, disabled_models: 0 };
  const capped = observation.observed.length > MAX_MODELS_PER_SOURCE ? observation.observed.slice(0, MAX_MODELS_PER_SOURCE) : observation.observed;
  counter.truncated = counter.truncated || observation.truncated || capped.length < observation.observed.length;
  for (const model of capped) {
    if (++counter.visited % HINT_DEADLINE_CHECK_INTERVAL === 0 && counter.deadlineAt !== undefined && performance.now() >= counter.deadlineAt) {
      counter.truncated = true;
      break;
    }
    if (model.availability === "unconnected" || model.cli_model.trim() === "") continue;
    const route = normalizeRoute(harness.driver, harness, model);
    if (DRIVER_METADATA[harness.driver].requiresProviderPrefix === true && route.provider === undefined) continue;
    const key = routeKey(route);
    if (counted.has(key) || known?.enabled.has(key)) continue;
    counted.add(key);
    const disabledCards = known?.disabled.get(key) ?? 0;
    if (disabledCards === 0) counts.new_models += 1;
    else if (disabledCards === 1) counts.disabled_models += 1;
  }
  if (counts.new_models > 0 || counts.disabled_models > 0) counter.harnesses.push({ harness: id, ...counts });
}

/**
 * Compact offline-only summary for `agrmcp doctor`: zero subprocesses, zero network, and one hard time budget
 * (OFFLINE_HINT_DEADLINE_MS) that covers reading the local files AND counting what they reported. Each harness is counted
 * the moment its own read finishes, so one slow reader cannot cost the numbers of the harnesses that were quick.
 */
export async function offlineDiscoveryHints(
  config: DiscoveryConfig, environment: Partial<DiscoveryEnvironment> & { signal?: AbortSignal } = {}, deps: DiscoveryDeps = {},
): Promise<DiscoveryHints> {
  const options: DiscoverModelsOptions = { mode: "offline", providers: "configured", offlineDeadlineMs: OFFLINE_HINT_DEADLINE_MS, ...environment };
  const harnesses: DiscoveryHints["harnesses"] = [];
  let truncated = false;
  await withRunContext(config, options, deps, async (ctx, selected) => {
    // The readers and the counter run against the same absolute deadline, taken once when the run context was built.
    const deadlineAt = ctx.offlineDeadlineAtMs;
    const configured = configuredRoutesByHarness(config, deadlineAt);
    const counter: HintCounter = { configured: configured.routes, deadlineAt, visited: 0, truncated: !configured.complete, harnesses };
    await Promise.all(selected.map(async ([id, harness]) => {
      countHarnessHints(counter, id, harness, await observeHarness(ctx, id, harness));
    }));
    truncated = counter.truncated;
  });
  harnesses.sort((a, b) => compareText(a.harness, b.harness));
  return {
    mode: "offline",
    unconfigured_models: harnesses.reduce((sum, entry) => sum + entry.new_models, 0),
    disabled_models: harnesses.reduce((sum, entry) => sum + entry.disabled_models, 0),
    harnesses,
    ...(truncated ? { truncated: true } : {}),
  };
}
