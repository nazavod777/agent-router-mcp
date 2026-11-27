/**
 * Merge, match, enrich, and ID allocation for discovered models (NEW in Wave 2). Pure: no I/O, no clock reads (`now` is injected).
 *
 * Pipeline per harness: merge observations by normalized route -> Stage 1 match configured models (enabled or disabled)
 * -> Stage 2 exact built-in template -> Stage 3 honest baseline. IDs are allocated last, in a deterministic order.
 */
import { createHash } from "node:crypto";
import { entityIdProblem, ENTITY_ID_MAX_LENGTH } from "../config/ids.js";
import type { ConfigSnapshot, ResolvedModel } from "../config/resolver.js";
import { ModelSchema, type ModelPatch } from "../config/schema.js";
import { DRIVER_METADATA, type DriverKind } from "../drivers.js";
import { UNKNOWN_VENDOR, inferVendorFamily, isAggregatorProvider } from "../roles/registry.js";
import { createDiscoveryScrubber, scrubDiscoveredModel } from "./sanitize.js";
import {
  MAX_PREVIEW_CANDIDATES,
  type DiscoveredModel,
  type DiscoveryCandidate,
  type HarnessDiscoveryResult,
} from "./types.js";

/** The slice of the config snapshot enrichment needs. */
export type EnrichConfig = Pick<ConfigSnapshot, "harnesses" | "models" | "aliases"> & Partial<Pick<ConfigSnapshot, "quarantined">>;

/** The driver-normalized upstream route of a model: what the CLI is actually asked to run. */
export interface ModelRoute {
  provider?: string;
  model: string;
}

const DEFAULT_DSH_PROVIDER = "deepseek-official";
const AUTO_DISCOVERED_NOTE = "Unverified (auto-discovered)";
const AVAILABILITY_RANK: Record<DiscoveredModel["availability"], number> = {
  reported_available: 3, configured: 2, unknown: 1, unconnected: 0,
};
const ID_HASH_LENGTH = 8;
/**
 * A candidate key is `<harness tag><content hash>`: the tag lets `applyDiscovery` find which harnesses a selection needs
 * without probing every one of them, and the whole key stays 16 hex characters.
 */
export const KEY_TAG_LENGTH = 4;
const KEY_HASH_LENGTH = 16;
/** Mirrors `vendor_family: z.string().max(64)` of the model schema; a longer inferred value is not a vendor, it is a route. */
const MAX_VENDOR_FAMILY_LENGTH = 64;
const TEMPLATE_QUALITY_SOURCE = "default";
/** What a person can act on comes first, so the preview cap can never push a new model behind configured ones. */
const STATUS_PRIORITY: Record<DiscoveryCandidate["status"], number> = {
  new: 0, disabled_in_catalog: 1, ambiguous: 2, already_configured: 3,
};

type ConfigHarness = EnrichConfig["harnesses"][string];

/**
 * Locale-independent ordering (UTF-16 code units): the same ids sort the same on every machine, so keys, proposed IDs, and
 * the preview order never depend on `LANG`.
 */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Normalizes `(harness, cli_model, cli_provider)` the way each driver builds its invocation: `pi` and `opencode` fold
 * `provider/model` and split at the first slash, `dsh` fills the default provider, drivers without provider support
 * route by model alone.
 */
export function normalizeRoute(
  driver: DriverKind, harness: Pick<ConfigHarness, "default_upstream_provider">, model: { cli_model: string; cli_provider?: string },
): ModelRoute {
  const cliModel = model.cli_model.trim();
  const cliProvider = clean(model.cli_provider);
  const capabilities = DRIVER_METADATA[driver];
  if (driver === "pi" || driver === "opencode") {
    const joined = cliProvider === undefined ? cliModel : `${cliProvider}/${cliModel}`;
    const slash = joined.indexOf("/");
    if (slash > 0 && slash < joined.length - 1) return { provider: joined.slice(0, slash), model: joined.slice(slash + 1) };
    return driver === "pi" && clean(harness.default_upstream_provider) !== undefined
      ? { provider: clean(harness.default_upstream_provider), model: joined }
      : { model: joined };
  }
  if (driver === "dsh") {
    return { provider: cliProvider ?? clean(harness.default_upstream_provider) ?? DEFAULT_DSH_PROVIDER, model: cliModel };
  }
  return capabilities.usesCliProvider && cliProvider !== undefined ? { provider: cliProvider, model: cliModel } : { model: cliModel };
}

export function routeKey(route: ModelRoute): string {
  return `${route.provider ?? ""}\u0000${route.model}`;
}

/** The route a discovered model would be stored under in the config (provider kept only where the driver reads it). */
function storedRoute(driver: DriverKind, route: ModelRoute): ModelRoute {
  return DRIVER_METADATA[driver].usesCliProvider && route.provider !== undefined ? route : { model: route.model };
}

// ---------------------------------------------------------------------------
// Merge and deduplicate
// ---------------------------------------------------------------------------

function preferExact(models: readonly DiscoveredModel[]): Pick<DiscoveredModel, "context_window" | "context_precision"> {
  const withContext = models.filter((model) => model.context_window !== undefined);
  const best = withContext.find((model) => model.context_precision === "exact") ?? withContext[0];
  return best === undefined ? {} : {
    context_window: best.context_window,
    ...(best.context_precision !== undefined ? { context_precision: best.context_precision } : {}),
  };
}

/**
 * Merges Layer 1 and Layer 2 observations of one harness per normalized route: exact structured metadata beats a rounded
 * listing value, while `reported_available` from a CLI listing is kept as the availability.
 */
export function mergeDiscoveredModels(
  driver: DriverKind, harness: Pick<ConfigHarness, "default_upstream_provider">, models: readonly DiscoveredModel[],
): DiscoveredModel[] {
  const groups = new Map<string, DiscoveredModel[]>();
  for (const model of models) {
    if (!clean(model.cli_model)) continue;
    const key = routeKey(normalizeRoute(driver, harness, model));
    groups.set(key, [...(groups.get(key) ?? []), model]);
  }
  return [...groups.values()].map((group) => {
    const route = storedRoute(driver, normalizeRoute(driver, harness, group[0]));
    const winner = group.reduce((best, model) => AVAILABILITY_RANK[model.availability] > AVAILABILITY_RANK[best.availability] ? model : best);
    const displayName = group.map((model) => clean(model.display_name)).find((name) => name !== undefined);
    const reasoning = group.find((model) => model.reasoning !== undefined)?.reasoning;
    const efforts = group.find((model) => model.native_efforts !== undefined && model.native_efforts.length > 0)?.native_efforts;
    return {
      cli_model: route.model,
      ...(route.provider !== undefined ? { cli_provider: route.provider } : {}),
      ...(displayName !== undefined ? { display_name: displayName } : {}),
      ...preferExact(group),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(efforts !== undefined ? { native_efforts: [...efforts] } : {}),
      availability: winner.availability,
      evidence: winner.evidence,
    };
  }).sort((a, b) => compareText(routeKey({ provider: a.cli_provider, model: a.cli_model }), routeKey({ provider: b.cli_provider, model: b.cli_model })));
}

// ---------------------------------------------------------------------------
// Stage 1: configured models; Stage 2: built-in template; Stage 3: baseline
// ---------------------------------------------------------------------------

interface ConfiguredModel { id: string; model: ResolvedModel; route: ModelRoute }

function routesOf(config: EnrichConfig): Map<string, ConfiguredModel[]> {
  const byHarness = new Map<string, ConfiguredModel[]>();
  for (const [id, model] of Object.entries(config.models)) {
    const harness = Object.hasOwn(config.harnesses, model.harness) ? config.harnesses[model.harness] : undefined;
    if (!harness) continue;
    const route = normalizeRoute(harness.driver, harness, model);
    byHarness.set(model.harness, [...(byHarness.get(model.harness) ?? []), { id, model, route }]);
  }
  for (const list of byHarness.values()) list.sort((a, b) => compareText(a.id, b.id));
  return byHarness;
}

interface Template { id: string; model: ResolvedModel; driver: DriverKind; route: ModelRoute }

/** Unmodified built-in cards only: user-created and user-overridden cards are never used as templates. */
function builtInTemplates(config: EnrichConfig): Template[] {
  return Object.entries(config.models).flatMap(([id, model]) => {
    const harness = Object.hasOwn(config.harnesses, model.harness) ? config.harnesses[model.harness] : undefined;
    if (!harness || model.provenance !== TEMPLATE_QUALITY_SOURCE || model.enabled === false) return [];
    return [{ id, model, driver: harness.driver, route: normalizeRoute(harness.driver, harness, model) }];
  }).sort((a, b) => compareText(a.id, b.id));
}

interface TemplateMatch { template: Template; costComparable: boolean }

/** Exact upstream model match, never fuzzy: same driver and provider first, then same driver, then a unique upstream match. */
function matchTemplate(templates: readonly Template[], driver: DriverKind, route: ModelRoute): TemplateMatch | undefined {
  const sameModel = templates.filter((template) => template.route.model === route.model);
  const tiers: Array<{ pool: Template[]; costComparable: boolean }> = [
    { pool: sameModel.filter((t) => t.driver === driver && (t.route.provider ?? "") === (route.provider ?? "")), costComparable: true },
    { pool: sameModel.filter((t) => t.driver === driver), costComparable: false },
    { pool: sameModel, costComparable: false },
  ];
  for (const { pool, costComparable } of tiers) {
    if (pool.length === 0) continue;
    // Several equally good templates mean the match is a guess, so fall back to the honest baseline.
    return pool.length === 1 ? { template: pool[0], costComparable } : undefined;
  }
  return undefined;
}

function effortsFor(driver: DriverKind, discovered: DiscoveredModel, preferred?: readonly string[]): string[] {
  const metadata = DRIVER_METADATA[driver];
  const defaults = [...metadata.defaultEfforts];
  if (metadata.effortSupport === "none" || discovered.reasoning === false) return ["default"];
  if (preferred === undefined) return defaults;
  const allowed = new Set([...defaults, ...(discovered.native_efforts ?? [])]);
  const common = preferred.filter((effort) => allowed.has(effort));
  return common.length > 0 ? common : defaults;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase()
    .replace(/[^a-z0-9._:/@-]+/g, "-")
    .replace(/\.{2,}/g, ".").replace(/\/{2,}/g, "/").replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "").replace(/[/.:@_-]+$/, "");
  return slug.slice(0, ENTITY_ID_MAX_LENGTH).replace(/[/.:@_-]+$/, "");
}

function shortHash(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function withinIdLimit(base: string, suffix: string): string {
  return `${base.slice(0, Math.max(1, ENTITY_ID_MAX_LENGTH - suffix.length)).replace(/[/.:@_-]+$/, "")}${suffix}`;
}

/** Reserves IDs case-insensitively so two IDs that differ only by case can never be proposed together. */
class IdAllocator {
  private readonly taken = new Set<string>();

  constructor(existing: Iterable<string>, private readonly scrub: (text: string) => string) {
    for (const id of existing) this.taken.add(id.toLowerCase());
  }

  allocate(harness: string, route: ModelRoute): string {
    const slug = slugify(route.model) || "model";
    const qualified = slugify(`${harness}-${route.model}`) || harness;
    const fullKey = `${harness}\u0000${routeKey(route)}`;
    const attempts = [
      slug,
      withinIdLimit(slugify(`${harness}-${route.model}`), ""),
      ...[0, 1, 2, 3].map((round) => withinIdLimit(qualified, `-${shortHash(`${fullKey}\u0000${round}`, ID_HASH_LENGTH)}`)),
    ];
    for (const attempt of attempts) {
      const key = attempt.toLowerCase();
      // An ID that scrubbing would change contains a secret shape and is never proposed.
      if (entityIdProblem(attempt) !== undefined || this.taken.has(key) || this.scrub(attempt) !== attempt) continue;
      this.taken.add(key);
      return attempt;
    }
    // Practically unreachable: four independent hash suffixes all collided.
    const fallback = `model-${shortHash(fullKey, ID_HASH_LENGTH * 2)}`;
    this.taken.add(fallback.toLowerCase());
    return fallback;
  }
}

function inferredVendor(harnessId: string, driver: DriverKind, route: ModelRoute): string | undefined {
  const vendor = inferVendorFamily({ harness: harnessId, cli_model: route.model, ...(route.provider !== undefined ? { cli_provider: route.provider } : {}) }, driver);
  // Without a known vendor the inference falls back to the provider key, which can be any length: such a value is dropped.
  const unhelpful = vendor === UNKNOWN_VENDOR || isAggregatorProvider(vendor) || vendor === harnessId.toLowerCase() || vendor === driver
    || vendor.length > MAX_VENDOR_FAMILY_LENGTH;
  return unhelpful ? undefined : vendor;
}

/** True when the proposed card would be accepted as a stored model; the same schema the config loader applies. */
function isValidCard(card: ModelPatch): boolean {
  return ModelSchema.safeParse({ ...card, custom: true }).success;
}

interface ProposedCard { model: ModelPatch; quality: "template" | "baseline"; templateId?: string }

function proposeCard(
  harnessId: string, driver: DriverKind, discovered: DiscoveredModel, route: ModelRoute, templates: readonly Template[], now: Date,
): ProposedCard {
  const match = matchTemplate(templates, driver, route);
  const stored = storedRoute(driver, route);
  const baselineVendor = inferredVendor(harnessId, driver, route);
  const efforts = effortsFor(driver, discovered, match?.template.model.efforts);
  const defaultEffort = match !== undefined && efforts.includes(match.template.model.default_effort) ? match.template.model.default_effort : efforts[0];
  const vendor = match?.template.model.vendor_family ?? baselineVendor;
  const quality = match === undefined ? "baseline" : "template";
  const model: ModelPatch = {
    harness: harnessId,
    cli_model: stored.model,
    ...(stored.provider !== undefined ? { cli_provider: stored.provider } : {}),
    ...(vendor !== undefined ? { vendor_family: vendor } : {}),
    display_name: clean(discovered.display_name) ?? stored.model,
    tier: match?.template.model.tier ?? "standard",
    efforts,
    default_effort: defaultEffort,
    cost_tier: match !== undefined && match.costComparable ? match.template.model.cost_tier : "medium",
    cost_note: AUTO_DISCOVERED_NOTE,
    speed_note: AUTO_DISCOVERED_NOTE,
    ...(discovered.context_window !== undefined ? { context_window: discovered.context_window } : {}),
    strengths: [`Auto-discovered from ${harnessId} CLI`],
    weaknesses: [],
    best_for: [],
    avoid_for: [],
    source: "discovered",
    metadata_quality: quality,
    discovered_at: now.toISOString(),
    ...(match !== undefined ? { template_id: match.template.id } : {}),
    enabled: true,
  };
  return { model, quality, ...(match !== undefined ? { templateId: match.template.id } : {}) };
}

function existingQuality(model: ResolvedModel): DiscoveryCandidate["metadata_quality"] {
  return model.metadata_quality === "template" || model.metadata_quality === "baseline" ? model.metadata_quality : "curated";
}

/** The leading part of every key of one harness (see KEY_TAG_LENGTH). */
export function harnessKeyTag(harness: string): string {
  return shortHash(`harness\u0000${harness}`, KEY_TAG_LENGTH);
}

/** The fields that make two candidates materially different; the observation time is deliberately absent. */
function candidateKey(candidate: Omit<DiscoveryCandidate, "key">, route: ModelRoute): string {
  const model = candidate.proposed_model;
  const material = model === undefined ? null : {
    display_name: model.display_name, tier: model.tier, efforts: model.efforts, default_effort: model.default_effort,
    cost_tier: model.cost_tier, vendor_family: model.vendor_family ?? null, context_window: model.context_window ?? null,
    template_id: model.template_id ?? null,
  };
  const content = JSON.stringify([
    candidate.action, candidate.harness, route.provider ?? null, route.model, candidate.proposed_id, candidate.status,
    candidate.existing_model_id ?? null, candidate.metadata_quality, material,
  ]);
  return `${harnessKeyTag(candidate.harness)}${shortHash(content, KEY_HASH_LENGTH - KEY_TAG_LENGTH)}`;
}

export interface BuildCandidatesInput {
  config: EnrichConfig;
  results: readonly HarnessDiscoveryResult[];
  providers: "configured" | "all";
  now: Date;
}

export interface BuildCandidatesOutput {
  candidates: DiscoveryCandidate[];
  /** Candidates before the preview cap. */
  total: number;
  truncated: boolean;
  /** Models skipped because the driver cannot route them (for example an OpenCode model without a provider), per harness. */
  unroutable: Record<string, number>;
  /** Models skipped because the card proposed for them would not be a valid model entry, per harness. */
  invalid: Record<string, number>;
}

function requiresProvider(driver: DriverKind, route: ModelRoute): boolean {
  return DRIVER_METADATA[driver].requiresProviderPrefix === true && route.provider === undefined;
}

/**
 * Runs the 3-stage pipeline over every harness result and returns candidates in a deterministic order. Each harness is
 * independent: its proposed IDs and keys depend on the config and on its own models only, never on what another harness
 * reported (or failed to report) in the same run.
 */
export function buildCandidates(input: BuildCandidatesInput): BuildCandidatesOutput {
  const { config } = input;
  const configured = routesOf(config);
  const templates = builtInTemplates(config);
  // A quarantined entity is absent from `config.models` but still occupies its ID in the user's file.
  const quarantinedIds = (config.quarantined ?? []).filter((entry) => entry.section === "models" || entry.section === "aliases").map((entry) => entry.id);
  const scrub = createDiscoveryScrubber();
  const takenIds = [...Object.keys(config.models), ...Object.keys(config.aliases), ...quarantinedIds];
  const unroutable: Record<string, number> = {};
  const invalid: Record<string, number> = {};
  const candidates: DiscoveryCandidate[] = [];

  const results = [...input.results].sort((a, b) => compareText(a.harness, b.harness));
  for (const result of results) {
    if (!Object.hasOwn(config.harnesses, result.harness)) continue;
    const harness = config.harnesses[result.harness];
    const allocator = new IdAllocator(takenIds, scrub);
    const existing = configured.get(result.harness) ?? [];
    const merged = mergeDiscoveredModels(result.driver, harness, result.models.map((model) => scrubDiscoveredModel(model, scrub)).filter((model) => model !== undefined))
      .filter((model) => input.providers === "all" || model.availability !== "unconnected");
    for (const discovered of merged) {
      const route = normalizeRoute(result.driver, harness, discovered);
      if (requiresProvider(result.driver, route)) {
        unroutable[result.harness] = (unroutable[result.harness] ?? 0) + 1;
        continue;
      }
      const key = routeKey(route);
      const matches = existing.filter((entry) => routeKey(entry.route) === key);
      const enabled = matches.filter((entry) => entry.model.enabled);
      const base = { harness: result.harness, driver: result.driver, discovered };

      if (enabled.length > 0) {
        const match = enabled[0];
        const draft = { ...base, status: "already_configured" as const, action: "none" as const, existing_model_id: match.id,
          proposed_id: match.id, metadata_quality: existingQuality(match.model),
          ...(match.model.template_id !== undefined ? { template_id: scrub(match.model.template_id) } : {}) };
        candidates.push({ key: candidateKey(draft, route), ...draft });
      } else if (matches.length === 1) {
        const match = matches[0];
        const draft = { ...base, status: "disabled_in_catalog" as const, action: "enable" as const, existing_model_id: match.id,
          proposed_id: match.id, metadata_quality: existingQuality(match.model),
          ...(match.model.template_id !== undefined ? { template_id: scrub(match.model.template_id) } : {}) };
        candidates.push({ key: candidateKey(draft, route), ...draft });
      } else if (matches.length > 1) {
        const draft = { ...base, status: "ambiguous" as const, action: "none" as const, proposed_id: allocator.allocate(result.harness, route),
          metadata_quality: "baseline" as const };
        candidates.push({ key: candidateKey(draft, route), ...draft });
      } else {
        const card = proposeCard(result.harness, result.driver, discovered, route, templates, input.now);
        if (!isValidCard(card.model)) {
          // One unusable card must never abort a whole `--all-new` batch; it also takes no ID, so no other candidate shifts.
          invalid[result.harness] = (invalid[result.harness] ?? 0) + 1;
          continue;
        }
        const draft = { ...base, status: "new" as const, action: "import" as const, proposed_id: allocator.allocate(result.harness, route),
          proposed_model: card.model, metadata_quality: card.quality, ...(card.templateId !== undefined ? { template_id: scrub(card.templateId) } : {}) };
        candidates.push({ key: candidateKey(draft, route), ...draft });
      }
    }
  }

  // Actionable first, then the order built above (harness, then route): Array.prototype.sort is stable, so it stays deterministic.
  candidates.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
  const total = candidates.length;
  return {
    candidates: total > MAX_PREVIEW_CANDIDATES ? candidates.slice(0, MAX_PREVIEW_CANDIDATES) : candidates,
    total,
    truncated: total > MAX_PREVIEW_CANDIDATES,
    unroutable,
    invalid,
  };
}
