import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../../src/application/session-query-error.ts";
import {
  createSessionListQuery,
  createSessionSearchQuery,
} from "../../src/domain/session-query.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import type { SessionDocument } from "../../src/domain/session.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { readQueryRevision } from "../../src/infrastructure/sqlite/query-cursor.ts";
import {
  createCoordinatedSqliteSessionIndex,
  createSqliteSessionIndexReader,
} from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import { createSqliteSessionQuery } from "../../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  runLeasedImmediateTransaction,
  type WriterLeaseIdentity,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import {
  clearWriterRecoveryReceiptInTransaction,
  initializeWriterRecoveryReceiptInTransaction,
} from "../../src/infrastructure/sqlite/writer-recovery-receipt.ts";
import { replacement } from "../contracts/session-index.contract.ts";
import {
  sessionQueryCorpusDocuments,
  sessionQueryCorpusIdentity,
} from "../fixtures/session-query-corpus.ts";
import { createTestDocument, createTestEntry, createTestSegment } from "../fixtures/session.ts";

describe("SQLite session query", () => {
  test("reports registered coverage on no-tracking and no-hit list pages", async () => {
    const database = migratedDatabase();
    try {
      database
        .prepare(
          `INSERT INTO sessions_source_instances (
             kind, instance_id, coverage_status, coverage_observed_at
           ) VALUES ('synthetic-empty', 'complete', 'complete', ?),
                    ('synthetic-empty', 'unknown', 'unknown', ?)`,
        )
        .run("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:00.000Z");
      const repository = createSqliteSessionQuery(database);

      const complete = await repository.list(
        createSessionListQuery({
          filter: { source: "synthetic-empty", instance: "complete", nativeId: "absent" },
          limit: 20,
        }),
      );
      expect(complete.sessions).toEqual([]);
      expect(complete.captureScope).toMatchObject({
        status: "complete",
        trackedSessions: 0,
        sourceCoverage: { complete: 1, unknown: 0 },
      });

      const unknown = await repository.list(
        createSessionListQuery({
          filter: { source: "synthetic-empty", instance: "unknown", nativeId: "absent" },
          limit: 20,
        }),
      );
      expect(unknown.sessions).toEqual([]);
      expect(unknown.captureScope).toMatchObject({
        status: "incomplete",
        trackedSessions: 0,
        sourceCoverage: { complete: 0, unknown: 1 },
      });
    } finally {
      database.close();
    }
  });

  test("searches literal special text and returns match-centered bounded evidence", async () => {
    const fixture = await seededQueryFixture();
    try {
      const repository = createSqliteSessionQuery(fixture.database);
      const special = await repository.search(
        createSessionSearchQuery({
          text: "OR /tmp/Project/File.ts",
          limit: 20,
          context: 0,
        }),
      );
      expect(special.hits).toHaveLength(1);
      expect(special.hits[0]?.entry).toMatchObject({
        kind: "tool-call",
        toolName: "exec_command",
        toolNamespace: "functions",
      });
      expect(special.hits[0]?.snippet.text).toContain("/tmp/Project/File.ts");
      expect(special.hits[0]?.snippet.contentHash).toEqual(
        hashContent("invoke recurrence OR /tmp/Project/File.ts"),
      );

      const unicodeWhitespace = await repository.search(
        createSessionSearchQuery({ text: "alpha\u0085beta", limit: 20, context: 0 }),
      );
      expect(unicodeWhitespace.hits.map(({ entry }) => entry.ordinal)).toEqual([0]);

      const late = await repository.search(
        createSessionSearchQuery({ text: "MAGIC_LATE_MATCH", limit: 20, context: 0 }),
      );
      expect(late.hits).toHaveLength(1);
      expect(late.hits[0]?.snippet.text).toContain("MAGIC_LATE_MATCH");
      expect(late.hits[0]?.snippet.truncated).toBe(true);
      expect(Buffer.byteLength(late.hits[0]?.snippet.text ?? "", "utf8")).toBeLessThanOrEqual(512);

      const controls = await repository.search(
        createSessionSearchQuery({ text: "CONTROL_MATCH", limit: 20, context: 0 }),
      );
      expect(controls.hits[0]?.snippet.text).toContain("before\u0001\u0002CONTROL_MATCH after");

      for (const term of ["GIANT_SUFFIX_MATCH", "GIANT_PREFIX_MATCH"]) {
        const giant = await repository.search(
          createSessionSearchQuery({ text: term, limit: 20, context: 0 }),
        );
        expect(giant.hits[0]?.snippet.text).toContain(term);
        expect(Buffer.byteLength(giant.hits[0]?.snippet.text ?? "", "utf8")).toBeLessThanOrEqual(
          512,
        );
      }
      const collision = await repository.search(
        createSessionSearchQuery({ text: "AMBIGUOUS_LATE_MATCH", limit: 20, context: 0 }),
      );
      expect(collision.hits[0]?.snippet.text).toContain("AMBIGUOUS_LATE_MATCH");

      const emptyLiteral = await repository.search(
        createSessionSearchQuery({ text: "---", limit: 20, context: 0 }),
      );
      expect(emptyLiteral).toMatchObject({
        hits: [],
        support: {
          occurrences: 0,
          uniqueContent: 0,
          uniqueKnownRoots: 0,
          unknownLineageSessions: 0,
        },
      });
      expect(emptyLiteral.captureScope).toMatchObject({
        status: "complete",
        trackedSessions: 2,
        sourceCoverage: { complete: 1, unknown: 0 },
        unassessedFilters: ["searchText"],
      });
    } finally {
      fixture.database.close();
    }
  });

  test("groups entry hits and keeps recurrence units and lineage support distinct", async () => {
    const fixture = await seededQueryFixture();
    try {
      const repository = createSqliteSessionQuery(fixture.database);
      const query = createSessionSearchQuery({
        text: "shared recurrence",
        limit: 20,
        context: 0,
      });
      const first = await repository.search(query);
      const repeated = await repository.search(query);

      expect(first).toEqual(repeated);
      expect(first.hits.map((hit) => hit.session.identity.nativeId)).toEqual([
        "a-session",
        "b-session",
      ]);
      expect(first.hits.map((hit) => hit.snippet.additionalMatchingSegments)).toEqual([0, 1]);
      expect(first.support).toEqual({
        occurrences: 3,
        uniqueContent: 1,
        uniqueKnownRoots: 1,
        unknownLineageSessions: 1,
      });
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.hits)).toBe(true);
      expect(Object.isFrozen(first.hits[0]?.session.identity.source)).toBe(true);
    } finally {
      fixture.database.close();
    }
  });

  test("preserves a selected snippet containing the first deterministic marker candidate", async () => {
    const database = migratedDatabase();
    const marker = firstSnippetMarkerCandidate(database);
    const selectedText = `before ${marker.start} selectedevidence ${marker.end} after`;
    await seedQueryDocuments(database, [markerDocument("selected", selectedText)]);
    try {
      const repository = createSqliteSessionQuery(database);
      const result = await repository.search(
        createSessionSearchQuery({ text: "selectedevidence", limit: 1, context: 0 }),
      );

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.snippet).toEqual({
        segmentOrdinal: 0,
        origin: "human",
        originConfidence: "high",
        contentHash: hashContent(selectedText),
        text: selectedText,
        truncated: false,
        additionalMatchingSegments: 0,
      });
    } finally {
      database.close();
    }
  });

  test("does not let unselected marker-like text change the selected output", async () => {
    const withoutCollision = migratedDatabase();
    const withCollision = migratedDatabase();
    const selectedText = "selectedevidence remains exact";
    const marker = firstSnippetMarkerCandidate(withCollision);
    await seedQueryDocuments(withoutCollision, [
      markerDocument("selected", selectedText),
      markerDocument("unselected", "ordinary background evidence"),
    ]);
    await seedQueryDocuments(withCollision, [
      markerDocument("selected", selectedText),
      markerDocument("unselected", `background ${marker.start} marker-like ${marker.end} evidence`),
    ]);
    try {
      const query = createSessionSearchQuery({ text: "selectedevidence", limit: 1, context: 0 });
      const ordinary = await createSqliteSessionQuery(withoutCollision).search(query);
      const collision = await createSqliteSessionQuery(withCollision).search(query);

      expect(collision).toEqual(ordinary);
      expect(collision.hits[0]?.snippet.text).toBe(selectedText);
    } finally {
      withoutCollision.close();
      withCollision.close();
    }
  });

  test("preserves complete shared-content results across bounded pages", async () => {
    const fixture = await seededQueryFixture();
    try {
      const repository = createSqliteSessionQuery(fixture.database);
      const firstQuery = createSessionSearchQuery({
        text: "shared recurrence",
        limit: 1,
        context: 1,
      });
      const first = await repository.search(firstQuery);
      const repeatedFirst = await repository.search(firstQuery);

      // Deep equality covers summaries, entries, snippets, hashes, context, support, and cursor.
      expect(repeatedFirst).toEqual(first);
      expect(first.hits.map((hit) => hit.session.identity.nativeId)).toEqual(["a-session"]);
      expect(first.hits[0]?.entry.ordinal).toBe(5);
      expect(first.hits[0]?.snippet).toEqual({
        segmentOrdinal: 0,
        origin: "human",
        originConfidence: "high",
        contentHash: hashContent("shared recurrence evidence"),
        text: "shared recurrence evidence",
        truncated: false,
        additionalMatchingSegments: 0,
      });
      expect(first.hits[0]?.context.map((entry) => entry.ordinal)).toEqual([4, 6]);
      expect(first.support).toEqual({
        occurrences: 3,
        uniqueContent: 1,
        uniqueKnownRoots: 1,
        unknownLineageSessions: 1,
      });
      expect(first.nextCursor).toBeDefined();
      if (first.nextCursor === undefined) throw new Error("Expected first search cursor");

      const secondQuery = createSessionSearchQuery({
        text: "shared recurrence",
        limit: 1,
        context: 1,
        cursor: first.nextCursor,
      });
      const second = await repository.search(secondQuery);
      const repeatedSecond = await repository.search(secondQuery);

      expect(repeatedSecond).toEqual(second);
      expect(second.hits.map((hit) => hit.session.identity.nativeId)).toEqual(["b-session"]);
      expect(second.hits[0]?.entry.ordinal).toBe(0);
      expect(second.hits[0]?.snippet).toEqual({
        segmentOrdinal: 0,
        origin: "human",
        originConfidence: "high",
        contentHash: hashContent("shared recurrence evidence"),
        text: "shared recurrence evidence",
        truncated: false,
        additionalMatchingSegments: 1,
      });
      expect(second.hits[0]?.context).toEqual([]);
      expect(second.support).toEqual(first.support);
      expect(second.nextCursor).toBeUndefined();
    } finally {
      fixture.database.close();
    }
  });

  test("applies exact filters and returns only direct tool call/result context", async () => {
    const fixture = await seededQueryFixture();
    try {
      const repository = createSqliteSessionQuery(fixture.database);
      const result = await repository.search(
        createSessionSearchQuery({
          text: "recurrence",
          filter: {
            source: "synthetic",
            instance: "query-profile",
            sourceState: "present",
            workspace: "/workspace/alpha",
            session: sessionQueryCorpusIdentity("a-session"),
            actor: "model",
            origin: "model",
            entryKind: "tool-call",
            toolName: "exec_command",
            toolNamespace: "functions",
            capturedAfter: "2026-07-14T11:59:59.999Z",
            capturedBefore: "2026-07-14T12:00:00.001Z",
            observedAfter: "2026-07-14T11:59:59.999Z",
            observedBefore: "2026-07-14T12:00:00.001Z",
            entryAfter: "2026-07-14T12:00:00.999Z",
            entryBefore: "2026-07-14T12:00:01.001Z",
          },
          limit: 20,
          context: 1,
        }),
      );

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.entry.ordinal).toBe(1);
      expect(result.hits[0]?.context.map((entry) => entry.ordinal)).toEqual([0, 2, 4]);
      expect(result.hits[0]?.context.find((entry) => entry.ordinal === 4)).toMatchObject({
        kind: "tool-result",
        adjacent: false,
        linked: true,
      });
      expect(result.hits[0]?.context.find((entry) => entry.ordinal === 4)).not.toHaveProperty(
        "toolName",
      );
      expect(result.hits[0]?.context.find((entry) => entry.ordinal === 2)).toMatchObject({
        adjacent: true,
        linked: false,
        bodyTruncated: true,
      });
      expect(result.hits[0]?.linkedContextTruncated).toBe(false);
    } finally {
      fixture.database.close();
    }
  });

  test("uses coverage observation while effective source state is unknown", async () => {
    const fixture = await seededQueryFixture();
    const now = () => new Date("2026-07-14T13:00:00.000Z");
    const lease = acquireWriterLease(fixture.database, "index", {
      now,
      token: () => "unknown-coverage-writer",
    });
    initializeDirectIndexWriter(fixture.database, lease, now);
    try {
      const index = createCoordinatedSqliteSessionIndex(fixture.database, {
        lease,
        now,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      });
      await index.startRun({
        source: sessionQueryCorpusIdentity("a-session").source,
        startedAt: "2026-07-14T14:00:00.000Z",
      });
      const repository = createSqliteSessionQuery(fixture.database);
      const unknown = await repository.list(
        createSessionListQuery({
          filter: {
            sourceState: "unknown",
            observedAfter: "2026-07-14T13:59:59.999Z",
            observedBefore: "2026-07-14T14:00:00.001Z",
          },
          limit: 20,
        }),
      );
      expect(unknown.sessions).toHaveLength(2);
      const noPresent = await repository.list(
        createSessionListQuery({ filter: { sourceState: "present" }, limit: 20 }),
      );
      expect(noPresent.sessions).toEqual([]);
      expect(noPresent.captureScope).toMatchObject({
        status: "incomplete",
        trackedSessions: 0,
        sourceCoverage: { complete: 0, unknown: 1 },
        appliedFilters: ["sourceState"],
      });
    } finally {
      interruptOwnedRunsAndReleaseWriterLease(fixture.database, lease, {
        now: () => new Date("2026-07-14T15:00:00.000Z"),
      });
      fixture.database.close();
    }
  });

  test("returns stored list/search digests without reconstructing a corrupt document", async () => {
    const fixture = await seededQueryFixture();
    const identity = sessionQueryCorpusIdentity("a-session");
    try {
      fixture.database
        .prepare(
          `UPDATE sessions_canonical_sessions
           SET document_digest = zeroblob(32)
           WHERE session_id = (
             SELECT tracking.session_id
             FROM sessions_session_tracking AS tracking
             JOIN sessions_source_instances AS source
               ON source.source_instance_id = tracking.source_instance_id
             WHERE source.kind = ? AND source.instance_id = ? AND tracking.native_id = ?
           )`,
        )
        .run(identity.source.kind, identity.source.instanceId, identity.nativeId);
      const repository = createSqliteSessionQuery(fixture.database);

      const listed = await repository.list(
        createSessionListQuery({ filter: { session: identity }, limit: 20 }),
      );
      const searched = await repository.search(
        createSessionSearchQuery({
          text: "MAGIC_LATE_MATCH",
          filter: { session: identity },
          limit: 20,
          context: 0,
        }),
      );

      expect(listed.sessions[0]?.documentDigest.digest).toBe("0".repeat(64));
      expect(searched.hits[0]?.session.documentDigest.digest).toBe("0".repeat(64));
      await expect(
        createSqliteSessionIndexReader(fixture.database).getDocument(identity),
      ).rejects.toMatchObject({ code: "corrupt-data" });
    } finally {
      fixture.database.close();
    }
  });

  test("rejects a search hit whose stored content digest does not match its text", async () => {
    const fixture = await seededQueryFixture();
    try {
      fixture.database.exec("DROP TRIGGER sessions_content_values_bu");
      fixture.database
        .prepare(
          `UPDATE sessions_content_values
           SET digest = zeroblob(32)
           WHERE text = ?`,
        )
        .run("invoke recurrence OR /tmp/Project/File.ts");
      const repository = createSqliteSessionQuery(fixture.database);

      await expect(
        repository.search(
          createSessionSearchQuery({
            text: "/tmp/Project/File.ts",
            limit: 20,
            context: 0,
          }),
        ),
      ).rejects.toMatchObject({ code: "corrupt-data" });
    } finally {
      fixture.database.close();
    }
  });

  test("paginates list and search deterministically and classifies cursor failures", async () => {
    const fixture = await seededQueryFixture();
    try {
      const repository = createSqliteSessionQuery(fixture.database);
      const firstList = await repository.list(createSessionListQuery({ limit: 1 }));
      expect(firstList.sessions.map((session) => session.identity.nativeId)).toEqual(["a-session"]);
      expect(firstList.nextCursor).toBeDefined();
      if (firstList.nextCursor === undefined) throw new Error("Expected list cursor");
      const secondList = await repository.list(
        createSessionListQuery({ limit: 1, cursor: firstList.nextCursor }),
      );
      expect(secondList.sessions.map((session) => session.identity.nativeId)).toEqual([
        "b-session",
      ]);

      const searchInput = { text: "shared recurrence", limit: 1, context: 0 } as const;
      const firstSearch = await repository.search(createSessionSearchQuery(searchInput));
      expect(firstSearch.support.occurrences).toBe(3);
      const cursor = firstSearch.nextCursor;
      expect(cursor).toBeDefined();
      if (cursor === undefined) throw new Error("Expected search cursor");
      const secondSearch = await repository.search(
        createSessionSearchQuery({ ...searchInput, cursor }),
      );
      expect(secondSearch.hits.map((hit) => hit.session.identity.nativeId)).toEqual(["b-session"]);

      await expect(
        repository.search(
          createSessionSearchQuery({ text: "different", limit: 1, context: 0, cursor }),
        ),
      ).rejects.toBeInstanceOf(SessionQueryUsageError);
      await expect(
        repository.search(createSessionSearchQuery({ ...searchInput, cursor: "not+base64" })),
      ).rejects.toMatchObject({ code: "invalid-cursor" });

      acquireWriterLease(fixture.database, "index", {
        now: () => new Date("2026-07-14T13:00:00.000Z"),
        token: () => "next-query-writer",
      });
      await expect(
        repository.search(createSessionSearchQuery({ ...searchInput, cursor })),
      ).rejects.toBeInstanceOf(SessionQueryOperationalError);
    } finally {
      fixture.database.close();
    }
  });
});

async function seededQueryFixture(): Promise<{ readonly database: DatabaseSync }> {
  const database = migratedDatabase();
  const now = () => new Date("2026-07-14T11:00:00.000Z");
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "seed-query-writer",
  });
  initializeDirectIndexWriter(database, lease, now);
  const index = createCoordinatedSqliteSessionIndex(database, {
    lease,
    now,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
  });
  const [firstDocument, secondDocument] = sessionQueryCorpusDocuments();
  const first = firstDocument.identity;
  const second = secondDocument.identity;
  const run = await index.startRun({
    source: first.source,
    startedAt: "2026-07-14T12:00:00.000Z",
  });
  await index.replaceSession(run, replacement(first, "query-a", firstDocument));
  await index.replaceSession(run, replacement(second, "query-b", secondDocument));
  await index.finishRun(run, {
    status: "completed",
    finishedAt: "2026-07-14T12:01:00.000Z",
  });
  interruptOwnedRunsAndReleaseWriterLease(database, lease, {
    now: () => new Date("2026-07-14T12:02:00.000Z"),
  });
  return { database };
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

const MARKER_SOURCE = Object.freeze({
  kind: "synthetic-marker",
  instanceId: "rank-hydration",
});

function markerDocument(nativeId: string, text: string): SessionDocument {
  return createTestDocument({
    identity: { source: MARKER_SOURCE, nativeId },
    lineageCoverage: "complete",
    entries: [
      createTestEntry({
        content: [
          createTestSegment({
            text,
            origin: "human",
            originConfidence: "high",
          }),
        ],
      }),
    ],
  });
}

function firstSnippetMarkerCandidate(database: DatabaseSync): {
  readonly start: string;
  readonly end: string;
} {
  const library = readQueryRevision(database).libraryInstanceId;
  return {
    start: `\u0001sessions-${library}-0-match-start\u0002`,
    end: `\u0001sessions-${library}-0-match-end\u0002`,
  };
}

async function seedQueryDocuments(
  database: DatabaseSync,
  documents: readonly SessionDocument[],
): Promise<void> {
  const first = documents[0];
  if (first === undefined) throw new Error("Query fixture must contain a document");
  const now = () => new Date("2026-07-14T11:00:00.000Z");
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "seed-marker-query-writer",
  });
  initializeDirectIndexWriter(database, lease, now);
  try {
    const index = createCoordinatedSqliteSessionIndex(database, {
      lease,
      now,
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    });
    const run = await index.startRun({
      source: first.identity.source,
      startedAt: "2026-07-14T12:00:00.000Z",
    });
    for (const [ordinal, document] of documents.entries()) {
      await index.replaceSession(
        run,
        replacement(document.identity, `marker-${String(ordinal)}`, document),
      );
    }
    await index.finishRun(run, {
      status: "completed",
      finishedAt: "2026-07-14T12:01:00.000Z",
    });
  } finally {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: () => new Date("2026-07-14T12:02:00.000Z"),
    });
  }
}

function initializeDirectIndexWriter(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  now: () => Date,
): void {
  runLeasedImmediateTransaction(database, lease, { now }, (transactionNow) => {
    clearWriterRecoveryReceiptInTransaction(database, lease, { now: transactionNow });
    initializeWriterRecoveryReceiptInTransaction(database, lease, {
      now: transactionNow,
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    });
  });
}
