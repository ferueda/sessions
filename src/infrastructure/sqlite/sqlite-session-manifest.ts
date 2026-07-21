import type { DatabaseSync } from "node:sqlite";

import { SessionQueryOperationalError } from "../../application/session-query-error.ts";
import {
  createSessionManifestResult,
  MAX_SESSION_MANIFEST_REVISIONS,
  type SessionManifestQuery,
  type SessionManifestResult,
  type SessionManifestRevision,
} from "../../domain/session-manifest.ts";
import { isCanonicalTimestamp } from "../../domain/canonical-timestamp.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { LineageCoverage, SessionIdentity } from "../../domain/session.ts";
import { readSqliteCaptureScope } from "./sqlite-capture-scope.ts";
import { decodeSqliteDocumentDigest } from "./sqlite-document-digest.ts";
import {
  EFFECTIVE_SOURCE_OBSERVED_AT_SQL,
  EFFECTIVE_SOURCE_STATE_SQL,
  sessionWhere,
} from "./sqlite-query-filters.ts";
import { createRetainedSessionRootResolver } from "./sqlite-query-lineage.ts";
import {
  decodeTrackedSessionFreshness,
  type SessionTrackingFreshnessColumns,
} from "./sqlite-session-state.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

export function readSqliteSessionManifest(
  database: DatabaseSync,
  query: SessionManifestQuery,
): SessionManifestResult {
  const captureScope = readSqliteCaptureScope(database, query.filter);
  const rows = readCohort(database, query);
  if (rows.length > MAX_SESSION_MANIFEST_REVISIONS) {
    throw new SessionQueryOperationalError("manifest-too-large");
  }
  const resolveRoot = rows.length === 0 ? undefined : createRetainedSessionRootResolver(database);
  const revisions = rows.map((row) => {
    if (resolveRoot === undefined || row.metrics_session_id === null) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    const sessionId = countAt(row.session_id);
    if (countAt(row.metrics_session_id) !== sessionId) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    const session = identityAt(row);
    const retainedState = retainedStateAt(session, row);
    const revision: SessionManifestRevision = {
      session,
      documentDigest: decodeSqliteDocumentDigest(row.document_digest_scheme, row.document_digest),
      ...optionalTimestamp("createdAt", row.created_at),
      ...optionalTimestamp("updatedAt", row.updated_at),
      capturedAt: timestampAt(row.captured_at),
      sourceObservedAt: timestampAt(row.source_observed_at),
      sourceState: sourceStateAt(row.source_state),
      freshness: retainedState.freshness,
      adapterVersion: retainedState.adapterVersion,
      lineageCoverage: lineageCoverageAt(row.lineage_coverage),
      root: resolveRoot(session),
      counts: {
        relations: countAt(row.relation_count),
        entries: countAt(row.entry_count),
        segments: countAt(row.segment_count),
        omittedSegments: countAt(row.omitted_segment_count),
        textUtf8Bytes: countAt(row.text_utf8_bytes),
      },
    };
    return revision;
  });
  try {
    return createSessionManifestResult({
      selection: query.selection,
      captureScope,
      revisions,
    });
  } catch (cause) {
    throw new SqliteSessionIndexError("corrupt-data", { cause });
  }
}

function readCohort(database: DatabaseSync, query: SessionManifestQuery): readonly ManifestRow[] {
  const where = sessionWhere(query.filter);
  return database
    .prepare(
      `WITH cohort AS (
         SELECT canonical.session_id
         FROM sessions_canonical_sessions AS canonical
         JOIN sessions_session_tracking AS tracking
           ON tracking.session_id = canonical.session_id
         JOIN sessions_source_instances AS source
           ON source.source_instance_id = tracking.source_instance_id
         WHERE 1 = 1${where.sql}
         ORDER BY
           source.kind COLLATE BINARY,
           source.instance_id COLLATE BINARY,
           tracking.native_id COLLATE BINARY
         LIMIT ?
       )
       SELECT canonical.session_id,
              source.kind,
              source.instance_id,
              tracking.native_id,
              canonical.document_digest_scheme,
              canonical.document_digest,
              canonical.created_at,
              canonical.updated_at,
              tracking.captured_at,
              ${EFFECTIVE_SOURCE_OBSERVED_AT_SQL} AS source_observed_at,
              ${EFFECTIVE_SOURCE_STATE_SQL} AS source_state,
              tracking.last_good_fingerprint_scheme,
              tracking.last_good_fingerprint_digest,
              tracking.latest_outcome,
              tracking.latest_failure_code,
              tracking.latest_fingerprint_scheme,
              tracking.latest_fingerprint_digest,
              tracking.latest_adapter_version,
              tracking.last_good_adapter_version,
              canonical.lineage_coverage,
              metrics.session_id AS metrics_session_id,
              metrics.relation_count,
              metrics.entry_count,
              metrics.segment_count,
              metrics.omitted_segment_count,
              metrics.text_utf8_bytes
       FROM cohort
       JOIN sessions_canonical_sessions AS canonical
         ON canonical.session_id = cohort.session_id
       JOIN sessions_session_tracking AS tracking
         ON tracking.session_id = canonical.session_id
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       LEFT JOIN sessions_canonical_document_metrics AS metrics
         ON metrics.session_id = canonical.session_id
       ORDER BY
         source.kind COLLATE BINARY,
         source.instance_id COLLATE BINARY,
         tracking.native_id COLLATE BINARY`,
    )
    .all(
      ...where.parameters,
      MAX_SESSION_MANIFEST_REVISIONS + 1,
    ) as unknown as readonly ManifestRow[];
}

function identityAt(row: ManifestRow): SessionIdentity {
  const identity = {
    source: { kind: row.kind, instanceId: row.instance_id },
    nativeId: row.native_id,
  };
  if (!isSessionIdentity(identity)) throw new SqliteSessionIndexError("corrupt-data");
  return identity;
}

function optionalTimestamp<const Key extends "createdAt" | "updatedAt">(
  key: Key,
  value: unknown,
): { readonly [Property in Key]?: string } {
  if (value === null) return {};
  return { [key]: timestampAt(value) } as { readonly [Property in Key]: string };
}

function timestampAt(value: unknown): string {
  if (!isCanonicalTimestamp(value)) throw new SqliteSessionIndexError("corrupt-data");
  return value;
}

function sourceStateAt(value: unknown): SessionManifestRevision["sourceState"] {
  if (value === "present" || value === "missing" || value === "unknown") return value;
  throw new SqliteSessionIndexError("corrupt-data");
}

function lineageCoverageAt(value: unknown): LineageCoverage {
  if (value === "complete" || value === "unknown") return value;
  throw new SqliteSessionIndexError("corrupt-data");
}

function retainedStateAt(
  identity: SessionIdentity,
  row: ManifestRow,
): {
  readonly freshness: SessionManifestRevision["freshness"];
  readonly adapterVersion: string;
} {
  const freshness = decodeTrackedSessionFreshness(identity, true, row);
  if (freshness.status === "current" || freshness.status === "stale") {
    return {
      freshness: freshness.status,
      adapterVersion: freshness.lastGood.adapterVersion,
    };
  }
  throw new SqliteSessionIndexError("corrupt-data");
}

function countAt(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return number;
}

interface ManifestRow extends SessionTrackingFreshnessColumns {
  readonly session_id: unknown;
  readonly kind: unknown;
  readonly instance_id: unknown;
  readonly native_id: unknown;
  readonly document_digest_scheme: unknown;
  readonly document_digest: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly captured_at: unknown;
  readonly source_observed_at: unknown;
  readonly source_state: unknown;
  readonly lineage_coverage: unknown;
  readonly metrics_session_id: unknown;
  readonly relation_count: unknown;
  readonly entry_count: unknown;
  readonly segment_count: unknown;
  readonly omitted_segment_count: unknown;
  readonly text_utf8_bytes: unknown;
}
