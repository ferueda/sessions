import type { DatabaseSync } from "node:sqlite";

import {
  createSessionIndexRunId,
  type SessionIndexFailureCode,
  type SessionIndexReader,
  type SessionIndexRun,
  type SessionIndexWriter,
} from "../../application/ports/session-index.ts";
import type { SessionObservation } from "../../application/validate-session.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { SessionIdentity, SourceInstance } from "../../domain/session.ts";
import { readCanonicalDocument, replaceCanonicalDocument } from "./sqlite-session-document.ts";
import { readImmutableIndexRunResult } from "./sqlite-index-run-result.ts";
import {
  findSessionTracking,
  hasCanonicalDocument,
  lastGoodRevision,
  readSessionFreshness,
  readSessionSummary,
  sameRevision,
} from "./sqlite-session-state.ts";
import { runImmediateTransaction, SqliteSessionIndexError } from "./sqlite-session-transaction.ts";
import { assertWriterLease, type WriterLeaseIdentity } from "./writer-lease.ts";

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
  "probe-failed",
  "discovery-failed",
  "interrupted",
  "repository-write",
]);

export { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

export function createSqliteSessionIndexReader(database: DatabaseSync): SessionIndexReader {
  return {
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

    async getSession(identity) {
      assertIdentity(identity);
      const row = findSessionTracking(database, identity);
      if (row === undefined) return undefined;
      const document = readCanonicalDocument(database, identity, integerAt(row.session_id));
      const summary = readSessionSummary(database, identity);
      if (document === undefined || summary === undefined) return undefined;
      return { summary, document };
    },
  };
}

export interface CoordinatedSqliteSessionIndexOptions {
  readonly lease: WriterLeaseIdentity;
  readonly now: () => Date;
}

export function createCoordinatedSqliteSessionIndex(
  database: DatabaseSync,
  options: CoordinatedSqliteSessionIndexOptions,
): SessionIndexWriter {
  if (options.lease.purpose !== "index") {
    throw new TypeError("Session index writer requires an index-purpose lease");
  }
  const reader = createSqliteSessionIndexReader(database);
  const assertLease = (): void => assertWriterLease(database, options.lease, options);
  const index: SessionIndexWriter = {
    ...reader,

    async listIndexedIdentities(source) {
      assertSource(source);
      return listIndexedIdentities(database, source);
    },

    async startRun(input) {
      assertSource(input.source);
      assertCanonicalTimestamp(input.startedAt, "Index run start");
      return runImmediateTransaction(database, () => {
        assertLease();
        const sourceInstanceId = ensureSourceInstance(database, input.source);
        database
          .prepare(
            `UPDATE sessions_source_instances
             SET coverage_status = 'unknown', coverage_observed_at = ?
             WHERE source_instance_id = ?`,
          )
          .run(input.startedAt, sourceInstanceId);
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
        assertLease();
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
        updateLatest(
          database,
          integerAt(tracking.session_id),
          observation,
          "unchanged",
          null,
          run.startedAt,
        );
        incrementRun(database, context.runId, "unchanged");
      });
    },

    async recordFailure(run, observation, failure) {
      assertIdentity(observation.identity);
      assertFailureCode(failure);
      runImmediateTransaction(database, () => {
        assertLease();
        recordFailure(database, run, observation, failure);
      });
    },

    async replaceSession(run, replacement) {
      assertIdentity(replacement.observation.identity);
      let activeRunValidated = false;
      try {
        runImmediateTransaction(database, () => {
          assertLease();
          const context = assertActiveRun(database, run, replacement.observation.identity.source);
          activeRunValidated = true;
          const sessionId = ensureTracking(
            database,
            context,
            replacement.observation,
            "indexed",
            null,
            run.startedAt,
          );
          replaceCanonicalDocument(database, sessionId, replacement.document);
          updateSuccessfulRevision(database, sessionId, replacement.observation, run.startedAt);
          incrementRun(database, context.runId, "indexed");
        });
      } catch (operationError) {
        if (!activeRunValidated) throw operationError;
        try {
          runImmediateTransaction(database, () => {
            assertLease();
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

    async recordMissing(run, identity) {
      assertIdentity(identity);
      runImmediateTransaction(database, () => {
        assertLease();
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
          .prepare(
            `UPDATE sessions_session_tracking
             SET presence_status = 'missing',
                 presence_observed_at = ?
             WHERE session_id = ?`,
          )
          .run(run.startedAt, sessionId);
        incrementRun(database, context.runId, "missing");
        addRunItem(database, context.runId, sessionId, "missing", null);
      });
    },

    async finishRun(run, completion) {
      assertCanonicalTimestamp(completion.finishedAt, "Index run finish");
      if (completion.status === "incomplete" && !RUN_FAILURE_CODES.has(completion.failure)) {
        throw new TypeError("Invalid index run failure code");
      }
      return runImmediateTransaction(database, () => {
        assertLease();
        const context = assertActiveRun(database, run);
        if (completion.status === "completed") {
          database
            .prepare(
              `UPDATE sessions_source_instances
               SET coverage_status = 'complete'
               WHERE source_instance_id = ?`,
            )
            .run(context.sourceInstanceId);
        }
        const result = readImmutableIndexRunResult(database, context.runId, run, completion);
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
        return result;
      });
    },
  };
  return index;
}

interface RunContext {
  readonly runId: number;
  readonly sourceInstanceId: number;
}

function listIndexedIdentities(
  database: DatabaseSync,
  source: SourceInstance,
): readonly SessionIdentity[] {
  const rows = database
    .prepare(
      `SELECT tracking.native_id
       FROM sessions_session_tracking AS tracking
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       JOIN sessions_canonical_sessions AS canonical
         ON canonical.session_id = tracking.session_id
       WHERE source.kind = ? AND source.instance_id = ?
       ORDER BY tracking.native_id COLLATE BINARY`,
    )
    .all(source.kind, source.instanceId) as readonly { readonly native_id?: unknown }[];
  return Object.freeze(
    rows.map((row) => {
      const identity = {
        source: { ...source },
        nativeId: row.native_id,
      };
      if (!isSessionIdentity(identity)) throw new SqliteSessionIndexError("corrupt-data");
      return Object.freeze({
        source: Object.freeze({ ...identity.source }),
        nativeId: identity.nativeId,
      });
    }),
  );
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
  const sessionId = ensureTracking(
    database,
    context,
    observation,
    "failed",
    failure,
    run.startedAt,
  );
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
  failure: SessionIndexFailureCode | null,
  observedAt: string,
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
         latest_failure_code,
         presence_status,
         presence_observed_at,
         last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'present', ?, ?)
       ON CONFLICT (source_instance_id, native_id) DO UPDATE SET
         latest_fingerprint_scheme = excluded.latest_fingerprint_scheme,
         latest_fingerprint_digest = excluded.latest_fingerprint_digest,
         latest_adapter_version = excluded.latest_adapter_version,
         latest_outcome = excluded.latest_outcome,
         latest_failure_code = excluded.latest_failure_code,
         presence_status = 'present',
         presence_observed_at = excluded.presence_observed_at,
         last_seen_at = excluded.last_seen_at`,
    )
    .run(
      context.sourceInstanceId,
      observation.identity.nativeId,
      revision.aggregateFingerprint.scheme,
      revision.aggregateFingerprint.digest,
      revision.adapterVersion,
      outcome,
      failure,
      observedAt,
      observedAt,
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
  observedAt: string,
): void {
  const revision = observation.revision;
  database
    .prepare(
      `UPDATE sessions_session_tracking
       SET latest_fingerprint_scheme = ?,
           latest_fingerprint_digest = ?,
           latest_adapter_version = ?,
           latest_outcome = ?,
           latest_failure_code = ?,
           presence_status = 'present',
           presence_observed_at = ?,
           last_seen_at = ?
       WHERE session_id = ?`,
    )
    .run(
      revision.aggregateFingerprint.scheme,
      revision.aggregateFingerprint.digest,
      revision.adapterVersion,
      outcome,
      failure,
      observedAt,
      observedAt,
      sessionId,
    );
}

function updateSuccessfulRevision(
  database: DatabaseSync,
  sessionId: number,
  observation: SessionObservation,
  observedAt: string,
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
           latest_failure_code = NULL,
           presence_status = 'present',
           presence_observed_at = ?,
           captured_at = ?,
           last_seen_at = ?
       WHERE session_id = ?`,
    )
    .run(
      revision.aggregateFingerprint.scheme,
      revision.aggregateFingerprint.digest,
      revision.adapterVersion,
      revision.aggregateFingerprint.scheme,
      revision.aggregateFingerprint.digest,
      revision.adapterVersion,
      observedAt,
      observedAt,
      observedAt,
      sessionId,
    );
}

function incrementRun(
  database: DatabaseSync,
  runId: number,
  outcome: "unchanged" | "indexed" | "failed" | "missing",
  stale = false,
): void {
  const columns = {
    unchanged: "unchanged_count",
    indexed: "indexed_count",
    failed: "failed_count",
    missing: "missing_count",
  } as const;
  const discovered = outcome === "missing" ? 0 : 1;
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
  outcome: "failed" | "missing",
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
