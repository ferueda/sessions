import type { DatabaseSync } from "node:sqlite";

import {
  MAX_SESSION_SEARCH_BODY_BYTES,
  MAX_SESSION_SEARCH_LINKED_CONTEXT,
  type SessionSearchContextEntry,
  type SessionSearchEntry,
} from "../../domain/session-query.ts";
import type { Actor } from "../../domain/session.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const ACTORS = new Set<Actor>(["human", "model", "tool", "system", "unknown"]);

export interface SqliteSearchContext {
  readonly entries: readonly SessionSearchContextEntry[];
  readonly linkedContextTruncated: boolean;
}

export function readSearchContext(
  database: DatabaseSync,
  sessionId: number,
  primaryOrdinal: number,
  adjacentLimit: number,
): SqliteSearchContext {
  const adjacent = adjacentOrdinals(primaryOrdinal, adjacentLimit);
  const linked = readLinkedOrdinals(database, sessionId, primaryOrdinal);
  const linkedAdditions = linked.filter((ordinal) => !adjacent.has(ordinal));
  const selectedLinked = linkedAdditions.slice(0, MAX_SESSION_SEARCH_LINKED_CONTEXT);
  const selected = new Set([...adjacent, ...selectedLinked]);
  if (selected.size === 0) {
    return Object.freeze({
      entries: Object.freeze([]),
      linkedContextTruncated: linkedAdditions.length > MAX_SESSION_SEARCH_LINKED_CONTEXT,
    });
  }
  const linkedSet = new Set(linked);
  const entries = readContextEntries(database, sessionId, selected, adjacent, linkedSet);
  return Object.freeze({
    entries: Object.freeze(entries),
    linkedContextTruncated: linkedAdditions.length > MAX_SESSION_SEARCH_LINKED_CONTEXT,
  });
}

export function truncateUtf8(
  value: string,
  maximumBytes = MAX_SESSION_SEARCH_BODY_BYTES,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return { text: value, truncated: false };
  }
  let bytes = 0;
  let text = "";
  for (const character of value) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maximumBytes) break;
    text += character;
    bytes += next;
  }
  return { text, truncated: true };
}

export function truncateUtf8Around(
  value: string,
  anchor: number,
  maximumBytes = MAX_SESSION_SEARCH_BODY_BYTES,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) {
    return { text: value, truncated: false };
  }
  const boundary = codePointBoundary(value, anchor);
  const before = value.slice(0, boundary);
  const after = value.slice(boundary);
  const beforeBudget = Math.floor(maximumBytes / 4);
  const prefix = utf8Suffix(before, beforeBudget);
  const suffix = truncateUtf8(after, maximumBytes - Buffer.byteLength(prefix, "utf8")).text;
  return { text: prefix + suffix, truncated: true };
}

function codePointBoundary(value: string, candidate: number): number {
  const boundary = Math.max(0, Math.min(value.length, candidate));
  if (boundary === 0 || boundary === value.length) return boundary;
  const before = value.charCodeAt(boundary - 1);
  const after = value.charCodeAt(boundary);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
    ? boundary - 1
    : boundary;
}

function utf8Suffix(value: string, maximumBytes: number): string {
  let bytes = 0;
  const result: string[] = [];
  for (const character of [...value].reverse()) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > maximumBytes) break;
    result.push(character);
    bytes += next;
  }
  return result.reverse().join("");
}

function adjacentOrdinals(primaryOrdinal: number, limit: number): Set<number> {
  const result = new Set<number>();
  for (
    let ordinal = Math.max(0, primaryOrdinal - limit);
    ordinal <= primaryOrdinal + limit;
    ordinal += 1
  ) {
    if (ordinal !== primaryOrdinal) result.add(ordinal);
  }
  return result;
}

function readLinkedOrdinals(
  database: DatabaseSync,
  sessionId: number,
  primaryOrdinal: number,
): readonly number[] {
  const rows = database
    .prepare(
      `SELECT candidate.ordinal
       FROM sessions_entries AS primary_entry
       JOIN sessions_entries AS candidate
         ON candidate.session_id = primary_entry.session_id
        AND candidate.ordinal <> primary_entry.ordinal
       WHERE primary_entry.session_id = ?
         AND primary_entry.ordinal = ?
         AND (
           primary_entry.related_entry_ordinal = candidate.ordinal
           OR candidate.related_entry_ordinal = primary_entry.ordinal
         )
         AND (
           (primary_entry.kind = 'tool-call' AND candidate.kind = 'tool-result')
           OR
           (primary_entry.kind = 'tool-result' AND candidate.kind = 'tool-call')
         )
       ORDER BY candidate.ordinal
       LIMIT ?`,
    )
    // At most twenty adjacent entries can precede the twenty-one extras needed
    // to prove linked-context truncation.
    .all(
      sessionId,
      primaryOrdinal,
      MAX_SESSION_SEARCH_LINKED_CONTEXT * 2 + 1,
    ) as unknown as readonly {
    readonly ordinal: unknown;
  }[];
  return rows.map((row) => integerAt(row.ordinal));
}

function readContextEntries(
  database: DatabaseSync,
  sessionId: number,
  selected: ReadonlySet<number>,
  adjacent: ReadonlySet<number>,
  linked: ReadonlySet<number>,
): readonly SessionSearchContextEntry[] {
  const ordinals = [...selected].toSorted((left, right) => left - right);
  const placeholders = ordinals.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT entry.ordinal,
              entry.kind,
              entry.actor,
              entry.timestamp,
              entry.related_entry_ordinal,
              entry.tool_call_id,
              entry.tool_name,
              entry.tool_namespace,
              occurrence.segment_ordinal,
              content.text
       FROM sessions_entries AS entry
       LEFT JOIN sessions_content_occurrences AS occurrence
         ON occurrence.session_id = entry.session_id
        AND occurrence.entry_ordinal = entry.ordinal
       LEFT JOIN sessions_content_values AS content
         ON content.content_id = occurrence.content_id
       WHERE entry.session_id = ?
         AND entry.ordinal IN (${placeholders})
       ORDER BY entry.ordinal, occurrence.segment_ordinal`,
    )
    .all(sessionId, ...ordinals) as unknown as readonly ContextRow[];
  const grouped = new Map<number, { entry: SessionSearchEntry; body: string[] }>();
  for (const row of rows) {
    const ordinal = integerAt(row.ordinal);
    const current = grouped.get(ordinal) ?? { entry: entryAt(row), body: [] };
    if (row.text !== null) {
      if (typeof row.text !== "string" || !row.text.isWellFormed()) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      current.body.push(row.text);
    }
    grouped.set(ordinal, current);
  }
  return [...grouped.entries()].map(([ordinal, value]) => {
    const body = truncateUtf8(value.body.join("\n"));
    return Object.freeze({
      ...value.entry,
      body: body.text,
      bodyTruncated: body.truncated,
      adjacent: adjacent.has(ordinal),
      linked: linked.has(ordinal),
    });
  });
}

export function entryAt(row: EntryRow): SessionSearchEntry {
  const ordinal = integerAt(row.ordinal);
  if (typeof row.kind !== "string" || !row.kind.isWellFormed() || !ACTORS.has(row.actor)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const toolName = optionalString(row.tool_name);
  const toolNamespace = optionalString(row.tool_namespace);
  if (
    (row.kind !== "tool-call" && (toolName !== undefined || toolNamespace !== undefined)) ||
    (toolNamespace !== undefined && toolName === undefined)
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return Object.freeze({
    ordinal,
    kind: row.kind,
    actor: row.actor,
    ...optionalStringProperty("timestamp", row.timestamp),
    ...optionalIntegerProperty("relatedEntryOrdinal", row.related_entry_ordinal),
    ...optionalStringProperty("toolCallId", row.tool_call_id),
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolNamespace === undefined ? {} : { toolNamespace }),
  });
}

function optionalString(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return value;
}

function optionalStringProperty<const Key extends string>(
  key: Key,
  value: unknown,
): { readonly [Property in Key]?: string } {
  const normalized = optionalString(value);
  return normalized === undefined
    ? {}
    : ({ [key]: normalized } as { readonly [Property in Key]: string });
}

function optionalIntegerProperty<const Key extends string>(
  key: Key,
  value: unknown,
): { readonly [Property in Key]?: number } {
  return value === null
    ? {}
    : ({ [key]: integerAt(value) } as { readonly [Property in Key]: number });
}

function integerAt(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return number;
}

interface EntryRow {
  readonly ordinal: unknown;
  readonly kind: unknown;
  readonly actor: Actor;
  readonly timestamp: unknown;
  readonly related_entry_ordinal: unknown;
  readonly tool_call_id: unknown;
  readonly tool_name: unknown;
  readonly tool_namespace: unknown;
}

interface ContextRow extends EntryRow {
  readonly segment_ordinal: unknown;
  readonly text: unknown;
}
