import type { DatabaseSync } from "node:sqlite";

import { validateSessionDocument } from "../../domain/session-validation.ts";
import type {
  ContentSegment,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SessionRelation,
} from "../../domain/session.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

export function replaceCanonicalDocument(
  database: DatabaseSync,
  sessionId: number,
  document: SessionDocument,
): void {
  database.prepare("DELETE FROM sessions_canonical_sessions WHERE session_id = ?").run(sessionId);
  database
    .prepare(
      `INSERT INTO sessions_canonical_sessions (
         session_id,
         title,
         workspace,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      document.title ?? null,
      document.workspace ?? null,
      document.createdAt ?? null,
      document.updatedAt ?? null,
    );

  insertRelations(database, sessionId, document.relations);
  insertEntries(database, sessionId, document.entries);
  garbageCollectContent(database);
}

export function readCanonicalDocument(
  database: DatabaseSync,
  identity: SessionIdentity,
  sessionId: number,
): SessionDocument | undefined {
  const session = database
    .prepare(
      `SELECT title, workspace, created_at, updated_at
       FROM sessions_canonical_sessions
       WHERE session_id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (session === undefined) return undefined;

  const relations = readRelations(database, sessionId);
  const entries = readEntries(database, sessionId);
  const candidate: SessionDocument = {
    identity: copyIdentity(identity),
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

export function garbageCollectContent(database: DatabaseSync): void {
  database.exec(
    `DELETE FROM sessions_content_values
     WHERE NOT EXISTS (
       SELECT 1
       FROM sessions_content_occurrences AS occurrence
       WHERE occurrence.content_id = sessions_content_values.content_id
     )`,
  );
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
       source_locator_uri,
       source_locator_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const occurrenceStatement = database.prepare(
    `INSERT INTO sessions_content_occurrences (
       session_id,
       entry_ordinal,
       segment_ordinal,
       content_id,
       origin,
       confidence,
       source_metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const entry of entries) {
    entryStatement.run(
      sessionId,
      entry.ordinal,
      entry.kind,
      entry.actor,
      entry.timestamp ?? null,
      entry.relatedEntryOrdinal ?? null,
      entry.toolCallId ?? null,
      entry.sourceLocator.uri,
      entry.sourceLocator.recordId ?? null,
    );
    for (const segment of entry.content) {
      const contentId = internContent(database, segment);
      occurrenceStatement.run(
        sessionId,
        entry.ordinal,
        segment.ordinal,
        contentId,
        segment.origin,
        segment.originConfidence,
        serializeMetadata(segment.sourceMetadata),
      );
    }
  }
}

function internContent(database: DatabaseSync, segment: ContentSegment): number {
  database
    .prepare(
      `INSERT INTO sessions_content_values (hash_scheme, digest, text)
       VALUES (?, ?, ?)
       ON CONFLICT (hash_scheme, digest, text) DO NOTHING`,
    )
    .run(segment.contentHash.scheme, segment.contentHash.digest, segment.text);
  const row = database
    .prepare(
      `SELECT content_id
       FROM sessions_content_values
       WHERE hash_scheme = ? AND digest = ? AND text = ?`,
    )
    .get(segment.contentHash.scheme, segment.contentHash.digest, segment.text) as
    | { readonly content_id?: unknown }
    | undefined;
  return integerAt(row?.content_id);
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
              source_locator_uri, source_locator_record_id
       FROM sessions_entries
       WHERE session_id = ?
       ORDER BY ordinal`,
    )
    .all(sessionId) as unknown as readonly EntryRow[];
  const segmentsByEntry = readSegments(database, sessionId);

  return entryRows.map((row, ordinal) => {
    if (integerAt(row.ordinal) !== ordinal) throw new SqliteSessionIndexError("corrupt-data");
    return {
      ordinal,
      kind: row.kind,
      actor: row.actor,
      ...optional("timestamp", row.timestamp),
      ...optionalInteger("relatedEntryOrdinal", row.related_entry_ordinal),
      ...optional("toolCallId", row.tool_call_id),
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
              content.hash_scheme,
              content.digest,
              content.text
       FROM sessions_content_occurrences AS occurrence
       JOIN sessions_content_values AS content
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
    segments.push({
      ordinal: segmentOrdinal,
      text: row.text,
      contentHash: { scheme: row.hash_scheme, digest: row.digest },
      origin: row.origin,
      originConfidence: row.confidence,
      sourceMetadata: parseMetadata(row.source_metadata_json),
    });
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
  readonly title: string | null;
  readonly workspace: string | null;
  readonly created_at: string | null;
  readonly updated_at: string | null;
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
  readonly source_locator_uri: string;
  readonly source_locator_record_id: string | null;
}

interface SegmentRow {
  readonly entry_ordinal: number | bigint;
  readonly segment_ordinal: number | bigint;
  readonly origin: ContentSegment["origin"];
  readonly confidence: ContentSegment["originConfidence"];
  readonly source_metadata_json: string;
  readonly hash_scheme: ContentSegment["contentHash"]["scheme"];
  readonly digest: string;
  readonly text: string;
}
