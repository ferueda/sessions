import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import {
  applyMigrations,
  readMigrationHistory,
  sqliteMigrations,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { readWriterLeaseHealth } from "../../src/infrastructure/sqlite/writer-lease.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite writer lifecycle cutover", () => {
  test("opens schema 3 by atomically carrying its expired index lease into schema 4", async () => {
    const paths = await schemaThreePaths("index", "2026-07-14T12:00:30.000Z");
    const now = () => new Date("2026-07-14T12:01:00.000Z");
    const writer = await createSqliteIndexLifecycle({
      now,
      writerToken: () => "lifecycle-cutover-owner",
    }).openWriter(paths);

    expect(readMigrationHistory(writer.database).currentVersion).toBe(4);
    expect(readWriterLeaseHealth(writer.database, { now })).toMatchObject({
      status: "live",
      generation: 2,
      purpose: "index",
    });
    expect(await readdir(paths.scratch)).toEqual([]);
    await expect(
      writer.workspace.withPrivateDirectory(async (directory) => {
        await writeFile(path.join(directory, "private-state"), "ephemeral");
        return path.dirname(directory);
      }),
    ).resolves.toBe(paths.scratch);
    expect(await readdir(paths.scratch)).toEqual([]);

    await writer.close();
    await expect(lstat(paths.scratch)).rejects.toMatchObject({ code: "ENOENT" });
    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(readWriterLeaseHealth(database, { now })).toEqual({ status: "free", generation: 2 });
    } finally {
      database.close();
    }
  });

  test("leaves schema 3 and its live owner unchanged when lifecycle acquisition is refused", async () => {
    const paths = await schemaThreePaths("index", "2026-07-14T12:02:00.000Z");
    const lifecycle = createSqliteIndexLifecycle({
      now: () => new Date("2026-07-14T12:01:00.000Z"),
      writerToken: () => "refused-lifecycle-owner",
    });

    await expect(lifecycle.openWriter(paths)).rejects.toMatchObject({ code: "writer-busy" });
    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(readMigrationHistory(database).currentVersion).toBe(3);
      expect(
        database
          .prepare("SELECT generation, purpose, owner_token FROM sessions_writer_lease")
          .get(),
      ).toEqual({
        generation: 1,
        purpose: "index",
        owner_token: "schema-three-owner",
      });
    } finally {
      database.close();
    }
    await expect(lstat(paths.scratch)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("attempts lease release and database close after workspace cleanup fails", async () => {
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
  });
});

async function schemaThreePaths(
  purpose: "index" | "clear",
  expiresAt: string,
): Promise<IndexPaths> {
  const paths = await fixturePaths();
  await mkdir(paths.directory, { mode: 0o700 });
  const database = new DatabaseSync(paths.database);
  try {
    applyMigrations(database, sqliteMigrations.slice(0, 3));
    database
      .prepare(
        `UPDATE sessions_writer_lease
         SET generation = 1,
             purpose = ?,
             owner_token = 'schema-three-owner',
             acquired_at = '2026-07-14T12:00:00.000Z',
             heartbeat_at = '2026-07-14T12:00:10.000Z',
             expires_at = ?
         WHERE singleton = 1`,
      )
      .run(purpose, expiresAt);
  } finally {
    database.close();
  }
  return paths;
}

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-lifecycle-cutover-"));
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
