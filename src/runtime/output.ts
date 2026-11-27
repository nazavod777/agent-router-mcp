const REDACTION_LOOKAHEAD_BYTES = 64 * 1024;

/**
 * Bytes to keep beyond a size cap so a secret straddling the cap is still whole when it is redacted: the larger of a
 * fixed window and the longest known secret.
 */
export function redactionLookahead(extraSecrets: readonly string[]): number {
  return extraSecrets.reduce((length, secret) => Math.max(length, Buffer.byteLength(secret)), REDACTION_LOOKAHEAD_BYTES);
}

export function utf8PrefixLength(bytes: Buffer, maxBytes: number): number {
  if (Number.isNaN(maxBytes)) return 0;
  let end = Math.min(bytes.length, Math.max(0, Math.floor(maxBytes)));
  if (end === bytes.length) return end;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; totalBytes: number } {
  const bytes = Buffer.from(text);
  const end = utf8PrefixLength(bytes, maxBytes);
  return {
    text: end === bytes.length ? text : bytes.subarray(0, end).toString("utf8"),
    truncated: end < bytes.length,
    totalBytes: bytes.length,
  };
}

export function formatMcpSummary(summary: string, opts: {
  maxBytes: number;
  logPath: string;
}): { summary: string; truncated: boolean; totalBytes: number } {
  const initial = truncateUtf8(summary, opts.maxBytes);
  if (!initial.truncated) return { summary, truncated: false, totalBytes: initial.totalBytes };

  let notice = `\n\n[Output truncated. See orch_logs or ${opts.logPath}.]`;
  if (Buffer.byteLength(notice) > opts.maxBytes) notice = "\n[Truncated. See orch_logs.]";
  notice = truncateUtf8(notice, opts.maxBytes).text;
  return {
    summary: truncateUtf8(summary, opts.maxBytes - Buffer.byteLength(notice)).text + notice,
    truncated: true,
    totalBytes: initial.totalBytes,
  };
}
