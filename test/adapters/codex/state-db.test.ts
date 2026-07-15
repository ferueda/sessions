import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { fingerprintCodexTuple } from "../../../src/adapters/codex/fingerprint.ts";
import {
  materializeCodexState,
  type CodexStateSchemaError,
} from "../../../src/adapters/codex/state-db.ts";

describe("Codex state schema gateway", () => {
  test("materializes required columns with exact absence sentinels", () => {
    withDatabase(
      `
        CREATE TABLE threads (id TEXT NOT NULL, rollout_path TEXT NOT NULL);
        INSERT INTO threads VALUES ('b', 'sessions/rollout-b.jsonl');
        INSERT INTO threads VALUES ('a', 'sessions/rollout-a.jsonl');
      `,
      (database) => {
        const generation = materializeCodexState(database);

        expect(generation.threads.map(({ id }) => id)).toEqual(["a", "b"]);
        expect(generation.threads[0]?.rowTuple).toEqual([
          "codex-thread-row-v1",
          ["id", "text", "a"],
          ["rollout_path", "text", "sessions/rollout-a.jsonl"],
          ["title", "column-absent"],
          ["cwd", "column-absent"],
          ["created", "absent", null, null],
          ["updated", "absent", null, null],
        ]);
        expect(generation.threads[0]?.edgeTuple).toEqual(["codex-parent-edge-v1", "table-absent"]);
        expect(generation.threads[0]?.spawnEdgeCoverage).toBe("unknown");
        expect(Object.isFrozen(generation)).toBe(true);
        expect(Object.isFrozen(generation.threads)).toBe(true);
      },
    );
  });

  test("applies optional metadata and millisecond timestamp precedence", () => {
    withDatabase(
      `
        CREATE TABLE threads (
          id TEXT, rollout_path TEXT, title TEXT, cwd TEXT,
          created_at_ms INTEGER, created_at INTEGER,
          updated_at_ms INTEGER, updated_at INTEGER,
          ignored TEXT
        );
        INSERT INTO threads VALUES (
          'thread', 'sessions/rollout-thread.jsonl', '', '/workspace',
          1001, 999999, NULL, 2, 'first'
        );
      `,
      (database) => {
        const first = materializeCodexState(database).threads[0]!;
        database.exec(`UPDATE threads SET ignored = 'second', created_at = 3`);
        const second = materializeCodexState(database).threads[0]!;

        expect(first).toMatchObject({
          workspace: "/workspace",
          createdAt: "1970-01-01T00:00:01.001Z",
          updatedAt: "1970-01-01T00:00:02.000Z",
        });
        expect(first).not.toHaveProperty("title");
        expect(first.rowTuple).toEqual(second.rowTuple);
        expect(fingerprintCodexTuple(first.rowTuple)).toBe(fingerprintCodexTuple(second.rowTuple));
      },
    );
  });

  test("fingerprints edge table, row, and status capabilities", () => {
    withDatabase(
      `
        CREATE TABLE threads (id TEXT, rollout_path TEXT);
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT, child_thread_id TEXT, status TEXT
        );
        INSERT INTO threads VALUES ('child', 'sessions/rollout-child.jsonl');
      `,
      (database) => {
        expect(materializeCodexState(database).threads[0]?.edgeTuple).toEqual([
          "codex-parent-edge-v1",
          "row-absent",
          "status-present",
        ]);
        expect(materializeCodexState(database).threads[0]?.spawnEdgeCoverage).toBe("complete");

        database.exec(`INSERT INTO thread_spawn_edges VALUES ('parent', 'child', NULL)`);
        expect(materializeCodexState(database).threads[0]).toMatchObject({
          parentId: "parent",
          spawnEdgeCoverage: "complete",
          edgeTuple: ["codex-parent-edge-v1", "row", "parent", "child", "status-present", null],
        });
      },
    );

    withDatabase(
      `
        CREATE TABLE threads (id TEXT, rollout_path TEXT);
        CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
        INSERT INTO threads VALUES ('child', 'sessions/rollout-child.jsonl');
      `,
      (database) => {
        expect(materializeCodexState(database).threads[0]?.edgeTuple).toEqual([
          "codex-parent-edge-v1",
          "row-absent",
          "status-absent",
        ]);
        expect(materializeCodexState(database).threads[0]?.spawnEdgeCoverage).toBe("complete");
      },
    );
  });

  test.each([
    `CREATE TABLE other (id TEXT);`,
    `CREATE TABLE threads (id TEXT);`,
    `CREATE VIEW threads AS SELECT 'id' AS id, 'path' AS rollout_path;`,
    `
      CREATE TABLE threads (id TEXT, rollout_path TEXT);
      CREATE TABLE thread_spawn_edges (child_thread_id TEXT);
    `,
  ])("rejects unsupported schema capabilities", (schema) => {
    withDatabase(schema, (database) => {
      expect(() => materializeCodexState(database)).toThrowError(
        expect.objectContaining({ kind: "unsupported-format" }) as CodexStateSchemaError,
      );
    });
  });

  test.each([
    `
      CREATE TABLE threads (id TEXT, rollout_path TEXT);
      INSERT INTO threads VALUES ('', 'path');
    `,
    `
      CREATE TABLE threads (id TEXT, rollout_path TEXT, title INTEGER);
      INSERT INTO threads VALUES ('id', 'path', 1);
    `,
    `
      CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at_ms REAL);
      INSERT INTO threads VALUES ('id', 'path', 1.5);
    `,
    `
      CREATE TABLE threads (id TEXT, rollout_path TEXT);
      INSERT INTO threads VALUES ('id', 'one');
      INSERT INTO threads VALUES ('id', 'two');
    `,
    `
      CREATE TABLE threads (id TEXT, rollout_path TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES ('child', 'path');
      INSERT INTO thread_spawn_edges VALUES ('one', 'child');
      INSERT INTO thread_spawn_edges VALUES ('two', 'child');
    `,
  ])("rejects malformed admitted values and ambiguous rows", (schema) => {
    withDatabase(schema, (database) => {
      expect(() => materializeCodexState(database)).toThrowError(
        expect.objectContaining({ kind: "malformed" }) as CodexStateSchemaError,
      );
    });
  });
});

function withDatabase(schema: string, run: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(schema);
    run(database);
  } finally {
    database.close();
  }
}
