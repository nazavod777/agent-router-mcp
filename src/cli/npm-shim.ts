import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve, win32 } from "node:path";

/** npm's launcher shims are a few hundred bytes; anything bigger is a real program, not a shim. */
const MAX_SHIM_BYTES = 16 * 1024;
const SCRIPT_SHIM_EXTENSIONS = new Set([".cmd", ".bat", ".ps1"]);
const POSIX_SHEBANG = /^#!\s*\/(?:usr\/)?bin\/(?:env\s+)?(?:ba|da|z)?sh\b/;
/** Every quoted string ending in a JavaScript file name. */
const QUOTED_SCRIPT = /["']([^"'\r\n]*?\.(?:c|m)?js)["']/gi;
/** The directory variable npm's shims put in front of the script: `%dp0%`, `%~dp0`, `$basedir`, `${basedir}`, `$PSScriptRoot`. */
const SHIM_DIR_VARIABLE = /^(?:%~?dp0%?|\$\{?basedir\}?|\$PSScriptRoot)/i;

const forwardSlashes = (path: string): string => path.replace(/\\/g, "/");

/** `realpath` of an existing file, or undefined when it is missing or cannot be resolved. */
export function realIfExists(path: string): string | undefined {
  try { return realpathSync(path); } catch { return undefined; }
}

function isSmallFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size <= MAX_SHIM_BYTES;
  } catch {
    return false;
  }
}

/** The script path a shim line points at, resolved against the shim's directory; foreign drive paths stay as written. */
function shimScriptPath(candidate: string, shimDirectory: string): string | undefined {
  const variable = SHIM_DIR_VARIABLE.exec(candidate)?.[0];
  const path = forwardSlashes(variable === undefined ? candidate : candidate.slice(variable.length));
  if (variable !== undefined) return resolve(shimDirectory, `.${path.startsWith("/") ? "" : "/"}${path}`);
  if (isAbsolute(path)) return resolve(path);
  return win32.isAbsolute(candidate) ? path : undefined;
}

/**
 * The JavaScript entry point an npm launcher shim runs, or undefined when `file` is not such a shim. Handles the three
 * shapes `npm install -g`/`npm link` write: `name.cmd` (`%dp0%\…`), `name.ps1` (`$basedir/…`) and the extensionless
 * `#!/bin/sh` script (`$basedir/…`). A relative target is resolved against the shim's own directory; the target need not exist.
 */
export function readNpmShimTarget(file: string): string | undefined {
  const extension = extname(file).toLowerCase();
  if (extension !== "" && !SCRIPT_SHIM_EXTENSIONS.has(extension)) return undefined;
  if (!isSmallFile(file)) return undefined;
  let content: string;
  try { content = readFileSync(file, "utf8"); } catch { return undefined; }
  if (extension === "" && !POSIX_SHEBANG.test(content)) return undefined;
  for (const [, candidate] of content.matchAll(QUOTED_SCRIPT)) {
    const target = shimScriptPath(candidate, dirname(file));
    if (target !== undefined) return target;
  }
  return undefined;
}

/**
 * What a launcher file ultimately runs: symlinks are followed first, then an npm shim is replaced by its script (also
 * followed through symlinks when it exists). A non-shim file resolves to itself; a missing file to undefined.
 */
export function resolveLauncherEntry(path: string): string | undefined {
  const real = realIfExists(path);
  if (real === undefined) return undefined;
  const target = readNpmShimTarget(real);
  return target === undefined ? real : realIfExists(target) ?? target;
}
