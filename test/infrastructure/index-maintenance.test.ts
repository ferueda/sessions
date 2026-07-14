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

import { clearIndex } from "../../src/application/clear-index.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { IndexMaintenanceError } from "../../src/application/ports/index-maintenance.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { createSqliteIndexMaintenance } from "../../src/infrastructure/sqlite/index-maintenance.ts";
import { applyMigrations, sqliteMigrations } from "../../src/infrastructure/sqlite/migrations.ts";

const temporaryDirectories: string[] = [];

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

    await expect(clearIndex(paths, createSqliteIndexMaintenance())).resolves.toEqual({
      schemaVersion: 1,
      command: "index-clear",
      outcome: "absent",
      databaseRemoved: false,
      walRemoved: false,
      shmRemoved: false,
    });
    await expect(stat(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("clears a current index while retaining its directory and unrelated files", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(paths);
    await writer.close();
    const neighbor = path.join(paths.directory, "keep.txt");
    await writeFile(neighbor, "not owned by index clear", { mode: 0o600 });

    await expect(clearIndex(paths, createSqliteIndexMaintenance())).resolves.toEqual({
      schemaVersion: 1,
      command: "index-clear",
      outcome: "cleared",
      databaseRemoved: true,
      walRemoved: false,
      shmRemoved: false,
    });

    await expect(readFile(neighbor, "utf8")).resolves.toBe("not owned by index clear");
    await expect(readdir(paths.directory)).resolves.toEqual(["keep.txt"]);
    await expect(lifecycle.inspect(paths)).resolves.toMatchObject({ status: "uninitialized" });
  });

  test("refuses a current index owned by a live indexing writer", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle({
      now: () => new Date("2026-07-14T12:00:00.000Z"),
      writerToken: () => "index-owner",
    }).openWriter(paths);

    await expect(
      clearIndex(
        paths,
        createSqliteIndexMaintenance({
          now: () => new Date("2026-07-14T12:00:01.000Z"),
          token: () => "clear-owner",
        }),
      ),
    ).rejects.toMatchObject({ code: "index-busy" });
    expect(await stat(paths.database)).toBeDefined();

    await writer.close();
  });

  test("keeps expired clear intent fenced from indexing until another clear resumes it", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(paths);
    await writer.close();
    let now = new Date("2026-07-14T12:00:00.000Z");
    let takeoverError: unknown;

    await expect(
      clearIndex(
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
      clearIndex(
        paths,
        createSqliteIndexMaintenance({
          now: () => now,
          token: () => "resuming-clear-owner",
        }),
      ),
    ).resolves.toMatchObject({ outcome: "cleared", databaseRemoved: true });
  });

  test("removes an older known database without migrating it", async () => {
    const paths = await fixturePaths();
    await createOlderIndex(paths);
    const before = await readFile(paths.database);

    await expect(clearIndex(paths, createSqliteIndexMaintenance())).resolves.toMatchObject({
      outcome: "cleared",
      databaseRemoved: true,
    });
    expect(before.length).toBeGreaterThan(0);
    await expect(stat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes a corrupt known database without opening or migrating it", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.database, "not a SQLite database", { mode: 0o600 });
    const neighbor = path.join(paths.directory, "keep-corrupt-neighbor.txt");
    await writeFile(neighbor, "retain", { mode: 0o600 });

    await expect(clearIndex(paths, createSqliteIndexMaintenance())).resolves.toMatchObject({
      outcome: "cleared",
      databaseRemoved: true,
      walRemoved: false,
      shmRemoved: false,
    });
    await expect(readFile(neighbor, "utf8")).resolves.toBe("retain");
  });

  test("rejects a substituted non-current database without deleting the replacement", async () => {
    const paths = await fixturePaths();
    await createOlderIndex(paths);

    await expect(
      clearIndex(
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

  test("refuses recovery sidecars beside an older database", async () => {
    const paths = await fixturePaths();
    await createOlderIndex(paths);
    await writeFile(paths.wal, "possible recovery state", { mode: 0o600 });

    await expect(clearIndex(paths, createSqliteIndexMaintenance())).rejects.toEqual(
      expect.objectContaining<Partial<IndexMaintenanceError>>({ code: "recovery-required" }),
    );
    await expect(readFile(paths.wal, "utf8")).resolves.toBe("possible recovery state");
    expect(await stat(paths.database)).toBeDefined();
  });

  test("refuses sidecar-only state", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.shm, "possible recovery state", { mode: 0o600 });

    await expect(clearIndex(paths, createSqliteIndexMaintenance())).rejects.toMatchObject({
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

    await expect(clearIndex(paths, createSqliteIndexMaintenance())).rejects.toMatchObject({
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
      clearIndex({ ...paths, database: unrelated }, createSqliteIndexMaintenance()),
    ).rejects.toMatchObject({ code: "unsafe-index" });
    await expect(readFile(unrelated, "utf8")).resolves.toBe("unrelated");
  });

  test("throws a retryable typed failure after deletion fails", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();
    const now = new Date("2026-07-14T12:00:00.000Z");
    const failingMaintenance = createSqliteIndexMaintenance({
      now: () => now,
      token: () => "first-clear-owner",
      async unlinkFile(file) {
        if (file === paths.database) throw new Error("injected unlink failure");
        await unlink(file);
      },
    });

    await expect(clearIndex(paths, failingMaintenance)).rejects.toMatchObject({
      code: "clear-failed",
      message: "Index maintenance failed: clear-failed",
    });
    expect(await stat(paths.database)).toBeDefined();

    await expect(
      clearIndex(
        paths,
        createSqliteIndexMaintenance({
          now: () => now,
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
      clearIndex(
        paths,
        createSqliteIndexMaintenance({
          async unlinkFile(file) {
            await unlink(file);
            await unlink(file);
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: "cleared", databaseRemoved: false });
    await expect(stat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-clear-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "sessions");
  const database = path.join(directory, "index.sqlite3");
  return {
    directory,
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}

async function createOlderIndex(paths: IndexPaths): Promise<void> {
  await mkdir(paths.directory, { mode: 0o700 });
  const database = new DatabaseSync(paths.database);
  applyMigrations(database, sqliteMigrations.slice(0, 2));
  database.close();
  if (process.platform !== "win32") await chmod(paths.database, 0o600);
}
