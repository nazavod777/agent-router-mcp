const REDACTED = "[REDACTED]";
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const SENSITIVE_FIELD_NAME = /token|password|passwd|secret|api[_-]?key|authorization|cookie|credential/i;
/** `Authorization` and `X-API-Key` header lines, plain or inside JSON (`"x-api-key": "value"`). */
const HEADER_VALUE = /\b((?:Authorization|X-API-Key)(?:\\?["'])?[ \t]*:[ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi;
const BEARER_TOKEN = /\b(Bearer[ \t]+)[^\s,;"'<>]+/gi;
const PREFIXED_TOKEN = new RegExp([
  String.raw`\b(?:sk-|ghp_|xoxb-)[\w-]+`,
  String.raw`\bAIza[A-Za-z0-9_-]{20,}`,
  String.raw`\bxai-[A-Za-z0-9_-]{12,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bgh[ous]_[A-Za-z0-9]{20,}`,
  String.raw`\bglpat-[A-Za-z0-9_-]{16,}`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
].join("|"), "g");

const MAX_USERINFO_LENGTH = 512;
/**
 * `scheme://userinfo@host`, plain or JSON-escaped (`https:\/\/user:pass@host`). The userinfo may hold quotes and escaped
 * characters, but never a slash, so it cannot swallow a path.
 */
const URL_USERINFO = new RegExp(
  String.raw`\b([a-z][a-z0-9+.-]*:(?:\\?\/){2})(?:[^\s/\\@]|\\(?!\/)[^\s]){1,${MAX_USERINFO_LENGTH}}@`,
  "gi",
);
/** A whole URL up to whitespace, a quote, or a bracket; JSON-escaped slashes (`\/`) and `\uXXXX` stay inside it. */
const URL_WITH_QUERY = /\b[a-z][a-z0-9+.-]*:(?:\\?\/){2}(?:\\\/|\\u[0-9a-f]{4}|[^\s"'<>\\])*[?#](?:\\\/|\\u[0-9a-f]{4}|[^\s"'<>\\])*/gi;

/** Query values and the whole fragment of a URL are credentials until proven otherwise (`?token=…`, `#access_token=…`). */
function redactUrlTail(url: string): string {
  const queryStart = url.search(/[?#]/);
  if (queryStart < 0) return url;
  const head = url.slice(0, queryStart);
  const tail = url.slice(queryStart);
  const fragmentStart = tail.indexOf("#");
  const query = fragmentStart < 0 ? tail : tail.slice(0, fragmentStart);
  const redactedQuery = query.length <= 1 ? query : `?${query.slice(1).split(/&|\\u0026/).map((pair) => {
    const equals = pair.indexOf("=");
    return equals < 0 ? REDACTED : `${pair.slice(0, equals + 1)}${REDACTED}`;
  }).join("&")}`;
  const fragment = fragmentStart < 0 || tail.length - fragmentStart <= 1 ? "" : `#${REDACTED}`;
  return `${head}${redactedQuery}${fragment}`;
}

/** The value as it appears inside a JSON string literal, so a secret with quotes or backslashes is still found there. */
function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

const MIN_REGISTERED_SECRET_LENGTH = 8;
const MAX_REGISTERED_SECRETS = 256;
/** Insertion-ordered, so the oldest value is evicted first once the cap is reached. */
const registeredSecrets = new Set<string>();

/**
 * Remembers secret values (for example credentials an adapter read from a user config file) so every later redaction in
 * this process masks them. Bounded: values shorter than 8 characters are ignored and the oldest entry is evicted past 256.
 */
export function registerSecretValues(values: readonly string[]): void {
  for (const value of values) {
    if (value.length < MIN_REGISTERED_SECRET_LENGTH) continue;
    // Re-registering moves a value to the newest position.
    registeredSecrets.delete(value);
    registeredSecrets.add(value);
    while (registeredSecrets.size > MAX_REGISTERED_SECRETS) {
      registeredSecrets.delete(registeredSecrets.values().next().value as string);
    }
  }
}

/** Test seam: forgets every registered secret value. */
export function clearRegisteredSecretValues(): void {
  registeredSecrets.clear();
}

export function createSecretRedactor(extraSecrets: string[] = []): (text: string) => string {
  const envSecrets = Object.entries(process.env).flatMap(([name, value]) =>
    SECRET_ENV_NAME.test(name) && value && value.length >= 8 ? [value] : [],
  );
  const known = [...new Set([...extraSecrets, ...registeredSecrets, ...envSecrets])].filter(Boolean);
  const secrets = [...new Set(known.flatMap((secret) => [secret, jsonEscaped(secret)]))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  const literals = secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = literals.length ? new RegExp(literals.join("|"), "g") : undefined;
  return (text) => (pattern ? text.replace(pattern, REDACTED) : text)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_WITH_QUERY, redactUrlTail)
    .replace(PREFIXED_TOKEN, REDACTED)
    .replace(HEADER_VALUE, `$1${REDACTED}`)
    .replace(BEARER_TOKEN, `$1${REDACTED}`);
}

export function redactSecrets(text: string, extraSecrets: string[] = []): string {
  return createSecretRedactor(extraSecrets)(text);
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/** A metadata field named like a credential is replaced whole, whatever its value looks like (numbers and booleans stay: they are counts). */
function isSensitiveField(key: string, value: unknown): boolean {
  return SENSITIVE_FIELD_NAME.test(key) && value != null && typeof value !== "number" && typeof value !== "boolean";
}

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  const entry = { time: new Date().toISOString(), level, message, fields };
  const redact = createSecretRedactor();
  const line = JSON.stringify(entry, (key, value: unknown) => {
    if (isSensitiveField(key, value)) return REDACTED;
    if (typeof value === "string") return redact(value);
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (typeof value === "bigint") return value.toString();
    return value;
  });
  process.stderr.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log("error", message, fields),
};
