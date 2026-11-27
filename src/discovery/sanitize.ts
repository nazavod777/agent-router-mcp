/**
 * Text sanitizing shared by the discovery modules (NEW). Probe output and local files are untrusted: anything that ends up in
 * a preview, a diagnostic, or a written `models.toml` first loses URL credentials, URL paths and query strings, hidden
 * (bidi-control and zero-width) characters, and known secret shapes.
 */
import { createSecretRedactor } from "../logging.js";
import type { DiscoveredModel } from "./types.js";

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
/** `?api_key=...`, `&token=...` style secrets in text that is not a full URL. */
const QUERY_SECRET = /([?&](?:api[_-]?key|key|token|access[_-]?token|auth|secret|password|passwd|sig|signature)=)[^&\s"'<>]*/gi;
const REDACTED_QUERY_VALUE = "[REDACTED]";
const UNPARSEABLE_URL = "<url>";
/** Zero-width characters, bidi marks and overrides, bidi isolates, the word joiner, and the byte order mark. */
const HIDDEN_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** Removes characters that are invisible or reorder the text around them, so they cannot disguise what a name says. */
export function stripHiddenCharacters(text: string): string {
  return text.replace(HIDDEN_CHARACTERS, "");
}

/**
 * `https://user:pass@host:8443/path?x=1#y` becomes `https://host:8443`: the path, query, fragment, and userinfo can all carry
 * credentials (`/v2/<api key>`), so only the origin stays. An unparseable or host-less URL is replaced altogether.
 */
function scrubUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return url.host === "" ? UNPARSEABLE_URL : `${url.protocol}//${url.host}`;
  } catch {
    return UNPARSEABLE_URL;
  }
}

/** Returns a function that scrubs one string; the secret redactor is built once, not per string. */
export function createDiscoveryScrubber(): (text: string) => string {
  const redact = createSecretRedactor();
  // Hidden characters go first: a zero-width character inside `https://` must not hide a URL from the rules below.
  return (text) => redact(stripHiddenCharacters(text).replace(URL_IN_TEXT, scrubUrl).replace(QUERY_SECRET, `$1${REDACTED_QUERY_VALUE}`));
}

export function scrubDiscoveryText(text: string): string {
  return createDiscoveryScrubber()(text);
}

/**
 * Every free-text field of a discovered model, scrubbed of URL credentials, paths, query strings, hidden characters, and secret
 * shapes. A model whose id or provider itself changes while scrubbing contains a secret shape or a hidden character and is
 * dropped (`undefined`): a redaction marker or a silently altered id is not a usable route.
 */
export function scrubDiscoveredModel(model: DiscoveredModel, scrub: (text: string) => string): DiscoveredModel | undefined {
  const cliModel = scrub(model.cli_model);
  const cliProvider = model.cli_provider === undefined ? undefined : scrub(model.cli_provider);
  if (cliModel !== model.cli_model || cliProvider !== model.cli_provider) return undefined;
  return { ...model, ...(model.display_name !== undefined ? { display_name: scrub(model.display_name) } : {}) };
}
