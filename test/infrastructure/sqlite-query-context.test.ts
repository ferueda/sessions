import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  entryAt,
  readSearchContexts,
  sqliteLinkedContextDiscoverySql,
  SQLITE_SEARCH_LINKED_CANDIDATE_LIMIT,
} from "../../src/infrastructure/sqlite/sqlite-query-context.ts";

describe("SQLite query context", () => {
  test("bounds high-fan-out linked discovery per primary with indexed next probes", () => {
    const database = contextDatabase();
    try {
      seedLinkedFanOut(database, 1, 500);
      seedLinkedFanOut(database, 2, 500);
      const sql = sqliteLinkedContextDiscoverySql(2);
      const parameters = [0, 1, 0, 1, 2, 0, SQLITE_SEARCH_LINKED_CANDIDATE_LIMIT];
      const discovered = database.prepare(sql).all(...parameters) as unknown as readonly {
        readonly primary_index: number | bigint;
        readonly candidate_ordinal: number | bigint;
      }[];

      expect(discovered).toHaveLength(SQLITE_SEARCH_LINKED_CANDIDATE_LIMIT * 2);
      for (const primaryIndex of [0, 1]) {
        expect(
          discovered
            .filter((row) => Number(row.primary_index) === primaryIndex)
            .map((row) => Number(row.candidate_ordinal)),
        ).toEqual(
          Array.from({ length: SQLITE_SEARCH_LINKED_CANDIDATE_LIMIT }, (_, index) => index + 1),
        );
      }

      const contexts = readSearchContexts(
        database,
        [
          { sessionId: 1, entryOrdinal: 0 },
          { sessionId: 2, entryOrdinal: 0 },
        ],
        0,
      );
      expect(contexts).toHaveLength(2);
      for (const context of contexts) {
        expect(context.entries.map((entry) => entry.ordinal)).toEqual(
          Array.from({ length: 20 }, (_, index) => index + 1),
        );
        expect(context.entries.every((entry) => entry.linked && !entry.adjacent)).toBe(true);
        expect(context.linkedContextTruncated).toBe(true);
      }

      expect(sql).toContain("WITH RECURSIVE");
      expect(sql).not.toContain("ROW_NUMBER");
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...parameters)
        .map((row) => String(row.detail).replaceAll(/\s+/gu, " ").trim());
      expect(
        plan.some(
          (detail) =>
            detail.includes("SEARCH candidate") &&
            detail.includes("session_id=?") &&
            detail.includes("ordinal>?"),
        ),
      ).toBe(true);
      expect(
        plan.some((detail) => detail.includes("SCAN candidate") && !detail.includes("SEARCH")),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  test("rejects a schema-valid but non-canonical stored timestamp", () => {
    expect(() =>
      entryAt({
        ordinal: 0,
        kind: "message",
        actor: "human",
        timestamp: "2026-7-22T12:00:00Z",
        related_entry_ordinal: null,
        tool_call_id: null,
        tool_name: null,
        tool_namespace: null,
      }),
    ).toThrow(expect.objectContaining({ code: "corrupt-data" }));
  });
});

function contextDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec(`
    CREATE TABLE sessions_entries (
      session_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      timestamp TEXT,
      related_entry_ordinal INTEGER,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_namespace TEXT,
      PRIMARY KEY (session_id, ordinal)
    ) STRICT;
    CREATE TABLE sessions_content_occurrences (
      session_id INTEGER NOT NULL,
      entry_ordinal INTEGER NOT NULL,
      segment_ordinal INTEGER NOT NULL,
      content_id INTEGER,
      PRIMARY KEY (session_id, entry_ordinal, segment_ordinal)
    ) STRICT;
    CREATE TABLE sessions_content_values (
      content_id INTEGER PRIMARY KEY,
      text TEXT NOT NULL
    ) STRICT;
  `);
  return database;
}

function seedLinkedFanOut(database: DatabaseSync, sessionId: number, candidates: number): void {
  const insert = database.prepare(
    `INSERT INTO sessions_entries (
       session_id,
       ordinal,
       kind,
       actor,
       timestamp,
       related_entry_ordinal,
       tool_call_id,
       tool_name,
       tool_namespace
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
  );
  database.exec("BEGIN");
  try {
    insert.run(
      sessionId,
      0,
      "tool-call",
      "model",
      "2026-07-22T12:00:00.000Z",
      null,
      "synthetic_tool",
    );
    for (let ordinal = 1; ordinal <= candidates; ordinal += 1) {
      insert.run(sessionId, ordinal, "tool-result", "tool", "2026-07-22T12:00:00.000Z", 0, null);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
