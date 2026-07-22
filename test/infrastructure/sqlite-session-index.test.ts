import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { SESSION_INDEX_BATCH_LIMIT } from "../../src/application/ports/session-index.ts";
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
import { encodeSqliteContentDigest } from "../../src/infrastructure/sqlite/sqlite-content-digest.ts";
import { decodeSqliteDocumentDigest } from "../../src/infrastructure/sqlite/sqlite-document-digest.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import { acquireWriterLease } from "../../src/infrastructure/sqlite/writer-lease.ts";

describe("SQLite session index", () => {
  runSessionIndexContract(createFixture);

  test("bounds freshness and tracked pages across 128, 129, and 257 identities", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const source = identity("bounded-page-profile", "seed").source;
      const nativeIds = [
        ...Array.from(
          { length: 252 },
          (_, ordinal) => `session-${String(ordinal).padStart(3, "0")}`,
        ),
        "A",
        "a",
        "é",
        "Ω",
        "😀",
      ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      const identities = nativeIds.map((nativeId) => identity(source.instanceId, nativeId));
      const seedRun = await index.startRun({
        source,
        startedAt: "2026-07-13T09:00:00.000Z",
      });
      for (const [ordinal, sessionIdentity] of identities.entries()) {
        await index.recordFailure(
          seedRun,
          observation(sessionIdentity, `page-revision-${String(ordinal)}`),
          "malformed",
        );
      }
      await finishCompleted(index, seedRun, counts({ discovered: 257, failed: 257 }));

      const run = await index.startRun({
        source,
        startedAt: "2026-07-13T10:00:00.000Z",
      });
      const first = await index.listTrackedIdentitiesPage(run);
      expect(first.identities).toEqual(identities.slice(0, SESSION_INDEX_BATCH_LIMIT));
      expect(first.hasMore).toBe(true);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.identities)).toBe(true);

      const second = await index.listTrackedIdentitiesPage(run, first.identities.at(-1)?.nativeId);
      expect(second.identities).toEqual(
        identities.slice(SESSION_INDEX_BATCH_LIMIT, SESSION_INDEX_BATCH_LIMIT * 2),
      );
      expect(second.hasMore).toBe(true);

      const third = await index.listTrackedIdentitiesPage(run, second.identities.at(-1)?.nativeId);
      expect(third).toEqual({ identities: identities.slice(256), hasMore: false });

      const freshness = await index.getFreshnessBatch(run, first.identities);
      expect(freshness).toHaveLength(SESSION_INDEX_BATCH_LIMIT);
      expect(freshness.map((state) => state.identity)).toEqual(first.identities);
      expect(freshness.every((state) => state.status === "unindexed")).toBe(true);
      expect(Object.isFrozen(freshness)).toBe(true);

      await expect(
        index.getFreshnessBatch(run, identities.slice(0, SESSION_INDEX_BATCH_LIMIT + 1)),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        index.getFreshnessBatch(run, [identities[1]!, identities[0]!]),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        index.getFreshnessBatch(run, [identities[0]!, identities[0]!]),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        index.recordMissingBatch(run, [identity("wrong-page-profile", "wrong-source")]),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(index.listTrackedIdentitiesPage(run, "")).rejects.toBeInstanceOf(TypeError);

      await index.recordMissingBatch(run, first.identities);
      await index.recordMissingBatch(run, [identity(source.instanceId, "zzzz-untracked")]);
      const result = await finishCompleted(
        index,
        run,
        counts({ missing: SESSION_INDEX_BATCH_LIMIT }),
      );
      expect(result.items).toHaveLength(100);
      expect(result.items.map((item) => item.identity)).toEqual(first.identities.slice(0, 100));
      expect(result.items.every((item) => item.outcome === "missing")).toBe(true);
      expect(result.omittedItemCount).toBe(28);
    } finally {
      database.close();
    }
  });

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
      expect(storedDocumentDigest(database)).toEqual(admitted.documentDigest);
      expect(storedDocumentMetrics(database)).toEqual({
        relationCount: 0,
        entryCount: 2,
        segmentCount: 3,
        omittedSegmentCount: 1,
        textUtf8Bytes: Buffer.byteLength(firstText, "utf8") + Buffer.byteLength(secondText, "utf8"),
      });
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

  test("narrows by digest but interns and reuses only exact text", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const sessionIdentity = identity("collision-profile", "collision-session");
      const text = "canonical bucket evidence";
      const contentHash = hashContent(text);
      const collisionText = "forced collision storage fixture";
      const collisionId = insertContentWithDigest(database, contentHash.digest, collisionText);
      const document: SessionDocument = {
        ...minimalDocument(sessionIdentity),
        entries: [entry(0, text), entry(1, text)],
      };
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      const admitted = replacement(sessionIdentity, "collision-a", document);

      await index.replaceSession(run, admitted);

      await expect(index.getDocument(sessionIdentity)).resolves.toEqual(admitted.document);
      const rows = database
        .prepare(
          `SELECT content.content_id, content.text, COUNT(occurrence.content_id) AS occurrences
           FROM sessions_content_values AS content
           LEFT JOIN sessions_content_occurrences AS occurrence
             ON occurrence.content_id = content.content_id
           WHERE content.digest = ?
           GROUP BY content.content_id
           ORDER BY content.content_id`,
        )
        .all(encodeSqliteContentDigest(contentHash.digest));
      expect(rows).toEqual([
        { content_id: collisionId, text: collisionText, occurrences: 0 },
        { content_id: expect.any(Number), text, occurrences: 2 },
      ]);
      expect(ftsCount(database, "canonical")).toBe(1);
      expect(ftsCount(database, "forced")).toBe(1);
      expectFtsIntegrity(database);
      await finishCompleted(index, run, counts({ discovered: 1, updated: 1 }));
    } finally {
      database.close();
    }
  });

  test.each([-1n, 0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n])(
    "preserves full signed SQLite content ID %s through replacement proof",
    async (contentId) => {
      const database = migratedDatabase();
      const index = createIndex(database);
      try {
        const sessionIdentity = identity("signed-content-id-profile", String(contentId));
        const text = `content stored with signed SQLite ID ${contentId}`;
        insertContentAtId(database, contentId, text);
        const run = await index.startRun({
          source: sessionIdentity.source,
          startedAt: "2026-07-13T12:00:00.000Z",
        });
        const admitted = replacement(sessionIdentity, "signed-content-id-a", {
          ...minimalDocument(sessionIdentity),
          entries: [entry(0, text)],
        });

        await index.replaceSession(run, admitted);

        await expect(index.getDocument(sessionIdentity)).resolves.toEqual(admitted.document);
        const statement = database.prepare("SELECT content_id FROM sessions_content_occurrences");
        statement.setReadBigInts(true);
        expect(statement.get()).toEqual({ content_id: contentId });
        expectFtsIntegrity(database);
      } finally {
        database.close();
      }
    },
  );

  test("fails closed when canonical storage contains duplicate exact bucket members", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const sessionIdentity = identity("corrupt-bucket-profile", "corrupt-bucket-session");
      const text = "ambiguous exact bucket evidence";
      const digest = hashContent(text).digest;
      database.exec("DROP TRIGGER sessions_content_values_duplicate_guard");
      insertContentWithDigest(database, digest, text);
      insertContentWithDigest(database, digest, text);
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });

      await expect(
        index.replaceSession(
          run,
          replacement(sessionIdentity, "corrupt-bucket-a", {
            ...minimalDocument(sessionIdentity),
            entries: [entry(0, text)],
          }),
        ),
      ).rejects.toMatchObject({ code: "corrupt-data" });
      await expect(index.getDocument(sessionIdentity)).resolves.toBeUndefined();
      expect(rowCount(database, "sessions_content_values")).toBe(2);
      expectFtsIntegrity(database);
    } finally {
      database.close();
    }
  });

  test.each([
    {
      name: "former content deletion",
      trigger: "sessions_content_values_bd",
    },
    {
      name: "resulting content insertion",
      trigger: "sessions_content_values_ai",
    },
  ])("rolls back when $name fails the affected-row FTS proof", async ({ trigger }) => {
    const database = migratedDatabase();
    let integrityUncertain = false;
    const index = createIndex(database, () => {
      integrityUncertain = true;
    });
    try {
      const sessionIdentity = identity("affected-proof-profile", trigger);
      const baseline = replacement(sessionIdentity, "revision-a", {
        ...minimalDocument(sessionIdentity),
        entries: [entry(0, "last good affected-row evidence")],
      });
      const baselineRun = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      await index.replaceSession(baselineRun, baseline);
      await finishCompleted(index, baselineRun, counts({ discovered: 1, updated: 1 }));
      const replacementRun = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T13:00:00.000Z",
      });
      database.exec(`DROP TRIGGER ${trigger}`);
      const next = replacement(sessionIdentity, "revision-b", {
        ...minimalDocument(sessionIdentity),
        entries: [entry(0, "replacement affected-row evidence")],
      });

      await expect(index.replaceSession(replacementRun, next)).rejects.toMatchObject({
        code: "corrupt-data",
      });

      expect(integrityUncertain).toBe(true);
      await expect(index.getDocument(sessionIdentity)).resolves.toEqual(baseline.document);
      await expect(index.getFreshness(sessionIdentity)).resolves.toEqual({
        status: "stale",
        identity: sessionIdentity,
        lastGood: baseline.observation.revision,
        latest: {
          outcome: "failed",
          revision: next.observation.revision,
          failure: "repository-write",
        },
      });
      expect(ftsCount(database, "good")).toBe(1);
      expect(ftsCount(database, "replacement")).toBe(0);
    } finally {
      database.close();
    }
  });

  test("rolls back when canonical reread disagrees with the admitted digest", async () => {
    const database = migratedDatabase();
    let integrityUncertain = false;
    const index = createIndex(database, () => {
      integrityUncertain = true;
    });
    try {
      const sessionIdentity = identity("readback-proof-profile", "readback-proof-session");
      const baseline = replacement(sessionIdentity, "revision-a", {
        ...minimalDocument(sessionIdentity),
        entries: [entry(0, "retained readback evidence")],
      });
      const baselineRun = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      await index.replaceSession(baselineRun, baseline);
      await finishCompleted(index, baselineRun, counts({ discovered: 1, updated: 1 }));
      const replacementRun = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T13:00:00.000Z",
      });
      database.exec(
        `CREATE TEMP TRIGGER test_corrupt_document_digest
         AFTER INSERT ON sessions_canonical_sessions
         BEGIN
           UPDATE sessions_canonical_sessions
           SET document_digest = zeroblob(32)
           WHERE session_id = new.session_id;
         END`,
      );
      const next = replacement(sessionIdentity, "revision-b", {
        ...minimalDocument(sessionIdentity),
        entries: [entry(0, "replacement readback evidence")],
      });

      await expect(index.replaceSession(replacementRun, next)).rejects.toMatchObject({
        code: "corrupt-data",
      });

      expect(integrityUncertain).toBe(true);
      await expect(index.getDocument(sessionIdentity)).resolves.toEqual(baseline.document);
      expect(storedDocumentDigest(database)).toEqual(baseline.documentDigest);
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
      const baselineContentRows = contentRows(database);
      const baselineDocumentDigest = storedDocumentDigest(database);
      const baselineDocumentMetrics = storedDocumentMetrics(database);
      expect(baselineDocumentDigest).toEqual(baseline.documentDigest);
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
        `CREATE TEMP TRIGGER test_abort_replacement_commit
         BEFORE UPDATE OF last_good_fingerprint_digest ON sessions_session_tracking
         BEGIN
           SELECT RAISE(ABORT, 'forced replacement commit abort');
         END`,
      );

      await expect(index.replaceSession(replacementRun, next)).rejects.toThrow(
        /forced replacement commit abort/u,
      );
      await expect(index.getDocument(sessionIdentity)).resolves.toEqual(baseline.document);
      expect(storedDocumentDigest(database)).toEqual(baselineDocumentDigest);
      expect(storedDocumentMetrics(database)).toEqual(baselineDocumentMetrics);
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
      expect(contentRows(database)).toEqual(baselineContentRows);
      expect(ftsCount(database, "old")).toBe(1);
      expect(ftsCount(database, "replacement")).toBe(0);
      expectFtsIntegrity(database);

      database.exec("DROP TRIGGER test_abort_replacement_commit");
      await index.replaceSession(replacementRun, next);
      await expect(index.getDocument(sessionIdentity)).resolves.toEqual(next.document);
      expect(storedDocumentDigest(database)).toEqual(next.documentDigest);
      expect(storedDocumentMetrics(database)).toEqual({
        relationCount: 0,
        entryCount: 2,
        segmentCount: 2,
        omittedSegmentCount: 0,
        textUtf8Bytes:
          Buffer.byteLength("replacement exclusive token", "utf8") +
          Buffer.byteLength("second new entry", "utf8"),
      });
      expect(next.documentDigest).not.toEqual(baselineDocumentDigest);
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

  test("reads stored attribution directly but fails full reads on a mismatching digest", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const sessionIdentity = identity("digest-corruption-profile", "digest-corruption-session");
      const admitted = replacement(
        sessionIdentity,
        "revision-a",
        completeDocument(sessionIdentity),
      );
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      await index.replaceSession(run, admitted);
      database
        .prepare("UPDATE sessions_canonical_sessions SET document_digest = zeroblob(32)")
        .run();

      await expect(index.getSummary(sessionIdentity)).resolves.toMatchObject({
        documentDigest: { digest: "0".repeat(64) },
      });
      await expect(index.getDocument(sessionIdentity)).rejects.toMatchObject({
        code: "corrupt-data",
      });
      await expect(index.getSession(sessionIdentity)).rejects.toMatchObject({
        code: "corrupt-data",
      });
    } finally {
      database.close();
    }
  });

  test.each([
    {
      name: "missing metrics",
      corrupt(database: DatabaseSync) {
        database.prepare("DELETE FROM sessions_canonical_document_metrics").run();
      },
    },
    {
      name: "inconsistent metrics",
      corrupt(database: DatabaseSync) {
        database
          .prepare(
            `UPDATE sessions_canonical_document_metrics
             SET text_utf8_bytes = text_utf8_bytes + 1`,
          )
          .run();
      },
    },
  ])("fails complete document reads for $name", async ({ corrupt }) => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const sessionIdentity = identity("metrics-corruption-profile", "metrics-session");
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      await index.replaceSession(
        run,
        replacement(sessionIdentity, "revision-a", completeDocument(sessionIdentity)),
      );
      corrupt(database);

      await expect(index.getDocument(sessionIdentity)).rejects.toMatchObject({
        code: "corrupt-data",
      });
      await expect(index.getSession(sessionIdentity)).rejects.toMatchObject({
        code: "corrupt-data",
      });
    } finally {
      database.close();
    }
  });

  test.each([
    {
      name: "missing capture time",
      mutate(database: DatabaseSync) {
        database.prepare("UPDATE sessions_session_tracking SET captured_at = NULL").run();
      },
    },
    {
      name: "missing effective source observation",
      mutate(database: DatabaseSync) {
        database.prepare("UPDATE sessions_source_instances SET coverage_observed_at = NULL").run();
      },
    },
    {
      name: "malformed last-good adapter version",
      mutate(database: DatabaseSync) {
        database
          .prepare("UPDATE sessions_session_tracking SET last_good_adapter_version = ''")
          .run();
      },
    },
  ])("fails retained summary reads for $name", async ({ mutate }) => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const sessionIdentity = identity("attribution-corruption-profile", "retained-session");
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      await index.replaceSession(
        run,
        replacement(sessionIdentity, "revision-a", minimalDocument(sessionIdentity)),
      );
      mutate(database);

      await expect(index.getSummary(sessionIdentity)).rejects.toMatchObject({
        code: "corrupt-data",
      });
    } finally {
      database.close();
    }
  });

  test("prunes only former unreferenced content during replacement", async () => {
    const database = migratedDatabase();
    const index = createIndex(database);
    try {
      const targetIdentity = identity("cleanup-profile", "target");
      const sharingIdentity = identity("cleanup-profile", "sharing");
      const obsoleteText = "obsoleteonlymarker target evidence";
      const sharedText = "sharedmarker recurring evidence";
      const reintroducedText = "reintroducedmarker retained evidence";
      const replacementText = "replacementmarker new evidence";
      const orphanText = "orphansentinelmarker unrelated evidence";
      const targetDocument: SessionDocument = {
        ...minimalDocument(targetIdentity),
        entries: [entry(0, obsoleteText), entry(1, sharedText), entry(2, reintroducedText)],
      };
      const sharingDocument: SessionDocument = {
        ...minimalDocument(sharingIdentity),
        entries: [entry(0, sharedText)],
      };
      const run = await index.startRun({
        source: targetIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      await index.replaceSession(run, replacement(targetIdentity, "target-a", targetDocument));
      await index.replaceSession(run, replacement(sharingIdentity, "sharing-a", sharingDocument));
      insertOrphanContent(database, orphanText);
      const reintroducedContentId = contentIdForText(database, reintroducedText);

      const nextDocument: SessionDocument = {
        ...minimalDocument(targetIdentity),
        entries: [entry(0, reintroducedText), entry(1, replacementText)],
      };
      await index.replaceSession(run, replacement(targetIdentity, "target-b", nextDocument));

      expect(contentOccurrenceCount(database, obsoleteText)).toBeUndefined();
      expect(contentOccurrenceCount(database, sharedText)).toBe(1);
      expect(contentOccurrenceCount(database, reintroducedText)).toBe(1);
      expect(contentIdForText(database, reintroducedText)).toBe(reintroducedContentId);
      expect(contentOccurrenceCount(database, replacementText)).toBe(1);
      expect(contentOccurrenceCount(database, orphanText)).toBe(0);
      expect(rowCount(database, "sessions_content_values")).toBe(4);
      expect(ftsCount(database, "obsoleteonlymarker")).toBe(0);
      expect(ftsCount(database, "sharedmarker")).toBe(1);
      expect(ftsCount(database, "reintroducedmarker")).toBe(1);
      expect(ftsCount(database, "replacementmarker")).toBe(1);
      expect(ftsCount(database, "orphansentinelmarker")).toBe(1);
      expectFtsIntegrity(database);
      await finishCompleted(index, run, counts({ discovered: 3, updated: 3 }));
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

      await index.recordMissingBatch(run, [secondIdentity]);
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

  test("fails closed when a source coverage update affects no row", async () => {
    const database = migratedDatabase();
    let integrityUncertain = false;
    const index = createIndex(database, () => {
      integrityUncertain = true;
    });
    try {
      const source = identity("coverage-count-profile", "seed").source;
      const seedRun = await index.startRun({
        source,
        startedAt: "2026-07-13T10:00:00.000Z",
      });
      await finishCompleted(index, seedRun, counts());
      database.exec(
        `CREATE TEMP TRIGGER test_ignore_source_coverage
         BEFORE UPDATE OF coverage_status, coverage_observed_at ON sessions_source_instances
         BEGIN
           SELECT RAISE(IGNORE);
         END`,
      );

      await expect(
        index.startRun({ source, startedAt: "2026-07-13T11:00:00.000Z" }),
      ).rejects.toMatchObject({ code: "corrupt-data" });

      expect(integrityUncertain).toBe(true);
      expect(rowCount(database, "sessions_index_runs")).toBe(1);
    } finally {
      database.close();
    }
  });

  test("rolls back when a run counter update affects no row", async () => {
    const database = migratedDatabase();
    let integrityUncertain = false;
    const index = createIndex(database, () => {
      integrityUncertain = true;
    });
    try {
      const sessionIdentity = identity("run-count-profile", "run-count-session");
      const admitted = replacement(sessionIdentity, "revision-a", minimalDocument(sessionIdentity));
      const baselineRun = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T10:00:00.000Z",
      });
      await index.replaceSession(baselineRun, admitted);
      await finishCompleted(index, baselineRun, counts({ discovered: 1, updated: 1 }));
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T11:00:00.000Z",
      });
      database.exec(
        `CREATE TEMP TRIGGER test_ignore_run_count
         BEFORE UPDATE OF unchanged_count ON sessions_index_runs
         BEGIN
           SELECT RAISE(IGNORE);
         END`,
      );

      await expect(index.recordUnchangedBatch(run, [admitted.observation])).rejects.toMatchObject({
        code: "corrupt-data",
      });

      expect(integrityUncertain).toBe(true);
      await expect(index.getFreshness(sessionIdentity)).resolves.toEqual({
        status: "current",
        identity: sessionIdentity,
        lastGood: admitted.observation.revision,
        latest: { outcome: "indexed", revision: admitted.observation.revision },
      });
      expect(
        database
          .prepare(
            "SELECT discovered_count, unchanged_count FROM sessions_index_runs WHERE run_id = ?",
          )
          .get(Number(run.id)),
      ).toEqual({ discovered_count: 0, unchanged_count: 0 });
    } finally {
      database.close();
    }
  });

  test("rolls back whole unchanged and missing batches when one member fails", async () => {
    const database = migratedDatabase();
    let integrityUncertain = false;
    const index = createIndex(database, () => {
      integrityUncertain = true;
    });
    try {
      const firstIdentity = identity("atomic-batch-profile", "first");
      const secondIdentity = identity("atomic-batch-profile", "second");
      const first = replacement(firstIdentity, "first-a", minimalDocument(firstIdentity));
      const second = replacement(secondIdentity, "second-a", minimalDocument(secondIdentity));
      const seedRun = await index.startRun({
        source: firstIdentity.source,
        startedAt: "2026-07-13T09:00:00.000Z",
      });
      await index.replaceSession(seedRun, first);
      await index.replaceSession(seedRun, second);
      await finishCompleted(index, seedRun, counts({ discovered: 2, updated: 2 }));
      const run = await index.startRun({
        source: firstIdentity.source,
        startedAt: "2026-07-13T10:00:00.000Z",
      });

      await expect(
        index.recordUnchangedBatch(run, [
          first.observation,
          observation(secondIdentity, "second-b"),
        ]),
      ).rejects.toMatchObject({ code: "invalid-state" });
      expect(integrityUncertain).toBe(true);
      await expect(index.getFreshnessBatch(run, [firstIdentity, secondIdentity])).resolves.toEqual([
        {
          status: "current",
          identity: firstIdentity,
          lastGood: first.observation.revision,
          latest: { outcome: "indexed", revision: first.observation.revision },
        },
        {
          status: "current",
          identity: secondIdentity,
          lastGood: second.observation.revision,
          latest: { outcome: "indexed", revision: second.observation.revision },
        },
      ]);
      expect(readRunMutationCounts(database, run.id)).toEqual({
        discovered_count: 0,
        unchanged_count: 0,
        missing_count: 0,
        omitted_item_count: 0,
      });

      integrityUncertain = false;
      database.exec(
        `CREATE TEMP TRIGGER test_abort_missing_batch
         BEFORE UPDATE OF presence_status ON sessions_session_tracking
         WHEN old.native_id = 'second'
         BEGIN
           SELECT RAISE(ABORT, 'forced missing batch failure');
         END`,
      );
      await expect(index.recordMissingBatch(run, [firstIdentity, secondIdentity])).rejects.toThrow(
        /forced missing batch failure/u,
      );
      expect(integrityUncertain).toBe(true);
      expect(
        database
          .prepare(
            `SELECT native_id, presence_status
             FROM sessions_session_tracking
             ORDER BY native_id COLLATE BINARY`,
          )
          .all(),
      ).toEqual([
        { native_id: "first", presence_status: "present" },
        { native_id: "second", presence_status: "present" },
      ]);
      expect(readRunMutationCounts(database, run.id)).toEqual({
        discovered_count: 0,
        unchanged_count: 0,
        missing_count: 0,
        omitted_item_count: 0,
      });
      expect(rowCount(database, "sessions_index_run_items")).toBe(0);
      database.exec("DROP TRIGGER test_abort_missing_batch");
      await finishCompleted(index, run, counts());
    } finally {
      database.close();
    }
  });

  test("rolls back when a tracking update affects no row", async () => {
    const database = migratedDatabase();
    let integrityUncertain = false;
    const index = createIndex(database, () => {
      integrityUncertain = true;
    });
    try {
      const sessionIdentity = identity("tracking-count-profile", "tracking-count-session");
      const admitted = replacement(sessionIdentity, "revision-a", minimalDocument(sessionIdentity));
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T10:00:00.000Z",
      });
      await index.replaceSession(run, admitted);
      database.exec(
        `CREATE TEMP TRIGGER test_ignore_tracking_update
         BEFORE UPDATE OF presence_status ON sessions_session_tracking
         BEGIN
           SELECT RAISE(IGNORE);
         END`,
      );

      await expect(index.recordMissingBatch(run, [sessionIdentity])).rejects.toMatchObject({
        code: "corrupt-data",
      });

      expect(integrityUncertain).toBe(true);
      await expect(index.getFreshness(sessionIdentity)).resolves.toMatchObject({
        status: "current",
      });
      expect(
        database
          .prepare("SELECT missing_count FROM sessions_index_runs WHERE run_id = ?")
          .get(Number(run.id)),
      ).toEqual({ missing_count: 0 });
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

function createIndex(database: DatabaseSync, onIntegrityUncertain?: () => void) {
  const now = () => new Date("2026-07-13T11:00:00.000Z");
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "synthetic-test-owner",
  });
  return createCoordinatedSqliteSessionIndex(database, {
    lease,
    now,
    ...(onIntegrityUncertain === undefined ? {} : { onIntegrityUncertain }),
  });
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

function storedDocumentDigest(database: DatabaseSync) {
  const row = database
    .prepare(
      `SELECT document_digest_scheme, document_digest
       FROM sessions_canonical_sessions`,
    )
    .get() as
    | { readonly document_digest_scheme?: unknown; readonly document_digest?: unknown }
    | undefined;
  return decodeSqliteDocumentDigest(row?.document_digest_scheme, row?.document_digest);
}

function storedDocumentMetrics(database: DatabaseSync) {
  const row = database
    .prepare(
      `SELECT relation_count, entry_count, segment_count,
              omitted_segment_count, text_utf8_bytes
       FROM sessions_canonical_document_metrics`,
    )
    .get() as
    | {
        readonly relation_count: number;
        readonly entry_count: number;
        readonly segment_count: number;
        readonly omitted_segment_count: number;
        readonly text_utf8_bytes: number;
      }
    | undefined;
  if (row === undefined) return undefined;
  return {
    relationCount: row.relation_count,
    entryCount: row.entry_count,
    segmentCount: row.segment_count,
    omittedSegmentCount: row.omitted_segment_count,
    textUtf8Bytes: row.text_utf8_bytes,
  };
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

function insertOrphanContent(database: DatabaseSync, text: string): void {
  const contentHash = hashContent(text);
  insertContentWithDigest(database, contentHash.digest, text);
}

function insertContentWithDigest(database: DatabaseSync, digest: string, text: string): number {
  const row = database
    .prepare(
      `INSERT INTO sessions_content_values (digest, text)
       VALUES (?, ?)
       RETURNING content_id`,
    )
    .get(encodeSqliteContentDigest(digest), text) as {
    readonly content_id: number | bigint;
  };
  return Number(row.content_id);
}

function insertContentAtId(database: DatabaseSync, contentId: bigint, text: string): void {
  database
    .prepare(
      `INSERT INTO sessions_content_values (content_id, digest, text)
       VALUES (?, ?, ?)`,
    )
    .run(contentId, encodeSqliteContentDigest(hashContent(text).digest), text);
}

function contentOccurrenceCount(database: DatabaseSync, text: string): number | undefined {
  const row = database
    .prepare(
      `SELECT COUNT(occurrence.content_id) AS occurrence_count
       FROM sessions_content_values AS content
       LEFT JOIN sessions_content_occurrences AS occurrence
         ON occurrence.content_id = content.content_id
       WHERE content.text = ?
       GROUP BY content.content_id`,
    )
    .get(text) as { readonly occurrence_count: number | bigint } | undefined;
  return row === undefined ? undefined : Number(row.occurrence_count);
}

function contentIdForText(database: DatabaseSync, text: string): number | undefined {
  const row = database
    .prepare(
      `SELECT content_id
       FROM sessions_content_values
       WHERE text = ?`,
    )
    .get(text) as { readonly content_id: number | bigint } | undefined;
  return row === undefined ? undefined : Number(row.content_id);
}

function contentRows(database: DatabaseSync): readonly Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT content_id, hex(digest) AS digest, text
       FROM sessions_content_values
       ORDER BY content_id`,
    )
    .all();
}

function rowCount(database: DatabaseSync, table: string): number {
  if (!/^sessions_[a-z_]+$/u.test(table)) throw new TypeError("Unsafe test table name");
  const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
    readonly count: number | bigint;
  };
  return Number(row.count);
}

function readRunMutationCounts(database: DatabaseSync, runId: string): Record<string, unknown> {
  return database
    .prepare(
      `SELECT discovered_count, unchanged_count, missing_count, omitted_item_count
       FROM sessions_index_runs
       WHERE run_id = ?`,
    )
    .get(Number(runId)) as Record<string, unknown>;
}
