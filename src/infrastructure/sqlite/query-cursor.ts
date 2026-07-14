import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const CURSOR_VERSION = 1;
const MAX_CURSOR_BYTES = 2_048;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export type QueryCommand = "list" | "search";

export interface QueryRevision {
  readonly libraryInstanceId: string;
  readonly writerGeneration: number;
}

export type CursorDecodeResult =
  | { readonly ok: true; readonly offset: number }
  | { readonly ok: false; readonly reason: "invalid" | "mismatch" | "stale" };

export function readQueryRevision(database: DatabaseSync): QueryRevision {
  const row = database
    .prepare(
      `SELECT library.instance_id, lease.generation
       FROM sessions_library AS library
       CROSS JOIN sessions_writer_lease AS lease
       WHERE library.singleton = 1 AND lease.singleton = 1`,
    )
    .get() as { readonly instance_id?: unknown; readonly generation?: unknown } | undefined;
  if (
    row === undefined ||
    typeof row.instance_id !== "string" ||
    !INSTANCE_ID_PATTERN.test(row.instance_id)
  ) {
    throw new Error("SQLite query metadata is corrupt");
  }
  return {
    libraryInstanceId: row.instance_id,
    writerGeneration: safeInteger(row.generation),
  };
}

export function fingerprintQuery(value: string): string {
  return createHash("sha256")
    .update("sessions-query-v1\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function encodeQueryCursor(input: {
  readonly command: QueryCommand;
  readonly fingerprint: string;
  readonly revision: QueryRevision;
  readonly offset: number;
}): string {
  assertCommand(input.command);
  if (!FINGERPRINT_PATTERN.test(input.fingerprint))
    throw new TypeError("Invalid query fingerprint");
  assertRevision(input.revision);
  assertOffset(input.offset);
  return Buffer.from(
    JSON.stringify({
      v: CURSOR_VERSION,
      c: input.command,
      q: input.fingerprint,
      l: input.revision.libraryInstanceId,
      g: input.revision.writerGeneration,
      o: input.offset,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeQueryCursor(
  cursor: string,
  expected: {
    readonly command: QueryCommand;
    readonly fingerprint: string;
    readonly revision: QueryRevision;
  },
): CursorDecodeResult {
  if (
    typeof cursor !== "string" ||
    cursor.length === 0 ||
    Buffer.byteLength(cursor, "utf8") > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    return invalid();
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.length === 0 || decoded.length > MAX_CURSOR_BYTES) return invalid();
    // Node's decoder is permissive, so require canonical base64url representation.
    if (decoded.toString("base64url") !== cursor) return invalid();
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    return invalid();
  }
  if (!isCursorPayload(parsed)) return invalid();
  if (
    parsed.v !== CURSOR_VERSION ||
    parsed.c !== expected.command ||
    parsed.q !== expected.fingerprint
  ) {
    return { ok: false, reason: "mismatch" };
  }
  if (
    parsed.l !== expected.revision.libraryInstanceId ||
    parsed.g !== expected.revision.writerGeneration
  ) {
    return { ok: false, reason: "stale" };
  }
  return { ok: true, offset: parsed.o };
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 6 ||
    !Object.hasOwn(record, "v") ||
    !Object.hasOwn(record, "c") ||
    !Object.hasOwn(record, "q") ||
    !Object.hasOwn(record, "l") ||
    !Object.hasOwn(record, "g") ||
    !Object.hasOwn(record, "o")
  ) {
    return false;
  }
  return (
    record.v === CURSOR_VERSION &&
    (record.c === "list" || record.c === "search") &&
    typeof record.q === "string" &&
    FINGERPRINT_PATTERN.test(record.q) &&
    typeof record.l === "string" &&
    INSTANCE_ID_PATTERN.test(record.l) &&
    isSafeNonNegativeInteger(record.g) &&
    isSafeNonNegativeInteger(record.o)
  );
}

function assertRevision(revision: QueryRevision): void {
  if (
    !INSTANCE_ID_PATTERN.test(revision.libraryInstanceId) ||
    !isSafeNonNegativeInteger(revision.writerGeneration)
  ) {
    throw new TypeError("Invalid query revision");
  }
}

function assertCommand(command: string): asserts command is QueryCommand {
  if (command !== "list" && command !== "search") throw new TypeError("Invalid query command");
}

function assertOffset(value: number): void {
  if (!isSafeNonNegativeInteger(value)) throw new TypeError("Invalid query offset");
}

function safeInteger(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!isSafeNonNegativeInteger(number)) throw new Error("SQLite query metadata is corrupt");
  return number;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalid(): CursorDecodeResult {
  return { ok: false, reason: "invalid" };
}

interface CursorPayload {
  readonly v: 1;
  readonly c: QueryCommand;
  readonly q: string;
  readonly l: string;
  readonly g: number;
  readonly o: number;
}
