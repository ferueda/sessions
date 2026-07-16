import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import { readSqliteCaptureScope } from "../../src/infrastructure/sqlite/sqlite-capture-scope.ts";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("SQLite capture scope", () => {
  test("keeps source coverage visible when no tracking row or result matches", () => {
    const database = migratedDatabase();
    insertSource(database, "synthetic", "complete", "complete");
    insertSource(database, "synthetic", "unknown", "unknown");

    expect(readSqliteCaptureScope(database, { source: "synthetic", instance: "complete" })).toEqual(
      {
        ...zeroScope(),
        status: "complete",
        sourceCoverage: { complete: 1, unknown: 0 },
        appliedFilters: ["source", "instance"],
      },
    );
    expect(
      readSqliteCaptureScope(database, {
        source: "synthetic",
        instance: "unknown",
        nativeId: "no-match",
        sourceState: "present",
      }),
    ).toEqual({
      ...zeroScope(),
      status: "incomplete",
      sourceCoverage: { complete: 0, unknown: 1 },
      appliedFilters: ["source", "instance", "nativeId", "sourceState"],
    });
    expect(readSqliteCaptureScope(database, { source: "not-registered" })).toMatchObject({
      status: "incomplete",
      trackedSessions: 0,
      sourceCoverage: { complete: 0, unknown: 0 },
    });
  });

  test("partitions retained, unindexed, source state, failures, and filters", () => {
    const database = migratedDatabase();
    const complete = insertSource(database, "synthetic", "complete", "complete");
    const unknown = insertSource(database, "synthetic", "unknown", "unknown");
    insertTracking(database, complete, "current", { state: "current", presence: "present" });
    insertTracking(database, complete, "stale", {
      state: "stale",
      presence: "missing",
      failure: "source-changed",
    });
    insertTracking(database, complete, "unindexed", {
      state: "unindexed",
      presence: "present",
      failure: "unreadable",
    });
    insertTracking(database, unknown, "unknown-state", { state: "current", presence: "missing" });

    expect(
      readSqliteCaptureScope(database, {
        source: "synthetic",
        workspace: "/private/workspace",
        observedAfter: "2026-07-16T00:00:00.000Z",
        actor: "model",
        toolNamespace: "private-tools",
        searchText: "private transcript",
      }),
    ).toEqual({
      status: "incomplete",
      trackedSessions: 4,
      retainedSessions: { current: 2, stale: 1 },
      unindexedSessions: 1,
      sourceState: { present: 2, missing: 1, unknown: 1 },
      sourceCoverage: { complete: 1, unknown: 1 },
      latestFailures: {
        unavailable: 0,
        unreadable: 1,
        malformed: 0,
        sourceChanged: 1,
        unsupportedFormat: 0,
        repositoryWrite: 0,
      },
      appliedFilters: ["source"],
      unassessedFilters: ["workspace", "observedAfter", "actor", "toolNamespace", "searchText"],
    });

    expect(readSqliteCaptureScope(database, { sourceState: "missing" })).toMatchObject({
      trackedSessions: 1,
      retainedSessions: { current: 0, stale: 1 },
      unindexedSessions: 0,
      sourceState: { present: 0, missing: 1, unknown: 0 },
      latestFailures: { sourceChanged: 1 },
      sourceCoverage: { complete: 1, unknown: 1 },
    });
  });

  test("reports every latest failure kind without exposing tracked identities", () => {
    const database = migratedDatabase();
    const source = insertSource(database, "synthetic", "failures", "complete");
    const failures = [
      "unavailable",
      "unreadable",
      "malformed",
      "source-changed",
      "unsupported-format",
      "repository-write",
    ] as const;
    for (const [index, failure] of failures.entries()) {
      insertTracking(database, source, `private-${String(index)}`, {
        state: "unindexed",
        presence: "present",
        failure,
      });
    }

    const scope = readSqliteCaptureScope(database, { source: "synthetic", instance: "failures" });
    expect(scope.latestFailures).toEqual({
      unavailable: 1,
      unreadable: 1,
      malformed: 1,
      sourceChanged: 1,
      unsupportedFormat: 1,
      repositoryWrite: 1,
    });
    expect(JSON.stringify(scope)).not.toContain("private-");
  });
});

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  applyMigrations(database);
  databases.push(database);
  return database;
}

function insertSource(
  database: DatabaseSync,
  kind: string,
  instanceId: string,
  coverage: "complete" | "unknown",
): number | bigint {
  return database
    .prepare(
      `INSERT INTO sessions_source_instances (
         kind, instance_id, coverage_status, coverage_observed_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(kind, instanceId, coverage, "2026-07-16T12:00:00.000Z").lastInsertRowid;
}

function insertTracking(
  database: DatabaseSync,
  sourceInstanceId: number | bigint,
  nativeId: string,
  input: {
    readonly state: "current" | "stale" | "unindexed";
    readonly presence: "present" | "missing";
    readonly failure?: string;
  },
): void {
  const retained = input.state !== "unindexed";
  const failed = input.state !== "current";
  const digest = nativeId.padEnd(64, "a").slice(0, 64);
  const result = database
    .prepare(
      `INSERT INTO sessions_session_tracking (
         source_instance_id, native_id,
         last_good_fingerprint_scheme, last_good_fingerprint_digest,
         last_good_adapter_version,
         latest_fingerprint_scheme, latest_fingerprint_digest,
         latest_adapter_version, latest_outcome, latest_failure_code,
         presence_status, presence_observed_at, captured_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, 'sha256-json-v1', ?, 'fixture-v2', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceInstanceId,
      nativeId,
      retained ? "sha256-json-v1" : null,
      retained ? digest : null,
      retained ? "fixture-v1" : null,
      digest,
      failed ? "failed" : "indexed",
      input.failure ?? null,
      input.presence,
      "2026-07-16T12:00:00.000Z",
      retained ? "2026-07-16T11:00:00.000Z" : null,
      "2026-07-16T12:00:00.000Z",
    );
  if (!retained) return;
  database
    .prepare(
      `INSERT INTO sessions_canonical_sessions (
         session_id, lineage_coverage, document_digest_scheme, document_digest
       ) VALUES (?, 'unknown', 'sha256-sessions-document-jcs-v1', ?)`,
    )
    .run(result.lastInsertRowid, new Uint8Array(32));
}

function zeroScope() {
  return {
    status: "incomplete" as const,
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
    appliedFilters: [],
    unassessedFilters: [],
  };
}
