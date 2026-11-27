import { z } from "zod";
import { DRIVER_KINDS, DRIVER_METADATA, LEGACY_WRITE_PERMISSION_MODES } from "../drivers.js";

export const DefaultsSchema = z.strictObject({
  locale: z.enum(["en", "ru"]).default("en"),
  stale_after_days: z.number().int().positive().default(90),
  max_concurrency: z.number().int().positive().default(8),
  max_queue_size: z.number().int().min(0).default(32),
  default_timeout_sec: z.number().int().positive().default(900),
  /** Used instead of default_timeout_sec when the caller omits timeout_sec and the effort is high, xhigh, or max. */
  high_effort_timeout_sec: z.number().int().positive().default(1800),
  max_timeout_sec: z.number().int().positive().default(3600),
  max_mcp_output_bytes: z.number().int().positive().default(24000),
  max_log_bytes_per_job: z.number().int().positive().default(10485760),
  orch_max_depth: z.number().int().min(0).default(1),
  inherit_mcp: z.boolean().default(false),
  require_plan_id: z.boolean().default(false),
  allow_unsandboxed_write: z.boolean().default(true),
  /** 0 = auto self-calibrating hold cap; 1..600 = explicit per-call hold cap for orch_status waits, in seconds. */
  mcp_max_wait_sec: z.number().int().min(0).max(600).default(0),
  /** Finished job directories under runs/ older than this many days are pruned; 0 disables age-based pruning. */
  run_retention_days: z.number().int().min(0).max(365).default(7),
  /** Total runs/ size cap in MiB (oldest finished jobs are pruned first); 0 disables size-based pruning. */
  max_runs_total_mb: z.number().int().min(0).max(102400).default(512),
  /** Parallel jobs per harness when neither the harness nor the CLI's own config states a limit. Schema-only default. */
  default_harness_concurrency: z.number().int().min(1).max(64).default(5),
  /** "cli_limit" lets a CLI's native subagents run within its own configured limits; "off" disables them per job. */
  native_subagents: z.enum(["cli_limit", "off"]).default("cli_limit"),
  /** Deepest native subagent nesting a job may use; the CLI's own lower limit still wins. */
  native_subagent_depth: z.number().int().min(0).max(3).default(2),
  /** What `max_concurrency` is counted per: "repo" = one repository (worktrees fold into their main repo), "context" = one context_id, "global" = the whole host. */
  concurrency_scope: z.enum(["repo", "context", "global"]).default("repo"),
  /** Hard ceiling on running jobs across ALL sessions; the effective cap is max(host_max_concurrency, max_concurrency). */
  host_max_concurrency: z.number().int().min(1).max(256).default(24),
  /** Streaming jobs that are making real progress get their soft timeout extended instead of being killed. */
  auto_extend_timeout: z.boolean().default(true),
  /** A streaming job with no output or CPU activity for this long is killed as idle; 0 disables idle detection. */
  idle_timeout_sec: z.number().int().min(0).max(86400).default(900),
  /** How far one activity-based extension moves the soft deadline. */
  timeout_extension_sec: z.number().int().min(60).max(3600).default(600),
  /** A job counts as active when it produced output (or stderr / CPU) within this window. */
  activity_window_sec: z.number().int().min(30).max(1800).default(180),
});

const entityMetadata = {
  enabled: z.boolean().default(true),
  custom: z.boolean().optional(),
  _base_hash: z.string().optional(),
};

const ISO_DATE_LENGTH = "YYYY-MM-DD".length;

/** TOML reads `2026-11-26` as a native date, not a string; every date field accepts both spellings. */
function dateFieldPreprocess(maxLength: number): (value: unknown) => unknown {
  return (value) => value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, maxLength) : value;
}

const IsoDateSchema = z.preprocess(dateFieldPreprocess(ISO_DATE_LENGTH), z.iso.date());
const IsoDateOrDateTimeSchema = z.preprocess(
  (value) => value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : value,
  z.union([z.iso.date(), z.iso.datetime({ offset: true, local: true })]),
);

/** How a harness's models are found: typed in by hand, listed by the CLI itself, or listed by a wrapper script. */
export const MODEL_DISCOVERY_MODES = ["manual", "native", "wrapper"] as const;
export const MODEL_SOURCES = ["catalog", "manual", "discovered"] as const;
export const METADATA_QUALITIES = ["curated", "template", "baseline", "reviewed"] as const;

export const HarnessSchema = z.strictObject({
  driver: z.enum(DRIVER_KINDS),
  display_name: z.string().min(1),
  binary: z.string().min(1),
  profile: z.string().optional(),
  default_upstream_provider: z.string().optional(),
  write_permission_mode: z.string().min(1).max(64).optional(),
  inherit_mcp: z.boolean().optional(),
  extra_args: z.array(z.string()).optional(),
  /** Per-harness cap on parallel jobs; overrides what the CLI's own config states. */
  max_concurrency: z.number().int().min(1).max(64).optional(),
  model_discovery: z.enum(MODEL_DISCOVERY_MODES).optional(),
  ...entityMetadata,
}).superRefine((harness, ctx) => {
  const modes = DRIVER_METADATA[harness.driver].writePermissionModes;
  const legacy = LEGACY_WRITE_PERMISSION_MODES[harness.driver] ?? [];
  const mode = harness.write_permission_mode;
  if (mode !== undefined && modes?.length && !modes.includes(mode) && !legacy.includes(mode)) {
    ctx.addIssue({
      code: "custom",
      path: ["write_permission_mode"],
      message: `write_permission_mode must be one of ${modes.join(", ")} for the ${harness.driver} driver`,
    });
  }
});

/** Cards that were found by model discovery and not yet reviewed may omit the facts a person has to look up. */
function mayOmitCardFacts(model: { source?: string; metadata_quality?: string }): boolean {
  return model.source === "discovered" && model.metadata_quality !== "reviewed";
}

export const ModelSchema = z.strictObject({
  harness: z.string().min(1),
  cli_model: z.string().min(1).optional(),
  cli_provider: z.string().min(1).optional(),
  vendor_family: z.string().min(1).max(64).optional(),
  display_name: z.string().min(1),
  tier: z.enum(["deep", "standard", "light", "specialist"]),
  efforts: z.array(z.string().min(1)).min(1),
  default_effort: z.string().min(1),
  cost_tier: z.enum(["low", "medium", "high", "premium"]),
  cost_note: z.string().default(""),
  speed_note: z.string().default(""),
  context_window: z.number().int().positive().optional(),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  best_for: z.array(z.string()).default([]),
  avoid_for: z.array(z.string()).default([]),
  checked_at: IsoDateSchema.optional(),
  source: z.enum(MODEL_SOURCES).optional(),
  metadata_quality: z.enum(METADATA_QUALITIES).optional(),
  discovered_at: IsoDateOrDateTimeSchema.optional(),
  template_id: z.string().min(1).optional(),
  ...entityMetadata,
}).superRefine((model, ctx) => {
  if (!model.efforts.includes(model.default_effort)) {
    ctx.addIssue({ code: "custom", path: ["default_effort"], message: "default_effort must be included in efforts" });
  }
  if (mayOmitCardFacts(model)) return;
  for (const field of ["context_window", "checked_at"] as const) {
    if (model[field] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is required (only unreviewed discovered cards may omit it)`,
      });
    }
  }
});

/** Optional fields a sparse override may clear again through `_unset`, so an inherited value can be removed. */
export const HARNESS_UNSETTABLE_FIELDS = [
  "profile", "default_upstream_provider", "write_permission_mode", "inherit_mcp", "extra_args", "max_concurrency", "model_discovery",
] as const;
export const MODEL_UNSETTABLE_FIELDS = [
  "cli_model", "cli_provider", "vendor_family", "context_window", "checked_at", "source", "metadata_quality", "discovered_at",
  "template_id",
] as const;

/** `_unset` exists only in the sparse user file: the resolver applies it and strips it from the resolved entity. */
export const HarnessUnsetSchema = z.array(z.enum(HARNESS_UNSETTABLE_FIELDS));
export const ModelUnsetSchema = z.array(z.enum(MODEL_UNSETTABLE_FIELDS));

export const PresetRoleSchema = z.strictObject({
  harness: z.string(),
  model: z.string(),
  effort: z.string(),
});

export const PresetSchema = z.strictObject({
  description: z.string(),
  roles: z.record(z.string(), PresetRoleSchema),
  ...entityMetadata,
});

export const CatalogSchema = z.strictObject({
  schema_version: z.literal(1),
  defaults: DefaultsSchema.prefault({}),
  aliases: z.record(z.string(), z.string().min(1)).default({}),
  harnesses: z.record(z.string(), HarnessSchema).default({}),
  models: z.record(z.string(), ModelSchema).default({}),
  presets: z.record(z.string(), PresetSchema).default({}),
});

export type DefaultsConfig = z.output<typeof DefaultsSchema>;
export type HarnessConfig = z.output<typeof HarnessSchema>;
export type ModelConfig = z.output<typeof ModelSchema> & { cli_model: string };
export type PresetRole = z.output<typeof PresetRoleSchema>;
export type PresetConfig = z.output<typeof PresetSchema>;
export type Catalog = Omit<z.output<typeof CatalogSchema>, "models"> & {
  models: Record<string, ModelConfig>;
};

export type DefaultsPatch = Partial<DefaultsConfig>;
export type HarnessPatch = Partial<HarnessConfig> & { _unset?: Array<(typeof HARNESS_UNSETTABLE_FIELDS)[number]> };
export type ModelPatch = Partial<ModelConfig> & { _unset?: Array<(typeof MODEL_UNSETTABLE_FIELDS)[number]> };
export type PresetPatch = Partial<Omit<PresetConfig, "roles">> & {
  roles?: Record<string, Partial<PresetRole> | null>;
};

// Entity values stay `unknown` here so one malformed entity (for example `models.broken = false`) cannot fail the whole
// file; the resolver checks each entity on its own and quarantines only the broken one.
const entityOverrides = z.record(z.string(), z.unknown());

// Validate entities after merging, so an override only has to supply changed fields.
export const OverridesSchema = z.strictObject({
  schema_version: z.literal(1).optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
  aliases: z.record(z.string(), z.unknown()).optional(),
  harnesses: entityOverrides.optional(),
  models: entityOverrides.optional(),
  presets: entityOverrides.optional(),
});

export type ConfigOverrides = z.output<typeof OverridesSchema>;
