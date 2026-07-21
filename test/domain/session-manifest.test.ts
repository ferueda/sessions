import { describe, expect, test } from "vitest";

import {
  createSessionManifestQuery,
  createSessionManifestResult,
  MAX_SESSION_MANIFEST_REVISIONS,
  SESSION_MANIFEST_ORDER,
  type SessionManifestRevision,
} from "../../src/domain/session-manifest.ts";
import { emptyCompleteCaptureScope } from "../fixtures/session-capture-scope.ts";

describe("session manifest", () => {
  test("admits, normalizes, copies, and freezes the workspace-free selection", () => {
    const session = {
      source: { kind: "synthetic", instanceId: "Profile-A" },
      nativeId: "one",
    };
    const filter = {
      source: "synthetic",
      instance: "Profile-A",
      sourceState: "present" as const,
      capturedAfter: "2026-07-20T00:00:00.000Z",
      capturedBefore: "2026-07-21T00:00:00.000Z",
      session,
    };

    const query = createSessionManifestQuery({ filter });
    session.source.instanceId = "changed";

    expect(query.selection).toEqual({
      order: SESSION_MANIFEST_ORDER,
      maximumRevisions: MAX_SESSION_MANIFEST_REVISIONS,
      filters: {
        source: "synthetic",
        instance: "Profile-A",
        sourceState: "present",
        capturedAfter: "2026-07-20T00:00:00.000Z",
        capturedBefore: "2026-07-21T00:00:00.000Z",
        session: {
          source: { kind: "synthetic", instanceId: "Profile-A" },
          nativeId: "one",
        },
      },
    });
    expect(query.filter).toBe(query.selection.filters);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.selection)).toBe(true);
    expect(Object.isFrozen(query.filter)).toBe(true);
    expect(Object.isFrozen(query.filter.session?.source)).toBe(true);
  });

  test("rejects a runtime workspace field before shared filter admission", () => {
    expect(() =>
      createSessionManifestQuery({
        filter: { workspace: undefined } as never,
      }),
    ).toThrow("does not accept a workspace filter");
    expect(() =>
      createSessionManifestQuery({
        filter: Object.create({ workspace: "/private" }) as never,
      }),
    ).toThrow("does not accept a workspace filter");
  });

  test.each([
    { instance: "missing-source" },
    { source: "Invalid Source" },
    { activityAfter: "not-a-time" },
    {
      capturedAfter: "2026-07-21T00:00:00.000Z",
      capturedBefore: "2026-07-20T00:00:00.000Z",
    },
  ])("rejects invalid shared filters %#", (filter) => {
    expect(() => createSessionManifestQuery({ filter })).toThrow(TypeError);
  });

  test("validates and deeply copies the complete public result", () => {
    const query = createSessionManifestQuery();
    const revision = manifestRevision();
    const result = createSessionManifestResult({
      selection: query.selection,
      captureScope: emptyCompleteCaptureScope,
      revisions: [revision],
    });

    (revision.session.source as { instanceId: string }).instanceId = "mutated";
    (revision.counts as { entries: number }).entries = 99;

    expect(result.revisions[0]).toEqual(manifestRevision());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.revisions)).toBe(true);
    expect(Object.isFrozen(result.revisions[0]?.session.source)).toBe(true);
    expect(Object.isFrozen(result.revisions[0]?.documentDigest)).toBe(true);
    expect(Object.isFrozen(result.revisions[0]?.root)).toBe(true);
    expect(Object.isFrozen(result.revisions[0]?.counts)).toBe(true);
  });

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid manifest metric %s",
    (entries) => {
      const query = createSessionManifestQuery();
      expect(() =>
        createSessionManifestResult({
          selection: query.selection,
          captureScope: emptyCompleteCaptureScope,
          revisions: [{ ...manifestRevision(), counts: { ...manifestRevision().counts, entries } }],
        }),
      ).toThrow(TypeError);
    },
  );

  test("rejects a mismatched fixed selection contract", () => {
    const query = createSessionManifestQuery();
    expect(() =>
      createSessionManifestResult({
        selection: { ...query.selection, maximumRevisions: 9_999 } as never,
        captureScope: emptyCompleteCaptureScope,
        revisions: [],
      }),
    ).toThrow("selection is invalid");
  });

  test("rejects duplicate, out-of-order, and internally inconsistent revision evidence", () => {
    const query = createSessionManifestQuery();
    const first = manifestRevision();
    const earlier = {
      ...manifestRevision(),
      session: {
        source: { kind: "synthetic", instanceId: "Profile-A" },
        nativeId: "before",
      },
    };
    for (const revisions of [
      [first, first],
      [first, earlier],
    ]) {
      expect(() =>
        createSessionManifestResult({
          selection: query.selection,
          captureScope: emptyCompleteCaptureScope,
          revisions,
        }),
      ).toThrow("canonical identity order");
    }
    expect(() =>
      createSessionManifestResult({
        selection: query.selection,
        captureScope: emptyCompleteCaptureScope,
        revisions: [
          {
            ...first,
            counts: { ...first.counts, segments: 0, omittedSegments: 1 },
          },
        ],
      }),
    ).toThrow("omitted segments exceed");
  });
});

function manifestRevision(): SessionManifestRevision {
  return {
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
    root: {
      kind: "known",
      root: {
        source: { kind: "synthetic", instanceId: "Profile-A" },
        nativeId: "root",
      },
    },
    counts: {
      relations: 1,
      entries: 2,
      segments: 3,
      omittedSegments: 1,
      textUtf8Bytes: 5,
    },
  };
}
