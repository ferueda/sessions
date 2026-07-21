import { describe, expect, test, vi } from "vitest";

import { createSessionManifest } from "../../src/application/create-session-manifest.ts";
import { SessionLibraryError } from "../../src/application/library-error.ts";
import type { IndexLifecycle, IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type { SessionIndexReader } from "../../src/application/ports/session-index.ts";
import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import {
  createSessionManifestQuery,
  type SessionManifestResult,
} from "../../src/domain/session-manifest.ts";
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

describe("createSessionManifest", () => {
  test("returns the exact empty selection without opening an uninitialized library", async () => {
    const lifecycle = lifecycleWith(emptyManifest(), "uninitialized");

    await expect(
      createSessionManifest({
        paths,
        lifecycle,
        filter: {
          source: "synthetic",
          instance: "Profile-A",
          activityAfter: "2026-07-20T00:00:00.000Z",
        },
      }),
    ).resolves.toEqual({
      selection: {
        order: "canonical-identity-v1",
        maximumRevisions: 10_000,
        filters: {
          source: "synthetic",
          instance: "Profile-A",
          activityAfter: "2026-07-20T00:00:00.000Z",
        },
      },
      captureScope: {
        ...uninitializedCaptureScope,
        appliedFilters: ["source", "instance"],
        unassessedFilters: ["activityAfter"],
      },
      revisions: [],
    });
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });

  test("admits the query before inspection, including runtime workspace rejection", async () => {
    const lifecycle = lifecycleWith(emptyManifest());

    await expect(
      createSessionManifest({
        paths,
        lifecycle,
        filter: { workspace: undefined } as never,
      }),
    ).rejects.toThrow("does not accept a workspace filter");
    await expect(
      createSessionManifest({ paths, lifecycle, filter: { source: "UPPER" } }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(lifecycle.inspect).not.toHaveBeenCalled();
  });

  test("makes one repository call and returns only deeply copied public manifest fields", async () => {
    const stored = manifestResult();
    const unsafeRevision = {
      ...stored.revisions[0]!,
      title: "private title",
      workspace: "/private/workspace",
      document: { entries: ["private transcript"] },
    } as unknown as SessionManifestResult["revisions"][number];
    const returned = {
      ...stored,
      selection: createSessionManifestQuery({ filter: { nativeId: "wrong" } }).selection,
      revisions: [unsafeRevision],
    } as SessionManifestResult;
    const lifecycle = lifecycleWith(returned);

    const result = await createSessionManifest({
      paths,
      lifecycle,
      filter: { source: "synthetic", instance: "Profile-A" },
    });

    const reader = await lifecycle.openReader.mock.results[0]!.value;
    expect(reader.query.manifest).toHaveBeenCalledOnce();
    expect(reader.query.manifest).toHaveBeenCalledWith({
      filter: { source: "synthetic", instance: "Profile-A" },
      selection: {
        order: "canonical-identity-v1",
        maximumRevisions: 10_000,
        filters: { source: "synthetic", instance: "Profile-A" },
      },
    });
    expect(result.selection.filters).toEqual({ source: "synthetic", instance: "Profile-A" });
    expect(result.revisions[0]).not.toHaveProperty("title");
    expect(result.revisions[0]).not.toHaveProperty("workspace");
    expect(result.revisions[0]).not.toHaveProperty("document");
    expect(result.revisions[0]).toEqual(stored.revisions[0]);
    expect(result.revisions[0]).not.toBe(returned.revisions[0]);
    expect(result.captureScope).not.toBe(returned.captureScope);
    expect(Object.isFrozen(result.revisions[0]?.session.source)).toBe(true);
    expect(Object.isFrozen(result.revisions[0]?.counts)).toBe(true);
    expect(reader.close).toHaveBeenCalledOnce();
  });

  test("does not open an unavailable library", async () => {
    const lifecycle = lifecycleWith(emptyManifest(), "recovery-required");

    await expect(createSessionManifest({ paths, lifecycle })).rejects.toBeInstanceOf(
      SessionLibraryError,
    );
    expect(lifecycle.openReader).not.toHaveBeenCalled();
  });

  test("closes after repository failure and preserves combined failures", async () => {
    const lifecycle = lifecycleWith(emptyManifest());
    const reader = await lifecycle.openReader(paths);
    const readFailure = new Error("read failed");
    const closeFailure = new Error("close failed");
    vi.mocked(reader.query.manifest).mockRejectedValueOnce(readFailure);
    vi.mocked(reader.close).mockRejectedValueOnce(closeFailure);
    lifecycle.openReader.mockClear();

    const failure = await createSessionManifest({ paths, lifecycle }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([readFailure, closeFailure]);
    expect((failure as Error).cause).toBe(readFailure);
    expect(reader.close).toHaveBeenCalledOnce();
  });
});

function lifecycleWith(
  manifest: SessionManifestResult,
  state: "ready" | "uninitialized" | "recovery-required" = "ready",
) {
  const query = {
    entries: vi.fn<SessionQueryRepository["entries"]>(),
    list: vi.fn<SessionQueryRepository["list"]>(),
    manifest: vi.fn<SessionQueryRepository["manifest"]>(async () => manifest),
    search: vi.fn<SessionQueryRepository["search"]>(),
  } satisfies SessionQueryRepository;
  const reader = {
    state: {
      status: "ready" as const,
      initialized: true as const,
      schemaVersion: 2,
      supportedSchemaVersion: 2,
    },
    sessions: {} as SessionIndexReader,
    query,
    close: vi.fn<() => Promise<void>>(async () => undefined),
  };
  return {
    inspect: vi.fn<IndexLifecycle["inspect"]>(async () => {
      if (state === "ready") return reader.state;
      if (state === "uninitialized") {
        return {
          status: "uninitialized" as const,
          initialized: false as const,
          schemaVersion: null,
          supportedSchemaVersion: 2,
        };
      }
      return {
        status: "recovery-required" as const,
        initialized: true as const,
        schemaVersion: null,
        supportedSchemaVersion: 2,
      };
    }),
    openReader: vi.fn<IndexLifecycle["openReader"]>(async () => reader),
    openWriter: vi.fn<IndexLifecycle["openWriter"]>(),
    inspectHealth: vi.fn<IndexLifecycle["inspectHealth"]>(),
  } satisfies IndexLifecycle;
}

function emptyManifest(): SessionManifestResult {
  return {
    selection: createSessionManifestQuery().selection,
    captureScope: emptyCompleteCaptureScope,
    revisions: [],
  };
}

function manifestResult(): SessionManifestResult {
  return {
    selection: createSessionManifestQuery().selection,
    captureScope: completeCaptureScope,
    revisions: [
      {
        session: {
          source: { kind: "synthetic", instanceId: "Profile-A" },
          nativeId: "one",
        },
        documentDigest: {
          scheme: "sha256-sessions-document-jcs-v1",
          digest: "0".repeat(64),
        },
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-20T00:00:00.000Z",
        capturedAt: "2026-07-21T00:00:00.000Z",
        sourceObservedAt: "2026-07-21T00:01:00.000Z",
        sourceState: "present",
        freshness: "current",
        adapterVersion: "synthetic-v1",
        lineageCoverage: "complete",
        root: { kind: "unknown" },
        counts: {
          relations: 1,
          entries: 2,
          segments: 3,
          omittedSegments: 1,
          textUtf8Bytes: 5,
        },
      },
    ],
  };
}
