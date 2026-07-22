import type {
  IndexCaptureScopeHealth,
  IndexHealthInspector,
  ReadyIndexHealth,
} from "../../application/ports/index-health.ts";
import type { IndexPaths, IndexStateInspector } from "../../application/ports/index-lifecycle.ts";
import type { RuntimeDiagnostic } from "../../application/ports/runtime-diagnostic.ts";
import type { IndexState } from "../../domain/index-state.ts";
import {
  reportDoctorProgress,
  type DoctorProgressObserver,
} from "../../application/doctor-progress.ts";
import { timeDoctorOperation, type DoctorTimingRecorder } from "../../application/doctor-timing.ts";

export interface IndexStateDiagnosticOptions {
  readonly progress?: DoctorProgressObserver;
  readonly timing?: DoctorTimingRecorder;
}

export function createIndexStateDiagnostic(
  resolvePaths: () => IndexPaths,
  inspector: IndexStateInspector & IndexHealthInspector,
  options: IndexStateDiagnosticOptions = {},
): RuntimeDiagnostic {
  return {
    id: "library-state",
    label: "Sessions library",
    async run() {
      const paths = resolvePaths();
      reportDoctorProgress(options.progress, { phase: "library-state" });
      const state = await timeDoctorOperation(options.timing, "libraryState", () =>
        inspector.inspect(paths),
      );
      if (state.status === "ready") {
        try {
          const health = await inspector.inspectHealth(paths, {
            ...(options.progress === undefined ? {} : { progress: options.progress }),
            ...(options.timing === undefined ? {} : { timing: options.timing }),
          });
          return {
            ok: health.ok,
            summary: !health.ok
              ? `Index schema ${String(state.schemaVersion)} failed health checks`
              : health.captureScope.status === "incomplete"
                ? `Index schema ${String(state.schemaVersion)} is ready; evidence may be incomplete`
                : `Index schema ${String(state.schemaVersion)} is ready`,
            details: { ...detailsFor(state), ...healthDetails(health) },
          };
        } catch {
          return {
            ok: false,
            summary: `Index schema ${String(state.schemaVersion)} health inspection failed`,
            details: { ...detailsFor(state), health: "inspection-failed" },
          };
        }
      }
      return {
        ok: state.status === "uninitialized",
        summary: summarize(state),
        details: detailsFor(state),
      };
    },
  };
}

function healthDetails(health: ReadyIndexHealth): Readonly<Record<string, string>> {
  return {
    canonicalIntegrity: health.canonicalIntegrity,
    foreignKeys: health.foreignKeys,
    contentReachability: health.contentReachability,
    orphanContentRows: health.orphanContentRows,
    orphanContentBytes: health.orphanContentBytes,
    ftsStructure: health.ftsStructure,
    ftsContent: health.ftsContent,
    ftsSecureDelete: health.ftsSecureDelete,
    ftsRemediation: health.ftsRemediation,
    pageReclamation: health.pageReclamation,
    runRecords: health.runRecords,
    writerLease: health.writerLease,
    activeRuns: String(health.activeRuns),
    interruptedRuns: String(health.interruptedRuns),
    ...captureScopeDetails(health.captureScope),
  };
}

function captureScopeDetails(scope: IndexCaptureScopeHealth): Readonly<Record<string, string>> {
  if (scope.status === "inspection-failed") {
    return {
      captureStatus: scope.status,
      trackedSessions: "unknown",
      retainedCurrentSessions: "unknown",
      retainedStaleSessions: "unknown",
      unindexedSessions: "unknown",
      sourceStatePresentSessions: "unknown",
      sourceStateMissingSessions: "unknown",
      sourceStateUnknownSessions: "unknown",
      sourceCoverageComplete: "unknown",
      sourceCoverageUnknown: "unknown",
      latestFailureUnavailable: "unknown",
      latestFailureUnreadable: "unknown",
      latestFailureMalformed: "unknown",
      latestFailureSourceChanged: "unknown",
      latestFailureUnsupportedFormat: "unknown",
      latestFailureRepositoryWrite: "unknown",
    };
  }
  return {
    captureStatus: scope.status,
    trackedSessions: String(scope.trackedSessions),
    retainedCurrentSessions: String(scope.retainedSessions.current),
    retainedStaleSessions: String(scope.retainedSessions.stale),
    unindexedSessions: String(scope.unindexedSessions),
    sourceStatePresentSessions: String(scope.sourceState.present),
    sourceStateMissingSessions: String(scope.sourceState.missing),
    sourceStateUnknownSessions: String(scope.sourceState.unknown),
    sourceCoverageComplete: String(scope.sourceCoverage.complete),
    sourceCoverageUnknown: String(scope.sourceCoverage.unknown),
    latestFailureUnavailable: String(scope.latestFailures.unavailable),
    latestFailureUnreadable: String(scope.latestFailures.unreadable),
    latestFailureMalformed: String(scope.latestFailures.malformed),
    latestFailureSourceChanged: String(scope.latestFailures.sourceChanged),
    latestFailureUnsupportedFormat: String(scope.latestFailures.unsupportedFormat),
    latestFailureRepositoryWrite: String(scope.latestFailures.repositoryWrite),
  };
}

function summarize(state: IndexState): string {
  switch (state.status) {
    case "uninitialized":
      return "Index is not initialized; explicit indexing will create it";
    case "ready":
      return `Index schema ${String(state.schemaVersion)} is ready`;
    case "migration-required":
      return `Index schema ${String(state.schemaVersion)} requires migration to ${String(state.supportedSchemaVersion)}`;
    case "newer-schema":
      return `Index schema ${String(state.schemaVersion)} is newer than supported schema ${String(state.supportedSchemaVersion)}`;
    case "incompatible":
      return `Index is incompatible (${state.reason})`;
    case "recovery-required":
      return "Index has active or recovery sidecar files";
    case "unsafe":
      return `Index ${state.target} is unsafe (${state.reason})`;
  }
  return assertNever(state);
}

function detailsFor(state: IndexState): Readonly<Record<string, string>> {
  return {
    state: state.status,
    initialized: String(state.initialized),
    schemaVersion: state.schemaVersion === null ? "unknown" : String(state.schemaVersion),
    supportedSchemaVersion: String(state.supportedSchemaVersion),
    ...(state.status === "incompatible" ? { reason: state.reason } : {}),
    ...(state.status === "unsafe" ? { target: state.target, reason: state.reason } : {}),
  };
}

function assertNever(value: never): never {
  throw new Error("Unhandled index state", { cause: value });
}
