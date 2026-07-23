import type { DatabaseSync } from "node:sqlite";

import type {
  IndexedSessionSummary,
  SessionFreshness,
  SessionIndexFailureCode,
} from "../../application/ports/session-index.ts";
import type { SessionRevision } from "../../application/validate-session.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { SessionIdentity } from "../../domain/session.ts";
import {
  EFFECTIVE_SOURCE_OBSERVED_AT_SQL,
  EFFECTIVE_SOURCE_STATE_SQL,
} from "./sqlite-query-filters.ts";
import { decodeSqliteDocumentDigest } from "./sqlite-document-digest.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const FAILURE_CODES: ReadonlySet<string> = new Set<SessionIndexFailureCode>([
  "unavailable",
  "unreadable",
  "malformed",
  "source-changed",
  "unsupported-format",
  "repository-write",
]);
const SESSION_SUMMARY_BATCH_LIMIT = 200;

export interface SessionTrackingRecord {
  readonly session_id: number | bigint;
  readonly source_instance_id: number | bigint;
  readonly last_good_fingerprint_scheme: string | null;
  readonly last_good_fingerprint_digest: string | null;
  readonly last_good_adapter_version: string | null;
  readonly latest_fingerprint_scheme: string | null;
  readonly latest_fingerprint_digest: string | null;
  readonly latest_adapter_version: string | null;
  readonly latest_outcome: string;
  readonly latest_failure_code: string | null;
  readonly presence_status: string;
  readonly presence_observed_at: string | null;
  readonly captured_at: string | null;
  readonly last_seen_at: string | null;
  readonly has_document: number | bigint;
}

export interface SessionTrackingFreshnessColumns {
  readonly last_good_fingerprint_scheme: unknown;
  readonly last_good_fingerprint_digest: unknown;
  readonly last_good_adapter_version: unknown;
  readonly latest_fingerprint_scheme: unknown;
  readonly latest_fingerprint_digest: unknown;
  readonly latest_adapter_version: unknown;
  readonly latest_outcome: unknown;
  readonly latest_failure_code: unknown;
}

export function findSessionTracking(
  database: DatabaseSync,
  identity: SessionIdentity,
): SessionTrackingRecord | undefined {
  return database
    .prepare(
      `SELECT tracking.session_id,
              tracking.source_instance_id,
              tracking.last_good_fingerprint_scheme,
              tracking.last_good_fingerprint_digest,
              tracking.last_good_adapter_version,
              tracking.latest_fingerprint_scheme,
              tracking.latest_fingerprint_digest,
              tracking.latest_adapter_version,
              tracking.latest_outcome,
              tracking.latest_failure_code,
              tracking.presence_status,
              tracking.presence_observed_at,
              tracking.captured_at,
              tracking.last_seen_at,
              EXISTS (
                SELECT 1
                FROM sessions_canonical_sessions AS canonical
                WHERE canonical.session_id = tracking.session_id
              ) AS has_document
       FROM sessions_session_tracking AS tracking
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       WHERE source.kind = ?
         AND source.instance_id = ?
         AND tracking.native_id = ?`,
    )
    .get(identity.source.kind, identity.source.instanceId, identity.nativeId) as
    | SessionTrackingRecord
    | undefined;
}

export function readSessionFreshness(
  database: DatabaseSync,
  identity: SessionIdentity,
): SessionFreshness {
  const row = findSessionTracking(database, identity);
  if (row === undefined) return { status: "untracked", identity: copyIdentity(identity) };

  return decodeTrackedSessionFreshness(identity, booleanIntegerAt(row.has_document), row);
}

export function readSessionFreshnessBatch(
  database: DatabaseSync,
  sourceInstanceId: number,
  identities: readonly SessionIdentity[],
): readonly SessionFreshness[] {
  const values = identities.map(() => "(?, ?)").join(", ");
  const parameters = identities.flatMap((identity, ordinal) => [ordinal, identity.nativeId]);
  const rows = database
    .prepare(
      `WITH requested(ordinal, native_id) AS (VALUES ${values})
       SELECT requested.ordinal,
              requested.native_id,
              tracking.session_id,
              tracking.source_instance_id,
              tracking.last_good_fingerprint_scheme,
              tracking.last_good_fingerprint_digest,
              tracking.last_good_adapter_version,
              tracking.latest_fingerprint_scheme,
              tracking.latest_fingerprint_digest,
              tracking.latest_adapter_version,
              tracking.latest_outcome,
              tracking.latest_failure_code,
              CASE WHEN canonical.session_id IS NULL THEN 0 ELSE 1 END AS has_document
       FROM requested
       LEFT JOIN sessions_session_tracking AS tracking
         ON tracking.source_instance_id = ?
        AND tracking.native_id = requested.native_id COLLATE BINARY
       LEFT JOIN sessions_canonical_sessions AS canonical
         ON canonical.session_id = tracking.session_id
       ORDER BY requested.ordinal`,
    )
    .all(...parameters, sourceInstanceId) as unknown as readonly FreshnessBatchRow[];
  if (rows.length !== identities.length) throw new SqliteSessionIndexError("corrupt-data");

  return Object.freeze(
    rows.map((row, ordinal) => {
      const identity = identities[ordinal];
      if (
        identity === undefined ||
        integerAt(row.ordinal) !== ordinal ||
        row.native_id !== identity.nativeId
      ) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      if (row.session_id === null) {
        if (row.source_instance_id !== null || booleanIntegerAt(row.has_document)) {
          throw new SqliteSessionIndexError("corrupt-data");
        }
        return { status: "untracked" as const, identity: copyIdentity(identity) };
      }
      integerAt(row.session_id);
      if (integerAt(row.source_instance_id) !== sourceInstanceId) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      return decodeTrackedSessionFreshness(identity, booleanIntegerAt(row.has_document), row);
    }),
  );
}

export function decodeTrackedSessionFreshness(
  identity: SessionIdentity,
  hasDocument: boolean,
  row: SessionTrackingFreshnessColumns,
): Exclude<SessionFreshness, { readonly status: "untracked" }> {
  const lastGood = lastGoodRevision(row);
  const latestRevision = revisionFromColumns(
    row.latest_fingerprint_scheme,
    row.latest_fingerprint_digest,
    row.latest_adapter_version,
  );
  const copiedIdentity = copyIdentity(identity);

  if (latestRevision === undefined) throw new SqliteSessionIndexError("corrupt-data");
  if (row.latest_outcome === "failed") {
    if (!isFailureCode(row.latest_failure_code)) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    const latest = {
      outcome: "failed" as const,
      revision: latestRevision,
      failure: row.latest_failure_code,
    };
    if (hasDocument && lastGood !== undefined) {
      return { status: "stale", identity: copiedIdentity, lastGood, latest };
    }
    if (!hasDocument && lastGood === undefined) {
      return { status: "unindexed", identity: copiedIdentity, latest };
    }
    throw new SqliteSessionIndexError("corrupt-data");
  }
  if (
    (row.latest_outcome === "indexed" || row.latest_outcome === "unchanged") &&
    hasDocument &&
    lastGood !== undefined &&
    sameRevision(lastGood, latestRevision) &&
    row.latest_failure_code === null
  ) {
    return {
      status: "current",
      identity: copiedIdentity,
      lastGood,
      latest: { outcome: row.latest_outcome, revision: latestRevision },
    };
  }
  throw new SqliteSessionIndexError("corrupt-data");
}

export function readSessionSummary(
  database: DatabaseSync,
  identity: SessionIdentity,
): IndexedSessionSummary | undefined {
  const row = database
    .prepare(
      `SELECT canonical.title,
              canonical.workspace,
              canonical.created_at,
              canonical.updated_at,
              tracking.captured_at,
              canonical.document_digest_scheme,
              canonical.document_digest,
              ${EFFECTIVE_SOURCE_STATE_SQL} AS source_state,
              ${EFFECTIVE_SOURCE_OBSERVED_AT_SQL} AS source_observed_at
       FROM sessions_canonical_sessions AS canonical
       JOIN sessions_session_tracking AS tracking
         ON tracking.session_id = canonical.session_id
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       WHERE source.kind = ?
         AND source.instance_id = ?
         AND tracking.native_id = ?`,
    )
    .get(identity.source.kind, identity.source.instanceId, identity.nativeId) as
    | SessionSummaryColumns
    | undefined;
  if (row === undefined) return undefined;
  const freshness = readSessionFreshness(database, identity);
  if (freshness.status !== "current" && freshness.status !== "stale") {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return decodeRetainedSessionSummary(identity, row, freshness);
}

export interface SessionSummaryBatchRequest {
  readonly sessionId: number;
  readonly identity: SessionIdentity;
}

export function readSessionSummariesBatch(
  database: DatabaseSync,
  requests: readonly SessionSummaryBatchRequest[],
): ReadonlyMap<number, IndexedSessionSummary> {
  if (requests.length === 0) return new Map();
  if (requests.length > SESSION_SUMMARY_BATCH_LIMIT) {
    throw new TypeError("SQLite session summary batch exceeds the supported limit");
  }

  const requestedSessionIds = new Set<number>();
  const requestsBySessionId = new Map<number, SessionSummaryBatchRequest>();
  const parameters: Array<number | string> = [];
  for (const request of requests) {
    if (
      !Number.isSafeInteger(request.sessionId) ||
      request.sessionId < 0 ||
      !isSessionIdentity(request.identity) ||
      requestedSessionIds.has(request.sessionId)
    ) {
      throw new TypeError("Invalid SQLite session summary batch request");
    }
    requestedSessionIds.add(request.sessionId);
    requestsBySessionId.set(request.sessionId, request);
    parameters.push(
      request.sessionId,
      request.identity.source.kind,
      request.identity.source.instanceId,
      request.identity.nativeId,
    );
  }

  const values = requests.map(() => "(?, ?, ?, ?)").join(", ");
  const statement = database.prepare(
    `WITH requested(session_id, source_kind, instance_id, native_id) AS (
       VALUES ${values}
     )
     SELECT requested.session_id AS requested_session_id,
            source.kind AS source_kind,
            source.instance_id,
            tracking.native_id,
            canonical.title,
            canonical.workspace,
            canonical.created_at,
            canonical.updated_at,
            tracking.captured_at,
            canonical.document_digest_scheme,
            canonical.document_digest,
            ${EFFECTIVE_SOURCE_STATE_SQL} AS source_state,
            ${EFFECTIVE_SOURCE_OBSERVED_AT_SQL} AS source_observed_at,
            tracking.last_good_fingerprint_scheme,
            tracking.last_good_fingerprint_digest,
            tracking.last_good_adapter_version,
            tracking.latest_fingerprint_scheme,
            tracking.latest_fingerprint_digest,
            tracking.latest_adapter_version,
            tracking.latest_outcome,
            tracking.latest_failure_code
     FROM requested
     JOIN sessions_canonical_sessions AS canonical
       ON canonical.session_id = requested.session_id
     JOIN sessions_session_tracking AS tracking
       ON tracking.session_id = canonical.session_id
      AND tracking.native_id = requested.native_id COLLATE BINARY
     JOIN sessions_source_instances AS source
       ON source.source_instance_id = tracking.source_instance_id
      AND source.kind = requested.source_kind COLLATE BINARY
      AND source.instance_id = requested.instance_id COLLATE BINARY`,
  );
  statement.setReadBigInts(true);
  const rows = statement.all(...parameters) as unknown as readonly SessionSummaryBatchRow[];
  if (rows.length !== requests.length) throw new SqliteSessionIndexError("corrupt-data");

  const summaries = new Map<number, IndexedSessionSummary>();
  for (const row of rows) {
    const sessionId = integerAt(row.requested_session_id);
    const request = requestsBySessionId.get(sessionId);
    if (
      request === undefined ||
      row.source_kind !== request.identity.source.kind ||
      row.instance_id !== request.identity.source.instanceId ||
      row.native_id !== request.identity.nativeId ||
      summaries.has(sessionId)
    ) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    const freshness = decodeTrackedSessionFreshness(request.identity, true, row);
    if (freshness.status !== "current" && freshness.status !== "stale") {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    summaries.set(sessionId, decodeRetainedSessionSummary(request.identity, row, freshness));
  }
  if (summaries.size !== requests.length) throw new SqliteSessionIndexError("corrupt-data");
  return summaries;
}

export function decodeRetainedSessionSummary(
  identity: SessionIdentity,
  row: SessionSummaryColumns,
  freshness: RetainedSessionFreshness,
): IndexedSessionSummary {
  const sourceState = effectiveSourceStateAt(row.source_state);
  const capturedAt = canonicalTimestampAt(row.captured_at);
  const sourceObservedAt = canonicalTimestampAt(row.source_observed_at);
  return {
    identity: copyIdentity(identity),
    ...optionalStoredString("title", row.title),
    ...optionalStoredString("workspace", row.workspace),
    ...optionalStoredTimestamp("createdAt", row.created_at),
    ...optionalStoredTimestamp("updatedAt", row.updated_at),
    freshness: freshness.status,
    sourceState,
    capturedAt,
    sourceObservedAt,
    adapterVersion: freshness.lastGood.adapterVersion,
    documentDigest: decodeSqliteDocumentDigest(row.document_digest_scheme, row.document_digest),
  };
}

export function lastGoodRevision(
  row: SessionTrackingFreshnessColumns,
): SessionRevision | undefined {
  return revisionFromColumns(
    row.last_good_fingerprint_scheme,
    row.last_good_fingerprint_digest,
    row.last_good_adapter_version,
  );
}

export function sameRevision(left: SessionRevision | undefined, right: SessionRevision): boolean {
  return (
    left !== undefined &&
    left.aggregateFingerprint.scheme === right.aggregateFingerprint.scheme &&
    left.aggregateFingerprint.digest === right.aggregateFingerprint.digest &&
    left.adapterVersion === right.adapterVersion
  );
}

export function hasCanonicalDocument(database: DatabaseSync, sessionId: number): boolean {
  return (
    database
      .prepare("SELECT 1 AS present FROM sessions_canonical_sessions WHERE session_id = ?")
      .get(sessionId) !== undefined
  );
}

function revisionFromColumns(
  scheme: unknown,
  digest: unknown,
  adapterVersion: unknown,
): SessionRevision | undefined {
  if (scheme === null && digest === null && adapterVersion === null) return undefined;
  if (
    scheme !== "sha256-json-v1" ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(digest) ||
    typeof adapterVersion !== "string" ||
    adapterVersion.length === 0 ||
    !adapterVersion.isWellFormed()
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return {
    aggregateFingerprint: { scheme, digest },
    adapterVersion,
  };
}

function isFailureCode(value: unknown): value is SessionIndexFailureCode {
  return typeof value === "string" && FAILURE_CODES.has(value);
}

function copyIdentity(identity: SessionIdentity): SessionIdentity {
  return { source: { ...identity.source }, nativeId: identity.nativeId };
}

function optionalStoredString<const Key extends string>(
  key: Key,
  value: unknown,
): { readonly [Property in Key]?: string } {
  if (value === null) return {};
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return { [key]: value } as { [Property in Key]: string };
}

function optionalStoredTimestamp<const Key extends string>(
  key: Key,
  value: unknown,
): { readonly [Property in Key]?: string } {
  if (value === null) return {};
  return { [key]: canonicalTimestampAt(value) } as { [Property in Key]: string };
}

function booleanIntegerAt(value: unknown): boolean {
  const integer = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof integer !== "number" ||
    !Number.isSafeInteger(integer) ||
    (integer !== 0 && integer !== 1)
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return integer === 1;
}

function integerAt(value: unknown): number {
  const integer = typeof value === "bigint" ? Number(value) : value;
  if (typeof integer !== "number" || !Number.isSafeInteger(integer) || integer < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return integer;
}

interface FreshnessBatchRow extends SessionTrackingFreshnessColumns {
  readonly ordinal: unknown;
  readonly native_id: unknown;
  readonly session_id: unknown;
  readonly source_instance_id: unknown;
  readonly has_document: unknown;
}

interface SessionSummaryBatchRow extends SessionSummaryColumns, SessionTrackingFreshnessColumns {
  readonly requested_session_id: unknown;
  readonly source_kind: unknown;
  readonly instance_id: unknown;
  readonly native_id: unknown;
}

export interface SessionSummaryColumns {
  readonly title: unknown;
  readonly workspace: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly captured_at: unknown;
  readonly source_state: unknown;
  readonly source_observed_at: unknown;
  readonly document_digest_scheme: unknown;
  readonly document_digest: unknown;
}

export type RetainedSessionFreshness = Extract<
  SessionFreshness,
  { readonly status: "current" | "stale" }
>;

function effectiveSourceStateAt(value: unknown): IndexedSessionSummary["sourceState"] {
  if (value === "present" || value === "missing" || value === "unknown") return value;
  throw new SqliteSessionIndexError("corrupt-data");
}

function canonicalTimestampAt(value: unknown): string {
  if (typeof value !== "string") throw new SqliteSessionIndexError("corrupt-data");
  const milliseconds = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return value;
}
