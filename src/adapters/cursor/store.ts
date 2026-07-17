import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";

import {
  decodeUtf8,
  exactRecord,
  optionalString,
  parseJsonText,
  requiredBoolean,
  requiredNonnegativeSafeInteger,
  requiredString,
} from "./format-fields.ts";
import {
  CursorFormatError,
  malformedCursorFormat,
  unsupportedCursorFormat,
} from "./format-error.ts";
import { parseCursorRootBlobIds } from "./wire-root.ts";

const BLOB_ID = /^[a-f0-9]{64}$/u;
const HEX_TEXT = /^(?:[a-f0-9]{2})+$/u;
const STORE_META_REQUIRED = new Set([
  "agentId",
  "createdAt",
  "isRunEverything",
  "latestRootBlobId",
  "mode",
  "name",
]);
const STORE_META_OPTIONAL = new Set(["lastUsedModel"]);

export type CursorStoreSelection =
  | {
      readonly family: "chat-store-v1";
      readonly nativeId: string;
    }
  | {
      readonly family: "agent-checkpoint-store-v1";
      readonly nativeId: string;
      readonly rootBlobId: string;
    };

export interface CursorStoreMetadata {
  readonly agentId: string;
  readonly createdAt: number;
  readonly isRunEverything: boolean;
  readonly latestRootBlobId: string;
  readonly mode: string;
  readonly name: string;
  readonly lastUsedModel?: string;
}

export interface CursorStoredMessage {
  readonly rootOrdinal: number;
  readonly value: unknown;
}

export interface CursorMaterializedStore {
  readonly metadata: CursorStoreMetadata;
  readonly rootBlobId: string;
  readonly messages: readonly CursorStoredMessage[];
}

/**
 * Reads only the selected root and its ordered message blobs from a private
 * SQLite snapshot. Unreferenced blobs remain outside the canonical session.
 */
export function materializeCursorStore(
  database: DatabaseSync,
  selection: CursorStoreSelection,
): CursorMaterializedStore {
  try {
    validateStoreSchema(database);
    validateNativeId(selection.nativeId);
    const metadata = readStoreMetadata(database);
    if (metadata.agentId !== selection.nativeId) malformedCursorFormat();

    const rootBlobId =
      selection.family === "chat-store-v1"
        ? validateBlobId(metadata.latestRootBlobId)
        : validateBlobId(selection.rootBlobId);
    const root = readBlob(database, rootBlobId);
    const messageBlobIds = parseCursorRootBlobIds(root);
    const messages = messageBlobIds.map((blobId, rootOrdinal) =>
      Object.freeze({
        rootOrdinal,
        value: parseJsonText(decodeUtf8(readBlob(database, blobId))),
      }),
    );

    return Object.freeze({
      metadata,
      rootBlobId,
      messages: Object.freeze(messages),
    });
  } catch (error) {
    if (error instanceof CursorFormatError) throw error;
    malformedCursorFormat(error);
  }
}

function validateStoreSchema(database: DatabaseSync): void {
  const objects = database
    .prepare(
      `SELECT name, type
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY name COLLATE BINARY`,
    )
    .all() as readonly { readonly name?: unknown; readonly type?: unknown }[];
  if (
    objects.length !== 2 ||
    objects[0]?.name !== "blobs" ||
    objects[0]?.type !== "table" ||
    objects[1]?.name !== "meta" ||
    objects[1]?.type !== "table"
  ) {
    unsupportedCursorFormat();
  }

  validateTable(database, "blobs", [
    { name: "id", type: "TEXT", primaryKey: 1 },
    { name: "data", type: "BLOB", primaryKey: 0 },
  ]);
  validateTable(database, "meta", [
    { name: "key", type: "TEXT", primaryKey: 1 },
    { name: "value", type: "TEXT", primaryKey: 0 },
  ]);
}

function validateTable(
  database: DatabaseSync,
  table: "blobs" | "meta",
  expected: readonly {
    readonly name: string;
    readonly type: string;
    readonly primaryKey: number;
  }[],
): void {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as readonly {
    readonly cid?: unknown;
    readonly name?: unknown;
    readonly type?: unknown;
    readonly notnull?: unknown;
    readonly dflt_value?: unknown;
    readonly pk?: unknown;
  }[];
  if (rows.length !== expected.length) unsupportedCursorFormat();
  for (const [index, shape] of expected.entries()) {
    const row = rows[index];
    if (
      row?.cid !== index ||
      row.name !== shape.name ||
      row.type !== shape.type ||
      row.notnull !== 0 ||
      row.dflt_value !== null ||
      row.pk !== shape.primaryKey
    ) {
      unsupportedCursorFormat();
    }
  }

  const indexes = database.prepare(`PRAGMA index_list("${table}")`).all() as readonly {
    readonly unique?: unknown;
    readonly origin?: unknown;
    readonly partial?: unknown;
  }[];
  if (
    indexes.length !== 1 ||
    indexes[0]?.unique !== 1 ||
    indexes[0]?.origin !== "pk" ||
    indexes[0]?.partial !== 0
  ) {
    unsupportedCursorFormat();
  }
}

function readStoreMetadata(database: DatabaseSync): CursorStoreMetadata {
  const rows = database
    .prepare(`SELECT key, value FROM meta ORDER BY key COLLATE BINARY`)
    .all() as readonly { readonly key?: unknown; readonly value?: unknown }[];
  if (rows.length !== 1 || rows[0]?.key !== "0") unsupportedCursorFormat();
  const encoded = rows[0]?.value;
  if (typeof encoded !== "string" || !HEX_TEXT.test(encoded)) malformedCursorFormat();

  const record = exactRecord(
    parseJsonText(decodeUtf8(Buffer.from(encoded, "hex"))),
    STORE_META_REQUIRED,
    STORE_META_OPTIONAL,
  );
  const metadata = {
    agentId: requiredString(record, "agentId", true),
    createdAt: requiredNonnegativeSafeInteger(record, "createdAt"),
    isRunEverything: requiredBoolean(record, "isRunEverything"),
    latestRootBlobId: requiredString(record, "latestRootBlobId"),
    mode: requiredString(record, "mode"),
    name: requiredString(record, "name"),
    ...optionalField(optionalString(record, "lastUsedModel"), "lastUsedModel"),
  } satisfies CursorStoreMetadata;
  return Object.freeze(metadata);
}

function readBlob(database: DatabaseSync, id: string): Uint8Array {
  const row = database.prepare(`SELECT data FROM blobs WHERE id = ?`).get(id) as
    | { readonly data?: unknown }
    | undefined;
  if (row === undefined || !(row.data instanceof Uint8Array)) malformedCursorFormat();
  return row.data;
}

function validateNativeId(value: string): void {
  if (value.length === 0 || !value.isWellFormed()) malformedCursorFormat();
}

function validateBlobId(value: string): string {
  if (!BLOB_ID.test(value)) malformedCursorFormat();
  return value;
}

function optionalField<Key extends string>(
  value: string | undefined,
  key: Key,
): {} | { readonly [Property in Key]: string } {
  return value === undefined ? {} : ({ [key]: value } as { readonly [Property in Key]: string });
}
