/** Name of the installed command-line binary; every help text, usage line, error prefix and fix-it hint derives from it. */
export const CLI_NAME = "agrmcp";

/** Binary names shipped before the rename. Never recommended; only recognized when cleaning up or migrating old installs. */
export const LEGACY_CLI_NAMES = ["orch", "orchestrator-mcp", "orchestrate-settings"] as const;
