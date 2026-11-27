# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-27

First open-source release.

### Added

- Standalone `stdio` MCP server with six tools: `orch_catalog`, `orch_plan_preview`, `orch_run`, `orch_status`, `orch_logs`, and `orch_cancel`, with lenient input validation and structured `INVALID_INPUT` errors.
- 17 built-in CLI harness drivers (`claude`, `codex`, `dsh`, `pi`, `antigravity`, `opencode`, `gemini`, `cursor`, `grok`, `kiro`, `fx`, `muse`, `copilot`, `droid`, `qwen`, `kimi`, `vibe`) with per-driver sandbox guarantees and a `verified` / `experimental` contract level.
- Built-in two-layer TOML catalog: 43 models across 12 labs, 24 aliases, 23 canonical roles, and 8 presets, plus sparse user overrides with per-entity quarantine and fail-closed cold-start behavior (`CONFIG_INVALID`).
- Server-side plan validation with cross-vendor review warnings, a multi-model Design Gate (`intent: "design_consult"`), and strict opt-in for orchestration.
- Git worktree isolation for parallel `write` subtasks, same-model sharding, per-session concurrency, and non-blocking per-harness scheduling.
- Verbatim error reporting (`raw_error`), classified failure codes, `safe_to_reroute`, role-aware `suggested_alternatives`, session cooldowns, and automatic failover.
- Activity-aware timeouts, redacted `checkpoint.json` files, and progress-preserving retries with `error.resume`.
- Event-driven waiting through `orch_status` cursors and the `agrmcp wait` command (exit codes `0` terminal, `2` timeout, `130` cancelled).
- Unified `agrmcp` CLI: `mcp`, `setup`, `mcp install | status | uninstall`, `settings`, `doctor`, `models discover`, `wait`, `config`, and `skill`, with verified one-command setup for every detected CLI and drift detection.
- Automatic model discovery from local CLI config files and zero-token listing commands, with reviewable imports.
- Localhost Technical Ledger Settings UI with origin-bound request tokens, a strict nonce CSP, and EN / RU locales.
- Companion cross-CLI `orchestrate` skill, `AGENTS.md`, and an AI agent guide with setup playbooks.
- English, Russian, and Chinese READMEs.
- Offline test suite (47 files, 2,150 tests) and GitHub Actions CI for Linux, macOS, and Windows.
- npm package metadata, a clean build that removes stale `dist/` files, and a published file list limited to `dist/`, `defaults/`, `skills/`, `README.md`, and `LICENSE`.

### Security

- Argv-only process spawning, process-tree cleanup, `ORCH_DEPTH` anti-recursion, secret redaction, and worktree git-filter isolation.
- Settings UI: loopback-only binding, `Host` validation, one-time bootstrap token with a 5-minute TTL, `HttpOnly; SameSite=Strict` cookie, `Sec-Fetch-Site: same-origin`, and an `X-Orch-Token` required on all `/api/*` calls.
- Zero telemetry: no outbound network requests from the router itself.

[Unreleased]: https://github.com/nazavod777/agent-router-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nazavod777/agent-router-mcp/releases/tag/v0.1.0
