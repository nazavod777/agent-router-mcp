import { randomUUID } from "node:crypto";
import {
  closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { stringify } from "smol-toml";
import { assertValidEntityId } from "./ids.js";
import { HARNESS_UNSETTABLE_FIELDS, MODEL_UNSETTABLE_FIELDS } from "./schema.js";
import {
  ConfigManager,
  computeConfigRevision,
  computeEntityHash,
  parseDefaultCatalog,
  parseUserOverrides,
  quarantineFailure,
  readOptionalConfig,
  resolveConfig,
  resolveModelAlias,
} from "./resolver.js";
import type { ConfigSnapshot } from "./resolver.js";
import type { Catalog, ConfigOverrides, DefaultsPatch, HarnessPatch, ModelPatch, PresetPatch } from "./schema.js";

type Table = Record<string, unknown>;
type EntitySection = "harnesses" | "models" | "presets";
export type ConfigSection = "defaults" | "aliases" | EntitySection;
/** Returning "unchanged" means the file must not be rewritten at all (not even re-formatted). */
type Mutation = (overrides: ConfigOverrides, base: Catalog) => void | "unchanged";

/** A batch for one atomic model import: new custom models plus existing models to switch on. */
export interface ImportModelBatch {
  /** New models, keyed by ID; each is stored as a custom model. An ID that already exists is skipped, never overwritten. */
  create?: Record<string, ModelPatch>;
  /** IDs of existing models to enable. */
  enable?: readonly string[];
}

export interface ImportModelsResult {
  snapshot: ConfigSnapshot;
  /** IDs created by this call. */
  imported: string[];
  /** IDs of existing models that were disabled and are enabled now. */
  enabled: string[];
  /** Requested creations skipped because the ID already exists. */
  skipped: string[];
}

const PRIVATE_FILE_MODE = 0o600;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_AGE_MS = 30_000;
/** Directory fsync is not supported everywhere (some filesystems and Windows); those errors only mean "nothing to flush". */
const UNSUPPORTED_DIRECTORY_SYNC_CODES: ReadonlySet<string> = new Set(["EINVAL", "EBADF", "EPERM", "ENOTSUP", "EISDIR", "EACCES"]);
const MAX_SYMLINK_HOPS = 40;

export class ConfigRevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";

  constructor(readonly expectedRevision: string, readonly currentRevision: string) {
    super("Config revision conflict. Reload the config and retry the change.");
    this.name = "ConfigRevisionConflictError";
  }
}

function ownValue<T>(table: Record<string, T> | undefined, key: string): T | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function defined(table: Table): Table {
  return Object.fromEntries(Object.entries(table).filter(([, value]) => value !== undefined));
}

function writeSynced(fd: number, content: string | Buffer): void {
  writeFileSync(fd, content);
  fsyncSync(fd);
}

/** Flushes a directory entry (a new or renamed file) to disk; filesystems that cannot fsync a directory are tolerated. */
function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomically(path: string, content: string, beforeRename: () => void): void {
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const fd = openSync(tempPath, "wx", PRIVATE_FILE_MODE);
  try {
    try {
      writeSynced(fd, content);
    } finally {
      closeSync(fd);
    }
    beforeRename();
    renameSync(tempPath, path);
    syncDirectory(dirname(path));
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function backupConfig(path: string, content: Buffer): void {
  for (let timestamp = Date.now(); ; timestamp++) {
    const backupPath = `${path}.bak.${timestamp}`;
    let fd: number;
    try {
      fd = openSync(backupPath, "wx", PRIVATE_FILE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      try {
        writeSynced(fd, content);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      rmSync(backupPath, { force: true });
      throw error;
    }
    syncDirectory(dirname(path));
    return;
  }
}

// ---------------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------------

/** What a lock file says about its owner. `pid` and `token` are absent when the content is unreadable or from an older build. */
interface LockInfo {
  pid?: number;
  token?: string;
  mtimeMs: number;
  inode: number;
}

/** A held lock: the open descriptor, and the token that proves the file on disk is still ours. */
interface HeldLock {
  fd: number;
  token: string;
  path: string;
}

function inspectLock(lockPath: string): LockInfo | undefined {
  let stats;
  try {
    stats = statSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Unreadable for another reason: report it as brand new, so it is never judged stale.
    return { mtimeMs: Date.now(), inode: 0 };
  }
  const info: LockInfo = { mtimeMs: stats.mtimeMs, inode: stats.ino };
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown; token?: unknown };
    if (typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) info.pid = parsed.pid;
    if (typeof parsed.token === "string") info.token = parsed.token;
  } catch {
    // Empty (still being written), partially written, or foreign content: only its age can decide.
  }
  return info;
}

/** `kill(pid, 0)` only probes: success and EPERM (alive, not ours) mean alive; only ESRCH means gone. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * A lock is stale when its owner process is gone. A live owner is never robbed, however old the lock is: a slow holder
 * would otherwise lose it in the middle of a write. Only a lock with no readable owner falls back to its age.
 */
function isStaleLock(info: LockInfo): boolean {
  if (info.pid !== undefined) return !isProcessAlive(info.pid);
  return Date.now() - info.mtimeMs > STALE_LOCK_AGE_MS;
}

/**
 * Removes `path` only if it is still the file with `inode`: the file is renamed to a unique tombstone, and the tombstone
 * is checked before it is deleted. A different file grabbed by mistake is put back without overwriting a newer one.
 */
function removeFileIfSame(path: string, inode: number): void {
  const tombstone = `${path}.${randomUUID()}.stale`;
  try {
    renameSync(path, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // Someone else already removed it.
    throw error;
  }
  try {
    if (statSync(tombstone).ino === inode) return;
    try {
      linkSync(tombstone, path);
    } catch (error) {
      // EEXIST: a newer file already took its place, so the grabbed one is obsolete. Anything else is a real failure.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    rmSync(tombstone, { force: true });
  }
}

/** Creates `path` exclusively and writes the owner record; undefined when the file already exists. */
function createLockFile(path: string): HeldLock | undefined {
  let fd: number;
  try {
    fd = openSync(path, "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
  const token = randomUUID();
  const inode = fstatSync(fd).ino;
  try {
    writeSynced(fd, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
  } catch (writeError) {
    closeSync(fd);
    removeFileIfSame(path, inode);
    throw writeError;
  }
  return { fd, token, path };
}

/**
 * Removes a lock whose owner is gone. Reclaiming is serialized by a short-lived guard file, and the staleness is checked
 * again while holding it, so two contenders can never remove each other's fresh lock and the lock path is never left
 * open for a third process in between.
 */
export function breakStaleLock(lockPath: string): void {
  const guard = createLockFile(`${lockPath}.reclaim`);
  if (guard === undefined) {
    const holder = inspectLock(`${lockPath}.reclaim`);
    // A guard whose owner died (or that nobody wrote to for a long time) must not block reclaiming forever.
    if (holder !== undefined && isStaleLock(holder)) removeFileIfSame(`${lockPath}.reclaim`, holder.inode);
    return;
  }
  try {
    const current = inspectLock(lockPath);
    if (current !== undefined && isStaleLock(current)) removeFileIfSame(lockPath, current.inode);
  } finally {
    releaseLock(guard);
  }
}

/** Deletes the lock file only when it still holds our token, so a slow holder can never delete a lock someone else took. */
function releaseLock(lock: HeldLock): void {
  try {
    const current = inspectLock(lock.path);
    if (current !== undefined && current.token === lock.token && current.inode === fstatSync(lock.fd).ino) {
      rmSync(lock.path, { force: true });
    }
  } finally {
    closeSync(lock.fd);
  }
}

async function acquireLock(lockPath: string): Promise<HeldLock> {
  const deadline = performance.now() + LOCK_WAIT_MS;
  for (;;) {
    const lock = createLockFile(lockPath);
    if (lock !== undefined) return lock;
    const holder = inspectLock(lockPath);
    if (holder === undefined) continue; // It vanished between the attempt and the look: try again at once.
    if (isStaleLock(holder)) {
      breakStaleLock(lockPath);
      if (inspectLock(lockPath) === undefined) continue;
    }
    if (performance.now() >= deadline) {
      throw new Error(`Timed out acquiring config lock ${lockPath}${
        holder.pid === undefined ? "" : ` (held by process ${holder.pid}; if that process is gone, delete the lock file)`}`);
    }
    await delay(LOCK_RETRY_MS);
  }
}

/** Path of the first `null` inside `value`, or undefined. TOML has no null: serializing one silently drops the field. */
function findNull(value: unknown, path: string): string | undefined {
  if (value === null) return path;
  if (Array.isArray(value)) {
    // Elements are searched recursively: an object or array nested inside an array can hold a null too.
    for (const [index, item] of value.entries()) {
      const found = findNull(item, `${path}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isTable(value)) return undefined;
  for (const [key, child] of Object.entries(value)) {
    const found = findNull(child, `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Rejects a `null` anywhere in a patch before it is merged or serialized: it would be dropped without a trace, and a safety
 * setting (for example `allow_unsandboxed_write = false`) would quietly revert to the built-in value. The one exception is
 * `presets.<id>.roles.<role> = null`, which deletes a preset role on purpose.
 */
function assertNoNull(patch: unknown, path: string): void {
  if (!isTable(patch)) {
    if (patch === null) throw new Error(nullMessage(path));
    return;
  }
  for (const [key, value] of Object.entries(patch)) {
    if (path.startsWith("presets.") && key === "roles" && isTable(value)) {
      for (const [role, roleValue] of Object.entries(value)) {
        const found = roleValue === null ? undefined : findNull(roleValue, `${path}.roles.${role}`);
        if (found !== undefined) throw new Error(nullMessage(found));
      }
      continue;
    }
    const found = findNull(value, `${path}.${key}`);
    if (found !== undefined) throw new Error(nullMessage(found));
  }
}

function nullMessage(path: string): string {
  return `Invalid null value at ${path}: TOML has no null. Omit the field to keep it unchanged, list an optional field in ` +
    "_unset to clear it, or reset it to its built-in value.";
}

/** `_unset` must be an array of known, clearable field names; anything else is an error instead of being dropped. */
function assertValidUnset(section: EntitySection, id: string, unset: unknown): void {
  if (unset === undefined) return;
  if (!Array.isArray(unset)) throw new Error(`_unset must be a JSON array of field names, for example ["profile"]`);
  const allowed: readonly string[] = section === "harnesses" ? HARNESS_UNSETTABLE_FIELDS : section === "models" ? MODEL_UNSETTABLE_FIELDS : [];
  for (const entry of unset) {
    if (typeof entry !== "string") {
      throw new Error(`_unset for ${section}.${id} must contain only field names (strings), got ${entry === null ? "null" : typeof entry}`);
    }
    if (!allowed.includes(entry)) {
      throw new Error(`_unset for ${section}.${id} cannot clear ${JSON.stringify(entry)}; ${
        allowed.length > 0 ? `clearable fields: ${allowed.join(", ")}` : `${section} have no clearable fields`}`);
    }
  }
}

function assertValidEntityPatch(section: EntitySection, id: string, patch: unknown): void {
  assertNoNull(patch, `${section}.${id}`);
  if (isTable(patch)) assertValidUnset(section, id, patch._unset);
}

function mergeRolePatch(previous: Table, patch: Table): Table {
  const changes = Object.entries(defined(patch)).map(([name, role]) => {
    if (role === null || (isTable(role) && Object.keys(defined(role)).length === 0)) return [name, {}];
    const existing = ownValue(previous, name);
    return [name, isTable(role) ? { ...(isTable(existing) ? existing : {}), ...defined(role) } : role];
  });
  return { ...previous, ...Object.fromEntries(changes) };
}

function sparsePatch(candidate: Table, base: Table): Table {
  const patch: Table = Object.fromEntries(Object.entries(candidate).filter(([key, value]) =>
    key !== "_base_hash" && !isDeepStrictEqual(value, ownValue(base, key)),
  ));

  if (isTable(patch.roles) && isTable(base.roles)) {
    const roles = Object.entries(patch.roles).flatMap(([name, role]) => {
      const inherited = ownValue(base.roles as Table, name);
      if (!isTable(role)) return [[name, role]];
      if (Object.keys(role).length === 0) return inherited === undefined ? [] : [[name, role]];
      const differences = isTable(inherited) ? sparsePatch(role, inherited) : role;
      return Object.keys(differences).length === 0 ? [] : [[name, differences]];
    });
    if (roles.length === 0) delete patch.roles;
    else patch.roles = Object.fromEntries(roles);
  }
  return patch;
}

function setEntity(overrides: ConfigOverrides, section: EntitySection, id: string, entity: Table): void {
  const entries = { ...overrides[section] };
  if (Object.keys(entity).length === 0) delete entries[id];
  else Object.defineProperty(entries, id, { value: entity, enumerable: true });
  if (Object.keys(entries).length === 0) delete overrides[section];
  else overrides[section] = entries;
}

function setAlias(overrides: ConfigOverrides, id: string, target: string | undefined): void {
  const aliases = { ...overrides.aliases };
  if (target === undefined) delete aliases[id];
  else Object.defineProperty(aliases, id, { value: target, enumerable: true });
  if (Object.keys(aliases).length === 0) delete overrides.aliases;
  else overrides.aliases = aliases;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Merges a patch into the user's sparse entry for one entity. `_unset` in the patch clears fields (so an inherited optional
 * value can be removed); setting a field again takes it off the clear list.
 */
function applyUpsert(overrides: ConfigOverrides, base: Catalog, section: EntitySection, id: string, patch: Table): void {
  // A malformed entity (not a table) is replaced outright: saving a valid entity is how it gets repaired.
  const stored = ownValue<unknown>(overrides[section], id);
  const existing = isTable(stored) ? stored : undefined;
  const inherited = ownValue<Table>(base[section], id);
  if (!inherited && existing === undefined) assertValidEntityId(id);

  assertValidEntityPatch(section, id, patch);
  const { _unset: unsetPatch, ...fields } = defined(patch);
  const previous = existing ?? {};
  const candidate: Table = { ...previous, ...fields };
  if (section === "presets" && isTable(patch.roles)) {
    candidate.roles = mergeRolePatch(isTable(previous.roles) ? previous.roles : {}, patch.roles);
  }

  const cleared = new Set([...stringList(previous._unset).filter((name) => !Object.hasOwn(fields, name)), ...stringList(unsetPatch)]);
  for (const name of cleared) delete candidate[name];
  delete candidate._unset;

  if (inherited && candidate.custom !== true) {
    const sparse = sparsePatch(candidate, inherited);
    // Only a field the built-in actually has can be cleared; for anything else there is nothing to remember.
    const unset = [...cleared].filter((name) => Object.hasOwn(inherited, name));
    if (unset.length > 0) sparse._unset = unset;
    if (Object.keys(sparse).length > 0) sparse._base_hash = computeEntityHash(inherited);
    setEntity(overrides, section, id, sparse);
  } else {
    delete candidate._base_hash;
    setEntity(overrides, section, id, candidate);
  }
}

/**
 * `section.id` keys of the entities that are quarantined in this config. `undefined` means the file does not resolve at
 * all (for example a bad `[defaults]` value), so there is no baseline to compare with and only touched entities are strict:
 * a write that repairs the file must not be refused because of the very damage it repairs.
 */
function quarantineKeys(base: Catalog, overrides: ConfigOverrides): Set<string> | undefined {
  try {
    return new Set(resolveConfig(base, overrides).quarantined.map(({ section, id }) => `${section}.${id}`));
  } catch {
    return undefined;
  }
}

/**
 * An existing config file is written through its real path, so a dotfiles symlink (`models.toml -> ~/dotfiles/models.toml`)
 * keeps pointing at the same file instead of being replaced by a regular one. A dangling symlink (its target does not exist
 * yet) is followed to the path it names, so the first save creates the target instead of replacing the link. A path that
 * does not exist at all is used as is.
 */
function resolveWritableTarget(path: string): string {
  let current = path;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    try {
      return realpathSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return current;
    current = resolve(dirname(current), readlinkSync(current));
  }
  throw new Error(`Too many levels of symbolic links while resolving ${path}`);
}

export class ConfigWriter {
  constructor(private readonly manager: ConfigManager = new ConfigManager()) {}

  updateDefaults(patch: DefaultsPatch, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.mutate(expectedRevision, (overrides, base) => {
      const next = sparsePatch({ ...overrides.defaults, ...defined(patch) }, base.defaults);
      if (Object.keys(next).length === 0) delete overrides.defaults;
      else overrides.defaults = next;
    }, [], () => assertNoNull(patch, "defaults"));
  }

  upsertModelOverride(id: string, patch: ModelPatch, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.upsert("models", id, patch, expectedRevision);
  }

  resetModelField(id: string, field: keyof ModelPatch, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.resetField("models", id, field, expectedRevision);
  }

  resetHarnessField(id: string, field: keyof HarnessPatch, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.resetField("harnesses", id, field, expectedRevision);
  }

  resetOrDeleteModel(id: string, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.resetEntity("models", id, expectedRevision);
  }

  upsertHarnessOverride(id: string, patch: HarnessPatch, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.upsert("harnesses", id, patch, expectedRevision);
  }

  resetOrDeleteHarness(id: string, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.resetEntity("harnesses", id, expectedRevision);
  }

  upsertPresetOverride(id: string, patch: PresetPatch, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.upsert("presets", id, patch, expectedRevision);
  }

  resetOrDeletePreset(id: string, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.resetEntity("presets", id, expectedRevision);
  }

  /** Sets (or changes) a user alias. A target equal to the built-in alias just drops the override. */
  upsertAlias(id: string, target: string, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.mutate(expectedRevision, (overrides, base) => {
      if (typeof target !== "string" || !target.trim()) throw new Error(`Alias ${JSON.stringify(id)} needs a non-empty target model ID`);
      if (!Object.hasOwn(base.aliases, id) && !Object.hasOwn(overrides.aliases ?? {}, id)) assertValidEntityId(id);
      setAlias(overrides, id, ownValue(base.aliases, id) === target ? undefined : target);
      // The alias must lead to a real model, must not loop, and must not hide behind a model with the same ID.
      const resolved = resolveConfig(base, overrides);
      if (Object.hasOwn(resolved.models, id)) {
        throw new Error(`Alias ${JSON.stringify(id)} would be ignored: a model has the same ID and model IDs take precedence`);
      }
      const rejected = resolved.quarantined.find((entry) => entry.section === "aliases" && entry.id === id);
      if (rejected) throw new Error(`Alias ${JSON.stringify(id)} is invalid: ${rejected.reason}`);
      const modelId = resolveModelAlias(id, resolved.aliases, resolved.models);
      if (!Object.hasOwn(resolved.models, modelId)) {
        throw new Error(`Alias ${JSON.stringify(id)} points to unknown model ${JSON.stringify(modelId)}`);
      }
    });
  }

  /** Removes the user's alias override. A built-in alias comes back; a user-only alias is deleted. */
  resetAlias(id: string, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.mutate(expectedRevision, (overrides) => setAlias(overrides, id, undefined));
  }

  /**
   * Creates new custom models and enables existing ones in one validated, atomic write under the config lock.
   * A batch that changes nothing returns the current snapshot without touching the file.
   */
  async importModels(batch: ImportModelBatch, expectedRevision?: string): Promise<ImportModelsResult> {
    const creations = Object.entries(batch.create ?? {});
    const enableIds = [...new Set(batch.enable ?? [])];
    const imported: string[] = [];
    const enabled: string[] = [];
    const skipped: string[] = [];
    // Only entities this call really writes are validated strictly; a skipped (already existing) one must not abort the batch.
    const touched: string[] = [];
    const snapshot = await this.mutate(expectedRevision, (overrides, base) => {
      const before = stringify(overrides);
      const current = resolveConfig(base, overrides).models;
      for (const [id, patch] of creations) {
        if (Object.hasOwn(current, id) || Object.hasOwn(base.models, id) || Object.hasOwn(overrides.models ?? {}, id)) {
          skipped.push(id);
          continue;
        }
        applyUpsert(overrides, base, "models", id, { ...patch, custom: true });
        imported.push(id);
        touched.push(`models.${id}`);
      }
      for (const id of enableIds) {
        const model = ownValue(current, id);
        if (!model) throw new Error(`Cannot enable unknown model ${JSON.stringify(id)}`);
        if (model.enabled) continue;
        applyUpsert(overrides, base, "models", id, { enabled: true });
        enabled.push(id);
        touched.push(`models.${id}`);
      }
      if (stringify(overrides) === before) return "unchanged";
    }, touched, () => {
      for (const [id, patch] of creations) assertValidEntityPatch("models", id, patch);
    });
    return { snapshot, imported, enabled, skipped };
  }

  resetSection(section: ConfigSection, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.mutate(expectedRevision, (overrides) => {
      delete overrides[section];
    });
  }

  resetAllToDefault(expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.mutate(expectedRevision);
  }

  private upsert(section: EntitySection, id: string, patch: Table, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.mutate(
      expectedRevision, (overrides, base) => applyUpsert(overrides, base, section, id, patch), [`${section}.${id}`],
      () => assertValidEntityPatch(section, id, patch),
    );
  }

  private resetField(section: "harnesses" | "models", id: string, field: string, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.mutate(expectedRevision, (overrides) => {
      const stored = ownValue<unknown>(overrides[section], id);
      const entity = { ...(isTable(stored) ? stored : {}) };
      delete entity[field];
      // A reset field inherits again, so it must not stay on the clear list either.
      if (Array.isArray(entity._unset)) {
        const remaining = entity._unset.filter((name) => name !== field);
        if (remaining.length > 0) entity._unset = remaining;
        else delete entity._unset;
      }
      if (Object.keys(entity).length === 1 && Object.hasOwn(entity, "_base_hash")) delete entity._base_hash;
      setEntity(overrides, section, id, entity);
    }, [`${section}.${id}`]);
  }

  private resetEntity(section: EntitySection, id: string, expectedRevision?: string): Promise<ConfigSnapshot> {
    return this.mutate(expectedRevision, (overrides) => setEntity(overrides, section, id, {}));
  }

  private async mutate(
    expectedRevision?: string, change?: Mutation, touched: readonly string[] = [], validate?: () => void,
  ): Promise<ConfigSnapshot> {
    validate?.();
    const { defaultPath, userPath } = this.manager;
    mkdirSync(dirname(userPath), { recursive: true, mode: 0o700 });
    const path = resolveWritableTarget(join(realpathSync(dirname(userPath)), basename(userPath)));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (path === realpathSync(defaultPath)) throw new Error("User config path points to the built-in catalog");

    const lockPath = `${path}.lock`;
    const lock = await acquireLock(lockPath);
    try {
      const defaultText = readFileSync(defaultPath, "utf8");
      const userBytes = readOptionalConfig(path);
      const revision = computeConfigRevision(defaultText, userBytes);
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new ConfigRevisionConflictError(expectedRevision, revision);
      }
      // The lock only stops other writers; a person editing the file by hand does not take it. Checked again right before
      // the rename, so an edit made while this write was being prepared is reported instead of overwritten.
      const assertFileUnchanged = (): void => {
        const latest = readOptionalConfig(path);
        const same = latest === null ? userBytes === null : userBytes !== null && latest.equals(userBytes);
        if (!same) throw new ConfigRevisionConflictError(revision, computeConfigRevision(defaultText, latest));
      };

      const base = parseDefaultCatalog(defaultText);
      const overrides = change ? parseUserOverrides(userBytes?.toString("utf8") ?? null) : {};
      const quarantinedBefore = change ? quarantineKeys(base, overrides) : new Set<string>();
      if (change?.(overrides, base) === "unchanged") return this.manager.load();
      const content = stringify({ ...overrides, schema_version: 1 });
      // A hand-broken entity that was already quarantined does not block unrelated edits; anything new or touched must be valid.
      const touchedKeys = new Set(touched);
      const offending = resolveConfig(base, parseUserOverrides(content)).quarantined.find(({ section, id }) => {
        const key = `${section}.${id}`;
        return touchedKeys.has(key) || (quarantinedBefore !== undefined && !quarantinedBefore.has(key));
      });
      if (offending) throw quarantineFailure(offending);

      if (!userBytes?.equals(Buffer.from(content))) {
        assertFileUnchanged();
        if (!change && userBytes !== null) backupConfig(path, userBytes);
        writeAtomically(path, content, assertFileUnchanged);
      } else if (!change && userBytes !== null) {
        backupConfig(path, userBytes);
      }
      return this.manager.load();
    } finally {
      releaseLock(lock);
    }
  }
}
