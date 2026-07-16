import type { DatabaseSync } from "node:sqlite";

import {
  assessCaptureScopeFilters,
  createSessionCaptureScope,
  type CaptureScopeFilterInput,
  type SessionCaptureScope,
} from "../../domain/session-capture-scope.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { SessionIdentity } from "../../domain/session.ts";
import { EFFECTIVE_SOURCE_STATE_SQL } from "./sqlite-query-filters.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const FAILURE_CODES = [
  "unavailable",
  "unreadable",
  "malformed",
  "source-changed",
  "unsupported-format",
  "repository-write",
] as const;

export function readSqliteCaptureScope(
  database: DatabaseSync,
  input: CaptureScopeFilterInput = {},
): SessionCaptureScope {
  const coverage = readCoverage(database, input);
  const tracking = readTracking(database, input);
  if (integerAt(tracking.invalid_failure) !== 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }

  const sourceCoverage = {
    complete: integerAt(coverage.complete),
    unknown: integerAt(coverage.unknown),
  };
  const retainedSessions = {
    current: integerAt(tracking.retained_current),
    stale: integerAt(tracking.retained_stale),
  };
  const unindexedSessions = integerAt(tracking.unindexed);
  const status =
    sourceCoverage.complete + sourceCoverage.unknown > 0 &&
    sourceCoverage.unknown === 0 &&
    retainedSessions.stale === 0 &&
    unindexedSessions === 0
      ? "complete"
      : "incomplete";

  try {
    return createSessionCaptureScope({
      status,
      trackedSessions: integerAt(tracking.tracked),
      retainedSessions,
      unindexedSessions,
      sourceState: {
        present: integerAt(tracking.source_present),
        missing: integerAt(tracking.source_missing),
        unknown: integerAt(tracking.source_unknown),
      },
      sourceCoverage,
      latestFailures: {
        unavailable: integerAt(tracking.failure_unavailable),
        unreadable: integerAt(tracking.failure_unreadable),
        malformed: integerAt(tracking.failure_malformed),
        sourceChanged: integerAt(tracking.failure_source_changed),
        unsupportedFormat: integerAt(tracking.failure_unsupported_format),
        repositoryWrite: integerAt(tracking.failure_repository_write),
      },
      ...assessCaptureScopeFilters(input),
    });
  } catch (error) {
    throw new SqliteSessionIndexError("corrupt-data", { cause: error });
  }
}

function readCoverage(database: DatabaseSync, input: CaptureScopeFilterInput): CoverageRow {
  const where = sourceWhere(input);
  return database
    .prepare(
      `SELECT
         SUM(CASE WHEN source.coverage_status = 'complete' THEN 1 ELSE 0 END) AS complete,
         SUM(CASE WHEN source.coverage_status = 'unknown' THEN 1 ELSE 0 END) AS unknown
       FROM sessions_source_instances AS source
       WHERE 1 = 1${where.sql}`,
    )
    .get(...where.parameters) as unknown as CoverageRow;
}

function readTracking(database: DatabaseSync, input: CaptureScopeFilterInput): TrackingRow {
  const where = trackingWhere(input);
  const recognizedFailures = FAILURE_CODES.map(() => "?").join(", ");
  return database
    .prepare(
      `SELECT
         COUNT(*) AS tracked,
         SUM(CASE
           WHEN canonical.session_id IS NOT NULL
            AND tracking.latest_outcome IN ('indexed', 'unchanged')
           THEN 1 ELSE 0 END) AS retained_current,
         SUM(CASE
           WHEN canonical.session_id IS NOT NULL
            AND tracking.latest_outcome = 'failed'
           THEN 1 ELSE 0 END) AS retained_stale,
         SUM(CASE
           WHEN canonical.session_id IS NULL
            AND tracking.latest_outcome = 'failed'
           THEN 1 ELSE 0 END) AS unindexed,
         SUM(CASE WHEN ${EFFECTIVE_SOURCE_STATE_SQL} = 'present' THEN 1 ELSE 0 END)
           AS source_present,
         SUM(CASE WHEN ${EFFECTIVE_SOURCE_STATE_SQL} = 'missing' THEN 1 ELSE 0 END)
           AS source_missing,
         SUM(CASE WHEN ${EFFECTIVE_SOURCE_STATE_SQL} = 'unknown' THEN 1 ELSE 0 END)
           AS source_unknown,
         SUM(CASE WHEN tracking.latest_failure_code = 'unavailable' THEN 1 ELSE 0 END)
           AS failure_unavailable,
         SUM(CASE WHEN tracking.latest_failure_code = 'unreadable' THEN 1 ELSE 0 END)
           AS failure_unreadable,
         SUM(CASE WHEN tracking.latest_failure_code = 'malformed' THEN 1 ELSE 0 END)
           AS failure_malformed,
         SUM(CASE WHEN tracking.latest_failure_code = 'source-changed' THEN 1 ELSE 0 END)
           AS failure_source_changed,
         SUM(CASE WHEN tracking.latest_failure_code = 'unsupported-format' THEN 1 ELSE 0 END)
           AS failure_unsupported_format,
         SUM(CASE WHEN tracking.latest_failure_code = 'repository-write' THEN 1 ELSE 0 END)
           AS failure_repository_write,
         SUM(CASE
           WHEN tracking.latest_outcome = 'failed'
            AND tracking.latest_failure_code NOT IN (${recognizedFailures})
           THEN 1 ELSE 0 END) AS invalid_failure
       FROM sessions_session_tracking AS tracking
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       LEFT JOIN sessions_canonical_sessions AS canonical
         ON canonical.session_id = tracking.session_id
       WHERE 1 = 1${where.sql}`,
    )
    .get(...FAILURE_CODES, ...where.parameters) as unknown as TrackingRow;
}

function sourceWhere(input: CaptureScopeFilterInput): SqlWhere {
  const conditions: string[] = [];
  const parameters: string[] = [];
  appendExact(conditions, parameters, "source.kind", stringAt(input.source));
  appendExact(conditions, parameters, "source.instance_id", stringAt(input.instance));
  const session = sessionAt(input.session);
  if (session !== undefined) {
    appendExact(conditions, parameters, "source.kind", session.source.kind);
    appendExact(conditions, parameters, "source.instance_id", session.source.instanceId);
  }
  return sqlWhere(conditions, parameters);
}

function trackingWhere(input: CaptureScopeFilterInput): SqlWhere {
  const conditions: string[] = [];
  const parameters: string[] = [];
  appendExact(conditions, parameters, "source.kind", stringAt(input.source));
  appendExact(conditions, parameters, "source.instance_id", stringAt(input.instance));
  appendExact(conditions, parameters, "tracking.native_id", stringAt(input.nativeId));
  appendExact(conditions, parameters, EFFECTIVE_SOURCE_STATE_SQL, stringAt(input.sourceState));
  const session = sessionAt(input.session);
  if (session !== undefined) {
    appendExact(conditions, parameters, "source.kind", session.source.kind);
    appendExact(conditions, parameters, "source.instance_id", session.source.instanceId);
    appendExact(conditions, parameters, "tracking.native_id", session.nativeId);
  }
  return sqlWhere(conditions, parameters);
}

function appendExact(
  conditions: string[],
  parameters: string[],
  expression: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  conditions.push(`${expression} = ?`);
  parameters.push(value);
}

function sqlWhere(conditions: readonly string[], parameters: readonly string[]): SqlWhere {
  return {
    sql: conditions.length === 0 ? "" : ` AND ${conditions.join(" AND ")}`,
    parameters,
  };
}

function stringAt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError("Capture scope string filter is invalid");
  return value;
}

function sessionAt(value: unknown): SessionIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isSessionIdentity(value)) throw new TypeError("Capture scope session filter is invalid");
  return value;
}

function integerAt(value: unknown): number {
  if (value === null) return 0;
  const integer = typeof value === "bigint" ? Number(value) : value;
  if (typeof integer !== "number" || !Number.isSafeInteger(integer) || integer < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return integer;
}

interface SqlWhere {
  readonly sql: string;
  readonly parameters: readonly string[];
}

interface CoverageRow {
  readonly complete: unknown;
  readonly unknown: unknown;
}

interface TrackingRow {
  readonly tracked: unknown;
  readonly retained_current: unknown;
  readonly retained_stale: unknown;
  readonly unindexed: unknown;
  readonly source_present: unknown;
  readonly source_missing: unknown;
  readonly source_unknown: unknown;
  readonly failure_unavailable: unknown;
  readonly failure_unreadable: unknown;
  readonly failure_malformed: unknown;
  readonly failure_source_changed: unknown;
  readonly failure_unsupported_format: unknown;
  readonly failure_repository_write: unknown;
  readonly invalid_failure: unknown;
}
