import type { SessionCaptureScope } from "../../src/domain/session-capture-scope.ts";

export const completeCaptureScope = Object.freeze({
  status: "complete",
  trackedSessions: 1,
  retainedSessions: Object.freeze({ current: 1, stale: 0 }),
  unindexedSessions: 0,
  sourceState: Object.freeze({ present: 1, missing: 0, unknown: 0 }),
  sourceCoverage: Object.freeze({ complete: 1, unknown: 0 }),
  latestFailures: Object.freeze({
    unavailable: 0,
    unreadable: 0,
    malformed: 0,
    sourceChanged: 0,
    unsupportedFormat: 0,
    repositoryWrite: 0,
  }),
  appliedFilters: Object.freeze([]),
  unassessedFilters: Object.freeze([]),
}) satisfies SessionCaptureScope;

export const emptyCompleteCaptureScope = Object.freeze({
  ...completeCaptureScope,
  trackedSessions: 0,
  retainedSessions: Object.freeze({ current: 0, stale: 0 }),
  sourceState: Object.freeze({ present: 0, missing: 0, unknown: 0 }),
}) satisfies SessionCaptureScope;

export const uninitializedCaptureScope = Object.freeze({
  ...emptyCompleteCaptureScope,
  status: "uninitialized",
  sourceCoverage: Object.freeze({ complete: 0, unknown: 0 }),
}) satisfies SessionCaptureScope;
