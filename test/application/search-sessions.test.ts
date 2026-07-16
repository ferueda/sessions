import { describe, expect, test, vi } from "vitest";

import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { SessionIndexReader } from "../../src/application/ports/session-index.ts";
import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import { SessionQueryOperationalError } from "../../src/application/session-query-error.ts";
import { searchSessions } from "../../src/application/search-sessions.ts";
import {
  createSessionQueryCursor,
  type SessionSearchPage,
  type SessionQuerySummary,
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
        activityAfter: "2026-07-14T10:00:00.000Z",
        activityBefore: "2026-07-14T11:00:00.000Z",
        entryKind: "Tool-Call",
        toolName: "ReadFile",
      },
    });

    expect(result).not.toBe(page);
    expect(Object.isFrozen(result.hits)).toBe(true);
    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.query.search).toHaveBeenCalledWith({
      text: "quoted Terms",
      termMode: "all",
      filter: {
        source: "synthetic",
        instance: "Profile-A",
        workspace: "/Exact/Workspace",
        activityAfter: "2026-07-14T10:00:00.000Z",
        activityBefore: "2026-07-14T11:00:00.000Z",
        entryKind: "Tool-Call",
        toolName: "ReadFile",
      },
      limit: 20,
      context: 0,
    });
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test("selects the session title without changing search evidence", async () => {
    const hit = {
      session: { ...summary(), title: "😀".repeat(2_049), workspace: "/private/workspace" },
      root: { kind: "known" as const, root: summary().identity },
      entry: { ordinal: 3, kind: "message", actor: "model" as const },
      matchedTerms: ["needle"],
      snippet: {
        segmentOrdinal: 1,
        origin: "model" as const,
        originConfidence: "high" as const,
        contentHash: { scheme: "sha256-utf8-v1" as const, digest: "1".repeat(64) },
        text: "matched excerpt",
        truncated: false,
        additionalMatchingSegments: 0,
      },
      context: [],
      linkedContextTruncated: false,
    };
    const lifecycle = lifecycleWith({
      hits: [hit],
      support: {
        occurrences: 1,
        uniqueContent: 1,
        uniqueKnownRoots: 1,
        unknownLineageSessions: 0,
      },
    });

    const result = await searchSessions({ paths, lifecycle, text: "needle" });

    expect(result.hits[0]!.session.title).toEqual({
      text: "😀".repeat(2_048),
      truncated: true,
      originalUtf8Bytes: 8_196,
      emittedUtf8Bytes: 8_192,
    });
    expect(result.hits[0]!.session).not.toHaveProperty("workspace");
    expect(result.hits[0]?.root).toEqual({ kind: "known", root: summary().identity });
    expect(result.hits[0]?.matchedTerms).toEqual(["needle"]);
    expect(result.hits[0]!.snippet).toEqual(hit.snippet);
    expect(result.hits[0]!.snippet).not.toBe(hit.snippet);
    expect(Object.isFrozen(result.hits[0]!.snippet.contentHash)).toBe(true);
    expect(Object.isFrozen(result.hits[0]?.root)).toBe(true);
    expect(Object.isFrozen(result.hits[0]?.matchedTerms)).toBe(true);
    expect(result.hits[0]?.matchedTerms).not.toBe(hit.matchedTerms);
  });

  test("forwards explicit any-term mode", async () => {
    const lifecycle = lifecycleWith(emptyPage());

    await searchSessions({ paths, lifecycle, text: "alpha beta", termMode: "any" });

    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.query.search).toHaveBeenCalledWith({
      text: "alpha beta",
      termMode: "any",
      filter: {},
      limit: 20,
      context: 0,
    });
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
    entries: vi.fn<SessionQueryRepository["entries"]>(async () => ({ entries: [] })),
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

function summary(): SessionQuerySummary {
  return {
    identity: {
      source: { kind: "synthetic", instanceId: "one" },
      nativeId: "session",
    },
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
