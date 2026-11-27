/** The config writer flushes the parent directory after the backup and the atomic rename, and tolerates filesystems that cannot. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../../src/config/resolver.js";
import { ConfigWriter } from "../../src/config/writer.js";

const sync = vi.hoisted(() => ({ directoryCalls: 0, fileCalls: 0, failDirectoriesWith: undefined as string | undefined }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: number) => {
      if (actual.fstatSync(fd).isDirectory()) {
        sync.directoryCalls += 1;
        if (sync.failDirectoriesWith) throw Object.assign(new Error("not supported"), { code: sync.failDirectoriesWith });
        return actual.fsyncSync(fd);
      }
      sync.fileCalls += 1;
      return actual.fsyncSync(fd);
    },
  };
});

let directory: string;
let userPath: string;
let writer: ConfigWriter;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orch-fsync-"));
  userPath = join(directory, "models.toml");
  const defaultPath = join(directory, "catalog.toml");
  writeFileSync(defaultPath, "schema_version = 1\n");
  writer = new ConfigWriter(new ConfigManager({ defaultPath, userPath }));
  Object.assign(sync, { directoryCalls: 0, fileCalls: 0, failDirectoriesWith: undefined });
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("config writer directory sync", () => {
  it("fsyncs the parent directory after the atomic rename, and after the backup of a reset", async () => {
    await writer.updateDefaults({ max_queue_size: 3 });
    expect(sync.directoryCalls).toBe(1);
    expect(sync.fileCalls).toBeGreaterThan(0);
    await writer.resetAllToDefault();
    expect(sync.directoryCalls).toBe(3); // The backup and the rewrite.
    expect(readdirSync(directory).some((name) => name.startsWith("models.toml.bak."))).toBe(true);
  });

  it.each(["EINVAL", "EBADF", "EPERM"])("ignores %s from filesystems that cannot sync a directory", async (code) => {
    sync.failDirectoriesWith = code;
    await writer.updateDefaults({ max_queue_size: 4 });
    expect(readFileSync(userPath, "utf8")).toContain("max_queue_size = 4");
    expect(sync.directoryCalls).toBeGreaterThan(0);
  });

  it("still reports an unexpected directory sync failure", async () => {
    sync.failDirectoriesWith = "EIO";
    await expect(writer.updateDefaults({ max_queue_size: 5 })).rejects.toThrow("not supported");
  });
});

