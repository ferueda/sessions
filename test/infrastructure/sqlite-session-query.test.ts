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
import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import { createSqliteSessionQuery } from "../../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import { replacement } from "../contracts/session-index.contract.ts";
import {
  sessionQueryCorpusDocuments,
  sessionQueryCorpusIdentity,
} from "../fixtures/session-query-corpus.ts";

describe("SQLite session query", () => {
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

      await expect(
        repository.search(createSessionSearchQuery({ text: "---", limit: 20, context: 0 })),
      ).resolves.toEqual({
        hits: [],
        support: {
          occurrences: 0,
          uniqueContent: 0,
          uniqueKnownRoots: 0,
          unknownLineageSessions: 0,
        },
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
    try {
      const index = createCoordinatedSqliteSessionIndex(fixture.database, { lease, now });
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
      await expect(
        repository.list(createSessionListQuery({ filter: { sourceState: "present" }, limit: 20 })),
      ).resolves.toEqual({ sessions: [] });
    } finally {
      interruptOwnedRunsAndReleaseWriterLease(fixture.database, lease, {
        now: () => new Date("2026-07-14T15:00:00.000Z"),
      });
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
  const index = createCoordinatedSqliteSessionIndex(database, { lease, now });
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
