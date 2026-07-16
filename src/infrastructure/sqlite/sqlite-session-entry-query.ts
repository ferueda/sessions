import type { DatabaseSync } from "node:sqlite";

import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../../application/session-query-error.ts";
import { contentHashMatches } from "../../domain/content-hash.ts";
import {
  createSessionQueryCursor,
  sessionQueryFingerprintMaterial,
  type SessionEntryContentSummary,
  type SessionEntryInventoryItem,
  type SessionEntryPage,
  type SessionEntryPreview,
  type SessionEntryQuery,
  type SessionQuerySummary,
} from "../../domain/session-query.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { ContentOrigin, OriginConfidence, SessionIdentity } from "../../domain/session.ts";
import {
  decodeQueryCursor,
  encodeQueryCursor,
  fingerprintQuery,
  readQueryRevision,
  type QueryRevision,
} from "./query-cursor.ts";
import { decodeSqliteContentDigest } from "./sqlite-content-digest.ts";
import { entryAt, truncateUtf8 } from "./sqlite-query-context.ts";
import {
  entryInventoryWhere,
  entrySelectionWhere,
  type SqliteQueryWhere,
} from "./sqlite-query-filters.ts";
import { createRetainedSessionRootResolver } from "./sqlite-query-lineage.ts";
import { readSessionSummary } from "./sqlite-session-state.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const ORIGINS = new Set<ContentOrigin>([
  "human",
  "injected",
  "delegated",
  "replayed-copied",
  "model",
  "tool",
  "system",
  "unknown",
]);
const CONFIDENCES = new Set<OriginConfidence>(["high", "medium", "low", "unknown"]);

export function listSqliteSessionEntries(
  database: DatabaseSync,
  query: SessionEntryQuery,
): SessionEntryPage {
  const cursor = prepareEntryCursor(database, query);
  const rows = readEntryRows(database, query, cursor.offset);
  const pageRows = rows.slice(0, query.limit);
  const entries = pageRows.length === 0 ? [] : hydrateEntries(database, pageRows, query);
  const nextCursor =
    rows.length > query.limit
      ? createSessionQueryCursor(
          encodeQueryCursor({
            command: "entries",
            fingerprint: cursor.fingerprint,
            revision: cursor.revision,
            offset: cursor.offset + query.limit,
          }),
        )
      : undefined;
  return Object.freeze({
    entries: Object.freeze(entries),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function readEntryRows(
  database: DatabaseSync,
  query: SessionEntryQuery,
  offset: number,
): readonly EntryCoordinateRow[] {
  const outer = entryInventoryWhere(query.filter);
  const selection = selectionClause(query);
  return database
    .prepare(
      `SELECT canonical.session_id,
              source.kind AS source_kind,
              source.instance_id,
              tracking.native_id,
              entry.ordinal,
              entry.kind,
              entry.actor,
              entry.timestamp,
              entry.related_entry_ordinal,
              entry.tool_call_id,
              entry.tool_name,
              entry.tool_namespace
       FROM sessions_source_instances AS source
       JOIN sessions_session_tracking AS tracking
         ON tracking.source_instance_id = source.source_instance_id
       JOIN sessions_canonical_sessions AS canonical
         ON canonical.session_id = tracking.session_id
       JOIN sessions_entries AS entry
         ON entry.session_id = canonical.session_id
       WHERE 1 = 1${outer.sql}${selection.sql}
       ORDER BY source.kind COLLATE BINARY,
                source.instance_id COLLATE BINARY,
                tracking.native_id COLLATE BINARY,
                entry.ordinal
       LIMIT ? OFFSET ?`,
    )
    .all(
      ...outer.parameters,
      ...selection.parameters,
      query.limit + 1,
      offset,
    ) as unknown as readonly EntryCoordinateRow[];
}

function selectionClause(query: SessionEntryQuery): SqliteQueryWhere {
  if (query.selection === "all") return { sql: "", parameters: [] };
  const selected = entrySelectionWhere(query.filter, "selected_entry");
  return {
    sql: ` AND entry.ordinal = (
      SELECT selected_entry.ordinal
      FROM sessions_entries AS selected_entry
      WHERE selected_entry.session_id = entry.session_id${selected.sql}
      ORDER BY selected_entry.ordinal ${query.selection === "first" ? "ASC" : "DESC"}
      LIMIT 1
    )`,
    parameters: selected.parameters,
  };
}

function hydrateEntries(
  database: DatabaseSync,
  rows: readonly EntryCoordinateRow[],
  query: SessionEntryQuery,
): readonly SessionEntryInventoryItem[] {
  const coordinates = rows.map((row) => ({
    sessionId: integerAt(row.session_id),
    entryOrdinal: integerAt(row.ordinal),
  }));
  const counts = readContentCounts(database, coordinates);
  const previews = readPreviews(database, coordinates, query.filter.origin);
  const resolveRoot = createRetainedSessionRootResolver(database);
  const summaryCache = new Map<number, SessionQuerySummary>();

  return rows.map((row, index) => {
    const coordinate = coordinates[index];
    if (coordinate === undefined) throw new SqliteSessionIndexError("corrupt-data");
    const identity = identityAt(row);
    let summary = summaryCache.get(coordinate.sessionId);
    if (summary === undefined) {
      const stored = readSessionSummary(database, identity);
      if (stored === undefined) throw new SqliteSessionIndexError("corrupt-data");
      summary = freezeSummary(stored);
      summaryCache.set(coordinate.sessionId, summary);
    }
    const root = resolveRoot(identity);
    const coordinateKey = contentKey(coordinate.sessionId, coordinate.entryOrdinal);
    const count = counts.get(coordinateKey);
    if (count === undefined) throw new SqliteSessionIndexError("corrupt-data");
    const preview = previews.get(coordinateKey);
    const content = contentSummary(count, preview);
    return Object.freeze({
      session: summary,
      entry: entryAt(row),
      root,
      content,
    });
  });
}

function readContentCounts(
  database: DatabaseSync,
  coordinates: readonly EntryCoordinate[],
): ReadonlyMap<string, ContentCount> {
  const selected = selectedEntriesCte(coordinates);
  const rows = database
    .prepare(
      `${selected.sql}
       SELECT selected.session_id,
              selected.entry_ordinal,
              COUNT(occurrence.content_id) AS text_segment_count,
              SUM(
                CASE
                  WHEN occurrence.segment_ordinal IS NOT NULL
                   AND occurrence.content_id IS NULL
                  THEN 1 ELSE 0
                END
              ) AS omitted_segment_count
       FROM selected_entries AS selected
       LEFT JOIN sessions_content_occurrences AS occurrence
         ON occurrence.session_id = selected.session_id
        AND occurrence.entry_ordinal = selected.entry_ordinal
       GROUP BY selected.session_id, selected.entry_ordinal`,
    )
    .all(...selected.parameters) as unknown as readonly ContentCountRow[];
  if (rows.length !== coordinates.length) throw new SqliteSessionIndexError("corrupt-data");
  const result = new Map<string, ContentCount>();
  for (const row of rows) {
    const sessionId = integerAt(row.session_id);
    const entryOrdinal = integerAt(row.entry_ordinal);
    const key = contentKey(sessionId, entryOrdinal);
    if (result.has(key)) throw new SqliteSessionIndexError("corrupt-data");
    result.set(key, {
      textSegmentCount: integerAt(row.text_segment_count),
      omittedSegmentCount: integerAt(row.omitted_segment_count),
    });
  }
  return result;
}

function readPreviews(
  database: DatabaseSync,
  coordinates: readonly EntryCoordinate[],
  origin: ContentOrigin | undefined,
): ReadonlyMap<string, SessionEntryPreview> {
  const selected = selectedEntriesCte(coordinates);
  const originCondition = origin === undefined ? "" : " AND occurrence.origin = ?";
  const candidateOriginCondition = origin === undefined ? "" : " AND candidate.origin = ?";
  const originParameters = origin === undefined ? [] : [origin, origin];
  const rows = database
    .prepare(
      `${selected.sql}
       SELECT occurrence.session_id,
              occurrence.entry_ordinal,
              occurrence.segment_ordinal,
              occurrence.origin,
              occurrence.confidence,
              content.text,
              content.digest
       FROM selected_entries AS selected
       JOIN sessions_content_occurrences AS occurrence
         ON occurrence.session_id = selected.session_id
        AND occurrence.entry_ordinal = selected.entry_ordinal
       JOIN sessions_content_values AS content
         ON content.content_id = occurrence.content_id
       WHERE occurrence.content_id IS NOT NULL${originCondition}
         AND occurrence.segment_ordinal = (
           SELECT candidate.segment_ordinal
           FROM sessions_content_occurrences AS candidate
           WHERE candidate.session_id = occurrence.session_id
             AND candidate.entry_ordinal = occurrence.entry_ordinal
             AND candidate.content_id IS NOT NULL${candidateOriginCondition}
           ORDER BY candidate.segment_ordinal
           LIMIT 1
         )`,
    )
    .all(...selected.parameters, ...originParameters) as unknown as readonly PreviewRow[];
  const result = new Map<string, SessionEntryPreview>();
  for (const row of rows) {
    const key = contentKey(integerAt(row.session_id), integerAt(row.entry_ordinal));
    if (result.has(key)) throw new SqliteSessionIndexError("corrupt-data");
    result.set(key, previewAt(row));
  }
  return result;
}

function selectedEntriesCte(coordinates: readonly EntryCoordinate[]): SelectedEntriesCte {
  if (coordinates.length === 0) throw new TypeError("Selected entry page must not be empty");
  return {
    sql: `WITH selected_entries(session_id, entry_ordinal) AS (
      VALUES ${coordinates.map(() => "(?, ?)").join(", ")}
    )`,
    parameters: coordinates.flatMap(({ sessionId, entryOrdinal }) => [sessionId, entryOrdinal]),
  };
}

function previewAt(row: PreviewRow): SessionEntryPreview {
  if (!ORIGINS.has(row.origin) || !CONFIDENCES.has(row.confidence)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const text = storedString(row.text);
  const contentHash = decodeSqliteContentDigest(row.digest);
  if (!contentHashMatches(text, contentHash)) throw new SqliteSessionIndexError("corrupt-data");
  const excerpt = truncateUtf8(text);
  return Object.freeze({
    segmentOrdinal: integerAt(row.segment_ordinal),
    origin: row.origin,
    originConfidence: row.confidence,
    contentHash: Object.freeze(contentHash),
    text: excerpt.text,
    truncated: excerpt.truncated,
  });
}

function contentSummary(
  count: ContentCount,
  preview: SessionEntryPreview | undefined,
): SessionEntryContentSummary {
  if (preview !== undefined && count.textSegmentCount === 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return Object.freeze({
    textSegmentCount: count.textSegmentCount,
    omittedSegmentCount: count.omittedSegmentCount,
    unpreviewedTextSegmentCount: count.textSegmentCount - (preview === undefined ? 0 : 1),
    ...(preview === undefined ? {} : { preview }),
  });
}

function prepareEntryCursor(database: DatabaseSync, query: SessionEntryQuery): PreparedCursor {
  const revision = readQueryRevision(database);
  const fingerprint = fingerprintQuery(sessionQueryFingerprintMaterial(query));
  if (query.cursor === undefined) return { revision, fingerprint, offset: 0 };
  const decoded = decodeQueryCursor(query.cursor, {
    command: "entries",
    fingerprint,
    revision,
  });
  if (!decoded.ok) {
    if (decoded.reason === "stale") throw new SessionQueryOperationalError("stale-cursor");
    throw new SessionQueryUsageError(
      decoded.reason === "mismatch" ? "cursor-query-mismatch" : "invalid-cursor",
    );
  }
  return { revision, fingerprint, offset: decoded.offset };
}

function identityAt(row: EntryCoordinateRow): SessionIdentity {
  const identity = {
    source: { kind: row.source_kind, instanceId: row.instance_id },
    nativeId: row.native_id,
  };
  if (!isSessionIdentity(identity)) throw new SqliteSessionIndexError("corrupt-data");
  return identity;
}

function freezeSummary(summary: SessionQuerySummary): SessionQuerySummary {
  return Object.freeze({
    ...summary,
    identity: Object.freeze({
      source: Object.freeze({ ...summary.identity.source }),
      nativeId: summary.identity.nativeId,
    }),
  });
}

function storedString(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return value;
}

function integerAt(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return number;
}

function contentKey(sessionId: number, entryOrdinal: number): string {
  return `${String(sessionId)}:${String(entryOrdinal)}`;
}

interface PreparedCursor {
  readonly revision: QueryRevision;
  readonly fingerprint: string;
  readonly offset: number;
}

interface EntryCoordinate {
  readonly sessionId: number;
  readonly entryOrdinal: number;
}

interface SelectedEntriesCte {
  readonly sql: string;
  readonly parameters: readonly number[];
}

interface ContentCount {
  readonly textSegmentCount: number;
  readonly omittedSegmentCount: number;
}

interface EntryCoordinateRow {
  readonly session_id: unknown;
  readonly source_kind: unknown;
  readonly instance_id: unknown;
  readonly native_id: unknown;
  readonly ordinal: unknown;
  readonly kind: unknown;
  readonly actor: never;
  readonly timestamp: unknown;
  readonly related_entry_ordinal: unknown;
  readonly tool_call_id: unknown;
  readonly tool_name: unknown;
  readonly tool_namespace: unknown;
}

interface ContentCountRow {
  readonly session_id: unknown;
  readonly entry_ordinal: unknown;
  readonly text_segment_count: unknown;
  readonly omitted_segment_count: unknown;
}

interface PreviewRow {
  readonly session_id: unknown;
  readonly entry_ordinal: unknown;
  readonly segment_ordinal: unknown;
  readonly origin: ContentOrigin;
  readonly confidence: OriginConfidence;
  readonly text: unknown;
  readonly digest: unknown;
}
