# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

Only the latest `0.1.x` release receives security fixes.

## Reporting a vulnerability

Please report vulnerabilities **privately**. Do not open a public issue or pull request for a security problem.

Use GitHub private vulnerability reporting (Security Advisories):
<https://github.com/nazavod777/agent-router-mcp/security/advisories/new>

Please include the affected version, your operating system and Node.js version, the steps to reproduce, and the impact you observed. Do not include real credentials; redact tokens, API keys, and personal data from logs and screenshots. You will get an acknowledgement as soon as the maintainer can review it, and a fix or a clear explanation afterwards. Please allow time for a fix before disclosing the issue publicly.

## Threat model

`agent-router-mcp` is a **local, single-user tool**. It runs on your machine, with your user permissions, and starts the coding CLIs that you already installed and logged in to. It has no hosted service, no accounts, and no multi-tenant mode.

### What it protects

- **Local CLI subprocesses.** Every CLI is started directly from an argument vector, never through a shell, in its own process group. Recursion is blocked through `ORCH_DEPTH` / `ORCH_JOB_ID`. `readonly` jobs use the strongest guarantee each CLI offers (`os_sandbox` or `tool_allowlist`), and `extra_args` that would weaken `readonly` mode are rejected with `SANDBOX_POLICY_VIOLATION`. Cancellation, timeout, and normal exit clean up the whole process tree. Working directories can be confined with `ORCH_ALLOWED_ROOTS`; the canonical directory is validated when the job is accepted and checked again (`revalidateCwd`) right before the CLI is spawned. That check cannot be atomic with the spawn: Node.js `spawn({ cwd })` resolves the path itself, so a directory swapped by another process of yours in the instant between the check and the child's `chdir` is outside what the router can close. Keep allowed roots in directories only you can write. When `inherit_mcp` is false, a Codex or Copilot MCP config that cannot be read and named safely (oversized, invalid, too many servers or unusable names) refuses the run instead of leaving servers enabled.
- **Worktree isolation.** Parallel `write` subtasks run in dedicated git worktrees under `ORCH_STATE_DIR`. Git hooks, `fsmonitor`, and `sshCommand` are disabled for the git commands the router runs, and the repository's own git filters (clean/smudge/process) are blanked while worktrees are created, diffed, or removed, so a hostile repository configuration cannot run code through the router's git calls. Filters are listed from the repository, included and worktree config; more than 256 of them, or a filter name containing `=` (which a `-c` override cannot address), is an error, never a silently partial list. `git status` / `git diff` ignore submodules (`--ignore-submodules=all`), so a filter in a submodule's own config is never reached. System and global git config are ignored for those calls. Every service git call runs one absolute `git` executable (relative `PATH` entries such as `.` are skipped, so a `git` planted in a job's working directory is never run) and carries `ORCH_JOB_ID`, so process-tree cleanup can find it.
- **Localhost Settings UI (`agrmcp settings`).** The server binds only to `127.0.0.1` on an ephemeral port and validates the `Host` header (anti-DNS-rebinding). The URL printed in the terminal carries a one-time token that expires after 5 minutes and is exchanged for an `HttpOnly; SameSite=Strict` session cookie. The one-time redirect delivers an origin-bound `X-Orch-Token` in the URL fragment (`/#t=<token>`), which browsers never send over HTTP or in a `Referer`; the page moves it into `sessionStorage` (isolated per origin and port) and clears the fragment at once. `GET /` serves static HTML with no token in it, so another local server that receives the cross-port session cookie cannot read the token with a plain HTTP request. The token is required on **every** `/api/*` call, reads such as `GET /api/state` and `/api/health` included, because a cookie alone cannot prove which local origin is calling. Browser requests whose `Sec-Fetch-Site` is not `same-origin` are refused. Writes also require an exact `Origin`, `Content-Type: application/json`, and a 256 KiB body cap. The page is served with a nonce-based CSP and no CORS headers, and the server shuts down after 15 minutes without activity.
- **Secret redaction.** Values of environment variables whose names contain `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `CREDENTIAL` (8 characters or longer), `Bearer` tokens, `Authorization` headers, and URL credentials are scrubbed from logs, summaries, diffs, checkpoints, and error responses. User config, prompt files, and backups are written with mode `0600` on POSIX systems. On Windows `0600` is not enforced by NTFS, so keep the config and state directories inside your private user profile.
- **Fail-closed cold-start config.** An invalid override is quarantined on its own. If `models.toml` cannot be parsed when the server starts and there is no earlier valid config in memory, the server reports `cold_start_fallback: true` and refuses to run jobs with `CONFIG_INVALID`, instead of silently running with weakened safety settings.
- **Zero telemetry.** The router makes no outbound network requests of its own and collects no usage data. Network traffic comes only from the CLIs that you launch through it, and they inherit your proxy and CA settings.
- **Read-only model discovery.** Discovery reads only allowlisted model fields from regular, size-capped files, never credential files, and runs listing probes without a shell under an environment allowlist.

### Out of scope

- A malicious local user or process that already runs as you, or that can read your home directory, can read your CLI credentials and the router state; this tool cannot defend against that.
- The behavior of the underlying CLIs and model providers, including their own sandboxes, data handling, and prompt-injection exposure. CLIs without an OS sandbox (every harness except `codex` and `dsh`) run `write` jobs with your user permissions, limited at most by their own tool allowlist; use `isolation: "worktree"` or set `allow_unsandboxed_write = false` to limit that.
- Content of repositories you choose to run workers in.

## Hardening tips

- Keep `allow_unsandboxed_write = false` if you do not need unsandboxed writers.
- Set `ORCH_ALLOWED_ROOTS` to the directories workers may use.
- Never put credentials in the repository or in `models.toml`; each CLI keeps its own login.
- Run `agrmcp doctor` and `agrmcp config show --json` after changing configuration, and treat a non-empty `config_warnings` or `quarantined` list as a problem.
