import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const CURSOR_VERSION_V1 = 1;
const CURSOR_VERSION_V2 = 2;
const MAX_CURSOR_BYTES = 2_048;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{32}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export type QueryCommand = "entries" | "list" | "search";

export interface QueryRevision {
  readonly libraryInstanceId: string;
  readonly writerGeneration: number;
}

export type QueryCursorAnchor =
  | {
      readonly kind: "list";
      readonly sessionId: number;
    }
  | {
      readonly kind: "entries";
      readonly sessionId: number;
      readonly entryOrdinal: number;
    };

export type CursorDecodeResult =
  | { readonly ok: true; readonly offset: number; readonly anchor?: QueryCursorAnchor }
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
      v: CURSOR_VERSION_V1,
      c: input.command,
      q: input.fingerprint,
      l: input.revision.libraryInstanceId,
      g: input.revision.writerGeneration,
      o: input.offset,
    }),
    "utf8",
  ).toString("base64url");
}

export function encodeAnchoredQueryCursor(
  input:
    | {
        readonly command: "list";
        readonly fingerprint: string;
        readonly revision: QueryRevision;
        readonly offset: number;
        readonly anchor: Extract<QueryCursorAnchor, { readonly kind: "list" }>;
      }
    | {
        readonly command: "entries";
        readonly fingerprint: string;
        readonly revision: QueryRevision;
        readonly offset: number;
        readonly anchor: Extract<QueryCursorAnchor, { readonly kind: "entries" }>;
      },
): string {
  assertAnchoredCommand(input.command);
  assertAnchorKind(input.anchor.kind);
  if (!FINGERPRINT_PATTERN.test(input.fingerprint))
    throw new TypeError("Invalid query fingerprint");
  assertRevision(input.revision);
  assertOffset(input.offset);
  assertOffset(input.anchor.sessionId);
  if (input.command !== input.anchor.kind) {
    throw new TypeError("Query cursor anchor does not match command");
  }
  if (input.command === "entries") {
    assertOffset(input.anchor.entryOrdinal);
  }

  const payload =
    input.command === "list"
      ? {
          v: CURSOR_VERSION_V2,
          c: input.command,
          q: input.fingerprint,
          l: input.revision.libraryInstanceId,
          g: input.revision.writerGeneration,
          o: input.offset,
          s: input.anchor.sessionId,
        }
      : {
          v: CURSOR_VERSION_V2,
          c: input.command,
          q: input.fingerprint,
          l: input.revision.libraryInstanceId,
          g: input.revision.writerGeneration,
          o: input.offset,
          s: input.anchor.sessionId,
          e: input.anchor.entryOrdinal,
        };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
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
  if (!isCursorPayloadV1(parsed) && !isCursorPayloadV2(parsed)) return invalid();
  if (parsed.c !== expected.command || parsed.q !== expected.fingerprint) {
    return { ok: false, reason: "mismatch" };
  }
  if (
    parsed.l !== expected.revision.libraryInstanceId ||
    parsed.g !== expected.revision.writerGeneration
  ) {
    return { ok: false, reason: "stale" };
  }
  if (parsed.v === CURSOR_VERSION_V1) {
    return { ok: true, offset: parsed.o };
  }
  return {
    ok: true,
    offset: parsed.o,
    anchor:
      parsed.c === "list"
        ? { kind: "list", sessionId: parsed.s }
        : {
            kind: "entries",
            sessionId: parsed.s,
            entryOrdinal: parsed.e,
          },
  };
}

function isCursorPayloadV1(value: unknown): value is CursorPayloadV1 {
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
    record.v === CURSOR_VERSION_V1 &&
    (record.c === "entries" || record.c === "list" || record.c === "search") &&
    typeof record.q === "string" &&
    FINGERPRINT_PATTERN.test(record.q) &&
    typeof record.l === "string" &&
    INSTANCE_ID_PATTERN.test(record.l) &&
    isSafeNonNegativeInteger(record.g) &&
    isSafeNonNegativeInteger(record.o)
  );
}

function isCursorPayloadV2(value: unknown): value is CursorPayloadV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.v !== CURSOR_VERSION_V2 || (record.c !== "entries" && record.c !== "list")) {
    return false;
  }
  const expectedKeys =
    record.c === "list"
      ? ["v", "c", "q", "l", "g", "o", "s"]
      : ["v", "c", "q", "l", "g", "o", "s", "e"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(record, key))
  ) {
    return false;
  }
  return (
    typeof record.q === "string" &&
    FINGERPRINT_PATTERN.test(record.q) &&
    typeof record.l === "string" &&
    INSTANCE_ID_PATTERN.test(record.l) &&
    isSafeNonNegativeInteger(record.g) &&
    isSafeNonNegativeInteger(record.o) &&
    isSafeNonNegativeInteger(record.s) &&
    (record.c === "list" || isSafeNonNegativeInteger(record.e))
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
  if (command !== "entries" && command !== "list" && command !== "search") {
    throw new TypeError("Invalid query command");
  }
}

function assertAnchoredCommand(command: string): asserts command is "entries" | "list" {
  if (command !== "entries" && command !== "list") {
    throw new TypeError("Invalid anchored query command");
  }
}

function assertAnchorKind(kind: string): asserts kind is QueryCursorAnchor["kind"] {
  if (kind !== "entries" && kind !== "list") {
    throw new TypeError("Invalid query cursor anchor kind");
  }
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

interface CursorPayloadV1 {
  readonly v: 1;
  readonly c: QueryCommand;
  readonly q: string;
  readonly l: string;
  readonly g: number;
  readonly o: number;
}

type CursorPayloadV2 =
  | {
      readonly v: 2;
      readonly c: "list";
      readonly q: string;
      readonly l: string;
      readonly g: number;
      readonly o: number;
      readonly s: number;
    }
  | {
      readonly v: 2;
      readonly c: "entries";
      readonly q: string;
      readonly l: string;
      readonly g: number;
      readonly o: number;
      readonly s: number;
      readonly e: number;
    };
