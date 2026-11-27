/**
 * The single creation policy for harness, model, preset, and alias IDs. Writer, CLI, settings server, and UI share it.
 * It applies to NEW IDs only: an ID that already exists in the catalog or the user file stays editable and deletable.
 */

export const ENTITY_ID_MAX_LENGTH = 128;
const ENTITY_ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,${ENTITY_ID_MAX_LENGTH - 1}}$`);
const FORBIDDEN_ENTITY_IDS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export const ENTITY_ID_RULES =
  "Id must start with a letter or digit and contain only letters, digits, '.', '_', ':', '@', '-', or '/' " +
  `(max ${ENTITY_ID_MAX_LENGTH} characters; no '..', '//', or trailing '/')`;

/** Returns why `id` cannot be used for a new entity, or `undefined` when it is acceptable. */
export function entityIdProblem(id: string): string | undefined {
  if (FORBIDDEN_ENTITY_IDS.has(id)) return `Id ${JSON.stringify(id)} is reserved`;
  if (!ENTITY_ID_PATTERN.test(id) || id.endsWith("/") || id.includes("//") || id.includes("..")) return ENTITY_ID_RULES;
  return undefined;
}

export function isValidEntityId(id: string): boolean {
  return entityIdProblem(id) === undefined;
}

export function assertValidEntityId(id: string): void {
  const problem = entityIdProblem(id);
  if (problem) throw new Error(problem);
}
