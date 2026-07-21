import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { SourceCaptureWorkspaceError } from "../../src/application/ports/session-source.ts";
import {
  createSqliteIndexLifecycle,
  SqliteIndexLifecycleError,
} from "../../src/infrastructure/sqlite/database.ts";
import {
  configureFts5SecureDelete,
  enableFts5SecureDelete,
  Fts5SecureDeleteConfigurationError,
  Fts5UnavailableError,
  probeFts5Security,
} from "../../src/infrastructure/sqlite/fts5-security.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
  migrationChecksum,
  sqliteMigrations,
  type SqliteMigration,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { prepareIndexPathsForWriter } from "../../src/infrastructure/sqlite/permissions.ts";
import {
  configureSqliteWriterDatabase,
  openSqliteWriterDatabase,
} from "../../src/infrastructure/sqlite/sqlite-writer-database.ts";
import {
  readWriterCleanProof,
  writerCleanProofPaths,
} from "../../src/infrastructure/sqlite/writer-clean-proof.ts";
import {
  admittedReplacement,
  completeDocument,
  identity,
  observation,
} from "../contracts/session-index.contract.ts";

const PRIOR_DOCUMENT_DIGEST_BOOTSTRAP_CHECKSUM =
  "sha256-utf8-v1:9e2233fa22b3dc8f999252985e3a65a036198d773ac4ebe6d787fd45ddbc2e5e";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite index lifecycle", () => {
  test("selects incremental page reclamation before bootstrapping a new database", async () => {
    const paths = await fixturePaths();
    const prepared = await prepareIndexPathsForWriter(paths);
    expect(prepared).toEqual({ databaseCreated: true });
    const database = openSqliteWriterDatabase(paths.database, 5_000);
    try {
      configureSqliteWriterDatabase(database, 5_000, {
        initializePageReclamation: prepared.databaseCreated,
      });
      expect(database.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
      expect(
        database
          .prepare(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sessions_schema_migrations'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }

    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    expect(writer.database.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    expect(
      writer.database.prepare("SELECT COUNT(*) AS count FROM sessions_schema_migrations").get(),
    ).toEqual({ count: CURRENT_INDEX_SCHEMA_VERSION });
    await writer.close();
  });

  test("initializes a fresh index once and reopens it without changing history", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();

    await expect(lifecycle.inspect(paths)).resolves.toEqual({
      status: "uninitialized",
      initialized: false,
      schemaVersion: null,
      supportedSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    });

    const firstWriter = await lifecycle.openWriter(paths);
    expect(firstWriter.database.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    const firstHistory = firstWriter.database
      .prepare(
        `SELECT version, name, checksum, applied_at
         FROM sessions_schema_migrations`,
      )
      .all() as Record<string, unknown>[];
    expect(firstHistory).toHaveLength(sqliteMigrations.length);
    for (const [index, migration] of sqliteMigrations.entries()) {
      expect(firstHistory[index]).toMatchObject({
        version: migration.version,
        name: migration.name,
        checksum: migrationChecksum(migration),
      });
      expect(firstHistory[index]?.checksum).toMatch(/^sha256-utf8-v1:[a-f0-9]{64}$/u);
    }
    await firstWriter.close();
    const firstProof = await readWriterCleanProof(paths.database);
    expect(firstProof).toMatchObject({
      version: 1,
      writerGeneration: 1,
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      schemaCookie: expect.any(Number),
    });

    const secondWriter = await lifecycle.openWriter(paths);
    expect(secondWriter.database.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
    expect(
      secondWriter.database
        .prepare("SELECT version, name, checksum, applied_at FROM sessions_schema_migrations")
        .all(),
    ).toEqual(firstHistory);
    expect(
      secondWriter.database.prepare("SELECT * FROM sessions_writer_lease").get(),
    ).toMatchObject({
      generation: 2,
      clean_generation: 1,
      clean_schema_cookie: firstProof?.schemaCookie,
      purpose: "index",
    });
    await secondWriter.close();
    await expect(readWriterCleanProof(paths.database)).resolves.toMatchObject({
      writerGeneration: 2,
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      schemaCookie: firstProof?.schemaCookie,
    });
    await expect(lifecycle.inspect(paths)).resolves.toMatchObject({
      status: "ready",
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    });
  });

  test("consumes clean proof before temporary-residue cleanup can fail", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const firstWriter = await lifecycle.openWriter(paths);
    const sessionIdentity = identity("proof-failure-profile", "proof-failure-session");
    const run = await firstWriter.sessions.startRun({
      source: sessionIdentity.source,
      startedAt: "2026-07-16T12:00:00.000Z",
    });
    await firstWriter.sessions.replaceSession(
      run,
      admittedReplacement(
        observation(sessionIdentity, "proof-failure-revision"),
        completeDocument(sessionIdentity),
      ),
    );
    await firstWriter.close();
    await expect(readWriterCleanProof(paths.database)).resolves.toMatchObject({
      writerGeneration: 1,
    });

    const residue = `${writerCleanProofPaths(paths.database).temporaryPrefix}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    await mkdir(residue, { mode: 0o700 });
    await expect(lifecycle.openWriter(paths)).rejects.toMatchObject({ code: "cleanup-failed" });

    await expect(readWriterCleanProof(paths.database)).resolves.toBeUndefined();
    const afterFailure = openReadOnly(paths.database);
    try {
      expect(afterFailure.prepare("SELECT * FROM sessions_writer_lease").get()).toMatchObject({
        generation: 1,
        clean_generation: 1,
        purpose: null,
      });
    } finally {
      afterFailure.close();
    }
    await rm(residue, { force: true, recursive: true });

    mutateDatabase(paths.database, (database) => {
      const occurrence = database
        .prepare(
          `SELECT session_id, entry_ordinal, segment_ordinal
           FROM sessions_content_occurrences
           WHERE content_id IS NOT NULL
           ORDER BY session_id, entry_ordinal, segment_ordinal
           LIMIT 1`,
        )
        .get() as
        | {
            readonly session_id: number | bigint;
            readonly entry_ordinal: number | bigint;
            readonly segment_ordinal: number | bigint;
          }
        | undefined;
      if (occurrence === undefined) throw new Error("Expected indexed content occurrence");
      const inserted = database
        .prepare("INSERT INTO sessions_content_values (digest, text) VALUES (?, ?)")
        .run(Buffer.alloc(32, 0x7f), "canonical content with a mismatched digest");
      database
        .prepare(
          `UPDATE sessions_content_occurrences
           SET content_id = ?
           WHERE session_id = ? AND entry_ordinal = ? AND segment_ordinal = ?`,
        )
        .run(
          inserted.lastInsertRowid,
          occurrence.session_id,
          occurrence.entry_ordinal,
          occurrence.segment_ordinal,
        );
    });

    await expect(lifecycle.openWriter(paths)).rejects.toThrow(
      "SQLite FTS projection recovery failed: canonical-corrupt",
    );
    await expect(readWriterCleanProof(paths.database)).resolves.toBeUndefined();
  });

  test("applies a contiguous catalog in order", async () => {
    const paths = await fixturePaths();
    const firstMarkerVersion = sqliteMigrations.length + 1;
    const migrations: readonly SqliteMigration[] = [
      ...sqliteMigrations,
      {
        version: firstMarkerVersion,
        name: "create_marker",
        sql: "CREATE TABLE marker (position INTEGER NOT NULL) STRICT;",
      },
      {
        version: firstMarkerVersion + 1,
        name: "populate_marker",
        sql: `INSERT INTO marker (position) VALUES (${firstMarkerVersion + 1});`,
      },
    ];
    const lifecycle = createSqliteIndexLifecycle({ migrations });

    const writer = await lifecycle.openWriter(paths);
    expect(
      writer.database
        .prepare("SELECT version, name FROM sessions_schema_migrations ORDER BY version")
        .all(),
    ).toEqual([
      ...sqliteMigrations.map(({ version, name }) => ({ version, name })),
      { version: firstMarkerVersion, name: "create_marker" },
      { version: firstMarkerVersion + 1, name: "populate_marker" },
    ]);
    expect(writer.database.prepare("SELECT position FROM marker").get()).toEqual({
      position: firstMarkerVersion + 1,
    });
    await writer.close();
  });

  test("rolls back a failed release, retains prior releases, and retries", async () => {
    const paths = await fixturePaths();
    const stableVersion = sqliteMigrations.length + 1;
    const firstTwo: readonly SqliteMigration[] = [
      ...sqliteMigrations,
      {
        version: stableVersion,
        name: "stable_release",
        sql: "CREATE TABLE stable_release (value TEXT NOT NULL) STRICT;",
      },
    ];
    const failing = [
      ...firstTwo,
      {
        version: stableVersion + 1,
        name: "retryable_release",
        sql: `CREATE TABLE rolled_back (value TEXT) STRICT;
INSERT INTO table_that_does_not_exist VALUES (1);`,
      },
    ] satisfies readonly SqliteMigration[];
    const failedLifecycle = createSqliteIndexLifecycle({ migrations: failing });

    const migrationFailure: unknown = await failedLifecycle.openWriter(paths).then(
      async (unexpectedWriter) => {
        await unexpectedWriter.close();
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(migrationFailure).not.toBeInstanceOf(AggregateError);
    expect(migrationFailure).toMatchObject({
      code: "ERR_SQLITE_ERROR",
      message: "no such table: table_that_does_not_exist",
    });
    await expect(failedLifecycle.inspect(paths)).resolves.toMatchObject({
      status: "migration-required",
      schemaVersion: stableVersion,
      supportedSchemaVersion: stableVersion + 1,
    });
    const afterFailure = openReadOnly(paths.database);
    expect(
      afterFailure.prepare("SELECT name FROM sqlite_schema WHERE name = 'rolled_back'").get(),
    ).toBeUndefined();
    expect(
      afterFailure.prepare("SELECT version FROM sessions_schema_migrations ORDER BY version").all(),
    ).toEqual(Array.from({ length: stableVersion }, (_, index) => ({ version: index + 1 })));
    afterFailure.close();

    const corrected = [
      ...firstTwo,
      {
        version: stableVersion + 1,
        name: "retryable_release",
        sql: "CREATE TABLE recovered_release (value TEXT) STRICT;",
      },
    ] satisfies readonly SqliteMigration[];
    const retryLifecycle = createSqliteIndexLifecycle({ migrations: corrected });
    const writer = await retryLifecycle.openWriter(paths);
    expect(
      writer.database
        .prepare("SELECT version FROM sessions_schema_migrations ORDER BY version")
        .all(),
    ).toEqual(Array.from({ length: stableVersion + 1 }, (_, index) => ({ version: index + 1 })));
    await writer.close();
  });

  test("refuses changed checksums and newer schemas", async () => {
    const checksumPaths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(checksumPaths);
    await writer.close();

    mutateDatabase(checksumPaths.database, (database) => {
      database
        .prepare("UPDATE sessions_schema_migrations SET checksum = ? WHERE version = 1")
        .run(PRIOR_DOCUMENT_DIGEST_BOOTSTRAP_CHECKSUM);
    });
    const obsoleteBytes = await readFile(checksumPaths.database);
    await expect(lifecycle.inspect(checksumPaths)).resolves.toMatchObject({
      status: "incompatible",
      reason: "migration-checksum-mismatch",
      schemaVersion: 1,
    });
    const incompatibleMessage = [
      "Session library was created by an incompatible pre-release build.",
      "Use a fresh SESSIONS_DATA_DIR, or back up and remove only the Sessions-owned directory",
      'shown by "sessions paths", then run "sessions index" again',
    ].join(" ");
    await expect(lifecycle.openWriter(checksumPaths)).rejects.toMatchObject({
      message: incompatibleMessage,
      state: { status: "incompatible", reason: "migration-checksum-mismatch" },
    });
    await expect(lifecycle.openReader(checksumPaths)).rejects.toMatchObject({
      state: { status: "incompatible", reason: "migration-checksum-mismatch" },
    });
    await expect(readFile(checksumPaths.database)).resolves.toEqual(obsoleteBytes);

    const newerPaths = await fixturePaths();
    const newerWriter = await lifecycle.openWriter(newerPaths);
    await newerWriter.close();
    mutateDatabase(newerPaths.database, (database) => {
      database
        .prepare(
          `INSERT INTO sessions_schema_migrations
             (version, name, checksum, applied_at)
           VALUES (?, 'future_release', 'sha256-utf8-v2:future', ?)`,
        )
        .run(CURRENT_INDEX_SCHEMA_VERSION + 1, new Date().toISOString());
    });
    await expect(lifecycle.inspect(newerPaths)).resolves.toEqual({
      status: "newer-schema",
      initialized: true,
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION + 1,
      supportedSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    });
    await expect(lifecycle.openWriter(newerPaths)).rejects.toBeInstanceOf(
      SqliteIndexLifecycleError,
    );
  });

  test("inspects immutable state without creating sidecars", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(paths);
    await writer.close();
    const beforeEntries = await readdir(paths.directory);
    const beforeBytes = await readFile(paths.database);

    await expect(lifecycle.inspect(paths)).resolves.toMatchObject({ status: "ready" });

    expect(await readdir(paths.directory)).toEqual(beforeEntries);
    expect(await readFile(paths.database)).toEqual(beforeBytes);
    await expect(stat(paths.wal)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.shm)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("keeps readers immutable while a writer resolves recovery sidecars", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle();
    const writer = await lifecycle.openWriter(paths);
    await writer.close();
    await writeFile(paths.wal, "active-or-stale", { mode: 0o600 });

    await expect(lifecycle.inspect(paths)).resolves.toEqual({
      status: "recovery-required",
      initialized: true,
      schemaVersion: null,
      supportedSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    });
    await expect(lifecycle.openReader(paths)).rejects.toMatchObject({
      state: { status: "recovery-required" },
    });

    const recoveredWriter = await lifecycle.openWriter(paths);
    await recoveredWriter.close();
    await expect(lifecycle.inspect(paths)).resolves.toMatchObject({ status: "ready" });
  });

  test("refuses sidecar-only recovery without creating a database", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.wal, "orphaned recovery state", { mode: 0o600 });

    await expect(createSqliteIndexLifecycle().openWriter(paths)).rejects.toMatchObject({
      state: { status: "recovery-required" },
    });
    await expect(stat(paths.database)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.wal, "utf8")).resolves.toBe("orphaned recovery state");
  });

  test("recovers a valid WAL and interrupts the abandoned run before new work", async () => {
    const paths = await fixturePaths();
    const databaseModule = pathToFileURL(
      path.resolve("src/infrastructure/sqlite/database.ts"),
    ).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createSqliteIndexLifecycle } from ${JSON.stringify(databaseModule)};
const paths = JSON.parse(process.env.SESSIONS_TEST_INDEX_PATHS);
const lifecycle = createSqliteIndexLifecycle({
  now: () => new Date("2026-07-13T12:00:00.000Z"),
  writerToken: () => "abandoned-child-owner",
});
const writer = await lifecycle.openWriter(paths);
await writer.sessions.startRun({
  source: { kind: "synthetic", instanceId: "recovery-profile" },
  startedAt: "2026-07-13T12:00:00.000Z",
});
process.exit(0);`,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, SESSIONS_TEST_INDEX_PATHS: JSON.stringify(paths) },
      },
    );
    expect(child.status).toBe(0);
    await expect(stat(paths.wal)).resolves.toMatchObject({ size: expect.any(Number) });

    const lifecycle = createSqliteIndexLifecycle({
      now: () => new Date("2026-07-13T12:01:00.000Z"),
      writerToken: () => "recovery-owner",
    });
    await expect(lifecycle.inspect(paths)).resolves.toMatchObject({
      status: "recovery-required",
    });

    const writer = await lifecycle.openWriter(paths);
    expect(
      writer.database
        .prepare(
          `SELECT status, finished_at, failure_code
           FROM sessions_index_runs`,
        )
        .get(),
    ).toEqual({
      status: "interrupted",
      finished_at: "2026-07-13T12:01:00.000Z",
      failure_code: "interrupted",
    });
    await writer.close();
    await expect(lifecycle.inspect(paths)).resolves.toMatchObject({ status: "ready" });
  });

  test("rejects a preexisting empty database without changing its page mode", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    await writeFile(paths.database, "", { mode: 0o600 });
    const lifecycle = createSqliteIndexLifecycle();

    await expect(lifecycle.inspect(paths)).resolves.toMatchObject({
      status: "migration-required",
      initialized: true,
      schemaVersion: 0,
    });
    const before = await readFile(paths.database);
    await expect(lifecycle.openWriter(paths)).rejects.toMatchObject({
      state: {
        status: "incompatible",
        reason: "page-reclamation-mode-mismatch",
      },
    });
    expect(await readFile(paths.database)).toEqual(before);
  });

  test.each([
    { label: "none", mode: 0 },
    { label: "full", mode: 1 },
  ])("rejects an existing current-schema $label database without changing it", async ({ mode }) => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    const database = new DatabaseSync(paths.database);
    try {
      if (mode === 1) database.exec("PRAGMA auto_vacuum = FULL");
      applyMigrations(database);
      expect(database.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: mode });
    } finally {
      database.close();
    }
    await chmod(paths.database, 0o600);
    const before = await readFile(paths.database);

    await expect(createSqliteIndexLifecycle().openWriter(paths)).rejects.toMatchObject({
      state: {
        status: "incompatible",
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
        reason: "page-reclamation-mode-mismatch",
      },
    });

    expect(await readFile(paths.database)).toEqual(before);
    const readOnly = openReadOnly(paths.database);
    try {
      expect(readOnly.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: mode });
    } finally {
      readOnly.close();
    }
  });

  test("rejects an existing empty migration table as invalid history", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    mutateDatabase(paths.database, (database) => {
      database.exec(sqliteMigrations[0]!.sql);
    });
    await chmod(paths.database, 0o600);

    await expect(createSqliteIndexLifecycle().inspect(paths)).resolves.toMatchObject({
      status: "incompatible",
      reason: "invalid-migration-history",
    });
  });

  test("rejects an arbitrary SQLite database without migration history", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.directory, { mode: 0o700 });
    mutateDatabase(paths.database, (database) => {
      database.exec("CREATE TABLE unrelated (value TEXT) STRICT;");
    });
    await chmod(paths.database, 0o600);

    await expect(createSqliteIndexLifecycle().inspect(paths)).resolves.toMatchObject({
      status: "incompatible",
      reason: "unrecognized-database",
    });
  });

  test("configures the writer security pragmas and FTS5 capability", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    const pragma = (name: string): unknown =>
      Object.values(writer.database.prepare(`PRAGMA ${name}`).get() ?? {})[0];

    expect(pragma("journal_mode")).toBe("wal");
    expect(pragma("foreign_keys")).toBe(1);
    expect(pragma("secure_delete")).toBe(1);
    expect(pragma("trusted_schema")).toBe(0);
    expect(pragma("busy_timeout")).toBe(5_000);
    writer.database.exec("PRAGMA writable_schema = ON");
    expect(pragma("writable_schema")).toBe(0);
    expect(writer.fts5Security).toMatchObject({ fts5: true });
    expect(writer.fts5Security.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    const persistentFtsSecurity = writer.database
      .prepare("SELECT v FROM sessions_content_fts_config WHERE k = 'secure-delete'")
      .get();
    expect(persistentFtsSecurity).toEqual(writer.fts5SecureDelete ? { v: 1 } : undefined);
    expect(() => writer.database.prepare('SELECT "not a string literal"').get()).toThrow(
      /no such column/u,
    );
    expect(() => writer.database.prepare("SELECT load_extension('missing')").get()).toThrow(
      /not authorized/u,
    );

    writer.database.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
    `);
    expect(() => writer.database.prepare("INSERT INTO child VALUES (999)").run()).toThrow(
      /FOREIGN KEY constraint failed/u,
    );
    await writer.close();
  });

  test.skipIf(process.platform === "win32")(
    "hardens database permissions even when connection close throws",
    async () => {
      const paths = await fixturePaths();
      const writer = await createSqliteIndexLifecycle().openWriter(paths);
      writer.database.close();
      await chmod(paths.database, 0o644);

      const closeFailure = await writer.close().catch((error: unknown) => error);
      expect(closeFailure).toBeInstanceOf(AggregateError);
      const errors = (closeFailure as AggregateError).errors;
      expect(errors).toHaveLength(2);
      expect(errors[0]).toBeInstanceOf(SourceCaptureWorkspaceError);
      expect((errors[0] as SourceCaptureWorkspaceError).cause).toMatchObject({
        code: "ERR_INVALID_STATE",
        message: "database is not open",
      });
      expect(errors[1]).toMatchObject({
        code: "ERR_INVALID_STATE",
        message: "database is not open",
      });
      expect((await stat(paths.database)).mode & 0o777).toBe(0o600);
      await expect(readWriterCleanProof(paths.database)).resolves.toBeUndefined();
      await expect(writer.close()).resolves.toBeUndefined();
    },
  );

  test("aggregates independent close and file-hardening failures", async () => {
    const paths = await fixturePaths();
    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    writer.database.close();
    await rm(paths.database);

    const cleanupFailure: unknown = await writer.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(cleanupFailure).toBeInstanceOf(AggregateError);
    const errors = (cleanupFailure as AggregateError).errors;
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBeInstanceOf(SourceCaptureWorkspaceError);
    expect((errors[0] as SourceCaptureWorkspaceError).cause).toMatchObject({
      code: "ERR_INVALID_STATE",
      message: "database is not open",
    });
    expect(errors[1]).toMatchObject({
      code: "ERR_INVALID_STATE",
      message: "database is not open",
    });
    expect(errors[2]).toMatchObject({ code: "ENOENT" });
    await expect(readWriterCleanProof(paths.database)).resolves.toBeUndefined();
  });

  test.skipIf(process.platform === "win32")(
    "tightens owned POSIX paths and protects database sidecars",
    async () => {
      const paths = await fixturePaths();
      await mkdir(paths.directory, { mode: 0o755 });
      await chmod(paths.directory, 0o755);

      const writer = await createSqliteIndexLifecycle().openWriter(paths);
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.database)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.wal)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.shm)).mode & 0o777).toBe(0o600);
      await writer.close();
    },
  );

  test.skipIf(process.platform === "win32")(
    "reports permissive POSIX state without tightening it during inspection",
    async () => {
      const paths = await fixturePaths();
      await mkdir(paths.directory, { mode: 0o755 });
      await chmod(paths.directory, 0o755);

      await expect(createSqliteIndexLifecycle().inspect(paths)).resolves.toMatchObject({
        status: "unsafe",
        target: "directory",
        reason: "permissions",
      });
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o755);
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects symlink targets without changing neighboring provider data",
    async () => {
      const root = await temporaryDirectory();
      const providerDirectory = path.join(root, "provider-history");
      const providerFile = path.join(providerDirectory, "session.jsonl");
      await mkdir(providerDirectory, { mode: 0o700 });
      await writeFile(providerFile, "provider-owned\n", { mode: 0o600 });
      const paths = indexPaths(path.join(root, "sessions"));
      await mkdir(paths.directory, { mode: 0o700 });
      await symlink(providerFile, paths.database);

      await expect(createSqliteIndexLifecycle().inspect(paths)).resolves.toMatchObject({
        status: "unsafe",
        target: "database",
        reason: "symlink",
      });
      await expect(createSqliteIndexLifecycle().openWriter(paths)).rejects.toMatchObject({
        state: { status: "unsafe", target: "database", reason: "symlink" },
      });
      expect(await readFile(providerFile, "utf8")).toBe("provider-owned\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects hard-linked database targets without changing their source",
    async () => {
      const root = await temporaryDirectory();
      const providerFile = path.join(root, "provider-index.sqlite3");
      await writeFile(providerFile, "", { mode: 0o600 });
      const paths = indexPaths(path.join(root, "sessions"));
      await mkdir(paths.directory, { mode: 0o700 });
      await link(providerFile, paths.database);

      await expect(createSqliteIndexLifecycle().inspect(paths)).resolves.toMatchObject({
        status: "unsafe",
        target: "database",
        reason: "unexpected-type",
      });
      await expect(createSqliteIndexLifecycle().openWriter(paths)).rejects.toMatchObject({
        state: { status: "unsafe", target: "database" },
      });
      expect(await readFile(providerFile)).toEqual(Buffer.alloc(0));
    },
  );

  test("keeps neighboring provider history byte-for-byte unchanged", async () => {
    const root = await temporaryDirectory();
    const providerDirectory = path.join(root, "provider-history");
    const providerFile = path.join(providerDirectory, "session.jsonl");
    await mkdir(providerDirectory, { mode: 0o700 });
    await writeFile(providerFile, '{"provider":"owned"}\n', { mode: 0o600 });
    const before = await readFile(providerFile);
    const paths = indexPaths(path.join(root, "sessions"));

    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();

    expect(await readFile(providerFile)).toEqual(before);
    expect((await readdir(root)).sort()).toEqual(["provider-history", "sessions"]);
  });

  test("rejects relative or escaping path sets before touching disk", async () => {
    const lifecycle = createSqliteIndexLifecycle();
    const relative = indexPaths("relative-cache");
    await expect(lifecycle.inspect(relative)).rejects.toThrow(
      "SQLite index paths must be absolute",
    );

    const root = await temporaryDirectory();
    const directory = path.join(root, "sessions");
    const database = path.join(root, "outside.sqlite3");
    await expect(
      lifecycle.openWriter({
        directory,
        scratch: path.join(directory, ".scratch"),
        database,
        wal: `${database}-wal`,
        shm: `${database}-shm`,
      }),
    ).rejects.toThrow("inside the owned state directory");
    expect(await readdir(root)).toEqual([]);
  });

  test("requires a contiguous migration catalog with unique names", () => {
    expect(() =>
      createSqliteIndexLifecycle({
        migrations: [
          ...sqliteMigrations,
          {
            version: CURRENT_INDEX_SCHEMA_VERSION + 2,
            name: "gap",
            sql: "SELECT 1;",
          },
        ],
      }),
    ).toThrow("contiguous");
    expect(() =>
      createSqliteIndexLifecycle({
        migrations: [
          ...sqliteMigrations,
          {
            version: CURRENT_INDEX_SCHEMA_VERSION + 1,
            name: "bootstrap",
            sql: "SELECT 1;",
          },
        ],
      }),
    ).toThrow("unique");
  });
});

describe("FTS5 security", () => {
  test("probes FTS5 and applies per-table secure-delete safely", () => {
    expect(probeFts5Security()).toMatchObject({ fts5: true });
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE VIRTUAL TABLE searchable USING fts5(content)");
    expect(enableFts5SecureDelete(database, "searchable")).toBe(true);
    expect(() => enableFts5SecureDelete(database, 'searchable"; DROP TABLE searchable')).toThrow(
      "simple SQLite identifier",
    );
    expect(
      database.prepare("SELECT name FROM sqlite_schema WHERE name = 'searchable'").get(),
    ).toBeDefined();
    database.close();
  });

  test("reports unsupported FTS secure-delete without blocking the writer", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle({
      fts5Probe: () => ({
        fts5: true,
        secureDelete: false,
        sqliteVersion: "3.41.0",
      }),
    });

    const writer = await lifecycle.openWriter(paths);
    expect(writer.fts5SecureDelete).toBe(false);
    expect(
      writer.database
        .prepare("SELECT v FROM sessions_content_fts_config WHERE k = 'secure-delete'")
        .get(),
    ).toBeUndefined();
    await writer.close();
    await expect(lifecycle.inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      ftsSecureDelete: "unsupported",
    });
  });

  test("distinguishes unsupported FTS secure-delete from persistent-table failure", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const unsupported = {
        fts5: true,
        secureDelete: false,
        sqliteVersion: "3.41.0",
      } as const;
      const supported = { ...unsupported, secureDelete: true } as const;

      expect(configureFts5SecureDelete(database, "missing_fts_table", unsupported)).toBe(false);
      let failure: unknown;
      try {
        configureFts5SecureDelete(database, "missing_fts_table", supported);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Fts5SecureDeleteConfigurationError);
      expect((failure as Fts5SecureDeleteConfigurationError).cause).toMatchObject({
        code: "ERR_SQLITE_ERROR",
      });
    } finally {
      database.close();
    }
  });

  test("repairs a missing FTS projection before configuring secure delete", async () => {
    const paths = await fixturePaths();
    const migrations = [
      ...sqliteMigrations,
      {
        version: CURRENT_INDEX_SCHEMA_VERSION + 1,
        name: "test_remove_content_fts",
        sql: "DROP TABLE sessions_content_fts;",
      },
    ] satisfies readonly SqliteMigration[];
    const lifecycle = createSqliteIndexLifecycle({
      migrations,
      fts5Probe: () => ({
        fts5: true,
        secureDelete: true,
        sqliteVersion: "3.50.0",
      }),
    });

    const writer = await lifecycle.openWriter(paths);
    expect(writer.fts5SecureDelete).toBe(true);
    await writer.close();
    await expect(lifecycle.inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      ftsStructure: "ok",
      ftsContent: "ok",
      ftsSecureDelete: "enabled",
    });
  });

  test("treats missing FTS5 as fatal before creating persistent state", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle({
      fts5Probe() {
        throw new Fts5UnavailableError("3.0.0");
      },
    });

    await expect(lifecycle.openWriter(paths)).rejects.toBeInstanceOf(Fts5UnavailableError);
    await expect(stat(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function fixturePaths(): Promise<IndexPaths> {
  const root = await temporaryDirectory();
  return indexPaths(path.join(root, "sessions"));
}

function indexPaths(directory: string): IndexPaths {
  const database = path.join(directory, "sessions.sqlite3");
  return {
    directory,
    scratch: path.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "sessions-sqlite-"));
  temporaryDirectories.push(directory);
  return directory;
}

function openReadOnly(file: string): DatabaseSync {
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
