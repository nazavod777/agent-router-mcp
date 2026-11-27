import { createSecretRedactor, redactSecrets } from "../logging.js";
import type { JobProgressSummary, ProgressCheckpoint, ProgressToolStep } from "../types.js";
import { truncateUtf8 } from "./output.js";

/** Most recent assistant text kept for a checkpoint (UTF-8 bytes). */
export const MAX_PARTIAL_TEXT_BYTES = 8 * 1024;
/** Most recent tool steps kept for a checkpoint. */
export const MAX_TOOL_STEPS = 40;
/** One tool target (a path, a pattern or a short command) is clipped to this many UTF-8 bytes. */
export const MAX_TARGET_BYTES = 180;
/** Bounded diff excerpt stored in a checkpoint (UTF-8 bytes). */
export const MAX_DIFF_EXCERPT_BYTES = 4 * 1024;
const MAX_TOOL_NAME_BYTES = 64;
const MAX_VARIANT_BYTES = 80;
const MAX_SESSION_ID_BYTES = 200;
const MAX_CHANGED_FILES = 100;
const MAX_CHANGED_FILE_BYTES = 300;
/** A clipped head may start in the middle of a token (possibly a secret); drop that partial token when it is short. */
const PARTIAL_TOKEN_SCAN_BYTES = 200;
/**
 * Raw assistant text is buffered up to this size so redaction runs over a wider window than the final clip: a secret
 * that straddles the 8 KB boundary is redacted whole, and a fragment left at the front of the buffer is clipped away.
 */
const RAW_TEXT_BUFFER_BYTES = MAX_PARTIAL_TEXT_BYTES * 2;
const MAX_CORRELATIONS = MAX_TOOL_STEPS * 2;
const TURN_SEPARATOR = "\n\n";
/** Any spelling of the wrapper tag (case, spaces or line breaks after `<` and `/`) is neutralized, not only the exact one. */
const PRIOR_CONTEXT_TAG = /<[\s\u200b-\u200d\ufeff]*(\/?)[\s\u200b-\u200d\ufeff]*prior_job_context/gi;

export const RESUME_DIRECTIVE =
  "Resume from this saved progress. Inspect the current workspace files first, do not redo already completed steps, " +
  "and finish the remaining work.";

const HANDOFF_HEADER = "Progress before stop:";
const HANDOFF_TOOLS_BYTES = 1_600;
const HANDOFF_FILES_BYTES = 1_000;
const HANDOFF_DIFF_BYTES = 2_400;
const TRUNCATION_MARKER = "[... truncated ...]";

/** Keeps the last `maxBytes` of text on a character boundary and drops the partial token the cut may have left. */
function clipTail(text: string, maxBytes: number): { text: string; clipped: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, clipped: false };
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let clipped = bytes.subarray(start).toString("utf8");
  const boundary = /\s/.exec(clipped.slice(0, PARTIAL_TOKEN_SCAN_BYTES));
  if (boundary) clipped = clipped.slice(boundary.index + 1);
  return { text: clipped, clipped: true };
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Clips a short single-line target; secrets must already be redacted, because a cut can split one. */
function clipTarget(target: string | undefined, maxBytes = MAX_TARGET_BYTES): string | undefined {
  if (target === undefined) return undefined;
  const clipped = truncateUtf8(singleLine(target), maxBytes).text.trimEnd();
  return clipped || undefined;
}

/**
 * Collects a bounded record of what a CLI did while it ran: the latest assistant text, a short tool trail and a turn
 * counter. It never stores raw file contents or tool result bodies; callers pass only short, safe targets. Secrets are
 * redacted before any text is clipped, so a cut can never leave part of a secret behind.
 */
export class ProgressTracker {
  private readonly redact: (text: string) => string;
  private committed = "";
  private current = "";
  private truncated = false;
  private turns = 0;
  private progressEvents = 0;
  private sessionId?: string;
  private readonly steps: ProgressToolStep[] = [];
  private readonly byCorrelation = new Map<string, ProgressToolStep>();

  constructor(extraSecrets: string[] = []) {
    this.redact = createSecretRedactor(extraSecrets);
  }

  /**
   * Monotonic count of real semantic progress events: non-empty assistant text, turn ends, tool starts and tool ends, plus `noteActivity()`.
   * Session ids and CLI keepalives (`system`, `api_retry`) never count, so a stalled stream cannot look alive.
   */
  events(): number {
    return this.progressEvents;
  }

  /**
   * Counts model work that leaves no checkpoint content (reasoning, a web search, a plan update) as progress, so a
   * long thinking phase is not mistaken for a stalled stream.
   */
  noteActivity(): void {
    this.progressEvents += 1;
  }

  /** Adds streamed assistant text to the current turn. */
  appendText(text: string): void {
    if (!text) return;
    this.progressEvents += 1;
    this.markLatestStepFollowedByText();
    this.current = this.clip(this.current + text);
  }

  /** Replaces the current turn's text with its finalized form, so earlier deltas are not counted twice. */
  setText(text: string): void {
    if (text) this.progressEvents += 1;
    if (text && text !== this.current) this.markLatestStepFollowedByText();
    this.current = this.clip(text);
  }

  /** Marks the end of an assistant turn; later text starts a new turn. */
  noteTurn(): void {
    this.turns += 1;
    this.progressEvents += 1;
    if (!this.current) return;
    this.committed = this.clip(this.committed ? `${this.committed}${TURN_SEPARATOR}${this.current}` : this.current);
    this.current = "";
  }

  /** `variant` is the short numeric-argument signature of the call (see `safeToolVariant`); it never leaves memory. */
  recordToolStart(tool: string, target?: string, correlationId?: string, variant?: string): void {
    this.progressEvents += 1;
    const step: ProgressToolStep = { tool: clipTarget(this.redact(tool), MAX_TOOL_NAME_BYTES) ?? "tool", status: "started" };
    const clippedTarget = clipTarget(target === undefined ? undefined : this.redact(target));
    if (clippedTarget) step.target = clippedTarget;
    const clippedVariant = clipTarget(variant === undefined ? undefined : this.redact(variant), MAX_VARIANT_BYTES);
    if (clippedVariant) step.variant = clippedVariant;
    this.steps.push(step);
    if (correlationId) {
      this.byCorrelation.set(correlationId, step);
      if (this.byCorrelation.size > MAX_CORRELATIONS) this.byCorrelation.delete(this.byCorrelation.keys().next().value!);
    }
    if (this.steps.length > MAX_TOOL_STEPS) {
      const evicted = this.steps.shift()!;
      for (const [id, candidate] of this.byCorrelation) if (candidate === evicted) this.byCorrelation.delete(id);
    }
  }

  /** Fresh assistant text after the latest tool call means the model kept working on it, which a stuck loop never does. */
  private markLatestStepFollowedByText(): void {
    const latest = this.steps.at(-1);
    if (latest) latest.followedByText = true;
  }

  /** True while a step started with this correlation id has not been finished. */
  isOpen(correlationId: string): boolean {
    return this.byCorrelation.has(correlationId);
  }

  /** Finishes a step by correlation id, or else the latest unfinished step of that tool name. */
  recordToolEnd(correlationIdOrTool: string, ok?: boolean): void {
    this.progressEvents += 1;
    let step = this.byCorrelation.get(correlationIdOrTool);
    if (step) {
      this.byCorrelation.delete(correlationIdOrTool);
    } else {
      for (let index = this.steps.length - 1; index >= 0; index--) {
        if (this.steps[index].tool === correlationIdOrTool && this.steps[index].status === "started") {
          step = this.steps[index];
          break;
        }
      }
    }
    if (step) step.status = ok === true ? "ok" : ok === false ? "error" : "unknown";
  }

  /** Stores the provider's opaque session id (redacted before it is clipped); it stays inside checkpoint.json. */
  setSessionId(id: string | undefined): void {
    const clipped = id ? truncateUtf8(this.redact(id.trim()), MAX_SESSION_ID_BYTES).text : "";
    if (clipped) this.sessionId = clipped;
  }

  snapshot(): ProgressCheckpoint {
    const combined = this.committed && this.current
      ? `${this.committed}${TURN_SEPARATOR}${this.current}` : this.committed || this.current;
    const clipped = clipTail(this.redact(combined), MAX_PARTIAL_TEXT_BYTES);
    const partialText = clipped.text.trim() ? clipped.text : undefined;
    return {
      ...(partialText ? { partial_text: partialText } : {}),
      ...(partialText && (this.truncated || clipped.clipped) ? { partial_text_truncated: true } : {}),
      tool_trail: this.steps.map((step) => ({ ...step })),
      turns: this.turns,
      ...(this.sessionId ? { provider_session_id: this.sessionId } : {}),
    };
  }

  /** Bounds the raw buffer; redaction happens in `snapshot` over this wider window, before the final clip. */
  private clip(text: string): string {
    const clipped = clipTail(text, RAW_TEXT_BUFFER_BYTES);
    if (clipped.clipped) this.truncated = true;
    return clipped.text;
  }
}

/** A path token starts here: not right after a path character, so `/x/repo/a` is never read as `/repo/a`. */
const PATH_TOKEN_START = "(?<![\\w.~/\\\\-])";
const PATH_SEPARATOR_PATTERN = "[\\\\/]";
const WINDOWS_ROOT = /^(?:[A-Za-z]:|[\\/]{2})/;

/**
 * Rewrites absolute paths below `cwd` as relative ones; text outside `cwd` is left untouched. Both `/` and `\`
 * separators are recognized (Windows drive and UNC roots match case-insensitively); only whole path tokens are shortened.
 */
function relativize(text: string, cwd: string | undefined): string {
  const root = cwd?.replace(/[\\/]+$/, "");
  if (!root || /^[A-Za-z]:$/.test(root)) return text; // A filesystem root would strip every leading separator.
  const body = [...root].map((char) => /[\\/]/.test(char) ? PATH_SEPARATOR_PATTERN : char.replace(/[.*+?^${}()|[\]]/g, "\\$&")).join("");
  const flags = WINDOWS_ROOT.test(root) ? "gi" : "g";
  return text.replace(new RegExp(`${PATH_TOKEN_START}${body}${PATH_SEPARATOR_PATTERN}`, flags), "");
}

/** Turns every `<prior_job_context` / `</prior_job_context` into an entity so untrusted text cannot open or close the handoff wrapper. */
export function neutralizeTags(text: string): string {
  return text.replace(PRIOR_CONTEXT_TAG, "&lt;$1prior_job_context");
}

export function summarizeCheckpoint(checkpoint: ProgressCheckpoint, checkpointSaved: boolean): JobProgressSummary {
  const partialTextBytes = checkpoint.partial_text ? Buffer.byteLength(checkpoint.partial_text) : 0;
  const toolCalls = checkpoint.tool_trail.length;
  const filesTouched = checkpoint.changed_files?.length ?? 0;
  return {
    has_partial_progress: partialTextBytes > 0 || toolCalls > 0 || filesTouched > 0,
    partial_text_bytes: partialTextBytes,
    tool_calls: toolCalls,
    turns: checkpoint.turns,
    files_touched: filesTouched,
    checkpoint_saved: checkpointSaved,
  };
}

/**
 * Makes a checkpoint safe to persist and to hand to another model. Every string is redacted BEFORE it is clipped, so a
 * cut can never leave a recognizable secret prefix; paths become relative to `cwd`; wrapper tags are neutralized.
 */
export function sanitizeCheckpoint(
  checkpoint: ProgressCheckpoint, extraSecrets: string[], cwd?: string,
): { checkpoint: ProgressCheckpoint; progress: JobProgressSummary } {
  const redact = (text: string) => neutralizeTags(redactSecrets(text, extraSecrets));
  const clean = (text: string) => relativize(redact(text), cwd);
  const trail = checkpoint.tool_trail.slice(-MAX_TOOL_STEPS).map((step): ProgressToolStep => {
    const target = step.target === undefined ? undefined : clipTarget(clean(step.target));
    return {
      tool: clipTarget(redact(step.tool), MAX_TOOL_NAME_BYTES) ?? "tool",
      ...(target ? { target } : {}),
      status: step.status,
    };
  });
  const files = [...new Set((checkpoint.changed_files ?? []).map((file) => clipTarget(clean(file), MAX_CHANGED_FILE_BYTES) ?? ""))]
    .filter(Boolean).slice(0, MAX_CHANGED_FILES);
  const text = checkpoint.partial_text === undefined ? undefined : clipTail(redact(checkpoint.partial_text), MAX_PARTIAL_TEXT_BYTES);
  const diff = checkpoint.diff_excerpt === undefined ? undefined : truncateUtf8(redact(checkpoint.diff_excerpt), MAX_DIFF_EXCERPT_BYTES);
  const sanitized: ProgressCheckpoint = {
    ...(text?.text.trim() ? { partial_text: text.text } : {}),
    ...(text?.text.trim() && (checkpoint.partial_text_truncated || text.clipped) ? { partial_text_truncated: true } : {}),
    tool_trail: trail,
    turns: Math.max(0, Math.floor(checkpoint.turns) || 0),
    ...(files.length > 0 ? { changed_files: files } : {}),
    ...(diff?.text.trim() ? { diff_excerpt: diff.text } : {}),
    ...(checkpoint.pre_existing_dirty === undefined ? {} : { pre_existing_dirty: checkpoint.pre_existing_dirty }),
    ...(checkpoint.provider_session_id ? { provider_session_id: truncateUtf8(redact(checkpoint.provider_session_id), MAX_SESSION_ID_BYTES).text } : {}),
  };
  return { checkpoint: sanitized, progress: summarizeCheckpoint(sanitized, false) };
}

function describeStep(step: ProgressToolStep): string {
  const status = step.status === "ok" ? "" : ` [${step.status}]`;
  return `${step.tool}${step.target ? ` ${step.target}` : ""}${status}`;
}

/** Fits `lines` into `budget` bytes, dropping whole lines from the front (oldest first). */
function fitLinesFromEnd(lines: readonly string[], budget: number): string {
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const size = Buffer.byteLength(lines[index]) + 1;
    if (used + size > budget) break;
    kept.unshift(lines[index]);
    used += size;
  }
  if (kept.length < lines.length) kept.unshift(`(${lines.length - kept.length} earlier step(s) omitted)`);
  return kept.join("\n");
}

/**
 * Renders the "Progress before stop" section of a continuation handoff. The section never exceeds `maxBytes`; the resume
 * directive is always kept and the partial assistant output (most recent text) takes whatever budget remains.
 */
export function formatCheckpointForHandoff(checkpoint: ProgressCheckpoint, maxBytes: number): string {
  const sections: string[] = [HANDOFF_HEADER];
  const fixed = Buffer.byteLength(HANDOFF_HEADER) + Buffer.byteLength(RESUME_DIRECTIVE) + 4;
  let remaining = Math.max(0, maxBytes - fixed);
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER) + 1;
  const add = (text: string, cap: number): void => {
    const room = Math.min(cap, remaining - 1);
    const safe = neutralizeTags(text);
    if (room <= 0 || !safe) return;
    let body = safe;
    if (Buffer.byteLength(safe) > room) {
      if (room <= markerBytes + 16) return;
      body = `${truncateUtf8(safe, room - markerBytes).text.trimEnd()}\n${TRUNCATION_MARKER}`;
    }
    sections.push(body);
    remaining -= Buffer.byteLength(body) + 1;
  };

  if (checkpoint.tool_trail.length > 0) {
    const steps = checkpoint.tool_trail.map((step, index) => `${index + 1}. ${describeStep(step)}`);
    add(`Tools/steps executed (${checkpoint.tool_trail.length}, oldest first):\n${fitLinesFromEnd(steps, HANDOFF_TOOLS_BYTES)}`, HANDOFF_TOOLS_BYTES + 128);
  }
  const files = checkpoint.changed_files ?? [];
  if (files.length > 0) {
    const dirty = checkpoint.pre_existing_dirty ? " (some files were already modified before this job started)" : "";
    add(`Workspace changes so far${dirty}: ${files.join(", ")}`, HANDOFF_FILES_BYTES);
  }
  if (checkpoint.diff_excerpt) add(`Diff excerpt:\n${checkpoint.diff_excerpt}`, HANDOFF_DIFF_BYTES);
  if (checkpoint.partial_text) {
    const room = Math.max(0, remaining - 64);
    const tail = clipTail(checkpoint.partial_text, room);
    if (room > 0 && tail.text.trim()) {
      const note = tail.clipped || checkpoint.partial_text_truncated ? " (tail only)" : "";
      add(`Partial assistant output before stop${note}:\n${tail.text}`, remaining);
    }
  }
  sections.push(RESUME_DIRECTIVE);
  return sections.join("\n");
}
