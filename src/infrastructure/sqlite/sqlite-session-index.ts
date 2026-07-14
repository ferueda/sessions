import type { DatabaseSync } from "node:sqlite";

import {
  createSessionIndexRunId,
  type IndexRunCounts,
  type SessionIndexFailureCode,
  type SessionIndexRun,
  type SessionIndexWriter,
} from "../../application/ports/session-index.ts";
import type { SessionObservation } from "../../application/validate-session.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { SessionIdentity, SourceInstance } from "../../domain/session.ts";
import {
  garbageCollectContent,
  readCanonicalDocument,
  replaceCanonicalDocument,
} from "./sqlite-session-document.ts";
import {
  findSessionTracking,
  hasCanonicalDocument,
  lastGoodRevision,
  readSessionFreshness,
  readSessionSummary,
  sameRevision,
} from "./sqlite-session-state.ts";
import { runImmediateTransaction, SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const FAILURE_CODES: ReadonlySet<string> = new Set<SessionIndexFailureCode>([
  "unavailable",
  "unreadable",
  "malformed",
  "source-changed",
  "unsupported-format",
  "repository-write",
]);
const RUN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "source-unavailable",
  "source-unreadable",
  "discovery-failed",
  "interrupted",
  "repository-write",
]);

export { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

export function createSqliteSessionIndex(database: DatabaseSync): SessionIndexWriter {
  const index: SessionIndexWriter = {
    async getFreshness(identity) {
      assertIdentity(identity);
      return readSessionFreshness(database, identity);
    },

    async getSummary(identity) {
      assertIdentity(identity);
      return readSessionSummary(database, identity);
    },

    async getDocument(identity) {
      assertIdentity(identity);
      const row = findSessionTracking(database, identity);
      if (row === undefined) return undefined;
      return readCanonicalDocument(database, identity, integerAt(row.session_id));
    },

    async startRun(input) {
      assertSource(input.source);
      assertCanonicalTimestamp(input.startedAt, "Index run start");
      return runImmediateTransaction(database, () => {
        const sourceInstanceId = ensureSourceInstance(database, input.source);
        const row = database
          .prepare(
            `INSERT INTO sessions_index_runs (source_instance_id, status, started_at)
             VALUES (?, 'active', ?)
             RETURNING run_id`,
          )
          .get(sourceInstanceId, input.startedAt) as { readonly run_id?: unknown } | undefined;
        return {
          id: createSessionIndexRunId(String(integerAt(row?.run_id))),
          source: { ...input.source },
          startedAt: input.startedAt,
        };
      });
    },

    async recordUnchanged(run, observation) {
      assertIdentity(observation.identity);
      runImmediateTransaction(database, () => {
        const context = assertActiveRun(database, run, observation.identity.source);
        const tracking = findSessionTracking(database, observation.identity);
        if (
          tracking === undefined ||
          integerAt(tracking.source_instance_id) !== context.sourceInstanceId ||
          !hasCanonicalDocument(database, integerAt(tracking.session_id)) ||
          !sameRevision(lastGoodRevision(tracking), observation.revision)
        ) {
          throw new SqliteSessionIndexError("invalid-state");
        }
        updateLatest(database, integerAt(tracking.session_id), observation, "unchanged", null);
        incrementRun(database, context.runId, "unchanged");
      });
    },

    async recordFailure(run, observation, failure) {
      assertIdentity(observation.identity);
      assertFailureCode(failure);
      runImmediateTransaction(database, () => {
        recordFailure(database, run, observation, failure);
      });
    },

    async replaceSession(run, replacement) {
      assertIdentity(replacement.observation.identity);
      let activeRunValidated = false;
      try {
        runImmediateTransaction(database, () => {
          const context = assertActiveRun(database, run, replacement.observation.identity.source);
          activeRunValidated = true;
          const sessionId = ensureTracking(database, context, replacement.observation, "indexed");
          replaceCanonicalDocument(database, sessionId, replacement.document);
          updateSuccessfulRevision(database, sessionId, replacement.observation);
          incrementRun(database, context.runId, "indexed");
        });
      } catch (operationError) {
        if (!activeRunValidated) throw operationError;
        try {
          runImmediateTransaction(database, () => {
            recordFailure(database, run, replacement.observation, "repository-write");
          });
        } catch (failureRecordingError) {
          throw new AggregateError(
            [operationError, failureRecordingError],
            "SQLite replacement and failure recording both failed",
            { cause: operationError },
          );
        }
        throw operationError;
      }
    },

    async removeSession(run, identity) {
      assertIdentity(identity);
      runImmediateTransaction(database, () => {
        const context = assertActiveRun(database, run, identity.source);
        const tracking = findSessionTracking(database, identity);
        if (
          tracking === undefined ||
          integerAt(tracking.source_instance_id) !== context.sourceInstanceId
        ) {
          return;
        }
        const sessionId = integerAt(tracking.session_id);
        if (!hasCanonicalDocument(database, sessionId)) return;

        database
          .prepare("DELETE FROM sessions_canonical_sessions WHERE session_id = ?")
          .run(sessionId);
        database
          .prepare(
            `UPDATE sessions_session_tracking
             SET last_good_fingerprint_scheme = NULL,
                 last_good_fingerprint_digest = NULL,
                 last_good_adapter_version = NULL,
                 latest_fingerprint_scheme = NULL,
                 latest_fingerprint_digest = NULL,
                 latest_adapter_version = NULL,
                 latest_outcome = 'removed',
                 latest_failure_code = NULL
             WHERE session_id = ?`,
          )
          .run(sessionId);
        garbageCollectContent(database);
        incrementRun(database, context.runId, "removed");
        addRunItem(database, context.runId, sessionId, "removed", null);
      });
    },

    async finishRun(run, completion) {
      assertCanonicalTimestamp(completion.finishedAt, "Index run finish");
      assertCounts(completion.counts);
      if (completion.status === "incomplete" && !RUN_FAILURE_CODES.has(completion.failure)) {
        throw new TypeError("Invalid index run failure code");
      }
      runImmediateTransaction(database, () => {
        const context = assertActiveRun(database, run);
        const actual = readRunCounts(database, context.runId);
        if (!sameCounts(actual, completion.counts)) {
          throw new SqliteSessionIndexError("invalid-state");
        }
        const status =
          completion.status === "completed"
            ? "completed"
            : completion.failure === "interrupted"
              ? "interrupted"
              : "failed";
        database
          .prepare(
            `UPDATE sessions_index_runs
             SET status = ?, finished_at = ?, failure_code = ?
             WHERE run_id = ?`,
          )
          .run(
            status,
            completion.finishedAt,
            completion.status === "completed" ? null : completion.failure,
            context.runId,
          );
        pruneFinishedRuns(database, context.sourceInstanceId);
      });
    },
  };
  return index;
}

interface RunContext {
  readonly runId: number;
  readonly sourceInstanceId: number;
}

function assertActiveRun(
  database: DatabaseSync,
  run: SessionIndexRun,
  expectedSource?: SourceInstance,
): RunContext {
  const runId = parseRunId(run.id);
  const row = database
    .prepare(
      `SELECT run.source_instance_id,
              run.status,
              run.started_at,
              source.kind,
              source.instance_id
       FROM sessions_index_runs AS run
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = run.source_instance_id
       WHERE run.run_id = ?`,
    )
    .get(runId) as RunRow | undefined;
  if (
    row === undefined ||
    row.status !== "active" ||
    row.started_at !== run.startedAt ||
    row.kind !== run.source.kind ||
    row.instance_id !== run.source.instanceId ||
    (expectedSource !== undefined && !sameSource(expectedSource, run.source))
  ) {
    throw new SqliteSessionIndexError("invalid-run");
  }
  return { runId, sourceInstanceId: integerAt(row.source_instance_id) };
}

function recordFailure(
  database: DatabaseSync,
  run: SessionIndexRun,
  observation: SessionObservation,
  failure: SessionIndexFailureCode,
): void {
  const context = assertActiveRun(database, run, observation.identity.source);
  const sessionId = ensureTracking(database, context, observation, "failed", failure);
  const stale = hasCanonicalDocument(database, sessionId);
  incrementRun(database, context.runId, "failed", stale);
  addRunItem(database, context.runId, sessionId, "failed", failure);
}

function ensureSourceInstance(database: DatabaseSync, source: SourceInstance): number {
  database
    .prepare(
      `INSERT INTO sessions_source_instances (kind, instance_id)
       VALUES (?, ?)
       ON CONFLICT (kind, instance_id) DO NOTHING`,
    )
    .run(source.kind, source.instanceId);
  const row = database
    .prepare(
      `SELECT source_instance_id
       FROM sessions_source_instances
       WHERE kind = ? AND instance_id = ?`,
    )
    .get(source.kind, source.instanceId) as { readonly source_instance_id?: unknown } | undefined;
  return integerAt(row?.source_instance_id);
}

function ensureTracking(
  database: DatabaseSync,
  context: RunContext,
  observation: SessionObservation,
  outcome: "indexed" | "failed",
  failure: SessionIndexFailureCode | null = null,
): number {
  const revision = observation.revision;
  database
    .prepare(
      `INSERT INTO sessions_session_tracking (
         source_instance_id,
         native_id,
         latest_fingerprint_scheme,
         latest_fingerprint_digest,
         latest_adapter_version,
         latest_outcome,
         latest_failure_code
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_instance_id, native_id) DO UPDATE SET
         latest_fingerprint_scheme = excluded.latest_fingerprint_scheme,
         latest_fingerprint_digest = excluded.latest_fingerprint_digest,
         latest_adapter_version = excluded.latest_adapter_version,
         latest_outcome = excluded.latest_outcome,
         latest_failure_code = excluded.latest_failure_code`,
    )
    .run(
      context.sourceInstanceId,
      observation.identity.nativeId,
      revision.aggregateFingerprint.scheme,
      revision.aggregateFingerprint.digest,
      revision.adapterVersion,
      outcome,
      failure,
    );
  const tracking = findSessionTracking(database, observation.identity);
  if (
    tracking === undefined ||
    integerAt(tracking.source_instance_id) !== context.sourceInstanceId
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return integerAt(tracking.session_id);
}

function updateLatest(
  database: DatabaseSync,
  sessionId: number,
  observation: SessionObservation,
  outcome: "unchanged" | "failed",
  failure: SessionIndexFailureCode | null,
): void {
  const revision = observation.revision;
  database
    .prepare(
      `UPDATE sessions_session_tracking
       SET latest_fingerprint_scheme = ?,
           latest_fingerprint_digest = ?,
           latest_adapter_version = ?,
           latest_outcome = ?,
           latest_failure_code = ?
       WHERE session_id = ?`,
    )
    .run(
      revision.aggregateFingerprint.scheme,
      revision.aggregateFingerprint.digest,
      revision.adapterVersion,
      outcome,
      failure,
      sessionId,
    );
}

function updateSuccessfulRevision(
  database: DatabaseSync,
  sessionId: number,
  observation: SessionObservation,
): void {
  const revision = observation.revision;
  database
    .prepare(
      `UPDATE sessions_session_tracking
       SET last_good_fingerprint_scheme = ?,
           last_good_fingerprint_digest = ?,
           last_good_adapter_version = ?,
           latest_fingerprint_scheme = ?,
           latest_fingerprint_digest = ?,
           latest_adapter_version = ?,
           latest_outcome = 'indexed',
           latest_failure_code = NULL
       WHERE session_id = ?`,
    )
    .run(
      revision.aggregateFingerprint.scheme,
      revision.aggregateFingerprint.digest,
      revision.adapterVersion,
      revision.aggregateFingerprint.scheme,
      revision.aggregateFingerprint.digest,
      revision.adapterVersion,
      sessionId,
    );
}

function incrementRun(
  database: DatabaseSync,
  runId: number,
  outcome: "unchanged" | "indexed" | "failed" | "removed",
  stale = false,
): void {
  const columns = {
    unchanged: "unchanged_count",
    indexed: "indexed_count",
    failed: "failed_count",
    removed: "removed_count",
  } as const;
  const discovered = outcome === "removed" ? 0 : 1;
  database
    .prepare(
      `UPDATE sessions_index_runs
     SET discovered_count = discovered_count + ${discovered},
         ${columns[outcome]} = ${columns[outcome]} + 1,
         stale_count = stale_count + ${stale ? 1 : 0}
     WHERE run_id = ? AND status = 'active'`,
    )
    .run(runId);
}

function addRunItem(
  database: DatabaseSync,
  runId: number,
  sessionId: number,
  outcome: "failed" | "removed",
  failure: SessionIndexFailureCode | null,
): void {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(MAX(ordinal), -1) AS maximum
       FROM sessions_index_run_items
       WHERE run_id = ?`,
    )
    .get(runId) as { readonly count?: unknown; readonly maximum?: unknown } | undefined;
  const count = integerAt(row?.count);
  if (count >= 100) {
    database
      .prepare(
        `UPDATE sessions_index_runs
         SET omitted_item_count = omitted_item_count + 1
         WHERE run_id = ?`,
      )
      .run(runId);
    return;
  }
  const maximum = signedIntegerAt(row?.maximum);
  database
    .prepare(
      `INSERT INTO sessions_index_run_items (
         run_id,
         ordinal,
         session_id,
         outcome,
         failure_code
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(runId, maximum + 1, sessionId, outcome, failure);
}

function readRunCounts(database: DatabaseSync, runId: number): IndexRunCounts {
  const row = database
    .prepare(
      `SELECT discovered_count, unchanged_count, indexed_count,
              failed_count, removed_count, stale_count
       FROM sessions_index_runs
       WHERE run_id = ?`,
    )
    .get(runId) as CountRow | undefined;
  if (row === undefined) throw new SqliteSessionIndexError("invalid-run");
  return {
    discovered: integerAt(row.discovered_count),
    unchanged: integerAt(row.unchanged_count),
    updated: integerAt(row.indexed_count),
    failed: integerAt(row.failed_count),
    removed: integerAt(row.removed_count),
    stale: integerAt(row.stale_count),
  };
}

function pruneFinishedRuns(database: DatabaseSync, sourceInstanceId: number): void {
  database
    .prepare(
      `DELETE FROM sessions_index_runs
       WHERE run_id IN (
         SELECT run_id
         FROM sessions_index_runs
         WHERE source_instance_id = ? AND status <> 'active'
         ORDER BY finished_at DESC, run_id DESC
         LIMIT -1 OFFSET 20
       )`,
    )
    .run(sourceInstanceId);
}

function sameCounts(left: IndexRunCounts, right: IndexRunCounts): boolean {
  return (
    left.discovered === right.discovered &&
    left.unchanged === right.unchanged &&
    left.updated === right.updated &&
    left.failed === right.failed &&
    left.removed === right.removed &&
    left.stale === right.stale
  );
}

function assertCounts(counts: IndexRunCounts): void {
  for (const value of Object.values(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("Index run counts must be non-negative safe integers");
    }
  }
  if (counts.discovered !== counts.unchanged + counts.updated + counts.failed) {
    throw new TypeError("Index run discovered count does not match candidate outcomes");
  }
  if (counts.stale > counts.failed) {
    throw new TypeError("Index run stale count cannot exceed failed count");
  }
}

function assertIdentity(identity: SessionIdentity): void {
  if (!isSessionIdentity(identity)) throw new TypeError("Invalid session identity");
}

function assertSource(source: SourceInstance): void {
  if (!isSessionIdentity({ source, nativeId: "run" })) {
    throw new TypeError("Invalid session source instance");
  }
}

function assertFailureCode(value: string): asserts value is SessionIndexFailureCode {
  if (!FAILURE_CODES.has(value)) throw new TypeError("Invalid session index failure code");
}

function assertCanonicalTimestamp(value: string, label: string): void {
  const milliseconds = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
}

function parseRunId(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new SqliteSessionIndexError("invalid-run");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new SqliteSessionIndexError("invalid-run");
  return result;
}

function sameSource(left: SourceInstance, right: SourceInstance): boolean {
  return left.kind === right.kind && left.instanceId === right.instanceId;
}

function integerAt(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return result;
}

function signedIntegerAt(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return result;
}

interface RunRow {
  readonly source_instance_id: number | bigint;
  readonly status: string;
  readonly started_at: string;
  readonly kind: string;
  readonly instance_id: string;
}

interface CountRow {
  readonly discovered_count: number | bigint;
  readonly unchanged_count: number | bigint;
  readonly indexed_count: number | bigint;
  readonly failed_count: number | bigint;
  readonly removed_count: number | bigint;
  readonly stale_count: number | bigint;
}
