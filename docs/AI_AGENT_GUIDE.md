# AI Agent Guide — agent-router-mcp

This guide is written for AI coding agents (large or small) that install, configure, or customize `agent-router-mcp` for a user. Every command below matches the real code in this repository. Follow the steps literally.

## 1. How to use this guide

1. Decide which job you are doing (see [`AGENTS.md`](../AGENTS.md)):
   - **Branch A — user setup / customization:** jump directly to the matching playbook in [§4](#4-playbooks-p1p10). Do not edit repo files.
   - **Branch B — changing this repo's code or defaults:** follow the contributor rules in `AGENTS.md`.
2. Every playbook has the same shape: **Goal → Preconditions → Commands → Expected output → Verify → Undo/Stop**. Do the steps in order. If a step's expected output does not match, stop and go to [§5 Troubleshooting](#5-troubleshooting-symptom--cause--fix).
3. Rules that always apply:
   - **STRICT OPT-IN:** never invoke `orch_*` MCP tools (`orch_catalog`, `orch_plan_preview`, `orch_run`, `orch_status`, `orch_logs`, `orch_cancel`) unless the user explicitly asked to use the orchestrator, agent-router, multi-model routing, swarm, or `/orchestrate`. Installing or configuring the project is NOT a request to orchestrate. Only exception: the verification step in P9 may call `orch_catalog` and `orch_plan_preview` when the user explicitly asked you to set up or verify the orchestrator; never call them unasked in ordinary sessions.
   - Talk to the user in the user's language. Keep commands, TOML keys, file paths, and JSON exactly as written here (English, canonical).
   - Never ask for, print, or store CLI credentials. Each CLI logs in by itself; tell the user which login command to run.
   - Never commit or push unless the user asked.

Notation used below:

- `<clone>` = absolute path of the cloned repository (for example `/home/alice/agent-router-mcp`). Get it with `cd <clone> && pwd`.
- `agrmcp` = the `agrmcp` command after `npm link`, or `node <clone>/dist/cli/main.js` without `npm link`. Both behave the same. `agrmcp` is the only CLI binary; the legacy `orch`, `orchestrator-mcp`, and `orchestrate-settings` commands no longer exist.

## 2. Project & runtime file map

Never guess config locations. Run this first and use the printed paths:

```bash
agrmcp config path
# Catalog: <clone>/defaults/catalog.toml
# User config: /home/<user>/.config/orchestrator-mcp/models.toml
# State: /home/<user>/.local/state/orchestrator-mcp
```

| Path | What it is | Edit for personal setup? | Edit for repo PR? |
|---|---|---|---|
| `defaults/catalog.toml` | Built-in catalog: harnesses, models, aliases, presets, `[defaults]` | **NO, never** | Yes (Branch B) |
| User `models.toml` (default `~/.config/orchestrator-mcp/models.toml`; `$XDG_CONFIG_HOME/orchestrator-mcp/models.toml`; or `$ORCH_MODELS_PATH`) | Sparse user overrides; stores only the fields you change; mode `0600` (a POSIX permission: on Windows keep the config and state directories inside your private user profile, because NTFS does not enforce it). Writes take a lock file that protects concurrent `agrmcp` writers (CLI and Settings UI); a manual edit takes no lock and is caught by the revision check just before the atomic rename (`409 Conflict`) | **Yes** — prefer `agrmcp config set` | No (personal, never commit) |
| `models.toml.bak.<timestamp>` (next to the user config) | Automatic backup created by a full reset | Read-only; copy back to restore | No |
| State dir (default `~/.local/state/orchestrator-mcp`; `$XDG_STATE_HOME/orchestrator-mcp`; or `$ORCH_STATE_DIR`) | Persistent runtime state for `runs/` (jobs, logs), `worktrees/`, and `locks/`. Automatic `runs/` pruning preserves active jobs and any run whose worktree still exists, including unmerged worktrees. | No (managed by the server) | No |
| `dist/cli/main.js` | Built CLI entry point (`agrmcp`); MCP server = `node <clone>/dist/cli/main.js mcp` | No — rebuild with `npm run build`; never copy `dist/` elsewhere | No — generated |
| `skills/orchestrate/SKILL.md` | Source of the companion orchestration skill | No | Yes; then run `agrmcp skill install` |
| Installed skill copies (`<cli-config-dir>/skills/orchestrate/SKILL.md`, e.g. `~/.claude/skills/orchestrate/SKILL.md`) | Copies made by `agrmcp skill install` | No — refresh with `agrmcp skill install` | No |
| `src/drivers.ts` | Single source of truth for the 17 `DRIVER_KINDS` and driver metadata | No | Yes |
| `src/config/schema.ts` | TOML schema (Zod): required fields and enums | No | Yes (contract change → Design Gate) |
| `src/config/ids.ts` | The one ID policy for new harness, model, preset, and alias IDs (writer, CLI, Settings UI) | No | Yes (contract change → Design Gate) |
| `src/discovery/`, `src/cli/models-cmd.ts` | Model discovery (offline readers, CLI listing probes, enrichment, preview/apply) and `agrmcp models discover`; never loaded by `agrmcp mcp`, `orch_plan_preview`, or `orch_run` | No | Yes (CLI contract change → Design Gate) |
| `src/roles/registry.ts` | The 23 canonical roles | No | Yes |
| `src/mcp/tools.ts` | MCP tool schemas and handlers | No | Yes (contract change → Design Gate) |
| `src/cli/wait-cmd.ts` | Event-driven `agrmcp wait` command | No | Yes (CLI contract change → Design Gate) |
| `src/cli/mcp-cmd.ts`, `src/cli/mcp-install.ts`, `src/cli/mcp-clients.ts` | `agrmcp setup` and `agrmcp mcp install \| status \| uninstall`: per-CLI config paths, formats, and status classification | No | Yes (CLI contract change → Design Gate) |
| `src/planner/preview.ts` | `orch_plan_preview` plan builder and warnings | No | Yes |
| `src/runtime/runner.ts` | Job runner, failover classification, cooldowns | No | Yes |
| `src/settings-ui/` | Localhost Settings Web UI | No | Yes |
| `docs/examples/*.toml` | Tested example overrides (checked by `tests/unit/docs-examples.test.ts`) | Copy into the user config | Yes (+ test expectation) |

## 3. MCP registration by client

Rules for every client:

- Build first (`npm install && npm run build`, see P1).
- Use the **absolute** node path and the **absolute** path to `<clone>/dist/cli/main.js`. GUI IDEs often do not see nvm/asdf/volta `PATH`, so a bare `node` may fail or pick an old Node.
- The server name is `orchestrator`.
- After registering, restart the client (or reload its MCP servers).

### Recommended: `agrmcp setup` (MCP + skill in one command)

`agrmcp setup` registers the MCP server **and** installs the `orchestrate` skill for each target, then reads both back to verify them. It always writes the absolute `node` path and this build's absolute `dist/cli/main.js`, so a skill can never be installed without its MCP server (and the reverse). Prefer it to the manual recipes below.

```bash
agrmcp setup --target all          # every CLI detected on this machine (`all` never touches CLIs that are not detected)
agrmcp setup --target claude       # one CLI; also comma-separated or repeated: --target claude,codex
agrmcp setup --dry-run --json      # preview: nothing is written; the Verified column shows n/a
agrmcp mcp status --check          # exit code 1 on drift; run it after setup to confirm
```

Targets: `claude`, `codex`, `dsh`, `pi`, `antigravity`, `opencode`, `gemini`, `cursor`, `grok`, `kiro`, `fx`, `muse`, `copilot`, `droid`, `qwen`, `kimi`, `vibe`, or `all`. An explicit target is always honored, even when the CLI is not detected.

`agrmcp setup` prints a table with the columns `Client  MCP  Skill  Verified  Config` (MCP and Skill each show `<status before> -> <action>`); with `--json` it returns `{ command, dry_run, force, node_path, entry_path, ok, targets[] }`. The exit code is `1` when any target failed.

`agrmcp mcp` manages the MCP entry alone:

| Command | What it does |
|---|---|
| `agrmcp mcp install [--target <cli>\|all] [--dry-run] [--force] [--json]` | Adds or repairs the `orchestrator` entry. Idempotent: a `current` entry is left unchanged. Writes atomically, keeps a backup of the previous file, and reads the result back. A `disabled` or `conflict` entry (the name `orchestrator` is used by something else) is skipped unless you pass `--force`, and the command then exits `1` for `conflict`; an `invalid` (unparsable) config is never touched and also exits `1`. Fails with a build hint if `dist/cli/main.js` does not exist |
| `agrmcp mcp status [--target <cli>\|all] [--check] [--json]` | Shows per CLI whether it is detected and the MCP and skill status. `--check` exits `1` on drift: any MCP status other than `current` (`missing`, `stale`, `disabled`, `conflict`, or `invalid`), or a skill that is missing or `outdated`; a disabled, foreign, or invalid MCP registration fails `--check` even when the skill is current. `--json` returns `{ command, node_path, entry_path, drift, targets[] }` |
| `agrmcp mcp uninstall [--target <cli>\|all] [--dry-run] [--force] [--json]` | Removes only the `orchestrator` MCP entry (the installed skill copy stays). An entry that does not look like agent-router-mcp is left alone unless you pass `--force` |

MCP status values: `current` (points at this build's `node` + `main.js`), `missing` (no entry), `stale` (an agent-router-mcp entry that points at another node or build, for example after you moved the clone), `disabled` (entry present but switched off), `conflict` (a different server already uses the name `orchestrator`), `invalid` (config cannot be parsed; fix the syntax first). Skill status values: `current`, `outdated`, `missing`.

Config file that `agrmcp mcp` edits for each CLI (override variables in parentheses; JSON and `.jsonc` edits keep comments, key order, and trailing commas untouched, and OpenCode `.jsonc` is supported):

| CLI | Config file |
|---|---|
| `claude` | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json`), user scope |
| `codex` | `~/.codex/config.toml` (`$CODEX_HOME`); MCP registration edits the top-level `mcp_servers` table only; a top-level `profile = "<name>"` is honored by CLI limit discovery (`src/config/cli-limits.ts`), not by MCP registration |
| `dsh` | `~/.dsh/cordis.patch.yml` (`$DSH_HOME`), entry id `mcp-orchestrator` |
| `pi` | `~/.pi/agent/mcp.json` (`$PI_CODING_AGENT_DIR`) |
| `antigravity` | `~/.gemini/config/mcp_config.json` (`$GEMINI_HOME` replaces `~/.gemini`); the legacy `~/.gemini/antigravity/mcp_config.json` is used only while the new file does not exist. T3 Code profiles are covered too (`antigravity:t3:<id>`, see "Isolated / ACP host config directories") |
| `opencode` | `~/.config/opencode/opencode.json` or `opencode.jsonc` (`$XDG_CONFIG_HOME`, `$OPENCODE_CONFIG_DIR`; an explicit `$OPENCODE_CONFIG` file wins) |
| `gemini` | `~/.gemini/settings.json` (`$GEMINI_CLI_HOME/.gemini`) |
| `cursor` | `~/.cursor/mcp.json` |
| `grok` | `~/.grok/config.toml` (`$GROK_HOME`) |
| `kiro` | `~/.kiro/settings/mcp.json` |
| `fx` | `~/.fx/mcp.json` (`$FX_HOME`) |
| `muse` | `~/.config/muse/settings.json` (`$XDG_CONFIG_HOME`) |
| `copilot` | `~/.copilot/mcp-config.json` (`$COPILOT_HOME`) |
| `droid` | `~/.factory/mcp.json` |
| `qwen` | `~/.qwen/settings.json` (`$QWEN_HOME`) |
| `kimi` | `~/.kimi-code/mcp.json` (`$KIMI_CODE_HOME`); the legacy `~/.kimi/mcp.json` is used only while `~/.kimi-code` does not exist |
| `vibe` | `~/.vibe/config.toml` (`$VIBE_HOME`) |

### Manual registration

Use the recipes below only when `agrmcp setup` cannot be used (for example an unsupported client, or a host-private config directory handled in the next sections). Get both absolute paths once:

```bash
cd <clone>
NODE_BIN="$(command -v node)"; MAIN_JS="$PWD/dist/cli/main.js"
echo "$NODE_BIN"; echo "$MAIN_JS"      # both must be absolute paths
```

### Claude Code

```bash
claude mcp add -s user orchestrator -- "$(command -v node)" "<clone>/dist/cli/main.js" mcp
claude mcp list                        # expect: orchestrator ... connected
```

Use `-s user` (long form `--scope user`) so the server is available in every project. Without it, `claude mcp add` registers the server only for the current project (local scope) and it is invisible from other directories.

### Codex CLI

```bash
codex mcp add orchestrator -- "$(command -v node)" "<clone>/dist/cli/main.js" mcp
codex mcp list                         # expect: orchestrator
```

### Gemini CLI

```bash
gemini mcp add --scope user orchestrator "$(command -v node)" "<clone>/dist/cli/main.js" mcp
gemini mcp list                        # expect: orchestrator
```

Use `--scope user`; without it Gemini CLI registers the server only for the current project (default scope is `project`). Do not put `--` before the command: `gemini mcp add` then fails with `Not enough non-option arguments`.

### Antigravity (`agy`)

```bash
agy mcp add orchestrator -- "$(command -v node)" "<clone>/dist/cli/main.js" mcp
```

Antigravity stores user-level MCP servers in `~/.gemini/config/mcp_config.json` (legacy location: `~/.gemini/antigravity/mcp_config.json`). `$GEMINI_HOME` replaces `~/.gemini` for Antigravity. `agrmcp mcp install --target antigravity` edits whichever file applies and also every discovered T3 Code profile (see "Isolated / ACP host config directories"); `--target antigravity:primary` repairs only the primary location.

### OpenCode

`opencode mcp add` is interactive. Non-interactive alternative: add this block to `~/.config/opencode/opencode.json` or `opencode.jsonc` (merge with existing keys; replace both paths with the real absolute values):

```json
{
  "mcp": {
    "servers": {
      "orchestrator": {
        "type": "local",
        "command": ["/abs/path/to/node", "/abs/path/to/agent-router-mcp/dist/cli/main.js", "mcp"],
        "enabled": true
      }
    }
  }
}
```

This is the OpenCode V2 layout (`mcp.servers.orchestrator`). OpenCode V1 keeps servers directly under `mcp` (`mcp.orchestrator`, same entry body); `agrmcp mcp install` follows whichever layout your existing file already uses and writes V2 into a new file. `opencode.jsonc` (comments, trailing commas) is read and edited in place without losing the comments.

### Pi

```bash
pi mcp add orchestrator -- "$(command -v node)" "<clone>/dist/cli/main.js" mcp
```

Pi 0.99.0 and newer has a built-in MCP client that reads `~/.pi/agent/mcp.json` (`$PI_CODING_AGENT_DIR/mcp.json`); `agrmcp mcp install --target pi` writes the `mcpServers.orchestrator` entry there.

### DeepSeek Harness (`dsh`)

Add to `~/.dsh/cordis.patch.yml` (replace both paths with real absolute values):

```yaml
- insert:
    - id: mcp-orchestrator
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: orchestrator
        transport: stdio
        command: /abs/path/to/node
        args: [/abs/path/to/agent-router-mcp/dist/cli/main.js, mcp]
```

`agrmcp mcp install --target dsh` writes this same entry (id `mcp-orchestrator`) into `~/.dsh/cordis.patch.yml` and updates it in place on later runs. Verify the merged config: `dsh --profile <profile> --dump-config`.

### Generic `mcp.json` (Cursor, VS Code, Windsurf, Zed, JetBrains, Claude Desktop)

Put this into the client's MCP config file (the file name and location depend on the client). **VS Code uses the top-level key `"servers"`, not `"mcpServers"`, and Zed uses `"context_servers"`**; keep the inner object the same. Use the absolute path to `node` (`$(command -v node)`; in Windows PowerShell `(Get-Command node).Source`), never a bare `node`, because GUI clients often miss nvm/asdf `PATH`:

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/agent-router-mcp/dist/cli/main.js", "mcp"]
    }
  }
}
```

After `npm link` you may use `"command": "/abs/path/to/agrmcp"` with `"args": ["mcp"]` instead. Existing legacy entries (`orchestrator-mcp`, `orch mcp`) in CLI configs are migrated by `agrmcp setup` without `--force`. Without `npm link`, the direct form is `node /abs/path/to/agent-router-mcp/dist/cli/main.js <subcommand>` (for example `... main.js mcp`, `... main.js doctor`); wherever this guide writes `agrmcp`, either spelling works.

### Isolated / ACP host config directories

Some hosts (T3 Code, Zed ACP agents, IDE extensions) launch the CLI with a **private config directory** instead of your normal one. Then MCP servers and skills you registered in the terminal are invisible inside the host.

| CLI | Private-dir mechanism | Default dir |
|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` env var | `~/.claude` |
| Codex CLI | `CODEX_HOME` env var | `~/.codex` |
| Pi | `PI_CODING_AGENT_DIR` env var | `~/.pi/agent` |
| Gemini CLI | `GEMINI_CLI_HOME` env var (Gemini CLI uses `$GEMINI_CLI_HOME/.gemini`) | `~/.gemini` |
| Antigravity | `GEMINI_HOME` env var, or a T3 Code profile (below) | `~/.gemini` |
| Other CLIs | `FX_HOME` (fx), `QWEN_HOME` (qwen), `KIMI_CODE_HOME` (kimi), plus `DSH_HOME`, `GROK_HOME`, `COPILOT_HOME`, `VIBE_HOME` | `~/.fx`, `~/.qwen`, `~/.kimi-code`, ... |

**T3 Code and Antigravity:** T3 Code keeps one isolated Antigravity profile per provider instance at `<T3_HOME or ~/.t3>/userdata/providers/antigravity/<id>/config/mcp_config.json`. `agrmcp setup`, `agrmcp mcp install | status | uninstall` discover these automatically and list them as `antigravity:t3:<id>` (ids are shown by `agrmcp mcp status`). A profile is skipped when `GEMINI_HOME` already points into it (no duplicate edits), and a profile whose path is a symlink leaving the profile tree is refused (containment guard). Use `--target antigravity:t3:<id>` for one profile, `--target antigravity:primary` for the primary location only (so `--force` can never touch a profile). Other ACP hosts manage their own directory; that location is host-specific, so check the host's settings or docs.

**Diagnose:**

1. In a normal terminal, `claude mcp list` (or `codex mcp list`, ...) shows `orchestrator`.
2. Inside the host, the agent has no `orch_*` tools and no `orchestrate` skill.
3. Find the host's private directory: check the host's settings/docs, or ask the agent running inside the host to print it, for example `echo "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "$PI_CODING_AGENT_DIR" "$GEMINI_CLI_HOME"`.

**Fix** (replace `<host-dir>` with the private directory found above):

```bash
# Claude Code inside the host
CLAUDE_CONFIG_DIR="<host-dir>" claude mcp add -s user orchestrator -- "$(command -v node)" "<clone>/dist/cli/main.js" mcp
agrmcp skill install --dir "<host-dir>/skills"

# Codex CLI inside the host
CODEX_HOME="<host-dir>" codex mcp add orchestrator -- "$(command -v node)" "<clone>/dist/cli/main.js" mcp
agrmcp skill install --dir "<host-dir>/skills"

# Pi inside the host
PI_CODING_AGENT_DIR="<host-dir>" pi mcp add orchestrator -- "$(command -v node)" "<clone>/dist/cli/main.js" mcp
agrmcp skill install --dir "<host-dir>/skills"

# Gemini CLI inside the host (<host-dir> = the GEMINI_CLI_HOME root; config lives in <host-dir>/.gemini)
GEMINI_CLI_HOME="<host-dir>" gemini mcp add --scope user orchestrator "$(command -v node)" "<clone>/dist/cli/main.js" mcp
agrmcp skill install --dir "<host-dir>/.gemini/skills"
```

`agrmcp skill install --dir <path>` writes `<path>/orchestrate/SKILL.md`, so pass the **skills** directory, not the config root. Alternative: if the env var is set in your shell, `agrmcp skill install --target claude` (or `codex`, `pi`) installs into `$CLAUDE_CONFIG_DIR/skills` (resp. `$CODEX_HOME/skills`, `$PI_CODING_AGENT_DIR/skills`) automatically. Restart the host afterwards.

## 4. Playbooks (P1–P10)

### P1. Fresh install

**Goal:** a built clone, MCP server registered, skill installed, and both verified.

**Preconditions:** `git`, Node.js **22 or newer**, at least one supported coding CLI installed and logged in. Contributors who run the test suite need Node.js `>= 22.12` (or `^24` / `>= 26`), because Vitest 5 requires it; the runtime itself needs only `>= 22`.

**Commands:**

```bash
node -v                                   # must print v22.12 or newer; otherwise stop (see §5)
cd <clone>
npm install                               # not `npm ci`: no package-lock.json is committed (generating one needs registry access), so `npm ci` fails with EUSAGE
npm run build                             # creates dist/
npm link                                  # OPTIONAL: installs the single global command `agrmcp`
node "$PWD/dist/cli/main.js" doctor       # or: agrmcp doctor (after npm link)
```

Then register the MCP server **and** install the skill in one step ([§3](#3-mcp-registration-by-client)):

```bash
node "$PWD/dist/cli/main.js" setup --target all      # every CLI detected on this machine
node "$PWD/dist/cli/main.js" setup --target codex    # or one CLI only (an explicit target is always honored)
node "$PWD/dist/cli/main.js" mcp status --check      # exit code 0 = no drift
```

`agrmcp skill install` (= `--target all`: installs the skill only, always into the core CLIs `claude`, `codex`, `dsh`, `pi` (created if needed) plus every other CLI detected on this machine, meaning its binary is on `PATH` or its own config directory is not empty) and `agrmcp mcp install` still exist for installing only the skill or only the MCP entry, but running just one of them is what causes "skill installed, MCP missing" drift, so prefer `setup`.

**Expected output:** `npm run build` exits 0; `doctor` prints a table with `Harness  Driver  Contract  Enabled  Installed  Version  Auth  ...` followed by a `MCP client registrations` table; `setup` prints one row per CLI (`Client  MCP  Skill  Verified  Config`) with `Verified = yes` and exits 0.

**Verify:** `agrmcp mcp status --check` exits 0 and every detected CLI shows MCP `current` and Skill `current`. `setup` reads both back after writing: a target that is not `current` afterwards (for example a disabled `orchestrator` entry left untouched without `--force`) is reported as `verified: false` with an `unverified_reason` (`--json`: `targets[].verified`, `unverified_reason`), and `setup` exits `1` on an error or a `conflict`/`invalid` entry. Then tell the user to restart the MCP client. The client must list 6 tools: `orch_catalog`, `orch_plan_preview`, `orch_run`, `orch_status`, `orch_logs`, `orch_cancel`. Run `agrmcp config show --json` and confirm `"config_warnings": []`.

**Undo/Stop:** remove the registration with `agrmcp mcp uninstall --target <cli>` (add `--dry-run` to preview; the skill copy stays), or by hand (`claude mcp remove orchestrator -s user`, `codex mcp remove orchestrator`, or delete the JSON block); `npm unlink -g agent-router-mcp` if you ran `npm link`.

### P2. Diagnose health with `agrmcp doctor --json`

**Goal:** know which harnesses are usable and why a harness is not used.

**Commands:**

```bash
agrmcp doctor --json
```

**Expected output:** a JSON object with `catalog_path`, `user_config_path`, `state_dir`, `config_warnings`, `config_diagnostics`, `discovery_hints` (omitted if the offline scan failed), `harnesses[]`, `mcp_clients[]`, and `mcp_client_warnings` (plus `stale_cli_links` when old global symlinks exist). Each harness entry has:

| Field | Values | Meaning → next step |
|---|---|---|
| `enabled` | `true` / `false` | `false` = disabled in config → enable with P3 if the user wants it |
| `installed` | `true` / `false` | `false` = binary not found on `PATH` (or at the configured `binary`) → user installs the CLI, or set an absolute `binary` path (P5), or disable the harness (P3) |
| `auth_status` | `ready` / `unauthenticated` / `unknown` | `unauthenticated` → tell the user to run that CLI's own login command in a terminal (for example `claude`, `codex login`, `gemini`). `unknown` = the CLI has no cheap auth probe; it is still usable — a real run will report `AUTH_REQUIRED` if login is missing |
| `contract` | `verified` / `experimental` | `experimental` adapters follow documented CLI contracts but were not captured live; the planner prefers `verified` harnesses during fallback |
| `security_guarantees` | `{ readonly, write }`, each `os_sandbox` / `tool_allowlist` / `unsandboxed` | `unsandboxed` write = no sandbox; prefer worktree isolation or `allow_unsandboxed_write = false` (P4) |
| `concurrency` | `effective_cap`, `global_cap`, `limit_source` (`harness_override` / `cli_config` / `fallback`), `fallback_used`, `native_subagents`, `native_max_depth`, optional `discovered_limit`, `discovered_max_depth`, `config_files`, `warnings` | parallel jobs this harness may run and its native-subagent depth. `fallback_used: true` means the CLI's own config states no limit and `default_harness_concurrency` applies; raise or lower it with P4. The table view prints it as `<cap>/<depth>`, with `~` after the cap when the fallback was used |
| `version`, `note` | strings | read them verbatim; they explain probe problems |

**MCP client registrations.** The text output ends with an `MCP client registrations` table (`Client  MCP  Skill  Config Path`), and `--json` returns the same data as `mcp_clients[]`. It lists every CLI that is detected on this machine or already has an MCP entry or the skill. Each entry has `client`, `label`, `detected`, `detected_by`, `config_path`, `skill_path`, `mcp_status` (`current` / `missing` / `stale` / `disabled` / `conflict` / `invalid`), optional `mcp_detail`, `skill_status` (`current` / `outdated` / `missing`), optional `skill_error`, `relevant`, and `fix_command`. `mcp_client_warnings` has one sentence per CLI whose `mcp_status` is not `current`, so drift such as "skill installed, MCP missing, disabled, or stale" is flagged with the exact fix. Read it as: run the printed `fix_command` (`agrmcp setup --target <cli>` when the skill is also not current, `agrmcp mcp install --target <cli>` when only MCP is, `... --force` for `disabled` or `conflict`; for `invalid`, fix the config syntax first). `agrmcp mcp status --check` gives the same verdict as an exit code.

**Config diagnostics.** `config_diagnostics` (printed as `Warning:` lines) are hints; the config still loads. They name fields the harness's driver never reads (`profile` outside `codex`/`dsh`, `default_upstream_provider` outside `dsh`/`pi`, `cli_provider` outside `dsh`/`pi`/`opencode`/`fx`), an `opencode` model without a provider (set `cli_provider` or a `provider/model` `cli_model`), and an enabled harness with a custom wrapper binary that is not usable, quoting the probe note. Remove the field or fix the wrapper, then re-run `agrmcp doctor`.

**Offline discovery hint.** `doctor` also runs the offline layer of model discovery (local CLI config and cache files only; no subprocess, no network) within a 45 ms budget. `discovery_hints` is `{ mode: "offline", unconfigured_models, disabled_models, harnesses[] }`, and the text output prints ``Discovery hint: <N> unconfigured models detected locally — run `agrmcp models discover` to review.`` when `N > 0`. It is only a hint: review and import with P10.

Apart from that, `agrmcp doctor` reports binary and auth health only. Session cooldowns live inside the running MCP server: the `runtime_warning` for an active cooldown is returned by `orch_catalog`, not by `agrmcp doctor` (call `orch_catalog` only under the strict opt-in rule in §1).

**Verify:** `config_warnings` must be `[]`, and `mcp_client_warnings` should be `[]` for every CLI the user relies on.

**Stop:** you NEVER ask for, print, or store credentials. Logging in is always the user's action in their own terminal.

### P3. Enable or disable a harness or model

**Goal:** turn a harness or model on/off without touching the catalog.

**Commands:**

```bash
agrmcp config get harnesses.kiro.enabled          # check current value first
agrmcp config set harnesses.kiro.enabled false    # disable a harness
agrmcp config set models.pi-grok-4.7.enabled false  # disable a model (dots in model IDs are handled)
agrmcp config show --json                         # verify
```

**JSON quoting gotcha:** `agrmcp config set` parses the value as JSON first. `false`, `true`, `600`, `["a","b"]`, `{"k":"v"}` become boolean/number/array/object. A plain word like `medium` stays a string. A **string that looks like a number or boolean** must be JSON-quoted inside shell quotes, otherwise it is stored as a number/boolean: `agrmcp config set harnesses.<id>.profile '"2025"'` stores the string `"2025"`, while `... 2025` stores the number `2025` (and is rejected because `profile` must be a string). Arrays, objects, and quoted strings must be valid JSON or the command fails with `Use valid JSON for arrays, objects, and quoted strings.`

**Validation:** `agrmcp config set` validates the merged result before writing. An invalid change prints `agrmcp: <reason>`, exits non-zero, and writes nothing — read the reason and fix the value.

**Expected output:** `Updated harnesses.kiro.enabled`.

**Verify:** `agrmcp config show --json` → `"config_warnings": []` and the harness appears under `overrides.harnesses`. A disabled harness used by a preset is replaced by an installed, enabled alternative during `orch_plan_preview`.

**Undo:** `agrmcp config reset harnesses.kiro` (or `agrmcp config reset models.<id>`). This removes ALL user overrides on that entity, not only `enabled`. To undo one field only, use `agrmcp config reset harnesses.kiro.enabled` (or `agrmcp config reset models.<id>.enabled`); other overrides on that entity stay (see P7). File-based equivalent: [`docs/examples/models.minimal.toml`](examples/models.minimal.toml).

### P4. Change preset roles, locale (`en`/`ru`), or safety/timeout defaults

**Goal:** change one preset role or a `[defaults]` value.

**Invariant:** for a preset role, `harness` MUST equal `models.<model>.harness`, and `effort` MUST be one of `models.<model>.efforts`. `agrmcp config set` rejects a violation with an error (nothing is written). If you hand-edit `models.toml` instead, the server **quarantines** only the offending entity (your preset override, or the model override that broke a built-in preset): it is left out of the resolved config and listed in `quarantined` and `config_warnings` (`Quarantined presets.<id> from <path>: ... does not match model ...`), while every other override still applies. Fix or reset that entity to bring it back.

**Commands (preset role):**

```bash
agrmcp config get models.gpt-6.2-astra.harness    # -> codex
agrmcp config get models.gpt-6.2-astra.efforts    # -> ["low","medium","high","xhigh","max"]
agrmcp config get presets.balanced.roles.review   # current role
agrmcp config set presets.balanced.roles.review '{"harness":"codex","model":"gpt-6.2-astra","effort":"high"}'
agrmcp config show --json                         # config_warnings must be []
```

Setting the whole role as one JSON object is atomic, so you never pass through an invalid half-changed state. The object must contain valid role fields (`harness`, `model`, `effort`); an empty `{}` is rejected. Changing a single field (`agrmcp config set presets.balanced.roles.quick.effort medium`) is fine only if the result still satisfies the invariant.

File-based equivalent: [`docs/examples/preset-role.toml`](examples/preset-role.toml) changes a different role — `quick` of the `balanced` preset — to `{ harness = "claude", model = "claude-sonnet-5-5", effort = "medium" }`; its CLI equivalent is `agrmcp config set presets.balanced.roles.quick '{"harness":"claude","model":"claude-sonnet-5-5","effort":"medium"}'`.

**Commands (`[defaults]`):**

```bash
agrmcp config set defaults.locale ru                    # "en" (default) or "ru"
agrmcp config set defaults.default_timeout_sec 900       # regular job timeout default
agrmcp config set defaults.high_effort_timeout_sec 1800  # high, xhigh, and max effort default
agrmcp config set defaults.max_timeout_sec 3600          # caps both defaults and explicit job timeouts
agrmcp config set defaults.max_concurrency 8             # cap on running jobs per repository session (default 8)
agrmcp config set defaults.concurrency_scope repo        # "repo" (default), "context", or "global"
agrmcp config set defaults.host_max_concurrency 24       # global ceiling across all sessions, 1..256 (default 24)
agrmcp config set defaults.auto_extend_timeout true      # extend the soft timeout of a job that keeps making progress (default true)
agrmcp config set defaults.idle_timeout_sec 900          # stop a stalled streaming job after this idle time; 0 disables (default 900)
agrmcp config set defaults.timeout_extension_sec 600     # one extension step, 60..3600 (default 600)
agrmcp config set defaults.activity_window_sec 180       # recent output/CPU window that counts as active, 30..1800 (default 180)
agrmcp config set defaults.max_queue_size 32             # queued jobs beyond the cap (default 32)
agrmcp config set defaults.default_harness_concurrency 5 # per-harness cap when the CLI's own config states none (default 5)
agrmcp config set defaults.native_subagents off          # "cli_limit" (default) or "off"
agrmcp config set defaults.native_subagent_depth 2       # 0..3 (default 2)
agrmcp config set harnesses.codex.max_concurrency 3      # per-harness override (1..64)
agrmcp config set defaults.allow_unsandboxed_write false  # reject unsandboxed writes; planner proposes safe fallbacks
agrmcp config set defaults.mcp_max_wait_sec 0             # 0 = auto; maximum 600 seconds
agrmcp config show --json
```

**Parallelism and native subagents.** The effective per-harness cap is `min(defaults.max_concurrency, harnesses.<id>.max_concurrency ?? limit read from the CLI's own config ?? defaults.default_harness_concurrency)`. The server discovers CLI limits read-only on Linux, macOS, and Windows (`src/config/cli-limits.ts`): Codex `config.toml`, Claude `settings.json` plus managed settings, OpenCode `opencode.json`/`opencode.jsonc`, DSH profiles and `cordis.patch.yml`, and Gemini/Pi `settings.json`. Same-model sharding uses `subtasks[].shards` in `orch_plan_preview`, or several subtasks on one model, up to the harness `effective_cap`. `shards: 1` is the same as omitting `shards` (pass an explicit `isolation: "worktree"` for an isolated single write job); `shards: 2..8` expands into `<id>#1..<id>#N`, `readonly` shards share the tree, and `write` shards are forced into `isolation: "worktree"`. `native_subagents` and `native_subagent_depth` only lower a CLI's own subagent limits for one invocation; user CLI config files are never modified and global `inherit_mcp` is never enabled. The per-invocation clamp (`native_subagents = "off"` and the depth limit) is actively enforced by `claude`, `codex`, `opencode`, and `dsh`; `pi` always starts with `--no-extensions`. Other CLIs (for example `gemini` and the experimental drivers) have no per-run enforcement flag, so they report `unknown` with a warning instead of a false `disabled_by_policy`. Check the result with `agrmcp doctor --json` (`harnesses[].concurrency`), `orch_catalog`, or `plan.concurrency` in `orch_plan_preview`.

**Timeouts and concurrency scope.** Callers should omit `timeout_sec`: the server picks the soft timeout by effort (`default_timeout_sec`, or `high_effort_timeout_sec` for `high`/`xhigh`/`max`). With `auto_extend_timeout = true`, a streaming job that produced output or CPU activity within `activity_window_sec` gets its soft deadline moved by `timeout_extension_sec`, repeatedly, up to the hard cap `max_timeout_sec`. A streaming job with no activity for `idle_timeout_sec` is killed early as idle (`0` disables this). A caller passes `strict_timeout: true` only when a hard, exact wall-clock limit is required. `max_concurrency` is counted per `concurrency_scope`: `repo` (one repository; worktrees fold into their main repo, the default), `context` (one `context_id`), or `global` (the whole host). `host_max_concurrency` is the ceiling across all sessions; the effective host cap is `max(host_max_concurrency, max_concurrency)`. `QUEUE_FULL` carries `details.scope` (`session` or `host`), and waiting jobs in `orch_status` show `queue: { position, blocked_by }` plus `session_id`. A task that touches more than 8 files or several subsystems should be sharded into smaller subtasks.

`defaults.mcp_max_wait_sec` caps how long `orch_status` may wait in one MCP call. `0`
selects automatic behavior; the maximum is `600` seconds. `agrmcp wait` defaults to 1800 seconds and
accepts up to 7200 seconds. The environment variable
`ORCH_MCP_MAX_WAIT_MS` sets the corresponding cap in milliseconds.

The server throttles automatic cleanup of old finished jobs in `runs/` using
`defaults.run_retention_days` and `defaults.max_runs_total_mb`. Set either key to `0`
to disable its pruning rule. By default, logs and worktrees live under the persistent
state directory. This keeps them off RAM-backed storage such as a `tmpfs`-mounted `/tmp`.

All `[defaults]` keys are listed in [§6](#6-schema--enum-cheat-sheet).

**Verify:** `"config_warnings": []`.

**Undo:** `agrmcp config reset presets.balanced` or `agrmcp config reset defaults`. Both remove ALL user overrides in that preset or section (every role you changed in `balanced`, every `[defaults]` key). Presets have no per-role reset: to undo one role and keep the others, re-apply the role you want with `agrmcp config set presets.balanced.roles.<role> '{...}'` (copy the built-in value from `defaults/catalog.toml`), or edit `models.toml` by hand.

### P5. Add a custom CLI or wrapper harness + custom model

**Goal:** route through your own wrapper binary or extra CLI profile.

**Template:** [`docs/examples/custom-harness.toml`](examples/custom-harness.toml). Merge its tables into the user config from `agrmcp config path`. Never put personal wrappers into the repo.

**Key rule:** `custom = true` turns OFF inheritance from `defaults/catalog.toml` for that entity, so every required field must be present (list in [§6](#6-schema--enum-cheat-sheet)). `agrmcp config set` validates first and writes nothing on error. In a hand-edited file, a custom entity with a missing or invalid field is **quarantined**: only that entity is dropped and listed in `quarantined` / `config_warnings` (`Quarantined harnesses.<id> from <path>: <reason>`), while all other overrides keep working. Only a file that cannot be parsed at all, or an invalid `[defaults]` value, makes the server fall back to the last valid config.

**IDs:** a new ID starts with a letter or digit and may contain letters, digits, `.`, `_`, `-`, `/`, `:`, `@` (at most 128 characters; no `..`, `//`, or trailing `/`; `__proto__`, `constructor`, `prototype` are reserved). Existing IDs stay editable even if they predate this rule.

**Steps (CLI, no hand-editing):**

1. Pick `driver` from the list in §6 (the CLI family your wrapper speaks). Set `binary` to an **absolute** path.
2. Create the harness with one JSON object (an unknown ID set to a whole object becomes a new entity with `custom = true`):

   ```bash
   agrmcp config set harnesses.my-wrapper '{"driver":"claude","display_name":"Claude (wrapper)","binary":"/usr/local/bin/claude-wrapper"}'
   ```

3. Copy `efforts`, `default_effort`, and `context_window` from the closest built-in model (`agrmcp config get models.claude-sonnet-5-5`), then create the model. For an ID with dots, slashes, or colons use `--section/--id` (or quote it: `models."my-model-1.5"`):

   ```bash
   agrmcp config set --section models --id my-model-1.5 '{"harness":"my-wrapper","cli_model":"claude-sonnet-5-5","display_name":"Sonnet via wrapper","tier":"standard","efforts":["low","medium","high"],"default_effort":"high","cost_tier":"medium","context_window":200000,"checked_at":"2026-11-26"}'
   agrmcp config get --section models --id my-model-1.5 --field provenance   # -> custom
   ```

   `default_effort` must be one of `efforts`; `checked_at` is an ISO date `YYYY-MM-DD` (a bare TOML date works too). `cost_note`, `speed_note`, `strengths`, `weaknesses`, `best_for`, and `avoid_for` default to empty.
4. Optional: a short alias, `agrmcp config set aliases.my-fast my-model-1.5` (undo: `agrmcp config reset aliases.my-fast`). A real model ID always wins over an alias of the same name; such a shadowed alias produces a `config_warnings` entry.

**Optional harness fields:**

- `write_permission_mode` must be one of the driver's modes (§6) for drivers that declare modes; the schema rejects anything else. Accepted is not applied: `codex` (and every driver without a mode list) accepts the field for compatibility but ignores it, and the Settings UI shows a saved value as ignored with a Clear button. Only `claude`, `antigravity`, `gemini`, `droid`, and `qwen` pass it to the CLI.
- `inherit_mcp` has 3 states: leave it unset to follow `defaults.inherit_mcp`, or set `true` / `false`. Built-in harnesses do not pin it. To clear an inherited value on an entity, use `agrmcp config set harnesses.<id>._unset '["inherit_mcp"]'` (any optional field listed in §6 can be cleared this way); the field keeps `field_provenance = "overridden"`, so reset stays available. Never enable `inherit_mcp` just to fix a failing run.
- MCP isolation depends on the driver (`mcpIsolation` in `src/drivers.ts`, the last column of the README harness table): `flag` and `config` drivers switch user MCP servers off for a run, `none` drivers have no such switch. `cursor` and `copilot` are `none`: `cursor` only warns that servers may stay loaded; `copilot` adds `--disable-builtin-mcps` and `--deny-tool <server>` for every server in `$COPILOT_HOME/mcp-config.json`, and servers added later may remain callable. A readonly Copilot run grants no tool at all (non-interactive mode refuses whatever needs approval) and also passes `--deny-tool write --deny-tool shell`. `opencode` and `dsh` are fail-closed too: OpenCode MCP servers are read from the V1/V2 JSONC configs (global, `$OPENCODE_CONFIG`, and project `.opencode/`), and DSH from `cordis.patch.yml` plus the active profile patches, including any `@deepseek-ai/dsh-mcp-client` plugin; each named server is switched off for the run. When `inherit_mcp` is false (or the Copilot run is readonly) and the MCP config of `copilot` (`mcp-config.json`), `codex` (`config.toml`), `opencode`, or `dsh` exists but cannot be named safely (oversized, not valid JSON/TOML, more than 64 servers, or a server name that is empty, longer than 128 characters or, for Copilot, starts with `-`), the run is refused with `SANDBOX_POLICY_VIOLATION` instead of starting with servers still enabled; a missing file is fine. Repair or remove the file; do not enable `inherit_mcp` to get around it.
- `model_discovery`: `manual`, `native`, or `wrapper` (P10). A custom wrapper or any path-based binary defaults to `manual`, so `agrmcp models discover` never runs it until you opt in.
- `profile` is read only by `codex` and `dsh`; `default_upstream_provider` only by `dsh` and `pi` (Pi also uses it for vendor inference); `cli_provider` (model) only by `dsh`, `pi`, `opencode`, and `fx`. An `opencode` model needs a provider: `cli_provider`, or `cli_model = "provider/model"`. `agrmcp doctor` flags violations as `config_diagnostics`.
- `vendor_family` (model) is optional: without it the planner infers the vendor from the model, harness driver, and upstream provider (aggregators such as Pi included); an unknown vendor never counts as "cross-vendor" for review.

**Verify:**

```bash
agrmcp doctor                    # the new harness row shows Installed = yes; no config_diagnostics for it
agrmcp config show --json        # config_warnings and quarantined must be []
```

**Undo** (for custom entities, reset deletes them). Order matters — delete the custom **model** FIRST, then the custom **harness**:

```bash
agrmcp config reset models.<custom-model>       # 1. delete every custom model that uses the harness
agrmcp config reset harnesses.<custom-harness>  # 2. only now delete the harness
agrmcp config show --json                       # config_warnings must be []
```

Deleting the harness first is rejected while a model still references it (`models.<id>.harness references unknown harness ...`). Also remove any preset role that points at the custom model or harness before deleting them.

### P6. Launch Settings Web UI

**Goal:** let the user edit config visually.

**Commands:**

```bash
agrmcp settings --no-open        # add --port N for a fixed port
```

**Expected output:** `Settings UI: http://127.0.0.1:<port>/...` followed by `Press Ctrl+C to stop`.

The Technical Ledger Settings UI provides operational tables, live harness health and delegation readiness, a master-detail preset-role matrix, and a complete grouped `[defaults]` editor. In Models, `/` or `Ctrl+K` focuses search; `Alt+1`–`Alt+4` switches tabs; `Ctrl+S` saves an open editor; `Esc` closes a drawer or mobile navigation. Parallelism and native-subagent settings (`default_harness_concurrency`, `native_subagents`, `native_subagent_depth`) appear in the `[defaults]` editor next to the global limits. Dropdowns are custom themed controls, the `[defaults]` editor keeps a persistent Save bar with live status, pages show save-rule cues (switches save immediately; entries save from their editor), and the UI ships its own favicon. See [`DESIGN.md`](../DESIGN.md).

Custom harness and model editing in the UI:

- **Harness drawer:** `extra_args` is edited one CLI argument per row (commas, duplicates, and order are kept exactly; `--enabled-tools a,b` stays one argument); `inherit_mcp` is a 3-state select (inherit the global "Inherit MCP servers" default / on / off); `max_concurrency` (1–64); `model_discovery` (default, `manual`, `native`, `wrapper`). Fields the driver never reads are hidden or flagged with a driver-aware warning.
- **Model drawer:** `vendor_family` shows the vendor the planner would infer as a placeholder (`auto: <vendor>`) and can be cleared back to automatic.
- **Quarantine banner:** quarantined user entities are listed at the top with their redacted reason; unrelated edits and saves keep working, and the quarantined entity can be fixed or reset.
- **Discover models:** the button in the Models header (all harnesses, or the harness filter in use) and in every saved harness drawer opens a review drawer. It has a mode selector (`On-demand (CLI + local)` / `Offline (local config only)`), a harness picker (a harness literally named `all` is still addressed correctly), a per-harness diagnostics strip, search plus status (`New`, `Disabled in catalog`, `Already configured`) and provider filters, and checkboxes for up to 50 models. **Import** sends one atomic batch (`POST /api/discover`, then `POST /api/models/import`). If the config changed meanwhile the server answers `409` and the drawer reloads the current config so you can rescan; if the preview expired (after 10 minutes) it answers `410` and asks you to scan again. Nothing is written until you import. Its strict offline nonce Content Security Policy (CSP) requires the per-response nonce on scripts and styles and blocks remote assets.

Give the printed URL to the user exactly as printed. It contains a one-time token that is valid for 5 minutes after start; it binds to `127.0.0.1` only and shuts down after 15 minutes idle (an open tab keeps it alive). The token becomes an `HttpOnly; SameSite=Strict` cookie, the one-time redirect hands the page an origin-bound `X-Orch-Token` only in the URL fragment (`/#t=<token>`; a fragment is never sent over HTTP, and the served HTML never contains the token), the page keeps it in `sessionStorage` (isolated per origin and port) and clears the fragment, so a new tab opened directly on `/` shows a message to open the printed URL again; every `/api/*` call, including `GET /api/state` and `/api/health`, needs the cookie and that header; a browser request with a `Sec-Fetch-Site` other than `same-origin` is refused with `403`. A quarantined config item has its own Reset button in the UI banner. The command blocks until stopped.

**Agents:** prefer `agrmcp config set` for scripted edits; use the Web UI only when the user wants to click.

**Stop:** Ctrl+C (or terminate the process you started).

### P7. Undo or reset safely

**Commands:**

```bash
agrmcp config reset models.<id>          # ALL overrides on one model (custom model: deleted)
agrmcp config reset models.<id>.<field>  # just one model field
agrmcp config reset harnesses.<id>       # ALL overrides on one harness (custom harness: deleted)
agrmcp config reset harnesses.<id>.<field>  # just one harness field
agrmcp config reset aliases.<alias>      # remove your alias override (built-in alias: back to default)
agrmcp config reset presets.balanced     # ALL overrides on one preset, every role (custom preset: deleted)
agrmcp config reset defaults             # whole [defaults] section (also: harnesses | models | presets | aliases)
agrmcp config reset --section models --id <id> [--field <field>]   # same, for IDs with dots, slashes, or colons
```

- Entity resets (`models.<id>`, `harnesses.<id>`, `presets.<id>`) drop every override on that entity, not one field. Models and harnesses support a per-field reset (`models.<id>.<field>`, `harnesses.<id>.<field>`); a reset field also leaves the `_unset` list, so it inherits again. Presets have no per-role reset: re-apply the roles you want to keep with `agrmcp config set`.
- A quarantined entity (it exists only in `models.toml`, not in the resolved config) can still be reset or deleted by its ID, dotted IDs included.
- Custom entities: delete models before the harness they use (see P5); a harness still referenced by a model cannot be deleted.

- Bare `agrmcp config reset` only prints usage (to stderr, exit code 1); it changes nothing. Always pass an explicit target.
- **NEVER** run `agrmcp config reset all` unless the user explicitly asked to wipe every override.
- A full reset saves a backup `models.toml.bak.<timestamp>` next to the user config. To restore, copy that file back over `models.toml`.
- A scoped `agrmcp config reset <target>` parses the existing TOML first, so it fails on a malformed `models.toml`. Fix the syntax or restore a backup first; use `agrmcp config reset all` only if the user asked to wipe everything.

**Verify:** `agrmcp config show --json` → `"config_warnings": []`.

### P8. Update after `git pull`

```bash
cd <clone>
git pull
npm install
npm run build
npm link                               # re-link the current build so `agrmcp` is the only global command
agrmcp setup --target all              # re-point stale MCP entries (legacy `orchestrator-mcp` / `orch mcp` ones are migrated, no --force) and refresh every skill copy
agrmcp mcp status --check              # exit code 0 = no drift
agrmcp config show --json              # config_warnings must be []
```

`agrmcp doctor` warns about stale global symlinks from earlier releases (`orch`, `orchestrator-mcp`, `orchestrate-settings`) that still point into this clone; remove the paths it prints with `rm`, then run `npm unlink -g agent-router-mcp && npm link` so `agrmcp` is the only command.

For isolated hosts with a private config directory, also run `agrmcp skill install --dir <host-dir>/skills` (see §3).

Then tell the user to **restart every MCP client** so it starts the new `dist/` build.

### P9. Full verification

```bash
cd <clone>
npm run build && npm run typecheck && npm test   # all offline; all must pass
agrmcp doctor --json                               # installed / auth_status / contract per harness; mcp_clients[] / mcp_client_warnings
agrmcp mcp status --check                          # exit code 0 = MCP entry and skill current for every detected CLI
agrmcp config show --json                          # "config_warnings": []
agrmcp setup --target all                          # repair MCP entries and refresh skill copies if anything drifted
```

From the MCP client — ONLY when the user explicitly asked to set up or verify the orchestrator, never unasked in ordinary sessions: call `orch_catalog` (brief), then `orch_plan_preview` with one subtask. Expect a `plan_id` and a `markdown_table`.

### P10. Discover and import models automatically

**Goal:** add model cards for models the user's installed CLIs already offer, without typing them in by hand.

**How it works:** discovery only observes until you apply. Layer 1 (offline) reads each CLI's own local config and cache files: regular, size-capped files only (a symlink to a regular file is followed, with the credential file-name deny-list applied to both the link and its target), credential file names denied, allowlisted model fields only; no subprocess and no network. Layer 2 (on demand, the default) also runs a fixed listing command per CLI that starts no LLM session and spends no tokens: `pi --no-extensions --no-mcp --no-approve --offline --list-models` (older Pi: `--no-extensions --no-mcp --list-models`), `opencode models`, `gemini models list --output-format json`, `agy models`, `fx models --json` (after checking the binary is Vercel fx), `grok models`, `cursor-agent models`, `kiro-cli chat --list-models --format json`, `muse exec --list-models`. Except for Pi (whose flags are chosen by version), a listing runs only when the CLI's own `--help` advertises that command or flag (read from its `Commands:` / `Options:` block); otherwise the harness reports `scope_unknown` and nothing is run. Probes run without a shell under an environment allowlist (API keys, tokens, `NODE_OPTIONS`, `LD_*`/`DYLD_*`, proxies dropped; `NO_COLOR=1`), never append `extra_args`, take at most 5 s each and 15 s overall, at most 2 at once, with output caps (512 KiB stdout, 32 KiB stderr), process-tree cleanup, and secret / URL-credential redaction. Drivers without a listing command (`claude`, `codex`, `dsh`, `copilot`, `droid`, `qwen`, `kimi`, `vibe`) are discovered from local files only; `cursor`, `kiro`, and `muse` have no local source, so `--offline` reports `scope_unknown` for them. Harnesses whose `model_discovery` is `manual` (the default for custom wrappers and path-based binaries) report `manual_only` and are never run; set `model_discovery = "native"` or `"wrapper"` to opt in.

**Commands:**

```bash
agrmcp models discover                          # preview every enabled harness; nothing is written
agrmcp models discover --offline                # Layer 1 only: no CLI is started
agrmcp models discover --harness opencode       # one harness (exact ID; a harness named "all" works too)
agrmcp models discover --all                    # also models from providers the CLI reports as not connected
agrmcp models discover --json                   # machine-readable preview
agrmcp models discover --apply --select <key>[,<key>...] --revision <rev>
agrmcp models discover --apply --all-new --revision <rev>
agrmcp config show --json                       # config_warnings and quarantined must be []
```

Flags: `--harness <id>`, `--offline`, `--all`, `--json`, `--apply`, `--select <key>` (repeatable or comma-separated), `--all-new`, `--revision <rev>`, `--help`. `--select`, `--all-new`, and `--revision` work only with `--apply`; `--apply` needs `--select` or `--all-new` (not both). Pass the same `--harness` / `--offline` / `--all` flags to `--apply` as to the preview, so both see the same candidates.

**Expected output:** a table `Harness  Provider  Model  Status  Proposed ID  Quality  Context  Key`, `Note: <harness>: <code> (...)` lines for diagnostics, `Summary: N model(s): ... new, ... disabled in catalog, ... already configured, ... ambiguous.`, `Revision: <rev>`, and ready `Apply:` command lines. `--apply` prints `Imported N: ...`, `Enabled N: ...`, optional `Skipped (ID already exists): ...`, and a `Next batch:` command when more new models remain.

| Status | Action on apply |
|---|---|
| `new` | imported as a new card (`source = "discovered"`, `metadata_quality = "template"` when copied from one matching built-in card, else `"baseline"`) |
| `disabled_in_catalog` | the one matching disabled card is re-enabled (only via `--select`) |
| `ambiguous` | none: several disabled cards match; enable the right one with P3 |
| `already_configured` | none |

Candidates are ordered actionable-first before the preview cap (1,000 candidates). `--all-new` imports only `new` candidates, at most 50 per call; `--select` accepts at most 50 keys. A key is a content hash, so a stale key fails with `Selection is stale or unknown`; rerun the preview. `--revision` makes `--apply` fail if the config changed since the preview. Imported `discovered` cards that are not `reviewed` may omit `context_window` and `checked_at`; the planner prefers curated or reviewed cards over `template`/`baseline` ones when both fit equally well. After reviewing a card, fill in `context_window` and `checked_at` and then run `agrmcp config set models.<id>.metadata_quality reviewed` (a `reviewed` card must have both). Listing commands above use each driver's default binary name; the configured `binary` is what actually runs.

**Diagnostic codes:** `manual_only`, `scope_unknown`, `binary_missing`, `unsupported_version`, `timeout`, `cancelled`, `busy` (another scan of that harness is running), `output_limit`, `invalid_output`, `source_unreadable`.

**Settings UI:** the same flow is the **Discover models** drawer (P6).

**Undo:** an imported card is a custom model: `agrmcp config reset models.<id>` deletes it; a re-enabled card goes back with `agrmcp config reset models.<id>.enabled`.

## 5. Troubleshooting (Symptom → Cause → Fix)

### Waiting for background jobs

Use `agrmcp wait --job <id> [--job <id> ...] [--until any|all] [--timeout <sec>] [--settle-ms <ms>] [--state-dir <path>]` to wait from a shell. For example: `agrmcp wait --job <id1> --job <id2> --until any`. Positional job IDs and comma-separated `--job` values are also accepted. The defaults are `any`, an 1800-second timeout, and a 1500 ms settle window. The maximum timeout is 7200 seconds. The command watches job state directories with kernel `fs.watch` notifications and a 5-second safety fallback. It returns immediately when the initial snapshot already meets the condition and does not spin the CPU while idle. Output is JSON with `wake_reason` (`terminal`, `all_terminal`, `timeout`, or `cancelled`), `pending_count`, and `jobs`. Exit codes: `0` terminal (`terminal` or `all_terminal`), `2` timeout, `130` cancelled (SIGINT/SIGTERM). In `any` mode, new completions may be coalesced for up to the settle window while jobs remain pending; `all` mode exits as soon as all selected jobs are terminal.

For hosts with asynchronous shell notifications, launch each background job with `orch_run({ ..., async: true })` and run one background `agrmcp wait --job <id1> --job <id2> --until any` (or `node <clone>/dist/cli/main.js wait ...`), then end the turn. On notification, snapshot results with `orch_status({ job_ids: [...] })`, fetch full output or diffs with `orch_logs` as needed, reroute failures promptly, and wait on remaining IDs. This is the preferred option when the host supports asynchronous shell notifications.

For MCP-only hosts, use `orch_status({ plan_id, until: "any_terminal", wait_ms: 600000 })`; the server automatically calibrates the wait to the host timeout. The MCP client supplies `_meta.progressToken` on the request and receives `notifications/progress` heartbeats from the server. Follow `next.args` (it carries the opaque `cursor`) while `pending_count > 0 || unseen_count > 0`, that is, whenever `next` is returned, including when the byte budget truncated finished jobs. Event delivery wakes the call; close completions may be coalesced for about 1.5 seconds. Use `until: "all_terminal"` only when no work can proceed earlier. Do not use polling loops or shell `sleep`.

| Symptom | Cause | Fix |
|---|---|---|
| Server works in the terminal but not in a GUI IDE (`spawn node ENOENT`, server "failed") | GUI apps do not load nvm/asdf/volta `PATH` | Register with absolute paths from `command -v node` and `<clone>/dist/cli/main.js` (§3) |
| Syntax errors on start, `engines` warning | Node.js older than 22 | Install Node 22+, rebuild (`npm install && npm run build`), re-register with the new absolute node path |
| `fx` harness shows wrong version or fails probe | Another `fx` (the `antonmedv/fx` JSON viewer) is first on `PATH` | Set `harnesses.fx.binary` to the absolute path of Vercel fx, or disable it (P3) |
| Cursor harness not found / wrong binary | The Cursor CLI may be installed as `agent`, colliding with other `agent` binaries | Set `harnesses.cursor.binary` to the absolute Cursor CLI path; the probe verifies Cursor's version pattern |
| Plan warns `unsandboxed` write | Driver has no sandbox for `write` (most non-`codex`/`dsh` drivers) | Use worktree isolation, choose an `os_sandbox` harness, or set `defaults.allow_unsandboxed_write false`. NEVER weaken sandbox flags to silence it |
| Config change "did nothing" | Hand-edited `models.toml` is invalid. A broken harness, model, preset, or alias is quarantined (only that entity is ignored); a TOML syntax error, unknown top-level section, or invalid `[defaults]` value makes the server ignore the whole user file and use the last valid config; with no earlier valid config in memory (a cold start) every run is refused with `CONFIG_INVALID` until the file is repaired, so a typo can never silently drop a safety setting (`agrmcp config show --json` and `agrmcp doctor --json` report this as `cold_start_fallback: true`) | `agrmcp config show --json` → read `quarantined` and `config_warnings`, fix the file or `agrmcp config reset <target>` |
| `config_warnings` says `Quarantined <section>.<id> from <path>: <reason>` | That one user entity failed validation (missing required field on a custom entity, bad enum, a model or harness it references is missing, a preset role that no longer matches its model) | Fix the field with `agrmcp config set`, or `agrmcp config reset <section>.<id>`; everything else already applies |
| `User alias "<id>" is ignored because a model has the same ID` | Model IDs take precedence over aliases | `agrmcp config reset aliases.<id>` or pick another alias name |
| `agrmcp config set models.<id-with-dots>...` edits the wrong entity or fails | A dotted path cannot tell where an unknown ID with dots ends | Quote it (`'models."<id>".tier'`) or use `--section models --id <id> --field <field>` |
| `agrmcp models discover` shows `manual_only` for a harness | Custom wrapper or path-based `binary`; discovery never runs it unasked | Type the models in by hand (P5), or opt in: `agrmcp config set harnesses.<id>.model_discovery native` (or `wrapper`) |
| `agrmcp models discover --apply` fails with `Config revision conflict. Reload the config and retry the change.` or `Selection is stale or unknown` | The config or the CLI's model list changed since the preview | Run the preview again and use the new `Revision` and keys |
| New behavior or tool fields missing after update | Stale `dist/` or client not restarted | `npm run build`, then restart the MCP client |
| Agent follows old orchestration rules | Stale installed skill copy | `agrmcp setup --target <cli>` (or `agrmcp skill install`; plus `--dir` for isolated hosts) |
| Skill is installed but the `orch_*` tools are missing (or `agrmcp doctor` warns "MCP registration is missing / stale / disabled") | The skill and the MCP entry drifted apart, or the clone moved so the entry points at an old build | `agrmcp mcp status`, then run the `fix_command` it prints (`agrmcp setup --target <cli>`; add `--force` for `disabled` / `conflict`), and restart the client |
| `orch_*` tools or skill missing only inside an IDE/ACP host | Host uses a private config dir | §3 "Isolated / ACP host config directories" |
| Codex on Windows fails with `SANDBOX_UNAVAILABLE` | Codex could not start its OS sandbox (restricted token / ACL setup failed). The harness enters a 600 s cooldown; `safe_to_reroute` is true in `readonly` / `worktree` runs (in `shared` / write runs only when no tool call ran and the working tree stayed unchanged) and `suggested_alternatives` lists other harnesses | Follow `error.details.hints`: avoid OneDrive and UNC (`\\server\share`) paths, keep the project path under 240 characters, keep `TEMP`/`TMP` under `%USERPROFILE%`, and check the user can create restricted tokens and set ACLs there. `agrmcp doctor --json` shows the same advice under `platform_warnings`. Re-route with `exclude_harnesses`; NEVER weaken `-s` / `-a` or other sandbox flags |
| Claude `readonly` run fails with `AUTH_REQUIRED` although `claude` works in a terminal | `--restricted` hides your shell login. The harness forwards only a strict allowlist of Anthropic / Bedrock / Vertex / Foundry auth and endpoint variables found in the user-level `settings.json` `env` block (names only, never proxy, CA, or custom-header variables). A group gate refuses mixing env-variable auth with file-based auth, and a `settings.json` inside the repo or worktree is rejected | `agrmcp doctor --json` lists `claude_readonly_forwarded_env` (names only). Put the auth variables in the user-level `settings.json`, or run `claude auth login` again (patterns such as `Failed to authenticate: OAuth session expired` map to `AUTH_REQUIRED`). Do not drop `--restricted` or add `extra_args` to get around it |
| Job fails with `RECURSION_BLOCKED` | A worker tried to orchestrate again; `ORCH_DEPTH` exceeded `orch_max_depth` (default 1) | Expected guard. Do the nested work in the worker directly; do not raise `orch_max_depth` unless the user asks |
| Worktree job misses your latest edits or fails on missing deps | Worktrees branch from `HEAD`; uncommitted edits and untracked `node_modules` are not copied | Use `shared` isolation for work depending on uncommitted edits, or let the worker install deps; never commit/stash for the user |
| `orch_*` call returns `INVALID_INPUT` | A required argument is missing or blank, or a value is out of range (for example `shards` outside 1–8; `shards: 1` is accepted and equals omitting it) | Read `error.details.missing` and `error.details.example`, fix the call, and resend. Unknown argument names appear in `ignored_arguments` with closest-key hints (for example `model` belongs in `override.model`) |
| Job fails with `TIMEOUT` and `has_partial_progress: true` | The worker ran out of time (`error.timeout_kind: "soft"`), stalled (`"idle"`), or hit the cap (`"hard"`) | Check the termination warnings first. `soft`: call `orch_run(error.resume.args)` as given (it includes `plan_id` and `subtask_id` for `require_plan_id = true` deployments), or pass `continue_from_job_id`; a larger `timeout_sec` is allowed. `idle`: check `error.stderr_tail`, auth, and quota, then resume without a larger `timeout_sec`. `hard`: shard into smaller subtasks. Read the checkpoint with `orch_logs({ job_id, part: "checkpoint" })`. See "Resuming after a timeout" below |
| Job fails with `QUOTA_EXCEEDED` / `RATE_LIMITED` / `PROVIDER_OVERLOADED` / `AUTH_REQUIRED` / `CLI_NOT_FOUND` | Harness-level failure; session cooldown starts (10 min for quota/auth/not-found, 2 min for rate-limit/overload) | Read `error.raw_error` verbatim. If `safe_to_reroute` is true: drop any stale `override`, re-preview with `exclude_harnesses: ["<harness>"]`, relaunch (max 2 reroutes per subtask). For `MODEL_UNSUPPORTED` use `exclude_models`. After the user fixes the cause, pass `refresh_health: true` to clear cooldowns |

**Delegation stop and timeout rules:** If a plan or run reports `DELEGATION_UNAVAILABLE`, `launchable: false`, `delegation_status: "exhausted"`, `delegation_state: "exhausted"`, or top-level `delegation.state: "exhausted"`, stop all work immediately. Do not execute blocked subtasks yourself or silently switch delegators. Tell the user which harnesses/models are blocked and include the exact provider errors and recovery options. For `TIMEOUT`, do not fail over; stay on the same harness and model and branch on `error.timeout_kind`: `soft` means retry or continue via `error.resume` (a larger `timeout_sec`, up to `max_timeout_sec`, is allowed); `idle` means the CLI stalled, so check `error.stderr_tail`, auth, and quota and resume without a larger `timeout_sec`; `hard` means the cap was reached, so split the work across subtasks assigned to that same model. Inter-model task payloads must be in English. Replies to the user remain in the user's language.

### Resuming after a timeout

`claude` streams realtime NDJSON (`--output-format stream-json --verbose`, still with `--no-session-persistence`; `tool_result` bodies are stripped from `stdout.log`). An interrupted, timed-out, or failed job writes a redacted `0600` `checkpoint.json` in its run directory: partial assistant output, a compact tool-activity trail, and the changed files with a bounded diff excerpt (from the job's worktree, or scoped to a shared write). Read it with `orch_logs({ job_id, part: "checkpoint" })`.

A `TIMEOUT` error includes `has_partial_progress` and, when the process tree ended cleanly, a ready `error.resume` call. Check the termination warnings first. If process termination failed (`safe_to_reroute: false` and no `error.resume`), do not resume into the poisoned checkout and do not start another writer there: stop and report to the user, who decides what to keep or revert. Otherwise send `orch_run(error.resume.args)` directly: it carries `continue_from_job_id`, the suggested `timeout_sec`, and `plan_id` + `subtask_id` (required by `require_plan_id = true` deployments). Resuming through `continue_from_job_id`, or by re-running a timed-out `plan_id` + `subtask_id` (it continues automatically; pass `fresh: true` to discard the saved progress and start over), prepends a bounded handoff of up to 16 KB titled "Progress before stop" and reuses a clean worktree. Keep the same harness and model. Branch on `error.timeout_kind`: for `soft` you may raise `timeout_sec` up to `max_timeout_sec`; for `idle` (the CLI stalled) fix the cause first (`error.stderr_tail`, auth, quota) and resume without raising `timeout_sec`; for `hard` (the cap was reached) shard the work into smaller subtasks.

### Continuing a job within one user prompt

Workers are stateless by default. To continue work on the same artifact, pass the prior job ID
as `continue_from_job_id` to `orch_run`. For multiple plans within one user prompt, pass the
same optional task-scoped `context_id` to `orch_plan_preview`. Runs inherit it from the plan,
and `orch_run` also accepts it directly. The prior job must be terminal, use the same `cwd`,
and match the same `context_id` if set or the same `plan_id` otherwise. The prior job must have
finished within the last 2 hours. The chain index stays in RAM.

The handoff covers up to four steps and is capped at about 12 KB (16 KB when continuing an interrupted job with a "Progress before stop" section). The server redacts secrets,
wraps it in `<prior_job_context untrusted="true">`, and prepends it to `system_context`.
Prompt excerpts stay in RAM, and continuation keeps no persistent state beyond the normal
per-job run directory (some CLI adapters write a short-lived system-prompt file inside
`runs/<job>/` that is removed when the job finishes).
The handoff works across all 17 CLI drivers, including cross-vendor failover (for example,
Claude to Codex).

A `write` continuation with `isolation: "worktree"` reuses the prior job's worktree, preserving
uncommitted edits, only when the prior job is a `write` job in the same git repo whose worktree
still exists on disk, was not cleaned up, and whose process tree terminated cleanly. If another
active continuation job currently holds that worktree, `orch_run` fails with retryable
`CONCURRENCY_LIMIT`; wait for the holder to finish, then retry.

In a chain that reuses one worktree, the latest job's diff is measured against the original
base commit and already includes every earlier step. Integrate ONLY the latest job's diff
(never apply parent and child diffs both), and clean up ONCE via that latest job after
integration (`orch_cancel({ job_id: <latest>, cleanup_worktree: true })`). Do not clean up the
parent before integrating the child.

`diff.patch` (`orch_logs({ job_id, part: "diff" })`) lists untracked files by name only, without their contents. Transfer untracked files from `worktree.path` itself and verify the full result before cleanup. A worktree with changes, ignored files, or a moved HEAD is kept by a plain cleanup; use `orch_cancel({ job_id, cleanup_worktree: true, force_cleanup: true })` only after you have confirmed that the remaining worktree changes can be discarded.

### Honest limits of errors and redaction

`orch_status` clips `error.raw_error` to 1,500 bytes (and `stderr_tail` to 1,000); call `orch_logs` (`part: "stderr"` or `"stdout"`) for the full saved output. Literal environment-value redaction scrubs the values of environment variables whose names contain `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `CREDENTIAL` only when the value is at least 8 characters long; shorter secrets are not matched by value.

## 6. Schema & enum cheat-sheet

Source of truth: [`src/drivers.ts`](../src/drivers.ts) and [`src/config/schema.ts`](../src/config/schema.ts). `schema_version = 1` is the only valid value.

**`driver`** (17 values): `claude`, `codex`, `dsh`, `pi`, `antigravity`, `opencode`, `gemini`, `cursor`, `grok`, `kiro`, `fx`, `muse`, `copilot`, `droid`, `qwen`, `kimi`, `vibe`.

**`write_permission_mode`** per driver (only these drivers accept it):

| Driver | Allowed values |
|---|---|
| `claude` | `acceptEdits`, `auto` |
| `antigravity` | `accept-edits`, `auto` |
| `gemini` | `auto_edit`, `yolo` |
| `droid` | `low`, `medium`, `high` |
| `qwen` | `auto-edit`, `yolo` |

The schema rejects any other value for these drivers; for every other driver (for example `codex`) the field is accepted but never applied. `antigravity` also accepts the legacy spelling `acceptEdits` and maps it to `accept-edits` (the UI does not offer it).

**Driver capabilities** (which optional fields an adapter actually reads; `agrmcp doctor` reports the rest in `config_diagnostics`):

| Field | Read by drivers |
|---|---|
| Harness `profile` | `codex`, `dsh` |
| Harness `default_upstream_provider` | `dsh`, `pi` |
| Model `cli_provider` | `dsh`, `pi`, `opencode`, `fx` |
| Provider required (`cli_provider`, or `provider/model` in `cli_model`) | `opencode` |

**Harness `model_discovery`:** `manual`, `native`, `wrapper` (unset = `native` for a built-in driver binary looked up by bare name, `manual` for a custom or path-based binary).
**Harness `inherit_mcp`:** unset (follow `defaults.inherit_mcp`), `true`, `false`. A per-run `orch_run` `inherit_mcp` beats both.
**Model `source`:** `catalog`, `manual`, `discovered`. **Model `metadata_quality`:** `curated`, `template`, `baseline`, `reviewed` (unset counts as `curated`).
**Entity IDs (new):** start with a letter or digit, then letters, digits, `.`, `_`, `:`, `@`, `-`, `/`; at most 128 characters; no `..`, `//`, or trailing `/`; `__proto__`, `constructor`, `prototype` are reserved. Source: [`src/config/ids.ts`](../src/config/ids.ts).
**`_unset` (user file only):** a list of optional fields to clear on one entity, so an inherited value is removed. Harness: `profile`, `default_upstream_provider`, `write_permission_mode`, `inherit_mcp`, `extra_args`, `max_concurrency`, `model_discovery`. Model: `cli_model`, `cli_provider`, `vendor_family`, `context_window`, `checked_at`, `source`, `metadata_quality`, `discovered_at`, `template_id`.
**Model `tier`:** `deep`, `standard`, `light`, `specialist`.
**Model `cost_tier`:** `low`, `medium`, `high`, `premium`.
**`defaults.locale`:** `en` (default), `ru`.
**Preset role:** `{ harness, model, effort }` — all three strings, all required.
**`orch_plan_preview` `intent`:** `general` (default), `design_consult` (cross-vendor advisors; pass `host_vendor`, for example `anthropic`, `openai`, `google`).

**Required fields when `custom = true`:**

| Entity | Required | Optional |
|---|---|---|
| Harness | `driver`, `display_name` (non-empty), `binary` (non-empty) | `enabled` (default `true`), `profile`, `default_upstream_provider`, `write_permission_mode`, `inherit_mcp` (unset = inherit), `extra_args`, `max_concurrency` (`1`–`64`; per-harness parallel job cap), `model_discovery` |
| Model | `harness`, `display_name`, `tier`, `efforts` (non-empty), `default_effort` (must be in `efforts`), `cost_tier`, `context_window` (positive integer) and `checked_at` (`YYYY-MM-DD`; a TOML date also works) — these two may be omitted only on a `source = "discovered"` card whose `metadata_quality` is not `reviewed` | `enabled`, `cli_model` (defaults to the model id), `cli_provider`, `vendor_family` (1–64 characters; inferred when unset), `cost_note` and `speed_note` (default `""`), `strengths`, `weaknesses`, `best_for`, `avoid_for` (default `[]`), `source`, `metadata_quality`, `discovered_at` (ISO date or date-time), `template_id` |
| Preset | `description`, `roles` | `enabled` |
| Alias | a non-empty model ID string (`[aliases] <alias> = "<model-id>"`) | — |

`agrmcp config show --json` returns `quarantined: [{ section, id, reason }]` (`section` is `harnesses`, `models`, `presets`, or `aliases`) for user entities that failed validation and were left out; each one also has a `config_warnings` entry.

**`[defaults]` keys and built-in schema defaults:**

| Key | Type | Default |
|---|---|---|
| `locale` | `en` / `ru` | `en` |
| `stale_after_days` | positive integer | `90` |
| `max_concurrency` | positive integer (cap on running jobs per `concurrency_scope`, by default per repository session) | `8` |
| `concurrency_scope` | `repo` / `context` / `global` (what `max_concurrency` is counted per) | `repo` |
| `host_max_concurrency` | integer `1`–`256` (global ceiling on running jobs across all sessions; effective cap is `max(host_max_concurrency, max_concurrency)`) | `24` |
| `max_queue_size` | integer >= 0 | `32` |
| `default_harness_concurrency` | integer `1`–`64` (parallel jobs per harness when neither `harnesses.<id>.max_concurrency` nor the CLI's own config states a limit) | `5` |
| `native_subagents` | `cli_limit` / `off` (`off` disables a CLI's own subagents per job) | `cli_limit` |
| `native_subagent_depth` | integer `0`–`3` (deepest native subagent nesting; a lower limit in the CLI's own config wins) | `2` |
| `default_timeout_sec` | positive integer (<= `max_timeout_sec`) | `900` |
| `high_effort_timeout_sec` | positive integer (<= `max_timeout_sec`) | `1800` |
| `mcp_max_wait_sec` | integer from `0` (auto) through `600` | `0` |
| `max_timeout_sec` | positive integer | `3600` |
| `auto_extend_timeout` | boolean (extend the soft timeout of a streaming job that keeps making real progress, up to `max_timeout_sec`) | `true` |
| `idle_timeout_sec` | integer from `0` (disable idle detection) through `86400` (a streaming job idle for this long is killed) | `900` |
| `timeout_extension_sec` | integer `60`–`3600` (how far one activity-based extension moves the soft deadline) | `600` |
| `activity_window_sec` | integer `30`–`1800` (output or CPU within this window counts as active) | `180` |
| `max_mcp_output_bytes` | positive integer | `24000` |
| `max_log_bytes_per_job` | positive integer | `10485760` |
| `run_retention_days` | integer from `0` (disable age pruning) through `365` | `7` |
| `max_runs_total_mb` | integer from `0` (disable size-cap pruning) through `102400` | `512` |
| `orch_max_depth` | integer >= 0 | `1` |
| `inherit_mcp` | boolean | `false` |
| `require_plan_id` | boolean | `false` |
| `allow_unsandboxed_write` | boolean | `true` |

`inherit_mcp`, `require_plan_id`, and `allow_unsandboxed_write` are also set in `defaults/catalog.toml` (as are `stale_after_days`, `max_concurrency`, `max_queue_size`, `default_timeout_sec`, `max_timeout_sec`, `max_mcp_output_bytes`, `max_log_bytes_per_job`, and `orch_max_depth`). Only the newer keys `locale`, `high_effort_timeout_sec`, `mcp_max_wait_sec`, `run_retention_days`, `max_runs_total_mb`, `default_harness_concurrency`, `native_subagents`, `native_subagent_depth`, `concurrency_scope`, `host_max_concurrency`, `auto_extend_timeout`, `idle_timeout_sec`, `timeout_extension_sec`, and `activity_window_sec` exist only in the schema. A `default_timeout_sec` or `high_effort_timeout_sec` above `max_timeout_sec` still loads, with a `config_warnings` entry, and jobs are capped at `max_timeout_sec` at runtime. The same applies, with a `config_warnings` entry, to `host_max_concurrency` below `max_concurrency` (the host cap is raised to `max_concurrency`), `idle_timeout_sec` (when above `0`) above `max_timeout_sec`, and `timeout_extension_sec` above `max_timeout_sec`. The effective per-harness cap is `min(max_concurrency, harness override ?? limit found in the CLI's own config ?? default_harness_concurrency)`; `agrmcp doctor` and `orch_catalog` show it per harness. CLI configs are read-only and only an allowlist of limit keys is parsed, never credential files. Native subagents are only ever lowered for a job (per-invocation flags or env), never raised, and no user config file is modified.

These are the schema defaults; `defaults/catalog.toml` may set different values for the keys it contains. Always check the effective value with `agrmcp config get defaults.<key>`.

### MCP tools, `orch_logs` parts, and error codes

Source of truth: [`src/mcp/tools.ts`](../src/mcp/tools.ts) and [`src/types.ts`](../src/types.ts). The server exposes 6 tools; `tools/list` publishes clean, flat Draft-7 JSON Schema.

| Tool | Notable arguments |
|---|---|
| `orch_catalog` | `detail` (`brief` / `full`), `search`, `task_type`, `preset`, `harness`, `tier`, `include_unavailable`, `refresh_health`, `limit` (1–100), `offset`, `include_preset_roles`; `detail: "full"` shows full model cards and per-harness `concurrency`, while full preset role maps need `preset: "<id>"` or `include_preset_roles: true` |
| `orch_plan_preview` | `subtasks` (required; each `{ id, task_type, title?, mode?, isolation?, shards?, override? }`; `shards` 1–8, where `1` equals omitting it and `2..8` expands into `<id>#1..<id>#N` with write shards forced into worktrees), `preset`, `cwd`, `exclude_harnesses`, `exclude_models`, `locale`, `host_vendor`, `intent`, `context_id`, `refresh_health`; returns `plan.concurrency` |
| `orch_run` | `plan_id` + `subtask_id` (hydrate harness, model, effort, mode, isolation, `cwd`), `prompt`, `continue_from_job_id`, `fresh`, `context_id`, `client_request_id`, `async`, `wait_ms`, `timeout_sec` (omit it; the server chooses), `strict_timeout` (`true` = no activity-based extension, an exact wall-clock limit), `inherit_mcp`; on continuation a deterministic default prompt is used |
| `orch_status` | `job_ids` (alias `job_id`), `plan_id`, `wait_ms`, `until` (`any_change` / `any_terminal` / `all_terminal`), `cursor`, `since_version` |
| `orch_logs` | `job_id`, `part`, `offset_bytes`, `limit_bytes` |
| `orch_cancel` | `job_id`, `cleanup_worktree`, `force_cleanup` |

**Lenient input (all 6 tools):** `null` optional fields, numeric and boolean strings (`"600"`, `"true"`, `"false"`, `"yes"`, `"no"`), singleton or comma-separated strings for list fields, and enum aliases are accepted. Unknown argument names are returned in `ignored_arguments` with closest-key hints. `orch_run` fills `cwd` from `plan_id` or `continue_from_job_id`. Missing or blank required arguments return a structured `INVALID_INPUT` error with `details.missing` and `details.example` (not an opaque `-32602`).

**`orch_logs` `part` (`LogPart`):** `summary` (default), `stdout`, `stderr`, `diff`, `files`, `checkpoint`.

**`error.code` (`ErrorCode`):** `CLI_NOT_FOUND`, `AUTH_REQUIRED`, `QUOTA_EXCEEDED`, `RATE_LIMITED`, `PROVIDER_OVERLOADED`, `RECURSION_BLOCKED`, `CONCURRENCY_LIMIT`, `QUEUE_FULL`, `INVALID_CWD`, `MODEL_UNSUPPORTED`, `HARNESS_UNAVAILABLE`, `DELEGATION_UNAVAILABLE`, `SANDBOX_POLICY_VIOLATION`, `SANDBOX_UNAVAILABLE`, `PROMPT_TOO_LARGE`, `PLAN_REQUIRED`, `PLAN_NOT_FOUND`, `INVALID_INPUT`, `IDEMPOTENCY_CONFLICT`, `TIMEOUT`, `NON_ZERO_EXIT`, `PARSE_ERROR`, `WORKTREE_ERROR`, `CANCELLED`, `INTERNAL_ERROR`. `QUEUE_FULL` and `CONCURRENCY_LIMIT` are local capacity limits: wait for running jobs or lower the parallelism instead of rerouting. `SANDBOX_UNAVAILABLE` means the harness could not start its OS sandbox (typically Codex on Windows); it is harness-scoped, starts a 600 s cooldown, and carries `details.hints` (see §5).

`ORCH_MCP_MAX_WAIT_MS` sets the MCP wait cap in milliseconds. The server automatically calibrates each wait to the host timeout; the maximum is 600 seconds.
