import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  applyMigrations,
  readMigrationHistory,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { encodeSqliteContentDigest } from "../../src/infrastructure/sqlite/sqlite-content-digest.ts";

const DIGEST = "a".repeat(64);

describe("canonical SQLite baseline", () => {
  test("bootstraps the complete current schema in one migration", () => {
    const database = openDatabase();
    try {
      const history = applyMigrations(database);

      expect(history).toMatchObject({ currentVersion: 1, pending: [] });
      expect(history.applied.map(({ version, name }) => ({ version, name }))).toEqual([
        { version: 1, name: "bootstrap" },
      ]);
      expect(readMigrationHistory(database).currentVersion).toBe(1);
      expect(strictApplicationTables(database)).toEqual([
        "sessions_canonical_sessions",
        "sessions_content_occurrences",
        "sessions_content_values",
        "sessions_entries",
        "sessions_index_run_items",
        "sessions_index_runs",
        "sessions_library",
        "sessions_relations",
        "sessions_schema_migrations",
        "sessions_session_tracking",
        "sessions_source_instances",
        "sessions_writer_lease",
      ]);
      expect(tableColumns(database, "sessions_source_instances")).toEqual(
        expect.arrayContaining(["coverage_status", "coverage_observed_at"]),
      );
      expect(tableColumns(database, "sessions_entries")).toEqual(
        expect.arrayContaining(["tool_name", "tool_namespace"]),
      );
      expect(tableColumns(database, "sessions_canonical_sessions")).toContain("lineage_coverage");
      expect(tableColumns(database, "sessions_content_values")).toEqual([
        "content_id",
        "digest",
        "text",
      ]);
      expect(
        database
          .prepare(
            `SELECT name, "unique" AS is_unique
             FROM pragma_index_list('sessions_content_values')
             ORDER BY name`,
          )
          .all(),
      ).toEqual([{ name: "sessions_content_values_digest_idx", is_unique: 0 }]);
      expect(
        database
          .prepare(
            `SELECT name
             FROM pragma_index_xinfo('sessions_content_values_digest_idx')
             WHERE key = 1
             ORDER BY seqno`,
          )
          .all(),
      ).toEqual([{ name: "digest" }]);
      expect(
        database
          .prepare(
            `SELECT name
             FROM sqlite_schema
             WHERE type = 'trigger'
               AND name = 'sessions_content_values_duplicate_guard'`,
          )
          .get(),
      ).toEqual({ name: "sessions_content_values_duplicate_guard" });
      expect(database.prepare("SELECT instance_id FROM sessions_library").get()).toEqual({
        instance_id: expect.stringMatching(/^[a-f0-9]{32}$/u),
      });
      expect(tableColumns(database, "sessions_index_runs")).toContain("missing_count");
      expect(tableColumns(database, "sessions_index_runs")).not.toContain("removed_count");
      expect(
        database
          .prepare(
            `SELECT partial
             FROM pragma_index_list('sessions_content_occurrences')
             WHERE name = 'sessions_content_occurrences_content_idx'`,
          )
          .get(),
      ).toEqual({ partial: 1 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("keeps collision tuples distinct and synchronizes immutable external-content FTS", () => {
    const database = migratedDatabase();
    try {
      const alphaId = insertContent(database, DIGEST, "collision alpha");
      const betaId = insertContent(database, DIGEST, "collision beta");

      expect(alphaId).not.toBe(betaId);
      expect(
        database
          .prepare(
            `SELECT content_id, text
             FROM sessions_content_values
             WHERE digest = ?
             ORDER BY content_id`,
          )
          .all(encodeSqliteContentDigest(DIGEST)),
      ).toEqual([
        { content_id: alphaId, text: "collision alpha" },
        { content_id: betaId, text: "collision beta" },
      ]);
      expect(() => insertContent(database, DIGEST, "collision alpha")).toThrow(
        /duplicate sessions content value/u,
      );
      expect(ftsMatches(database, "alpha")).toEqual([alphaId]);
      expect(ftsMatches(database, "beta")).toEqual([betaId]);

      expect(() =>
        database
          .prepare("UPDATE sessions_content_values SET text = ? WHERE content_id = ?")
          .run("changed", alphaId),
      ).toThrow(/sessions content values are immutable/u);

      database.prepare("DELETE FROM sessions_content_values WHERE content_id = ?").run(alphaId);
      expect(ftsMatches(database, "alpha")).toEqual([]);
      expect(ftsMatches(database, "beta")).toEqual([betaId]);
      expectFtsIntegrity(database);
    } finally {
      database.close();
    }
  });

  test("supports absent relation targets, deferred entry references, and canonical cascades", () => {
    const database = migratedDatabase();
    try {
      const { sessionId } = insertTrackedSession(database);
      database
        .prepare(
          `INSERT INTO sessions_relations (
             session_id,
             ordinal,
             kind,
             target_kind,
             target_instance_id,
             target_native_id,
             confidence
           ) VALUES (?, 0, 'parent', 'future-source', 'other-profile', 'missing-session', 'low')`,
        )
        .run(sessionId);

      database.exec("BEGIN");
      database
        .prepare(
          `INSERT INTO sessions_entries (
             session_id,
             ordinal,
             kind,
             actor,
             related_entry_ordinal,
             source_locator_uri
           ) VALUES (?, 0, 'message', 'human', 1, 'memory://entry/0')`,
        )
        .run(sessionId);
      database
        .prepare(
          `INSERT INTO sessions_entries (
             session_id,
             ordinal,
             kind,
             actor,
             related_entry_ordinal,
             source_locator_uri
           ) VALUES (?, 1, 'message', 'model', 0, 'memory://entry/1')`,
        )
        .run(sessionId);
      database.exec("COMMIT");

      const contentId = insertContent(database, DIGEST, "cascade proof");
      database
        .prepare(
          `INSERT INTO sessions_content_occurrences (
             session_id,
             entry_ordinal,
             segment_ordinal,
             content_id,
             origin,
             confidence,
             source_metadata_json
           ) VALUES (?, 0, 0, ?, 'human', 'high', '{"fixture":"synthetic"}')`,
        )
        .run(sessionId, contentId);

      expect(() =>
        database.prepare("DELETE FROM sessions_content_values WHERE content_id = ?").run(contentId),
      ).toThrow(/FOREIGN KEY constraint failed/u);
      expect(ftsMatches(database, "cascade")).toEqual([contentId]);

      database
        .prepare("DELETE FROM sessions_canonical_sessions WHERE session_id = ?")
        .run(sessionId);
      expect(rowCount(database, "sessions_relations")).toBe(0);
      expect(rowCount(database, "sessions_entries")).toBe(0);
      expect(rowCount(database, "sessions_content_occurrences")).toBe(0);
      expect(rowCount(database, "sessions_session_tracking")).toBe(1);

      database.prepare("DELETE FROM sessions_content_values WHERE content_id = ?").run(contentId);
      expect(ftsMatches(database, "cascade")).toEqual([]);
      expectFtsIntegrity(database);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("enforces tool ownership and strict content variants at the baseline", () => {
    const database = migratedDatabase();
    try {
      const { sessionId } = insertTrackedSession(database);
      const insertEntry = database.prepare(
        `INSERT INTO sessions_entries (
           session_id, ordinal, kind, actor, tool_name, tool_namespace, source_locator_uri
         ) VALUES (?, 0, ?, 'tool', ?, ?, 'memory://entry/0')`,
      );

      expect(() => insertEntry.run(sessionId, "message", "read", null)).toThrow(
        /CHECK constraint failed/u,
      );
      expect(() => insertEntry.run(sessionId, "tool-call", null, "filesystem")).toThrow(
        /CHECK constraint failed/u,
      );
      expect(() => insertEntry.run(sessionId, "tool-call", "read", "filesystem")).not.toThrow();

      const contentId = insertContent(database, DIGEST, "strict variant proof");
      const insertOccurrence = database.prepare(
        `INSERT INTO sessions_content_occurrences (
           session_id, entry_ordinal, segment_ordinal, content_id,
           content_class, source_type, origin, confidence, source_metadata_json
         ) VALUES (?, 0, ?, ?, ?, ?, 'tool', 'high', '{}')`,
      );
      insertOccurrence.run(sessionId, 0, contentId, null, null);
      insertOccurrence.run(sessionId, 1, null, "structured", "tool-output");

      for (const invalid of [
        "",
        "-leading",
        "trailing-",
        "double--dash",
        "Upper",
        "under_score",
        "nul\0byte",
        "évidence",
        "a".repeat(65),
      ]) {
        expect(() => insertOccurrence.run(sessionId, 2, null, "unknown", invalid)).toThrow(
          /CHECK constraint failed/u,
        );
      }
      expect(() =>
        insertOccurrence.run(sessionId, 2, contentId, "structured", "tool-output"),
      ).toThrow(/CHECK constraint failed/u);
      expect(() => insertOccurrence.run(sessionId, 2, null, null, null)).toThrow(
        /CHECK constraint failed/u,
      );

      expect(() =>
        insertOccurrence.run(sessionId, 2, null, "unknown", "a".repeat(64)),
      ).not.toThrow();

      const insertStoredContent = database.prepare(
        `INSERT INTO sessions_content_values (digest, text)
         VALUES (?, ?)`,
      );
      expect(() => insertStoredContent.run(DIGEST, "text digest rejected")).toThrow(
        /cannot store TEXT value in BLOB column/u,
      );
      expect(() => insertStoredContent.run(new Uint8Array(31), "short digest rejected")).toThrow(
        /CHECK constraint failed/u,
      );
      expect(() => insertStoredContent.run(new Uint8Array(33), "long digest rejected")).toThrow(
        /CHECK constraint failed/u,
      );
    } finally {
      database.close();
    }
  });

  test("enforces current revisions, run-item outcomes, and the diagnostic-item cap", () => {
    const database = migratedDatabase();
    try {
      const sourceInstanceId = insertSourceInstance(database, "run-profile");
      const failedSessionId = Number(
        database
          .prepare(
            `INSERT INTO sessions_session_tracking (
               source_instance_id,
               native_id,
               latest_fingerprint_scheme,
               latest_fingerprint_digest,
               latest_adapter_version,
               latest_outcome,
               latest_failure_code
             ) VALUES (?, 'failed-session', 'sha256-json-v1', ?, '1', 'failed', 'malformed')
             RETURNING session_id`,
          )
          .get(sourceInstanceId, DIGEST)?.session_id,
      );

      expect(() =>
        database
          .prepare(
            `INSERT INTO sessions_session_tracking (
               source_instance_id,
               native_id,
               latest_fingerprint_scheme,
               latest_fingerprint_digest,
               latest_adapter_version,
               latest_outcome
             ) VALUES (?, 'invalid-removed-outcome', 'sha256-json-v1', ?, '1', 'removed')`,
          )
          .run(sourceInstanceId, DIGEST),
      ).toThrow(/CHECK constraint failed/u);
      expect(() =>
        database
          .prepare(
            `INSERT INTO sessions_session_tracking (
               source_instance_id,
               native_id,
               latest_fingerprint_scheme,
               latest_fingerprint_digest,
               latest_adapter_version,
               latest_outcome
             ) VALUES (?, 'invalid-failure', 'sha256-json-v1', ?, '1', 'failed')`,
          )
          .run(sourceInstanceId, DIGEST),
      ).toThrow(/CHECK constraint failed/u);

      const runId = Number(
        database
          .prepare(
            `INSERT INTO sessions_index_runs (
               source_instance_id,
               status,
               started_at
             ) VALUES (?, 'active', '2026-07-13T12:00:00.000Z')
             RETURNING run_id`,
          )
          .get(sourceInstanceId)?.run_id,
      );
      const insertItem = database.prepare(
        `INSERT INTO sessions_index_run_items (
           run_id,
           ordinal,
           session_id,
           outcome
         ) VALUES (?, ?, ?, 'missing')`,
      );
      for (let ordinal = 0; ordinal < 100; ordinal += 1) {
        insertItem.run(runId, ordinal, failedSessionId);
      }

      expect(rowCount(database, "sessions_index_run_items")).toBe(100);
      expect(() => insertItem.run(runId, 100, failedSessionId)).toThrow(/CHECK constraint failed/u);
      expect(() =>
        database
          .prepare(
            `INSERT INTO sessions_index_run_items (
               run_id,
               ordinal,
               session_id,
               outcome
             ) VALUES (?, 0, ?, 'removed')`,
          )
          .run(runId, failedSessionId),
      ).toThrow(/CHECK constraint failed/u);
      expect(() =>
        database
          .prepare(
            `UPDATE sessions_index_runs
             SET discovered_count = 2,
                 indexed_count = 1
             WHERE run_id = ?`,
          )
          .run(runId),
      ).toThrow(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });
});

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  return database;
}

function migratedDatabase(): DatabaseSync {
  const database = openDatabase();
  applyMigrations(database);
  return database;
}

function strictApplicationTables(database: DatabaseSync): readonly string[] {
  return (
    database
      .prepare(
        `SELECT name
         FROM pragma_table_list
         WHERE type = 'table'
           AND name LIKE 'sessions_%'
           AND strict = 1
         ORDER BY name`,
      )
      .all() as unknown as readonly { readonly name: string }[]
  ).map(({ name }) => name);
}

function insertSourceInstance(database: DatabaseSync, instanceId = "profile-one"): number {
  const row = database
    .prepare(
      `INSERT INTO sessions_source_instances (kind, instance_id)
       VALUES ('synthetic', ?)
       RETURNING source_instance_id`,
    )
    .get(instanceId) as { readonly source_instance_id: number | bigint };
  return Number(row.source_instance_id);
}

function insertTrackedSession(database: DatabaseSync): { readonly sessionId: number } {
  const sourceInstanceId = insertSourceInstance(database);
  const row = database
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
       ) VALUES (?, 'session-one', 'sha256-json-v1', ?, '1', 'sha256-json-v1', ?, '1', 'indexed')
       RETURNING session_id`,
    )
    .get(sourceInstanceId, DIGEST, DIGEST) as { readonly session_id: number | bigint };
  const sessionId = Number(row.session_id);
  database
    .prepare(
      `INSERT INTO sessions_canonical_sessions (session_id, lineage_coverage, title)
       VALUES (?, 'complete', 'Proof')`,
    )
    .run(sessionId);
  return { sessionId };
}

function insertContent(database: DatabaseSync, digest: string, text: string): number {
  const row = database
    .prepare(
      `INSERT INTO sessions_content_values (digest, text)
       VALUES (?, ?)
       RETURNING content_id`,
    )
    .get(encodeSqliteContentDigest(digest), text) as { readonly content_id: number | bigint };
  return Number(row.content_id);
}

function ftsMatches(database: DatabaseSync, query: string): readonly number[] {
  return (
    database
      .prepare(
        `SELECT rowid
         FROM sessions_content_fts
         WHERE sessions_content_fts MATCH ?
         ORDER BY rowid`,
      )
      .all(query) as unknown as readonly { readonly rowid: number | bigint }[]
  ).map(({ rowid }) => Number(rowid));
}

function expectFtsIntegrity(database: DatabaseSync): void {
  expect(() =>
    database.exec(
      `INSERT INTO sessions_content_fts(sessions_content_fts, rank)
       VALUES ('integrity-check', 1)`,
    ),
  ).not.toThrow();
}

function rowCount(database: DatabaseSync, table: string): number {
  if (!/^sessions_[a-z_]+$/u.test(table)) throw new TypeError("Unsafe test table name");
  const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
    readonly count: number | bigint;
  };
  return Number(row.count);
}

function tableColumns(database: DatabaseSync, table: string): readonly string[] {
  if (!/^sessions_[a-z_]+$/u.test(table)) throw new TypeError("Unsafe test table name");
  return (
    database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as readonly {
      readonly name: string;
    }[]
  ).map(({ name }) => name);
}
