import type { DatabaseSync } from "node:sqlite";

import type { SessionQueryRepository } from "../../application/ports/session-query.ts";
import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../../application/session-query-error.ts";
import {
  createSessionQueryCursor,
  sessionQueryFingerprintMaterial,
  type SessionListPage,
  type SessionListQuery,
  type SessionQuerySummary,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchQuery,
  type SessionSearchSnippet,
} from "../../domain/session-query.ts";
import { isCanonicalTimestamp } from "../../domain/canonical-timestamp.ts";
import { contentHashMatches } from "../../domain/content-hash.ts";
import type { SessionRootResolver } from "../../domain/session-lineage.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { ContentOrigin, OriginConfidence, SessionIdentity } from "../../domain/session.ts";
import { splitUnicodeWhitespaceTerms } from "../../domain/unicode-whitespace.ts";
import { readSqliteCaptureScope } from "./sqlite-capture-scope.ts";
import { literalFtsQuery } from "./literal-fts-query.ts";
import {
  decodeQueryCursor,
  encodeAnchoredQueryCursor,
  encodeQueryCursor,
  fingerprintQuery,
  readQueryRevision,
  type QueryCursorAnchor,
  type QueryCommand,
  type QueryRevision,
} from "./query-cursor.ts";
import { entryAt, readSearchContexts, truncateUtf8Around } from "./sqlite-query-context.ts";
import {
  EFFECTIVE_SESSION_ACTIVITY_SQL,
  searchWhere,
  sessionWhere,
  type SqliteQueryWhere,
} from "./sqlite-query-filters.ts";
import { countRootSupport, createRetainedSessionRootResolver } from "./sqlite-query-lineage.ts";
import { decodeSqliteContentDigest } from "./sqlite-content-digest.ts";
import {
  readSessionSummariesBatch,
  type SessionSummaryBatchRequest,
} from "./sqlite-session-state.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";
import { listSqliteSessionEntries } from "./sqlite-session-entry-query.ts";
import { readSqliteSessionManifest } from "./sqlite-session-manifest.ts";

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

export function createSqliteSessionQuery(database: DatabaseSync): SessionQueryRepository {
  return {
    async entries(query) {
      return listSqliteSessionEntries(database, query);
    },
    async list(query) {
      return listSessions(database, query);
    },
    async manifest(query) {
      return readSqliteSessionManifest(database, query);
    },
    async search(query) {
      return searchSessions(database, query);
    },
  };
}

function listSessions(database: DatabaseSync, query: SessionListQuery): SessionListPage {
  const cursor = prepareCursor(database, "list", query);
  const captureScope = readSqliteCaptureScope(database, query.filter);
  const position = listCoordinatePosition(database, query, cursor);
  const statement = buildSqliteListCoordinateStatement(query, position);
  const rows = database
    .prepare(statement.sql)
    .all(...statement.parameters) as unknown as readonly ListCoordinateRow[];
  const pageRows = rows.slice(0, query.limit);
  const resolveRoot =
    pageRows.length === 0 ? undefined : createRetainedSessionRootResolver(database);
  const summaries = readSelectedSummaries(database, pageRows.map(listSessionCoordinateAt));
  const sessions = pageRows.map((row) => {
    const identity = identityAt(row);
    const summary = summaries.get(integerAt(row.session_id));
    if (summary === undefined || resolveRoot === undefined) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    if (!sameIdentity(summary.identity, identity))
      throw new SqliteSessionIndexError("corrupt-data");
    return Object.freeze({ ...freezeSummary(summary), root: resolveRoot(identity) });
  });
  const nextCursor =
    rows.length > query.limit
      ? nextListQueryCursor(cursor, cursor.offset + query.limit, pageRows)
      : undefined;
  return Object.freeze({
    sessions: Object.freeze(sessions),
    captureScope,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

export interface SqliteListCoordinateStatement {
  readonly sql: string;
  readonly parameters: readonly (number | string)[];
}

export type SqliteListCoordinatePosition =
  | { readonly kind: "first" }
  | { readonly kind: "offset"; readonly offset: number }
  | { readonly kind: "keyset"; readonly anchor: SqliteListResolvedAnchor };

export interface SqliteListResolvedAnchor {
  readonly sessionId: number;
  readonly activity: string | null;
  readonly sourceKind: string;
  readonly instanceId: string;
  readonly nativeId: string;
}

export function buildSqliteListCoordinateStatement(
  query: SessionListQuery,
  position: SqliteListCoordinatePosition,
): SqliteListCoordinateStatement {
  const where = sessionWhere(query.filter);
  if (position.kind !== "keyset") {
    return Object.freeze({
      sql: `${listCoordinateSelect()}
       WHERE 1 = 1${where.sql}
       ${listCoordinateOrder()}
       LIMIT ?${position.kind === "offset" ? " OFFSET ?" : ""}`,
      parameters: Object.freeze([
        ...where.parameters,
        query.limit + 1,
        ...(position.kind === "offset" ? [position.offset] : []),
      ]),
    });
  }

  return Object.freeze({
    sql: `WITH resolved_anchor AS MATERIALIZED (
       SELECT canonical.session_id,
              ${EFFECTIVE_SESSION_ACTIVITY_SQL} AS activity,
              source.kind AS source_kind,
              source.instance_id,
              tracking.native_id
       FROM sessions_canonical_sessions AS canonical
       JOIN sessions_session_tracking AS tracking
         ON tracking.session_id = canonical.session_id
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       WHERE canonical.session_id = ?
         AND 1 = 1${where.sql}
     )
     ${listCoordinateSelect()}
     CROSS JOIN resolved_anchor AS anchor
     WHERE 1 = 1${where.sql}
       AND (
         CASE WHEN ${EFFECTIVE_SESSION_ACTIVITY_SQL} IS NULL THEN 1 ELSE 0 END
           > CASE WHEN anchor.activity IS NULL THEN 1 ELSE 0 END
         OR (
           CASE WHEN ${EFFECTIVE_SESSION_ACTIVITY_SQL} IS NULL THEN 1 ELSE 0 END
             = CASE WHEN anchor.activity IS NULL THEN 1 ELSE 0 END
           AND (
             (
               anchor.activity IS NOT NULL
               AND ${EFFECTIVE_SESSION_ACTIVITY_SQL} < anchor.activity
             )
             OR (
               (
                 ${EFFECTIVE_SESSION_ACTIVITY_SQL} = anchor.activity
                 OR (
                   ${EFFECTIVE_SESSION_ACTIVITY_SQL} IS NULL
                   AND anchor.activity IS NULL
                 )
               )
               AND (
                 source.kind COLLATE BINARY,
                 source.instance_id COLLATE BINARY,
                 tracking.native_id COLLATE BINARY
               ) > (
                 anchor.source_kind,
                 anchor.instance_id,
                 anchor.native_id
               )
             )
           )
         )
       )
     ${listCoordinateOrder()}
     LIMIT ?`,
    parameters: Object.freeze([
      position.anchor.sessionId,
      ...where.parameters,
      ...where.parameters,
      query.limit + 1,
    ]),
  });
}

function listCoordinateSelect(): string {
  return `SELECT canonical.session_id,
                source.kind,
                source.instance_id,
                tracking.native_id,
                ${EFFECTIVE_SESSION_ACTIVITY_SQL} AS activity
         FROM sessions_canonical_sessions AS canonical
         JOIN sessions_session_tracking AS tracking
           ON tracking.session_id = canonical.session_id
         JOIN sessions_source_instances AS source
           ON source.source_instance_id = tracking.source_instance_id`;
}

function listCoordinateOrder(): string {
  return `ORDER BY
         CASE WHEN ${EFFECTIVE_SESSION_ACTIVITY_SQL} IS NULL THEN 1 ELSE 0 END,
         ${EFFECTIVE_SESSION_ACTIVITY_SQL} DESC,
         source.kind COLLATE BINARY,
         source.instance_id COLLATE BINARY,
         tracking.native_id COLLATE BINARY`;
}

function listCoordinatePosition(
  database: DatabaseSync,
  query: SessionListQuery,
  cursor: PreparedCursor,
): SqliteListCoordinatePosition {
  if (cursor.anchor === undefined) {
    return cursor.legacyOffset ? { kind: "offset", offset: cursor.offset } : { kind: "first" };
  }
  if (cursor.anchor.kind !== "list") throw new SessionQueryUsageError("invalid-cursor");
  return {
    kind: "keyset",
    anchor: resolveListAnchor(database, query, cursor.anchor),
  };
}

function resolveListAnchor(
  database: DatabaseSync,
  query: SessionListQuery,
  anchor: Extract<QueryCursorAnchor, { readonly kind: "list" }>,
): SqliteListResolvedAnchor {
  const where = sessionWhere(query.filter);
  const rows = database
    .prepare(
      `WITH physical_anchor AS MATERIALIZED (
         SELECT canonical.session_id,
                ${EFFECTIVE_SESSION_ACTIVITY_SQL} AS activity,
                source.kind,
                source.instance_id,
                tracking.native_id
         FROM sessions_canonical_sessions AS canonical
         JOIN sessions_session_tracking AS tracking
           ON tracking.session_id = canonical.session_id
         JOIN sessions_source_instances AS source
           ON source.source_instance_id = tracking.source_instance_id
         WHERE canonical.session_id = ?
       ),
       qualifying_anchor AS MATERIALIZED (
         SELECT canonical.session_id
         FROM sessions_canonical_sessions AS canonical
         JOIN sessions_session_tracking AS tracking
           ON tracking.session_id = canonical.session_id
         JOIN sessions_source_instances AS source
           ON source.source_instance_id = tracking.source_instance_id
         WHERE canonical.session_id = ?
           AND 1 = 1${where.sql}
       )
       SELECT physical_anchor.*,
              EXISTS (SELECT 1 FROM qualifying_anchor) AS qualifies
       FROM physical_anchor`,
    )
    .all(
      anchor.sessionId,
      anchor.sessionId,
      ...where.parameters,
    ) as unknown as readonly ListAnchorRow[];
  if (rows.length === 0) throw new SessionQueryUsageError("invalid-cursor");
  if (rows.length !== 1) throw new SqliteSessionIndexError("corrupt-data");
  const row = rows[0];
  if (row === undefined) throw new SqliteSessionIndexError("corrupt-data");
  const sessionId = integerAt(row.session_id);
  const identity = identityAt(row);
  const activity = optionalCanonicalTimestampAt(row.activity);
  const qualifies = integerAt(row.qualifies);
  if (sessionId !== anchor.sessionId || qualifies > 1) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  if (qualifies === 0) throw new SessionQueryUsageError("invalid-cursor");
  return {
    sessionId,
    activity,
    sourceKind: identity.source.kind,
    instanceId: identity.source.instanceId,
    nativeId: identity.nativeId,
  };
}

function nextListQueryCursor(
  cursor: PreparedCursor,
  offset: number,
  pageRows: readonly ListCoordinateRow[],
) {
  const row = pageRows.at(-1);
  if (row === undefined) throw new SqliteSessionIndexError("corrupt-data");
  return createSessionQueryCursor(
    encodeAnchoredQueryCursor({
      command: "list",
      fingerprint: cursor.fingerprint,
      revision: cursor.revision,
      offset,
      anchor: { kind: "list", sessionId: integerAt(row.session_id) },
    }),
  );
}

function searchSessions(database: DatabaseSync, query: SessionSearchQuery): SessionSearchPage {
  const cursor = prepareCursor(database, "search", query);
  const captureScope = readSqliteCaptureScope(database, {
    ...query.filter,
    searchText: query.text,
  });
  const ftsQuery = literalFtsQuery(query.text, query.termMode);
  if (ftsQuery === undefined) return emptySearchPage(captureScope);
  const where = searchWhere(query.filter);
  const supportResolution = readSupport(database, ftsQuery, where);
  const searchRows = readSearchRows(database, query, ftsQuery, where, cursor.offset);
  const pageRows = searchRows.slice(0, query.limit);
  const hits =
    pageRows.length === 0
      ? []
      : hydrateSearchHits(
          database,
          pageRows,
          query.context,
          ftsQuery,
          cursor.revision.libraryInstanceId,
          query,
          supportResolution.resolveRoot,
        );
  const nextCursor =
    searchRows.length > query.limit
      ? nextSearchQueryCursor(cursor, cursor.offset + query.limit)
      : undefined;
  return Object.freeze({
    hits: Object.freeze(hits),
    support: Object.freeze(supportResolution.support),
    captureScope,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function readSearchRows(
  database: DatabaseSync,
  query: SessionSearchQuery,
  ftsQuery: string,
  where: SqliteQueryWhere,
  offset: number,
): readonly SearchRankRow[] {
  return database
    .prepare(
      `WITH matching_segments AS (
         SELECT canonical.session_id,
                source.kind AS source_kind,
                source.instance_id,
                tracking.native_id,
                canonical.created_at,
                canonical.updated_at,
                entry.ordinal AS entry_ordinal,
                entry.kind AS entry_kind,
                entry.actor,
                entry.timestamp,
                entry.related_entry_ordinal,
                entry.tool_call_id,
                entry.tool_name,
                entry.tool_namespace,
                occurrence.segment_ordinal,
                occurrence.content_id,
                occurrence.origin,
                occurrence.confidence,
                bm25(sessions_content_fts) AS score
         FROM sessions_content_fts
         JOIN sessions_content_values AS content
           ON content.content_id = sessions_content_fts.rowid
         JOIN sessions_content_occurrences AS occurrence
           ON occurrence.content_id = content.content_id
         JOIN sessions_entries AS entry
           ON entry.session_id = occurrence.session_id
          AND entry.ordinal = occurrence.entry_ordinal
         JOIN sessions_canonical_sessions AS canonical
           ON canonical.session_id = entry.session_id
         JOIN sessions_session_tracking AS tracking
           ON tracking.session_id = canonical.session_id
         JOIN sessions_source_instances AS source
           ON source.source_instance_id = tracking.source_instance_id
         WHERE sessions_content_fts MATCH ?${where.sql}
       ), ranked_segments AS (
         SELECT matching_segments.*,
                COUNT(*) OVER (
                  PARTITION BY session_id, entry_ordinal
                ) AS matching_segment_count,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id, entry_ordinal
                  ORDER BY score, segment_ordinal
                ) AS segment_rank
         FROM matching_segments
       )
       SELECT *
       FROM ranked_segments
       WHERE segment_rank = 1
       ORDER BY
         score,
         CASE WHEN COALESCE(updated_at, created_at) IS NULL THEN 1 ELSE 0 END,
         COALESCE(updated_at, created_at) DESC,
         source_kind COLLATE BINARY,
         instance_id COLLATE BINARY,
         native_id COLLATE BINARY,
         entry_ordinal
       LIMIT ? OFFSET ?`,
    )
    .all(
      ftsQuery,
      ...where.parameters,
      query.limit + 1,
      offset,
    ) as unknown as readonly SearchRankRow[];
}

function hydrateSearchContent(
  database: DatabaseSync,
  rows: readonly SearchRankRow[],
  ftsQuery: string,
  libraryInstanceId: string,
): HydratedSearchContent {
  const contentIds = [...new Set(rows.map((row) => integerAt(row.content_id)))];
  const selectedSql = contentIds.map(() => "(?, ?)").join(", ");
  const selectedParameters = contentIds.flatMap((contentId, contentIndex) => [
    contentIndex,
    contentId,
  ]);
  // FTS5 can ignore an untyped bound rowid beside MATCH; the explicit cast keeps
  // hydration restricted to the selected ranked canonical content rows.
  const statement = database.prepare(
    `WITH selected_content(content_index, content_id) AS (
       VALUES ${selectedSql}
     )
     SELECT selected.content_index,
            selected.content_id,
            content.text,
            content.digest AS content_digest,
            snippet(sessions_content_fts, 0, ?, ?, ' … ', 64) AS snippet_text
     FROM sessions_content_fts
     JOIN sessions_content_values AS content
       ON content.content_id = sessions_content_fts.rowid
     JOIN selected_content AS selected
       ON sessions_content_fts.rowid = CAST(selected.content_id AS INTEGER)
     WHERE sessions_content_fts MATCH ?
     ORDER BY selected.content_index`,
  );

  for (let candidate = 0; ; candidate += 1) {
    if (!Number.isSafeInteger(candidate)) throw new SqliteSessionIndexError("corrupt-data");
    const markers = snippetMarkers(libraryInstanceId, candidate);
    const hydrated = statement.all(
      ...selectedParameters,
      markers.start,
      markers.end,
      ftsQuery,
    ) as unknown as readonly HydratedContentRow[];
    if (hydrated.length !== contentIds.length) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    const byContentId = new Map<number, HydratedContentRow>();
    let collision = false;
    for (const row of hydrated) {
      const contentIndex = integerAt(row.content_index);
      const contentId = integerAt(row.content_id);
      if (contentIds[contentIndex] !== contentId || byContentId.has(contentId)) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      const text = storedString(row.text);
      if (text.includes(markers.start) || text.includes(markers.end)) {
        collision = true;
        break;
      }
      byContentId.set(contentId, row);
    }
    if (!collision) return { byContentId, markers };
  }
}

function hydrateSearchHits(
  database: DatabaseSync,
  rows: readonly SearchRankRow[],
  adjacentContext: number,
  ftsQuery: string,
  libraryInstanceId: string,
  query: SessionSearchQuery,
  resolveRoot: SessionRootResolver | undefined,
): readonly SessionSearchHit[] {
  if (resolveRoot === undefined) throw new SqliteSessionIndexError("corrupt-data");
  const hydrated = hydrateSearchContent(database, rows, ftsQuery, libraryInstanceId);
  const matchedTerms = readMatchedTerms(database, rows, query);
  const contexts = readSearchContexts(database, rows.map(searchCoordinateAt), adjacentContext);
  if (contexts.length !== rows.length) throw new SqliteSessionIndexError("corrupt-data");
  const summaries = readSelectedSummaries(database, rows.map(searchSessionCoordinateAt));
  return rows.map((row, rowIndex) => {
    const context = contexts[rowIndex];
    if (context === undefined) throw new SqliteSessionIndexError("corrupt-data");
    return searchHit(row, summaries, hydrated, matchedTerms, resolveRoot, context);
  });
}

function readMatchedTerms(
  database: DatabaseSync,
  rows: readonly SearchRankRow[],
  query: SessionSearchQuery,
): ReadonlyMap<string, readonly string[]> {
  const terms = uniqueSearchTerms(query.text);
  const coordinates = rows.map(searchCoordinateAt);
  const matches = new Map<string, string[]>(
    coordinates.map(({ sessionId, entryOrdinal }) => [coordinateKey(sessionId, entryOrdinal), []]),
  );
  if (matches.size !== coordinates.length || terms.length === 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }

  if (query.termMode === "all") {
    const exactTerms = Object.freeze([...terms]);
    return new Map([...matches.keys()].map((key) => [key, exactTerms]));
  }

  const selectedSql = coordinates.map(() => "(?, ?)").join(", ");
  const coordinateParameters = coordinates.flatMap(({ sessionId, entryOrdinal }) => [
    sessionId,
    entryOrdinal,
  ]);
  const originSql = query.filter.origin === undefined ? "" : " AND occurrence.origin = ?";
  const originParameters = query.filter.origin === undefined ? [] : [query.filter.origin];
  // Drive through the selected entry and occurrence keys before probing the one
  // canonical FTS row, so term attribution stays page-bounded.
  const statement = database.prepare(
    `WITH selected_entries(session_id, entry_ordinal) AS (
       VALUES ${selectedSql}
     )
     SELECT selected.session_id, selected.entry_ordinal
     FROM selected_entries AS selected
     WHERE EXISTS (
       SELECT 1
       FROM sessions_content_occurrences AS occurrence
       WHERE occurrence.session_id = selected.session_id
         AND occurrence.entry_ordinal = selected.entry_ordinal
         AND occurrence.content_id IS NOT NULL${originSql}
         AND EXISTS (
           SELECT 1
           FROM sessions_content_fts
           WHERE sessions_content_fts MATCH ?
             AND sessions_content_fts.rowid = CAST(occurrence.content_id AS INTEGER)
         )
     )
     ORDER BY selected.session_id, selected.entry_ordinal`,
  );

  for (const term of terms) {
    const termQuery = literalFtsQuery(term, "all");
    if (termQuery === undefined) throw new SqliteSessionIndexError("corrupt-data");
    const matchedRows = statement.all(
      ...coordinateParameters,
      ...originParameters,
      termQuery,
    ) as unknown as readonly SearchCoordinateRow[];
    for (const row of matchedRows) {
      const coordinate = searchCoordinateAt(row);
      const matched = matches.get(coordinateKey(coordinate.sessionId, coordinate.entryOrdinal));
      if (matched === undefined) throw new SqliteSessionIndexError("corrupt-data");
      matched.push(term);
    }
  }

  const result = new Map<string, readonly string[]>();
  for (const [key, matched] of matches) {
    if (matched.length === 0) throw new SqliteSessionIndexError("corrupt-data");
    result.set(key, Object.freeze(matched));
  }
  return result;
}

function uniqueSearchTerms(text: string): readonly string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of splitUnicodeWhitespaceTerms(text)) {
    if (seen.has(term)) continue;
    seen.add(term);
    result.push(term);
  }
  return result;
}

function snippetMarkers(libraryInstanceId: string, candidate: number): SnippetMarkers {
  return {
    start: `\u0001sessions-${libraryInstanceId}-${String(candidate)}-match-start\u0002`,
    end: `\u0001sessions-${libraryInstanceId}-${String(candidate)}-match-end\u0002`,
  };
}

function readSupport(
  database: DatabaseSync,
  ftsQuery: string,
  where: SqliteQueryWhere,
): SearchSupportResolution {
  const joins = searchJoins();
  const aggregate = database
    .prepare(
      `SELECT COUNT(*) AS occurrences,
              COUNT(DISTINCT occurrence.content_id) AS unique_content
       ${joins}
       WHERE sessions_content_fts MATCH ?${where.sql}`,
    )
    .get(ftsQuery, ...where.parameters) as AggregateRow | undefined;
  if (aggregate === undefined) throw new SqliteSessionIndexError("corrupt-data");
  const matchingRows = database
    .prepare(
      `SELECT DISTINCT source.kind, source.instance_id, tracking.native_id
       ${joins}
       WHERE sessions_content_fts MATCH ?${where.sql}
       ORDER BY source.kind COLLATE BINARY,
                source.instance_id COLLATE BINARY,
                tracking.native_id COLLATE BINARY`,
    )
    .all(ftsQuery, ...where.parameters) as unknown as readonly IdentityRow[];
  const occurrences = integerAt(aggregate.occurrences);
  const uniqueContent = integerAt(aggregate.unique_content);
  if (matchingRows.length === 0) {
    if (occurrences !== 0 || uniqueContent !== 0) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    return {
      support: {
        occurrences: 0,
        uniqueContent: 0,
        uniqueKnownRoots: 0,
        unknownLineageSessions: 0,
      },
    };
  }
  const resolveRoot = createRetainedSessionRootResolver(database);
  const roots = countRootSupport(resolveRoot, matchingRows.map(identityAt));
  return {
    support: { occurrences, uniqueContent, ...roots },
    resolveRoot,
  };
}

function searchJoins(): string {
  return `FROM sessions_content_fts
    JOIN sessions_content_values AS content
      ON content.content_id = sessions_content_fts.rowid
    JOIN sessions_content_occurrences AS occurrence
      ON occurrence.content_id = content.content_id
    JOIN sessions_entries AS entry
      ON entry.session_id = occurrence.session_id
     AND entry.ordinal = occurrence.entry_ordinal
    JOIN sessions_canonical_sessions AS canonical
      ON canonical.session_id = entry.session_id
    JOIN sessions_session_tracking AS tracking
      ON tracking.session_id = canonical.session_id
    JOIN sessions_source_instances AS source
      ON source.source_instance_id = tracking.source_instance_id`;
}

function searchHit(
  row: SearchRankRow,
  summaries: ReadonlyMap<number, SessionQuerySummary>,
  hydrated: HydratedSearchContent,
  matchedTerms: ReadonlyMap<string, readonly string[]>,
  resolveRoot: SessionRootResolver,
  context: ReturnType<typeof readSearchContexts>[number],
): SessionSearchHit {
  const sessionId = integerAt(row.session_id);
  const identity = identityAt({
    kind: row.source_kind,
    instance_id: row.instance_id,
    native_id: row.native_id,
  });
  const summary = summaries.get(sessionId);
  if (summary === undefined || !sameIdentity(summary.identity, identity)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const entry = entryAt({
    ordinal: row.entry_ordinal,
    kind: row.entry_kind,
    actor: row.actor,
    timestamp: row.timestamp,
    related_entry_ordinal: row.related_entry_ordinal,
    tool_call_id: row.tool_call_id,
    tool_name: row.tool_name,
    tool_namespace: row.tool_namespace,
  });
  const contentId = integerAt(row.content_id);
  const content = hydrated.byContentId.get(contentId);
  if (content === undefined) throw new SqliteSessionIndexError("corrupt-data");
  const snippet = snippetAt(row, content, hydrated.markers);
  const terms = matchedTerms.get(coordinateKey(sessionId, entry.ordinal));
  if (terms === undefined) throw new SqliteSessionIndexError("corrupt-data");
  return Object.freeze({
    session: summary,
    root: resolveRoot(identity),
    entry,
    snippet,
    matchedTerms: terms,
    context: context.entries,
    linkedContextTruncated: context.linkedContextTruncated,
  });
}

function searchCoordinateAt(row: {
  readonly session_id: unknown;
  readonly entry_ordinal: unknown;
}): SearchCoordinate {
  return {
    sessionId: integerAt(row.session_id),
    entryOrdinal: integerAt(row.entry_ordinal),
  };
}

function listSessionCoordinateAt(row: ListCoordinateRow): SelectedSessionCoordinate {
  return { sessionId: integerAt(row.session_id), identity: identityAt(row) };
}

function searchSessionCoordinateAt(row: SearchRankRow): SelectedSessionCoordinate {
  return {
    sessionId: integerAt(row.session_id),
    identity: identityAt({
      kind: row.source_kind,
      instance_id: row.instance_id,
      native_id: row.native_id,
    }),
  };
}

function readSelectedSummaries(
  database: DatabaseSync,
  coordinates: readonly SelectedSessionCoordinate[],
): ReadonlyMap<number, SessionQuerySummary> {
  const requests = new Map<number, SessionSummaryBatchRequest>();
  for (const coordinate of coordinates) {
    const previous = requests.get(coordinate.sessionId);
    if (previous !== undefined) {
      if (!sameIdentity(previous.identity, coordinate.identity)) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      continue;
    }
    requests.set(coordinate.sessionId, {
      sessionId: coordinate.sessionId,
      identity: coordinate.identity,
    });
  }
  const stored = readSessionSummariesBatch(database, [...requests.values()]);
  return new Map(
    [...stored].map(([sessionId, summary]) => [sessionId, freezeSummary(summary)] as const),
  );
}

function coordinateKey(sessionId: number, entryOrdinal: number): string {
  return `${String(sessionId)}:${String(entryOrdinal)}`;
}

function snippetAt(
  row: SearchRankRow,
  content: HydratedContentRow,
  markers: SnippetMarkers,
): SessionSearchSnippet {
  const fullText = storedString(content.text);
  const contentHash = decodeSqliteContentDigest(content.content_digest);
  if (!contentHashMatches(fullText, contentHash)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const markedExcerpt = storedString(content.snippet_text);
  if (!ORIGINS.has(row.origin) || !CONFIDENCES.has(row.confidence)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const markerIndex = markedExcerpt.indexOf(markers.start);
  if (
    markerIndex < 0 ||
    markedExcerpt.indexOf(markers.end, markerIndex + markers.start.length) < 0
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const beforeMatch = removeSnippetMarkers(markedExcerpt.slice(0, markerIndex), markers);
  const excerpt = removeSnippetMarkers(markedExcerpt, markers);
  const bounded = truncateUtf8Around(excerpt, beforeMatch.length);
  const matchingSegments = integerAt(row.matching_segment_count);
  if (matchingSegments < 1) throw new SqliteSessionIndexError("corrupt-data");
  return Object.freeze({
    segmentOrdinal: integerAt(row.segment_ordinal),
    origin: row.origin,
    originConfidence: row.confidence,
    contentHash: Object.freeze(contentHash),
    text: bounded.text,
    truncated: bounded.truncated || excerpt !== fullText,
    additionalMatchingSegments: matchingSegments - 1,
  });
}

function removeSnippetMarkers(value: string, markers: SnippetMarkers): string {
  return value.replaceAll(markers.start, "").replaceAll(markers.end, "");
}

function prepareCursor(
  database: DatabaseSync,
  command: QueryCommand,
  query: SessionListQuery | SessionSearchQuery,
): PreparedCursor {
  const revision = readQueryRevision(database);
  const fingerprint = fingerprintQuery(sessionQueryFingerprintMaterial(query));
  if (query.cursor === undefined) {
    return { revision, fingerprint, offset: 0, legacyOffset: false };
  }
  const decoded = decodeQueryCursor(query.cursor, { command, fingerprint, revision });
  if (!decoded.ok) {
    if (decoded.reason === "stale") throw new SessionQueryOperationalError("stale-cursor");
    throw new SessionQueryUsageError(
      decoded.reason === "mismatch" ? "cursor-query-mismatch" : "invalid-cursor",
    );
  }
  return {
    revision,
    fingerprint,
    offset: decoded.offset,
    legacyOffset: decoded.anchor === undefined,
    ...(decoded.anchor === undefined ? {} : { anchor: decoded.anchor }),
  };
}

function nextSearchQueryCursor(cursor: PreparedCursor, offset: number) {
  return createSessionQueryCursor(
    encodeQueryCursor({
      command: "search",
      fingerprint: cursor.fingerprint,
      revision: cursor.revision,
      offset,
    }),
  );
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

function identityAt(row: IdentityRow): SessionIdentity {
  const identity = {
    source: { kind: row.kind, instanceId: row.instance_id },
    nativeId: row.native_id,
  };
  if (!isSessionIdentity(identity)) throw new SqliteSessionIndexError("corrupt-data");
  return identity;
}

function sameIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return (
    left.source.kind === right.source.kind &&
    left.source.instanceId === right.source.instanceId &&
    left.nativeId === right.nativeId
  );
}

function emptySearchPage(captureScope: SessionSearchPage["captureScope"]): SessionSearchPage {
  return Object.freeze({
    hits: Object.freeze([]),
    support: Object.freeze({
      occurrences: 0,
      uniqueContent: 0,
      uniqueKnownRoots: 0,
      unknownLineageSessions: 0,
    }),
    captureScope,
  });
}

function storedString(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return value;
}

function optionalCanonicalTimestampAt(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !isCanonicalTimestamp(value)) {
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

interface PreparedCursor {
  readonly revision: QueryRevision;
  readonly fingerprint: string;
  readonly offset: number;
  readonly legacyOffset: boolean;
  readonly anchor?: QueryCursorAnchor;
}

interface SnippetMarkers {
  readonly start: string;
  readonly end: string;
}

interface HydratedSearchContent {
  readonly byContentId: ReadonlyMap<number, HydratedContentRow>;
  readonly markers: SnippetMarkers;
}

interface SearchSupportResolution {
  readonly support: SessionSearchPage["support"];
  readonly resolveRoot?: SessionRootResolver;
}

interface SearchCoordinate {
  readonly sessionId: number;
  readonly entryOrdinal: number;
}

interface SelectedSessionCoordinate {
  readonly sessionId: number;
  readonly identity: SessionIdentity;
}

interface SearchCoordinateRow {
  readonly session_id: unknown;
  readonly entry_ordinal: unknown;
}

interface IdentityRow {
  readonly kind: unknown;
  readonly instance_id: unknown;
  readonly native_id: unknown;
}

interface ListCoordinateRow extends IdentityRow {
  readonly session_id: unknown;
  readonly activity: unknown;
}

interface ListAnchorRow extends ListCoordinateRow {
  readonly qualifies: unknown;
}

interface AggregateRow {
  readonly occurrences: unknown;
  readonly unique_content: unknown;
}

interface SearchRankRow {
  readonly session_id: unknown;
  readonly source_kind: unknown;
  readonly instance_id: unknown;
  readonly native_id: unknown;
  readonly entry_ordinal: unknown;
  readonly entry_kind: unknown;
  readonly actor: never;
  readonly timestamp: unknown;
  readonly related_entry_ordinal: unknown;
  readonly tool_call_id: unknown;
  readonly tool_name: unknown;
  readonly tool_namespace: unknown;
  readonly segment_ordinal: unknown;
  readonly content_id: unknown;
  readonly origin: ContentOrigin;
  readonly confidence: OriginConfidence;
  readonly matching_segment_count: unknown;
}

interface HydratedContentRow {
  readonly content_index: unknown;
  readonly content_id: unknown;
  readonly text: unknown;
  readonly content_digest: unknown;
  readonly snippet_text: unknown;
}
