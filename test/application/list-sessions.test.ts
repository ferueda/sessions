import { describe, expect, test, vi } from "vitest";

import { listSessions } from "../../src/application/list-sessions.ts";
import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { SessionIndexReader } from "../../src/application/ports/session-index.ts";
import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import { SessionQueryOperationalError } from "../../src/application/session-query-error.ts";
import {
  createSessionQueryCursor,
  type SessionListPage,
  type SessionQuerySummary,
} from "../../src/domain/session-query.ts";

const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};

describe("listSessions", () => {
  test("returns an empty result without opening uninitialized state", async () => {
    const lifecycle = lifecycleWith({ sessions: [] }, "uninitialized");

    await expect(listSessions({ paths, lifecycle })).resolves.toEqual({
      sessions: [],
    });
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });

  test("forwards one validated query and selects safe immutable summaries", async () => {
    const page = {
      sessions: [
        { ...summary("z"), title: `${"é".repeat(4_096)}tail`, workspace: "/private/workspace" },
        summary("a"),
      ],
      nextCursor: createSessionQueryCursor("next-page"),
    } satisfies SessionListPage;
    const lifecycle = lifecycleWith(page);

    const result = await listSessions({
      paths,
      lifecycle,
      filter: { source: "synthetic", instance: "Profile-One", workspace: "/Workspace" },
      limit: 2,
    });

    expect(result.sessions.map(({ identity }) => identity.nativeId)).toEqual(["z", "a"]);
    expect(result.sessions[0]!.title).toEqual({
      text: "é".repeat(4_096),
      truncated: true,
      originalUtf8Bytes: 8_196,
      emittedUtf8Bytes: 8_192,
    });
    expect(result.sessions[0]).not.toHaveProperty("workspace");
    expect(Object.isFrozen(result.sessions[0])).toBe(true);
    expect(Object.isFrozen(result.sessions[0]!.identity.source)).toBe(true);
    expect(result.nextCursor).toBe("next-page");
    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.query.list).toHaveBeenCalledWith({
      filter: { source: "synthetic", instance: "Profile-One", workspace: "/Workspace" },
      limit: 2,
    });
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test.each([0, 201, 1.5])("rejects invalid limit %s before inspection", async (limit) => {
    const lifecycle = lifecycleWith({ sessions: [] });
    await expect(listSessions({ paths, lifecycle, limit })).rejects.toBeInstanceOf(TypeError);
    expect(lifecycle.inspect).not.toHaveBeenCalled();
  });

  test("preserves an undefined repository rejection as a failed read", async () => {
    const lifecycle = lifecycleWith({ sessions: [] });
    const reader = await lifecycle.openReader(paths);
    vi.mocked(reader.query.list).mockRejectedValueOnce(undefined);
    lifecycle.openReader.mockClear();

    const outcome = await listSessions({ paths, lifecycle }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    expect(outcome).toEqual({ status: "rejected", error: undefined });
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test("treats a cursor against an absent library as stale", async () => {
    const lifecycle = lifecycleWith({ sessions: [] }, "uninitialized");

    await expect(listSessions({ paths, lifecycle, cursor: "old-page" })).rejects.toBeInstanceOf(
      SessionQueryOperationalError,
    );
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });
});

function lifecycleWith(page: SessionListPage, state: "ready" | "uninitialized" = "ready") {
  const sessions = {} as SessionIndexReader;
  const query = {
    entries: vi.fn<SessionQueryRepository["entries"]>(async () => ({ entries: [] })),
    list: vi.fn<SessionQueryRepository["list"]>(async () => page),
    search: vi.fn<SessionQueryRepository["search"]>(async () => ({
      hits: [],
      support: {
        occurrences: 0,
        uniqueContent: 0,
        uniqueKnownRoots: 0,
        unknownLineageSessions: 0,
      },
    })),
  } satisfies SessionQueryRepository;
  const reader = {
    state: {
      status: "ready" as const,
      initialized: true as const,
      schemaVersion: 1,
      supportedSchemaVersion: 1,
    },
    sessions,
    query,
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

function summary(nativeId: string): SessionQuerySummary {
  return {
    identity: { source: { kind: "synthetic", instanceId: "one" }, nativeId },
    freshness: "current",
    sourceState: "present",
    capturedAt: "2026-07-15T12:00:00.000Z",
    sourceObservedAt: "2026-07-15T12:00:00.000Z",
    adapterVersion: "synthetic-v1",
    documentDigest: {
      scheme: "sha256-sessions-document-jcs-v1",
      digest: "0".repeat(64),
    },
  };
}
