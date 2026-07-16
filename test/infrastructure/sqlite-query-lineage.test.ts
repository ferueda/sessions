import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { createSessionSearchQuery } from "../../src/domain/session-query.ts";
import type {
  LineageCoverage,
  SessionDocument,
  SessionIdentity,
  SessionRelation,
} from "../../src/domain/session.ts";
import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import { createSqliteSessionQuery } from "../../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import { replacement } from "../contracts/session-index.contract.ts";
import { createTestDocument, createTestEntry, createTestSegment } from "../fixtures/session.ts";

describe("SQLite query lineage support", () => {
  test("counts independent roots once and keeps unresolved ancestry explicit", async () => {
    const database = migratedDatabase();
    const now = () => new Date("2026-07-14T12:00:00.000Z");
    const lease = acquireWriterLease(database, "index", {
      now,
      token: () => "query-lineage-writer",
    });
    try {
      const rootA = identity("root-a");
      const childA = identity("child-a");
      const rootB = identity("root-b");
      const cycleLeft = identity("cycle-left");
      const cycleRight = identity("cycle-right");
      const documents = [
        document(rootA, "complete", [relation("child", childA)]),
        document(childA, "complete", [relation("parent", rootA)]),
        document(rootB, "complete"),
        document(identity("fork-b"), "complete", [relation("fork", rootB)]),
        document(identity("continuation-b"), "complete", [relation("continuation", rootB)]),
        document(identity("missing-ancestor"), "complete", [
          relation("parent", identity("not-retained")),
        ]),
        document(identity("unknown-coverage"), "unknown"),
        document(cycleLeft, "complete", [relation("parent", cycleRight)]),
        document(cycleRight, "complete", [relation("parent", cycleLeft)]),
      ];
      const index = createCoordinatedSqliteSessionIndex(database, { lease, now });
      const run = await index.startRun({
        source: rootA.source,
        startedAt: "2026-07-14T12:00:00.000Z",
      });
      for (const [ordinal, candidate] of documents.entries()) {
        await index.replaceSession(
          run,
          replacement(candidate.identity, `lineage-${String(ordinal)}`, candidate),
        );
      }
      await index.finishRun(run, {
        status: "completed",
        finishedAt: "2026-07-14T12:01:00.000Z",
      });
      interruptOwnedRunsAndReleaseWriterLease(database, lease, {
        now: () => new Date("2026-07-14T12:02:00.000Z"),
      });

      const query = createSessionSearchQuery({
        text: "lineage matrix evidence",
        limit: 20,
        context: 0,
      });
      const repository = createSqliteSessionQuery(database);
      const result = await repository.search(query);

      expect(result.hits).toHaveLength(documents.length);
      expect(result.support).toEqual({
        occurrences: documents.length,
        uniqueContent: 1,
        uniqueKnownRoots: 2,
        unknownLineageSessions: 4,
      });
      await expect(repository.search(query)).resolves.toEqual(result);
    } finally {
      database.close();
    }
  });
});

const SOURCE = { kind: "synthetic-lineage", instanceId: "matrix" } as const;

function identity(nativeId: string): SessionIdentity {
  return { source: SOURCE, nativeId };
}

function relation(kind: SessionRelation["kind"], target: SessionIdentity): SessionRelation {
  return { kind, target, confidence: "high" };
}

function document(
  sessionIdentity: SessionIdentity,
  lineageCoverage: LineageCoverage,
  relations: readonly SessionRelation[] = [],
): SessionDocument {
  return {
    ...createTestDocument({
      identity: sessionIdentity,
      lineageCoverage,
      entries: [
        createTestEntry({
          content: [
            createTestSegment({
              text: "lineage matrix evidence",
              origin: "human",
              originConfidence: "high",
            }),
          ],
        }),
      ],
    }),
    relations,
  };
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
