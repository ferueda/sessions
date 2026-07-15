import { describe, expect, test, vi } from "vitest";

import { exportSession } from "../../src/application/export-session.ts";
import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type {
  IndexedSession,
  SessionIndexReader,
} from "../../src/application/ports/session-index.ts";
import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import { createTestDocument, createTestEntry } from "../fixtures/session.ts";

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

describe("exportSession", () => {
  test("selects one bounded retained snapshot from one immutable reader", async () => {
    const indexed = sessionWithEntries(60, "missing");
    const lifecycle = lifecycleWith(indexed);

    const result = await exportSession({ paths, lifecycle, identity });

    expect(result.snapshot.sourceState).toBe("missing");
    expect(result.snapshot.selection.mode).toBe("bounded");
    expect(result.snapshot.selection.entries).toEqual({
      selected: 50,
      total: 60,
      truncated: true,
      firstOrdinal: 0,
      lastOrdinal: 49,
    });
    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.sessions.getSession).toHaveBeenCalledOnce();
    expect(reader.sessions.getSession).toHaveBeenCalledWith(identity);
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test("full mode removes presentation bounds but not the public projection", async () => {
    const indexed = sessionWithEntries(60, "unknown");
    const lifecycle = lifecycleWith(indexed);

    const result = await exportSession({ paths, lifecycle, identity, full: true });

    expect(result.entries).toHaveLength(60);
    expect(result.snapshot.selection).toMatchObject({
      mode: "full",
      entries: { selected: 60, total: 60, truncated: false },
    });
    expect(result.snapshot.sourceState).toBe("unknown");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/workspace/synthetic");
    expect(serialized).not.toContain("memory://synthetic");
  });

  test("does not create storage or open a reader for an absent library", async () => {
    const lifecycle = lifecycleWith(undefined, "uninitialized");

    await expect(exportSession({ paths, lifecycle, identity })).rejects.toMatchObject({
      code: "session-not-found",
    });
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });

  test("closes the reader when the retained session is absent", async () => {
    const lifecycle = lifecycleWith(undefined);

    await expect(exportSession({ paths, lifecycle, identity })).rejects.toMatchObject({
      code: "session-not-found",
    });
    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test.each(["present", "missing", "unknown"] as const)(
    "preserves the retained digest for %s source state",
    async (sourceState) => {
      const indexed = sessionWithEntries(1, sourceState);
      const lifecycle = lifecycleWith(indexed);

      const result = await exportSession({ paths, lifecycle, identity });

      expect(result.snapshot.sourceState).toBe(sourceState);
      expect(result.snapshot.documentDigest).toEqual(indexed.summary.documentDigest);
    },
  );
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

function sessionWithEntries(
  count: number,
  sourceState: "present" | "missing" | "unknown",
): IndexedSession {
  const entries = Array.from({ length: count }, (_, ordinal) =>
    createTestEntry({ ordinal, content: [] }),
  );
  return {
    summary: {
      identity,
      title: "Synthetic export",
      freshness: "current",
      sourceState,
      capturedAt: "2026-07-15T12:00:00.000Z",
      sourceObservedAt: "2026-07-15T12:00:00.000Z",
      adapterVersion: "synthetic-v1",
      documentDigest: {
        scheme: "sha256-sessions-document-jcs-v1",
        digest: "0".repeat(64),
      },
    },
    document: {
      ...createTestDocument({ identity, entries }),
      title: "Synthetic export",
    },
  };
}
