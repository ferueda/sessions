export const CAPTURE_SCOPE_FILTER_NAMES = [
  "source",
  "instance",
  "nativeId",
  "sourceState",
  "workspace",
  "activityAfter",
  "activityBefore",
  "capturedAfter",
  "capturedBefore",
  "observedAfter",
  "observedBefore",
  "session",
  "entryAfter",
  "entryBefore",
  "actor",
  "origin",
  "entryKind",
  "toolName",
  "toolNamespace",
  "searchText",
] as const;

export type CaptureScopeFilterName = (typeof CAPTURE_SCOPE_FILTER_NAMES)[number];

const APPLIED_FILTER_NAMES: ReadonlySet<CaptureScopeFilterName> = new Set([
  "source",
  "instance",
  "nativeId",
  "sourceState",
  "session",
]);

export interface CaptureScopeFilterInput {
  readonly source?: unknown;
  readonly instance?: unknown;
  readonly nativeId?: unknown;
  readonly sourceState?: unknown;
  readonly workspace?: unknown;
  readonly activityAfter?: unknown;
  readonly activityBefore?: unknown;
  readonly capturedAfter?: unknown;
  readonly capturedBefore?: unknown;
  readonly observedAfter?: unknown;
  readonly observedBefore?: unknown;
  readonly session?: unknown;
  readonly entryAfter?: unknown;
  readonly entryBefore?: unknown;
  readonly actor?: unknown;
  readonly origin?: unknown;
  readonly entryKind?: unknown;
  readonly toolName?: unknown;
  readonly toolNamespace?: unknown;
  readonly searchText?: unknown;
}

export interface SessionCaptureScope {
  readonly status: "uninitialized" | "complete" | "incomplete";
  readonly trackedSessions: number;
  readonly retainedSessions: {
    readonly current: number;
    readonly stale: number;
  };
  readonly unindexedSessions: number;
  readonly sourceState: {
    readonly present: number;
    readonly missing: number;
    readonly unknown: number;
  };
  /** Counts registered source instances, not tracked sessions. */
  readonly sourceCoverage: {
    readonly complete: number;
    readonly unknown: number;
  };
  readonly latestFailures: {
    readonly unavailable: number;
    readonly unreadable: number;
    readonly malformed: number;
    readonly sourceChanged: number;
    readonly unsupportedFormat: number;
    readonly repositoryWrite: number;
  };
  readonly appliedFilters: readonly CaptureScopeFilterName[];
  readonly unassessedFilters: readonly CaptureScopeFilterName[];
}

export interface CaptureScopeFilterAssessment {
  readonly appliedFilters: readonly CaptureScopeFilterName[];
  readonly unassessedFilters: readonly CaptureScopeFilterName[];
}

export function assessCaptureScopeFilters(
  input: CaptureScopeFilterInput = {},
): CaptureScopeFilterAssessment {
  const appliedFilters: CaptureScopeFilterName[] = [];
  const unassessedFilters: CaptureScopeFilterName[] = [];
  for (const name of CAPTURE_SCOPE_FILTER_NAMES) {
    if (input[name] === undefined) continue;
    (APPLIED_FILTER_NAMES.has(name) ? appliedFilters : unassessedFilters).push(name);
  }
  return Object.freeze({
    appliedFilters: Object.freeze(appliedFilters),
    unassessedFilters: Object.freeze(unassessedFilters),
  });
}

export function createUninitializedCaptureScope(
  input: CaptureScopeFilterInput = {},
): SessionCaptureScope {
  const filters = assessCaptureScopeFilters(input);
  return createSessionCaptureScope({
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
    ...filters,
  });
}

export function createSessionCaptureScope(input: SessionCaptureScope): SessionCaptureScope {
  const trackedSessions = countAt(input.trackedSessions);
  const retainedCurrent = countAt(input.retainedSessions.current);
  const retainedStale = countAt(input.retainedSessions.stale);
  const unindexedSessions = countAt(input.unindexedSessions);
  const sourceStatePresent = countAt(input.sourceState.present);
  const sourceStateMissing = countAt(input.sourceState.missing);
  const sourceStateUnknown = countAt(input.sourceState.unknown);
  const sourceCoverageComplete = countAt(input.sourceCoverage.complete);
  const sourceCoverageUnknown = countAt(input.sourceCoverage.unknown);
  const latestFailures = Object.freeze({
    unavailable: countAt(input.latestFailures.unavailable),
    unreadable: countAt(input.latestFailures.unreadable),
    malformed: countAt(input.latestFailures.malformed),
    sourceChanged: countAt(input.latestFailures.sourceChanged),
    unsupportedFormat: countAt(input.latestFailures.unsupportedFormat),
    repositoryWrite: countAt(input.latestFailures.repositoryWrite),
  });
  const appliedFilters = copyFilterNames(input.appliedFilters);
  const unassessedFilters = copyFilterNames(input.unassessedFilters);

  if (
    new Set([...appliedFilters, ...unassessedFilters]).size !==
    appliedFilters.length + unassessedFilters.length
  ) {
    throw new TypeError("Capture scope filter fields must not overlap");
  }
  if (
    appliedFilters.some((name) => !APPLIED_FILTER_NAMES.has(name)) ||
    unassessedFilters.some((name) => APPLIED_FILTER_NAMES.has(name))
  ) {
    throw new TypeError("Capture scope filter classification is invalid");
  }
  if (trackedSessions !== retainedCurrent + retainedStale + unindexedSessions) {
    throw new TypeError("Capture scope retained-state counts do not partition tracked sessions");
  }
  if (trackedSessions !== sourceStatePresent + sourceStateMissing + sourceStateUnknown) {
    throw new TypeError("Capture scope source-state counts do not partition tracked sessions");
  }
  if (
    retainedStale + unindexedSessions !==
    latestFailures.unavailable +
      latestFailures.unreadable +
      latestFailures.malformed +
      latestFailures.sourceChanged +
      latestFailures.unsupportedFormat +
      latestFailures.repositoryWrite
  ) {
    throw new TypeError("Capture scope failure counts do not partition unavailable evidence");
  }

  const expectedStatus =
    sourceCoverageComplete + sourceCoverageUnknown > 0 &&
    sourceCoverageUnknown === 0 &&
    retainedStale === 0 &&
    unindexedSessions === 0
      ? "complete"
      : "incomplete";
  if (input.status === "uninitialized") {
    if (trackedSessions !== 0 || sourceCoverageComplete !== 0 || sourceCoverageUnknown !== 0) {
      throw new TypeError("Uninitialized capture scope must have zero evidence counts");
    }
  } else if (input.status !== expectedStatus) {
    throw new TypeError("Capture scope status does not match its evidence counts");
  }

  return Object.freeze({
    status: input.status,
    trackedSessions,
    retainedSessions: Object.freeze({ current: retainedCurrent, stale: retainedStale }),
    unindexedSessions,
    sourceState: Object.freeze({
      present: sourceStatePresent,
      missing: sourceStateMissing,
      unknown: sourceStateUnknown,
    }),
    sourceCoverage: Object.freeze({
      complete: sourceCoverageComplete,
      unknown: sourceCoverageUnknown,
    }),
    latestFailures,
    appliedFilters,
    unassessedFilters,
  });
}

export function copySessionCaptureScope(scope: SessionCaptureScope): SessionCaptureScope {
  return createSessionCaptureScope(scope);
}

function copyFilterNames(
  names: readonly CaptureScopeFilterName[],
): readonly CaptureScopeFilterName[] {
  let previousIndex = -1;
  const copied = names.map((name) => {
    const index = CAPTURE_SCOPE_FILTER_NAMES.indexOf(name);
    if (index < 0 || index <= previousIndex) {
      throw new TypeError("Capture scope filter fields must use canonical order");
    }
    previousIndex = index;
    return name;
  });
  return Object.freeze(copied);
}

function countAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Capture scope counts must be non-negative safe integers");
  }
  return value;
}
