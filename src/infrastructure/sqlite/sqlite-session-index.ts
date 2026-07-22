import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";

import {
  SESSION_INDEX_BATCH_LIMIT,
  createSessionIndexRunId,
  type SessionIndexFailureCode,
  type SessionIndexReader,
  type SessionIndexRun,
  type SessionIndexWriter,
} from "../../application/ports/session-index.ts";
import type {
  SessionObservation,
  ValidatedSessionReplacement,
} from "../../application/validate-session.ts";
import { sameSessionDocumentDigest } from "../../domain/public-session-document.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { SessionIdentity, SourceInstance } from "../../domain/session.ts";
import { assertFtsProjectionContentParityForIds } from "./fts-projection.ts";
import {
  readCanonicalDocument,
  readCanonicalDocumentRecord,
  replaceCanonicalDocument,
} from "./sqlite-session-document.ts";
import { readImmutableIndexRunResult } from "./sqlite-index-run-result.ts";
import {
  findSessionTracking,
  hasCanonicalDocument,
  readSessionFreshness,
  readSessionFreshnessBatch,
  readSessionSummary,
  sameRevision,
} from "./sqlite-session-state.ts";
import { runImmediateTransaction, SqliteSessionIndexError } from "./sqlite-session-transaction.ts";
import {
  assertWriterLease,
  runLeasedImmediateTransaction,
  type WriterLeaseIdentity,
} from "./writer-lease.ts";

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
      const canonical = readCanonicalDocumentRecord(database, identity, integerAt(row.session_id));
      const summary = readSessionSummary(database, identity);
      if (canonical === undefined || summary === undefined) return undefined;
      if (!sameSessionDocumentDigest(canonical.documentDigest, summary.documentDigest)) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      return { summary, document: canonical.document };
    },
  };
}

export interface CoordinatedSqliteSessionIndexOptions {
  readonly lease: WriterLeaseIdentity;
  readonly now: () => Date;
  readonly onIntegrityUncertain?: () => void;
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
  const markIntegrityUncertain = (): void => options.onIntegrityUncertain?.();
  const runTrackedImmediateTransaction = <T>(operation: () => T): T => {
    try {
      return runImmediateTransaction(database, operation);
    } catch (error) {
      markIntegrityUncertain();
      throw error;
    }
  };
  const runLeasedMutation = <T>(operation: () => T): T => {
    try {
      return runLeasedImmediateTransaction(database, options.lease, options, operation);
    } catch (error) {
      markIntegrityUncertain();
      throw error;
    }
  };
  const index: SessionIndexWriter = {
    ...reader,

    async startRun(input) {
      assertSource(input.source);
      assertCanonicalTimestamp(input.startedAt, "Index run start");
      return runTrackedImmediateTransaction(() => {
        assertLease();
        const sourceInstanceId = ensureSourceInstance(database, input.source);
        assertSingleRowChange(
          database
            .prepare(
              `UPDATE sessions_source_instances
             SET coverage_status = 'unknown', coverage_observed_at = ?
             WHERE source_instance_id = ?`,
            )
            .run(input.startedAt, sourceInstanceId),
        );
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

    async getFreshnessBatch(run, identities) {
      assertIdentityBatch(run, identities);
      assertLease();
      const context = assertActiveRun(database, run, run.source);
      const freshness = readSessionFreshnessBatch(database, context.sourceInstanceId, identities);
      assertLease();
      return freshness;
    },

    async recordUnchangedBatch(run, observations) {
      assertObservationBatch(run, observations);
      runLeasedMutation(() => {
        const context = assertActiveRun(database, run, run.source);
        const identities = observations.map((observation) => observation.identity);
        const freshness = readSessionFreshnessBatch(database, context.sourceInstanceId, identities);
        for (const [ordinal, state] of freshness.entries()) {
          const observation = observations[ordinal];
          if (
            observation === undefined ||
            (state.status !== "current" && state.status !== "stale") ||
            !sameRevision(state.lastGood, observation.revision)
          ) {
            throw new SqliteSessionIndexError("invalid-state");
          }
        }
        updateLatestBatch(database, context, observations, run.startedAt);
        incrementRun(database, context.runId, "unchanged", observations.length);
      });
    },

    async recordFailure(run, observation, failure) {
      assertIdentity(observation.identity);
      assertFailureCode(failure);
      runTrackedImmediateTransaction(() => {
        assertLease();
        recordFailure(database, run, observation, failure);
      });
    },

    async replaceSession(run, replacement) {
      assertIdentity(replacement.observation.identity);
      let activeRunValidated = false;
      try {
        runLeasedMutation(() => {
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
          const affectedContentIds = replaceCanonicalDocument(
            database,
            sessionId,
            replacement.document,
            replacement.documentDigest,
          );
          assertReplacementIntegrity(database, sessionId, replacement, affectedContentIds);
          updateSuccessfulRevision(database, sessionId, replacement.observation, run.startedAt);
          incrementRun(database, context.runId, "indexed");
        });
      } catch (operationError) {
        if (!activeRunValidated) throw operationError;
        try {
          runLeasedMutation(() => {
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

    async listTrackedIdentitiesPage(run, afterNativeId) {
      assertNativeIdCursor(afterNativeId);
      assertLease();
      const context = assertActiveRun(database, run, run.source);
      const page = listTrackedIdentitiesPage(database, run, context, afterNativeId);
      assertLease();
      return page;
    },

    async recordMissingBatch(run, identities) {
      assertIdentityBatch(run, identities);
      runLeasedMutation(() => {
        const context = assertActiveRun(database, run, run.source);
        const tracked = resolveTrackedBatch(database, context, identities);
        if (tracked.length === 0) return;
        updateMissingBatch(database, context, tracked, run.startedAt);
        incrementRun(database, context.runId, "missing", tracked.length);
        addMissingRunItems(database, context.runId, tracked);
      });
    },

    async finishRun(run, completion) {
      assertCanonicalTimestamp(completion.finishedAt, "Index run finish");
      if (completion.status === "incomplete" && !RUN_FAILURE_CODES.has(completion.failure)) {
        throw new TypeError("Invalid index run failure code");
      }
      return runTrackedImmediateTransaction(() => {
        assertLease();
        const context = assertActiveRun(database, run);
        if (completion.status === "completed") {
          assertSingleRowChange(
            database
              .prepare(
                `UPDATE sessions_source_instances
               SET coverage_status = 'complete'
               WHERE source_instance_id = ?`,
              )
              .run(context.sourceInstanceId),
          );
        }
        const result = readImmutableIndexRunResult(database, context.runId, run, completion);
        const status =
          completion.status === "completed"
            ? "completed"
            : completion.failure === "interrupted"
              ? "interrupted"
              : "failed";
        assertSingleRowChange(
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
            ),
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

function assertReplacementIntegrity(
  database: DatabaseSync,
  sessionId: number,
  replacement: ValidatedSessionReplacement,
  affectedContentIds: readonly bigint[],
): void {
  const record = readCanonicalDocumentRecord(database, replacement.observation.identity, sessionId);
  if (
    record === undefined ||
    !sameSessionDocumentDigest(record.documentDigest, replacement.documentDigest)
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  try {
    assertFtsProjectionContentParityForIds(database, affectedContentIds);
  } catch (error) {
    throw new SqliteSessionIndexError("corrupt-data", { cause: error });
  }
}

function listTrackedIdentitiesPage(
  database: DatabaseSync,
  run: SessionIndexRun,
  context: RunContext,
  afterNativeId: string | undefined,
): { readonly identities: readonly SessionIdentity[]; readonly hasMore: boolean } {
  const cursorClause =
    afterNativeId === undefined ? "" : "AND tracking.native_id > ? COLLATE BINARY";
  const parameters =
    afterNativeId === undefined
      ? [context.sourceInstanceId, SESSION_INDEX_BATCH_LIMIT + 1]
      : [context.sourceInstanceId, afterNativeId, SESSION_INDEX_BATCH_LIMIT + 1];
  const rows = database
    .prepare(
      `SELECT tracking.native_id
       FROM sessions_session_tracking AS tracking
       WHERE tracking.source_instance_id = ?
         ${cursorClause}
       ORDER BY tracking.native_id COLLATE BINARY
       LIMIT ?`,
    )
    .all(...parameters) as readonly { readonly native_id?: unknown }[];
  if (rows.length > SESSION_INDEX_BATCH_LIMIT + 1) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const identities = rows.slice(0, SESSION_INDEX_BATCH_LIMIT).map((row, ordinal) => {
    const identity = {
      source: { ...run.source },
      nativeId: row.native_id,
    };
    if (!isSessionIdentity(identity)) throw new SqliteSessionIndexError("corrupt-data");
    const previous = ordinal === 0 ? afterNativeId : rows[ordinal - 1]?.native_id;
    if (
      previous !== undefined &&
      (typeof previous !== "string" || compareUtf8Binary(previous, identity.nativeId) >= 0)
    ) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    return Object.freeze({
      source: Object.freeze({ ...identity.source }),
      nativeId: identity.nativeId,
    });
  });
  return Object.freeze({
    identities: Object.freeze(identities),
    hasMore: rows.length > SESSION_INDEX_BATCH_LIMIT,
  });
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
  incrementRun(database, context.runId, "failed", 1, stale ? 1 : 0);
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
  assertSingleRowChange(
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
      ),
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

function updateLatestBatch(
  database: DatabaseSync,
  context: RunContext,
  observations: readonly SessionObservation[],
  observedAt: string,
): void {
  const values = observations.map(() => "(?, ?, ?, ?)").join(", ");
  const parameters = observations.flatMap((observation) => [
    observation.identity.nativeId,
    observation.revision.aggregateFingerprint.scheme,
    observation.revision.aggregateFingerprint.digest,
    observation.revision.adapterVersion,
  ]);
  assertChangeCount(
    database
      .prepare(
        `WITH input(native_id, fingerprint_scheme, fingerprint_digest, adapter_version) AS (
           VALUES ${values}
         )
         UPDATE sessions_session_tracking AS tracking
         SET latest_fingerprint_scheme = (
               SELECT fingerprint_scheme FROM input
               WHERE input.native_id = tracking.native_id COLLATE BINARY
             ),
             latest_fingerprint_digest = (
               SELECT fingerprint_digest FROM input
               WHERE input.native_id = tracking.native_id COLLATE BINARY
             ),
             latest_adapter_version = (
               SELECT adapter_version FROM input
               WHERE input.native_id = tracking.native_id COLLATE BINARY
             ),
             latest_outcome = 'unchanged',
             latest_failure_code = NULL,
             presence_status = 'present',
             presence_observed_at = ?,
             last_seen_at = ?
         WHERE tracking.source_instance_id = ?
           AND tracking.native_id IN (SELECT native_id FROM input)`,
      )
      .run(...parameters, observedAt, observedAt, context.sourceInstanceId),
    observations.length,
  );
}

interface TrackedBatchItem {
  readonly ordinal: number;
  readonly sessionId: number;
  readonly identity: SessionIdentity;
}

function resolveTrackedBatch(
  database: DatabaseSync,
  context: RunContext,
  identities: readonly SessionIdentity[],
): readonly TrackedBatchItem[] {
  const values = identities.map(() => "(?, ?)").join(", ");
  const parameters = identities.flatMap((identity, ordinal) => [ordinal, identity.nativeId]);
  const rows = database
    .prepare(
      `WITH requested(ordinal, native_id) AS (VALUES ${values})
       SELECT requested.ordinal, tracking.session_id, tracking.native_id
       FROM requested
       JOIN sessions_session_tracking AS tracking
         ON tracking.source_instance_id = ?
        AND tracking.native_id = requested.native_id COLLATE BINARY
       ORDER BY requested.ordinal`,
    )
    .all(...parameters, context.sourceInstanceId) as unknown as readonly TrackedBatchRow[];
  if (rows.length > identities.length) throw new SqliteSessionIndexError("corrupt-data");

  return Object.freeze(
    rows.map((row) => {
      const ordinal = integerAt(row.ordinal);
      const identity = identities[ordinal];
      if (identity === undefined || row.native_id !== identity.nativeId) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      return Object.freeze({
        ordinal,
        sessionId: integerAt(row.session_id),
        identity,
      });
    }),
  );
}

function updateMissingBatch(
  database: DatabaseSync,
  context: RunContext,
  tracked: readonly TrackedBatchItem[],
  observedAt: string,
): void {
  const values = tracked.map(() => "(?)").join(", ");
  assertChangeCount(
    database
      .prepare(
        `WITH input(session_id) AS (VALUES ${values})
         UPDATE sessions_session_tracking
         SET presence_status = 'missing',
             presence_observed_at = ?
         WHERE source_instance_id = ?
           AND session_id IN (SELECT session_id FROM input)`,
      )
      .run(...tracked.map((item) => item.sessionId), observedAt, context.sourceInstanceId),
    tracked.length,
  );
}

function addMissingRunItems(
  database: DatabaseSync,
  runId: number,
  tracked: readonly TrackedBatchItem[],
): void {
  const position = readRunItemPosition(database, runId);
  const remainingOrdinals = Math.max(0, 100 - (position.maximum + 1));
  const remainingItems = Math.max(0, 100 - position.count);
  const detailCount = Math.min(tracked.length, remainingOrdinals, remainingItems);
  const detailed = tracked.slice(0, detailCount);
  if (detailed.length > 0) {
    const values = detailed.map(() => "(?, ?, ?, 'missing', NULL)").join(", ");
    const parameters = detailed.flatMap((item, offset) => [
      runId,
      position.maximum + 1 + offset,
      item.sessionId,
    ]);
    assertChangeCount(
      database
        .prepare(
          `INSERT INTO sessions_index_run_items (
             run_id, ordinal, session_id, outcome, failure_code
           ) VALUES ${values}`,
        )
        .run(...parameters),
      detailed.length,
    );
  }

  const omitted = tracked.length - detailed.length;
  if (omitted > 0) incrementOmittedRunItems(database, runId, omitted);
}

function updateSuccessfulRevision(
  database: DatabaseSync,
  sessionId: number,
  observation: SessionObservation,
  observedAt: string,
): void {
  const revision = observation.revision;
  assertSingleRowChange(
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
      ),
  );
}

function incrementRun(
  database: DatabaseSync,
  runId: number,
  outcome: "unchanged" | "indexed" | "failed" | "missing",
  amount = 1,
  staleAmount = 0,
): void {
  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    !Number.isSafeInteger(staleAmount) ||
    staleAmount < 0 ||
    staleAmount > amount
  ) {
    throw new TypeError("Invalid index run increment");
  }
  const columns = {
    unchanged: "unchanged_count",
    indexed: "indexed_count",
    failed: "failed_count",
    missing: "missing_count",
  } as const;
  const discovered = outcome === "missing" ? 0 : amount;
  assertSingleRowChange(
    database
      .prepare(
        `UPDATE sessions_index_runs
         SET discovered_count = discovered_count + ?,
             ${columns[outcome]} = ${columns[outcome]} + ?,
             stale_count = stale_count + ?
         WHERE run_id = ? AND status = 'active'`,
      )
      .run(discovered, amount, staleAmount, runId),
  );
}

function addRunItem(
  database: DatabaseSync,
  runId: number,
  sessionId: number,
  outcome: "failed" | "missing",
  failure: SessionIndexFailureCode | null,
): void {
  const position = readRunItemPosition(database, runId);
  if (position.count >= 100 || position.maximum >= 99) {
    incrementOmittedRunItems(database, runId, 1);
    return;
  }
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
    .run(runId, position.maximum + 1, sessionId, outcome, failure);
}

function readRunItemPosition(
  database: DatabaseSync,
  runId: number,
): { readonly count: number; readonly maximum: number } {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(MAX(ordinal), -1) AS maximum
       FROM sessions_index_run_items
       WHERE run_id = ?`,
    )
    .get(runId) as { readonly count?: unknown; readonly maximum?: unknown } | undefined;
  const count = integerAt(row?.count);
  const maximum = signedIntegerAt(row?.maximum);
  if (count > 100 || maximum < -1 || maximum > 99 || (count === 0) !== (maximum === -1)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return { count, maximum };
}

function incrementOmittedRunItems(database: DatabaseSync, runId: number, amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError("Invalid omitted run-item increment");
  }
  assertSingleRowChange(
    database
      .prepare(
        `UPDATE sessions_index_runs
         SET omitted_item_count = omitted_item_count + ?
         WHERE run_id = ? AND status = 'active'`,
      )
      .run(amount, runId),
  );
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

function assertIdentityBatch(run: SessionIndexRun, identities: readonly SessionIdentity[]): void {
  if (
    !Array.isArray(identities) ||
    identities.length === 0 ||
    identities.length > SESSION_INDEX_BATCH_LIMIT
  ) {
    throw new TypeError(`Session identity batch must contain 1-${SESSION_INDEX_BATCH_LIMIT} items`);
  }
  for (const [ordinal, identity] of identities.entries()) {
    assertIdentity(identity);
    if (!sameSource(identity.source, run.source)) {
      throw new TypeError("Session identity batch must match the index run source");
    }
    const previous = identities[ordinal - 1];
    if (previous !== undefined && compareUtf8Binary(previous.nativeId, identity.nativeId) >= 0) {
      throw new TypeError("Session identity batch must use unique binary native-ID order");
    }
  }
}

function assertObservationBatch(
  run: SessionIndexRun,
  observations: readonly SessionObservation[],
): void {
  if (!Array.isArray(observations)) {
    throw new TypeError("Session observation batch must be an array");
  }
  assertIdentityBatch(
    run,
    observations.map((observation) => observation.identity),
  );
}

function assertNativeIdCursor(value: string | undefined): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || value.length === 0 || !value.isWellFormed())
  ) {
    throw new TypeError("Tracked identity cursor must be a non-empty well-formed string");
  }
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

function compareUtf8Binary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
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

function assertSingleRowChange(result: { readonly changes: number | bigint }): void {
  if (result.changes !== 1 && result.changes !== 1n) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
}

function assertChangeCount(result: { readonly changes: number | bigint }, expected: number): void {
  const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
  if (!Number.isSafeInteger(changes) || changes !== expected) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
}

interface RunRow {
  readonly source_instance_id: number | bigint;
  readonly status: string;
  readonly started_at: string;
  readonly kind: string;
  readonly instance_id: string;
}

interface TrackedBatchRow {
  readonly ordinal: unknown;
  readonly session_id: unknown;
  readonly native_id: unknown;
}
