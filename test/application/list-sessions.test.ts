import { describe, expect, test, vi } from "vitest";

import { listSessions } from "../../src/application/list-sessions.ts";
import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type {
  IndexedSessionSummary,
  SessionIndexReader,
} from "../../src/application/ports/session-index.ts";

const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};

describe("listSessions", () => {
  test("returns an empty result without opening uninitialized state", async () => {
    const lifecycle = lifecycleWith([], "uninitialized");

    await expect(listSessions({ paths, lifecycle })).resolves.toEqual({
      sessions: [],
      truncated: false,
    });
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });

  test("requests one sentinel and preserves repository order", async () => {
    const summaries = [summary("z"), summary("a"), summary("sentinel")];
    const lifecycle = lifecycleWith(summaries);

    const result = await listSessions({ paths, lifecycle, limit: 2 });

    expect(result.sessions.map(({ identity }) => identity.nativeId)).toEqual(["z", "a"]);
    expect(result.truncated).toBe(true);
    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.sessions.listSummaries).toHaveBeenCalledWith({ limit: 3 });
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test.each([0, 201, 1.5])("rejects invalid limit %s before inspection", async (limit) => {
    const lifecycle = lifecycleWith([]);
    await expect(listSessions({ paths, lifecycle, limit })).rejects.toBeInstanceOf(TypeError);
    expect(lifecycle.inspect).not.toHaveBeenCalled();
  });

  test("preserves an undefined repository rejection as a failed read", async () => {
    const lifecycle = lifecycleWith([]);
    const reader = await lifecycle.openReader(paths);
    vi.mocked(reader.sessions.listSummaries).mockRejectedValueOnce(undefined);
    lifecycle.openReader.mockClear();

    const outcome = await listSessions({ paths, lifecycle }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    expect(outcome).toEqual({ status: "rejected", error: undefined });
    expect(reader.close).toHaveBeenCalledOnce();
  });
});

function lifecycleWith(
  summaries: readonly IndexedSessionSummary[],
  state: "ready" | "uninitialized" = "ready",
) {
  const sessions = {
    listSummaries: vi.fn<SessionIndexReader["listSummaries"]>(async () => summaries),
  } as unknown as SessionIndexReader;
  const reader = {
    state: {
      status: "ready" as const,
      initialized: true as const,
      schemaVersion: 1,
      supportedSchemaVersion: 1,
    },
    sessions,
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

function summary(nativeId: string): IndexedSessionSummary {
  return {
    identity: { source: { kind: "synthetic", instanceId: "one" }, nativeId },
    freshness: "current",
    sourceState: "present",
  };
}
