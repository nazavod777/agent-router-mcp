import { randomUUID } from "node:crypto";
import { DRIVER_SECURITY_GUARANTEES } from "../adapters/registry.js";
import { effectivePiModelProvider } from "../adapters/pi.js";
import type { ConfigSnapshot, ResolvedHarness, ResolvedModel } from "../config/resolver.js";
import { resolveModelAlias } from "../config/resolver.js";
import { emptyCliLimits } from "../config/cli-limits.js";
import { resolveHarnessConcurrency } from "../runtime/concurrency.js";
import type { RuntimeDegradation } from "../runtime/runner.js";
import type { PresetRole } from "../config/schema.js";
import { DRIVER_METADATA } from "../drivers.js";
import { UNKNOWN_VENDOR, defaultModeForRole, getRoleDefinition, inferVendorFamily, isKnownVendor, keywordsForRole, preferredTierForRole,
  resolveRoleId } from "../roles/registry.js";
import type {
  ConcurrencyScope,
  CostTier,
  DriverKind,
  ErrorCode,
  FailureScope,
  HarnessConcurrencyInfo,
  HarnessHealth,
  IsolationMode,
  ModelTier,
  RunMode,
  SecurityGuarantee,
  StructuredError,
} from "../types.js";

export const DEFAULT_PRESET = "balanced";
const MAX_ALTERNATIVES = 2;
const NOTE_MAX_CHARS = 70;

export interface PlanSubtaskInput {
  id: string;
  title: string;
  task_type: string;
  mode?: RunMode;
  isolation?: IsolationMode;
  override?: { harness?: string; model?: string; effort?: string };
  /** Split this subtask into 2..8 independent shards (`<id>#1`..`<id>#N`); write shards always run in worktrees. */
  shards?: number;
}

export const MAX_SHARDS = 8;

/** A subtask after shard expansion. */
interface ExpandedSubtask extends Omit<PlanSubtaskInput, "shards"> {
  /** True when the requested shared isolation was replaced by a worktree. */
  isolationForced?: boolean;
}

export interface PlanAlternative {
  harness: string;
  model: string;
  effort: string;
  tier: ModelTier;
  cost_tier: CostTier;
  reason: string;
}

export type SelectionSource = "override" | "preset" | "catalog_match";

export interface PlanPreviewItem {
  index: number;
  id: string;
  title: string;
  task_type: string;
  harness: string;
  harness_display_name: string;
  driver: DriverKind;
  model: string;
  model_display_name: string;
  cli_model: string;
  effort: string;
  mode: RunMode;
  mode_source: "user" | "default";
  isolation: IsolationMode;
  recommended_isolation: IsolationMode;
  isolation_source: "user" | "recommended";
  tier: ModelTier;
  cost_tier: CostTier;
  cost_note: string;
  security_guarantee: SecurityGuarantee;
  selection_source: SelectionSource;
  harness_auth_status?: HarnessHealth["auth_status"];
  harness_installed?: boolean;
  is_stale: boolean;
  pros: string;
  risks: string;
  warnings: string[];
  alternatives: PlanAlternative[];
}

export interface PlanPreviewResult {
  plan_id: string;
  preset: string;
  preset_description: string;
  config_revision: string;
  created_at: string;
  parallel_write_detected: boolean;
  items: PlanPreviewItem[];
  /** Flattened per-item warnings ("#2: …") plus plan-level warnings. */
  warnings: string[];
  markdown_table: string;
  /** Echo of the explicit routing exclusions so a later reroute never re-suggests them. */
  exclude_harnesses?: string[];
  exclude_models?: string[];
  /** Harnesses/models named by explicit subtask overrides; they bypass the exclusions and must stay selectable after a timeout. */
  explicit_harnesses?: string[];
  explicit_models?: string[];
  /** "exhausted" means every enabled delegation model is blocked: stop main work and notify the user. */
  delegation_status: DelegationState;
  /** False when delegation is exhausted or any planned row cannot run; the plan is then diagnostic only and must not be run. */
  launchable: boolean;
  /** Effective planner intent: "design_consult" for an explicit or inferred consultation; kept so failover preserves its constraints. */
  intent?: PlanIntent;
  /** Normalized vendor family of the host agent; failover alternatives stay independent of it for a consultation. */
  host_vendor?: string;
  blocked_reason?: "DELEGATION_UNAVAILABLE";
  blocked_by_harness?: Record<string, DelegationBlockReason>;
  earliest_retry_at?: string;
  /** Parallelism limits and how many planned subtasks land on each harness. */
  concurrency: PlanConcurrencySummary;
  timeouts: PlanTimeoutSummary;
}

export interface PlanConcurrencySummary {
  /** Per-session cap (`max_concurrency`); the name is kept for compatibility with older callers. */
  global_max_concurrency: number;
  /** Same value under its accurate name. */
  session_max_concurrency: number;
  host_max_concurrency: number;
  concurrency_scope: ConcurrencyScope;
  /** Present when the caller supplied a working directory: the session the plan would run in. */
  session_id?: string;
  session_active?: number;
  host_active?: number;
  max_queue_size: number;
  per_harness: Record<string, HarnessConcurrencyInfo & { planned_subtasks: number; session_active?: number }>;
}

/** How long jobs may run and how the server extends or ends them; hosts should normally omit `timeout_sec`. */
export interface PlanTimeoutSummary {
  default_timeout_sec: number;
  high_effort_timeout_sec: number;
  max_timeout_sec: number;
  auto_extend_timeout: boolean;
  idle_timeout_sec: number;
  timeout_extension_sec: number;
  activity_window_sec: number;
}

/** Live counts of running jobs, used to show how much of the session and host budget is already taken. */
export interface PlanLiveConcurrency {
  session_id: string;
  session_active: number;
  host_active: number;
  harness_active?: Record<string, number>;
}

interface RoutingFilters {
  excludeHarnesses?: readonly string[];
  excludeModels?: readonly string[];
  runtimeDegradations?: readonly RuntimeDegradation[];
}

export interface BuildPlanPreviewInput extends RoutingFilters {
  locale?: "en" | "ru";
  config: ConfigSnapshot;
  healthByHarness?: Record<string, HarnessHealth>;
  subtasks: PlanSubtaskInput[];
  preset?: string;
  cwdDirty?: boolean;
  /** Effective parallel limits per harness; harnesses missing here use the defaults without CLI discovery. */
  concurrencyByHarness?: Record<string, HarnessConcurrencyInfo>;
  /** Running-job counts of the session this plan would run in; omitted when no working directory is known. */
  liveConcurrency?: PlanLiveConcurrency;
  /** Vendor family of the host agent (e.g. "anthropic", "openai"); unknown values never match a model vendor. */
  host_vendor?: string;
  /**
   * "design_consult" turns on the consultation-diversity check; an explicit "general" never does.
   * When omitted, a readonly architecture + second_opinion pair is treated as a consultation.
   */
  intent?: PlanIntent;
}

export type PlanIntent = "general" | "design_consult";

export class PlanPreviewError extends Error {
  readonly structured: StructuredError;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PlanPreviewError";
    this.structured = {
      code, message, retryable: false,
      ...(code === "DELEGATION_UNAVAILABLE" ? { failure_scope: "harness" as const, safe_to_reroute: false, delegation_state: "exhausted" as const } : {}),
      ...(details ? { details } : {}),
    };
  }
}

const COST_RANK: Record<CostTier, number> = { low: 0, medium: 1, high: 2, premium: 3 };
/** Tie-breaker that lets live-verified adapters win over experimental ones with equal fit. */
const VERIFIED_CONTRACT_BONUS = 3;

const en = {
  header: "| # | Subtask | Harness / Model | Effort | Mode | Isolation | Tier / Cost | Sandbox | Pros & Risks |",
  cheaper: "cheaper", moreExpensive: "more expensive", otherHarness: "different harness", tier: "tier", comparable: "comparable option",
  premium: "premium — expensive model",
  unsandboxed: "unsandboxed — write without OS sandbox",
  experimental: (driver: string) => `experimental — experimental adapter ${driver}, check the flags in your local CLI version`,
  stale: (date: string) => `stale — model card is outdated (checked_at ${date})`,
  missing: (id: string) => `harness ${id} is not installed`,
  unauthenticated: (id: string) => `harness ${id} is not authenticated`,
  shared: "parallel shared write — edit conflict risk, use worktree",
  dirty: "dirty git tree — uncommitted changes will not be copied to worktree",
  selfReview: (vendor: string) => `self-review — same vendor (${vendor}) as change author; pick another harness/vendor for independent review`,
  disabledModel: (role: string, preset: string, model: string) =>
    `Role ${role} in preset ${preset} points to disabled model ${model}. Using a catalog alternative.`,
  unsafeReadonly: (role: string, preset: string, model: string) =>
    `Role ${role} in preset ${preset} (${model}) cannot guarantee safe readonly execution. Using a safe alternative.`,
  unsafeWrite: (role: string, preset: string, model: string) =>
    `Role ${role} in preset ${preset} (${model}) is blocked by allow_unsandboxed_write = false. Using a safe alternative.`,
  missingPresetHarness: (id: string, preset: string) => `Harness ${id} from preset ${preset} is not installed. Using an available alternative.`,
  unauthenticatedPresetHarness: (id: string, preset: string) => `Harness ${id} from preset ${preset} is not authenticated. Using an available alternative.`,
  designConsultSameVendor: (vendor: string) =>
    `design consultation — all advisors resolve to one vendor (${vendor}); add a second vendor for an independent perspective`,
  designConsultHostVendor: (vendor: string) =>
    `design consultation — advisor is from the same vendor (${vendor}) as the host agent; use another vendor for an independent perspective`,
  designConsultNoAdvisors:
    "design consultation expects readonly advisory subtasks (for example architecture and second_opinion), but the plan has none",
  designConsultUnknownVendor:
    "design consultation — the advisor's vendor could not be determined, so its independence from the host and the other advisors is unverified; " +
    "set vendor_family on the model card or pick a model with a known vendor",
  selfReviewUnverified:
    "independence unverified — the vendor of the reviewer or of the change author could not be determined, so the review may not be independent; " +
    "set vendor_family on the model card or pick a model with a known vendor",
  recentFailure: (d: RuntimeDegradation, replaced: boolean) =>
    `${d.scope === "model" ? "Model " + d.model : "Harness " + d.harness} recently failed in this session (${d.code}: ${shortDiagnostic(d)}); ${replaced ? "routed to an available alternative." : "selected despite the recent failure."}`,
  sharedWrites: (ids: string) => `Subtasks ${ids} write in parallel in shared mode — this is prohibited, use isolation: "worktree".`,
  harnessQueue: (harness: string, planned: number, cap: number, queueDisabled: boolean) =>
    `${planned} subtasks target harness ${harness}, which runs at most ${cap} at a time; ` +
    (queueDisabled ? "the queue is disabled (max_queue_size = 0), so the rest will hit QUEUE_FULL." : "the rest will queue."),
  shardWorktree: 'write shards cannot share a checkout — isolation "shared" was replaced by "worktree"',
  delegationExhausted: (blocked: string) =>
    `DELEGATION_UNAVAILABLE — all enabled delegation models are unavailable (${blocked}). STOP all main work, do not run these subtasks yourself, and notify the user.`,
};

const ru: typeof en = {
  header: "| # | Подзадача | Харнесс / Модель | Effort | Режим | Изоляция | Тир / Цена | Песочница | Плюсы и риски |",
  cheaper: "дешевле", moreExpensive: "дороже", otherHarness: "другой харнесс", tier: "тир", comparable: "сопоставимый вариант",
  premium: "premium — дорогая модель",
  unsandboxed: "unsandboxed — запись без песочницы ОС",
  experimental: (driver) => `experimental — адаптер ${driver} экспериментальный, проверьте флаги на локальной версии CLI`,
  stale: (date) => `stale — карточка модели устарела (checked_at ${date})`,
  missing: (id) => `харнесс ${id} не установлен`,
  unauthenticated: (id) => `харнесс ${id} не авторизован`,
  shared: "параллельная запись в shared — конфликт правок, нужен worktree",
  dirty: "грязное git-дерево — незакоммиченные изменения не попадут в worktree",
  selfReview: (vendor) => `саморевью — тот же вендор (${vendor}), что и автор правки; выберите другой харнесс/вендор для независимой проверки`,
  disabledModel: (role, preset, model) =>
    `Роль ${role} пресета ${preset} указывает на отключённую модель ${model}; выбрана замена по каталогу.`,
  unsafeReadonly: (role, preset, model) =>
    `Роль ${role} пресета ${preset} (${model}) не гарантирует безопасный readonly; выбрана безопасная замена.`,
  unsafeWrite: (role, preset, model) =>
    `Роль ${role} пресета ${preset} (${model}) запрещена политикой allow_unsandboxed_write = false; выбрана безопасная замена.`,
  missingPresetHarness: (id, preset) => `Харнесс ${id} из пресета ${preset} не установлен; выбрана доступная замена.`,
  unauthenticatedPresetHarness: (id, preset) => `Харнесс ${id} из пресета ${preset} не авторизован; выбрана доступная замена.`,
  designConsultSameVendor: (vendor) =>
    `консультация по дизайну — все советники от одного вендора (${vendor}); добавьте второго вендора для независимого взгляда`,
  designConsultHostVendor: (vendor) =>
    `консультация по дизайну — советник от того же вендора (${vendor}), что и главный агент; возьмите другого вендора для независимого взгляда`,
  designConsultNoAdvisors:
    "консультация по дизайну ожидает readonly-советников (например architecture и second_opinion), но в плане их нет",
  designConsultUnknownVendor:
    "консультация по дизайну — вендор советника не удалось определить, поэтому его независимость от главного агента и других советников не подтверждена; " +
    "задайте vendor_family в карточке модели или выберите модель с известным вендором",
  selfReviewUnverified:
    "независимость не подтверждена — вендор ревьюера или автора правки не удалось определить, поэтому ревью может быть ненезависимым; " +
    "задайте vendor_family в карточке модели или выберите модель с известным вендором",
  recentFailure: (d, replaced) =>
    `${d.scope === "model" ? "Модель " + d.model + " недавно упала" : "Харнесс " + d.harness + " недавно упал"} в этой сессии (${d.code}: ${shortDiagnostic(d)}); ${replaced ? "выбрана доступная замена." : "этот вариант выбран несмотря на сбой."}`,
  sharedWrites: (ids) => `Подзадачи ${ids} пишут параллельно в shared — это запрещено, используйте isolation: "worktree".`,
  harnessQueue: (harness, planned, cap, queueDisabled) =>
    `${planned} подзадач идут на харнесс ${harness}, который выполняет не более ${cap} одновременно; ` +
    (queueDisabled ? "очередь отключена (max_queue_size = 0), поэтому остальные получат QUEUE_FULL." : "остальные встанут в очередь."),
  shardWorktree: 'write-шарды не могут делить одну рабочую копию — isolation "shared" заменён на "worktree"',
  delegationExhausted: (blocked) =>
    `DELEGATION_UNAVAILABLE — все включённые модели для делегирования недоступны (${blocked}). ОСТАНОВИТЕ всю основную работу, не выполняйте эти подзадачи сами и сообщите пользователю.`,
};

const messages = { en, ru };
const TABLE_DIVIDER = "|---|-----------|------------------|--------|-------|----------|------------|-----------|---------------|";

function countHits(notes: string[], keywords: RegExp[]): number {
  return notes.filter((note) => keywords.some((keyword) => keyword.test(note))).length;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

interface Candidate {
  modelId: string;
  model: ResolvedModel;
  harness: ResolvedHarness;
}

interface Selection extends Candidate {
  effort: string;
  source: SelectionSource;
  notes: string[];
}

function isUsable(config: ConfigSnapshot, modelId: string): Candidate | undefined {
  const model = Object.hasOwn(config.models, modelId) ? config.models[modelId] : undefined;
  if (!model?.enabled) return undefined;
  const harness = Object.hasOwn(config.harnesses, model.harness) ? config.harnesses[model.harness] : undefined;
  if (!harness?.enabled) return undefined;
  return { modelId, model, harness };
}

function shortDiagnostic(failure: RuntimeDegradation): string {
  return failure.raw_error.replace(/\s+/g, " ").slice(0, 120);
}

function activeFailure(candidate: Candidate, filters: RoutingFilters): RuntimeDegradation | undefined {
  return filters.runtimeDegradations?.find((entry) => Date.parse(entry.expires_at) > Date.now() &&
    entry.harness === candidate.model.harness && (entry.scope === "harness" || entry.model === candidate.modelId));
}

function excluded(candidate: Candidate, filters: RoutingFilters, explicitHarness?: string): boolean {
  return Boolean(filters.excludeModels?.includes(candidate.modelId) || (candidate.model.harness !== explicitHarness &&
    filters.excludeHarnesses?.includes(candidate.model.harness)));
}

/** Resolves aliases to canonical model IDs (deduplicated, order kept) so an excluded alias cannot slip past an ID comparison. */
function canonicalModelIds(config: ConfigSnapshot, ids: readonly string[] | undefined): string[] | undefined {
  return ids && [...new Set(ids.map((id) => aliasOrSelf(id, config.aliases, config.models)))];
}

function healthScore(health: HarnessHealth | undefined): number {
  if (!health) return 0;
  if (!health.installed) return -50;
  if (health.auth_status === "unauthenticated") return -40;
  return health.auth_status === "ready" ? 5 : 1;
}

/** Tie-breaker only: a reviewed or curated card beats an auto-generated baseline card when both fit equally well. */
const METADATA_QUALITY_PENALTY = { curated: 0, reviewed: 0, template: 1, baseline: 2 } as const;

function scoreCandidate(candidate: Candidate, keywords: RegExp[], preferredTier: ModelTier | undefined, health?: HarnessHealth, degraded = false): number {
  const fit = countHits(candidate.model.best_for, keywords) * 10 - countHits(candidate.model.avoid_for, keywords) * 15;
  const tierBonus = preferredTier === candidate.model.tier ? 4 : 0;
  const stalePenalty = candidate.model.is_stale ? -1 : 0;
  const qualityPenalty = METADATA_QUALITY_PENALTY[candidate.model.metadata_quality ?? "curated"];
  const contractBonus = DRIVER_METADATA[candidate.harness.driver]?.contract === "verified" ? VERIFIED_CONTRACT_BONUS : 0;
  // Lower cost breaks ties.
  return fit - (degraded ? 45 : 0) + tierBonus + stalePenalty - qualityPenalty + contractBonus + healthScore(health) - COST_RANK[candidate.model.cost_tier] * 0.5;
}

function isAllowedBySandboxPolicy(
  config: ConfigSnapshot,
  candidate: Candidate,
  mode: RunMode,
  health?: Record<string, HarnessHealth>,
): boolean {
  return isAllowedGuarantee(config, mode, securityGuaranteeFor(candidate.harness.driver, mode, health?.[candidate.model.harness]));
}

/** Readonly work always needs a real guarantee; unsandboxed writes depend on allow_unsandboxed_write. */
function isAllowedGuarantee(config: ConfigSnapshot, mode: RunMode, guarantee: SecurityGuarantee): boolean {
  if (mode === "readonly") return guarantee !== "unsandboxed";
  return config.defaults.allow_unsandboxed_write || guarantee !== "unsandboxed";
}

function sandboxViolationReason(mode: RunMode): string {
  return mode === "readonly"
    ? "cannot guarantee safe readonly execution"
    : "is unsandboxed in write mode and disabled by allow_unsandboxed_write = false";
}

function isInstalled(health: Record<string, HarnessHealth> | undefined, candidate: Candidate): boolean | undefined {
  return health?.[candidate.model.harness]?.installed;
}

/**
 * The harness health as it applies to one model. Pi authenticates per upstream provider and its probe checks only the
 * harness's default provider, so for a model routed to another provider that result (ready or not) says nothing: the
 * auth status becomes "unknown" instead of blocking or favouring a model whose own provider was never checked.
 */
function healthForCandidate(health: HarnessHealth | undefined, candidate: Candidate): HarnessHealth | undefined {
  if (!health || health.auth_status === "unknown") return health;
  const { driver, default_upstream_provider: checkedProvider } = candidate.harness;
  const modelProvider = driver === "pi" ? effectivePiModelProvider(candidate.model) : undefined;
  if (driver !== "pi" || modelProvider === undefined || modelProvider === checkedProvider) return health;
  return { ...health, auth_status: "unknown" };
}

function rankCandidates(
  config: ConfigSnapshot,
  taskType: string,
  mode: RunMode,
  health: Record<string, HarnessHealth> | undefined,
  filters: RoutingFilters,
  harnessFilter?: string,
): Candidate[] {
  const keywords = keywordsForRole(taskType);
  const preferredTier = preferredTierForRole(taskType);
  return Object.keys(config.models)
    .map((modelId) => isUsable(config, modelId))
    .filter((candidate): candidate is Candidate => Boolean(candidate))
    .filter((candidate) => !excluded(candidate, filters, harnessFilter))
    .filter((candidate) => !harnessFilter || candidate.model.harness === harnessFilter)
    .filter((candidate) => isAllowedBySandboxPolicy(config, candidate, mode, health))
    .map((candidate) => {
      const degraded = Boolean(activeFailure(candidate, filters));
      const probe = healthForCandidate(health?.[candidate.model.harness], candidate);
      const available = !health || Boolean(probe?.installed && probe.auth_status !== "unauthenticated");
      return { candidate, available, degraded, score: scoreCandidate(candidate, keywords, preferredTier, probe, degraded) };
    })
    .sort((a, b) => Number(b.available) - Number(a.available) || Number(a.degraded) - Number(b.degraded) ||
      b.score - a.score || a.candidate.modelId.localeCompare(b.candidate.modelId))
    .map(({ candidate }) => candidate);
}

function requireHarness(config: ConfigSnapshot, harnessId: string, subtaskId: string): ResolvedHarness {
  const harness = Object.hasOwn(config.harnesses, harnessId) ? config.harnesses[harnessId] : undefined;
  if (!harness) {
    throw new PlanPreviewError("HARNESS_UNAVAILABLE", `Subtask ${subtaskId}: unknown harness ${JSON.stringify(harnessId)}.`, {
      subtask_id: subtaskId,
      harness: harnessId,
      available_harnesses: Object.keys(config.harnesses),
    });
  }
  if (!harness.enabled) {
    throw new PlanPreviewError("HARNESS_UNAVAILABLE", `Subtask ${subtaskId}: harness ${JSON.stringify(harnessId)} is disabled.`, {
      subtask_id: subtaskId,
      harness: harnessId,
    });
  }
  return harness;
}

function requireModel(config: ConfigSnapshot, requested: string, subtaskId: string): Candidate {
  let modelId: string;
  try {
    modelId = resolveModelAlias(requested, config.aliases, config.models);
  } catch (error) {
    throw new PlanPreviewError("MODEL_UNSUPPORTED", `Subtask ${subtaskId}: ${(error as Error).message}.`, { subtask_id: subtaskId });
  }
  const model = Object.hasOwn(config.models, modelId) ? config.models[modelId] : undefined;
  if (!model) {
    throw new PlanPreviewError("MODEL_UNSUPPORTED", `Subtask ${subtaskId}: unknown model ${JSON.stringify(requested)}.`, {
      subtask_id: subtaskId,
      model: requested,
    });
  }
  if (!model.enabled) {
    throw new PlanPreviewError("MODEL_UNSUPPORTED", `Subtask ${subtaskId}: model ${JSON.stringify(modelId)} is disabled.`, {
      subtask_id: subtaskId,
      model: modelId,
    });
  }
  const harness = requireHarness(config, model.harness, subtaskId);
  return { modelId, model, harness };
}

function requireEffort(candidate: Candidate, effort: string, subtaskId: string): string {
  if (candidate.model.efforts.includes(effort)) return effort;
  throw new PlanPreviewError(
    "MODEL_UNSUPPORTED",
    `Subtask ${subtaskId}: effort ${JSON.stringify(effort)} is not supported by model ${JSON.stringify(candidate.modelId)} ` +
      `(supported: ${candidate.model.efforts.join(", ")}).`,
    { subtask_id: subtaskId, model: candidate.modelId, effort, supported_efforts: candidate.model.efforts },
  );
}

function selectModel(
  config: ConfigSnapshot,
  presetRoles: Record<string, PresetRole>,
  presetId: string,
  subtask: PlanSubtaskInput,
  mode: RunMode,
  health: Record<string, HarnessHealth> | undefined,
  text: typeof en,
  filters: RoutingFilters,
): Selection {
  const override = subtask.override ?? {};
  const notes: string[] = [];
  const roleId = Object.hasOwn(presetRoles, subtask.task_type) ? subtask.task_type : resolveRoleId(subtask.task_type);
  const role = Object.hasOwn(presetRoles, roleId) ? presetRoles[roleId] : undefined;
  const rawPresetCandidate = role ? isUsable(config, resolveModelAlias(role.model, config.aliases, config.models)) : undefined;
  const safePreset = rawPresetCandidate && isAllowedBySandboxPolicy(config, rawPresetCandidate, mode, health)
    ? rawPresetCandidate
    : undefined;
  const presetCandidate = safePreset && !excluded(safePreset, filters, override.harness) ? safePreset : undefined;
  if (role && !rawPresetCandidate) {
    notes.push(text.disabledModel(subtask.task_type, presetId, role.model));
  } else if (role && rawPresetCandidate && !safePreset) {
    const fallback = mode === "readonly" ? text.unsafeReadonly : text.unsafeWrite;
    notes.push(fallback(subtask.task_type, presetId, role.model));
  }

  let base: Candidate;
  let source: SelectionSource;
  if (override.model) {
    base = requireModel(config, override.model, subtask.id);
    if (override.harness && override.harness !== base.model.harness) {
      throw new PlanPreviewError(
        "MODEL_UNSUPPORTED",
        `Subtask ${subtask.id}: model ${JSON.stringify(base.modelId)} belongs to harness ${JSON.stringify(base.model.harness)}, ` +
          `not ${JSON.stringify(override.harness)}.`,
        { subtask_id: subtask.id, model: base.modelId, harness: override.harness },
      );
    }
    if (!isAllowedBySandboxPolicy(config, base, mode, health)) {
      const message = mode === "readonly"
        ? `Subtask ${subtask.id}: driver ${base.harness.driver} cannot guarantee safe readonly execution (${base.model.harness}/${base.modelId}).`
        : `Subtask ${subtask.id}: unsandboxed write operations are disabled by allow_unsandboxed_write = false (${base.model.harness}/${base.modelId}).`;
      throw new PlanPreviewError(
        "SANDBOX_POLICY_VIOLATION",
        message,
        { subtask_id: subtask.id, model: base.modelId, harness: base.model.harness, mode },
      );
    }
    source = "override";
  } else if (override.harness) {
    const harness = requireHarness(config, override.harness, subtask.id);
    if (!isAllowedGuarantee(config, mode, securityGuaranteeFor(harness.driver, mode, health?.[override.harness]))) {
      throw new PlanPreviewError(
        "SANDBOX_POLICY_VIOLATION",
        `Subtask ${subtask.id}: harness ${JSON.stringify(override.harness)} ${sandboxViolationReason(mode)}.`,
        { subtask_id: subtask.id, harness: override.harness, mode },
      );
    }
    if (presetCandidate && presetCandidate.model.harness === override.harness &&
        activeFailure(presetCandidate, filters)?.scope !== "model") {
      base = presetCandidate;
    } else {
      const ranked = rankCandidates(config, subtask.task_type, mode, health, filters, override.harness);
      if (ranked.length === 0) {
        throw new PlanPreviewError("MODEL_UNSUPPORTED", `Subtask ${subtask.id}: harness ${JSON.stringify(override.harness)} has no enabled models.`, {
          subtask_id: subtask.id,
          harness: override.harness,
        });
      }
      base = ranked[0];
    }
    source = "override";
  } else if (presetCandidate) {
    const degradation = activeFailure(presetCandidate, filters);
    const missing = isInstalled(health, presetCandidate) === false;
    const unauthenticated = !missing &&
      healthForCandidate(health?.[presetCandidate.model.harness], presetCandidate)?.auth_status === "unauthenticated";
    const replacement = degradation || missing || unauthenticated
      ? rankCandidates(config, subtask.task_type, mode, health, filters).find((candidate) => {
        const probe = healthForCandidate(health?.[candidate.model.harness], candidate);
        return (!health || (probe?.installed && probe.auth_status !== "unauthenticated")) && !activeFailure(candidate, filters);
      }) : undefined;
    if (replacement) {
      const presetHarness = presetCandidate.model.harness;
      notes.push(degradation ? text.recentFailure(degradation, true)
        : missing ? text.missingPresetHarness(presetHarness, presetId)
          : text.unauthenticatedPresetHarness(presetHarness, presetId));
      base = replacement;
      source = "catalog_match";
    } else {
      base = presetCandidate;
      source = "preset";
    }
  } else {
    const ranked = rankCandidates(config, subtask.task_type, mode, health, filters);
    if (ranked.length === 0) {
      throw new PlanPreviewError("HARNESS_UNAVAILABLE", "No enabled models are available in the catalog.", {
        subtask_id: subtask.id, no_enabled_models: true,
      });
    }
    base = ranked[0];
    source = "catalog_match";
  }

  const active = activeFailure(base, filters);
  if (active) notes.push(text.recentFailure(active, false));
  const presetEffort = presetCandidate && presetCandidate.modelId === base.modelId ? role?.effort : undefined;
  const effort = override.effort !== undefined
    ? requireEffort(base, override.effort, subtask.id)
    : presetEffort ?? base.model.default_effort;
  if (override.effort !== undefined) source = "override";
  return { ...base, effort, source, notes };
}

// ---------------------------------------------------------------------------
// Alternatives, warnings, rendering
// ---------------------------------------------------------------------------

function alternativeReason(chosen: Candidate, alternative: Candidate, text: typeof en): string {
  const reasons: string[] = [];
  const costDelta = COST_RANK[alternative.model.cost_tier] - COST_RANK[chosen.model.cost_tier];
  if (costDelta < 0) reasons.push(`${text.cheaper} (${alternative.model.cost_tier})`);
  if (costDelta > 0) reasons.push(`${text.moreExpensive} (${alternative.model.cost_tier})`);
  if (alternative.model.harness !== chosen.model.harness) reasons.push(`${text.otherHarness} (${alternative.model.harness})`);
  if (alternative.model.tier !== chosen.model.tier) reasons.push(`${text.tier} ${alternative.model.tier}`);
  return reasons.join(", ") || text.comparable;
}

function pickAlternatives(
  config: ConfigSnapshot,
  chosen: Candidate,
  taskType: string,
  mode: RunMode,
  health: Record<string, HarnessHealth> | undefined,
  text: typeof en,
  filters: RoutingFilters,
  reviewVendors?: { chosen: string; authors: ReadonlyMap<string, number> },
): PlanAlternative[] {
  const keywords = keywordsForRole(taskType);
  const ranked = rankCandidates(config, taskType, mode, health, filters).filter((candidate) =>
    candidate.modelId !== chosen.modelId && !activeFailure(candidate, filters));
  const isReady = (candidate: Candidate): boolean => {
    const harnessHealth = healthForCandidate(health?.[candidate.model.harness], candidate);
    return !harnessHealth || (harnessHealth.installed && harnessHealth.auth_status !== "unauthenticated");
  };
  const alternatives = ranked.flatMap((candidate) => {
    const relevant = countHits(candidate.model.best_for, keywords) > 0 || candidate.model.tier === chosen.model.tier;
    if (reviewVendors) {
      const vendor = inferVendorFamily(candidate.model, candidate.harness.driver, candidate.harness.default_upstream_provider);
      // An author of unknown vendor may share any vendor, so no candidate is then a confirmed independent reviewer.
      if (isKnownVendor(vendor) && vendor !== reviewVendors.chosen && !reviewVendors.authors.has(vendor) &&
          !reviewVendors.authors.has(UNKNOWN_VENDOR)) {
        return [{ candidate, priority: relevant ? 0 : 1 }];
      }
    }
    if (!relevant) return [];
    return [{ candidate, priority: candidate.model.harness !== chosen.model.harness ? 2 : 3 }];
  }).sort((a, b) => Number(!isReady(a.candidate)) - Number(!isReady(b.candidate)) || a.priority - b.priority);
  return alternatives.slice(0, MAX_ALTERNATIVES).map(({ candidate }) => ({
    harness: candidate.model.harness,
    model: candidate.modelId,
    effort: candidate.model.default_effort,
    tier: candidate.model.tier,
    cost_tier: candidate.model.cost_tier,
    reason: alternativeReason(chosen, candidate, text),
  }));
}

/** Alternatives from vendors other than the chosen model's (and the host's), for design consultations. */
function crossVendorAlternatives(
  config: ConfigSnapshot,
  chosen: Candidate,
  taskType: string,
  mode: RunMode,
  health: Record<string, HarnessHealth> | undefined,
  text: typeof en,
  filters: RoutingFilters,
  avoidVendors: ReadonlyMap<string, number>,
): PlanAlternative[] {
  const chosenVendor = inferVendorFamily(chosen.model, chosen.harness.driver, chosen.harness.default_upstream_provider);
  return pickAlternatives(config, chosen, taskType, mode, health, text, filters, { chosen: chosenVendor, authors: avoidVendors })
    .filter((alternative) => {
      const candidate = isUsable(config, alternative.model);
      if (!candidate) return false;
      const vendor = inferVendorFamily(candidate.model, candidate.harness.driver, candidate.harness.default_upstream_provider);
      return isKnownVendor(vendor) && !avoidVendors.has(vendor);
    });
}

interface RuntimeAlternativeInput {
  config: ConfigSnapshot;
  healthByHarness: Record<string, HarnessHealth>;
  failedHarness?: string;
  failedModel?: string;
  role?: string;
  mode: RunMode;
  failureScope: FailureScope;
  errorCode: ErrorCode;
  avoidVendors?: Iterable<string>;
  /**
   * Vendors a replacement should differ from (soft preference, unlike `avoidVendors`): other consultation advisors and the host.
   * Ready candidates of a known, different vendor rank first; an unknown vendor never counts as independent.
   */
  independentFrom?: Iterable<string>;
  runtimeDegradations?: readonly RuntimeDegradation[];
  excludeHarnesses?: readonly string[];
  excludeModels?: readonly string[];
  /** Structured error details; `limit_bytes` marks a local argv size limit that argv drivers cannot beat. */
  errorDetails?: Record<string, unknown>;
}

export function suggestRuntimeAlternatives(rawInput: RuntimeAlternativeInput): PlanAlternative[] {
  const input = { ...rawInput, excludeModels: canonicalModelIds(rawInput.config, rawInput.excludeModels) };
  const { config, healthByHarness, failedHarness, failedModel, mode, failureScope, errorCode } = input;
  // A timeout is recovered by retrying the same model with a larger timeout_sec, never by switching models.
  if (errorCode === "TIMEOUT") return [];
  const failed = failedModel && Object.hasOwn(config.models, failedModel) ? config.models[failedModel] : undefined;
  const failedHarnessConfig = failed && Object.hasOwn(config.harnesses, failed.harness) ? config.harnesses[failed.harness] : undefined;
  const failedDriver = failedHarnessConfig?.driver;
  const vendor = failed && failedDriver ? inferVendorFamily(failed, failedDriver, failedHarnessConfig?.default_upstream_provider) : undefined;
  const role = input.role ?? (mode === "write" ? "implementation" : "codebase_qa");
  const keywords = keywordsForRole(role);
  const preferredTier = preferredTierForRole(role);
  const avoidVendors = new Set(input.avoidVendors);
  const independentFrom = new Set(input.independentFrom);
  const contextKeywords = keywordsForRole("long_context");
  const localArgvLimit = errorCode === "PROMPT_TOO_LARGE" && input.errorDetails?.limit_bytes !== undefined;
  const candidates = Object.keys(config.models).flatMap((id) => {
    const candidate = isUsable(config, id);
    if (!candidate || excluded(candidate, input) || activeFailure(candidate, input) ||
        !isAllowedBySandboxPolicy(config, candidate, mode, healthByHarness)) return [];
    const { model, harness } = candidate;
    if (localArgvLimit && DRIVER_METADATA[harness.driver].promptDelivery === "argv") return [];
    const probe = healthForCandidate(healthByHarness[model.harness], candidate);
    if (!probe?.enabled || !probe.installed || probe.auth_status === "unauthenticated") return [];
    const otherHarness = model.harness !== failedHarness;
    if ((failureScope === "harness" && !otherHarness) ||
        (id === failedModel && (failureScope === "model" || !otherHarness))) return [];
    const family = inferVendorFamily(model, harness.driver, harness.default_upstream_provider);
    if (avoidVendors.has(family)) return [];
    const guarantee = securityGuaranteeFor(harness.driver, mode, probe);
    let score = scoreCandidate(candidate, keywords, preferredTier, probe);
    if (mode === "write" && guarantee !== "unsandboxed") score += 8;
    if (errorCode === "PROMPT_TOO_LARGE") score += countHits([...model.best_for, ...model.strengths], contextKeywords) * 6;
    const preferredDelivery = errorCode === "PROMPT_TOO_LARGE" && DRIVER_METADATA[harness.driver].promptDelivery !== "argv";
    const preferredRoute = failureScope === "harness" ? family !== vendor && family !== UNKNOWN_VENDOR : failureScope === "job" && otherHarness;
    const reason = preferredDelivery ? "Supports larger prompts via " + DRIVER_METADATA[harness.driver].promptDelivery :
      otherHarness ? "Role fit on another harness" : "Role fit on the same harness";
    const independent = independentFrom.size > 0 && isKnownVendor(family) && !independentFrom.has(family);
    return [{ id, score, preferredRoute, preferredDelivery, independent, alternative: {
      harness: model.harness, model: id, effort: model.default_effort, tier: model.tier, cost_tier: model.cost_tier,
      reason: `${reason} (${role}, ${harness.driver}, ${guarantee})`,
    } }];
  });
  return candidates.sort((a, b) => Number(b.preferredDelivery) - Number(a.preferredDelivery) ||
    Number(b.independent) - Number(a.independent) ||
    Number(b.preferredRoute) - Number(a.preferredRoute) || b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 3).map(({ alternative }) => alternative);
}

export type DelegationState = "available" | "exhausted" | "unknown";
export type DelegationBlockReason = "not_installed" | "unauthenticated" | "sandbox_policy" | "cooldown" | "excluded";

export interface DelegationAvailability {
  state: DelegationState;
  usable_count: number;
  /** Enabled models whose harness has no health probe yet; never counted as blocked. */
  unknown_count: number;
  total_enabled_count: number;
  blocked_by_harness: Record<string, DelegationBlockReason>;
  /** Set only when every blocked model is blocked solely by a session cooldown. */
  earliest_retry_at?: string;
  retryable: boolean;
}

export interface DelegationAvailabilityInput {
  config: ConfigSnapshot;
  healthByHarness?: Record<string, HarnessHealth>;
  runtimeDegradations?: readonly RuntimeDegradation[];
  excludeHarnesses?: readonly string[];
  excludeModels?: readonly string[];
  /** Harnesses named by an explicit subtask override; `selectModel` lets them bypass `excludeHarnesses`. */
  explicitHarnesses?: readonly string[];
  /** Models named by an explicit subtask override; `selectModel` lets them bypass both exclusion lists. */
  explicitModels?: readonly string[];
  /**
   * Modes the delegated work needs. When non-empty, a model counts as usable only if its harness can run at least one of
   * them under the sandbox policy; otherwise it is blocked as "sandbox_policy".
   */
  modes?: readonly RunMode[];
}

/** Most informative reason first when several models of one harness are blocked differently. */
const BLOCK_REASON_PRIORITY: readonly DelegationBlockReason[] = ["not_installed", "unauthenticated", "sandbox_policy", "cooldown", "excluded"];

/**
 * Whether any enabled model could still run delegated work. A missing or inconclusive health probe counts as
 * "unknown", never as blocked, so a slow or failed probe cannot cause a false hard stop. Confirmed facts
 * (not installed, unauthenticated) outrank a cooldown, so such a harness is never reported as retryable.
 */
export function delegationAvailability(input: DelegationAvailabilityInput): DelegationAvailability {
  const { config, healthByHarness } = input;
  let usable = 0;
  let unknown = 0;
  let total = 0;
  let cooldownOnly = true;
  let earliestRetryMs: number | undefined;
  const reasonsByHarness = new Map<string, DelegationBlockReason>();
  const liveHarnesses = new Set<string>();
  const explicitHarnesses = new Set(input.explicitHarnesses);
  const explicitModels = new Set(canonicalModelIds(config, input.explicitModels));
  const excludeModels = canonicalModelIds(config, input.excludeModels);
  const requiredModes = [...new Set(input.modes ?? [])];

  const block = (harnessId: string, reason: DelegationBlockReason): void => {
    if (reason !== "cooldown") cooldownOnly = false;
    const current = reasonsByHarness.get(harnessId);
    if (!current || BLOCK_REASON_PRIORITY.indexOf(reason) < BLOCK_REASON_PRIORITY.indexOf(current)) {
      reasonsByHarness.set(harnessId, reason);
    }
  };
  const isExcluded = (modelId: string, harnessId: string): boolean => {
    if (explicitModels.has(modelId)) return false;
    return Boolean(excludeModels?.includes(modelId) ||
      (!explicitHarnesses.has(harnessId) && input.excludeHarnesses?.includes(harnessId)));
  };

  for (const modelId of Object.keys(config.models)) {
    const candidate = isUsable(config, modelId);
    if (!candidate) continue;
    total++;
    const harnessId = candidate.model.harness;
    if (isExcluded(modelId, harnessId)) {
      block(harnessId, "excluded");
      continue;
    }
    const hasProbe = Boolean(healthByHarness) && Object.hasOwn(healthByHarness!, harnessId);
    const probe = hasProbe ? healthForCandidate(healthByHarness![harnessId], candidate) : undefined;
    const conclusive = probe !== undefined && probe.probe_inconclusive !== true;
    if (conclusive && !probe.installed) {
      block(harnessId, "not_installed");
      continue;
    }
    if (conclusive && probe.auth_status === "unauthenticated") {
      block(harnessId, "unauthenticated");
      continue;
    }
    // A confirmed sandbox-policy block never lifts by waiting, so it outranks a cooldown and keeps the stop non-retryable.
    if (requiredModes.length > 0 && !requiredModes.some((mode) =>
      isAllowedGuarantee(config, mode, securityGuaranteeFor(candidate.harness.driver, mode, probe)))) {
      block(harnessId, "sandbox_policy");
      continue;
    }
    const now = Date.now();
    const active = (input.runtimeDegradations ?? []).filter((entry) => Date.parse(entry.expires_at) > now &&
      entry.harness === harnessId && (entry.scope === "harness" || entry.model === modelId));
    if (active.length > 0) {
      block(harnessId, "cooldown");
      // The model is back once its last active cooldown expires.
      const freeAt = Math.max(...active.map((entry) => Date.parse(entry.expires_at)));
      earliestRetryMs = earliestRetryMs === undefined ? freeAt : Math.min(earliestRetryMs, freeAt);
      continue;
    }
    if (!conclusive) {
      unknown++;
      liveHarnesses.add(harnessId);
      continue;
    }
    usable++;
    liveHarnesses.add(harnessId);
  }

  if (total === 0) {
    return { state: "exhausted", usable_count: 0, unknown_count: 0, total_enabled_count: 0, blocked_by_harness: {}, retryable: false };
  }
  const state: DelegationState = usable > 0 ? "available" : unknown > 0 ? "unknown" : "exhausted";
  const blockedByHarness = Object.fromEntries([...reasonsByHarness].filter(([id]) => !liveHarnesses.has(id)));
  const retryAtMs = state === "exhausted" && cooldownOnly ? earliestRetryMs : undefined;
  return {
    state, usable_count: usable, unknown_count: unknown, total_enabled_count: total, blocked_by_harness: blockedByHarness,
    ...(retryAtMs === undefined ? {} : { earliest_retry_at: new Date(retryAtMs).toISOString() }),
    retryable: retryAtMs !== undefined,
  };
}

function shorten(text: string | undefined): string {
  if (!text) return "";
  const firstClause = text.split(/[:;]/)[0].trim();
  return firstClause.length <= NOTE_MAX_CHARS ? firstClause : `${firstClause.slice(0, NOTE_MAX_CHARS - 1).trimEnd()}…`;
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function renderRow(item: PlanPreviewItem): string {
  // Full warning text goes below the table; the cell carries only the short tag before " — ".
  const tags = item.warnings.map((warning) => `⚠ ${warning.split(" — ")[0]}`);
  const prosAndRisks = [item.pros && `+ ${item.pros}`, item.risks && `− ${item.risks}`, ...tags]
    .filter(Boolean)
    .join("; ");
  const cells = [
    String(item.index),
    item.title,
    `${item.harness} / ${item.model}`,
    item.effort,
    item.mode,
    item.isolation,
    `${item.tier} / ${item.cost_tier}`,
    item.security_guarantee,
    prosAndRisks,
  ];
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

function securityGuaranteeFor(driver: DriverKind, mode: RunMode, health?: HarnessHealth): SecurityGuarantee {
  // A driver without a registered adapter gets the most conservative guarantee.
  return health?.security_guarantees?.[mode] ?? DRIVER_SECURITY_GUARANTEES[driver]?.[mode] ?? "unsandboxed";
}

/** Splits subtasks that ask for shards into `<id>#<n>` items; write shards are forced into worktrees. */
function expandShards(subtasks: PlanSubtaskInput[]): ExpandedSubtask[] {
  return subtasks.flatMap(({ shards, ...subtask }): ExpandedSubtask[] => {
    if (shards === undefined || shards === 1) return [subtask];
    if (!Number.isInteger(shards) || shards < 1 || shards > MAX_SHARDS) {
      throw new PlanPreviewError("PLAN_REQUIRED", `shards must be an integer from 1 to ${MAX_SHARDS}.`, { subtask_id: subtask.id, shards });
    }
    const isWrite = (subtask.mode ?? defaultModeForRole(subtask.task_type)) === "write";
    const forced = isWrite && subtask.isolation === "shared";
    return Array.from({ length: shards }, (_unused, position): ExpandedSubtask => ({
      ...subtask,
      id: `${subtask.id}#${position + 1}`,
      title: `${subtask.title} [shard ${position + 1}/${shards}]`,
      ...(forced ? { isolation: "worktree" as const, isolationForced: true } : {}),
    }));
  });
}

/**
 * Checks IDs twice: on the caller's subtasks before shard expansion (so `a` + sharded `a` is rejected even though `a`,
 * `a#1`, `a#2` would be distinct), and on the expanded list (so a literal `a#1` cannot collide with a generated shard ID).
 */
function validateSubtasks(subtasks: readonly Pick<PlanSubtaskInput, "id">[], stage: "requested" | "expanded"): void {
  if (subtasks.length === 0) {
    throw new PlanPreviewError("PLAN_REQUIRED", "A plan preview needs at least one subtask.");
  }
  const seen = new Set<string>();
  for (const subtask of subtasks) {
    if (!subtask.id?.trim()) throw new PlanPreviewError("PLAN_REQUIRED", "Every subtask needs a non-empty id.");
    if (seen.has(subtask.id)) {
      const message = stage === "requested"
        ? `Duplicate subtask id ${JSON.stringify(subtask.id)}.`
        : `Duplicate subtask id ${JSON.stringify(subtask.id)}: it collides with a generated shard id (<id>#<n>); rename the subtask.`;
      throw new PlanPreviewError("PLAN_REQUIRED", message, { subtask_id: subtask.id });
    }
    seen.add(subtask.id);
  }
}

/** The driver a label names, either by its kind ("antigravity") or by its default binary ("agy"). */
function driverForLabel(label: string): DriverKind | undefined {
  const drivers = Object.keys(DRIVER_METADATA) as DriverKind[];
  return drivers.find((driver) => driver === label) ?? drivers.find((driver) => DRIVER_METADATA[driver].defaultBinary === label);
}

/**
 * Maps a free-form vendor label ("zai", "Claude", "codex", "agy") to the catalog's vendor family; unknown labels stay as typed.
 * A driver kind or binary name maps through that driver's native vendor first, so "codex" means "openai".
 */
function normalizeHostVendor(value: string | undefined): string | undefined {
  const label = value?.trim().toLowerCase();
  if (!label) return undefined;
  const driver = driverForLabel(label);
  const nativeVendor = driver && DRIVER_METADATA[driver].nativeVendor;
  if (nativeVendor) return nativeVendor;
  // "pi" has no native vendor, so an unrecognized label falls through unchanged.
  return inferVendorFamily({ harness: label, cli_model: label }, "pi");
}

interface SelectedSubtask { subtask: PlanSubtaskInput; mode: RunMode; category?: string; vendor: string }

/** A plan is a design consultation when asked for explicitly, or (intent omitted) when it pairs architecture with second_opinion, all readonly. */
function isDesignConsultation(selected: SelectedSubtask[], intent: PlanIntent | undefined): boolean {
  if (intent === "design_consult") return true;
  if (intent !== undefined) return false;
  const roles = new Set(selected.map(({ subtask }) => resolveRoleId(subtask.task_type)));
  return roles.has("architecture") && roles.has("second_opinion") && selected.every(({ mode }) => mode === "readonly");
}

/**
 * How a review row relates to the plan's other authors: "same" vendor, "unverified" when any vendor involved is unknown
 * (it may match), or undefined when the plan has no other author or the vendors are known and different.
 */
function reviewIndependence(vendor: string, isAuthor: boolean, authorVendors: ReadonlyMap<string, number>): "same" | "unverified" | undefined {
  const others = [...authorVendors].flatMap(([name, count]) => count - (isAuthor && name === vendor ? 1 : 0) > 0 ? [name] : []);
  if (others.length === 0) return undefined;
  if (!isKnownVendor(vendor) || others.some((name) => !isKnownVendor(name))) return "unverified";
  return others.includes(vendor) ? "same" : undefined;
}

/** Readonly advisors only; repo recon and other support roles are the host's own legwork. */
function advisoryIndexes(selected: SelectedSubtask[]): number[] {
  return selected.flatMap(({ mode, category }, index) => mode === "readonly" && category !== "support" ? [index] : []);
}

function aliasOrSelf(requested: string, aliases: ConfigSnapshot["aliases"], models: ConfigSnapshot["models"]): string {
  try {
    return resolveModelAlias(requested, aliases, models);
  } catch {
    return requested; // A cyclic alias is reported by selectModel.
  }
}

function summarizeTimeouts(defaults: ConfigSnapshot["defaults"]): PlanTimeoutSummary {
  return {
    default_timeout_sec: defaults.default_timeout_sec,
    high_effort_timeout_sec: defaults.high_effort_timeout_sec,
    max_timeout_sec: defaults.max_timeout_sec,
    auto_extend_timeout: defaults.auto_extend_timeout,
    idle_timeout_sec: defaults.idle_timeout_sec,
    timeout_extension_sec: defaults.timeout_extension_sec,
    activity_window_sec: defaults.activity_window_sec,
  };
}

function summarizeConcurrency(
  config: ConfigSnapshot, items: PlanPreviewItem[], known: Record<string, HarnessConcurrencyInfo> | undefined,
  live: PlanLiveConcurrency | undefined,
): PlanConcurrencySummary {
  const planned = new Map<string, number>();
  for (const item of items) planned.set(item.harness, (planned.get(item.harness) ?? 0) + 1);
  const perHarness: PlanConcurrencySummary["per_harness"] = {};
  for (const [harnessId, count] of planned) {
    const harness = config.harnesses[harnessId];
    const info = known?.[harnessId]
      ?? resolveHarnessConcurrency({ harnessId, harness, defaults: config.defaults, cliLimits: emptyCliLimits(harness.driver) });
    perHarness[harnessId] = {
      ...info, planned_subtasks: count,
      ...(live ? { session_active: live.harness_active?.[harnessId] ?? 0 } : {}),
    };
  }
  const { max_concurrency, host_max_concurrency, concurrency_scope, max_queue_size } = config.defaults;
  return {
    global_max_concurrency: max_concurrency,
    session_max_concurrency: max_concurrency,
    host_max_concurrency: Math.max(host_max_concurrency, max_concurrency),
    concurrency_scope,
    ...(live ? { session_id: live.session_id, session_active: live.session_active, host_active: live.host_active } : {}),
    max_queue_size,
    per_harness: perHarness,
  };
}

export function buildPlanPreview(input: BuildPlanPreviewInput): PlanPreviewResult {
  const { config, healthByHarness: health } = input;
  const text = messages[input.locale ?? config.defaults.locale ?? "en"];
  const presetId = input.preset?.trim() || DEFAULT_PRESET;
  const preset = Object.hasOwn(config.presets, presetId) ? config.presets[presetId] : undefined;
  if (!preset || !preset.enabled) {
    const available = Object.entries(config.presets).filter(([, value]) => value.enabled).map(([id]) => id);
    throw new PlanPreviewError(
      "PLAN_NOT_FOUND",
      `Preset ${JSON.stringify(presetId)} ${preset ? "is disabled" : "does not exist"}. Available presets: ${available.join(", ") || "none"}.`,
      { preset: presetId, available_presets: available },
    );
  }
  validateSubtasks(input.subtasks, "requested");
  const subtasks = expandShards(input.subtasks);
  validateSubtasks(subtasks, "expanded");
  // Aliases resolve to canonical IDs once, so every ranking and availability check compares like with like.
  const filters: RoutingFilters = { ...input, excludeModels: canonicalModelIds(config, input.excludeModels) };

  const explicitModels = [...new Set(subtasks.flatMap(({ override }) => override?.model ? [aliasOrSelf(override.model, config.aliases, config.models)] : []))];
  const explicitHarnesses = [...new Set(subtasks.flatMap(({ override }) => override?.harness && !override.model ? [override.harness] : []))];
  const delegation = delegationAvailability({
    config, healthByHarness: health, runtimeDegradations: input.runtimeDegradations,
    excludeHarnesses: filters.excludeHarnesses, excludeModels: filters.excludeModels, explicitModels, explicitHarnesses,
    modes: subtasks.map((subtask) => subtask.mode ?? defaultModeForRole(subtask.task_type)),
  });
  if (delegation.total_enabled_count === 0) {
    throw new PlanPreviewError(
      "DELEGATION_UNAVAILABLE",
      "All enabled delegation models are unavailable: no enabled models in the catalog. Stop main work and notify the user.",
      { all_delegation_models_unavailable: true },
    );
  }

  const authorVendors = new Map<string, number>();
  const selected = subtasks.map((subtask) => {
    const mode = subtask.mode ?? defaultModeForRole(subtask.task_type);
    const category = getRoleDefinition(subtask.task_type)?.category;
    let selection: Selection;
    try {
      selection = selectModel(config, preset.roles, presetId, subtask, mode, health, text, filters);
    } catch (cause) {
      // Exclusions or cooldowns that remove every candidate are a delegation hard stop, not a routing hiccup.
      if (cause instanceof PlanPreviewError && cause.structured.details?.no_enabled_models === true) {
        // Judged for this row's own mode: one runnable mode elsewhere in the plan must not hide a row nothing can run.
        const rowDelegation = delegation.state === "exhausted" ? delegation : delegationAvailability({
          config, healthByHarness: health, runtimeDegradations: input.runtimeDegradations,
          excludeHarnesses: filters.excludeHarnesses, excludeModels: filters.excludeModels, explicitModels, explicitHarnesses, modes: [mode],
        });
        if (rowDelegation.state === "exhausted") {
          throw new PlanPreviewError(
            "DELEGATION_UNAVAILABLE",
            delegation.state === "exhausted"
              ? "All enabled delegation models are unavailable. Stop main work and notify the user."
              : `All enabled delegation models are unavailable for subtask ${subtask.id} (${mode}). Stop main work and notify the user.`,
            { all_delegation_models_unavailable: true, subtask_id: subtask.id, blocked_by_harness: rowDelegation.blocked_by_harness,
              ...(rowDelegation.earliest_retry_at ? { earliest_retry_at: rowDelegation.earliest_retry_at } : {}) },
          );
        }
      }
      throw cause;
    }
    const vendor = inferVendorFamily(selection.model, selection.harness.driver, selection.harness.default_upstream_provider);
    const isAuthor = category === "author" || mode === "write";
    if (isAuthor) authorVendors.set(vendor, (authorVendors.get(vendor) ?? 0) + 1);
    return { subtask, mode, category, selection, vendor, isAuthor };
  });
  // An unidentified host vendor cannot be compared with anything, so it is treated as not provided.
  const normalizedHostVendor = normalizeHostVendor(input.host_vendor);
  const hostVendor = isKnownVendor(normalizedHostVendor) ? normalizedHostVendor : undefined;
  const designConsultation = isDesignConsultation(selected, input.intent);
  const advisory = designConsultation ? advisoryIndexes(selected) : [];
  const advisoryVendors = new Set(advisory.map((index) => selected[index].vendor));
  const collapsedVendor = advisory.length >= 2 && advisoryVendors.size === 1 ? selected[advisory[0]].vendor : undefined;
  const consultWarnings = new Map<number, string>();
  for (const index of advisory) {
    // An advisor of unknown vendor may be the host's vendor or another advisor's, so it never counts as independent.
    if (!isKnownVendor(selected[index].vendor)) {
      consultWarnings.set(index, text.designConsultUnknownVendor);
    } else if (hostVendor !== undefined && selected[index].vendor === hostVendor) {
      // Every advisor that repeats the host's vendor adds no independent perspective, even when others differ.
      consultWarnings.set(index, text.designConsultHostVendor(hostVendor));
    } else if (collapsedVendor !== undefined) {
      consultWarnings.set(index, text.designConsultSameVendor(collapsedVendor));
    }
  }
  const writeCount = selected.filter(({ mode }) => mode === "write").length;
  const parallelWrite = writeCount >= 2;
  const planWarnings: string[] = [...config.config_warnings];
  if (input.intent === "design_consult" && advisory.length === 0) planWarnings.push(text.designConsultNoAdvisors);

  const items = selected.map(({ subtask, mode, category, selection, vendor, isAuthor }, position): PlanPreviewItem => {
    const recommendedIsolation: IsolationMode = mode === "write" && parallelWrite ? "worktree" : "shared";
    const isolation = subtask.isolation ?? recommendedIsolation;
    const harnessHealth = healthForCandidate(health?.[selection.model.harness], selection);
    const securityGuarantee = securityGuaranteeFor(selection.harness.driver, mode, harnessHealth);
    const warnings = [...selection.notes];

    if (selection.model.cost_tier === "premium") warnings.push(text.premium);
    if (securityGuarantee === "unsandboxed") warnings.push(text.unsandboxed);
    if (DRIVER_METADATA[selection.harness.driver]?.contract === "experimental") {
      warnings.push(text.experimental(selection.harness.driver));
    }
    if (selection.model.is_stale) warnings.push(text.stale(selection.model.checked_at ?? "unknown"));
    if (harnessHealth && !harnessHealth.installed) warnings.push(text.missing(selection.model.harness));
    else if (harnessHealth?.auth_status === "unauthenticated") warnings.push(text.unauthenticated(selection.model.harness));
    if (mode === "write" && parallelWrite && isolation === "shared") {
      warnings.push(text.shared);
    }
    if (subtask.isolationForced) warnings.push(text.shardWorktree);
    if (input.cwdDirty && (recommendedIsolation === "worktree" || isolation === "worktree")) {
      warnings.push(text.dirty);
    }
    const reviewVendors = category === "review" ? { chosen: vendor, authors: authorVendors } : undefined;
    const independence = reviewVendors && reviewIndependence(vendor, isAuthor, authorVendors);
    if (independence === "same") warnings.push(text.selfReview(vendor));
    else if (independence === "unverified") warnings.push(text.selfReviewUnverified);
    const consultWarning = consultWarnings.get(position);
    if (consultWarning) warnings.push(consultWarning);
    const alternatives = consultWarning
      ? crossVendorAlternatives(config, selection, subtask.task_type, mode, health, text, filters,
        new Map([[vendor, 1], ...(hostVendor ? [[hostVendor, 1] as [string, number]] : [])]))
      : pickAlternatives(config, selection, subtask.task_type, mode, health, text, filters, reviewVendors);

    return {
      index: position + 1,
      id: subtask.id,
      title: subtask.title,
      task_type: subtask.task_type,
      harness: selection.model.harness,
      harness_display_name: selection.harness.display_name,
      driver: selection.harness.driver,
      model: selection.modelId,
      model_display_name: selection.model.display_name,
      cli_model: selection.model.cli_model,
      effort: selection.effort,
      mode,
      mode_source: subtask.mode ? "user" : "default",
      isolation,
      recommended_isolation: recommendedIsolation,
      isolation_source: subtask.isolation && !subtask.isolationForced ? "user" : "recommended",
      tier: selection.model.tier,
      cost_tier: selection.model.cost_tier,
      cost_note: selection.model.cost_note,
      security_guarantee: securityGuarantee,
      selection_source: selection.source,
      ...(harnessHealth ? { harness_auth_status: harnessHealth.auth_status, harness_installed: harnessHealth.installed } : {}),
      is_stale: selection.model.is_stale,
      pros: shorten(selection.model.strengths[0]),
      risks: shorten(selection.model.weaknesses[0]),
      warnings,
      alternatives,
    };
  });

  const sharedWrites = items.filter((item) => item.mode === "write" && item.isolation === "shared");
  if (parallelWrite && sharedWrites.length >= 2) {
    planWarnings.push(text.sharedWrites(sharedWrites.map((item) => `#${item.index}`).join(", ")));
  }
  const concurrency = summarizeConcurrency(config, items, input.concurrencyByHarness, input.liveConcurrency);
  for (const [harnessId, entry] of Object.entries(concurrency.per_harness)) {
    if (entry.planned_subtasks > entry.effective_cap) {
      planWarnings.push(text.harnessQueue(harnessId, entry.planned_subtasks, entry.effective_cap, concurrency.max_queue_size === 0));
    }
  }
  const exhausted = delegation.state === "exhausted";
  if (exhausted) {
    const blocked = Object.entries(delegation.blocked_by_harness).map(([id, reason]) => `${id}: ${reason}`).join(", ");
    planWarnings.push(text.delegationExhausted(blocked));
  }
  // Plan-wide availability is not enough: every row must itself be allowed to run under the sandbox policy.
  const unrunnableRows = items.filter((item) => !isAllowedGuarantee(config, item.mode, item.security_guarantee));
  const launchable = !exhausted && unrunnableRows.length === 0;
  const blockedByHarness: Record<string, DelegationBlockReason> = exhausted
    ? delegation.blocked_by_harness : Object.fromEntries(unrunnableRows.map((item) => [item.harness, "sandbox_policy" as const]));

  return {
    plan_id: `plan_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    preset: presetId,
    preset_description: preset.description,
    config_revision: config.revision,
    created_at: new Date().toISOString(),
    parallel_write_detected: parallelWrite,
    items,
    warnings: [...items.flatMap((item) => item.warnings.map((warning) => `#${item.index}: ${warning}`)), ...planWarnings],
    markdown_table: [text.header, TABLE_DIVIDER, ...items.map(renderRow)].join("\n"),
    ...(input.excludeHarnesses ? { exclude_harnesses: [...input.excludeHarnesses] } : {}),
    ...(filters.excludeModels ? { exclude_models: [...filters.excludeModels] } : {}),
    ...(explicitHarnesses.length > 0 ? { explicit_harnesses: explicitHarnesses } : {}),
    ...(explicitModels.length > 0 ? { explicit_models: explicitModels } : {}),
    concurrency,
    timeouts: summarizeTimeouts(config.defaults),
    delegation_status: delegation.state,
    launchable,
    ...(designConsultation ? { intent: "design_consult" as const } : input.intent ? { intent: input.intent } : {}),
    ...(hostVendor ? { host_vendor: hostVendor } : {}),
    ...(launchable ? {} : {
      blocked_reason: "DELEGATION_UNAVAILABLE" as const,
      blocked_by_harness: blockedByHarness,
      ...(exhausted && delegation.earliest_retry_at ? { earliest_retry_at: delegation.earliest_retry_at } : {}),
    }),
  };
}
