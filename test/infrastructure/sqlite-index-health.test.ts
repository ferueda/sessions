import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { SessionIndexFailureCode } from "../../src/application/ports/session-index.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import {
  digestPublicSessionDocument,
  projectPublicSessionDocument,
  SESSION_DOCUMENT_DIGEST_SCHEME,
} from "../../src/domain/public-session-document.ts";
import type { SessionDocument, SessionIdentity } from "../../src/domain/session.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import { encodeSqliteContentDigest } from "../../src/infrastructure/sqlite/sqlite-content-digest.ts";
import { acquireWriterLease } from "../../src/infrastructure/sqlite/writer-lease.ts";

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
      captureScope: {
        status: "incomplete",
        trackedSessions: 0,
        retainedSessions: { current: 0, stale: 0 },
        unindexedSessions: 0,
        sourceState: { present: 0, missing: 0, unknown: 0 },
        sourceCoverage: { complete: 0, unknown: 0 },
        latestFailures: {
          unavailable: 0,
          unreadable: 0,
          malformed: 0,
          sourceChanged: 0,
          unsupportedFormat: 0,
          repositoryWrite: 0,
        },
        appliedFilters: [],
        unassessedFilters: [],
      },
      canonicalIntegrity: "ok",
      foreignKeys: "ok",
      contentReachability: "ok",
      orphanContentRows: "0",
      orphanContentBytes: "0",
      ftsStructure: "ok",
      ftsContent: "ok",
      ftsSecureDelete: "enabled",
      ftsRemediation: "not-needed",
      pageReclamation: "incremental",
      runRecords: "ok",
      writerLease: "free",
      activeRuns: 0,
      interruptedRuns: 0,
    });

    expect(await persistenceSnapshot(paths)).toEqual(before);
  });

  test("reports exact orphan rows and UTF-8 bytes without exposing or mutating content", async () => {
    const paths = await initializedPaths();
    const text = "generic orphan café";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      database
        .prepare(
          `INSERT INTO sessions_content_values (digest, text)
           VALUES (?, ?)`,
        )
        .run(encodeSqliteContentDigest(contentHash.digest), text);
    });
    const before = await persistenceSnapshot(paths);

    const health = await createSqliteIndexLifecycle().inspectHealth(paths);

    expect(health).toMatchObject({
      ok: false,
      canonicalIntegrity: "ok",
      foreignKeys: "ok",
      contentReachability: "orphaned",
      orphanContentRows: "1",
      orphanContentBytes: String(Buffer.byteLength(text, "utf8")),
      ftsStructure: "ok",
      ftsContent: "ok",
      ftsRemediation: "not-needed",
    });
    const serialized = JSON.stringify(health);
    expect(serialized).not.toContain(text);
    expect(serialized).not.toContain(contentHash.digest);
    expect(serialized).not.toContain(paths.database);
    expect(await persistenceSnapshot(paths)).toEqual(before);
  });

  test("reports unavailable reachability aggregates instead of manufacturing zero", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      database.exec("DROP TABLE sessions_content_occurrences");
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      contentReachability: "inspection-failed",
      orphanContentRows: "unknown",
      orphanContentBytes: "unknown",
    });
  });

  test("reports repair ownership without exposing its token", async () => {
    const paths = await initializedPaths();
    const now = () => new Date("2026-07-14T12:00:00.000Z");
    mutateDatabase(paths.database, (database) => {
      acquireWriterLease(database, "repair", { now, token: () => "private-repair-token" });
    });

    const health = await createSqliteIndexLifecycle({ now }).inspectHealth(paths);

    expect(health).toMatchObject({ ok: true, writerLease: "repair-live" });
    expect(JSON.stringify(health)).not.toContain("private-repair-token");
  });

  test("reports a recognized wrong page mode as typed unhealthy state without mutation", async () => {
    const paths = await currentSchemaPathsWithoutIncrementalReclamation();
    const before = await persistenceSnapshot(paths);

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      canonicalIntegrity: "ok",
      foreignKeys: "ok",
      ftsStructure: "ok",
      ftsContent: "ok",
      pageReclamation: "invalid",
      writerLease: "free",
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

  test("accepts a valid first-seen failure without a canonical document", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      seedValidTrackingOnly(database);
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      canonicalIntegrity: "ok",
      captureScope: {
        status: "incomplete",
        trackedSessions: 1,
        retainedSessions: { current: 0, stale: 0 },
        unindexedSessions: 1,
        sourceState: { present: 0, missing: 0, unknown: 1 },
        sourceCoverage: { complete: 0, unknown: 1 },
        latestFailures: { unreadable: 1 },
        appliedFilters: [],
        unassessedFilters: [],
      },
      ftsStructure: "ok",
      ftsContent: "ok",
    });
  });

  test("accepts and reports a missing first-seen failure without canonical data", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      const fixture = seedValidTrackingOnly(database);
      const observedAt = "2026-07-14T12:00:00.000Z";
      database
        .prepare(
          `UPDATE sessions_source_instances
           SET coverage_status = 'complete', coverage_observed_at = ?
           WHERE source_instance_id = ?`,
        )
        .run(observedAt, fixture.sourceInstanceId);
      database
        .prepare(
          `UPDATE sessions_session_tracking
           SET presence_status = 'missing', presence_observed_at = ?
           WHERE session_id = ?`,
        )
        .run(observedAt, fixture.sessionId);
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      canonicalIntegrity: "ok",
      captureScope: {
        status: "incomplete",
        trackedSessions: 1,
        retainedSessions: { current: 0, stale: 0 },
        unindexedSessions: 1,
        sourceState: { present: 0, missing: 1, unknown: 0 },
        sourceCoverage: { complete: 1, unknown: 0 },
        latestFailures: { unreadable: 1 },
      },
    });
  });

  test("reports exact global capture partitions and failure counts without identities", async () => {
    const paths = await initializedPaths();
    const privateMarker = "private-capture-scope-marker";
    mutateDatabase(paths.database, (database) => {
      const failures = [
        "unavailable",
        "unreadable",
        "malformed",
        "source-changed",
        "unsupported-format",
        "repository-write",
      ] as const;
      for (const failure of failures) {
        const fixture = seedValidTrackingOnly(database, {
          instanceId: `${privateMarker}-${failure}`,
          failure,
        });
        markSourceCoverageComplete(database, fixture);
        if (failure === "unavailable") attachEmptyCanonical(database, fixture, "stale");
        if (failure === "repository-write") markTrackingMissing(database, fixture);
      }
      const current = seedValidTrackingOnly(database, {
        instanceId: `${privateMarker}-current`,
      });
      markSourceCoverageComplete(database, current);
      attachEmptyCanonical(database, current, "current");
    });

    const health = await createSqliteIndexLifecycle().inspectHealth(paths);

    expect(health).toMatchObject({
      ok: true,
      canonicalIntegrity: "ok",
      captureScope: {
        status: "incomplete",
        trackedSessions: 7,
        retainedSessions: { current: 1, stale: 1 },
        unindexedSessions: 5,
        sourceState: { present: 6, missing: 1, unknown: 0 },
        sourceCoverage: { complete: 7, unknown: 0 },
        latestFailures: {
          unavailable: 1,
          unreadable: 1,
          malformed: 1,
          sourceChanged: 1,
          unsupportedFormat: 1,
          repositoryWrite: 1,
        },
        appliedFilters: [],
        unassessedFilters: [],
      },
    });
    expect(JSON.stringify(health.captureScope)).not.toContain(privateMarker);
  });

  test("validates source instances even when they have no tracking rows", async () => {
    expect.hasAssertions();
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      database
        .prepare(
          `INSERT INTO sessions_source_instances (kind, instance_id)
           VALUES ('Invalid-Kind', 'source-only')`,
        )
        .run();
    });

    await expectCanonicalIntegrityFailure(paths);
  });

  test("rejects complete source coverage without an observation timestamp", async () => {
    expect.hasAssertions();
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      database
        .prepare(
          `INSERT INTO sessions_source_instances (
             kind, instance_id, coverage_status, coverage_observed_at
           ) VALUES ('synthetic', 'complete-without-observation', 'complete', NULL)`,
        )
        .run();
    });

    await expectCanonicalIntegrityFailure(paths);
  });

  test("detects corrupt revisions on tracking-only failed identities", async () => {
    expect.hasAssertions();
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      const fixture = seedValidTrackingOnly(database);
      database
        .prepare(
          `UPDATE sessions_session_tracking
           SET latest_fingerprint_digest = 'invalid'
           WHERE session_id = ?`,
        )
        .run(fixture.sessionId);
    });

    await expectCanonicalIntegrityFailure(paths);
  });

  test("detects tracking state that claims an indexed revision without a document", async () => {
    expect.hasAssertions();
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      const fixture = seedValidTrackingOnly(database);
      database
        .prepare(
          `UPDATE sessions_session_tracking
           SET last_good_fingerprint_scheme = latest_fingerprint_scheme,
               last_good_fingerprint_digest = latest_fingerprint_digest,
               last_good_adapter_version = latest_adapter_version,
               latest_outcome = 'indexed',
               latest_failure_code = NULL
           WHERE session_id = ?`,
        )
        .run(fixture.sessionId);
    });

    await expectCanonicalIntegrityFailure(paths);
  });

  test("classifies a document digest mismatch as canonical rather than FTS damage", async () => {
    expect.hasAssertions();
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      seedValidEmptyCanonicalSession(database);
      database
        .prepare("UPDATE sessions_canonical_sessions SET document_digest = zeroblob(32)")
        .run();
    });

    await expectCanonicalIntegrityFailure(paths);
  });

  test.each([
    "coverage_observed_at",
    "presence_observed_at",
    "captured_at",
    "last_seen_at",
  ] as const)("detects a non-canonical %s timestamp", async (column) => {
    expect.hasAssertions();
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      const fixture = seedValidTrackingOnly(database);
      corruptObservationTimestamp(database, fixture, column);
    });

    await expectCanonicalIntegrityFailure(paths);
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
          `INSERT INTO sessions_content_values (digest, text)
           VALUES (?, ?)
           RETURNING content_id`,
        )
        .get(encodeSqliteContentDigest(contentHash.digest), text) as {
        readonly content_id: number | bigint;
      };
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(inserted.content_id, text);
    });

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      ftsContent: "failed",
    });
  });

  test("detects semantic FTS damage without mutating the immutable library", async () => {
    const paths = await initializedPaths();
    const canonical = "alpha beta gamma";
    const contentHash = hashContent(canonical);
    mutateDatabase(paths.database, (database) => {
      const inserted = database
        .prepare(
          `INSERT INTO sessions_content_values (digest, text)
           VALUES (?, ?)
           RETURNING content_id`,
        )
        .get(encodeSqliteContentDigest(contentHash.digest), canonical) as {
        readonly content_id: number | bigint;
      };
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(inserted.content_id, canonical);
      database
        .prepare("INSERT INTO sessions_content_fts (rowid, text) VALUES (?, ?)")
        .run(inserted.content_id, "alpha gamma beta");
    });
    const before = await persistenceSnapshot(paths);

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      ftsStructure: "ok",
      ftsContent: "failed",
      ftsRemediation: "rebuild-required",
    });
    expect(await persistenceSnapshot(paths)).toEqual(before);
  });

  test("detects a referenced malformed stored digest", async () => {
    expect.hasAssertions();
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      const fixture = seedValidTrackingOnly(database);
      database
        .prepare(
          `UPDATE sessions_session_tracking
           SET last_good_fingerprint_scheme = latest_fingerprint_scheme,
               last_good_fingerprint_digest = latest_fingerprint_digest,
               last_good_adapter_version = latest_adapter_version,
               latest_outcome = 'indexed',
               latest_failure_code = NULL
           WHERE session_id = ?`,
        )
        .run(fixture.sessionId);
      database
        .prepare(
          `INSERT INTO sessions_canonical_sessions (
             session_id, lineage_coverage, document_digest_scheme, document_digest
           ) VALUES (?, 'unknown', ?, ?)`,
        )
        .run(fixture.sessionId, SESSION_DOCUMENT_DIGEST_SCHEME, new Uint8Array(32));
      database
        .prepare(
          `INSERT INTO sessions_entries (
             session_id, ordinal, kind, actor, source_locator_uri
           ) VALUES (?, 0, 'message', 'human', 'memory://mismatched-digest')`,
        )
        .run(fixture.sessionId);
      database.exec("PRAGMA ignore_check_constraints = ON");
      const inserted = database
        .prepare(
          `INSERT INTO sessions_content_values (digest, text)
           VALUES (?, 'canonical text')
           RETURNING content_id`,
        )
        .get(new Uint8Array(31)) as {
        readonly content_id: number | bigint;
      };
      database
        .prepare(
          `INSERT INTO sessions_content_occurrences (
             session_id, entry_ordinal, segment_ordinal, content_id,
             origin, confidence, source_metadata_json
           ) VALUES (?, 0, 0, ?, 'human', 'high', '{}')`,
        )
        .run(fixture.sessionId, inserted.content_id);
    });

    await expectCanonicalIntegrityFailure(paths);
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
  const database = path.join(directory, "sessions.sqlite3");
  const paths: IndexPaths = {
    directory,
    scratch: path.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
  const writer = await lifecycle.openWriter(paths);
  await writer.close();
  return paths;
}

async function currentSchemaPathsWithoutIncrementalReclamation(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-health-invalid-mode-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "sessions");
  await mkdir(directory, { mode: 0o700 });
  const databaseFile = path.join(directory, "sessions.sqlite3");
  const database = new DatabaseSync(databaseFile);
  try {
    applyMigrations(database);
  } finally {
    database.close();
  }
  await chmod(databaseFile, 0o600);
  return {
    directory,
    scratch: path.join(directory, ".scratch"),
    database: databaseFile,
    wal: `${databaseFile}-wal`,
    shm: `${databaseFile}-shm`,
  };
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

interface TrackingOnlyFixture {
  readonly sessionId: number | bigint;
  readonly sourceInstanceId: number | bigint;
  readonly identity: SessionIdentity;
}

function seedValidTrackingOnly(
  database: DatabaseSync,
  options: {
    readonly instanceId?: string;
    readonly nativeId?: string;
    readonly failure?: SessionIndexFailureCode;
  } = {},
): TrackingOnlyFixture {
  const instanceId = options.instanceId ?? "tracking-only";
  const nativeId = options.nativeId ?? "failed-session";
  const failure = options.failure ?? "unreadable";
  const source = database
    .prepare(
      `INSERT INTO sessions_source_instances (kind, instance_id)
       VALUES ('synthetic', ?)`,
    )
    .run(instanceId);
  const tracking = database
    .prepare(
      `INSERT INTO sessions_session_tracking (
         source_instance_id,
         native_id,
         latest_fingerprint_scheme,
         latest_fingerprint_digest,
         latest_adapter_version,
         latest_outcome,
         latest_failure_code
       ) VALUES (?, ?, 'sha256-json-v1', ?, 'fixture-v1', 'failed', ?)`,
    )
    .run(source.lastInsertRowid, nativeId, "a".repeat(64), failure);
  return {
    sourceInstanceId: source.lastInsertRowid,
    sessionId: tracking.lastInsertRowid,
    identity: { source: { kind: "synthetic", instanceId }, nativeId },
  };
}

function seedValidEmptyCanonicalSession(database: DatabaseSync): void {
  const fixture = seedValidTrackingOnly(database);
  markSourceCoverageComplete(database, fixture);
  attachEmptyCanonical(database, fixture, "current");
}

function markSourceCoverageComplete(database: DatabaseSync, fixture: TrackingOnlyFixture): void {
  const observedAt = "2026-07-14T12:00:00.000Z";
  database
    .prepare(
      `UPDATE sessions_source_instances
       SET coverage_status = 'complete', coverage_observed_at = ?
       WHERE source_instance_id = ?`,
    )
    .run(observedAt, fixture.sourceInstanceId);
}

function markTrackingMissing(database: DatabaseSync, fixture: TrackingOnlyFixture): void {
  database
    .prepare(
      `UPDATE sessions_session_tracking
       SET presence_status = 'missing', presence_observed_at = ?
       WHERE session_id = ?`,
    )
    .run("2026-07-14T12:00:00.000Z", fixture.sessionId);
}

function attachEmptyCanonical(
  database: DatabaseSync,
  fixture: TrackingOnlyFixture,
  freshness: "current" | "stale",
): void {
  const observedAt = "2026-07-14T12:00:00.000Z";
  const document: SessionDocument = {
    identity: fixture.identity,
    lineageCoverage: "unknown",
    relations: [],
    entries: [],
  };
  const digest = digestPublicSessionDocument(projectPublicSessionDocument(document));
  database
    .prepare(
      `UPDATE sessions_session_tracking
       SET last_good_fingerprint_scheme = latest_fingerprint_scheme,
           last_good_fingerprint_digest = latest_fingerprint_digest,
           last_good_adapter_version = latest_adapter_version,
           presence_observed_at = ?,
           captured_at = ?,
           last_seen_at = ?,
           latest_outcome = CASE WHEN ? = 'current' THEN 'indexed' ELSE latest_outcome END,
           latest_failure_code = CASE WHEN ? = 'current' THEN NULL ELSE latest_failure_code END
       WHERE session_id = ?`,
    )
    .run(observedAt, observedAt, observedAt, freshness, freshness, fixture.sessionId);
  const stored = Buffer.from(digest.digest, "hex");
  database
    .prepare(
      `INSERT INTO sessions_canonical_sessions (
         session_id, lineage_coverage, document_digest_scheme, document_digest
       ) VALUES (?, 'unknown', ?, ?)`,
    )
    .run(fixture.sessionId, digest.scheme, stored);
}

function corruptObservationTimestamp(
  database: DatabaseSync,
  fixture: TrackingOnlyFixture,
  column: "coverage_observed_at" | "presence_observed_at" | "captured_at" | "last_seen_at",
): void {
  const invalidTimestamp = "2026-7-14T12:00:00Z";
  if (column === "coverage_observed_at") {
    database
      .prepare(
        `UPDATE sessions_source_instances
         SET coverage_observed_at = ?
         WHERE source_instance_id = ?`,
      )
      .run(invalidTimestamp, fixture.sourceInstanceId);
    return;
  }
  const sql = {
    presence_observed_at: `UPDATE sessions_session_tracking
                           SET presence_observed_at = ?
                           WHERE session_id = ?`,
    captured_at: `UPDATE sessions_session_tracking
                  SET captured_at = ?
                  WHERE session_id = ?`,
    last_seen_at: `UPDATE sessions_session_tracking
                   SET last_seen_at = ?
                   WHERE session_id = ?`,
  }[column];
  database.prepare(sql).run(invalidTimestamp, fixture.sessionId);
}

async function expectCanonicalIntegrityFailure(paths: IndexPaths): Promise<void> {
  await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
    ok: false,
    captureScope: { status: "inspection-failed" },
    canonicalIntegrity: "failed",
    foreignKeys: "ok",
    ftsStructure: "ok",
    ftsContent: "ok",
    ftsRemediation: "not-needed",
  });
}
