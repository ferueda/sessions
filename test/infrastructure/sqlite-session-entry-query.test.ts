import { constants, DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { hashContent } from "../../src/domain/content-hash.ts";
import {
  createSessionEntryQuery,
  sessionQueryFingerprintMaterial,
  type SessionEntryFilterInput,
  type SessionEntryPage,
  type SessionEntrySelection,
} from "../../src/domain/session-query.ts";
import type { SessionDocument, SessionIdentity } from "../../src/domain/session.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import {
  decodeQueryCursor,
  encodeAnchoredQueryCursor,
  encodeQueryCursor,
  fingerprintQuery,
  readQueryRevision,
} from "../../src/infrastructure/sqlite/query-cursor.ts";
import {
  buildSqliteEntryCoordinateStatement,
  listSqliteSessionEntries,
  type SqliteEntryQueryWork,
} from "../../src/infrastructure/sqlite/sqlite-session-entry-query.ts";
import { createSqliteSessionQuery } from "../../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import { initializeWriterRecoveryReceipt } from "../../src/infrastructure/sqlite/writer-recovery-receipt.ts";
import { replacement } from "../contracts/session-index.contract.ts";

describe("SQLite session entry query", () => {
  test("traverses binary identities without gaps for all, first, last, and filtered pages", async () => {
    const database = migratedDatabase();
    try {
      await seed(database, [filterDocument("é"), filterDocument("a"), filterDocument("Z")]);
      const repository = createSqliteSessionQuery(database);
      const cases: readonly {
        readonly selection: SessionEntrySelection;
        readonly filter?: SessionEntryFilterInput;
      }[] = [
        { selection: "all" },
        { selection: "first", filter: { actor: "human" } },
        { selection: "last", filter: { actor: "human" } },
        { selection: "all", filter: { origin: "model" } },
        {
          selection: "all",
          filter: { toolName: "exec_command", toolNamespace: "functions" },
        },
      ];

      for (const candidate of cases) {
        const expected = await repository.entries(
          createSessionEntryQuery({ ...candidate, limit: 200 }),
        );
        const traversed = await traverseEntries(database, candidate);
        expect(traversed).toEqual(entryKeys(expected));
        expect(new Set(traversed).size).toBe(traversed.length);
      }
    } finally {
      database.close();
    }
  });

  test("accepts v1 once, emits v2 anchors, and rejects stale or invalid anchors", async () => {
    const database = migratedDatabase();
    try {
      await seed(database, [filterDocument("anchor")]);
      const repository = createSqliteSessionQuery(database);
      const query = createSessionEntryQuery({ limit: 1 });
      const revision = readQueryRevision(database);
      const fingerprint = fingerprintQuery(sessionQueryFingerprintMaterial(query));
      const v1 = encodeQueryCursor({
        command: "entries",
        fingerprint,
        revision,
        offset: 1,
      });
      const fromV1 = await repository.entries(createSessionEntryQuery({ limit: 1, cursor: v1 }));
      expect(entryKeys(fromV1)).toEqual(["anchor#1"]);
      expect(fromV1.nextCursor).toBeDefined();
      if (fromV1.nextCursor === undefined) throw new Error("Expected v2 continuation");
      const decoded = decodeQueryCursor(fromV1.nextCursor, {
        command: "entries",
        fingerprint,
        revision,
      });
      expect(decoded).toEqual({
        ok: true,
        offset: 2,
        anchor: {
          kind: "entries",
          sessionId: sessionId(database, "anchor"),
          entryOrdinal: 1,
        },
      });
      await expect(
        repository.entries(createSessionEntryQuery({ limit: 1, cursor: fromV1.nextCursor })),
      ).resolves.toMatchObject({
        entries: [{ session: { identity: identity("anchor") }, entry: { ordinal: 2 } }],
      });

      const missingAnchor = encodeAnchoredQueryCursor({
        command: "entries",
        fingerprint,
        revision,
        offset: 1,
        anchor: { kind: "entries", sessionId: 999_999, entryOrdinal: 0 },
      });
      await expect(
        repository.entries(createSessionEntryQuery({ limit: 1, cursor: missingAnchor })),
      ).rejects.toMatchObject({ code: "invalid-cursor" });

      const humanQuery = createSessionEntryQuery({ filter: { actor: "human" }, limit: 1 });
      const nonqualifyingAnchor = encodeAnchoredQueryCursor({
        command: "entries",
        fingerprint: fingerprintQuery(sessionQueryFingerprintMaterial(humanQuery)),
        revision,
        offset: 1,
        anchor: {
          kind: "entries",
          sessionId: sessionId(database, "anchor"),
          entryOrdinal: 2,
        },
      });
      await expect(
        repository.entries(
          createSessionEntryQuery({
            filter: { actor: "human" },
            limit: 1,
            cursor: nonqualifyingAnchor,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid-cursor" });

      const first = await repository.entries(query);
      expect(first.nextCursor).toBeDefined();
      if (first.nextCursor === undefined) throw new Error("Expected stale continuation");
      const lease = acquireWriterLease(database, "index", {
        now: () => new Date("2026-07-15T13:00:00.000Z"),
        token: () => "entry-query-stale-writer",
      });
      try {
        await expect(
          repository.entries(createSessionEntryQuery({ limit: 1, cursor: first.nextCursor })),
        ).rejects.toMatchObject({ code: "stale-cursor" });
      } finally {
        interruptOwnedRunsAndReleaseWriterLease(database, lease, {
          now: () => new Date("2026-07-15T13:01:00.000Z"),
        });
      }
    } finally {
      database.close();
    }
  });

  test("batches summary hydration once at the public page maximum", async () => {
    const database = migratedDatabase();
    try {
      await seed(
        database,
        Array.from({ length: 200 }, (_, ordinal) =>
          document(`batch-${String(ordinal).padStart(3, "0")}`, `evidence ${String(ordinal)}`),
        ),
      );
      const one = await entriesWithSelectCount(database, 1);
      const many = await entriesWithSelectCount(database, 200);

      expect(one.page.entries).toHaveLength(1);
      expect(many.page.entries).toHaveLength(200);
      expect(many.selectCount).toBe(one.selectCount);
    } finally {
      database.close();
    }
  });

  test("preserves every filter family and applies entry filters before first or last selection", async () => {
    const database = migratedDatabase();
    try {
      await seed(database, [filterDocument("filter-target"), filterDocument("other")]);
      const repository = createSqliteSessionQuery(database);
      const fullyFiltered = await repository.entries(
        createSessionEntryQuery({
          filter: {
            source: SOURCE.kind,
            instance: SOURCE.instanceId,
            nativeId: "filter-target",
            sourceState: "present",
            workspace: "/workspace/filter-target",
            activityAfter: "2026-07-15T11:59:59.999Z",
            activityBefore: "2026-07-15T12:00:00.001Z",
            capturedAfter: "2026-07-15T11:59:59.999Z",
            capturedBefore: "2026-07-15T12:00:00.001Z",
            observedAfter: "2026-07-15T11:59:59.999Z",
            observedBefore: "2026-07-15T12:01:00.001Z",
            session: identity("filter-target"),
            entryAfter: "2026-07-15T12:00:01.999Z",
            entryBefore: "2026-07-15T12:00:02.001Z",
            actor: "model",
            origin: "model",
            entryKind: "tool-call",
            toolName: "exec_command",
            toolNamespace: "functions",
          },
          selection: "first",
          limit: 10,
        }),
      );

      expect(
        fullyFiltered.entries.map(({ session, entry }) => [
          session.identity.nativeId,
          entry.ordinal,
        ]),
      ).toEqual([["filter-target", 2]]);

      for (const [selection, expectedOrdinal] of [
        ["first", 1],
        ["last", 4],
      ] as const) {
        const page = await repository.entries(
          createSessionEntryQuery({
            filter: { nativeId: "filter-target", actor: "human" },
            selection,
            limit: 10,
          }),
        );
        expect(page.entries.map(({ entry }) => entry.ordinal)).toEqual([expectedOrdinal]);
      }
    } finally {
      database.close();
    }
  });

  test("keeps binary identity ordering under the explicit traversal", async () => {
    const database = migratedDatabase();
    try {
      await seed(database, [
        document("é", "accent"),
        document("a", "lowercase"),
        document("Z", "uppercase"),
      ]);
      const page = await createSqliteSessionQuery(database).entries(
        createSessionEntryQuery({ limit: 10 }),
      );

      expect(page.entries.map(({ session }) => session.identity.nativeId)).toEqual(["Z", "a", "é"]);
    } finally {
      database.close();
    }
  });

  test("owns the explicit traversal SQL and ignores observer failures", async () => {
    const database = migratedDatabase();
    try {
      await seed(database, [document("observed", "observed evidence")]);
      const query = createSessionEntryQuery({ limit: 10 });
      const firstStatement = buildSqliteEntryCoordinateStatement(query, { kind: "first" });
      const keysetStatement = buildSqliteEntryCoordinateStatement(query, {
        kind: "keyset",
        anchor: {
          sessionId: 1,
          entryOrdinal: 2,
          sourceKind: SOURCE.kind,
          instanceId: SOURCE.instanceId,
          nativeId: "observed",
        },
      });
      const offsetStatement = buildSqliteEntryCoordinateStatement(query, {
        kind: "offset",
        offset: 10,
      });
      expect(firstStatement.sql).toContain(
        "FROM sessions_source_instances AS source\n          CROSS JOIN sessions_session_tracking AS tracking",
      );
      expect(firstStatement.sql).toContain(
        "WHERE tracking.source_instance_id = source.source_instance_id",
      );
      expect(firstStatement.sql).toContain("AND entry.session_id = canonical.session_id");
      expect(firstStatement.sql).not.toContain("OFFSET");
      expect(keysetStatement.sql).not.toContain("OFFSET");
      expect(keysetStatement.sql).toContain("entry.ordinal > CASE");
      expect(offsetStatement.sql).toContain("OFFSET ?");

      const work: SqliteEntryQueryWork[] = [];
      const expected = listSqliteSessionEntries(database, query, {
        observeWork: (event) => work.push(event),
      });
      const withFailingObserver = listSqliteSessionEntries(database, query, {
        observeWork: () => {
          throw new Error("private observer failure");
        },
      });

      expect(withFailingObserver).toEqual(expected);
      expect(work.map(({ phase, rowCount }) => [phase, rowCount])).toEqual([
        ["coordinate-selection", 1],
        ["hydration", 1],
      ]);
      expect(work.every(({ elapsedMilliseconds }) => elapsedMilliseconds >= 0)).toBe(true);
    } finally {
      database.close();
    }
  });

  test("hydrates only the selected page and excludes storage-only entry fields", async () => {
    const database = migratedDatabase();
    const safeText = "safe retained entry evidence";
    const corruptText = "later corrupt retained entry evidence";
    try {
      await seed(database, [document("a-safe", safeText), document("b-corrupt", corruptText)]);
      const repository = createSqliteSessionQuery(database);
      const first = await repository.entries(
        createSessionEntryQuery({
          filter: { source: SOURCE.kind, instance: SOURCE.instanceId },
          limit: 1,
        }),
      );

      expect(first.entries).toHaveLength(1);
      expect(first.entries[0]).toMatchObject({
        session: { identity: identity("a-safe") },
        entry: { ordinal: 0, kind: "message", actor: "human" },
        root: { kind: "known", root: identity("a-safe") },
        content: {
          textSegmentCount: 1,
          omittedSegmentCount: 0,
          unpreviewedTextSegmentCount: 0,
          preview: {
            segmentOrdinal: 0,
            contentHash: hashContent(safeText),
            text: safeText,
            truncated: false,
          },
        },
      });
      expect(first.nextCursor).toBeDefined();
      expect(first.entries[0]?.entry).not.toHaveProperty("sourceLocator");
      expect(first.entries[0]?.content.preview).not.toHaveProperty("sourceMetadata");
      expect(JSON.stringify(first)).not.toContain("locator-private-marker");
      expect(JSON.stringify(first)).not.toContain("metadata-private-marker");

      database.exec("DROP TRIGGER sessions_content_values_bu");
      database
        .prepare("UPDATE sessions_content_values SET digest = zeroblob(32) WHERE text = ?")
        .run(corruptText);

      await expect(
        repository.entries(
          createSessionEntryQuery({
            filter: { source: SOURCE.kind, instance: SOURCE.instanceId },
            limit: 1,
          }),
        ),
      ).resolves.toEqual(first);
      if (first.nextCursor === undefined) throw new Error("Expected entry continuation");
      await expect(
        repository.entries(
          createSessionEntryQuery({
            filter: { source: SOURCE.kind, instance: SOURCE.instanceId },
            limit: 1,
            cursor: first.nextCursor,
          }),
        ),
      ).rejects.toMatchObject({ code: "corrupt-data" });
    } finally {
      database.close();
    }
  });
});

const SOURCE = { kind: "synthetic-entry-focus", instanceId: "local" } as const;

function identity(nativeId: string): SessionIdentity {
  return { source: SOURCE, nativeId };
}

function document(nativeId: string, text: string): SessionDocument {
  return {
    identity: identity(nativeId),
    title: `Focused entry ${nativeId}`,
    workspace: "/workspace/internal-filter-only",
    lineageCoverage: "complete",
    relations: [],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        timestamp: "2026-07-15T12:00:00.000Z",
        sourceLocator: {
          uri: "memory://locator-private-marker",
          recordId: "private-record",
        },
        content: [
          {
            kind: "text",
            ordinal: 0,
            text,
            contentHash: hashContent(text),
            origin: "human",
            originConfidence: "high",
            sourceMetadata: { marker: "metadata-private-marker" },
          },
        ],
      },
    ],
  };
}

function filterDocument(nativeId: string): SessionDocument {
  const text = `model evidence ${nativeId}`;
  return {
    identity: identity(nativeId),
    title: `Filtered entry ${nativeId}`,
    workspace: `/workspace/${nativeId}`,
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z",
    lineageCoverage: "complete",
    relations: [],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "system",
        timestamp: "2026-07-15T12:00:00.000Z",
        sourceLocator: { uri: `memory://${nativeId}/0` },
        content: [],
      },
      {
        ordinal: 1,
        kind: "message",
        actor: "human",
        timestamp: "2026-07-15T12:00:01.000Z",
        sourceLocator: { uri: `memory://${nativeId}/1` },
        content: [],
      },
      {
        ordinal: 2,
        kind: "tool-call",
        actor: "model",
        timestamp: "2026-07-15T12:00:02.000Z",
        toolCallId: `call-${nativeId}`,
        toolName: "exec_command",
        toolNamespace: "functions",
        sourceLocator: { uri: `memory://${nativeId}/2` },
        content: [
          {
            kind: "text",
            ordinal: 0,
            text,
            contentHash: hashContent(text),
            origin: "model",
            originConfidence: "high",
            sourceMetadata: {},
          },
        ],
      },
      {
        ordinal: 3,
        kind: "tool-result",
        actor: "tool",
        timestamp: "2026-07-15T12:00:03.000Z",
        relatedEntryOrdinal: 2,
        toolCallId: `call-${nativeId}`,
        sourceLocator: { uri: `memory://${nativeId}/3` },
        content: [],
      },
      {
        ordinal: 4,
        kind: "message",
        actor: "human",
        timestamp: "2026-07-15T12:00:04.000Z",
        sourceLocator: { uri: `memory://${nativeId}/4` },
        content: [],
      },
    ],
  };
}

async function seed(database: DatabaseSync, documents: readonly SessionDocument[]): Promise<void> {
  const now = () => new Date("2026-07-15T12:00:00.000Z");
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "entry-query-focused-writer",
  });
  initializeWriterRecoveryReceipt(database, lease, {
    now,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
  });
  const index = createCoordinatedSqliteSessionIndex(database, {
    lease,
    now,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
  });
  try {
    const run = await index.startRun({ source: SOURCE, startedAt: now().toISOString() });
    for (const [ordinal, candidate] of documents.entries()) {
      await index.replaceSession(
        run,
        replacement(candidate.identity, `entry-focused-${String(ordinal)}`, candidate),
      );
    }
    await index.finishRun(run, {
      status: "completed",
      finishedAt: "2026-07-15T12:01:00.000Z",
    });
  } finally {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: () => new Date("2026-07-15T12:02:00.000Z"),
    });
  }
}

async function traverseEntries(
  database: DatabaseSync,
  candidate: {
    readonly selection: SessionEntrySelection;
    readonly filter?: SessionEntryFilterInput;
  },
): Promise<readonly string[]> {
  const repository = createSqliteSessionQuery(database);
  const result: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.entries(
      createSessionEntryQuery({
        ...candidate,
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    result.push(...entryKeys(page));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}

function entryKeys(page: SessionEntryPage): readonly string[] {
  return page.entries.map(
    ({ session, entry }) => `${session.identity.nativeId}#${String(entry.ordinal)}`,
  );
}

function sessionId(database: DatabaseSync, nativeId: string): number {
  const row = database
    .prepare(
      `SELECT canonical.session_id
       FROM sessions_canonical_sessions AS canonical
       JOIN sessions_session_tracking AS tracking
         ON tracking.session_id = canonical.session_id
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       WHERE source.kind = ?
         AND source.instance_id = ?
         AND tracking.native_id = ?`,
    )
    .get(SOURCE.kind, SOURCE.instanceId, nativeId) as { readonly session_id?: unknown } | undefined;
  const value = row?.session_id;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Missing test session ID");
  }
  return value;
}

async function entriesWithSelectCount(
  database: DatabaseSync,
  limit: number,
): Promise<{ readonly page: SessionEntryPage; readonly selectCount: number }> {
  let selectCount = 0;
  database.setAuthorizer((actionCode) => {
    if (actionCode === constants.SQLITE_SELECT) selectCount += 1;
    return constants.SQLITE_OK;
  });
  try {
    return {
      page: await createSqliteSessionQuery(database).entries(createSessionEntryQuery({ limit })),
      selectCount,
    };
  } finally {
    database.setAuthorizer(null);
  }
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
