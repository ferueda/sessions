import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { clearData } from "../../src/application/clear-index.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { createSqliteIndexMaintenance } from "../../src/infrastructure/sqlite/index-maintenance.ts";
import { acquireWriterLease } from "../../src/infrastructure/sqlite/writer-lease.ts";
import { writerCleanProofPaths } from "../../src/infrastructure/sqlite/writer-clean-proof.ts";

const temporaryDirectories: string[] = [];
const LEGACY_BOOTSTRAP_CHECKSUM =
  "sha256-utf8-v1:be63645c8bcb17699fba78674153d9fa04603e0915497f6f9b6c194fdd58593c";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite index maintenance", () => {
  test("returns absent without creating the owned directory", async () => {
    const paths = await fixturePaths();

    await expect(clearData(paths, createSqliteIndexMaintenance())).resolves.toEqual({
      schemaVersion: 1,
      command: "data-clear",
      outcome: "absent",
      scratchRemoved: false,
      databaseRemoved: false,
      walRemoved: false,
      shmRemoved: false,
    });
    await expect(stat(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes proof-only residue without treating it as initialized storage", async () => {
    const paths = await fixturePaths();
    const proof = writerCleanProofPaths(paths.database);
    const temporary = `${proof.temporaryPrefix}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    const neighbor = path.join(paths.directory, "keep.txt");
    await mkdir(paths.directory, { mode: 0o700 });
    await Promise.all([
      writeFile(proof.proof, "stale proof", { mode: 0o600 }),
      writeFile(temporary, "abandoned temporary proof", { mode: 0o600 }),
      writeFile(neighbor, "unrelated", { mode: 0o600 }),
    ]);

    await expect(clearData(paths, createSqliteIndexMaintenance())).resolves.toEqual({
      schemaVersion: 1,
      command: "data-clear",
      outcome: "absent",
      scratchRemoved: false,
      databaseRemoved: false,
      walRemoved: false,
      shmRemoved: false,
    });
    await expect(readdir(paths.directory)).resolves.toEqual(["keep.txt"]);
  });

  test.runIf(process.platform !== "win32")(
    "does not remove proof residue through an unsafe owned directory",
    async () => {
      const paths = await fixturePaths();
      const proof = writerCleanProofPaths(paths.database);
      await mkdir(paths.directory, { mode: 0o700 });
      await writeFile(proof.proof, "retain stale proof", { mode: 0o600 });
      await chmod(paths.directory, 0o755);

      await expect(clearData(paths, createSqliteIndexMaintenance())).rejects.toMatchObject({
        code: "unsafe-index",
      });
      await expect(readFile(proof.proof, "utf8")).resolves.toBe("retain stale proof");
    },
  );

  test("removes an empty interrupted-initialization database", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.database, "", { mode: 0o600 });

    await expect(clearData(paths, createSqliteIndexMaintenance())).resolves.toMatchObject({
      outcome: "cleared",
      databaseRemoved: true,
    });
    await expect(stat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("clears a current index while retaining its directory and unrelated files", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(paths);
    await writer.close();
    const neighbor = path.join(paths.directory, "keep.txt");
    await writeFile(neighbor, "not owned by index clear", { mode: 0o600 });

    await expect(clearData(paths, createSqliteIndexMaintenance())).resolves.toEqual({
      schemaVersion: 1,
      command: "data-clear",
      outcome: "cleared",
      scratchRemoved: false,
      databaseRemoved: true,
      walRemoved: false,
      shmRemoved: false,
    });

    await expect(readFile(neighbor, "utf8")).resolves.toBe("not owned by index clear");
    await expect(readdir(paths.directory)).resolves.toEqual(["keep.txt"]);
    await expect(lifecycle.inspect(paths)).resolves.toMatchObject({ status: "uninitialized" });
  });

  test("removes only the exact scratch subtree and does not follow nested symlinks", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();
    await mkdir(paths.scratch, { mode: 0o700 });
    await mkdir(path.join(paths.scratch, "nested"), { mode: 0o700 });
    await writeFile(path.join(paths.scratch, "nested", "temporary.txt"), "temporary", {
      mode: 0o600,
    });
    const outside = path.join(path.dirname(paths.directory), "outside.txt");
    await writeFile(outside, "retain outside", { mode: 0o600 });
    await symlink(outside, path.join(paths.scratch, "outside-link"));

    await expect(clearData(paths, createSqliteIndexMaintenance())).resolves.toMatchObject({
      outcome: "cleared",
      scratchRemoved: true,
      databaseRemoved: true,
    });
    await expect(stat(paths.scratch)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outside, "utf8")).resolves.toBe("retain outside");
  });

  test("refuses orphan scratch without its lease-bearing database", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.scratch, { mode: 0o700, recursive: true });
    await writeFile(path.join(paths.scratch, "orphan.txt"), "retain", { mode: 0o600 });

    await expect(clearData(paths, createSqliteIndexMaintenance())).rejects.toMatchObject({
      code: "recovery-required",
    });
    await expect(readFile(path.join(paths.scratch, "orphan.txt"), "utf8")).resolves.toBe("retain");
  });

  test("refuses a current index owned by a live indexing writer", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle({
      now: () => new Date("2026-07-14T12:00:00.000Z"),
      writerToken: () => "index-owner",
    }).openWriter(paths);

    await expect(
      clearData(
        paths,
        createSqliteIndexMaintenance({
          now: () => new Date("2026-07-14T12:00:01.000Z"),
          token: () => "clear-owner",
        }),
      ),
    ).rejects.toMatchObject({ code: "library-busy" });
    expect(await stat(paths.database)).toBeDefined();

    await writer.close();
  });

  test("honors a live writer before inspecting or touching its scratch root", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();
    const now = () => new Date("2026-07-14T12:00:00.000Z");
    const database = new DatabaseSync(paths.database);
    acquireWriterLease(database, "index", { now, token: () => "live-index-owner" });
    database.close();
    const outside = path.join(path.dirname(paths.directory), "live-owner-scratch.txt");
    await writeFile(outside, "retain", { mode: 0o600 });
    await symlink(outside, paths.scratch);

    await expect(
      clearData(
        paths,
        createSqliteIndexMaintenance({
          now: () => new Date("2026-07-14T12:00:01.000Z"),
          token: () => "blocked-clear-owner",
        }),
      ),
    ).rejects.toMatchObject({ code: "library-busy" });
    await expect(readFile(outside, "utf8")).resolves.toBe("retain");
  });

  test("keeps expired clear intent fenced from indexing until another clear resumes it", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(paths);
    await writer.close();
    let now = new Date("2026-07-14T12:00:00.000Z");
    let takeoverError: unknown;

    await expect(
      clearData(
        paths,
        createSqliteIndexMaintenance({
          now: () => now,
          token: () => "expiring-clear-owner",
          async beforeFileRemoval() {
            now = new Date("2026-07-14T12:01:00.000Z");
            try {
              await createSqliteIndexLifecycle({
                now: () => now,
                writerToken: () => "racing-index-owner",
              }).openWriter(paths);
            } catch (error) {
              takeoverError = error;
            }
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "concurrent-change" });
    expect(takeoverError).toMatchObject({ code: "writer-busy" });
    expect(await stat(paths.database)).toBeDefined();

    await expect(
      clearData(
        paths,
        createSqliteIndexMaintenance({
          now: () => now,
          token: () => "resuming-clear-owner",
        }),
      ),
    ).resolves.toMatchObject({ outcome: "cleared", databaseRemoved: true });
  });

  test("refuses an obsolete development database without mutating it", async () => {
    const paths = await fixturePaths();
    await createObsoleteDevelopmentIndex(paths);
    const before = await readFile(paths.database);

    await expect(clearData(paths, createSqliteIndexMaintenance())).rejects.toMatchObject({
      code: "corrupt-data",
    });
    await expect(readFile(paths.database)).resolves.toEqual(before);
  });

  test("refuses a corrupt known database without removing neighboring files", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.database, "not a SQLite database", { mode: 0o600 });
    const neighbor = path.join(paths.directory, "keep-corrupt-neighbor.txt");
    await writeFile(neighbor, "retain", { mode: 0o600 });

    await expect(clearData(paths, createSqliteIndexMaintenance())).rejects.toMatchObject({
      code: "corrupt-data",
    });
    await expect(readFile(paths.database, "utf8")).resolves.toBe("not a SQLite database");
    await expect(readFile(neighbor, "utf8")).resolves.toBe("retain");
  });

  test("rejects a substituted non-current database without deleting the replacement", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();

    await expect(
      clearData(
        paths,
        createSqliteIndexMaintenance({
          async beforeFileRemoval() {
            await unlink(paths.database);
            await writeFile(paths.database, "replacement owned by another operation", {
              mode: 0o600,
            });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "concurrent-change" });
    await expect(readFile(paths.database, "utf8")).resolves.toBe(
      "replacement owned by another operation",
    );
  });

  test("refuses sidecar-only state", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.shm, "possible recovery state", { mode: 0o600 });

    await expect(clearData(paths, createSqliteIndexMaintenance())).rejects.toMatchObject({
      code: "recovery-required",
    });
    await expect(readFile(paths.shm, "utf8")).resolves.toBe("possible recovery state");
  });

  test("refuses unsafe known paths without following a symlink", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    const outside = path.join(path.dirname(paths.directory), "outside.sqlite3");
    await writeFile(outside, "outside", { mode: 0o600 });
    await symlink(outside, paths.database);

    await expect(clearData(paths, createSqliteIndexMaintenance())).rejects.toMatchObject({
      code: "unsafe-index",
    });
    await expect(readFile(outside, "utf8")).resolves.toBe("outside");
  });

  test("validates canonical owned paths before inspecting or deleting", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    const unrelated = path.join(path.dirname(paths.directory), "unrelated.sqlite3");
    await writeFile(unrelated, "unrelated", { mode: 0o600 });

    await expect(
      clearData({ ...paths, database: unrelated }, createSqliteIndexMaintenance()),
    ).rejects.toMatchObject({ code: "unsafe-index" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("unrelated");
  });

  test("throws a retryable typed failure after deletion fails", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();
    let now = new Date("2026-07-14T12:00:00.000Z");
    const failingMaintenance = createSqliteIndexMaintenance({
      now: () => new Date(now),
      token: () => "first-clear-owner",
      async unlinkFile(file) {
        if (file === paths.database) throw new Error("injected unlink failure");
        await unlink(file);
      },
    });

    await expect(clearData(paths, failingMaintenance)).rejects.toMatchObject({
      code: "clear-failed",
      message: "Session library maintenance failed: clear-failed",
    });
    expect(await stat(paths.database)).toBeDefined();

    now = new Date("2026-07-14T12:01:00.000Z");
    await expect(
      clearData(
        paths,
        createSqliteIndexMaintenance({
          now: () => new Date(now),
          token: () => "retry-clear-owner",
        }),
      ),
    ).resolves.toMatchObject({ outcome: "cleared", databaseRemoved: true });
  });

  test("treats a target that disappears at unlink as already removed", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();

    await expect(
      clearData(
        paths,
        createSqliteIndexMaintenance({
          async unlinkFile(file) {
            await unlink(file);
            await unlink(file);
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: "absent", databaseRemoved: false });
    await expect(stat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-clear-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "sessions");
  const database = path.join(directory, "sessions.sqlite3");
  return {
    directory,
    scratch: path.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}

async function createObsoleteDevelopmentIndex(paths: IndexPaths): Promise<void> {
  await mkdir(paths.directory, { mode: 0o700 });
  const database = new DatabaseSync(paths.database);
  try {
    database.exec(`CREATE TABLE sessions_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;`);
    database
      .prepare(
        `INSERT INTO sessions_schema_migrations (version, name, checksum, applied_at)
         VALUES (1, 'bootstrap', ?, '2026-07-14T12:00:00.000Z')`,
      )
      .run(LEGACY_BOOTSTRAP_CHECKSUM);
  } finally {
    database.close();
  }
  if (process.platform !== "win32") await chmod(paths.database, 0o600);
}
