import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import {
  SqliteIndexLifecycleError,
  SqliteIndexReaderClosedError,
} from "../../src/infrastructure/sqlite/lifecycle-error.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
  sqliteMigrations,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { createSqliteReadSnapshot } from "../../src/infrastructure/sqlite/read-snapshot.ts";
import { counts, finishCompleted, replacement } from "../contracts/session-index.contract.ts";
import { createTestDocument, createTestIdentity } from "../fixtures/session.ts";
import { createSessionManifestQuery } from "../../src/domain/session-manifest.ts";
import { createSqliteSessionQuery } from "../../src/infrastructure/sqlite/sqlite-session-query.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite reader lifecycle", () => {
  test("reads an immutable snapshot without changing the index or creating sidecars", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(paths);
    await writer.close();
    const beforeEntries = await readdir(paths.directory);
    const beforeBytes = await readFile(paths.database);
    const snapshot = createSqliteReadSnapshot(paths);

    await expect(
      snapshot.run((database) =>
        database.prepare("SELECT max(version) AS version FROM sessions_schema_migrations").get(),
      ),
    ).resolves.toEqual({ version: CURRENT_INDEX_SCHEMA_VERSION });
    await snapshot.close();

    expect(await readdir(paths.directory)).toEqual(beforeEntries);
    expect(await readFile(paths.database)).toEqual(beforeBytes);
    await expect(stat(paths.wal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.shm)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(snapshot.run(() => undefined)).rejects.toBeInstanceOf(
      SqliteIndexReaderClosedError,
    );
  });

  test("opens a connectionless repository reader without changing index state", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(paths);
    await writer.close();
    const beforeEntries = await readdir(paths.directory);
    const beforeBytes = await readFile(paths.database);

    const reader = await lifecycle.openReader(paths);
    expect(reader).not.toHaveProperty("database");
    await expect(reader.sessions.getFreshness(createTestIdentity("not-indexed"))).resolves.toEqual({
      status: "untracked",
      identity: createTestIdentity("not-indexed"),
    });
    await expect(
      reader.sessions.getSummary(createTestIdentity("not-indexed")),
    ).resolves.toBeUndefined();
    await expect(
      reader.sessions.getDocument(createTestIdentity("not-indexed")),
    ).resolves.toBeUndefined();
    await reader.close();
    await reader.close();

    expect(await readdir(paths.directory)).toEqual(beforeEntries);
    expect(await readFile(paths.database)).toEqual(beforeBytes);
    await expect(stat(paths.wal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.shm)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      reader.sessions.getFreshness(createTestIdentity("after-close")),
    ).rejects.toBeInstanceOf(SqliteIndexReaderClosedError);
  });

  test("returns one verified session and attribution from an immutable reader snapshot", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const identity = createTestIdentity("snapshot-session");
    const admitted = replacement(identity, "snapshot-revision", createTestDocument({ identity }));
    const writer = await lifecycle.openWriter(paths);
    const run = await writer.sessions.startRun({
      source: identity.source,
      startedAt: "2026-07-15T12:00:00.000Z",
    });
    await writer.sessions.replaceSession(run, admitted);
    await finishCompleted(writer.sessions, run, counts({ discovered: 1, updated: 1 }));
    await writer.close();

    const reader = await lifecycle.openReader(paths);
    try {
      await expect(reader.sessions.getSession(identity)).resolves.toEqual({
        summary: {
          identity,
          title: "Synthetic session",
          workspace: "/workspace/synthetic",
          createdAt: "2026-07-13T12:00:00.000Z",
          updatedAt: "2026-07-13T12:01:00.000Z",
          freshness: "current",
          sourceState: "present",
          capturedAt: "2026-07-15T12:00:00.000Z",
          sourceObservedAt: "2026-07-15T12:00:00.000Z",
          adapterVersion: "synthetic-v1",
          documentDigest: admitted.documentDigest,
        },
        document: admitted.document,
      });
    } finally {
      await reader.close();
    }
  });

  test("refuses absent and migration-required state without initializing it", async () => {
    const absentPaths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();

    await expect(lifecycle.openReader(absentPaths)).rejects.toMatchObject({
      state: { status: "uninitialized" },
    });
    await expect(stat(absentPaths.directory)).rejects.toMatchObject({ code: "ENOENT" });

    const baselinePaths = await fixturePaths();
    await createBaselineIndex(baselinePaths);
    const beforeBytes = await readFile(baselinePaths.database);
    const futureLifecycle = createSqliteIndexLifecycle({
      migrations: [
        ...sqliteMigrations,
        {
          version: CURRENT_INDEX_SCHEMA_VERSION + 1,
          name: "future_marker",
          sql: "CREATE TABLE future_marker (id INTEGER);",
        },
      ],
    });
    await expect(futureLifecycle.openReader(baselinePaths)).rejects.toMatchObject({
      state: {
        status: "migration-required",
        schemaVersion: 1,
        supportedSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION + 1,
      },
    });
    expect(await readFile(baselinePaths.database)).toEqual(beforeBytes);
    const database = openReadOnly(baselinePaths.database);
    expect(
      database.prepare("SELECT version FROM sessions_schema_migrations ORDER BY version").all(),
    ).toEqual([{ version: 1 }]);
    database.close();
  });

  test("refuses a current schema with the wrong page mode before running a read", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    const database = new DatabaseSync(paths.database);
    try {
      applyMigrations(database);
      expect(database.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
    } finally {
      database.close();
    }
    await chmod(paths.database, 0o600);
    const beforeBytes = await readFile(paths.database);
    const beforeEntries = await readdir(paths.directory);
    const snapshot = createSqliteReadSnapshot(paths);
    let operationRan = false;

    await expect(
      snapshot.run(() => {
        operationRan = true;
      }),
    ).rejects.toMatchObject({
      state: {
        status: "incompatible",
        reason: "page-reclamation-mode-mismatch",
      },
    });
    await snapshot.close();

    expect(operationRan).toBe(false);
    expect(await readFile(paths.database)).toEqual(beforeBytes);
    expect(await readdir(paths.directory)).toEqual(beforeEntries);
  });

  test("discards a read result when the main database changes during the operation", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();
    const snapshot = createSqliteReadSnapshot(paths);

    const readFailure: unknown = await snapshot
      .run(() => {
        mutateDatabase(paths.database, (database) => {
          database
            .prepare("UPDATE sessions_schema_migrations SET applied_at = ? WHERE version = 1")
            .run("2026-07-14T00:00:00.000Z");
        });
        return "must be discarded";
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(readFailure).toBeInstanceOf(SqliteIndexLifecycleError);
    expect(readFailure).toMatchObject({
      state: { status: "incompatible", reason: "concurrent-change" },
    });
    await snapshot.close();
  });

  test("discards a complete manifest when the main database changes during its snapshot", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const identity = createTestIdentity("manifest-snapshot");
    const writer = await lifecycle.openWriter(paths);
    const run = await writer.sessions.startRun({
      source: identity.source,
      startedAt: "2026-07-15T12:00:00.000Z",
    });
    await writer.sessions.replaceSession(
      run,
      replacement(identity, "manifest-snapshot-revision", createTestDocument({ identity })),
    );
    await finishCompleted(writer.sessions, run, counts({ discovered: 1, updated: 1 }));
    await writer.close();
    const snapshot = createSqliteReadSnapshot(paths);

    const readFailure = await snapshot
      .run(async (database) => {
        const complete = await createSqliteSessionQuery(database).manifest(
          createSessionManifestQuery(),
        );
        expect(complete.revisions).toHaveLength(1);
        mutateDatabase(paths.database, (mutable) => {
          mutable
            .prepare("UPDATE sessions_schema_migrations SET applied_at = ? WHERE version = 1")
            .run("2026-07-14T00:00:00.000Z");
        });
        return complete;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(readFailure).toBeInstanceOf(SqliteIndexLifecycleError);
    expect(readFailure).toMatchObject({
      state: { status: "incompatible", reason: "concurrent-change" },
    });
    await snapshot.close();
  });

  test("aggregates an operation error with recovery detected after the read", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();
    const snapshot = createSqliteReadSnapshot(paths);
    const operationError = new Error("synthetic read failure");

    const readFailure: unknown = await snapshot
      .run(async () => {
        await writeFile(paths.wal, "appeared during read", { mode: 0o600 });
        throw operationError;
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(readFailure).toBeInstanceOf(AggregateError);
    const errors = (readFailure as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(2);
    expect(errors[0]).toBe(operationError);
    expect(errors[1]).toBeInstanceOf(SqliteIndexLifecycleError);
    expect(errors[1]).toMatchObject({ state: { status: "recovery-required" } });
    expect((readFailure as AggregateError).cause).toBe(operationError);
    await snapshot.close();
  });

  test("preserves a thrown undefined value as a failed read", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();
    const snapshot = createSqliteReadSnapshot(paths);

    const outcome = await snapshot
      .run(() => {
        throw undefined;
      })
      .then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

    expect(outcome).toEqual({ status: "rejected", error: undefined });
    await snapshot.close();
  });
});

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-sqlite-reader-"));
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

function openReadOnly(file: string): DatabaseSync {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, { readOnly: true });
}

async function createBaselineIndex(paths: IndexPaths): Promise<void> {
  await mkdir(paths.directory, { mode: 0o700 });
  const database = new DatabaseSync(paths.database);
  try {
    database.exec("PRAGMA auto_vacuum = INCREMENTAL");
    applyMigrations(database, [sqliteMigrations[0]!]);
  } finally {
    database.close();
  }
  await chmod(paths.database, 0o600);
}

function mutateDatabase(file: string, mutate: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(file);
  try {
    mutate(database);
  } finally {
    database.close();
  }
}
