export const DRIVER_KINDS = [
  "claude",
  "codex",
  "dsh",
  "pi",
  "antigravity",
  "opencode",
  "gemini",
  "cursor",
  "grok",
  "kiro",
  "fx",
  "muse",
  "copilot",
  "droid",
  "qwen",
  "kimi",
  "vibe",
] as const;

export type DriverKind = (typeof DRIVER_KINDS)[number];
export type DriverContract = "verified" | "experimental";
export type PromptDelivery = "stdin" | "file" | "argv";
export type EffortSupport = "native" | "model-variant" | "none";
export type McpIsolation = "flag" | "config" | "none";

/** What a driver's adapter actually reads from the harness and model config; keep in sync with `src/adapters`. */
export interface DriverCapabilities {
  /** The adapter passes `harness.profile` to the CLI. */
  readonly supportsProfile: boolean;
  /** The adapter reads `harness.default_upstream_provider`. */
  readonly usesUpstreamProvider: boolean;
  /** The adapter reads `model.cli_provider`. */
  readonly usesCliProvider: boolean;
  /** The CLI needs `provider/model`, from `cli_provider` or a `/` inside `cli_model`. */
  readonly requiresProviderPrefix?: boolean;
  /** Effort levels suggested for a new model on this driver. */
  readonly defaultEfforts: readonly string[];
}

interface DriverBaseMetadata {
  readonly kind: DriverKind;
  readonly label: string;
  readonly defaultBinary: string;
  readonly contract: DriverContract;
  readonly nativeVendor?: string;
  readonly promptDelivery: PromptDelivery;
  readonly effortSupport: EffortSupport;
  readonly mcpIsolation: McpIsolation;
  readonly probeTimeoutMs: number;
  readonly supportsReadonly: boolean;
  readonly writePermissionModes?: readonly string[];
  readonly skillDir?: {
    readonly envVar?: string;
    /** Path segments appended to home directory when envVar is unset. */
    readonly homeSegments: readonly string[];
    /** Subdirectory appended to the resolved config directory (usually "skills"). */
    readonly subDir: string;
    /** Always include in `agrmcp skill install --target all` even if parent dir doesn't exist yet. */
    readonly coreTarget?: boolean;
  };
}

export type DriverMetadata = DriverBaseMetadata & DriverCapabilities;

const DRIVER_BASE_METADATA: Record<DriverKind, DriverBaseMetadata> = {
  claude: {
    kind: "claude",
    label: "Claude Code",
    defaultBinary: "claude",
    contract: "verified",
    nativeVendor: "anthropic",
    promptDelivery: "stdin",
    effortSupport: "native",
    mcpIsolation: "flag",
    probeTimeoutMs: 4000,
    supportsReadonly: true,
    writePermissionModes: ["acceptEdits", "auto"],
    skillDir: { envVar: "CLAUDE_CONFIG_DIR", homeSegments: [".claude"], subDir: "skills", coreTarget: true },
  },
  codex: {
    kind: "codex",
    label: "Codex CLI",
    defaultBinary: "codex",
    contract: "verified",
    nativeVendor: "openai",
    promptDelivery: "stdin",
    effortSupport: "native",
    mcpIsolation: "config",
    probeTimeoutMs: 4000,
    supportsReadonly: true,
    skillDir: { envVar: "CODEX_HOME", homeSegments: [".codex"], subDir: "skills", coreTarget: true },
  },
  dsh: {
    kind: "dsh",
    label: "DeepSeek Harness",
    defaultBinary: "dsh",
    contract: "verified",
    nativeVendor: "deepseek",
    promptDelivery: "stdin",
    effortSupport: "native",
    mcpIsolation: "config",
    probeTimeoutMs: 4000,
    supportsReadonly: true,
    skillDir: { homeSegments: [".dsh"], subDir: "skills", coreTarget: true },
  },
  pi: {
    kind: "pi",
    label: "Pi",
    defaultBinary: "pi",
    contract: "verified",
    promptDelivery: "stdin",
    effortSupport: "native",
    mcpIsolation: "flag",
    probeTimeoutMs: 4000,
    supportsReadonly: true,
    skillDir: { envVar: "PI_CODING_AGENT_DIR", homeSegments: [".pi", "agent"], subDir: "skills", coreTarget: true },
  },
  antigravity: {
    kind: "antigravity",
    label: "Antigravity CLI",
    defaultBinary: "agy",
    contract: "verified",
    nativeVendor: "google",
    promptDelivery: "argv",
    effortSupport: "native",
    mcpIsolation: "none",
    probeTimeoutMs: 8000,
    supportsReadonly: true,
    writePermissionModes: ["accept-edits", "auto"],
    skillDir: { homeSegments: [".gemini", "antigravity"], subDir: "skills" },
  },
  opencode: {
    kind: "opencode",
    label: "OpenCode",
    defaultBinary: "opencode",
    contract: "verified",
    promptDelivery: "stdin",
    effortSupport: "model-variant",
    mcpIsolation: "config",
    probeTimeoutMs: 8000,
    supportsReadonly: true,
    skillDir: { homeSegments: [".config", "opencode"], subDir: "skills" },
  },
  gemini: {
    kind: "gemini",
    label: "Gemini CLI",
    defaultBinary: "gemini",
    contract: "verified",
    nativeVendor: "google",
    promptDelivery: "stdin",
    effortSupport: "none",
    mcpIsolation: "flag",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
    writePermissionModes: ["auto_edit", "yolo"],
    skillDir: { homeSegments: [".gemini"], subDir: "skills" },
  },
  cursor: {
    kind: "cursor",
    label: "Cursor CLI",
    defaultBinary: "cursor-agent",
    contract: "experimental",
    promptDelivery: "argv",
    effortSupport: "none",
    // Cursor CLI has no flag that turns MCP servers off (`--approve-mcps` only auto-approves them), so none is passed.
    mcpIsolation: "none",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
    skillDir: { homeSegments: [".cursor"], subDir: "skills" },
  },
  grok: {
    kind: "grok",
    label: "Grok Build",
    defaultBinary: "grok",
    contract: "experimental",
    nativeVendor: "xai",
    promptDelivery: "argv",
    effortSupport: "none",
    mcpIsolation: "none",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
  },
  kiro: {
    kind: "kiro",
    label: "Kiro CLI",
    defaultBinary: "kiro-cli",
    contract: "experimental",
    promptDelivery: "argv",
    effortSupport: "none",
    mcpIsolation: "none",
    probeTimeoutMs: 6000,
    supportsReadonly: true,
    skillDir: { homeSegments: [".kiro"], subDir: "skills" },
  },
  fx: {
    kind: "fx",
    label: "Vercel fx",
    defaultBinary: "fx",
    contract: "experimental",
    promptDelivery: "argv",
    effortSupport: "native",
    mcpIsolation: "none",
    probeTimeoutMs: 5000,
    supportsReadonly: false,
  },
  muse: {
    kind: "muse",
    label: "Muse Code",
    defaultBinary: "muse",
    contract: "experimental",
    nativeVendor: "meta",
    promptDelivery: "file",
    effortSupport: "none",
    mcpIsolation: "none",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
  },
  copilot: {
    kind: "copilot",
    label: "GitHub Copilot CLI",
    defaultBinary: "copilot",
    contract: "experimental",
    promptDelivery: "argv",
    effortSupport: "none",
    // `--disable-builtin-mcps` only drops the built-in servers; user-configured servers are denied by name, best effort.
    mcpIsolation: "none",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
    skillDir: { homeSegments: [".copilot"], subDir: "skills" },
  },
  droid: {
    kind: "droid",
    label: "Factory Droid",
    defaultBinary: "droid",
    contract: "experimental",
    promptDelivery: "file",
    effortSupport: "native",
    mcpIsolation: "none",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
    writePermissionModes: ["low", "medium", "high"],
    skillDir: { homeSegments: [".factory"], subDir: "skills" },
  },
  qwen: {
    kind: "qwen",
    label: "Qwen Code",
    defaultBinary: "qwen",
    contract: "experimental",
    nativeVendor: "alibaba",
    promptDelivery: "stdin",
    effortSupport: "none",
    mcpIsolation: "flag",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
    writePermissionModes: ["auto-edit", "yolo"],
    skillDir: { homeSegments: [".qwen"], subDir: "skills" },
  },
  kimi: {
    kind: "kimi",
    label: "Kimi CLI",
    defaultBinary: "kimi",
    contract: "experimental",
    nativeVendor: "moonshot",
    promptDelivery: "argv",
    effortSupport: "none",
    mcpIsolation: "none",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
    skillDir: { homeSegments: [".kimi"], subDir: "skills" },
  },
  vibe: {
    kind: "vibe",
    label: "Mistral Vibe",
    defaultBinary: "vibe",
    contract: "experimental",
    nativeVendor: "mistral",
    promptDelivery: "argv",
    effortSupport: "none",
    mcpIsolation: "none",
    probeTimeoutMs: 5000,
    supportsReadonly: true,
    skillDir: { homeSegments: [".vibe"], subDir: "skills" },
  },
};

const REASONING_EFFORTS = ["low", "medium", "high"] as const;
/** DSH (DeepSeek) has no "medium": its stock models offer these levels, as the built-in catalog lists them. */
const DSH_EFFORTS = ["off", "low", "high", "max"] as const;
const NO_EFFORTS = ["default"] as const;

const NO_CAPABILITIES = { supportsProfile: false, usesUpstreamProvider: false, usesCliProvider: false } as const;

const DRIVER_CAPABILITIES: Record<DriverKind, DriverCapabilities> = {
  claude: { ...NO_CAPABILITIES, defaultEfforts: REASONING_EFFORTS },
  codex: { ...NO_CAPABILITIES, supportsProfile: true, defaultEfforts: REASONING_EFFORTS },
  dsh: { supportsProfile: true, usesUpstreamProvider: true, usesCliProvider: true, defaultEfforts: DSH_EFFORTS },
  pi: { ...NO_CAPABILITIES, usesUpstreamProvider: true, usesCliProvider: true, defaultEfforts: REASONING_EFFORTS },
  antigravity: { ...NO_CAPABILITIES, defaultEfforts: REASONING_EFFORTS },
  opencode: { ...NO_CAPABILITIES, usesCliProvider: true, requiresProviderPrefix: true, defaultEfforts: NO_EFFORTS },
  gemini: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
  cursor: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
  grok: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
  kiro: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
  fx: { ...NO_CAPABILITIES, usesCliProvider: true, defaultEfforts: REASONING_EFFORTS },
  muse: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
  copilot: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
  droid: { ...NO_CAPABILITIES, defaultEfforts: REASONING_EFFORTS },
  qwen: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
  kimi: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
  vibe: { ...NO_CAPABILITIES, defaultEfforts: NO_EFFORTS },
};

export const DRIVER_METADATA: Record<DriverKind, DriverMetadata> = Object.fromEntries(
  DRIVER_KINDS.map((kind) => [kind, { ...DRIVER_BASE_METADATA[kind], ...DRIVER_CAPABILITIES[kind] }]),
) as Record<DriverKind, DriverMetadata>;

export function isDriverKind(value: string): value is DriverKind {
  return (DRIVER_KINDS as readonly string[]).includes(value);
}

/**
 * Spellings an adapter still accepts and normalizes but the UI does not offer; they validate without being listed in
 * `writePermissionModes`. The Antigravity adapter maps `acceptEdits` (Claude's spelling) to `accept-edits`.
 */
export const LEGACY_WRITE_PERMISSION_MODES: Partial<Record<DriverKind, readonly string[]>> = {
  antigravity: ["acceptEdits"],
};

/** True only for the driver's own executable looked up by bare name; a path or a renamed binary is a user-made wrapper. */
export function isStockBinary(driver: DriverKind, binary: string): boolean {
  return !/[\\/]/.test(binary) && binary === DRIVER_METADATA[driver].defaultBinary;
}
