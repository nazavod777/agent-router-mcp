import { DRIVER_KINDS, DRIVER_METADATA, type DriverKind } from "../drivers.js";
import type { ModelTier, RunMode } from "../types.js";

export interface RoleDefinition {
  id: string;
  defaultMode: RunMode;
  preferredTier: ModelTier;
  category: "author" | "review" | "analysis" | "support";
  description: string;
  keywords: RegExp[];
}

const definitions = {
  architecture: {
    defaultMode: "readonly", preferredTier: "deep", category: "analysis",
    description: "Design system boundaries, contracts, and implementation plans.",
    keywords: [/архитектур|контракт|план изменений/i, /architect|system design|api design|implementation plan/i],
  },
  research: {
    defaultMode: "readonly", preferredTier: "standard", category: "analysis",
    description: "Find and synthesize evidence from primary sources.",
    keywords: [/исследован|анализ|сводк|первичный проход|источник/i, /research|literature|primary sources?|survey/i],
  },
  codebase_qa: {
    defaultMode: "readonly", preferredTier: "standard", category: "analysis",
    description: "Answer questions about how an existing codebase works.",
    keywords: [/как работает|объясн.{0,12}код|вопрос.{0,12}код|поиск по коду/i, /codebase|code comprehension|code navigation|call flow/i],
  },
  repo_recon: {
    defaultMode: "readonly", preferredTier: "light", category: "support",
    description: "Map a repository and locate entry points, conventions, and checks.",
    keywords: [/разведк|обзор репозитор|точк.{0,4} входа|первичный проход/i, /repo(?:sitory)? recon|repo survey|onboarding|entry ?points?/i],
  },
  ui_review: {
    defaultMode: "readonly", preferredTier: "specialist", category: "analysis",
    description: "Inspect UI layout, interaction, and accessibility.",
    keywords: [/ревью интерфейс|визуальн|доступност|проверка в[ёе]рстки/i, /ui review|visual (?:review|qa)|accessibility|a11y|usability/i],
  },
  root_cause: {
    defaultMode: "readonly", preferredTier: "deep", category: "analysis",
    description: "Trace a failure or regression to its underlying cause.",
    keywords: [/первопричин|корнев.{0,8} причин|диагност|регресси/i, /root cause|failure analysis|diagnos|regression|traceback/i],
  },
  review: {
    defaultMode: "readonly", preferredTier: "deep", category: "review",
    description: "Review a change for defects, regressions, and missing validation.",
    keywords: [/ревью|проверка изменений|при[ёе]мк/i, /review|pull request|pr review|release validation/i],
  },
  second_opinion: {
    defaultMode: "readonly", preferredTier: "deep", category: "review",
    description: "Give an independent assessment of a proposed change or decision.",
    keywords: [/второе мнение|независим.{0,12}(?:оценк|проверк)|перепроверк/i, /second opinion|independent (?:review|assessment)|cross[- ]vendor/i],
  },
  security: {
    defaultMode: "readonly", preferredTier: "deep", category: "review",
    description: "Audit trust boundaries, access control, and sensitive data handling.",
    keywords: [/безопасн|аудит|уязвим|авторизац/i, /security|audit|vulnerabilit|threat model|access control/i],
  },
  test_strategy: {
    defaultMode: "readonly", preferredTier: "deep", category: "analysis",
    description: "Identify test coverage gaps and prioritize regression scenarios.",
    keywords: [/план тест|стратеги.{0,12}тест|покрыти|сценари.{0,12}проверк/i, /test strategy|test plan|test design|coverage|edge cases/i],
  },
  performance: {
    defaultMode: "readonly", preferredTier: "deep", category: "analysis",
    description: "Measure and diagnose performance or resource bottlenecks.",
    keywords: [/производительност|профилирован|быстродейств|задержк|бенчмарк/i, /performance|profiling|benchmark|latency|throughput|bottleneck/i],
  },
  data_sql: {
    defaultMode: "readonly", preferredTier: "standard", category: "analysis",
    description: "Analyze data, SQL queries, schemas, and query plans.",
    keywords: [/данн|запрос|схем.{0,8} (?:баз|таблиц)|выборк/i, /\bsql\b|query plan|database|data analysis|analytics/i],
  },
  long_context: {
    defaultMode: "readonly", preferredTier: "deep", category: "analysis",
    description: "Synthesize large documents, transcripts, or codebases.",
    keywords: [/длинн.{0,8} контекст|больш.{0,8} (?:объ[ёе]м|документ)|многофайлов/i, /long context|large (?:repo|codebase|document)|multi[- ]file|context window/i],
  },
  implementation: {
    defaultMode: "write", preferredTier: "standard", category: "author",
    description: "Implement features and backend changes.",
    keywords: [/реализац|рефакторинг|фич|по плану|тест|б[эе]кенд/i, /implement|feature|backend|coding/i],
  },
  frontend: {
    defaultMode: "write", preferredTier: "deep", category: "author",
    description: "Implement frontend behavior and application state.",
    keywords: [/фронтенд|в[ёе]рстк|компонент|клиентск.{0,8} логик/i, /front[- ]?end|components?|client[- ]side|react|css/i],
  },
  ui: {
    defaultMode: "write", preferredTier: "specialist", category: "author",
    description: "Build and polish user interfaces and layouts.",
    keywords: [/в[ёе]рстк|фронтенд|интерфейс|макет/i, /\bui\b|front[- ]?end|interface|layout|visual polish/i],
  },
  ui_design: {
    defaultMode: "write", preferredTier: "specialist", category: "author",
    description: "Create UI designs, prototypes, and design system components.",
    keywords: [/дизайн|макет|прототип|типографик/i, /ui design|ux design|wireframe|mockup|prototype|design system/i],
  },
  deep_refactor: {
    defaultMode: "write", preferredTier: "deep", category: "author",
    description: "Make coordinated refactors and migrations across modules.",
    keywords: [/рефакторинг|миграци|перестройк|декомпозици/i, /refactor|migration|cross[- ]module|codemod/i],
  },
  debugging: {
    defaultMode: "write", preferredTier: "deep", category: "author",
    description: "Reproduce and fix defects and regressions.",
    keywords: [/дебаг|отладк|баг|корнев|регресси/i, /debug|bug fix|regression|troubleshoot/i],
  },
  testing: {
    defaultMode: "write", preferredTier: "standard", category: "author",
    description: "Implement and maintain automated tests and fixtures.",
    keywords: [/тест|фикстур|автотест/i, /\btests?\b|testing|fixtures?|\be2e\b|assertions?/i],
  },
  devops: {
    defaultMode: "write", preferredTier: "standard", category: "author",
    description: "Maintain build, CI, deployment, and operations tooling.",
    keywords: [/инфраструктур|депло|сборк|терминал|эксплуатац/i, /devops|deploy|\bci\b|pipeline|shell|terminal|operations/i],
  },
  writing: {
    defaultMode: "write", preferredTier: "specialist", category: "author",
    description: "Write or edit documentation, product copy, and other prose.",
    keywords: [/текст|копирайт|документ|редактур/i, /writing|documentation|readme|copywriting|proofread/i],
  },
  quick: {
    defaultMode: "write", preferredTier: "light", category: "author",
    description: "Handle small, routine edits and simple triage.",
    keywords: [/быстр|мелк|бойлерплейт|механическ|триаж/i, /quick|boilerplate|triage|small edits?|mechanical/i],
  },
} satisfies Record<string, Omit<RoleDefinition, "id">>;

export const ROLES: Record<string, RoleDefinition> = Object.fromEntries(
  Object.entries(definitions).map(([id, role]) => [id, { id, ...role }]),
);

const ROLE_ALIASES: Record<string, string> = {
  planning: "architecture",
  backend: "implementation",
  refactoring: "deep_refactor",
  migration: "deep_refactor",
  docs: "writing",
  triage: "quick",
  sql_data: "data_sql",
  data_analysis: "data_sql",
  security_review: "security",
  test_implementation: "testing",
  devops_terminal: "devops",
  ops_diagnosis: "devops",
  release_validation: "review",
};

export function resolveRoleId(taskType: string): string {
  const id = taskType.trim().toLowerCase();
  return Object.hasOwn(ROLE_ALIASES, id) ? ROLE_ALIASES[id] : id;
}

export function getRoleDefinition(taskType: string): RoleDefinition | undefined {
  const id = resolveRoleId(taskType);
  return Object.hasOwn(ROLES, id) ? ROLES[id] : undefined;
}

export function defaultModeForRole(taskType: string): RunMode {
  return getRoleDefinition(taskType)?.defaultMode ?? "readonly";
}

export function preferredTierForRole(taskType: string): ModelTier | undefined {
  return getRoleDefinition(taskType)?.preferredTier;
}

export function keywordsForRole(taskType: string): RegExp[] {
  const id = resolveRoleId(taskType);
  const keywords = getRoleDefinition(id)?.keywords ?? [];
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return keywords;
  const startBoundary = /^\w/.test(id) ? "\\b" : "";
  const endBoundary = /\w$/.test(id) ? "\\b" : "";
  return [...keywords, new RegExp(`${startBoundary}${escaped}${endBoundary}`, "i")];
}

const VENDOR_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["anthropic", /^(?:anthropic|claude|opus|sonnet|haiku)(?:[-_.:]|$)/],
  ["openai", /^(?:openai|gpt|chatgpt|o[134])(?:[-_.:]|$)/],
  ["deepseek", /^deepseek(?:[-_.:]|$)/],
  ["zhipu", /^(?:zhipu|z\.ai|zai|glm)(?:[-_.:]|$)/],
  ["moonshot", /^(?:moonshot|kimi)(?:[-_.:]|$)/],
  ["alibaba", /^(?:alibaba|dashscope|qwen)/],
  ["google", /^(?:google|gemini)/],
  ["minimax", /^minimax/],
  ["xiaomi", /^(?:xiaomi|mimo)/],
  ["xai", /^(?:xai|grok)/],
  ["meta", /^(?:meta|llama|muse)/],
  ["mistral", /^(?:mistral|devstral|codestral|vibe)/],
  ["amazon", /^(?:amazon|aws|nova)/],
];

const NATIVE_VENDOR: Partial<Record<DriverKind, string>> = Object.fromEntries(
  DRIVER_KINDS.flatMap((kind) => {
    const vendor = DRIVER_METADATA[kind].nativeVendor;
    return vendor ? [[kind, vendor]] : [];
  }),
);

// "agy" is the Antigravity binary name, used as a model-id prefix in the catalog.
const DRIVER_PREFIX = new RegExp(`^(?:${[...DRIVER_KINDS, "agy"].join("|")})-`);

function matchVendor(id: string): string | undefined {
  return VENDOR_PATTERNS.find(([, pattern]) => pattern.test(id))?.[0];
}

function knownVendor(value: string): string | undefined {
  for (const part of value.split("/").reverse()) {
    // Vendor names such as "claude-" or "kimi-" double as driver prefixes, so try the raw id first.
    const match = matchVendor(part) ?? matchVendor(part.replace(DRIVER_PREFIX, ""));
    if (match) return match;
  }
}

/** Returned when no vendor can be determined; it is never counted as an independent vendor. */
export const UNKNOWN_VENDOR = "unknown";

/** True only for a vendor that was actually identified; "unknown" (or blank) can never confirm cross-vendor independence. */
export function isKnownVendor(vendor: string | undefined): vendor is string {
  const label = vendor?.trim().toLowerCase();
  return label !== undefined && label !== "" && label !== UNKNOWN_VENDOR;
}

/** Gateways that serve many vendors' models: their name says where a model is hosted, not who made it. */
const AGGREGATOR_PROVIDERS: ReadonlySet<string> = new Set([
  "openrouter", "requesty", "opencode-go", "opencode", "deepinfra", "together", "fireworks", "bedrock", "vertex", "azure",
  "litellm", "ollama", "lmstudio", "vercel", "cloudflare", "groq",
]);

export function isAggregatorProvider(provider: string): boolean {
  return AGGREGATOR_PROVIDERS.has(provider.trim().toLowerCase());
}

/**
 * `defaultUpstreamProvider` is the harness-level provider a model inherits when it sets no `cli_provider` of its own
 * (for example a Pi harness routed through `openrouter`); callers with a harness at hand must pass it.
 */
export function inferVendorFamily(
  model: { harness: string; cli_model: string; cli_provider?: string; vendor_family?: string },
  driver: DriverKind,
  defaultUpstreamProvider?: string,
): string {
  const explicit = model.vendor_family?.trim();
  if (explicit) return explicit.toLowerCase();
  const modelId = model.cli_model.trim().toLowerCase();
  // Only drivers that actually route through `default_upstream_provider` inherit it; for the others it is not the model's host.
  const inherited = DRIVER_METADATA[driver].usesUpstreamProvider ? defaultUpstreamProvider : undefined;
  const provider = (model.cli_provider ?? inherited)?.trim().toLowerCase() ?? "";
  const harness = model.harness.trim().toLowerCase();
  // "openrouter/some-model" names its gateway inside cli_model itself.
  const modelPrefix = modelId.includes("/") ? modelId.slice(0, modelId.indexOf("/")) : "";
  if ((provider && AGGREGATOR_PROVIDERS.has(provider)) || (modelPrefix && AGGREGATOR_PROVIDERS.has(modelPrefix))) {
    // The provider only hosts the model, so the vendor comes from the model name alone.
    return knownVendor(modelId) ?? UNKNOWN_VENDOR;
  }
  return knownVendor(modelId) ??
    knownVendor(provider) ??
    knownVendor(harness) ??
    (provider || NATIVE_VENDOR[driver] || harness || driver);
}
