---
name: orchestrate
description: STRICT OPT-IN ONLY — activate ONLY when the user explicitly asks to use the orchestrator, agent-router, multi-model routing, swarm, or /orchestrate. NEVER activate spontaneously on ordinary requests. Once explicitly requested, autonomously split non-trivial tasks across CLIs/models via agent-router MCP with server-side plan validation, cross-vendor design consult & review, worktree isolation, and sandbox guardrails.
---

# Orchestrate: route subtasks to models, fast

Works the same way in any MCP client or CLI. Take models, prices, and presets only from the
MCP tools, never from memory. Plan tables are English by default; pass `locale: "ru"` to
`orch_plan_preview` only when the user is conversing in Russian.

**Language rule:** keep ALL model-to-model orchestration payloads in English
(`subtasks[].title`, `label`, `prompt`, `system_context`, and worker replies). Always
communicate with the user in the user's conversation language.

## 0. Strict opt-in gate (HARD RULE)
- **NEVER call any `orch_*` tool unless the user explicitly asked** to use the orchestrator,
  agent-router, multi-model routing, swarm, or `/orchestrate`.
- For ordinary coding, research, or chat requests where the user did not ask to orchestrate,
  do NOT invoke `orch_catalog`, `orch_plan_preview`, or `orch_run` — handle the task directly.
- Every step below (including the Design Gate in §1a and Autonomous Launch in §4) applies
  **only after the user has explicitly opted into orchestration**.
- Once the user explicitly asks to orchestrate with `agent-router-mcp`, keep all delegated
  subtasks inside `orch_*` — do NOT silently bypass it with another host delegation tool
  (in a dirty git tree, run dependent `shared` writes sequentially via `orch_run`).

## 1. Fast triage (max 1 turn)
- Orchestrate only when there are >=2 independent subtasks, or 1 subtask that needs another
  model (cross-vendor review, UI specialist, huge context). Otherwise do the work yourself,
  unless the Design Gate (§1a) triggers.
- Do NOT pre-read large source files, READMEs, or logs before delegating. Workers read them.
- Split into subtasks: goal, role, mode (`readonly` / `write`), isolation.

## 1a. Design gate: consult before designing
- **Triggers** (ANY holds, before writing code): changing an external contract (public API,
  MCP tool, CLI surface, config schema); crossing safety, sandbox, auth, permission, or
  recursion boundaries; changing data ownership, persistence format, or hard-to-reverse
  migrations; modifying failure, retry, failover, or concurrency semantics; choosing between
  >=2 competing architectures; or the user asks for a design / best approach.
- **Skip** (stay fast, do it solo): local reversible bug fix with a clear root cause;
  single-module change that follows an existing pattern; docs/copy/tests only; config value
  tweaks; the user already specified the exact design; or a consultation for the same
  decision already ran.
- **How** (full sequence, finish it before writing any code):
  1. `orch_plan_preview({ intent: "design_consult", host_vendor?, ... })` using 1 cross-vendor
  `readonly` advisor (`architecture` or `second_opinion`) in parallel with your own recon. For high-stakes, multi-subsystem, or irreversible decisions
  use 2 cross-vendor advisors (`architecture` + `second_opinion`, plus `security` for safety
  boundaries). Give every advisor the same brief (goal, constraints, file paths, not
  contents) without telegraphing your preferred answer, and ask for: recommendation,
  rejected options, main risk, and a verification check. If the preview warns that advisors
  share one vendor (or the host's), re-preview once on an `alternatives` entry.
  2. Launch every advisor with `orch_run({ plan_id, subtask_id, prompt, cwd, async: true,
     client_request_id })`.
  3. Wait using §5 (background `agrmcp wait --job ... --until all` or `orch_status({ plan_id, until: "any_terminal", wait_ms: 600000 })` following `next` until all finish).
  4. Synthesize (below) before writing any code.
- **Synthesize**: compare the advisors and your own view against actual code evidence, never
  by model prestige. Record the chosen option, the decisive fact, and the open risk in the
  final report.

## 2. Preview (skip `orch_catalog` for standard presets)
- Go straight to `orch_plan_preview({ cwd, preset?, locale?, subtasks })`.
  **Always use preset `"balanced"` by default** whenever the user did not specify another
  preset — NEVER ask the user which preset to pick.
- Call `orch_catalog` only to pick a specific model or inspect overrides. It is brief by
  default; use `detail: "full"` only when you need full cards or preset role maps.
- Write every `subtasks[].title` in English (model-to-model payload); user-facing messages
  stay in the user's conversation language.
- Mode rules:
  - `readonly` for research, review, security, architecture.
  - Parallel `write` subtasks require `isolation: "worktree"`. Never run two `write`
    subtasks in `shared` at the same time.
- **Parallel same-model sharding:** to fan one task out over several workers of the same
  model, set `subtasks[].shards` to `2..8` (ids become `<id>#1..<id>#N`) or list several
  subtasks on that model. `shards: 1` is the same as omitting `shards`: for an isolated single
  write job pass `isolation: "worktree"` explicitly. Stay within the harness `effective_cap`
  (`orch_catalog({ detail: "full" })` shows it per harness under `concurrency`; extra subtasks
  queue). `readonly` shards share the tree; `write` shards are forced into
  `isolation: "worktree"`. Give each shard a disjoint slice in its prompt.
- **Native CLI subagents:** a CLI's own subagents are governed by `native_subagents`
  (`cli_limit`: allowed up to the CLI's own limits; `off`: disabled per job) and
  `native_subagent_depth`. The per-invocation clamp is enforced only by `claude`, `codex`,
  `opencode`, and `dsh` (`pi` always starts with `--no-extensions`). Other CLIs (for example
  `gemini` and the experimental drivers) have no per-run flag: they report their discovered
  state (typically `unknown`) with a warning, so do not rely on `off` there. Never enable
  native subagents by passing `inherit_mcp: true`.

## 3. Auto-handle preview warnings (max 1 re-preview before launch)
- `self-review`: re-preview once with the review subtask on `alternatives[0]`
  (a different vendor).
- `missing` / `unauthenticated` harness: re-preview once on a ready harness.
- `unsandboxed` write: re-preview once on a ready sandboxed harness (`claude`, `codex`,
  `dsh`). If none is available and server config allows it, use `isolation: "worktree"`
  and proceed without asking; note it in the summary.
- `dirty git tree` + `worktree`: never commit or stash for the user. If edits depend on
  uncommitted changes, run the `write` subtasks sequentially in `shared` mode.
- `premium` model: avoid unless the user explicitly asked for `max-quality` or that model;
  otherwise re-preview with a standard-tier alternative.
- Surface server fallback warnings briefly in your launch/completion report.

## 4. Autonomous launch (ZERO approval prompts)
- NEVER ask "Run it? Reply ok or edit a row..." and never wait for confirmation.
- Pause after `orch_plan_preview` only if the user explicitly asked for a plan, dry-run, or
  cost estimate first.
- In ONE turn, launch all independent subtasks in parallel:
  `orch_run({ plan_id, subtask_id, prompt, cwd, async: true, client_request_id })`
  - `harness`, `model`, `effort`, `mode`, and `isolation` are hydrated automatically from
    the saved plan. Do not repeat them. `cwd` is hydrated from `plan_id` or
    `continue_from_job_id` when omitted, and `prompt` has a smart default on a continuation.
  - Arguments are lenient: `null`, blank strings, numeric strings, `"false"`, and enum
    aliases are accepted. Names listed in the reply's `ignored_arguments` were not
    recognized (check the suggestion). An `INVALID_INPUT` error carries `details.missing` and
    `details.example`: fix the call and send it again; it is never retryable as is.
  - Use a unique `client_request_id` per subtask; a retry with the same id is deduplicated.
  - Never pass `inherit_mcp: true` unless the user explicitly asks.
- Give each worker a self-contained prompt: goal, files or areas to read, constraints,
  expected output, and how to verify. Write the prompt, `system_context`, and `label` in
  English, and tell the worker to reply in English (for example end the prompt with
  "Reply in English."). Note: git worktrees omit gitignored `node_modules`, so for large multi-file write
  tasks let the coordinator run the full test suite after integrating diffs.
- Timeouts: **omit `timeout_sec`.** The server then picks a soft timeout by effort: 900 s
  (`default_timeout_sec`), or 1800 s (`high_effort_timeout_sec`) at effort `high`, `xhigh`, or
  `max`. With `auto_extend_timeout` (default on) a streaming job that keeps producing real
  output or CPU activity gets its soft deadline extended (by `timeout_extension_sec`, judged
  over `activity_window_sec`) up to the hard cap of 3600 s (`max_timeout_sec`). A streaming job
  with no activity for `idle_timeout_sec` (default 900 s; 0 disables) is stopped early as idle.
  Pass `strict_timeout: true` only when a hard, exact wall-clock limit is truly required: it
  disables extension. `agrmcp wait` defaults to 1800 s with a 7200 s maximum.
- **Shard big tasks:** a subtask that touches more than 8 files or several subsystems should be
  split into smaller subtasks (disjoint slices, see sharding in §2) instead of given a long
  timeout.
- **Concurrency scope:** `max_concurrency` is counted per repository session (worktrees fold
  into their main repo), according to `concurrency_scope` (`repo` default, `context`, or
  `global`); `host_max_concurrency` (default 24) is the global ceiling across all sessions. A
  `QUEUE_FULL` error carries `details.scope` (`"session"` or `"host"`) telling which limit was
  hit. `orch_status` jobs expose `queue: { position, blocked_by }` while waiting and
  `session_id`.
- **Workers are stateless by default.** Pass `continue_from_job_id` to `orch_run` only to
  keep working on the same artifact within one user prompt: implement -> test fails -> fix,
  address review findings, or pick up a timed-out job. When that work spans plans, pass the
  same task-scoped `context_id` to each `orch_plan_preview`; runs inherit it from the plan.
  `orch_run` also accepts `context_id` directly. The prior job must be terminal, must have
  finished within the last 2 hours, and must be in the same `cwd`, with the same `context_id`
  if set or the same `plan_id` otherwise.
  - NEVER chain across new user prompts or independent parallel subtasks, or into fresh
    cross-vendor reviews, `design_consult` advisors, or security-sensitive runs after
    untrusted content.
  - The compact handoff works across all 17 CLIs, including cross-vendor failover. A `write`
    continuation with `isolation: "worktree"` automatically reuses the parent's worktree,
    preserving uncommitted edits, only when the parent is a `write` job in the same git
    repo whose worktree still exists on disk, was not cleaned up, and whose process tree
    terminated cleanly. If another active continuation job currently holds that worktree,
    `orch_run` fails with retryable `CONCURRENCY_LIMIT`: wait for the holder to finish.
  - In a chain that reuses one worktree, the latest job's diff is measured against the
    original base commit and already includes every earlier step. Integrate ONLY the latest
    job's diff (never apply parent and child diffs both), and clean up ONCE via that latest
    job after integration; do not clean up the parent before integrating the child.

## 5. Efficient waiting
- Never poll in a loop or use shell `sleep` to wait for background jobs.
- **Option A — async shell notifications:** use this when the host can notify you when an
  asynchronous shell command finishes. Launch each worker with
  `orch_run({ ..., async: true })` and one background wait command:
  `agrmcp wait --job <id1> --job <id2> --until any` (or
  `node <clone>/dist/cli/main.js wait --job <id1> --job <id2> --until any`). End the turn.
  When the host reports the wait command finished, call
  `orch_status({ job_ids: [...] })` to snapshot the jobs and inspect results or failures.
  Call `orch_logs` for full outputs or diffs when needed. Reroute failed jobs immediately,
  then wait on the remaining job IDs.
- **Option B — MCP-only clients:** call
  `orch_status({ plan_id, until: "any_terminal", wait_ms: 600000 })`. The server
  automatically calibrates the wait to the host timeout. Use `notifications/progress`
  heartbeats when supported (the MCP client supplies `_meta.progressToken`; the server sends
  the heartbeats). Follow `next.args` (it carries the opaque `cursor`) while
  `pending_count > 0 || unseen_count > 0`, that is, whenever `next` is returned, including when
  the byte budget cut off finished jobs. Event delivery wakes the call; closely spaced completions may
  be coalesced for about 1.5 seconds. Use `until: "all_terminal"` only when no work can
  proceed earlier.
- `agrmcp wait` uses filesystem notifications with a safety fallback. It returns immediately
  when the initial snapshot already satisfies the condition and does not spin while idle.
  Its output is JSON with `wake_reason` (`terminal`, `all_terminal`, `timeout`, or
  `cancelled`), `pending_count`, and `jobs`. Exit codes: `0` terminal, `2` timeout, `130`
  cancelled (SIGINT/SIGTERM). Defaults are `any`, 1800 seconds (max 7200), and a 1500 ms
  settle window while jobs remain pending. Pass `--state-dir <path>` when the MCP server runs
  with a custom `ORCH_STATE_DIR`, otherwise `agrmcp wait` watches the default runs directory.
- Fetch full output via `orch_logs` only when you actually need it.
- Cancel a stuck or unneeded job with `orch_cancel`.

## 6. Verbatim failures & smart autonomous rerouting
- NEVER give up on a subtask just because a model or provider failed (quota, rate limit,
  overload, expired auth, unsupported model). Recover autonomously: max 2 automatic
  reroutes per subtask, zero approval prompts. Except `TIMEOUT`: stay on the same model, never
  reroute; recover by `error.timeout_kind` (below).
- Read the failure verbatim from `orch_status` / `orch_run`: `error.raw_error` (and
  `error.stderr_tail`), plus `error.code`, `error.failure_scope`, `error.safe_to_reroute`,
  and `error.suggested_alternatives` (role-matched, healthy, sandbox- and review-aware).
  `error.raw_error` / `error.stderr_tail` in `orch_status` are compact excerpts; call
  `orch_logs` (`part: "stderr"` / `"stdout"`) when you need the full saved output.
- Check `error.safe_to_reroute` before EVERY reroute and reroute only when it is `true`. This
  applies in `readonly` and `worktree` too: a failed process-tree termination returns
  `safe_to_reroute: false` even there, because a surviving process may still be running.
- Before re-planning, drop any stale `override` on the failed subtask: an explicit
  `override` takes precedence over `exclude_harnesses` / `exclude_models`, so the failed
  route would be picked again.
- Pick the recovery by the actual error:
  - `QUOTA_EXCEEDED`, `AUTH_REQUIRED`, `RATE_LIMITED`, `PROVIDER_OVERLOADED`, `CLI_NOT_FOUND`,
    `HARNESS_UNAVAILABLE` (`failure_scope: "harness"`): never retry another model on the
    same harness. Only if `safe_to_reroute` is `true`: clean up a clean failed worktree
    (`orch_cancel({ job_id, cleanup_worktree: true })`), re-plan with
    `orch_plan_preview({ ..., exclude_harnesses: [failed_harness, ...] })` (or override to
    the best entry in `suggested_alternatives`, keeping cross-vendor review intact), and
    launch `orch_run` immediately with a fresh `client_request_id`.
  - `MODEL_UNSUPPORTED` (`failure_scope: "model"`): only if `safe_to_reroute` is `true`, re-plan
    with `exclude_models: [failed_model, ...]` (or override to `suggested_alternatives[0]`) and
    launch immediately; if it is `false`, handle it as in the `safe_to_reroute: false` item below.
  - `PROMPT_TOO_LARGE`: with `safe_to_reroute: true`, switch to a stdin/long-context harness from
    `suggested_alternatives`, or slim the prompt by passing file paths instead of dumps.
  - `TIMEOUT`: NEVER fail over to a different model. Check the termination warnings first
    ("Could not terminate the process tree"): if process termination failed
    (`safe_to_reroute: false` and no `error.resume`), do not resume into the poisoned
    checkout and do not start another writer there: stop and report to the user (see the
    `safe_to_reroute: false` item below). Otherwise retry or
    continue on the SAME harness/model, branching on `error.timeout_kind`:
    - `"soft"`: the job was cut at its soft deadline. Retry or continue via `error.resume`; a
      larger `timeout_sec` is allowed (use `error.suggested_timeout_sec`, up to
      `max_timeout_sec`).
    - `"idle"`: the CLI stalled (no output or CPU activity). Check `error.stderr_tail`, auth,
      and quota first, then resume WITHOUT inflating the timeout (no larger `timeout_sec`).
    - `"hard"`: the `max_timeout_sec` cap was reached. Shard the work into smaller subtasks.
    Progress is preserved: call
    `orch_run(error.resume.args)` directly (it holds `continue_from_job_id`, the suggested
    `timeout_sec`, and `plan_id` + `subtask_id`, which `require_plan_id = true` deployments
    need); without `error.resume`, build `orch_run({ continue_from_job_id: <timed_out_job_id>,
    timeout_sec })` yourself. Re-running the same `plan_id` + `subtask_id`
    also auto-continues the timed-out job's progress; pass `fresh: true` to discard it and
    start over. Inspect partial work with `orch_logs({ job_id, part: "checkpoint" })`. Split the subtask into smaller
    focused pieces when `timeout_kind` is `"hard"` (the job already ran at `max_timeout_sec`). Failover to another
    harness/model is ONLY for non-timeout failures; a timeout never triggers a cooldown.
  - `NON_ZERO_EXIT` / `PARSE_ERROR`: read `raw_error`. Provider, network, or CLI-flag
    failure with `safe_to_reroute: true` -> reroute via `exclude_harnesses`. Prompt or `cwd`
    problem -> fix the input first.
  - `safe_to_reroute: false` (partial `shared` edits, or a failed process-tree termination in any
    isolation): STOP work on that subtask. NEVER reroute it to another harness/model, never launch a second
    (concurrent) writer on the same checkout or worktree, and never overwrite its files. After an unconfirmed
    process-tree termination the old process may still be writing, so a `git status` / `git diff` is not proof that
    the checkout is quiet: do not inspect it and carry on. Report to the user (job id, `raw_error`, checkout or
    worktree path, and that the process tree was not confirmed terminated) and let the user decide whether to keep or
    revert the partial changes and when it is safe to continue.
- Session cooldowns already steer later previews away from a degraded harness/model (with a
  warning); pass `refresh_health: true` only when you know the provider has recovered.
- Policy errors (`SANDBOX_POLICY_VIOLATION`, `RECURSION_BLOCKED`): fix the plan or prompt;
  never bypass the guard.
- **HARD STOP** when all enabled delegation models are unavailable (`DELEGATION_UNAVAILABLE`,
  `launchable: false`, `delegation_status: "exhausted"`, or `delegation_state: "exhausted"` /
  top-level `delegation.state: "exhausted"`): immediately stop all main work. Do NOT run the delegated subtasks yourself
  and do not silently switch to another delegator. Cancel only meaningless dependent runs,
  preserve dirty shared edits and dirty worktrees, and notify the user (in the user's
  conversation language) with every blocked harness/model, its verbatim `raw_error`, and
  recovery options (log in, install the CLI, wait until `earliest_retry_at`,
  `refresh_health: true`, enable another harness).

## 7. Integration and cleanup
- For each worktree job, inspect the diff with `orch_logs({ job_id, part: "diff" })`.
- Verify results yourself; do not take a worker's report on faith.
- `diff.patch` lists untracked files by name only, without their contents. Transfer untracked
  files from `worktree.path` itself, then verify the full result.
- Integrate the changes into the working copy, resolve conflicts, and run the project's
  tests and lint.
- Then remove the worktree with `orch_cancel({ job_id, cleanup_worktree: true })`.
  Never remove a worktree before its diff is integrated (or the user chose to discard it).
  A worktree with changes, ignored files, or a moved HEAD is kept; use
  `orch_cancel({ job_id, cleanup_worktree: true, force_cleanup: true })` only after you have
  confirmed that the remaining worktree changes can be discarded.
- For a continuation chain that reused one worktree, inspect, integrate, and clean up only
  via the latest job; its diff already contains the earlier steps.

## 8. Final report
- Include the compact routing summary (`markdown_table` from the preview, updated if
  anything was rerouted) so the user sees which harness/model ran each subtask.
- Report every failover chain: which `harness/model` failed, its verbatim `raw_error`, and
  which replacement `harness/model` completed the subtask.
- Then: what each subtask did, what was verified, what was not, fallback warnings, and
  remaining risks.
