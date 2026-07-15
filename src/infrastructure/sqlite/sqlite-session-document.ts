import type { DatabaseSync, StatementSync } from "node:sqlite";

import { validateSessionDocument } from "../../domain/session-validation.ts";
import { isCanonicalSourceType, isContentClass } from "../../domain/source-type.ts";
import type {
  ContentSegment,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SessionRelation,
  TextContentSegment,
} from "../../domain/session.ts";
import {
  deleteUnreferencedContentCandidates,
  readSessionContentCandidates,
} from "./sqlite-content-maintenance.ts";
import { decodeSqliteContentDigest, encodeSqliteContentDigest } from "./sqlite-content-digest.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

export function replaceCanonicalDocument(
  database: DatabaseSync,
  sessionId: number,
  document: SessionDocument,
): void {
  const obsoleteContentCandidates = readSessionContentCandidates(database, sessionId);
  database.prepare("DELETE FROM sessions_canonical_sessions WHERE session_id = ?").run(sessionId);
  database
    .prepare(
      `INSERT INTO sessions_canonical_sessions (
         session_id,
         lineage_coverage,
         title,
         workspace,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      document.lineageCoverage,
      document.title ?? null,
      document.workspace ?? null,
      document.createdAt ?? null,
      document.updatedAt ?? null,
    );

  insertRelations(database, sessionId, document.relations);
  insertEntries(database, sessionId, document.entries);
  deleteUnreferencedContentCandidates(database, obsoleteContentCandidates);
}

export function readCanonicalDocument(
  database: DatabaseSync,
  identity: SessionIdentity,
  sessionId: number,
): SessionDocument | undefined {
  const session = database
    .prepare(
      `SELECT lineage_coverage, title, workspace, created_at, updated_at
       FROM sessions_canonical_sessions
       WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (session === undefined) return undefined;

  const relations = readRelations(database, sessionId);
  const entries = readEntries(database, sessionId);
  const candidate: SessionDocument = {
    identity: copyIdentity(identity),
    lineageCoverage: lineageCoverageAt(session.lineage_coverage),
    ...optional("title", session.title),
    ...optional("workspace", session.workspace),
    ...optional("createdAt", session.created_at),
    ...optional("updatedAt", session.updated_at),
    relations,
    entries,
  };
  const validated = validateSessionDocument(candidate, { expectedIdentity: identity });
  if (!validated.ok) throw new SqliteSessionIndexError("corrupt-data");
  return validated.document;
}

function insertRelations(
  database: DatabaseSync,
  sessionId: number,
  relations: readonly SessionRelation[],
): void {
  const statement = database.prepare(
    `INSERT INTO sessions_relations (
       session_id,
       ordinal,
       kind,
       target_kind,
       target_instance_id,
       target_native_id,
       confidence
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [ordinal, relation] of relations.entries()) {
    statement.run(
      sessionId,
      ordinal,
      relation.kind,
      relation.target.source.kind,
      relation.target.source.instanceId,
      relation.target.nativeId,
      relation.confidence,
    );
  }
}

function insertEntries(
  database: DatabaseSync,
  sessionId: number,
  entries: readonly SessionEntry[],
): void {
  const entryStatement = database.prepare(
    `INSERT INTO sessions_entries (
       session_id,
       ordinal,
       kind,
       actor,
       timestamp,
       related_entry_ordinal,
       tool_call_id,
       tool_name,
       tool_namespace,
       source_locator_uri,
       source_locator_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const occurrenceStatement = database.prepare(
    `INSERT INTO sessions_content_occurrences (
       session_id,
       entry_ordinal,
       segment_ordinal,
       content_id,
       content_class,
       source_type,
       origin,
       confidence,
       source_metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let contentStatements: ContentStatements | undefined;

  for (const entry of entries) {
    entryStatement.run(
      sessionId,
      entry.ordinal,
      entry.kind,
      entry.actor,
      entry.timestamp ?? null,
      entry.relatedEntryOrdinal ?? null,
      entry.toolCallId ?? null,
      entry.toolName ?? null,
      entry.toolNamespace ?? null,
      entry.sourceLocator.uri,
      entry.sourceLocator.recordId ?? null,
    );
    for (const segment of entry.content) {
      const contentId =
        segment.kind === "text"
          ? internContent((contentStatements ??= prepareContentStatements(database)), segment)
          : null;
      occurrenceStatement.run(
        sessionId,
        entry.ordinal,
        segment.ordinal,
        contentId,
        segment.kind === "omitted" ? segment.contentClass : null,
        segment.kind === "omitted" ? segment.sourceType : null,
        segment.origin,
        segment.originConfidence,
        serializeMetadata(segment.sourceMetadata),
      );
    }
  }
}

function prepareContentStatements(database: DatabaseSync): ContentStatements {
  return {
    insert: database.prepare(
      `INSERT INTO sessions_content_values (digest, text)
       VALUES (?, ?)
       RETURNING content_id`,
    ),
    find: database.prepare(
      `SELECT content_id
       FROM sessions_content_values
       WHERE digest = ? AND text = ? COLLATE BINARY
       ORDER BY content_id
       LIMIT 2`,
    ),
  };
}

function internContent(statements: ContentStatements, segment: TextContentSegment): number {
  const digest = encodeSqliteContentDigest(segment.contentHash.digest);
  const rows = statements.find.all(digest, segment.text) as unknown as readonly {
    readonly content_id?: unknown;
  }[];
  if (rows.length > 1) throw new SqliteSessionIndexError("corrupt-data");
  const existing = rows[0];
  if (existing !== undefined) return integerAt(existing.content_id);
  const inserted = statements.insert.get(digest, segment.text) as
    | { readonly content_id?: unknown }
    | undefined;
  return integerAt(inserted?.content_id);
}

interface ContentStatements {
  readonly insert: StatementSync;
  readonly find: StatementSync;
}

function readRelations(database: DatabaseSync, sessionId: number): readonly SessionRelation[] {
  const rows = database
    .prepare(
      `SELECT ordinal, kind, target_kind, target_instance_id, target_native_id, confidence
       FROM sessions_relations
       WHERE session_id = ?
       ORDER BY ordinal`,
    )
    .all(sessionId) as unknown as readonly RelationRow[];
  return rows.map((row, ordinal) => {
    if (integerAt(row.ordinal) !== ordinal) throw new SqliteSessionIndexError("corrupt-data");
    return {
      kind: row.kind,
      target: {
        source: { kind: row.target_kind, instanceId: row.target_instance_id },
        nativeId: row.target_native_id,
      },
      confidence: row.confidence,
    };
  });
}

function readEntries(database: DatabaseSync, sessionId: number): readonly SessionEntry[] {
  const entryRows = database
    .prepare(
      `SELECT ordinal, kind, actor, timestamp, related_entry_ordinal, tool_call_id,
              tool_name, tool_namespace, source_locator_uri, source_locator_record_id
       FROM sessions_entries
       WHERE session_id = ?
       ORDER BY ordinal`,
    )
    .all(sessionId) as unknown as readonly EntryRow[];
  const segmentsByEntry = readSegments(database, sessionId);

  return entryRows.map((row, ordinal) => {
    if (integerAt(row.ordinal) !== ordinal) throw new SqliteSessionIndexError("corrupt-data");
    const toolName = optionalStoredString(row.tool_name);
    const toolNamespace = optionalStoredString(row.tool_namespace);
    if (
      (row.kind !== "tool-call" && (toolName !== undefined || toolNamespace !== undefined)) ||
      (toolNamespace !== undefined && toolName === undefined)
    ) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    return {
      ordinal,
      kind: row.kind,
      actor: row.actor,
      ...optional("timestamp", row.timestamp),
      ...optionalInteger("relatedEntryOrdinal", row.related_entry_ordinal),
      ...optional("toolCallId", row.tool_call_id),
      ...(toolName === undefined ? {} : { toolName }),
      ...(toolNamespace === undefined ? {} : { toolNamespace }),
      sourceLocator: {
        uri: row.source_locator_uri,
        ...optional("recordId", row.source_locator_record_id),
      },
      content: segmentsByEntry.get(ordinal) ?? [],
    };
  });
}

function readSegments(
  database: DatabaseSync,
  sessionId: number,
): ReadonlyMap<number, ContentSegment[]> {
  const rows = database
    .prepare(
      `SELECT occurrence.entry_ordinal,
              occurrence.segment_ordinal,
              occurrence.origin,
              occurrence.confidence,
              occurrence.source_metadata_json,
              occurrence.content_id,
              occurrence.content_class,
              occurrence.source_type,
              content.digest,
              content.text
       FROM sessions_content_occurrences AS occurrence
       LEFT JOIN sessions_content_values AS content
         ON content.content_id = occurrence.content_id
       WHERE occurrence.session_id = ?
       ORDER BY occurrence.entry_ordinal, occurrence.segment_ordinal`,
    )
    .all(sessionId) as unknown as readonly SegmentRow[];
  const result = new Map<number, ContentSegment[]>();
  for (const row of rows) {
    const entryOrdinal = integerAt(row.entry_ordinal);
    const segmentOrdinal = integerAt(row.segment_ordinal);
    const segments = result.get(entryOrdinal) ?? [];
    if (segmentOrdinal !== segments.length) throw new SqliteSessionIndexError("corrupt-data");
    const common = {
      ordinal: segmentOrdinal,
      origin: row.origin,
      originConfidence: row.confidence,
      sourceMetadata: parseMetadata(row.source_metadata_json),
    } as const;
    if (row.content_id === null) {
      if (
        row.digest !== null ||
        row.text !== null ||
        !isContentClass(row.content_class) ||
        !isCanonicalSourceType(row.source_type)
      ) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      segments.push({
        kind: "omitted",
        ...common,
        contentClass: row.content_class,
        sourceType: row.source_type,
      });
    } else {
      integerAt(row.content_id);
      if (row.content_class !== null || row.source_type !== null || typeof row.text !== "string") {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      segments.push({
        kind: "text",
        ...common,
        text: row.text,
        contentHash: decodeSqliteContentDigest(row.digest),
      });
    }
    result.set(entryOrdinal, segments);
  }
  return result;
}

function serializeMetadata(metadata: Readonly<Record<string, string>>): string {
  const entries = Object.entries(metadata).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
    .join(",")}}`;
}

function parseMetadata(value: string): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new SqliteSessionIndexError("corrupt-data", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const entries = Object.entries(parsed);
  if (
    entries.some(
      ([key, item]) => !key.isWellFormed() || typeof item !== "string" || !item.isWellFormed(),
    )
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function optionalStoredString(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return value;
}

function copyIdentity(identity: SessionIdentity): SessionIdentity {
  return { source: { ...identity.source }, nativeId: identity.nativeId };
}

function optional<const Key extends string>(
  key: Key,
  value: string | null,
): { readonly [Property in Key]?: string } {
  return value === null ? {} : ({ [key]: value } as { [Property in Key]: string });
}

function optionalInteger<const Key extends string>(
  key: Key,
  value: number | bigint | null,
): { readonly [Property in Key]?: number } {
  return value === null ? {} : ({ [key]: integerAt(value) } as { [Property in Key]: number });
}

function integerAt(value: unknown): number {
  const integer = typeof value === "bigint" ? Number(value) : value;
  if (typeof integer !== "number" || !Number.isSafeInteger(integer) || integer < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return integer;
}

interface SessionRow {
  readonly lineage_coverage: unknown;
  readonly title: string | null;
  readonly workspace: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
}

function lineageCoverageAt(value: unknown): SessionDocument["lineageCoverage"] {
  if (value === "complete" || value === "unknown") return value;
  throw new SqliteSessionIndexError("corrupt-data");
}

interface RelationRow {
  readonly ordinal: number | bigint;
  readonly kind: SessionRelation["kind"];
  readonly target_kind: string;
  readonly target_instance_id: string;
  readonly target_native_id: string;
  readonly confidence: SessionRelation["confidence"];
}

interface EntryRow {
  readonly ordinal: number | bigint;
  readonly kind: string;
  readonly actor: SessionEntry["actor"];
  readonly timestamp: string | null;
  readonly related_entry_ordinal: number | bigint | null;
  readonly tool_call_id: string | null;
  readonly tool_name: unknown;
  readonly tool_namespace: unknown;
  readonly source_locator_uri: string;
  readonly source_locator_record_id: string | null;
}

interface SegmentRow {
  readonly entry_ordinal: number | bigint;
  readonly segment_ordinal: number | bigint;
  readonly origin: ContentSegment["origin"];
  readonly confidence: ContentSegment["originConfidence"];
  readonly source_metadata_json: string;
  readonly content_id: number | bigint | null;
  readonly content_class: unknown;
  readonly source_type: unknown;
  readonly digest: unknown;
  readonly text: unknown;
}
