import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { ConfigManager } from "../config/resolver.js";
import { CLI_NAME } from "../cli/name.js";
import { logger } from "../logging.js";
import type { PlanPreviewResult } from "../planner/preview.js";
import { OrchestratorRunner } from "../runtime/runner.js";
import { registerOrchestratorTools, type ToolDependencies } from "./tools.js";

export type OrchestratorMcpDependencies = Partial<ToolDependencies>;

const instructions = `STRICT OPT-IN ONLY: NEVER call any orch_* tool unless the user explicitly asks to use the orchestrator, agent-router, multi-model routing, swarm, or /orchestrate. For ordinary requests where the user did not ask to orchestrate, do NOT call orch_catalog, orch_plan_preview, or orch_run.
When the user explicitly asks to orchestrate, keep delegated subtasks inside orch_* (do not silently bypass with another host delegator) and run autonomously without asking for launch approval; let workers read the repo and logs. Keep all model-to-model orchestration payloads (subtasks[].title, label, prompt, system_context, and worker replies) in English, and tell every worker in its prompt to reply in English (e.g. "Reply in English."); communicate with the user in the user's conversation language:
0. Before designing an external contract, safety/sandbox boundary, persistence/migration, failover/concurrency semantics or a choice between architectures, consult 1-2 cross-vendor readonly advisors: orch_plan_preview({intent:"design_consult",host_vendor?,...}), launch them with orch_run, wait via step 2 (background ${CLI_NAME} wait or orch_status until:"any_terminal"), and synthesize their answers before writing code. Skip for local reversible fixes that follow existing patterns.
1. Call orch_plan_preview({cwd, preset?, locale?, subtasks:[{id,title,task_type,mode?}]}). Always default to preset "balanced" when the user did not specify another preset (never ask the user which preset to pick). Use orch_catalog for model choices. Fix warnings in one re-preview. Pick another vendor for independent review. Prefer sandboxed writes. In a dirty tree, keep dependent writes sequential and shared. Never commit or stash for the user. For parallel same-model work set subtasks[].shards to 2-8 (shards:1 equals omitting it; pass isolation:"worktree" explicitly for an isolated single write job) or list several subtasks on one model, up to that harness's effective_cap (orch_catalog detail:"full", concurrency); readonly shards share the tree, write shards are forced into worktrees. A CLI's own native subagents stay under the native_subagents and native_subagent_depth settings; the per-run clamp is enforced only by claude, codex, opencode and dsh (pi always starts with --no-extensions), while other CLIs such as gemini have no per-run flag and report unknown with a warning; never pass inherit_mcp:true to enable native subagents.
2. Launch immediately unless asked for a plan, dry-run or cost estimate. Call orch_run({plan_id,subtask_id,prompt,cwd,async:true,client_request_id}) for each independent subtask. Then wait without polling turns: prefer a background shell command "${CLI_NAME} wait --job <ids...> --until any" when the host wakes the agent on background-process exit; otherwise call orch_status({plan_id,until:"any_terminal",wait_ms:600000}) and follow the returned next.args (cursor included) while pending_count > 0 or unseen_count > 0, that is, whenever next is returned. The client supplies _meta.progressToken and the server streams MCP progress notifications, calibrates the hold time to the host's limits, and wakes on the first finished or failed job, so react to each completion (review, reroute, integrate) without waiting for the rest. orch_run takes cwd from plan_id or continue_from_job_id when omitted, and prompt has a default on a continuation. Tool arguments are lenient (null and blank are ignored, names in ignored_arguments were not recognized); an INVALID_INPUT error lists details.missing and details.example, so fix the call and send it again. Timeouts: OMIT timeout_sec, because the server chooses it by effort and automatically extends a streaming job that keeps making real progress, up to max_timeout_sec, while a stalled streaming job is stopped early as idle; pass strict_timeout:true only when a hard exact wall-clock limit is truly required. SHARD any task that touches more than 8 files or several subsystems into smaller subtasks. Concurrency (max_concurrency) is counted per repository session (see concurrency_scope), with host_max_concurrency as the global ceiling; a QUEUE_FULL error carries details.scope ("session" or "host"), and orch_status jobs show queue:{position,blocked_by} and session_id.
3. Never abandon a subtask because a model or provider failed. Read error.raw_error and error.stderr_tail verbatim (excerpts; use orch_logs for full output), plus error.code, error.failure_scope, error.safe_to_reroute and error.suggested_alternatives. If safe_to_reroute is true, clean up any empty failed worktree with orch_cancel({job_id,cleanup_worktree:true}). Drop any failed override, then re-plan using orch_plan_preview with exclude_harnesses for harness failures (QUOTA_EXCEEDED, AUTH_REQUIRED, RATE_LIMITED, PROVIDER_OVERLOADED, CLI_NOT_FOUND, SANDBOX_UNAVAILABLE) or exclude_models for MODEL_UNSUPPORTED. On TIMEOUT, do NOT fail over to another model: retry or continue the SAME harness and model with a larger timeout_sec (up to max_timeout_sec) without losing progress, branching on error.timeout_kind: "soft" means retry or continue via error.resume (a larger timeout_sec is allowed); "idle" means the CLI stalled, so check error.stderr_tail, auth and quota, and resume WITHOUT inflating timeout_sec; "hard" means the max_timeout_sec cap was reached, so shard into smaller subtasks. First check the termination warnings: if process termination failed (safe_to_reroute:false and no error.resume), do not blindly resume into a poisoned checkout. Otherwise call orch_run(error.resume.args) as given (it already includes plan_id and subtask_id, which require_plan_id deployments need) or orch_run({continue_from_job_id,timeout_sec}) (re-running the same plan_id and subtask_id also continues timeout progress automatically, fresh:true discards it) and inspect partial work with orch_logs({job_id,part:"checkpoint"}); only split when error.timeout_kind is "hard" (already at max_timeout_sec). Fail over to another harness/model ONLY on non-timeout errors (QUOTA_EXCEEDED, AUTH_REQUIRED, RATE_LIMITED, PROVIDER_OVERLOADED, CLI_NOT_FOUND, SANDBOX_UNAVAILABLE, HARNESS_UNAVAILABLE, MODEL_UNSUPPORTED, PROMPT_TOO_LARGE). For PROMPT_TOO_LARGE use stdin or a long-context model, or pass file paths. Launch immediately with a new client_request_id, up to 2 reroutes per subtask. If safe_to_reroute is false, STOP that subtask: never reroute it, never start a second writer on the same checkout (an unconfirmed process tree may still be writing), and report to the user, who decides what to keep or revert.
Workers are stateless by default. Pass continue_from_job_id (plus a task-scoped context_id on orch_plan_preview and orch_run when spanning plans in the same user prompt) ONLY to iterate on the same artifact (fix tests, address review feedback, resume a timed-out job); NEVER across different user prompts, independent parallel subtasks, or fresh cross-vendor reviews and design consults.
4. Inspect orch_logs({job_id,part:"diff"}) (it lists untracked files by name only: copy their contents from worktree.path), integrate, verify the full result, test and clean up worktrees (orch_cancel force_cleanup:true only after confirming the remaining worktree changes can be discarded). HARD STOP on DELEGATION_UNAVAILABLE, launchable:false, delegation_status:'exhausted', or delegation_state:'exhausted' (all enabled delegation models unavailable): immediately STOP all main work, do NOT execute the delegated subtasks yourself and do not silently switch delegators, preserve dirty shared edits and dirty worktrees, and notify the user (in the user's conversation language) with every blocked harness/model, verbatim raw_error, and recovery options. Report the routing chain and each provider's verbatim error in the final response.`;

function createServer(deps: OrchestratorMcpDependencies) {
  const configManager = deps.configManager ?? new ConfigManager();
  const adapterRegistry = deps.adapterRegistry ?? new AdapterRegistry();
  const runner = deps.runner ?? new OrchestratorRunner<PlanPreviewResult>({ configManager, adapterRegistry });
  const server = new McpServer({ name: "agent-router-mcp", version: "0.1.1" }, { instructions });
  registerOrchestratorTools(server, { ...deps, configManager, adapterRegistry, runner });
  return { server, runner };
}

export function createOrchestratorMcpServer(deps: OrchestratorMcpDependencies = {}): McpServer {
  return createServer(deps).server;
}

export async function runStdioMcpServer(deps: OrchestratorMcpDependencies = {}): Promise<void> {
  const { server, runner } = createServer(deps);
  const transport = new StdioServerTransport();
  let requestShutdown!: () => void;
  const requested = new Promise<void>((resolve) => { requestShutdown = resolve; });
  const shutdown = () => requestShutdown();
  const onProtocolError = (error: Error) => logger.error("MCP protocol error.", { message: error.message });
  const onOutputError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") logger.error("MCP stdout failed.", { message: error.message });
    shutdown();
  };
  const onStderrError = () => {
    // Swallow closed-stderr EPIPE so shutdown/cleanup never crashes mid-flight.
  };

  server.server.onclose = shutdown;
  server.server.onerror = onProtocolError;
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdout.on("error", onOutputError);
  process.stderr.on("error", onStderrError);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    if (process.stdin.readableEnded || process.stdin.destroyed) shutdown();
    await requested;
  } finally {
    try {
      // Closing MCP also aborts any outstanding status waits.
      const results = await Promise.allSettled([Promise.resolve().then(() => runner.shutdown()), server.close()]);
      for (const result of results) {
        if (result.status === "rejected") {
          logger.error("MCP shutdown failed.", {
            message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
          process.exitCode = 1;
        }
      }
    } finally {
      process.stdin.off("end", shutdown);
      process.stdin.off("close", shutdown);
      process.stdout.off("error", onOutputError);
      process.stderr.off("error", onStderrError);
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
  }
}
