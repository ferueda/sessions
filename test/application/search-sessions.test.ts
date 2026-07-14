import { describe, expect, test, vi } from "vitest";

import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { SessionIndexReader } from "../../src/application/ports/session-index.ts";
import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import { SessionQueryOperationalError } from "../../src/application/session-query-error.ts";
import { searchSessions } from "../../src/application/search-sessions.ts";
import {
  createSessionQueryCursor,
  type SessionSearchPage,
} from "../../src/domain/session-query.ts";

const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};

describe("searchSessions", () => {
  test("returns zero query-wide support without opening uninitialized state", async () => {
    const lifecycle = lifecycleWith(emptyPage(), "uninitialized");

    await expect(searchSessions({ paths, lifecycle, text: "needle" })).resolves.toEqual({
      hits: [],
      support: {
        occurrences: 0,
        uniqueContent: 0,
        uniqueKnownRoots: 0,
        unknownLineageSessions: 0,
      },
    });
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });

  test("forwards normalized text, exact filters, and defaults in one repository call", async () => {
    const page = {
      ...emptyPage(),
      nextCursor: createSessionQueryCursor("next-page"),
    } satisfies SessionSearchPage;
    const lifecycle = lifecycleWith(page);

    const result = await searchSessions({
      paths,
      lifecycle,
      text: "  quoted\u2003Terms  ",
      filter: {
        source: "synthetic",
        instance: "Profile-A",
        workspace: "/Exact/Workspace",
        entryKind: "Tool-Call",
        toolName: "ReadFile",
      },
    });

    expect(result).toBe(page);
    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.query.search).toHaveBeenCalledWith({
      text: "quoted Terms",
      filter: {
        source: "synthetic",
        instance: "Profile-A",
        workspace: "/Exact/Workspace",
        entryKind: "Tool-Call",
        toolName: "ReadFile",
      },
      limit: 20,
      context: 0,
    });
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test("rejects invalid input before inspecting the library", async () => {
    const lifecycle = lifecycleWith(emptyPage());

    await expect(searchSessions({ paths, lifecycle, text: " \t\n " })).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(lifecycle.inspect).not.toHaveBeenCalled();
  });

  test("classifies malformed and absent-library cursors separately", async () => {
    const lifecycle = lifecycleWith(emptyPage(), "uninitialized");

    await expect(
      searchSessions({ paths, lifecycle, text: "needle", cursor: "" }),
    ).rejects.toMatchObject({
      code: "invalid-cursor",
    });
    await expect(
      searchSessions({ paths, lifecycle, text: "needle", cursor: "old-page" }),
    ).rejects.toBeInstanceOf(SessionQueryOperationalError);
    expect(lifecycle.inspect).toHaveBeenCalledOnce();
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });
});

function lifecycleWith(page: SessionSearchPage, state: "ready" | "uninitialized" = "ready") {
  const query = {
    list: vi.fn<SessionQueryRepository["list"]>(async () => ({ sessions: [] })),
    search: vi.fn<SessionQueryRepository["search"]>(async () => page),
  } satisfies SessionQueryRepository;
  const reader = {
    state: {
      status: "ready" as const,
      initialized: true as const,
      schemaVersion: 1,
      supportedSchemaVersion: 1,
    },
    sessions: {} as SessionIndexReader,
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

function emptyPage(): SessionSearchPage {
  return {
    hits: [],
    support: {
      occurrences: 0,
      uniqueContent: 0,
      uniqueKnownRoots: 0,
      unknownLineageSessions: 0,
    },
  };
}
