import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { hashContent } from "../../src/domain/content-hash.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import {
  applyMigrations,
  readMigrationHistory,
  sqliteMigrations,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { readCanonicalDocument } from "../../src/infrastructure/sqlite/sqlite-session-document.ts";

const IDENTITY: SessionIdentity = {
  source: { kind: "synthetic", instanceId: "migration-profile" },
  nativeId: "retained-session",
};
const TEXT = "preserved searchable migration evidence";

describe("canonical library evidence migration", () => {
  test("preserves schema 3 documents, FTS, history, and writer ownership", () => {
    const database = schemaThreeDatabase();
    try {
      const fixture = seedSchemaThree(database);

      const history = applyMigrations(database);

      expect(history).toMatchObject({ currentVersion: 4, pending: [] });
      expect(history.applied.at(-1)).toMatchObject({
        version: 4,
        name: "canonical_library_evidence",
      });
      expect(readMigrationHistory(database).currentVersion).toBe(4);
      expect(readCanonicalDocument(database, IDENTITY, fixture.retainedSessionId)).toEqual({
        identity: IDENTITY,
        title: "Migration proof",
        relations: [],
        entries: [
          {
            ordinal: 0,
            kind: "message",
            actor: "human",
            toolCallId: "legacy-call-id-on-message",
            sourceLocator: { uri: "memory://migration/0" },
            content: [
              {
                kind: "text",
                ordinal: 0,
                text: TEXT,
                contentHash: hashContent(TEXT),
                origin: "human",
                originConfidence: "high",
                sourceMetadata: { fixture: "schema-three" },
              },
            ],
          },
          {
            ordinal: 1,
            kind: "tool-result",
            actor: "tool",
            relatedEntryOrdinal: 0,
            toolCallId: "legacy-result-id",
            sourceLocator: { uri: "memory://migration/1" },
            content: [],
          },
        ],
      });
      expect(ftsMatches(database, "searchable")).toEqual([fixture.contentId]);
      expectFtsIntegrity(database);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database
          .prepare(
            `SELECT coverage_status, coverage_observed_at
             FROM sessions_source_instances
             WHERE source_instance_id = ?`,
          )
          .get(fixture.sourceInstanceId),
      ).toEqual({ coverage_status: "unknown", coverage_observed_at: null });
      expect(
        database
          .prepare(
            `SELECT presence_status, presence_observed_at, captured_at, last_seen_at
             FROM sessions_session_tracking
             WHERE session_id = ?`,
          )
          .get(fixture.retainedSessionId),
      ).toEqual({
        presence_status: "present",
        presence_observed_at: null,
        captured_at: null,
        last_seen_at: null,
      });
      expect(
        database
          .prepare(
            `SELECT presence_status, presence_observed_at, captured_at, last_seen_at
             FROM sessions_session_tracking
             WHERE session_id = ?`,
          )
          .get(fixture.removedSessionId),
      ).toEqual({
        presence_status: "missing",
        presence_observed_at: null,
        captured_at: null,
        last_seen_at: null,
      });
      expect(
        database
          .prepare(
            `SELECT removed_count, missing_count, omitted_item_count
             FROM sessions_index_runs
             WHERE run_id = ?`,
          )
          .get(fixture.runId),
      ).toEqual({ removed_count: 1, missing_count: 0, omitted_item_count: 0 });
      expect(
        database
          .prepare(
            `SELECT outcome, failure_code
             FROM sessions_index_run_items
             WHERE run_id = ?`,
          )
          .all(fixture.runId),
      ).toEqual([{ outcome: "removed", failure_code: null }]);
      expect(database.prepare("SELECT * FROM sessions_writer_lease").get()).toEqual({
        singleton: 1,
        generation: 7,
        purpose: "index",
        owner_token: "preserved-owner",
        acquired_at: "2026-07-14T12:00:00.000Z",
        heartbeat_at: "2026-07-14T12:00:01.000Z",
        expires_at: "2026-07-14T12:00:31.000Z",
      });
      expect(
        database
          .prepare(
            `SELECT partial
             FROM pragma_index_list('sessions_content_occurrences')
             WHERE name = 'sessions_content_occurrences_content_idx'`,
          )
          .get(),
      ).toEqual({ partial: 1 });
    } finally {
      database.close();
    }
  });

  test("enforces strict content variants, tool identity, missing evidence, and forget leases", () => {
    const database = schemaThreeDatabase();
    try {
      const fixture = seedSchemaThree(database);
      applyMigrations(database);

      database
        .prepare(
          `INSERT INTO sessions_content_occurrences (
             session_id,
             entry_ordinal,
             segment_ordinal,
             content_class,
             source_type,
             origin,
             confidence,
             source_metadata_json
           ) VALUES (?, 1, 0, 'image', ?, 'tool', 'high', '{}')`,
        )
        .run(fixture.retainedSessionId, `a${"b".repeat(63)}`);
      expect(
        database
          .prepare(
            `SELECT content_id, content_class, source_type
             FROM sessions_content_occurrences
             WHERE session_id = ? AND entry_ordinal = 1`,
          )
          .get(fixture.retainedSessionId),
      ).toEqual({
        content_id: null,
        content_class: "image",
        source_type: `a${"b".repeat(63)}`,
      });

      const invalidSourceTypes = [
        "",
        `a${"b".repeat(64)}`,
        "UPPER",
        "snake_case",
        "double--hyphen",
        "-leading",
        "trailing-",
        "white space",
        "nul\0byte",
        "control\u0001byte",
        "unicode-é",
        "path/value",
      ];
      const insertOmitted = database.prepare(
        `INSERT INTO sessions_content_occurrences (
           session_id,
           entry_ordinal,
           segment_ordinal,
           content_class,
           source_type,
           origin,
           confidence,
           source_metadata_json
         ) VALUES (?, 1, 1, 'unknown', ?, 'unknown', 'unknown', '{}')`,
      );
      for (const sourceType of invalidSourceTypes) {
        expect(() => insertOmitted.run(fixture.retainedSessionId, sourceType)).toThrow(
          /CHECK constraint failed/u,
        );
      }
      expect(() =>
        database
          .prepare(
            `INSERT INTO sessions_content_occurrences (
               session_id,
               entry_ordinal,
               segment_ordinal,
               content_id,
               content_class,
               source_type,
               origin,
               confidence,
               source_metadata_json
             ) VALUES (?, 1, 1, ?, 'image', 'image-record', 'tool', 'high', '{}')`,
          )
          .run(fixture.retainedSessionId, fixture.contentId),
      ).toThrow(/CHECK constraint failed/u);
      expect(() =>
        database
          .prepare(
            `INSERT INTO sessions_content_occurrences (
               session_id,
               entry_ordinal,
               segment_ordinal,
               origin,
               confidence,
               source_metadata_json
             ) VALUES (?, 1, 1, 'tool', 'high', '{}')`,
          )
          .run(fixture.retainedSessionId),
      ).toThrow(/CHECK constraint failed/u);

      expect(() =>
        database
          .prepare(
            `INSERT INTO sessions_entries (
               session_id,
               ordinal,
               kind,
               actor,
               tool_name,
               source_locator_uri
             ) VALUES (?, 2, 'message', 'model', 'invalid-owner', 'memory://migration/2')`,
          )
          .run(fixture.retainedSessionId),
      ).toThrow(/CHECK constraint failed/u);
      expect(() =>
        database
          .prepare(
            `INSERT INTO sessions_entries (
               session_id,
               ordinal,
               kind,
               actor,
               tool_namespace,
               source_locator_uri
             ) VALUES (?, 2, 'tool-call', 'model', 'functions', 'memory://migration/2')`,
          )
          .run(fixture.retainedSessionId),
      ).toThrow(/CHECK constraint failed/u);
      database
        .prepare(
          `INSERT INTO sessions_entries (
             session_id,
             ordinal,
             kind,
             actor,
             tool_name,
             tool_namespace,
             source_locator_uri
           ) VALUES (?, 2, 'tool-call', 'model', 'read_file', 'functions', 'memory://migration/2')`,
        )
        .run(fixture.retainedSessionId);

      database
        .prepare("UPDATE sessions_index_runs SET missing_count = 1 WHERE run_id = ?")
        .run(fixture.runId);
      database
        .prepare(
          `INSERT INTO sessions_index_run_items (
             run_id,
             ordinal,
             session_id,
             outcome
           ) VALUES (?, 1, ?, 'missing')`,
        )
        .run(fixture.runId, fixture.retainedSessionId);
      expect(() =>
        database
          .prepare("UPDATE sessions_index_runs SET missing_count = -1 WHERE run_id = ?")
          .run(fixture.runId),
      ).toThrow(/CHECK constraint failed/u);

      database
        .prepare(
          `UPDATE sessions_writer_lease
           SET purpose = 'forget',
               owner_token = 'forget-owner',
               acquired_at = '2026-07-14T13:00:00.000Z',
               heartbeat_at = '2026-07-14T13:00:00.000Z',
               expires_at = '2026-07-14T13:00:30.000Z'
           WHERE singleton = 1`,
        )
        .run();
      expect(database.prepare("SELECT purpose FROM sessions_writer_lease").get()).toEqual({
        purpose: "forget",
      });
      expect(() =>
        database
          .prepare("UPDATE sessions_writer_lease SET purpose = 'unsafe' WHERE singleton = 1")
          .run(),
      ).toThrow(/CHECK constraint failed/u);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("rolls the whole migration back when a rebuild step fails", () => {
    const database = schemaThreeDatabase();
    try {
      seedSchemaThree(database);
      database.exec("CREATE TABLE sessions_content_occurrences_v3 (poison INTEGER) STRICT");

      expect(() => applyMigrations(database)).toThrow(/already another table or index/u);

      expect(readMigrationHistory(database, sqliteMigrations.slice(0, 3)).currentVersion).toBe(3);
      expect(tableColumns(database, "sessions_source_instances")).not.toContain("coverage_status");
      expect(tableColumns(database, "sessions_entries")).not.toContain("tool_name");
      expect(tableColumns(database, "sessions_content_occurrences")).toContain("content_id");
      expect(tableColumns(database, "sessions_content_occurrences_v3")).toEqual(["poison"]);
      expect(ftsMatches(database, "searchable")).toHaveLength(1);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
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

function schemaThreeDatabase(): DatabaseSync {
  const database = openDatabase();
  applyMigrations(database, sqliteMigrations.slice(0, 3));
  return database;
}

interface SchemaThreeFixture {
  readonly sourceInstanceId: number;
  readonly retainedSessionId: number;
  readonly removedSessionId: number;
  readonly contentId: number;
  readonly runId: number;
}

function seedSchemaThree(database: DatabaseSync): SchemaThreeFixture {
  const sourceInstanceId = insertedId(
    database
      .prepare(
        `INSERT INTO sessions_source_instances (kind, instance_id)
         VALUES (?, ?)
         RETURNING source_instance_id`,
      )
      .get(IDENTITY.source.kind, IDENTITY.source.instanceId),
    "source_instance_id",
  );
  const digest = "a".repeat(64);
  const retainedSessionId = insertedId(
    database
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
         ) VALUES (?, ?, 'sha256-json-v1', ?, 'schema-three', 'sha256-json-v1', ?, 'schema-three', 'indexed')
         RETURNING session_id`,
      )
      .get(sourceInstanceId, IDENTITY.nativeId, digest, digest),
    "session_id",
  );
  const removedSessionId = insertedId(
    database
      .prepare(
        `INSERT INTO sessions_session_tracking (
           source_instance_id,
           native_id,
           latest_outcome
         ) VALUES (?, 'legacy-removed', 'removed')
         RETURNING session_id`,
      )
      .get(sourceInstanceId),
    "session_id",
  );
  database
    .prepare(
      `INSERT INTO sessions_canonical_sessions (session_id, title)
       VALUES (?, 'Migration proof')`,
    )
    .run(retainedSessionId);
  database
    .prepare(
      `INSERT INTO sessions_entries (
         session_id,
         ordinal,
         kind,
         actor,
         tool_call_id,
         source_locator_uri
       ) VALUES (?, 0, 'message', 'human', 'legacy-call-id-on-message', 'memory://migration/0')`,
    )
    .run(retainedSessionId);
  database
    .prepare(
      `INSERT INTO sessions_entries (
         session_id,
         ordinal,
         kind,
         actor,
         related_entry_ordinal,
         tool_call_id,
         source_locator_uri
       ) VALUES (?, 1, 'tool-result', 'tool', 0, 'legacy-result-id', 'memory://migration/1')`,
    )
    .run(retainedSessionId);
  const contentHash = hashContent(TEXT);
  const contentId = insertedId(
    database
      .prepare(
        `INSERT INTO sessions_content_values (hash_scheme, digest, text)
         VALUES (?, ?, ?)
         RETURNING content_id`,
      )
      .get(contentHash.scheme, contentHash.digest, TEXT),
    "content_id",
  );
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
       ) VALUES (?, 0, 0, ?, 'human', 'high', '{"fixture":"schema-three"}')`,
    )
    .run(retainedSessionId, contentId);
  const runId = insertedId(
    database
      .prepare(
        `INSERT INTO sessions_index_runs (
           source_instance_id,
           status,
           started_at,
           finished_at,
           removed_count
         ) VALUES (
           ?,
           'completed',
           '2026-07-14T11:00:00.000Z',
           '2026-07-14T11:01:00.000Z',
           1
         )
         RETURNING run_id`,
      )
      .get(sourceInstanceId),
    "run_id",
  );
  database
    .prepare(
      `INSERT INTO sessions_index_run_items (run_id, ordinal, session_id, outcome)
       VALUES (?, 0, ?, 'removed')`,
    )
    .run(runId, removedSessionId);
  database
    .prepare(
      `UPDATE sessions_writer_lease
       SET generation = 7,
           purpose = 'index',
           owner_token = 'preserved-owner',
           acquired_at = '2026-07-14T12:00:00.000Z',
           heartbeat_at = '2026-07-14T12:00:01.000Z',
           expires_at = '2026-07-14T12:00:31.000Z'
       WHERE singleton = 1`,
    )
    .run();
  return { sourceInstanceId, retainedSessionId, removedSessionId, contentId, runId };
}

function insertedId(row: unknown, key: string): number {
  if (typeof row !== "object" || row === null || !(key in row)) {
    throw new TypeError("Fixture insert did not return an identifier");
  }
  const value = (row as Record<string, unknown>)[key];
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new TypeError("Fixture identifier is invalid");
  }
  return number;
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

function tableColumns(database: DatabaseSync, table: string): readonly string[] {
  if (!/^sessions_[a-z0-9_]+$/u.test(table)) throw new TypeError("Unsafe test table name");
  return (
    database.prepare(`PRAGMA table_info("${table}")`).all() as unknown as readonly {
      readonly name: string;
    }[]
  ).map(({ name }) => name);
}
