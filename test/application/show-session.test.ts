import { describe, expect, test, vi } from "vitest";

import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type {
  IndexedSession,
  SessionIndexReader,
} from "../../src/application/ports/session-index.ts";
import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import { SessionLibraryError } from "../../src/application/library-error.ts";
import { showSession } from "../../src/application/show-session.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import { createTestEntry } from "../fixtures/session.ts";

const identity: SessionIdentity = {
  source: { kind: "synthetic", instanceId: "one" },
  nativeId: "session",
};
const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};

describe("showSession", () => {
  test("selects bounded context from one atomic repository read", async () => {
    const indexed = sessionWithEntries(8);
    const lifecycle = lifecycleWith(indexed);

    const result = await showSession({ paths, lifecycle, identity, entry: 4, context: 2 });

    expect(result.entries.map(({ ordinal }) => ordinal)).toEqual([2, 3, 4, 5, 6]);
    expect(result.snapshot.selection.entries).toEqual({
      selected: 5,
      total: 8,
      truncated: true,
      firstOrdinal: 2,
      lastOrdinal: 6,
    });
    expect(result.entries[0]).not.toHaveProperty("sourceLocator");
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.snapshot.selection)).toBe(true);
    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.sessions.getSession).toHaveBeenCalledWith(identity);
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test("keeps the first-50 entry window before applying transcript bounds", async () => {
    const lifecycle = lifecycleWith(sessionWithEntries(60));

    const result = await showSession({ paths, lifecycle, identity });

    expect(result.entries).toHaveLength(50);
    expect(result.snapshot.selection.entries).toEqual({
      selected: 50,
      total: 60,
      truncated: true,
      firstOrdinal: 0,
      lastOrdinal: 49,
    });
  });

  test("treats uninitialized and absent sessions as the same not-found failure", async () => {
    const uninitialized = lifecycleWith(undefined, "uninitialized");
    const absent = lifecycleWith(undefined);

    await expect(showSession({ paths, lifecycle: uninitialized, identity })).rejects.toMatchObject({
      code: "session-not-found",
    });
    await expect(showSession({ paths, lifecycle: absent, identity })).rejects.toBeInstanceOf(
      SessionLibraryError,
    );
    expect(uninitialized.openReader).not.toHaveBeenCalled();
  });

  test("rejects context without an entry before inspection", async () => {
    const lifecycle = lifecycleWith(sessionWithEntries(1));
    await expect(showSession({ paths, lifecycle, identity, context: 1 })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(lifecycle.inspect).not.toHaveBeenCalled();
  });
});

function lifecycleWith(
  indexed: IndexedSession | undefined,
  state: "ready" | "uninitialized" = "ready",
) {
  const sessions = {
    getSession: vi.fn<SessionIndexReader["getSession"]>(async () => indexed),
  } as unknown as SessionIndexReader;
  const reader = {
    state: {
      status: "ready" as const,
      initialized: true as const,
      schemaVersion: 1,
      supportedSchemaVersion: 1,
    },
    sessions,
    query: {} as SessionQueryRepository,
    close: vi.fn<() => Promise<void>>(async () => undefined),
  };
  return {
    inspect: vi.fn<IndexLifecycle["inspect"]>(async () =>
      state === "ready"
        ? reader.state
        : {
            status: "uninitialized" as const,
            initialized: false as const,
            schemaVersion: null,
            supportedSchemaVersion: 1,
          },
    ),
    openReader: vi.fn<IndexLifecycle["openReader"]>(async () => reader),
    openWriter: vi.fn<IndexLifecycle["openWriter"]>(),
    inspectHealth: vi.fn<IndexLifecycle["inspectHealth"]>(),
  } satisfies IndexLifecycle;
}

function sessionWithEntries(count: number): IndexedSession {
  const entries = Array.from({ length: count }, (_, ordinal) =>
    createTestEntry({ ordinal, content: [] }),
  );
  return {
    summary: {
      identity,
      freshness: "current",
      sourceState: "present",
      capturedAt: "2026-07-15T12:00:00.000Z",
      sourceObservedAt: "2026-07-15T12:00:00.000Z",
      adapterVersion: "synthetic-v1",
      documentDigest: {
        scheme: "sha256-sessions-document-jcs-v1",
        digest: "0".repeat(64),
      },
    },
    document: { identity, lineageCoverage: "unknown", relations: [], entries },
  };
}
