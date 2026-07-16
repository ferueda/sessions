import { describe, expect, test } from "vitest";

import {
  assessCaptureScopeFilters,
  createSessionCaptureScope,
  createUninitializedCaptureScope,
  type SessionCaptureScope,
} from "../../src/domain/session-capture-scope.ts";

describe("session capture scope", () => {
  test("classifies active filter names in canonical order without values", () => {
    const assessment = assessCaptureScopeFilters({
      toolName: "private-tool",
      source: "synthetic",
      activityBefore: "2026-07-16T00:00:00.000Z",
      nativeId: "private-session",
      session: {
        source: { kind: "synthetic", instanceId: "private-instance" },
        nativeId: "private-session",
      },
      searchText: "private transcript marker",
    });

    expect(assessment).toEqual({
      appliedFilters: ["source", "nativeId", "session"],
      unassessedFilters: ["activityBefore", "toolName", "searchText"],
    });
    expect(JSON.stringify(assessment)).not.toContain("private-");
  });

  test("creates a deeply immutable complete scope", () => {
    const scope = createSessionCaptureScope(completeScope());

    expect(scope.status).toBe("complete");
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.retainedSessions)).toBe(true);
    expect(Object.isFrozen(scope.latestFailures)).toBe(true);
    expect(Object.isFrozen(scope.appliedFilters)).toBe(true);
  });

  test("creates an explicit zero uninitialized scope with filter disclosure", () => {
    expect(
      createUninitializedCaptureScope({ source: "codex", workspace: "/private", searchText: "x" }),
    ).toEqual({
      status: "uninitialized",
      trackedSessions: 0,
      retainedSessions: { current: 0, stale: 0 },
      unindexedSessions: 0,
      sourceState: { present: 0, missing: 0, unknown: 0 },
      sourceCoverage: { complete: 0, unknown: 0 },
      latestFailures: {
        unavailable: 0,
        unreadable: 0,
        malformed: 0,
        sourceChanged: 0,
        unsupportedFormat: 0,
        repositoryWrite: 0,
      },
      appliedFilters: ["source"],
      unassessedFilters: ["workspace", "searchText"],
    });
  });

  test("rejects inconsistent partitions, status, count, order, and overlap", () => {
    expect(() => createSessionCaptureScope({ ...completeScope(), trackedSessions: 2 })).toThrow(
      /retained-state/u,
    );
    expect(() => createSessionCaptureScope({ ...completeScope(), status: "incomplete" })).toThrow(
      /status/u,
    );
    expect(() => createSessionCaptureScope({ ...completeScope(), trackedSessions: -1 })).toThrow(
      /counts/u,
    );
    expect(() =>
      createSessionCaptureScope({
        ...completeScope(),
        appliedFilters: ["session", "source"],
      }),
    ).toThrow(/canonical order/u);
    expect(() =>
      createSessionCaptureScope({
        ...completeScope(),
        appliedFilters: ["source"],
        unassessedFilters: ["source"],
      }),
    ).toThrow(/overlap/u);
    expect(() =>
      createSessionCaptureScope({
        ...completeScope(),
        appliedFilters: ["workspace"],
      }),
    ).toThrow(/classification/u);
  });
});

function completeScope(): SessionCaptureScope {
  return {
    status: "complete",
    trackedSessions: 1,
    retainedSessions: { current: 1, stale: 0 },
    unindexedSessions: 0,
    sourceState: { present: 1, missing: 0, unknown: 0 },
    sourceCoverage: { complete: 1, unknown: 0 },
    latestFailures: {
      unavailable: 0,
      unreadable: 0,
      malformed: 0,
      sourceChanged: 0,
      unsupportedFormat: 0,
      repositoryWrite: 0,
    },
    appliedFilters: [],
    unassessedFilters: [],
  };
}
