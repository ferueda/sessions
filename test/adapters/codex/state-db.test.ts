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

  test("executes one ordered edge query for a large admitted cohort", () => {
    withDatabase(
      `
        CREATE TABLE threads (id TEXT, rollout_path TEXT);
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT, child_thread_id TEXT, status TEXT
        );
      `,
      (database) => {
        const insertThread = database.prepare("INSERT INTO threads VALUES (?, ?)");
        const insertEdge = database.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?, ?)");
        database.exec("BEGIN");
        try {
          for (let ordinal = 0; ordinal < 2_000; ordinal += 1) {
            const id = `thread-${ordinal.toString().padStart(4, "0")}`;
            insertThread.run(id, `sessions/${id}.jsonl`);
            if (ordinal > 0) {
              const parentId = `thread-${(ordinal - 1).toString().padStart(4, "0")}`;
              insertEdge.run(parentId, id, "ready");
            }
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }

        const edgeQueryExecutions = instrumentEdgeQueryExecutions(database);
        const generation = materializeCodexState(database);

        expect(edgeQueryExecutions()).toBe(1);
        expect(generation.threads).toHaveLength(2_000);
        expect(generation.threads[0]).toMatchObject({
          id: "thread-0000",
          spawnEdgeCoverage: "complete",
          edgeTuple: ["codex-parent-edge-v1", "row-absent", "status-present"],
        });
        expect(generation.threads.at(-1)).toMatchObject({
          id: "thread-1999",
          parentId: "thread-1998",
          edgeTuple: [
            "codex-parent-edge-v1",
            "row",
            "thread-1998",
            "thread-1999",
            "status-present",
            "ready",
          ],
        });
      },
    );
  });

  test("ignores malformed orphan edges but rejects malformed admitted edges", () => {
    withDatabase(
      `
        CREATE TABLE threads (id TEXT, rollout_path TEXT);
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT, child_thread_id TEXT, status TEXT
        );
        INSERT INTO threads VALUES ('a', 'sessions/a.jsonl');
        INSERT INTO threads VALUES ('b', 'sessions/b.jsonl');
        INSERT INTO thread_spawn_edges VALUES ('parent', 'a', 'ready');
        INSERT INTO thread_spawn_edges VALUES (NULL, 'orphan', 7);
      `,
      (database) => {
        expect(materializeCodexState(database).threads).toMatchObject([
          {
            id: "a",
            parentId: "parent",
            edgeTuple: ["codex-parent-edge-v1", "row", "parent", "a", "status-present", "ready"],
          },
          {
            id: "b",
            edgeTuple: ["codex-parent-edge-v1", "row-absent", "status-present"],
          },
        ]);

        database.exec(`INSERT INTO thread_spawn_edges VALUES ('one', 'b', 'ready')`);
        database.exec(`INSERT INTO thread_spawn_edges VALUES ('two', 'b', 'ready')`);
        expect(() => materializeCodexState(database)).toThrowError(
          expect.objectContaining({ kind: "malformed" }) as CodexStateSchemaError,
        );
      },
    );
  });

  test("keeps case-distinct thread ids when the thread key has non-binary collation", () => {
    withDatabase(
      `
        CREATE TABLE threads (id TEXT COLLATE NOCASE, rollout_path TEXT);
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT, child_thread_id TEXT, status TEXT
        );
        INSERT INTO threads VALUES ('a', 'sessions/lower.jsonl');
        INSERT INTO threads VALUES ('A', 'sessions/upper.jsonl');
        INSERT INTO thread_spawn_edges VALUES ('lower-parent', 'a', 'lower');
        INSERT INTO thread_spawn_edges VALUES ('upper-parent', 'A', 'upper');
      `,
      (database) => {
        expect(
          materializeCodexState(database).threads.map(({ id, edgeTuple }) => ({ id, edgeTuple })),
        ).toEqual([
          {
            id: "A",
            edgeTuple: [
              "codex-parent-edge-v1",
              "row",
              "upper-parent",
              "A",
              "status-present",
              "upper",
            ],
          },
          {
            id: "a",
            edgeTuple: [
              "codex-parent-edge-v1",
              "row",
              "lower-parent",
              "a",
              "status-present",
              "lower",
            ],
          },
        ]);
      },
    );
  });

  test("uses the edge key collation while retaining exact child validation", () => {
    withDatabase(
      `
        CREATE TABLE threads (id TEXT, rollout_path TEXT);
        CREATE TABLE thread_spawn_edges (
          parent_thread_id TEXT, child_thread_id TEXT COLLATE NOCASE
        );
        INSERT INTO threads VALUES ('A', 'sessions/upper.jsonl');
        INSERT INTO threads VALUES ('a', 'sessions/lower.jsonl');
        INSERT INTO threads VALUES ('child', 'sessions/child.jsonl');
        INSERT INTO thread_spawn_edges VALUES ('parent', 'child');
      `,
      (database) => {
        expect(
          materializeCodexState(database).threads.map(({ id, edgeTuple }) => ({ id, edgeTuple })),
        ).toEqual([
          {
            id: "A",
            edgeTuple: ["codex-parent-edge-v1", "row-absent", "status-absent"],
          },
          {
            id: "a",
            edgeTuple: ["codex-parent-edge-v1", "row-absent", "status-absent"],
          },
          {
            id: "child",
            edgeTuple: ["codex-parent-edge-v1", "row", "parent", "child", "status-absent", null],
          },
        ]);

        database.exec(`UPDATE thread_spawn_edges SET child_thread_id = 'CHILD'`);
        expect(() => materializeCodexState(database)).toThrowError(
          expect.objectContaining({ kind: "malformed" }) as CodexStateSchemaError,
        );
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

function instrumentEdgeQueryExecutions(database: DatabaseSync): () => number {
  const prepare = database.prepare.bind(database);
  let executions = 0;
  database.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.includes("JOIN thread_spawn_edges AS edges")) {
      const all = statement.all.bind(statement);
      statement.all = () => {
        executions += 1;
        return all();
      };
    }
    return statement;
  };
  return () => executions;
}
