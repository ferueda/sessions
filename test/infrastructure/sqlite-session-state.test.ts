import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  CURRENT_INDEX_SCHEMA_VERSION,
  applyMigrations,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import {
  decodeRetainedSessionSummary,
  findSessionTracking,
  readSessionFreshness,
  readSessionSummariesBatch,
  readSessionSummary,
} from "../../src/infrastructure/sqlite/sqlite-session-state.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  runLeasedImmediateTransaction,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import {
  clearWriterRecoveryReceiptInTransaction,
  initializeWriterRecoveryReceiptInTransaction,
} from "../../src/infrastructure/sqlite/writer-recovery-receipt.ts";
import { replacement } from "../contracts/session-index.contract.ts";
import { createTestDocument, createTestIdentity } from "../fixtures/session.ts";

describe("SQLite retained session summaries", () => {
  test("hydrates a bounded identity-checked batch with point-read parity", async () => {
    const database = await seededDatabase();
    try {
      const first = createTestIdentity("summary-one");
      const second = createTestIdentity("summary-two");
      const firstId = sessionId(database, first);
      const secondId = sessionId(database, second);

      const summaries = readSessionSummariesBatch(database, [
        { sessionId: secondId, identity: second },
        { sessionId: firstId, identity: first },
      ]);

      expect([...summaries.keys()]).toEqual([secondId, firstId]);
      expect(summaries.get(firstId)).toEqual(readSessionSummary(database, first));
      expect(summaries.get(secondId)).toEqual(readSessionSummary(database, second));
      expect(readSessionSummariesBatch(database, [])).toEqual(new Map());
    } finally {
      database.close();
    }
  });

  test("rejects ambiguous, mismatched, and oversized requests", async () => {
    const database = await seededDatabase();
    try {
      const first = createTestIdentity("summary-one");
      const second = createTestIdentity("summary-two");
      const firstId = sessionId(database, first);

      expect(() =>
        readSessionSummariesBatch(database, [
          { sessionId: firstId, identity: first },
          { sessionId: firstId, identity: first },
        ]),
      ).toThrow(TypeError);
      expect(() =>
        readSessionSummariesBatch(database, [{ sessionId: firstId, identity: second }]),
      ).toThrow("SQLite session index operation failed: corrupt-data");
      expect(() =>
        readSessionSummariesBatch(
          database,
          Array.from({ length: 201 }, (_, sessionId) => ({ sessionId, identity: first })),
        ),
      ).toThrow(TypeError);
    } finally {
      database.close();
    }
  });

  test("executes the exact 200-request batch with 800 bound values", async () => {
    const identities = Array.from({ length: 200 }, (_, ordinal) =>
      createTestIdentity(`summary-${String(ordinal).padStart(3, "0")}`),
    );
    const database = await seededDatabase(identities);
    try {
      const requests = identities.map((identity) => ({
        sessionId: sessionId(database, identity),
        identity,
      }));

      const summaries = readSessionSummariesBatch(database, requests);

      expect(summaries.size).toBe(200);
      for (const request of requests) {
        expect(summaries.get(request.sessionId)).toEqual(
          readSessionSummary(database, request.identity),
        );
      }
    } finally {
      database.close();
    }
  });

  test.each(["created_at", "updated_at"] as const)(
    "classifies malformed stored %s as corrupt in point and batch reads",
    async (column) => {
      const database = await seededDatabase();
      try {
        const identity = createTestIdentity("summary-one");
        const retainedSessionId = sessionId(database, identity);
        mutateCanonicalTimestamp(database, retainedSessionId, column);

        expect(() => readSessionSummary(database, identity)).toThrow(
          "SQLite session index operation failed: corrupt-data",
        );
        expect(() =>
          readSessionSummariesBatch(database, [{ sessionId: retainedSessionId, identity }]),
        ).toThrow("SQLite session index operation failed: corrupt-data");
      } finally {
        database.close();
      }
    },
  );

  test.each(["title", "workspace"] as const)(
    "rejects a non-well-formed optional stored %s in the shared decoder",
    async (field) => {
      const database = await seededDatabase();
      try {
        const identity = createTestIdentity("summary-one");
        const summary = readSessionSummary(database, identity);
        const freshness = readSessionFreshness(database, identity);
        if (
          summary === undefined ||
          (freshness.status !== "current" && freshness.status !== "stale")
        ) {
          throw new Error("Expected retained summary fixture");
        }
        const columns = {
          title: null,
          workspace: null,
          created_at: summary.createdAt ?? null,
          updated_at: summary.updatedAt ?? null,
          captured_at: summary.capturedAt,
          source_state: summary.sourceState,
          source_observed_at: summary.sourceObservedAt,
          document_digest_scheme: summary.documentDigest.scheme,
          document_digest: Buffer.from(summary.documentDigest.digest, "hex"),
          [field]: "\ud800",
        };

        expect(() => decodeRetainedSessionSummary(identity, columns, freshness)).toThrow(
          "SQLite session index operation failed: corrupt-data",
        );
      } finally {
        database.close();
      }
    },
  );
});

async function seededDatabase(
  identities: readonly ReturnType<typeof createTestIdentity>[] = [
    createTestIdentity("summary-one"),
    createTestIdentity("summary-two"),
  ],
): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  applyMigrations(database);
  const now = () => new Date("2026-07-23T12:00:00.000Z");
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "summary-batch-writer",
  });
  runLeasedImmediateTransaction(database, lease, { now }, (transactionNow) => {
    clearWriterRecoveryReceiptInTransaction(database, lease, { now: transactionNow });
    initializeWriterRecoveryReceiptInTransaction(database, lease, {
      now: transactionNow,
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    });
  });
  const index = createCoordinatedSqliteSessionIndex(database, {
    lease,
    now,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
  });
  const firstIdentity = identities[0];
  if (firstIdentity === undefined) throw new TypeError("Summary fixture requires one identity");
  const run = await index.startRun({
    source: firstIdentity.source,
    startedAt: "2026-07-23T12:01:00.000Z",
  });
  for (const identity of identities) {
    const document = createTestDocument({ identity });
    await index.replaceSession(run, replacement(identity, identity.nativeId, document));
  }
  await index.finishRun(run, {
    status: "completed",
    finishedAt: "2026-07-23T12:02:00.000Z",
  });
  interruptOwnedRunsAndReleaseWriterLease(database, lease, {
    now: () => new Date("2026-07-23T12:03:00.000Z"),
  });
  return database;
}

function mutateCanonicalTimestamp(
  database: DatabaseSync,
  sessionId: number,
  column: "created_at" | "updated_at",
): void {
  const now = () => new Date("2026-07-23T13:00:00.000Z");
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => `summary-corruption-${column}`,
  });
  try {
    runLeasedImmediateTransaction(database, lease, { now }, () => {
      database
        .prepare(
          `UPDATE sessions_canonical_sessions
           SET ${column} = ?
           WHERE session_id = ?`,
        )
        .run("not-a-canonical-timestamp", sessionId);
    });
  } finally {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: () => new Date("2026-07-23T13:01:00.000Z"),
    });
  }
}

function sessionId(
  database: DatabaseSync,
  identity: ReturnType<typeof createTestIdentity>,
): number {
  const row = findSessionTracking(database, identity);
  const value = row?.session_id;
  const sessionId = typeof value === "bigint" ? Number(value) : value;
  if (typeof sessionId !== "number" || !Number.isSafeInteger(sessionId)) {
    throw new Error("Missing test session ID");
  }
  return sessionId;
}
