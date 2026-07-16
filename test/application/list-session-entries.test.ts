import { describe, expect, test, vi } from "vitest";

import { listSessionEntries } from "../../src/application/list-session-entries.ts";
import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { SessionIndexReader } from "../../src/application/ports/session-index.ts";
import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import { SessionQueryOperationalError } from "../../src/application/session-query-error.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import {
  createSessionQueryCursor,
  type SessionEntryPage,
  type SessionQuerySummary,
} from "../../src/domain/session-query.ts";
import {
  completeCaptureScope,
  emptyCompleteCaptureScope,
  uninitializedCaptureScope,
} from "../fixtures/session-capture-scope.ts";

const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};

describe("listSessionEntries", () => {
  test("returns an empty result without opening uninitialized state", async () => {
    const lifecycle = lifecycleWith(
      { entries: [], captureScope: emptyCompleteCaptureScope },
      "uninitialized",
    );

    await expect(listSessionEntries({ paths, lifecycle })).resolves.toEqual({
      entries: [],
      captureScope: uninitializedCaptureScope,
    });
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });

  test("forwards one validated query and selects safe immutable entry evidence", async () => {
    const page = {
      entries: [
        {
          session: { ...summary("child"), workspace: "/private/workspace" },
          entry: {
            ordinal: 4,
            kind: "tool-call",
            actor: "model" as const,
            toolCallId: "call-1",
            toolName: "read_file",
            toolNamespace: "filesystem",
          },
          root: {
            kind: "known" as const,
            root: summary("root").identity,
          },
          content: {
            textSegmentCount: 2,
            omittedSegmentCount: 1,
            unpreviewedTextSegmentCount: 1,
            preview: {
              segmentOrdinal: 0,
              origin: "model" as const,
              originConfidence: "high" as const,
              contentHash: hashContent("bounded evidence"),
              text: "bounded evidence",
              truncated: false,
            },
          },
        },
      ],
      captureScope: completeCaptureScope,
      nextCursor: createSessionQueryCursor("next-page"),
    } satisfies SessionEntryPage;
    const lifecycle = lifecycleWith(page);

    const result = await listSessionEntries({
      paths,
      lifecycle,
      filter: { source: "synthetic", actor: "model", origin: "model" },
      selection: "last",
      limit: 1,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).not.toHaveProperty("workspace");
    expect(result.entries[0]?.session).not.toHaveProperty("workspace");
    expect(result.entries[0]?.entry).toMatchObject({ ordinal: 4, toolName: "read_file" });
    expect(result.entries[0]?.root).toEqual({
      kind: "known",
      root: summary("root").identity,
    });
    expect(result.entries[0]?.content.preview?.contentHash).toEqual(
      hashContent("bounded evidence"),
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.entries)).toBe(true);
    expect(Object.isFrozen(result.entries[0]?.session.identity.source)).toBe(true);
    expect(Object.isFrozen(result.entries[0]?.content.preview?.contentHash)).toBe(true);
    expect(result.captureScope).toEqual(completeCaptureScope);
    expect(result.captureScope).not.toBe(page.captureScope);
    expect(result.nextCursor).toBe("next-page");

    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.query.entries).toHaveBeenCalledWith({
      filter: { source: "synthetic", actor: "model", origin: "model" },
      selection: "last",
      limit: 1,
    });
    expect(reader.query.list).not.toHaveBeenCalled();
    expect(reader.query.search).not.toHaveBeenCalled();
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test.each([0, 201, 1.5])("rejects invalid limit %s before inspection", async (limit) => {
    const lifecycle = lifecycleWith({ entries: [], captureScope: emptyCompleteCaptureScope });

    await expect(listSessionEntries({ paths, lifecycle, limit })).rejects.toBeInstanceOf(TypeError);
    expect(lifecycle.inspect).not.toHaveBeenCalled();
  });

  test("treats a cursor against an absent library as stale", async () => {
    const lifecycle = lifecycleWith(
      { entries: [], captureScope: emptyCompleteCaptureScope },
      "uninitialized",
    );

    await expect(
      listSessionEntries({ paths, lifecycle, cursor: "old-page" }),
    ).rejects.toBeInstanceOf(SessionQueryOperationalError);
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });
});

function lifecycleWith(page: SessionEntryPage, state: "ready" | "uninitialized" = "ready") {
  const sessions = {} as SessionIndexReader;
  const query = {
    entries: vi.fn<SessionQueryRepository["entries"]>(async () => page),
    list: vi.fn<SessionQueryRepository["list"]>(async () => ({
      sessions: [],
      captureScope: emptyCompleteCaptureScope,
    })),
    search: vi.fn<SessionQueryRepository["search"]>(async () => ({
      hits: [],
      support: {
        occurrences: 0,
        uniqueContent: 0,
        uniqueKnownRoots: 0,
        unknownLineageSessions: 0,
      },
      captureScope: emptyCompleteCaptureScope,
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
