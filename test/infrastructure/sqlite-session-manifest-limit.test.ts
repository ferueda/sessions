import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { SessionQueryOperationalError } from "../../src/application/session-query-error.ts";
import {
  createSessionManifestQuery,
  MAX_SESSION_MANIFEST_REVISIONS,
} from "../../src/domain/session-manifest.ts";
import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import { createSqliteSessionQuery } from "../../src/infrastructure/sqlite/sqlite-session-query.ts";

describe("SQLite session manifest boundary", () => {
  test("returns exactly 10,000 metadata revisions and rejects 10,001 as one whole call", async () => {
    const database = migratedDatabase();
    try {
      seedMetadataSessions(database, MAX_SESSION_MANIFEST_REVISIONS);
      const repository = createSqliteSessionQuery(database);

      const exact = await repository.manifest(createSessionManifestQuery());
      expect(exact.revisions).toHaveLength(MAX_SESSION_MANIFEST_REVISIONS);
      expect(exact.revisions[0]?.session.nativeId).toBe("manifest-00000");
      expect(exact.revisions.at(-1)?.session.nativeId).toBe("manifest-09999");
      expect(
        exact.revisions.every(({ counts }) => Object.values(counts).every((n) => n === 0)),
      ).toBe(true);

      seedMetadataSessions(database, 1, MAX_SESSION_MANIFEST_REVISIONS + 1);
      const failure = await repository
        .manifest(createSessionManifestQuery())
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionQueryOperationalError);
      expect(failure).toMatchObject({ code: "manifest-too-large" });
      expect((failure as Error).message).toBe(
        "Session manifest matches more than 10,000 revisions; narrow the selection",
      );
      expect((failure as Error).message).not.toContain("manifest-10000");
    } finally {
      database.close();
    }
  });
});

function seedMetadataSessions(database: DatabaseSync, count: number, firstSessionId = 1): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT OR IGNORE INTO sessions_source_instances (
           source_instance_id,
           kind,
           instance_id,
           coverage_status,
           coverage_observed_at
         ) VALUES (1, 'synthetic-manifest', 'metadata-limit', 'complete', ?)`,
      )
      .run("2026-07-21T12:00:00.000Z");
    const tracking = database.prepare(
      `INSERT INTO sessions_session_tracking (
         session_id,
         source_instance_id,
         native_id,
         last_good_fingerprint_scheme,
         last_good_fingerprint_digest,
         last_good_adapter_version,
         latest_fingerprint_scheme,
         latest_fingerprint_digest,
         latest_adapter_version,
         latest_outcome,
         presence_status,
         presence_observed_at,
         captured_at,
         last_seen_at
       ) VALUES (?, 1, ?, 'sha256-json-v1', ?, 'synthetic-v1',
                 'sha256-json-v1', ?, 'synthetic-v1', 'indexed', 'present', ?, ?, ?)`,
    );
    const canonical = database.prepare(
      `INSERT INTO sessions_canonical_sessions (
         session_id,
         lineage_coverage,
         document_digest_scheme,
         document_digest
       ) VALUES (?, 'complete', 'sha256-sessions-document-jcs-v1', ?)`,
    );
    const metrics = database.prepare(
      `INSERT INTO sessions_canonical_document_metrics (
         session_id,
         relation_count,
         entry_count,
         segment_count,
         omitted_segment_count,
         text_utf8_bytes
       ) VALUES (?, 0, 0, 0, 0, 0)`,
    );
    const timestamp = "2026-07-21T12:00:00.000Z";
    const digest = Buffer.alloc(32);
    for (let offset = 0; offset < count; offset += 1) {
      const sessionId = firstSessionId + offset;
      const nativeId = `manifest-${String(sessionId - 1).padStart(5, "0")}`;
      const fingerprint = sessionId.toString(16).padStart(64, "0");
      tracking.run(sessionId, nativeId, fingerprint, fingerprint, timestamp, timestamp, timestamp);
      canonical.run(sessionId, digest);
      metrics.run(sessionId);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  applyMigrations(database);
  return database;
}
