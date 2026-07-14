import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  admittedReplacement,
  completeDocument,
  counts,
  entry,
  identity,
  minimalDocument,
  observation,
  replacement,
  runSessionIndexContract,
  finishCompleted,
  type SessionIndexContractFixture,
} from "../contracts/session-index.contract.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import type { SessionDocument } from "../../src/domain/session.ts";
import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import { acquireWriterLease } from "../../src/infrastructure/sqlite/writer-lease.ts";

describe("SQLite session index", () => {
  runSessionIndexContract(createFixture);

  test("round-trips tool identity and ordered text/omitted evidence without interning omissions", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const sessionIdentity = identity("canonical-evidence-profile", "mixed-evidence");
      const firstText = "before omitted evidence";
      const secondText = "after omitted evidence";
      const document: SessionDocument = {
        ...minimalDocument(sessionIdentity),
        entries: [
          {
            ordinal: 0,
            kind: "tool-call",
            actor: "model",
            toolCallId: "call-1",
            toolName: "exec_command",
            toolNamespace: "functions",
            sourceLocator: { uri: "memory://mixed/0" },
            content: [
              {
                kind: "text",
                ordinal: 0,
                text: firstText,
                contentHash: hashContent(firstText),
                origin: "model",
                originConfidence: "high",
                sourceMetadata: {},
              },
              {
                kind: "omitted",
                ordinal: 1,
                contentClass: "image",
                sourceType: "input-image",
                origin: "human",
                originConfidence: "high",
                sourceMetadata: {},
              },
              {
                kind: "text",
                ordinal: 2,
                text: secondText,
                contentHash: hashContent(secondText),
                origin: "model",
                originConfidence: "high",
                sourceMetadata: {},
              },
            ],
          },
          {
            ordinal: 1,
            kind: "tool-result",
            actor: "tool",
            relatedEntryOrdinal: 0,
            toolCallId: "call-1",
            sourceLocator: { uri: "memory://mixed/1" },
            content: [],
          },
        ],
      };
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      const admitted = replacement(sessionIdentity, "mixed-a", document);

      await index.replaceSession(run, admitted);

      await expect(index.getDocument(sessionIdentity)).resolves.toEqual(admitted.document);
      expect(rowCount(database, "sessions_content_values")).toBe(2);
      expect(ftsCount(database, "before")).toBe(1);
      expect(ftsCount(database, "input")).toBe(0);
      expect(
        database
          .prepare(
            `SELECT segment_ordinal,
                    content_id IS NOT NULL AS has_content,
                    content_class,
                    source_type
             FROM sessions_content_occurrences
             ORDER BY segment_ordinal`,
          )
          .all(),
      ).toEqual([
        { segment_ordinal: 0, has_content: 1, content_class: null, source_type: null },
        {
          segment_ordinal: 1,
          has_content: 0,
          content_class: "image",
          source_type: "input-image",
        },
        { segment_ordinal: 2, has_content: 1, content_class: null, source_type: null },
      ]);
      await finishCompleted(index, run, counts({ discovered: 1, updated: 1 }));
    } finally {
      database.close();
    }
  });

  test("rolls back a forced replacement failure, records staleness, and retries cleanly", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const sessionIdentity = identity("rollback-profile", "rollback-session");
      const baseline = replacement(
        sessionIdentity,
        "revision-a",
        completeDocument(sessionIdentity),
      );
      const baselineRun = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      await index.replaceSession(baselineRun, baseline);
      expect(
        database
          .prepare(
            `SELECT source_metadata_json
             FROM sessions_content_occurrences
             WHERE entry_ordinal = 0 AND segment_ordinal = 0`,
          )
          .get(),
      ).toEqual({ source_metadata_json: '{"10":"ten","2":"two"}' });
      await finishCompleted(index, baselineRun, counts({ discovered: 1, updated: 1 }));

      const nextObservation = observation(sessionIdentity, "revision-b");
      const nextDocument: SessionDocument = {
        ...minimalDocument(sessionIdentity),
        entries: [entry(0, "replacement exclusive token"), entry(1, "second new entry")],
      };
      const next = admittedReplacement(nextObservation, nextDocument);
      const replacementRun = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T13:00:00.000Z",
      });
      database.exec(
        `CREATE TEMP TRIGGER test_abort_replacement
         BEFORE INSERT ON sessions_entries
         WHEN new.ordinal = 1
         BEGIN
           SELECT RAISE(ABORT, 'forced replacement abort');
         END`,
      );

      await expect(index.replaceSession(replacementRun, next)).rejects.toThrow(
        /forced replacement abort/u,
      );
      await expect(index.getDocument(sessionIdentity)).resolves.toEqual(baseline.document);
      await expect(index.getFreshness(sessionIdentity)).resolves.toEqual({
        status: "stale",
        identity: sessionIdentity,
        lastGood: baseline.observation.revision,
        latest: {
          outcome: "failed",
          revision: nextObservation.revision,
          failure: "repository-write",
        },
      });
      expect(ftsCount(database, "old")).toBe(1);
      expect(ftsCount(database, "replacement")).toBe(0);
      expectFtsIntegrity(database);

      database.exec("DROP TRIGGER test_abort_replacement");
      await index.replaceSession(replacementRun, next);
      await expect(index.getDocument(sessionIdentity)).resolves.toEqual(next.document);
      expect(ftsCount(database, "old")).toBe(0);
      expect(ftsCount(database, "replacement")).toBe(1);
      expectFtsIntegrity(database);
      await finishCompleted(
        index,
        replacementRun,
        counts({ discovered: 2, updated: 1, failed: 1, stale: 1 }),
      );
    } finally {
      database.close();
    }
  });

  test("retains shared content when its session becomes missing", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const firstIdentity = identity("shared-profile", "first");
      const secondIdentity = identity("shared-profile", "second");
      const sharedText = "shared recurrence evidence";
      const firstDocument: SessionDocument = {
        ...minimalDocument(firstIdentity),
        entries: [entry(0, sharedText)],
      };
      const secondDocument: SessionDocument = {
        ...minimalDocument(secondIdentity),
        entries: [entry(0, sharedText)],
      };
      const run = await index.startRun({
        source: firstIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      await index.replaceSession(run, replacement(firstIdentity, "first-a", firstDocument));
      await index.replaceSession(run, replacement(secondIdentity, "second-a", secondDocument));

      expect(rowCount(database, "sessions_content_values")).toBe(1);
      expect(rowCount(database, "sessions_content_occurrences")).toBe(2);
      expect(ftsCount(database, "recurrence")).toBe(1);

      await index.replaceSession(
        run,
        replacement(firstIdentity, "first-b", minimalDocument(firstIdentity)),
      );
      expect(rowCount(database, "sessions_content_values")).toBe(1);
      expect(rowCount(database, "sessions_content_occurrences")).toBe(1);
      expect(ftsCount(database, "recurrence")).toBe(1);

      await index.recordMissing(run, secondIdentity);
      expect(rowCount(database, "sessions_content_values")).toBe(1);
      expect(rowCount(database, "sessions_content_occurrences")).toBe(1);
      expect(ftsCount(database, "recurrence")).toBe(1);
      expectFtsIntegrity(database);
      await finishCompleted(index, run, counts({ discovered: 3, updated: 3, missing: 1 }));
    } finally {
      database.close();
    }
  });

  test("caps detailed failures, keeps exact counts, and retains twenty finished runs", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const source = identity("retention-profile", "seed").source;
      const failureRun = await index.startRun({
        source,
        startedAt: "2026-07-13T10:00:00.000Z",
      });
      for (let ordinal = 0; ordinal < 105; ordinal += 1) {
        const failedIdentity = identity(source.instanceId, `failed-${ordinal}`);
        await index.recordFailure(
          failureRun,
          observation(failedIdentity, `revision-${ordinal}`),
          "malformed",
        );
      }
      expect(rowCount(database, "sessions_index_run_items")).toBe(100);
      expect(
        database
          .prepare(
            `SELECT failed_count, stale_count, omitted_item_count
             FROM sessions_index_runs
             WHERE run_id = ?`,
          )
          .get(Number(failureRun.id)),
      ).toEqual({ failed_count: 105, stale_count: 0, omitted_item_count: 5 });
      const failureResult = await index.finishRun(failureRun, {
        status: "completed",
        finishedAt: "2026-07-13T15:00:00.000Z",
      });
      expect(failureResult).toMatchObject({
        status: "completed",
        counts: { discovered: 105, failed: 105, stale: 0 },
        omittedItemCount: 5,
      });
      expect(failureResult.items).toHaveLength(100);
      expect(failureResult.items[0]).toMatchObject({
        identity: { nativeId: "failed-0" },
        outcome: "failed",
        failure: "malformed",
      });
      expect(failureResult.items[99]).toMatchObject({
        identity: { nativeId: "failed-99" },
        outcome: "failed",
        failure: "malformed",
      });
      expect(Object.isFrozen(failureResult)).toBe(true);
      expect(Object.isFrozen(failureResult.items)).toBe(true);

      const activeRun = await index.startRun({
        source,
        startedAt: "2026-07-13T11:00:00.000Z",
      });
      const durableIdentity = identity(source.instanceId, "durable-session");
      const durableRun = await index.startRun({
        source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      const durableReplacement = replacement(
        durableIdentity,
        "durable-revision",
        minimalDocument(durableIdentity),
      );
      await index.replaceSession(durableRun, durableReplacement);
      await finishCompleted(index, durableRun, counts({ discovered: 1, updated: 1 }));
      const otherSource = identity("other-retention-profile", "other").source;
      const otherRun = await index.startRun({
        source: otherSource,
        startedAt: "2026-07-13T12:30:00.000Z",
      });
      const otherResult = await index.finishRun(otherRun, {
        status: "completed",
        finishedAt: "2026-07-13T12:31:00.000Z",
      });
      expect(otherResult.counts).toEqual(counts());
      for (let ordinal = 0; ordinal < 25; ordinal += 1) {
        const day = String(ordinal + 1).padStart(2, "0");
        const run = await index.startRun({
          source,
          startedAt: `2026-07-${day}T12:00:00.000Z`,
        });
        const result = await index.finishRun(run, {
          status: "completed",
          finishedAt: `2026-08-${day}T12:00:00.000Z`,
        });
        expect(result.counts).toEqual(counts());
      }

      expect(
        database
          .prepare(
            `SELECT
               SUM(run.status = 'active') AS active_count,
               SUM(run.status <> 'active') AS finished_count
             FROM sessions_index_runs AS run
             JOIN sessions_source_instances AS source
               ON source.source_instance_id = run.source_instance_id
             WHERE source.instance_id = ?`,
          )
          .get(source.instanceId),
      ).toEqual({ active_count: 1, finished_count: 20 });
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM sessions_index_runs AS run
             JOIN sessions_source_instances AS source
               ON source.source_instance_id = run.source_instance_id
             WHERE source.instance_id = ? AND run.status <> 'active'`,
          )
          .get(otherSource.instanceId),
      ).toEqual({ count: 1 });
      await expect(index.getFreshness(durableIdentity)).resolves.toEqual({
        status: "current",
        identity: durableIdentity,
        lastGood: durableReplacement.observation.revision,
        latest: { outcome: "indexed", revision: durableReplacement.observation.revision },
      });
      await finishCompleted(index, activeRun, counts());
    } finally {
      database.close();
    }
  });

  test("rejects a run from another source before recording any observation", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const first = identity("source-one", "one");
      const second = identity("source-two", "two");
      const run = await index.startRun({
        source: first.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });

      await expect(
        index.recordFailure(run, observation(second, "revision-a"), "malformed"),
      ).rejects.toMatchObject({ code: "invalid-run" });
      expect(rowCount(database, "sessions_session_tracking")).toBe(0);
      await finishCompleted(index, run, counts());
    } finally {
      database.close();
    }
  });
});

function createFixture(): SessionIndexContractFixture {
  const database = migratedDatabase();
  return {
    index: createIndex(database),
    async close() {
      database.close();
    },
  };
}

function createIndex(database: DatabaseSync) {
  const now = () => new Date("2026-07-13T11:00:00.000Z");
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "synthetic-test-owner",
  });
  return createCoordinatedSqliteSessionIndex(database, { lease, now });
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
