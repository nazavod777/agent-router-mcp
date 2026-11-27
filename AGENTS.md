# AGENTS.md — agent-router-mcp

Communicate with the user in their language; keep commands, TOML keys, and code edits canonical.

`agrmcp` below means the `agrmcp` command (after `npm link`) or `node <clone>/dist/cli/main.js`; it is the only CLI binary (legacy `orch`, `orchestrator-mcp`, `orchestrate-settings` are gone). Full guide: [`docs/AI_AGENT_GUIDE.md`](docs/AI_AGENT_GUIDE.md).

## Which job are you doing?

- **Branch A: user setup / customization** (install, register MCP, enable/disable, presets, custom harness, troubleshooting).
  Read ONLY the matching playbook in [`docs/AI_AGENT_GUIDE.md` §4](docs/AI_AGENT_GUIDE.md#4-playbooks-p1p10) (P1–P10). Do not edit repo files.
- **Branch B: modifying this repo's source code or defaults** (`src/`, `defaults/`, `skills/`, `tests/`, docs).
  Follow [Contributor Rules](#branch-b-contributor-rules) and the Design Gate before architectural changes.

## Hard guardrails

- STRICT OPT-IN ONLY: NEVER invoke `orch_*` MCP tools unless the user explicitly asked to use the orchestrator, agent-router, multi-model routing, swarm, or `/orchestrate`.
- NEVER edit `defaults/catalog.toml` for personal setup. Edit the sparse user config (path from `agrmcp config path`) via `agrmcp config set` or `~/.config/orchestrator-mcp/models.toml`.
- NEVER put personal API keys, secrets, or local wrapper harnesses into the git repository.
- NEVER ask for, print, or store CLI credentials. Each CLI logs in by itself; tell the user which login command to run.
- NEVER run `agrmcp config reset all` unless the user explicitly asked to wipe everything. Bare `agrmcp config reset` only prints usage; always pass an explicit target.
- NEVER edit `dist/` directly or copy `dist/` outside the clone (`defaults/catalog.toml` and `skills/` are resolved relative to `dist/`).
- ALWAYS use absolute paths to `node` (`$(command -v node)`) and `<clone>/dist/cli/main.js` when registering MCP servers (GUI IDEs often miss nvm/asdf PATH).
- ALWAYS run `agrmcp config show --json` after any config change and treat a non-empty `config_warnings` or `quarantined` array as a failure. An invalid entity override is quarantined (ignored on its own); an unparsable file or invalid `[defaults]` falls back silently to the last valid config. On a cold start with a broken file (`cold_start_fallback: true`) every job is refused with `CONFIG_INVALID`; repair the file first.
- `agrmcp models discover` only previews; NEVER pass `--apply` unless the user asked to import models.
- ALWAYS run `agrmcp skill install` (or `--target <cli>` / `--dir <path>`) after editing `skills/orchestrate/SKILL.md` or pulling updates, and tell the user to restart MCP clients after `npm run build`.
- NEVER weaken sandbox flags (`allow_unsandboxed_write`, `extra_args`, `write_permission_mode`) or enable `inherit_mcp: true` just to "fix" a failing run. `write_permission_mode` is accepted for every driver but applied only by those that list modes; Codex ignores it.
- NEVER commit or push changes unless the user asked.

## Quick playbook 1: fresh install

```bash
node -v                                   # must be v22.12 or newer
cd <clone> && npm install && npm run build   # not the ci command: no package-lock.json is committed
node "$PWD/dist/cli/main.js" doctor       # which CLIs are installed and logged in
node "$PWD/dist/cli/main.js" setup --target all   # MCP entry + skill for every detected CLI, verified (or --target <cli>)
node "$PWD/dist/cli/main.js" mcp status --check   # exit 0 = no drift (skill and MCP both current)
```

`agrmcp setup` writes absolute `node` and `dist/cli/main.js` paths itself; preview with `--dry-run`, overwrite a disabled or foreign `orchestrator` entry only with `--force`. `agrmcp mcp install | status | uninstall` manage the MCP entry alone; manual recipes (for example `claude mcp add -s user ...`) are in guide §3. Then tell the user to restart their MCP client. Details: guide P1 and §3.

## Quick playbook 2: disable a harness or model

```bash
agrmcp config get harnesses.kiro.enabled         # check current value first
agrmcp config set harnesses.kiro.enabled false   # or: agrmcp config set models.<id>.enabled false
agrmcp config show --json                        # config_warnings must be []
```

Undo: `agrmcp config reset harnesses.kiro` (or `agrmcp config reset models.<id>`). This removes ALL user overrides on that entity, not just `enabled`; to undo one field use `agrmcp config reset models.<id>.<field>` or `agrmcp config reset harnesses.<id>.<field>`. For IDs with dots, slashes, or colons use `--section <section> --id <id> [--field <field>]`. Details: guide P3, P7.

## Quick playbook 3: verify setup

```bash
agrmcp doctor --json          # installed / auth_status / contract per harness; mcp_clients[] flags MCP/skill drift
agrmcp mcp status --check     # exit 0 = MCP entry and skill current; a disabled/foreign/invalid entry fails it
agrmcp config show --json     # config_warnings and quarantined must be []
agrmcp setup --target all     # repair drift; a target still not current gets verified:false + unverified_reason
```

Only when the user explicitly asked to set up or verify the orchestrator (never unasked in ordinary sessions): from the MCP client call `orch_catalog` (brief), then `orch_plan_preview` with one subtask. Details: guide P2, P9.

## Goal → section

| User asks to… | Go to |
|---|---|
| Install, build, first run, one-command `agrmcp setup` | Guide P1, §3 |
| Register MCP in Claude Code / Codex / Gemini / Antigravity / OpenCode / Pi / DSH / IDE | Guide §3 |
| Server missing only inside an IDE / ACP host (T3 Code, Zed, extensions) | Guide §3 "Isolated / ACP host config directories" |
| Check health, auth, MCP/skill drift, "why is harness X not used" | Guide P2 |
| Enable / disable a harness or model | Guide P3 |
| Change preset role, locale (`en`/`ru`), timeouts, concurrency, safety limits | Guide P4 |
| Add a wrapper binary / custom CLI / custom model / alias | Guide P5, `docs/examples/custom-harness.toml` |
| Find and import models the installed CLIs offer (`agrmcp models discover`) | Guide P10 |
| Edit config visually (incl. Settings UI "Discover models") | Guide P6 |
| Undo a change / reset | Guide P7 |
| Update after `git pull` | Guide P8 |
| Full verification | Guide P9 |
| Errors, warnings, odd behavior | Guide §5 |
| Valid enum values / required fields | Guide §6 |

## Branch B: contributor rules

- Gate before claiming done: `npm run build && npm run typecheck && npm test` (all offline).
- **Design Gate (when orchestrator/swarm is requested):** before changing contracts (MCP tool schemas, CLI flags, TOML schema), safety boundaries (sandbox, readonly, recursion, redaction), persistence/schemas, failover/concurrency, or choosing between competing architectures, consult cross-vendor advisors with `orch_plan_preview` using `intent: "design_consult"` (pass `host_vendor` so advisors come from other vendors), then record the decision.
- Single sources of truth: drivers in `src/drivers.ts`, schema in `src/config/schema.ts`, roles in `src/roles/registry.ts`, built-in catalog in `defaults/catalog.toml`.
- New TOML examples go in `docs/examples/` and need an expectation in `tests/unit/docs-examples.test.ts`.
- Keep `README.md`, `README.ru.md`, `README.zh.md` synchronized (same sections, tables, numbers).
- Keep this file ≤ 120 lines and English-only; put detail into `docs/AI_AGENT_GUIDE.md`.
- CLI wait and event-driven MCP status guidance: see `docs/AI_AGENT_GUIDE.md` §2, §5, and §6. `agrmcp wait` exit codes: `0` terminal, `2` timeout, `130` cancelled.
