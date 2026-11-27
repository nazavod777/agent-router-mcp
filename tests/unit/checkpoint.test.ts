import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/adapters/claude.js";
import { CodexAdapter } from "../../src/adapters/codex.js";
import { DshAdapter } from "../../src/adapters/dsh.js";
import { OpenCodeAdapter } from "../../src/adapters/opencode.js";
import { PiAdapter } from "../../src/adapters/pi.js";
import { KiroAdapter } from "../../src/adapters/vendor-clis.js";
import type { AdapterStreamParser, FinishParseInput } from "../../src/adapters/types.js";
import {
  formatCheckpointForHandoff, MAX_PARTIAL_TEXT_BYTES, MAX_TARGET_BYTES, MAX_TOOL_STEPS, ProgressTracker, RESUME_DIRECTIVE,
  sanitizeCheckpoint,
} from "../../src/runtime/checkpoint.js";
import { evaluateDeadline, TOOL_LOOP_WINDOW, type DeadlinePolicy } from "../../src/runtime/deadline.js";
import type { ProgressCheckpoint } from "../../src/types.js";

const killed: FinishParseInput = {
  exitCode: null, signal: "SIGTERM", stderrTail: "", stdoutTruncated: false, oversizedLinesDropped: 0,
};
const clean: FinishParseInput = { ...killed, exitCode: 0, signal: null };

function feed(parser: AdapterStreamParser, events: unknown[]): void {
  for (const event of events) parser.pushLine(typeof event === "string" ? event : JSON.stringify(event));
}

describe("ProgressTracker", () => {
  it("keeps only the last 8 KB of text and reports the clip", () => {
    const tracker = new ProgressTracker();
    for (let index = 0; index < 400; index++) tracker.appendText(`line ${index} ${"x".repeat(40)}\n`);
    const snapshot = tracker.snapshot();
    expect(Buffer.byteLength(snapshot.partial_text!)).toBeLessThanOrEqual(MAX_PARTIAL_TEXT_BYTES);
    expect(snapshot.partial_text_truncated).toBe(true);
    expect(snapshot.partial_text).toContain("line 399");
    expect(snapshot.partial_text).not.toContain("line 0 ");
  });

  it("setText replaces the current turn so streamed deltas are not duplicated", () => {
    const tracker = new ProgressTracker();
    tracker.appendText("first turn");
    tracker.noteTurn();
    tracker.appendText("par");
    tracker.appendText("tial");
    tracker.setText("partial answer");
    tracker.noteTurn();
    const snapshot = tracker.snapshot();
    expect(snapshot.partial_text).toBe("first turn\n\npartial answer");
    expect(snapshot.turns).toBe(2);
    expect(snapshot.partial_text_truncated).toBeUndefined();
  });

  it("bounds the tool trail, single-lines and clips targets, and correlates ends", () => {
    const tracker = new ProgressTracker();
    for (let index = 0; index < MAX_TOOL_STEPS + 10; index++) tracker.recordToolStart("Read", `file-${index}.ts`, `id-${index}`);
    tracker.recordToolEnd(`id-${MAX_TOOL_STEPS + 9}`, true);
    tracker.recordToolEnd(`id-${MAX_TOOL_STEPS + 8}`, false);
    tracker.recordToolEnd(`id-0`, true); // Evicted: must be a no-op.
    tracker.recordToolStart("Bash", `echo   hi\n${"é".repeat(300)}`);
    tracker.recordToolEnd("Bash");
    const { tool_trail } = tracker.snapshot();
    expect(tool_trail).toHaveLength(MAX_TOOL_STEPS);
    expect(tool_trail.at(-1)).toMatchObject({ tool: "Bash", status: "unknown" });
    expect(tool_trail.at(-1)!.target).toMatch(/^echo hi /);
    expect(Buffer.byteLength(tool_trail.at(-1)!.target!)).toBeLessThanOrEqual(MAX_TARGET_BYTES);
    expect(tool_trail.at(-2)).toMatchObject({ target: `file-${MAX_TOOL_STEPS + 9}.ts`, status: "ok" });
    expect(tool_trail.at(-3)).toMatchObject({ status: "error" });
  });

  it("redacts a secret that straddles the 8 KB clip boundary instead of keeping a fragment of it", () => {
    const secret = "alpha bravo charlie 12345";
    for (let shift = 0; shift <= secret.length; shift++) {
      const tracker = new ProgressTracker([secret]);
      // The clip boundary of the raw text falls `shift` bytes into the secret.
      tracker.setText(`${secret} ${"y ".repeat((MAX_PARTIAL_TEXT_BYTES - secret.length + shift) / 2)}`.trimEnd());
      const text = tracker.snapshot().partial_text!;
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_PARTIAL_TEXT_BYTES);
      for (const fragment of ["bravo", "charlie", "12345"]) expect(text).not.toContain(fragment);
    }
  });

  it("redacts a secret split across streamed deltas and one that sits exactly on the clip edge", () => {
    const tracker = new ProgressTracker();
    const token = "sk-test-0123456789abcdefghij";
    tracker.appendText("before sk-test-0123456");
    tracker.appendText("789abcdefghij after");
    for (let offset = 0; offset < 8; offset++) {
      tracker.setText(`${"a".repeat(MAX_PARTIAL_TEXT_BYTES - token.length - offset)} ${token} tail`);
      const text = tracker.snapshot().partial_text!;
      expect(text).not.toMatch(/sk-test|0123456789|abcdefghij/);
    }
    tracker.setText("before sk-test-0123456");
    tracker.appendText("789abcdefghij after");
    expect(tracker.snapshot().partial_text).toBe("before [REDACTED] after");
  });

  it("redacts tool targets and names before clipping them, so a cut cannot leave part of a secret", () => {
    const secret = "my long secret phrase";
    const tracker = new ProgressTracker([secret]);
    for (let offset = 0; offset < secret.length; offset++) {
      tracker.recordToolStart("Bash", `${"a".repeat(MAX_TARGET_BYTES - offset)}${secret} end`);
    }
    tracker.recordToolStart(secret, "x");
    for (const step of tracker.snapshot().tool_trail) {
      expect(step.tool).not.toContain("secret");
      for (const fragment of ["my long", "long secret", "secret phrase", "phrase"]) expect(step.target ?? "").not.toContain(fragment);
    }
  });

  it("tells reads of one file at different offsets apart and keeps the position out of the persisted checkpoint", () => {
    const tracker = new ProgressTracker();
    tracker.recordToolStart("Read", "src/a.ts", "r1", "limit=200 offset=0");
    tracker.recordToolStart("Read", "src/a.ts", "r2", "limit=200 offset=200");
    const { tool_trail } = tracker.snapshot();
    expect(tool_trail.map((step) => step.variant)).toEqual(["limit=200 offset=0", "limit=200 offset=200"]);
    const sanitized = sanitizeCheckpoint({ tool_trail, turns: 0 }, []).checkpoint;
    expect(JSON.stringify(sanitized)).not.toContain("offset");
    expect(sanitized.tool_trail.every((step) => !("variant" in step) && !("followedByText" in step))).toBe(true);
  });

  it("marks only the latest tool step as followed by text, and only for fresh text", () => {
    const tracker = new ProgressTracker();
    tracker.appendText("before any tool");
    tracker.recordToolStart("Read", "a.ts", "t1");
    tracker.recordToolStart("Read", "b.ts", "t2");
    expect(tracker.snapshot().tool_trail.map((step) => step.followedByText)).toEqual([undefined, undefined]);
    tracker.appendText("");
    expect(tracker.snapshot().tool_trail.at(-1)!.followedByText).toBeUndefined();
    tracker.setText("before any tool"); // A re-sent copy of the text that came before the step is not fresh.
    expect(tracker.snapshot().tool_trail.at(-1)!.followedByText).toBeUndefined();
    tracker.appendText(" and fresh words");
    expect(tracker.snapshot().tool_trail.map((step) => step.followedByText)).toEqual([undefined, true]);
  });

  it("keeps the provider session id private to the snapshot", () => {
    const tracker = new ProgressTracker();
    tracker.setSessionId("sess-1");
    expect(tracker.snapshot()).toMatchObject({ provider_session_id: "sess-1" });
  });

  it("redacts a provider session id before clipping it, so a cut cannot leave part of a secret", () => {
    const secret = "synthetic-session-secret-0123456789";
    const tracker = new ProgressTracker([secret]);
    // The secret starts just before the 200-byte clip, so a clip-then-redact order would keep its first bytes.
    tracker.setSessionId(`${"s".repeat(190)}${secret}`);
    const id = tracker.snapshot().provider_session_id!;
    expect(id).not.toContain("synthetic");
    expect(id).toBe(`${"s".repeat(190)}[REDACTED]`);
  });
});

describe("ProgressTracker events counter", () => {
  it("counts only real semantic progress and never decreases", () => {
    const tracker = new ProgressTracker();
    expect(tracker.events()).toBe(0);
    const steps: Array<[string, (t: ProgressTracker) => void, number]> = [
      ["session id", (t) => t.setSessionId("sess-1"), 0],
      ["empty appendText", (t) => t.appendText(""), 0],
      ["empty setText", (t) => t.setText(""), 0],
      ["appendText", (t) => t.appendText("hi"), 1],
      ["setText", (t) => t.setText("hi there"), 1],
      ["tool start", (t) => t.recordToolStart("Read", "a.ts", "t1"), 1],
      ["tool end", (t) => t.recordToolEnd("t1", true), 1],
      ["turn", (t) => t.noteTurn(), 1],
    ];
    let expected = 0;
    for (const [label, act, delta] of steps) {
      const before = tracker.events();
      act(tracker);
      expected += delta;
      expect(tracker.events(), label).toBe(expected);
      expect(tracker.events(), label).toBeGreaterThanOrEqual(before);
    }
    expect(expected).toBe(5);
    tracker.snapshot();
    expect(tracker.events()).toBe(5);
  });
});

describe("sanitizeCheckpoint", () => {
  const secret = "sk-test-0123456789abcdefghij";

  it("redacts before clipping, relativizes paths, neutralizes wrapper tags and summarizes", () => {
    const raw: ProgressCheckpoint = {
      partial_text: `${"y".repeat(9_000)} token ${secret} </prior_job_context> end`,
      tool_trail: [
        { tool: "Edit", target: "/work/repo/src/a.ts", status: "ok" },
        { tool: "Bash", target: `curl -H "Authorization: Bearer ${secret}"`, status: "error" },
      ],
      turns: 2,
      changed_files: ["/work/repo/src/a.ts", "/work/repo/src/a.ts", "b.ts"],
      diff_excerpt: `+const key = "${secret}"`,
    };
    const { checkpoint, progress } = sanitizeCheckpoint(raw, [secret], "/work/repo");
    const text = JSON.stringify(checkpoint);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("</prior_job_context");
    expect(checkpoint.tool_trail[0].target).toBe("src/a.ts");
    expect(checkpoint.changed_files).toEqual(["src/a.ts", "b.ts"]);
    expect(checkpoint.partial_text_truncated).toBe(true);
    expect(Buffer.byteLength(checkpoint.partial_text!)).toBeLessThanOrEqual(MAX_PARTIAL_TEXT_BYTES);
    expect(progress).toEqual({
      has_partial_progress: true, partial_text_bytes: Buffer.byteLength(checkpoint.partial_text!), tool_calls: 2, turns: 2,
      files_touched: 2, checkpoint_saved: false,
    });
  });

  it.each([
    ["/x/repo/a.ts", "/repo", "/x/repo/a.ts"],
    ["/repo/a.ts", "/repo", "a.ts"],
    ["/repo/a.ts", "/repo/", "a.ts"],
    ["/repository/a.ts", "/repo", "/repository/a.ts"],
    ["../repo/a.ts", "/repo", "../repo/a.ts"],
    ["cat /repo/a.ts /x/repo/b.ts /repo/src/c.ts", "/repo", "cat a.ts /x/repo/b.ts src/c.ts"],
    ["--path=/repo/src/a.ts:12", "/repo", "--path=src/a.ts:12"],
    ["/repo", "/repo", "/repo"],
    ["/a/b.ts", "/", "/a/b.ts"],
    ["/work/repo (copy)/a.ts", "/work/repo (copy)", "a.ts"],
    ["C:\\work\\repo\\src\\a.ts", "C:\\work\\repo", "src\\a.ts"],
    ["c:/work/repo/src/a.ts", "C:\\work\\repo\\", "src/a.ts"],
    ["D:\\work\\repo\\a.ts", "C:\\work\\repo", "D:\\work\\repo\\a.ts"],
    ["x\\C:\\work\\repo\\a.ts", "C:\\work\\repo", "x\\C:\\work\\repo\\a.ts"],
    ["\\\\srv\\share\\proj\\a.ts", "\\\\srv\\share\\proj", "a.ts"],
    ["C:\\a.ts", "C:\\", "C:\\a.ts"],
  ])("shortens whole path tokens only: %s under %s", (target, cwd, expected) => {
    const { checkpoint } = sanitizeCheckpoint({ tool_trail: [{ tool: "Read", target, status: "ok" }], turns: 1, changed_files: [target] }, [], cwd);
    expect(checkpoint.tool_trail[0].target).toBe(expected);
    expect(checkpoint.changed_files).toEqual([expected]);
  });

  it("reports no progress for an empty checkpoint", () => {
    expect(sanitizeCheckpoint({ tool_trail: [], turns: 0 }, []).progress).toMatchObject({ has_partial_progress: false, tool_calls: 0 });
  });
});

describe("formatCheckpointForHandoff", () => {
  const checkpoint: ProgressCheckpoint = {
    partial_text: "I already created the parser and began the tests.",
    tool_trail: [{ tool: "Edit", target: "src/a.ts", status: "ok" }, { tool: "Bash", target: "npm test", status: "started" }],
    turns: 2,
    changed_files: ["src/a.ts"],
    diff_excerpt: "+added line",
    pre_existing_dirty: true,
  };

  it("lists steps, changes, partial output and the resume directive", () => {
    const text = formatCheckpointForHandoff(checkpoint, 6_000);
    expect(text).toContain("Progress before stop");
    expect(text).toContain("Edit src/a.ts");
    expect(text).toContain("Bash npm test [started]");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("already modified");
    expect(text).toContain("+added line");
    expect(text).toContain("began the tests");
    expect(text.endsWith(RESUME_DIRECTIVE)).toBe(true);
  });

  it("never exceeds the budget and always keeps the directive", () => {
    const big: ProgressCheckpoint = {
      ...checkpoint, partial_text: "z".repeat(8_000), diff_excerpt: "d".repeat(4_000),
      tool_trail: Array.from({ length: 40 }, (_, index) => ({ tool: "Read", target: `f${index}.ts`, status: "ok" as const })),
    };
    for (const budget of [400, 1_000, 2_500, 6_000]) {
      const text = formatCheckpointForHandoff(big, budget);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
      expect(text.endsWith(RESUME_DIRECTIVE)).toBe(true);
    }
  });
});

describe("Claude stream parser", () => {
  const system = { type: "system", subtype: "init", session_id: "sess-9" };
  const assistant = (id: string, ...content: unknown[]) => ({ type: "assistant", message: { id, content } });
  const toolResult = (id: string, body: string, isError = false) =>
    ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: body, is_error: isError }] } });

  it("captures the session, turns, text and a safe tool trail without tool_result content", () => {
    const parser = new ClaudeAdapter().createStreamParser();
    feed(parser, [
      system,
      assistant("m1", { type: "text", text: "Looking at the file." }),
      assistant("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/src/a.ts", offset: 5 } }),
      toolResult("t1", "SECRET FILE BODY with rate limit 429 too many requests"),
      assistant("m2", { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }),
      toolResult("t2", "boom", true),
    ]);
    const checkpoint = parser.checkpoint!();
    expect(checkpoint).toMatchObject({ provider_session_id: "sess-9", turns: 2, partial_text: "Looking at the file." });
    expect(checkpoint.tool_trail).toEqual([
      { tool: "Read", target: "/repo/src/a.ts", variant: "offset=5", status: "ok" },
      { tool: "Bash", target: "npm test", status: "error" },
    ]);
    expect(JSON.stringify(checkpoint)).not.toContain("SECRET FILE BODY");
  });

  it("never classifies tool_result text of an interrupted run as a provider failure", () => {
    const parser = new ClaudeAdapter().createStreamParser();
    feed(parser, [
      system,
      assistant("m1", { type: "tool_use", id: "t1", name: "Read", input: { file_path: "notes.md" } }),
      toolResult("t1", "HTTP 429 rate limit exceeded, quota exceeded, invalid api key, status 503 overloaded"),
    ]);
    const result = parser.finish(killed);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("NON_ZERO_EXIT");
    expect(JSON.stringify(result.error)).not.toMatch(/rate limit|quota|api key|tool_result/i);
  });

  it("still reports an explicit assistant error and the stderr tail", () => {
    const parser = new ClaudeAdapter().createStreamParser();
    feed(parser, [system, { type: "assistant", error: "rate_limit", message: { id: "m1", content: [{ type: "text", text: "API Error: 429 rate limit" }] } }]);
    expect(parser.finish({ ...killed, exitCode: 1, signal: null }).error?.code).toBe("RATE_LIMITED");
    const plain = new ClaudeAdapter().createStreamParser();
    feed(plain, [system]);
    expect(plain.finish({ ...killed, exitCode: 1, signal: null, stderrTail: "HTTP 429 too many requests" }).error?.code).toBe("RATE_LIMITED");
  });

  it("takes the authoritative result event of a stream", () => {
    const parser = new ClaudeAdapter().createStreamParser();
    feed(parser, [
      system, assistant("m1", { type: "text", text: "draft" }),
      { type: "result", subtype: "success", is_error: false, result: "final answer", session_id: "sess-9", total_cost_usd: 0.5, usage: { input_tokens: 3, output_tokens: 4 } },
    ]);
    expect(parser.finish(clean)).toMatchObject({ ok: true, summary: "final answer", usage: { input_tokens: 3, cost_usd: 0.5 } });
  });

  it("keeps legacy single-object, array and pretty-printed JSON working", () => {
    const result = { type: "result", subtype: "success", is_error: false, result: "legacy" };
    for (const lines of [[JSON.stringify(result)], [JSON.stringify([system, result])], JSON.stringify(result, null, 2).split("\n")]) {
      const parser = new ClaudeAdapter().createStreamParser();
      feed(parser, lines);
      expect(parser.finish(clean)).toMatchObject({ ok: true, summary: "legacy" });
    }
  });

  it("keeps the old raw-text classification for legacy non-stream output", () => {
    const parser = new ClaudeAdapter().createStreamParser();
    feed(parser, ["Error: 429 too many requests"]);
    expect(parser.finish({ ...killed, exitCode: 1, signal: null }).error?.code).toBe("RATE_LIMITED");
  });
});

describe("Claude tool trail as stuck-loop evidence", () => {
  const SECOND = 1_000;
  const NOW = 100 * SECOND;
  const policy: DeadlinePolicy = {
    outputMode: "streaming", softSec: 100, hardSec: 1_000, idleSec: 0, autoExtend: true, strict: false, chunkSec: 600, windowSec: 180,
  };
  const read = (id: string, input: Record<string, unknown>) =>
    ({ type: "assistant", message: { id, content: [{ type: "tool_use", id, name: "Read", input }] } });
  const decide = (parser: AdapterStreamParser) => evaluateDeadline(policy, {
    spawnedAt: 0, softDeadline: NOW, hardDeadline: 1_000 * SECOND, lastOutputAt: NOW - SECOND, lastProgressAt: NOW - SECOND,
    progressCounterAvailable: true, toolTrail: parser.checkpoint!().tool_trail,
  }, { now: NOW }).action;

  it("extends a job that reads one file page by page, and stops one that repeats the same read", () => {
    const paging = new ClaudeAdapter().createStreamParser();
    const repeating = new ClaudeAdapter().createStreamParser();
    for (let index = 0; index < TOOL_LOOP_WINDOW; index++) {
      feed(paging, [read(`p${index}`, { file_path: "/repo/big.ts", offset: index * 500, limit: 500 })]);
      feed(repeating, [read(`r${index}`, { file_path: "/repo/big.ts", offset: 0, limit: 500 })]);
    }
    expect(decide(paging)).toBe("extend");
    expect(decide(repeating)).toBe("kill");
  });

  it("extends again once the assistant wrote new text after the repeated reads", () => {
    const parser = new ClaudeAdapter().createStreamParser();
    for (let index = 0; index < TOOL_LOOP_WINDOW; index++) feed(parser, [read(`r${index}`, { file_path: "/repo/big.ts" })]);
    expect(decide(parser)).toBe("kill");
    feed(parser, [{ type: "assistant", message: { id: "m-text", content: [{ type: "text", text: "Now I understand the file; editing it." }] } }]);
    expect(decide(parser)).toBe("extend");
  });
});

describe("Claude progress events", () => {
  it("counts assistant text and tools but never system, api_retry or session keepalives", () => {
    const parser = new ClaudeAdapter().createStreamParser();
    const lines: Array<[unknown, number]> = [
      [{ type: "system", subtype: "init", session_id: "s" }, 0],
      [{ type: "system", subtype: "api_retry", attempt: 1, error: "overloaded" }, 0],
      [{ type: "system", subtype: "status" }, 0],
      ["not json at all", 0],
      [{ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "hello" }] } }, 2], // turn + text
      [{ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } }, 1],
      [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } }, 1],
      [{ type: "system", subtype: "api_retry", attempt: 2 }, 0],
      [{ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s" }, 0],
    ];
    let expected = 0;
    expect(parser.progressEvents!()).toBe(0);
    for (const [line, delta] of lines) {
      feed(parser, [line]);
      expected += delta;
      expect(parser.progressEvents!(), JSON.stringify(line)).toBe(expected);
    }
  });
});

describe("Claude invocation format", () => {
  const input = (extra_args: string[]) => ({
    harnessId: "claude", modelId: "m", effort: "high", mode: "readonly" as const, prompt: "p", cwd: "/tmp", jobDir: "/tmp",
    inheritMcp: false, isGitRepo: false,
    harness: { driver: "claude", display_name: "c", binary: process.execPath, enabled: true, extra_args },
    model: { harness: "claude", cli_model: "cm", efforts: ["high"], default_effort: "high" },
  }) as never;

  it("asks for stream-json unless extra_args chose a format, keeping the sandbox flags", async () => {
    const adapter = new ClaudeAdapter();
    const streamed = (await adapter.buildInvocation(input([]))).args;
    expect(streamed.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(streamed).toEqual(expect.arrayContaining(["--no-session-persistence", "--restricted", "--strict-mcp-config", "--tools", "Read,Glob,Grep"]));
    const chosen = (await adapter.buildInvocation(input(["--output-format", "json"]))).args;
    expect(chosen.filter((arg) => arg === "--output-format")).toHaveLength(1);
    expect(chosen).not.toContain("stream-json");
  });

  it.each([
    [[], "streaming"],
    [["--output-format", "stream-json"], "streaming"],
    [["--output-format=stream-json"], "streaming"],
    [["--output-format", "json"], "buffered"],
    [["--output-format=text"], "buffered"],
  ] as const)("reports outputMode for extra_args %j as %s", async (extra, mode) => {
    expect((await new ClaudeAdapter().buildInvocation(input([...extra]))).outputMode).toBe(mode);
  });
});

describe("progressEvents of the other stream parsers", () => {
  it.each([
    ["codex", () => new CodexAdapter().createStreamParser(), [
      [{ type: "thread.started", thread_id: "th" }, 0],
      [{ type: "turn.started" }, 0],
      [{ type: "item.started", item: { id: "c1", type: "command_execution", command: "ls" } }, 1],
      [{ type: "item.completed", item: { id: "c1", type: "command_execution", command: "ls", exit_code: 0 } }, 1],
      [{ type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking about it" } }, 1],
      [{ type: "item.completed", item: { id: "w1", type: "web_search", query: "docs" } }, 1],
      [{ type: "item.completed", item: { id: "t1", type: "todo_list", items: [{ text: "a", completed: false }] } }, 1],
      [{ type: "item.completed", item: { id: "u1", type: "unknown_future_item" } }, 0],
      [{ type: "item.completed", item: { id: "m1", type: "agent_message", text: "done" } }, 2],
    ]],
    ["dsh", () => new DshAdapter().createStreamParser(), [
      [{ type: "session", sessionId: "d1" }, 0],
      [{ type: "status", phase: "thinking" }, 0],
      [{ type: "text", text: "" }, 0],
      [{ type: "text", text: "go" }, 1],
      [{ type: "tool_call", id: "k1", name: "grep", input: {} }, 1],
      [{ type: "tool_result", id: "k1" }, 1],
      [{ type: "step_end", usage: { inputTokens: 1, outputTokens: 1 } }, 1],
    ]],
    ["pi", () => new PiAdapter().createStreamParser(), [
      [{ type: "session", sessionId: "p1" }, 0],
      [{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } }, 1],
      [{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "" } }, 0],
      [{ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }, 0],
      [{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }, 1],
      [{ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: " more" } }, 1],
      [{ type: "tool_execution_start", toolCallId: "p1", toolName: "read", args: {} }, 1],
      [{ type: "tool_execution_end", toolCallId: "p1", toolName: "read", isError: false }, 1],
      [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }, 2],
    ]],
    ["opencode", () => new OpenCodeAdapter().createStreamParser(), [
      [{ type: "step_start", sessionID: "oc" }, 0],
      [{ type: "text", sessionID: "oc", part: { messageID: "a", text: "one" } }, 1],
      [{ type: "tool_use", sessionID: "oc", part: { type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: { filePath: "x.ts" } } } }, 2],
      [{ type: "step_finish", sessionID: "oc", part: { tokens: { input: 1, output: 1 } } }, 0],
    ]],
    ["kiro", () => new KiroAdapter().createStreamParser(), [
      [{ type: "system", subtype: "init" }, 0],
      [{ type: "text", delta: "hi" }, 1],
      [{ type: "message", role: "assistant", content: "hi there" }, 1],
    ]],
  ] as unknown as Array<[string, () => AdapterStreamParser, Array<[unknown, number]>]>)(
    "%s counts semantic events only", (_name, create, lines) => {
      const parser = create();
      expect(parser.progressEvents!()).toBe(0);
      let expected = 0;
      for (const [line, delta] of lines) {
        feed(parser, [line]);
        expected += delta;
        expect(parser.progressEvents!(), JSON.stringify(line)).toBe(expected);
      }
    },
  );
});

describe("other adapters' checkpoints", () => {
  it("codex records thread, messages and tool steps without command output", () => {
    const parser = new CodexAdapter().createStreamParser();
    feed(parser, [
      { type: "thread.started", thread_id: "th-1" },
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "npm test" } },
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: "npm test", aggregated_output: "SECRET OUTPUT", exit_code: 1 } },
      { type: "item.completed", item: { id: "f1", type: "file_change", status: "completed", changes: [{ path: "src/a.ts", kind: "update" }] } },
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: "half done" } },
    ]);
    const checkpoint = parser.checkpoint!();
    expect(checkpoint).toMatchObject({ provider_session_id: "th-1", partial_text: "half done", turns: 1 });
    expect(checkpoint.tool_trail).toEqual([
      { tool: "shell", target: "npm test", status: "error" },
      { tool: "file_update", target: "src/a.ts", status: "ok", followedByText: true },
    ]);
    expect(JSON.stringify(checkpoint)).not.toContain("SECRET OUTPUT");
    expect(parser.finish(killed).ok).toBe(false);
  });

  it("pi dedupes streamed deltas against the finalized message and records tools", () => {
    const parser = new PiAdapter().createStreamParser();
    feed(parser, [
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } },
      { type: "tool_execution_start", toolCallId: "p1", toolName: "read", args: { path: "a.ts" } },
      { type: "tool_execution_end", toolCallId: "p1", toolName: "read", isError: false, result: "BODY" },
      { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "hello" }] } },
    ]);
    const checkpoint = parser.checkpoint!();
    expect(checkpoint).toMatchObject({ partial_text: "hello", turns: 1 });
    expect(checkpoint.tool_trail).toEqual([{ tool: "read", target: "a.ts", status: "ok" }]);
    expect(JSON.stringify(checkpoint)).not.toContain("BODY");
  });

  it("dsh records streamed text, steps and tool events", () => {
    const parser = new DshAdapter().createStreamParser();
    feed(parser, [
      { type: "session", sessionId: "d1" },
      { type: "text", text: "working " },
      { type: "tool_call", id: "k1", name: "grep", input: { pattern: "TODO" } },
      { type: "tool_result", id: "k1" },
      { type: "text", text: "on it" },
      { type: "step_end", usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    expect(parser.checkpoint!()).toMatchObject({
      provider_session_id: "d1", partial_text: "working on it", turns: 1,
      tool_trail: [{ tool: "grep", target: "TODO", status: "ok" }],
    });
  });

  it("opencode records session, text per message and tool parts", () => {
    const parser = new OpenCodeAdapter().createStreamParser();
    feed(parser, [
      { type: "text", sessionID: "oc-1", part: { messageID: "a", text: "one" } },
      { type: "tool_use", sessionID: "oc-1", part: { type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: { filePath: "x.ts" }, output: "BODY" } } },
      { type: "text", sessionID: "oc-1", part: { messageID: "b", text: "two" } },
    ]);
    const checkpoint = parser.checkpoint!();
    expect(checkpoint).toMatchObject({ provider_session_id: "oc-1", partial_text: "one\n\ntwo", turns: 1 });
    expect(checkpoint.tool_trail).toEqual([{ tool: "read", target: "x.ts", status: "ok", followedByText: true }]);
    expect(JSON.stringify(checkpoint)).not.toContain("BODY");
  });
});
