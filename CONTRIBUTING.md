# Contributing to agent-router-mcp

Thanks for your interest in improving `agent-router-mcp`. Bug reports, documentation fixes, new driver and model cards, and focused features are all welcome.

For security problems, do **not** open a public issue; follow [SECURITY.md](SECURITY.md).

## Setup

Requirements: Node.js **>= 22.12**, npm, and git. You do not need any coding CLI installed: the whole test suite runs offline against mock CLI binaries.

```bash
git clone https://github.com/nazavod777/agent-router-mcp.git
cd agent-router-mcp
npm install
npm run build
```

No `package-lock.json` is committed yet, so use `npm install` (not `npm ci`) locally. `npm run build` removes `dist/` first, so stale files never survive a rebuild. Run the CLI with `node dist/cli/main.js <command>` or `npm link` for the `agrmcp` command. Never edit `dist/` by hand.

## The gate

Every change must pass all three offline checks before you open a pull request:

```bash
npm run build && npm run typecheck && npm test
```

CI runs the same gate on Linux and macOS (Node 22 and 24) and a Windows subset. Add or extend tests for behavior changes; a bug-fix test should fail on the unfixed code.

## Architecture overview

| Path | Role |
|---|---|
| `src/drivers.ts` | Single source of truth for the 17 `DRIVER_KINDS` and their metadata |
| `src/adapters/` | One adapter per CLI: argv builders, output parsers, identity probes |
| `src/config/` | Layered sparse TOML resolver, Zod schemas (`schema.ts`), entity ID policy, atomic locked writer |
| `defaults/catalog.toml` | Built-in catalog: harnesses, models, aliases, presets |
| `src/roles/registry.ts` | The 23 canonical roles |
| `src/planner/` | Plan preview, fallback routing, cross-vendor review guard |
| `src/runtime/` | Runner, worktrees, job store, concurrency, checkpoints, process-tree cleanup, redaction |
| `src/discovery/` | Model discovery: offline readers, zero-token probes, sanitizer, enrichment |
| `src/mcp/` | `stdio` MCP server and the six `orch_*` tools |
| `src/cli/` | The unified `agrmcp` CLI: `setup`, `mcp`, `settings`, `doctor`, `models`, `wait`, `config`, `skill` |
| `src/settings-ui/` | Localhost HTTP server and the zero-dependency HTML/JS editor ([`DESIGN.md`](DESIGN.md)) |
| `skills/orchestrate/SKILL.md` | The companion cross-CLI skill |
| `tests/` | Offline unit, integration, adapter, Settings UI, and MCP stdio tests |

Single sources of truth: drivers in `src/drivers.ts`, schema in `src/config/schema.ts`, roles in `src/roles/registry.ts`, and the built-in catalog in `defaults/catalog.toml`.

## Adding things

- **A driver:** add its metadata to `src/drivers.ts`, an adapter under `src/adapters/`, a catalog harness and at least one model card in `defaults/catalog.toml`, and offline tests (flags, `readonlyForbiddenArgs`, prompt delivery, parser). New drivers start as `experimental` until their flags and output are verified against the live CLI.
- **A model card:** add it to `defaults/catalog.toml` with honest strengths and weaknesses, a `checked_at` date, and a cost note. Never add keys to `[defaults]` without a Design Gate.
- **A TOML example:** put it in `docs/examples/` and add an expectation for it in `tests/unit/docs-examples.test.ts`.
- **A personal setup:** never edit `defaults/catalog.toml` for it. Use the sparse user config (`agrmcp config set ...`) instead, and never commit personal wrapper binaries, local paths, API keys, or other secrets.

Changes to MCP tool schemas, CLI flags, the TOML schema, safety boundaries (sandbox, readonly, recursion, redaction), persistence formats, or failover and concurrency semantics need a written design decision first. Open an issue to discuss it before you write code.

## Documentation

- Keep `README.md`, `README.ru.md`, and `README.zh.md` in parity: the same sections, tables, row order, and numbers (counts of tests, models, harnesses, roles, presets).
- After editing `skills/orchestrate/SKILL.md`, run `agrmcp skill install` so your installed copy matches.
- `AGENTS.md` must stay English-only and at most 120 lines; put detail in `docs/AI_AGENT_GUIDE.md`.
- Update stale docs and tests in the same change.

## Pull request checklist

- [ ] `npm run build && npm run typecheck && npm test` passes locally.
- [ ] New behavior has tests; a bug fix has a test that failed before the fix.
- [ ] No secrets, personal paths, or personal wrapper names anywhere in the diff.
- [ ] `defaults/catalog.toml` changes are general-purpose, not a personal setup.
- [ ] New TOML examples live in `docs/examples/` with a `tests/unit/docs-examples.test.ts` expectation.
- [ ] The three READMEs are updated together and still match.
- [ ] `AGENTS.md` is still at most 120 lines, English-only.
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` for user-visible changes.
- [ ] Contract, safety, or persistence changes link to the agreed design decision.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
