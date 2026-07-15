import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { forgetSession } from "../../src/application/forget-session.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { SESSION_DOCUMENT_DIGEST_SCHEME } from "../../src/domain/public-session-document.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import { createSqliteIndexMaintenance } from "../../src/infrastructure/sqlite/index-maintenance.ts";
import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import { encodeSqliteContentDigest } from "../../src/infrastructure/sqlite/sqlite-content-digest.ts";
import {
  acquireWriterLease,
  readWriterLeaseHealth,
} from "../../src/infrastructure/sqlite/writer-lease.ts";

const temporaryDirectories: string[] = [];
const LEGACY_BOOTSTRAP_CHECKSUM =
  "sha256-utf8-v1:be63645c8bcb17699fba78674153d9fa04603e0915497f6f9b6c194fdd58593c";
const now = () => new Date("2026-07-14T12:00:00.000Z");
const target: SessionIdentity = {
  source: { kind: "synthetic", instanceId: "profile-one" },
  nativeId: "target",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite session forget maintenance", () => {
  test("returns absent without initializing an empty database", async () => {
    const paths = await fixturePaths();
    await writeFile(paths.database, "", { mode: 0o600 });
    const before = await readFile(paths.database);

    await expect(
      forgetSession(paths, createSqliteIndexMaintenance({ now }), target),
    ).resolves.toMatchObject({ outcome: "absent" });

    await expect(readFile(paths.database)).resolves.toEqual(before);
    await expect(readdir(paths.directory)).resolves.toEqual(["sessions.sqlite3"]);
  });

  test("refuses an obsolete baseline without changing owned state", async () => {
    const paths = await fixturePaths();
    const database = new DatabaseSync(paths.database);
    database.exec(`CREATE TABLE sessions_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO sessions_schema_migrations (version, name, checksum, applied_at)
    VALUES (
      1,
      'bootstrap',
      '${LEGACY_BOOTSTRAP_CHECKSUM}',
      '2026-07-14T00:00:00.000Z'
    );`);
    database.close();
    await secureDatabase(paths.database);
    const before = await readFile(paths.database);
    const beforeJournalMode = readJournalMode(paths.database);

    await expect(
      forgetSession(paths, createSqliteIndexMaintenance({ now }), target),
    ).rejects.toMatchObject({ code: "corrupt-data" });

    await expect(readFile(paths.database)).resolves.toEqual(before);
    expect(readJournalMode(paths.database)).toBe(beforeJournalMode);
    await expect(readdir(paths.directory)).resolves.toEqual(["sessions.sqlite3"]);
  });

  test("redacts one retained copy while preserving aggregate and shared evidence", async () => {
    const paths = await seededCurrentPaths();
    const maintenance = createSqliteIndexMaintenance({
      now,
      token: () => "forget-owner",
    });

    await expect(forgetSession(paths, maintenance, target)).resolves.toMatchObject({
      outcome: "forgotten",
      identity: { canonicalId: "synthetic@profile-one:target" },
    });

    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(count(database, "sessions_source_instances")).toBe(1);
      expect(count(database, "sessions_session_tracking")).toBe(1);
      expect(count(database, "sessions_canonical_sessions")).toBe(1);
      expect(count(database, "sessions_entries")).toBe(1);
      expect(count(database, "sessions_content_occurrences")).toBe(1);
      expect(count(database, "sessions_content_values")).toBe(2);
      expect(count(database, "sessions_index_runs")).toBe(1);
      expect(count(database, "sessions_index_run_items")).toBe(0);
      expect(
        database
          .prepare(
            `SELECT failed_count, missing_count, omitted_item_count
             FROM sessions_index_runs`,
          )
          .get(),
      ).toEqual({
        failed_count: 1,
        missing_count: 1,
        omitted_item_count: 2,
      });
      expect(
        database
          .prepare(
            `SELECT relation.target_kind, relation.target_instance_id, relation.target_native_id
             FROM sessions_relations AS relation`,
          )
          .get(),
      ).toEqual({
        target_kind: target.source.kind,
        target_instance_id: target.source.instanceId,
        target_native_id: target.nativeId,
      });
      expect(ftsCount(database, "shared")).toBe(1);
      expect(ftsCount(database, "private")).toBe(0);
      expect(ftsCount(database, "unrelated")).toBe(1);
      expect(readWriterLeaseHealth(database, { now })).toEqual({
        status: "free",
        generation: 1,
      });
    } finally {
      database.close();
    }

    await expect(forgetSession(paths, maintenance, target)).resolves.toMatchObject({
      outcome: "absent",
    });
    const afterRetry = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(
        afterRetry.prepare("SELECT omitted_item_count FROM sessions_index_runs").get(),
      ).toEqual({ omitted_item_count: 2 });
    } finally {
      afterRetry.close();
    }
  });

  test("refuses a live writer without mutating the target", async () => {
    const paths = await seededCurrentPaths();
    const database = new DatabaseSync(paths.database);
    acquireWriterLease(database, "index", { now, token: () => "live-index-owner" });
    database.close();

    await expect(
      forgetSession(
        paths,
        createSqliteIndexMaintenance({
          now: () => new Date("2026-07-14T12:00:01.000Z"),
          token: () => "blocked-forget-owner",
        }),
        target,
      ),
    ).rejects.toMatchObject({ code: "library-busy" });

    const unchanged = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(count(unchanged, "sessions_session_tracking")).toBe(2);
      expect(count(unchanged, "sessions_index_run_items")).toBe(2);
      expect(unchanged.prepare("SELECT omitted_item_count FROM sessions_index_runs").get()).toEqual(
        { omitted_item_count: 0 },
      );
    } finally {
      unchanged.close();
    }
  });

  test("rolls back target deletion when its FTS delete trigger fails", async () => {
    const paths = await seededCurrentPaths();
    const damaged = new DatabaseSync(paths.database);
    try {
      damaged.exec(`DROP TRIGGER sessions_content_values_bd;
        CREATE TRIGGER sessions_content_values_bd
        BEFORE DELETE ON sessions_content_values
        BEGIN
          SELECT RAISE(ABORT, 'synthetic FTS delete failure');
        END;`);
    } finally {
      damaged.close();
    }

    await expect(
      forgetSession(
        paths,
        createSqliteIndexMaintenance({ now, token: () => "failing-forget-owner" }),
        target,
      ),
    ).rejects.toMatchObject({ code: "forget-failed" });

    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(count(database, "sessions_session_tracking")).toBe(2);
      expect(count(database, "sessions_index_run_items")).toBe(2);
      expect(count(database, "sessions_content_values")).toBe(3);
      expect(ftsCount(database, "private")).toBe(1);
      expect(database.prepare("SELECT omitted_item_count FROM sessions_index_runs").get()).toEqual({
        omitted_item_count: 0,
      });
    } finally {
      database.close();
    }
  });

  test("is idempotent when deletion commits before cleanup loses the lease", async () => {
    const paths = await seededCurrentPaths();
    let clockCalls = 0;
    const expiringClock = () => {
      clockCalls += 1;
      return new Date(clockCalls <= 3 ? "2026-07-14T12:00:00.000Z" : "2026-07-14T12:01:00.000Z");
    };

    await expect(
      forgetSession(
        paths,
        createSqliteIndexMaintenance({
          now: expiringClock,
          token: () => "committed-forget-owner",
        }),
        target,
      ),
    ).rejects.toMatchObject({ code: "forget-failed" });

    await expect(
      forgetSession(
        paths,
        createSqliteIndexMaintenance({
          now: () => new Date("2026-07-14T12:02:00.000Z"),
          token: () => "retry-forget-owner",
        }),
        target,
      ),
    ).resolves.toMatchObject({ outcome: "absent" });

    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(count(database, "sessions_session_tracking")).toBe(1);
      expect(database.prepare("SELECT omitted_item_count FROM sessions_index_runs").get()).toEqual({
        omitted_item_count: 2,
      });
    } finally {
      database.close();
    }
  });
});

async function seededCurrentPaths(): Promise<IndexPaths> {
  const paths = await fixturePaths();
  const database = new DatabaseSync(paths.database);
  try {
    database.exec("PRAGMA auto_vacuum = INCREMENTAL");
    applyMigrations(database);
    seedRetainedEvidence(database);
  } finally {
    database.close();
  }
  await secureDatabase(paths.database);
  return paths;
}

function seedRetainedEvidence(database: DatabaseSync): void {
  const sourceId = insertSource(database);
  const targetId = insertTracking(database, sourceId, target.nativeId);
  const retainedId = insertTracking(database, sourceId, "retained");
  database
    .prepare(
      `INSERT INTO sessions_canonical_sessions (
         session_id, lineage_coverage, document_digest_scheme, document_digest
       ) VALUES (?, 'unknown', ?, ?), (?, 'unknown', ?, ?)`,
    )
    .run(
      targetId,
      SESSION_DOCUMENT_DIGEST_SCHEME,
      new Uint8Array(32),
      retainedId,
      SESSION_DOCUMENT_DIGEST_SCHEME,
      new Uint8Array(32),
    );
  insertEntry(database, targetId, "memory://target");
  insertEntry(database, retainedId, "memory://retained");

  const sharedId = insertContent(database, "a".repeat(64), "shared evidence");
  const privateId = insertContent(database, "b".repeat(64), "private target evidence");
  insertContent(database, "c".repeat(64), "unrelated orphan evidence");
  insertOccurrence(database, targetId, 0, sharedId);
  insertOccurrence(database, targetId, 1, privateId);
  insertOccurrence(database, retainedId, 0, sharedId);

  database
    .prepare(
      `INSERT INTO sessions_relations (
         session_id, ordinal, kind, target_kind, target_instance_id,
         target_native_id, confidence
       ) VALUES (?, 0, 'continuation', ?, ?, 'retained', 'high')`,
    )
    .run(targetId, target.source.kind, target.source.instanceId);
  database
    .prepare(
      `INSERT INTO sessions_relations (
         session_id, ordinal, kind, target_kind, target_instance_id,
         target_native_id, confidence
       ) VALUES (?, 0, 'parent', ?, ?, ?, 'high')`,
    )
    .run(retainedId, target.source.kind, target.source.instanceId, target.nativeId);

  const run = database
    .prepare(
      `INSERT INTO sessions_index_runs (
         source_instance_id, status, started_at, finished_at,
         discovered_count, failed_count, missing_count
       ) VALUES (
         ?, 'completed', '2026-07-14T10:00:00.000Z', '2026-07-14T10:01:00.000Z',
         1, 1, 1
       )`,
    )
    .run(sourceId).lastInsertRowid;
  database
    .prepare(
      `INSERT INTO sessions_index_run_items (
         run_id, ordinal, session_id, outcome, failure_code
       ) VALUES
         (?, 0, ?, 'failed', 'malformed'),
         (?, 1, ?, 'missing', NULL)`,
    )
    .run(run, targetId, run, targetId);
}

function insertSource(database: DatabaseSync): number | bigint {
  return database
    .prepare("INSERT INTO sessions_source_instances (kind, instance_id) VALUES (?, ?)")
    .run(target.source.kind, target.source.instanceId).lastInsertRowid;
}

function insertTracking(
  database: DatabaseSync,
  sourceId: number | bigint,
  nativeId: string,
): number | bigint {
  return database
    .prepare(
      `INSERT INTO sessions_session_tracking (
         source_instance_id,
         native_id,
         last_good_fingerprint_scheme,
         last_good_fingerprint_digest,
         last_good_adapter_version,
         latest_fingerprint_scheme,
         latest_fingerprint_digest,
         latest_adapter_version,
         latest_outcome
       ) VALUES (?, ?, 'synthetic-v1', 'good', 'adapter-v1',
                 'synthetic-v1', 'good', 'adapter-v1', 'indexed')`,
    )
    .run(sourceId, nativeId).lastInsertRowid;
}

function insertEntry(database: DatabaseSync, sessionId: number | bigint, uri: string): void {
  database
    .prepare(
      `INSERT INTO sessions_entries (
         session_id, ordinal, kind, actor, source_locator_uri
       ) VALUES (?, 0, 'message', 'human', ?)`,
    )
    .run(sessionId, uri);
}

function insertContent(database: DatabaseSync, digest: string, text: string): number | bigint {
  const row = database
    .prepare(
      `INSERT INTO sessions_content_values (digest, text)
       VALUES (?, ?)
       RETURNING content_id`,
    )
    .get(encodeSqliteContentDigest(digest), text) as {
    readonly content_id: number | bigint;
  };
  return row.content_id;
}

function insertOccurrence(
  database: DatabaseSync,
  sessionId: number | bigint,
  segmentOrdinal: number,
  contentId: number | bigint,
): void {
  database
    .prepare(
      `INSERT INTO sessions_content_occurrences (
         session_id, entry_ordinal, segment_ordinal, content_id,
         origin, confidence, source_metadata_json
       ) VALUES (?, 0, ?, ?, 'human', 'high', '{}')`,
    )
    .run(sessionId, segmentOrdinal, contentId);
}

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-forget-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "sessions");
  await mkdir(directory, { mode: 0o700 });
  const database = path.join(directory, "sessions.sqlite3");
  return {
    directory,
    scratch: path.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}

async function secureDatabase(file: string): Promise<void> {
  if (process.platform !== "win32") await chmod(file, 0o600);
}

function count(database: DatabaseSync, table: string): number {
  if (!/^sessions_[a-z_]+$/u.test(table)) throw new TypeError("Unsafe table name");
  const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
    readonly count: number | bigint;
  };
  return Number(row.count);
}

function ftsCount(database: DatabaseSync, query: string): number {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sessions_content_fts
       WHERE sessions_content_fts MATCH ?`,
    )
    .get(query) as { readonly count: number | bigint };
  return Number(row.count);
}

function readJournalMode(file: string): unknown {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return Object.values(database.prepare("PRAGMA journal_mode").get() ?? {})[0];
  } finally {
    database.close();
  }
}
