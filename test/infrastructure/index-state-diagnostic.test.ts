import { describe, expect, test } from "vitest";

import type {
  IndexHealthInspector,
  ReadyIndexHealth,
} from "../../src/application/ports/index-health.ts";
import type {
  IndexPaths,
  IndexStateInspector,
} from "../../src/application/ports/index-lifecycle.ts";
import type { IndexState } from "../../src/domain/index-state.ts";
import type { SessionCaptureScope } from "../../src/domain/session-capture-scope.ts";
import { createIndexStateDiagnostic } from "../../src/infrastructure/state/index-state-diagnostic.ts";

const paths: IndexPaths = {
  directory: "/cache/sessions",
  scratch: "/cache/sessions/.scratch",
  database: "/cache/sessions/sessions.sqlite3",
  wal: "/cache/sessions/sessions.sqlite3-wal",
  shm: "/cache/sessions/sessions.sqlite3-shm",
};

describe("createIndexStateDiagnostic", () => {
  test("treats an uninitialized index as healthy with neutral guidance", async () => {
    const outcome = await diagnosticFor({
      status: "uninitialized",
      initialized: false,
      schemaVersion: null,
      supportedSchemaVersion: 1,
    }).run();

    expect(outcome).toEqual({
      ok: true,
      summary: "Index is not initialized; explicit indexing will create it",
      details: {
        state: "uninitialized",
        initialized: "false",
        schemaVersion: "unknown",
        supportedSchemaVersion: "1",
      },
    });
  });

  test("reports a ready schema as healthy", async () => {
    const outcome = await diagnosticFor({
      status: "ready",
      initialized: true,
      schemaVersion: 1,
      supportedSchemaVersion: 1,
    }).run();

    expect(outcome).toMatchObject({
      ok: true,
      summary: "Index schema 1 is ready",
      details: {
        state: "ready",
        schemaVersion: "1",
        canonicalIntegrity: "ok",
        foreignKeys: "ok",
        contentReachability: "ok",
        orphanContentRows: "0",
        orphanContentBytes: "0",
        ftsStructure: "ok",
        ftsContent: "ok",
        ftsSecureDelete: "enabled",
        ftsRemediation: "not-needed",
        pageReclamation: "incremental",
        runRecords: "ok",
        writerLease: "free",
        activeRuns: "0",
        interruptedRuns: "0",
        captureStatus: "complete",
        trackedSessions: "0",
        retainedCurrentSessions: "0",
        retainedStaleSessions: "0",
        unindexedSessions: "0",
        sourceStatePresentSessions: "0",
        sourceStateMissingSessions: "0",
        sourceStateUnknownSessions: "0",
        sourceCoverageComplete: "1",
        sourceCoverageUnknown: "0",
        latestFailureUnavailable: "0",
        latestFailureUnreadable: "0",
        latestFailureMalformed: "0",
        latestFailureSourceChanged: "0",
        latestFailureUnsupportedFormat: "0",
        latestFailureRepositoryWrite: "0",
      },
    });
  });

  test("warns without failing when ready-library evidence may be incomplete", async () => {
    const outcome = await diagnosticFor(
      {
        status: "ready",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 1,
      },
      { ...healthyIndex, captureScope: incompleteCaptureScope },
    ).run();

    expect(outcome).toMatchObject({
      ok: true,
      summary: "Index schema 1 is ready; evidence may be incomplete",
      details: {
        captureStatus: "incomplete",
        trackedSessions: "1",
        retainedCurrentSessions: "0",
        retainedStaleSessions: "0",
        unindexedSessions: "1",
        sourceStatePresentSessions: "1",
        sourceStateMissingSessions: "0",
        sourceStateUnknownSessions: "0",
        sourceCoverageComplete: "1",
        sourceCoverageUnknown: "0",
        latestFailureUnavailable: "0",
        latestFailureUnreadable: "1",
        latestFailureMalformed: "0",
        latestFailureSourceChanged: "0",
        latestFailureUnsupportedFormat: "0",
        latestFailureRepositoryWrite: "0",
      },
    });
  });

  test("reports typed ready-index health failures without sensitive details", async () => {
    const outcome = await diagnosticFor(
      {
        status: "ready",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 1,
      },
      {
        ...healthyIndex,
        ok: false,
        ftsContent: "failed",
        ftsRemediation: "rebuild-required",
        writerLease: "expired",
        activeRuns: 1,
        interruptedRuns: 2,
        captureScope: incompleteCaptureScope,
      },
    ).run();

    expect(outcome).toEqual({
      ok: false,
      summary: "Index schema 1 failed health checks",
      details: {
        state: "ready",
        initialized: "true",
        schemaVersion: "1",
        supportedSchemaVersion: "1",
        canonicalIntegrity: "ok",
        foreignKeys: "ok",
        contentReachability: "ok",
        orphanContentRows: "0",
        orphanContentBytes: "0",
        ftsStructure: "ok",
        ftsContent: "failed",
        ftsSecureDelete: "enabled",
        ftsRemediation: "rebuild-required",
        pageReclamation: "incremental",
        runRecords: "ok",
        writerLease: "expired",
        activeRuns: "1",
        interruptedRuns: "2",
        captureStatus: "incomplete",
        trackedSessions: "1",
        retainedCurrentSessions: "0",
        retainedStaleSessions: "0",
        unindexedSessions: "1",
        sourceStatePresentSessions: "1",
        sourceStateMissingSessions: "0",
        sourceStateUnknownSessions: "0",
        sourceCoverageComplete: "1",
        sourceCoverageUnknown: "0",
        latestFailureUnavailable: "0",
        latestFailureUnreadable: "1",
        latestFailureMalformed: "0",
        latestFailureSourceChanged: "0",
        latestFailureUnsupportedFormat: "0",
        latestFailureRepositoryWrite: "0",
      },
    });
  });

  test("reports invalid page reclamation as a typed health detail", async () => {
    const outcome = await diagnosticFor(
      {
        status: "ready",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 1,
      },
      { ...healthyIndex, ok: false, pageReclamation: "invalid" },
    ).run();

    expect(outcome).toMatchObject({
      ok: false,
      summary: "Index schema 1 failed health checks",
      details: { pageReclamation: "invalid" },
    });
  });

  test("reports compact lease ownership without exposing its token", async () => {
    const outcome = await diagnosticFor(
      {
        status: "ready",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 1,
      },
      { ...healthyIndex, writerLease: "compact-live" },
    ).run();

    expect(outcome).toMatchObject({
      ok: true,
      details: { writerLease: "compact-live" },
    });
  });

  test("reports repair lease ownership without exposing private details", async () => {
    const outcome = await diagnosticFor(
      {
        status: "ready",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 1,
      },
      { ...healthyIndex, writerLease: "repair-live" },
    ).run();

    expect(outcome).toMatchObject({
      ok: true,
      details: { writerLease: "repair-live" },
    });
  });

  test("sanitizes an unexpected ready-index health inspection failure", async () => {
    const state: IndexState = {
      status: "ready",
      initialized: true,
      schemaVersion: 1,
      supportedSchemaVersion: 1,
    };
    const inspector: IndexStateInspector & IndexHealthInspector = {
      async inspect() {
        return state;
      },
      async inspectHealth() {
        throw new Error("database path and SQL details");
      },
    };

    await expect(createIndexStateDiagnostic(() => paths, inspector).run()).resolves.toEqual({
      ok: false,
      summary: "Index schema 1 health inspection failed",
      details: {
        state: "ready",
        initialized: "true",
        schemaVersion: "1",
        supportedSchemaVersion: "1",
        health: "inspection-failed",
      },
    });
  });

  test.each<{
    readonly state: IndexState;
    readonly summary: string;
  }>([
    {
      state: {
        status: "migration-required",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 2,
      },
      summary: "Index schema 1 requires migration to 2",
    },
    {
      state: {
        status: "newer-schema",
        initialized: true,
        schemaVersion: 2,
        supportedSchemaVersion: 1,
      },
      summary: "Index schema 2 is newer than supported schema 1",
    },
    {
      state: {
        status: "incompatible",
        initialized: true,
        schemaVersion: null,
        supportedSchemaVersion: 1,
        reason: "unrecognized-database",
      },
      summary: "Index is incompatible (unrecognized-database)",
    },
    {
      state: {
        status: "recovery-required",
        initialized: true,
        schemaVersion: null,
        supportedSchemaVersion: 1,
      },
      summary: "Index has active or recovery sidecar files",
    },
    {
      state: {
        status: "unsafe",
        initialized: false,
        schemaVersion: null,
        supportedSchemaVersion: 1,
        target: "directory",
        reason: "permissions",
      },
      summary: "Index directory is unsafe (permissions)",
    },
  ])("fails unhealthy index state $state.status", async ({ state, summary }) => {
    const outcome = await diagnosticFor(state).run();

    expect(outcome).toMatchObject({ ok: false, summary });
  });
});

const healthyIndex: ReadyIndexHealth = {
  ok: true,
  captureScope: {
    status: "complete",
    trackedSessions: 0,
    retainedSessions: { current: 0, stale: 0 },
    unindexedSessions: 0,
    sourceState: { present: 0, missing: 0, unknown: 0 },
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
  },
  canonicalIntegrity: "ok",
  foreignKeys: "ok",
  contentReachability: "ok",
  orphanContentRows: "0",
  orphanContentBytes: "0",
  ftsStructure: "ok",
  ftsContent: "ok",
  ftsSecureDelete: "enabled",
  ftsRemediation: "not-needed",
  pageReclamation: "incremental",
  runRecords: "ok",
  writerLease: "free",
  activeRuns: 0,
  interruptedRuns: 0,
};

const incompleteCaptureScope: SessionCaptureScope = {
  status: "incomplete",
  trackedSessions: 1,
  retainedSessions: { current: 0, stale: 0 },
  unindexedSessions: 1,
  sourceState: { present: 1, missing: 0, unknown: 0 },
  sourceCoverage: { complete: 1, unknown: 0 },
  latestFailures: {
    unavailable: 0,
    unreadable: 1,
    malformed: 0,
    sourceChanged: 0,
    unsupportedFormat: 0,
    repositoryWrite: 0,
  },
  appliedFilters: [],
  unassessedFilters: [],
};

function diagnosticFor(state: IndexState, health: ReadyIndexHealth = healthyIndex) {
  const inspector: IndexStateInspector & IndexHealthInspector = {
    async inspect(actualPaths) {
      expect(actualPaths).toBe(paths);
      return state;
    },
    async inspectHealth(actualPaths) {
      expect(actualPaths).toBe(paths);
      return health;
    },
  };
  return createIndexStateDiagnostic(() => paths, inspector);
}
