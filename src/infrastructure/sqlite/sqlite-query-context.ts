import type { DatabaseSync } from "node:sqlite";

import {
  MAX_SESSION_SEARCH_BODY_BYTES,
  MAX_SESSION_SEARCH_LINKED_CONTEXT,
  type SessionSearchContextEntry,
  type SessionSearchEntry,
} from "../../domain/session-query.ts";
import { isCanonicalTimestamp } from "../../domain/canonical-timestamp.ts";
import type { Actor } from "../../domain/session.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const ACTORS = new Set<Actor>(["human", "model", "tool", "system", "unknown"]);
// Three parameters per coordinate keeps a chunk below SQLite's common 999-variable limit.
export const SQLITE_SEARCH_CONTEXT_COORDINATE_CHUNK_SIZE = 200;
// At most twenty adjacent entries can precede the twenty-one extras needed
// to prove linked-context truncation.
export const SQLITE_SEARCH_LINKED_CANDIDATE_LIMIT = MAX_SESSION_SEARCH_LINKED_CONTEXT * 2 + 1;

export interface SqliteSearchContext {
  readonly entries: readonly SessionSearchContextEntry[];
  readonly linkedContextTruncated: boolean;
}

export interface SqliteSearchContextCoordinate {
  readonly sessionId: number;
  readonly entryOrdinal: number;
}

export function readSearchContexts(
  database: DatabaseSync,
  primaries: readonly SqliteSearchContextCoordinate[],
  adjacentLimit: number,
): readonly SqliteSearchContext[] {
  if (primaries.length === 0) return Object.freeze([]);
  const uniquePrimaries = new Set(primaries.map(coordinateKey));
  if (uniquePrimaries.size !== primaries.length) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const linkedByPrimary = readLinkedOrdinals(database, primaries);
  const plans = primaries.map((primary, primaryIndex) => {
    const adjacent = adjacentOrdinals(primary.entryOrdinal, adjacentLimit);
    const linked = linkedByPrimary[primaryIndex];
    if (linked === undefined) throw new SqliteSessionIndexError("corrupt-data");
    const linkedAdditions = linked.filter((ordinal) => !adjacent.has(ordinal));
    return {
      primary,
      adjacent,
      linked: new Set(linked),
      selected: new Set([
        ...adjacent,
        ...linkedAdditions.slice(0, MAX_SESSION_SEARCH_LINKED_CONTEXT),
      ]),
      linkedContextTruncated: linkedAdditions.length > MAX_SESSION_SEARCH_LINKED_CONTEXT,
    };
  });
  const hydrated = readContextEntries(database, selectedContextCoordinates(plans));
  return Object.freeze(
    plans.map((plan) =>
      Object.freeze({
        entries: Object.freeze(
          [...plan.selected]
            .toSorted((left, right) => left - right)
            .flatMap((ordinal) => {
              const entry = hydrated.get(coordinateKeyOf(plan.primary.sessionId, ordinal));
              return entry === undefined
                ? []
                : [
                    Object.freeze({
                      ...entry,
                      adjacent: plan.adjacent.has(ordinal),
                      linked: plan.linked.has(ordinal),
                    }),
                  ];
            }),
        ),
        linkedContextTruncated: plan.linkedContextTruncated,
      }),
    ),
  );
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
  primaries: readonly SqliteSearchContextCoordinate[],
): readonly (readonly number[])[] {
  const selected = selectedPrimaryCte(primaries);
  const rows = database
    .prepare(sqliteLinkedContextDiscoverySql(primaries.length))
    .all(
      ...selected.parameters,
      SQLITE_SEARCH_LINKED_CANDIDATE_LIMIT,
    ) as unknown as readonly LinkedRow[];
  const result = primaries.map(() => [] as number[]);
  for (const row of rows) {
    const primaryIndex = integerAt(row.primary_index);
    const primary = primaries[primaryIndex];
    const linked = result[primaryIndex];
    if (
      primary === undefined ||
      linked === undefined ||
      integerAt(row.session_id) !== primary.sessionId ||
      integerAt(row.primary_ordinal) !== primary.entryOrdinal
    ) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    const ordinal = integerAt(row.candidate_ordinal);
    const previous = linked.at(-1);
    if (previous !== undefined && ordinal <= previous) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    linked.push(ordinal);
  }
  return result;
}

export function sqliteLinkedContextDiscoverySql(primaryCount: number): string {
  if (!Number.isSafeInteger(primaryCount) || primaryCount < 1) {
    throw new TypeError("Primary count must be a positive safe integer");
  }
  return `${selectedPrimaryCteSql(primaryCount)},
   linked_candidates (
     primary_index,
     session_id,
     primary_ordinal,
     candidate_ordinal,
     candidate_rank
   ) AS (
     SELECT selected.primary_index,
            selected.session_id,
            selected.primary_ordinal,
            -1,
            0
     FROM selected_primaries AS selected
     UNION ALL
     SELECT linked.primary_index,
            linked.session_id,
            linked.primary_ordinal,
            (
              SELECT candidate.ordinal
              FROM sessions_entries AS primary_entry
              JOIN sessions_entries AS candidate
                ON candidate.session_id = primary_entry.session_id
               AND candidate.ordinal > linked.candidate_ordinal
              WHERE primary_entry.session_id = linked.session_id
                AND primary_entry.ordinal = linked.primary_ordinal
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
              LIMIT 1
            ),
            linked.candidate_rank + 1
     FROM linked_candidates AS linked
     WHERE linked.candidate_rank < ?
       AND linked.candidate_ordinal IS NOT NULL
   )
   SELECT primary_index, session_id, primary_ordinal, candidate_ordinal
   FROM linked_candidates
   WHERE candidate_rank > 0
     AND candidate_ordinal IS NOT NULL
   ORDER BY primary_index, candidate_ordinal`;
}

function readContextEntries(
  database: DatabaseSync,
  coordinates: readonly SqliteSearchContextCoordinate[],
): ReadonlyMap<string, ContextEntryBody> {
  const result = new Map<string, ContextEntryBody>();
  for (
    let start = 0;
    start < coordinates.length;
    start += SQLITE_SEARCH_CONTEXT_COORDINATE_CHUNK_SIZE
  ) {
    const chunk = coordinates.slice(start, start + SQLITE_SEARCH_CONTEXT_COORDINATE_CHUNK_SIZE);
    const selected = selectedContextCte(chunk);
    const rows = database
      .prepare(
        `${selected.sql}
         SELECT selected.coordinate_index,
                selected.session_id AS selected_session_id,
                selected.entry_ordinal AS selected_entry_ordinal,
                entry.ordinal,
                entry.kind,
                entry.actor,
                entry.timestamp,
                entry.related_entry_ordinal,
                entry.tool_call_id,
                entry.tool_name,
                entry.tool_namespace,
                occurrence.segment_ordinal,
                content.text
         FROM selected_context AS selected
         JOIN sessions_entries AS entry
           ON entry.session_id = selected.session_id
          AND entry.ordinal = selected.entry_ordinal
         LEFT JOIN sessions_content_occurrences AS occurrence
           ON occurrence.session_id = entry.session_id
          AND occurrence.entry_ordinal = entry.ordinal
         LEFT JOIN sessions_content_values AS content
           ON content.content_id = occurrence.content_id
         ORDER BY selected.coordinate_index, occurrence.segment_ordinal`,
      )
      .all(...selected.parameters) as unknown as readonly ContextRow[];
    const grouped = new Map<number, { entry: SessionSearchEntry; body: string[] }>();
    for (const row of rows) {
      const coordinateIndex = integerAt(row.coordinate_index);
      const coordinate = chunk[coordinateIndex];
      if (
        coordinate === undefined ||
        integerAt(row.selected_session_id) !== coordinate.sessionId ||
        integerAt(row.selected_entry_ordinal) !== coordinate.entryOrdinal ||
        integerAt(row.ordinal) !== coordinate.entryOrdinal
      ) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      const current = grouped.get(coordinateIndex) ?? { entry: entryAt(row), body: [] };
      if (row.text !== null) {
        if (typeof row.text !== "string" || !row.text.isWellFormed()) {
          throw new SqliteSessionIndexError("corrupt-data");
        }
        current.body.push(row.text);
      }
      grouped.set(coordinateIndex, current);
    }
    for (const [coordinateIndex, value] of grouped) {
      const coordinate = chunk[coordinateIndex];
      if (coordinate === undefined) throw new SqliteSessionIndexError("corrupt-data");
      const body = truncateUtf8(value.body.join("\n"));
      const key = coordinateKey(coordinate);
      if (result.has(key)) throw new SqliteSessionIndexError("corrupt-data");
      result.set(
        key,
        Object.freeze({
          ...value.entry,
          body: body.text,
          bodyTruncated: body.truncated,
        }),
      );
    }
  }
  return result;
}

function selectedContextCoordinates(
  plans: readonly {
    readonly primary: SqliteSearchContextCoordinate;
    readonly selected: ReadonlySet<number>;
  }[],
): readonly SqliteSearchContextCoordinate[] {
  const byKey = new Map<string, SqliteSearchContextCoordinate>();
  for (const plan of plans) {
    for (const entryOrdinal of plan.selected) {
      const coordinate = { sessionId: plan.primary.sessionId, entryOrdinal };
      byKey.set(coordinateKey(coordinate), coordinate);
    }
  }
  return [...byKey.values()].toSorted(
    (left, right) => left.sessionId - right.sessionId || left.entryOrdinal - right.entryOrdinal,
  );
}

function selectedPrimaryCte(primaries: readonly SqliteSearchContextCoordinate[]): SelectedCte {
  return {
    sql: selectedPrimaryCteSql(primaries.length),
    parameters: primaries.flatMap((primary, primaryIndex) => [
      primaryIndex,
      primary.sessionId,
      primary.entryOrdinal,
    ]),
  };
}

function selectedPrimaryCteSql(primaryCount: number): string {
  return `WITH RECURSIVE selected_primaries(primary_index, session_id, primary_ordinal) AS (
    VALUES ${Array.from({ length: primaryCount }, () => "(?, ?, ?)").join(", ")}
  )`;
}

function selectedContextCte(coordinates: readonly SqliteSearchContextCoordinate[]): SelectedCte {
  return {
    sql: `WITH selected_context(coordinate_index, session_id, entry_ordinal) AS (
      VALUES ${coordinates.map(() => "(?, ?, ?)").join(", ")}
    )`,
    parameters: coordinates.flatMap((coordinate, coordinateIndex) => [
      coordinateIndex,
      coordinate.sessionId,
      coordinate.entryOrdinal,
    ]),
  };
}

function coordinateKey(coordinate: SqliteSearchContextCoordinate): string {
  return coordinateKeyOf(coordinate.sessionId, coordinate.entryOrdinal);
}

function coordinateKeyOf(sessionId: number, entryOrdinal: number): string {
  return `${String(sessionId)}:${String(entryOrdinal)}`;
}

export function entryAt(row: EntryRow): SessionSearchEntry {
  const ordinal = integerAt(row.ordinal);
  if (typeof row.kind !== "string" || !row.kind.isWellFormed() || !ACTORS.has(row.actor)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  const timestamp = optionalString(row.timestamp);
  const toolName = optionalString(row.tool_name);
  const toolNamespace = optionalString(row.tool_namespace);
  if (
    (timestamp !== undefined && !isCanonicalTimestamp(timestamp)) ||
    (row.kind !== "tool-call" && (toolName !== undefined || toolNamespace !== undefined)) ||
    (toolNamespace !== undefined && toolName === undefined)
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return Object.freeze({
    ordinal,
    kind: row.kind,
    actor: row.actor,
    ...(timestamp === undefined ? {} : { timestamp }),
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
  readonly coordinate_index: unknown;
  readonly selected_session_id: unknown;
  readonly selected_entry_ordinal: unknown;
  readonly segment_ordinal: unknown;
  readonly text: unknown;
}

interface LinkedRow {
  readonly primary_index: unknown;
  readonly session_id: unknown;
  readonly primary_ordinal: unknown;
  readonly candidate_ordinal: unknown;
}

type ContextEntryBody = Omit<SessionSearchContextEntry, "adjacent" | "linked">;

interface SelectedCte {
  readonly sql: string;
  readonly parameters: readonly number[];
}
