import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { openExistingSqliteWriterDatabase } from "../../src/infrastructure/sqlite/sqlite-writer-database.ts";
import { readWriterLeaseHealth } from "../../src/infrastructure/sqlite/writer-lease.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite writer cleanup", () => {
  test("an existing-only writer open never creates a missing database", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });

    expect(() => openExistingSqliteWriterDatabase(paths.database, 0)).toThrow(/.+/u);
    await expect(lstat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("releases the lease and closes the database after workspace cleanup fails", async () => {
    const paths = await fixturePaths();
    const now = () => new Date("2026-07-14T13:00:00.000Z");
    const writer = await createSqliteIndexLifecycle({
      now,
      writerToken: () => "cleanup-owner",
    }).openWriter(paths);
    await rm(paths.scratch, { recursive: true });
    await writeFile(paths.scratch, "unsafe replacement");

    await expect(writer.close()).rejects.toMatchObject({ code: "unsafe-scratch-root" });
    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(readWriterLeaseHealth(database, { now })).toEqual({ status: "free", generation: 1 });
    } finally {
      database.close();
    }
    await expect(lstat(paths.scratch)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });
});

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-writer-cleanup-"));
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
