import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite ready-index health", () => {
  test("reports a healthy empty index through an immutable inspection", async () => {
    const paths = await initializedPaths();
    const lifecycle = createSqliteIndexLifecycle({
      now: () => new Date("2026-07-14T12:00:00.000Z"),
    });
    const before = await persistenceSnapshot(paths);

    await expect(lifecycle.inspectHealth(paths)).resolves.toEqual({
      ok: true,
      integrity: "ok",
      foreignKeys: "ok",
      ftsStructure: "ok",
      ftsContent: "ok",
      ftsSecureDelete: "enabled",
      runRecords: "ok",
      writerLease: "free",
      activeRuns: 0,
      interruptedRuns: 0,
    });

    expect(await persistenceSnapshot(paths)).toEqual(before);
  });

  test("reports historical interrupted runs without making the index unhealthy", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      const source = database
        .prepare(
          `INSERT INTO sessions_source_instances (kind, instance_id)
           VALUES ('synthetic', 'profile-one')`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO sessions_index_runs (
             source_instance_id, status, started_at, finished_at, failure_code
           ) VALUES (?, 'interrupted', ?, ?, 'interrupted')`,
        )
        .run(source.lastInsertRowid, "2026-07-14T10:00:00.000Z", "2026-07-14T10:01:00.000Z");
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      activeRuns: 0,
      interruptedRuns: 1,
      writerLease: "free",
    });
  });

  test("fails an active run without a live indexing lease", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      const source = database
        .prepare(
          `INSERT INTO sessions_source_instances (kind, instance_id)
           VALUES ('synthetic', 'profile-two')`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO sessions_index_runs (source_instance_id, status, started_at)
           VALUES (?, 'active', ?)`,
        )
        .run(source.lastInsertRowid, "2026-07-14T11:00:00.000Z");
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      activeRuns: 1,
      interruptedRuns: 0,
      writerLease: "free",
    });
  });

  test("detects missing persistent FTS secure-delete configuration", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      database.exec(
        `INSERT INTO sessions_content_fts (sessions_content_fts, rank)
         VALUES ('secure-delete', 0)`,
      );
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      ftsSecureDelete: "missing",
    });
  });

  test.each([
    "DROP TRIGGER sessions_content_values_ai",
    `DROP TRIGGER sessions_content_values_bd;
     CREATE TRIGGER sessions_content_values_bd
     BEFORE DELETE ON sessions_content_values
     BEGIN
       SELECT 1;
     END`,
  ])("detects missing or altered FTS maintenance triggers", async (sql) => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => database.exec(sql));

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      ftsStructure: "failed",
    });
  });

  test("detects FTS content-row inconsistency through read-only shadow checks", async () => {
    const paths = await initializedPaths();
    const text = "indexed evidence";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      const inserted = database
        .prepare(
          `INSERT INTO sessions_content_values (hash_scheme, digest, text)
           VALUES (?, ?, ?)`,
        )
        .run(contentHash.scheme, contentHash.digest, text);
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(inserted.lastInsertRowid, text);
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      ftsContent: "failed",
    });
  });

  test("detects foreign-key violations without exposing the violating row", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      database
        .prepare(
          `INSERT INTO sessions_content_occurrences (
             session_id, entry_ordinal, segment_ordinal, content_id,
             origin, confidence, source_metadata_json
           ) VALUES (999, 0, 0, 999, 'unknown', 'unknown', '{}')`,
        )
        .run();
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      foreignKeys: "failed",
    });
  });
});

async function initializedPaths(lifecycle = createSqliteIndexLifecycle()): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-health-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "sessions");
  const database = path.join(directory, "index.sqlite3");
  const paths: IndexPaths = {
    directory,
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
  const writer = await lifecycle.openWriter(paths);
  await writer.close();
  return paths;
}

interface PersistenceSnapshot {
  readonly database: Buffer;
  readonly modified: bigint;
  readonly entries: readonly string[];
  readonly migrations: readonly Record<string, unknown>[];
  readonly runs: readonly Record<string, unknown>[];
}

async function persistenceSnapshot(paths: IndexPaths): Promise<PersistenceSnapshot> {
  const database = openImmutable(paths.database);
  try {
    return {
      database: await readFile(paths.database),
      modified: (await stat(paths.database, { bigint: true })).mtimeNs,
      entries: await readdir(paths.directory),
      migrations: database
        .prepare("SELECT * FROM sessions_schema_migrations ORDER BY version")
        .all() as readonly Record<string, unknown>[],
      runs: database
        .prepare("SELECT * FROM sessions_index_runs ORDER BY run_id")
        .all() as readonly Record<string, unknown>[],
    };
  } finally {
    database.close();
  }
}

function openImmutable(file: string): DatabaseSync {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, { readOnly: true });
}

function mutateDatabase(file: string, mutate: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(file);
  try {
    mutate(database);
  } finally {
    database.close();
  }
}
