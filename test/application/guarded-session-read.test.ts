import { describe, expect, test, vi } from "vitest";

import { exportSession } from "../../src/application/export-session.ts";
import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type {
  IndexedSession,
  SessionIndexReader,
} from "../../src/application/ports/session-index.ts";
import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import { showSession } from "../../src/application/show-session.ts";
import type { SessionDocumentDigest } from "../../src/domain/public-session-document.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import { createTestDocument, createTestEntry } from "../fixtures/session.ts";

const identity: SessionIdentity = {
  source: { kind: "synthetic", instanceId: "guarded" },
  nativeId: "session",
};
const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};
const documentDigest: SessionDocumentDigest = {
  scheme: "sha256-sessions-document-jcs-v1",
  digest: "a".repeat(64),
};
const differentDigest: SessionDocumentDigest = {
  scheme: "sha256-sessions-document-jcs-v1",
  digest: "b".repeat(64),
};

const guardedReaders = [
  {
    name: "show",
    read: (lifecycle: IndexLifecycle, expectedDocumentDigest?: SessionDocumentDigest) =>
      showSession({
        paths,
        lifecycle,
        identity,
        fromEntry: 0,
        toEntry: 0,
        ...(expectedDocumentDigest === undefined ? {} : { expectedDocumentDigest }),
      }),
    readAbsentCoordinate: (
      lifecycle: IndexLifecycle,
      expectedDocumentDigest: SessionDocumentDigest,
    ) =>
      showSession({
        paths,
        lifecycle,
        identity,
        expectedDocumentDigest,
        fromEntry: 2,
        toEntry: 2,
      }),
  },
  {
    name: "export",
    read: (lifecycle: IndexLifecycle, expectedDocumentDigest?: SessionDocumentDigest) =>
      exportSession({
        paths,
        lifecycle,
        identity,
        fromEntry: 0,
        toEntry: 0,
        ...(expectedDocumentDigest === undefined ? {} : { expectedDocumentDigest }),
      }),
    readAbsentCoordinate: (
      lifecycle: IndexLifecycle,
      expectedDocumentDigest: SessionDocumentDigest,
    ) =>
      exportSession({
        paths,
        lifecycle,
        identity,
        expectedDocumentDigest,
        fromEntry: 2,
        toEntry: 2,
      }),
  },
] as const;

describe("digest-guarded session reads", () => {
  test.each(guardedReaders)(
    "keeps matching guarded $name output equal to unguarded output",
    async (reader) => {
      const indexed = retainedSession();

      const unguarded = await reader.read(lifecycleWith(indexed));
      const guarded = await reader.read(lifecycleWith(indexed), documentDigest);

      expect(guarded).toEqual(unguarded);
      expect(guarded.snapshot).toMatchObject({
        documentDigest,
        sourceState: "missing",
      });
    },
  );

  test.each(guardedReaders)(
    "makes a $name digest mismatch precede coordinate absence",
    async (reader) => {
      const lifecycle = lifecycleWith(retainedSession());

      await expect(reader.readAbsentCoordinate(lifecycle, differentDigest)).rejects.toMatchObject({
        code: "document-digest-mismatch",
        message: "Retained session does not match the expected document digest",
      });
      const opened = await lifecycle.openReader.mock.results[0]!.value;
      expect(opened.sessions.getSession).toHaveBeenCalledOnce();
      expect(opened.close).toHaveBeenCalledOnce();
    },
  );

  test.each(guardedReaders)(
    "keeps an absent guarded $name session as session-not-found",
    async (reader) => {
      const lifecycle = lifecycleWith(undefined);

      await expect(reader.read(lifecycle, differentDigest)).rejects.toMatchObject({
        code: "session-not-found",
      });
      const opened = await lifecycle.openReader.mock.results[0]!.value;
      expect(opened.close).toHaveBeenCalledOnce();
    },
  );

  test.each(guardedReaders)(
    "rejects an invalid $name digest before library inspection",
    async (reader) => {
      const lifecycle = lifecycleWith(retainedSession());
      const invalid = {
        scheme: "sha256-sessions-document-jcs-v1",
        digest: "A".repeat(64),
      } as SessionDocumentDigest;

      await expect(reader.read(lifecycle, invalid)).rejects.toBeInstanceOf(TypeError);
      expect(lifecycle.inspect).not.toHaveBeenCalled();
    },
  );
});

function lifecycleWith(indexed: IndexedSession | undefined) {
  const sessions = {
    getSession: vi.fn<SessionIndexReader["getSession"]>(async () => indexed),
  } as unknown as SessionIndexReader;
  const reader = {
    state: {
      status: "ready" as const,
      initialized: true as const,
      schemaVersion: 3,
      supportedSchemaVersion: 3,
    },
    sessions,
    query: {} as SessionQueryRepository,
    close: vi.fn<() => Promise<void>>(async () => undefined),
  };
  return {
    inspect: vi.fn<IndexLifecycle["inspect"]>(async () => reader.state),
    openReader: vi.fn<IndexLifecycle["openReader"]>(async () => reader),
    openWriter: vi.fn<IndexLifecycle["openWriter"]>(),
    inspectHealth: vi.fn<IndexLifecycle["inspectHealth"]>(),
  } satisfies IndexLifecycle;
}

function retainedSession(): IndexedSession {
  const entries = [createTestEntry({ ordinal: 0, content: [] })];
  return {
    summary: {
      identity,
      freshness: "current",
      sourceState: "missing",
      capturedAt: "2026-07-22T12:00:00.000Z",
      sourceObservedAt: "2026-07-22T12:01:00.000Z",
      adapterVersion: "synthetic-v1",
      documentDigest,
    },
    document: createTestDocument({ identity, entries }),
  };
}
