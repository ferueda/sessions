import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";

import type { CursorStoreMetadata } from "../../../src/adapters/cursor/store.ts";

export const ROOT_BLOB_ID = "10".repeat(32);

export function createCursorStoreDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB);
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
  `);
  insertStoreMetadata(database, {
    agentId: "generic-session",
    createdAt: 1_700_000_000_000,
    isRunEverything: false,
    latestRootBlobId: ROOT_BLOB_ID,
    mode: "agent",
    name: "Generic session",
  });
  return database;
}

export function insertStoreMetadata(
  database: DatabaseSync,
  metadata: CursorStoreMetadata | Readonly<Record<string, unknown>>,
): void {
  const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("hex");
  database.prepare(`INSERT INTO meta(key, value) VALUES ('0', ?)`).run(encoded);
}

export function replaceStoreMetadata(
  database: DatabaseSync,
  metadata: CursorStoreMetadata | Readonly<Record<string, unknown>>,
): void {
  database.exec(`DELETE FROM meta`);
  insertStoreMetadata(database, metadata);
}

export function insertBlob(database: DatabaseSync, id: string, data: Uint8Array | string): void {
  database
    .prepare(`INSERT INTO blobs(id, data) VALUES (?, ?)`)
    .run(id, typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

export function messageBlobId(index: number): string {
  return index.toString(16).padStart(2, "0").repeat(32);
}

export function encodeRoot(fields: readonly RootField[]): Uint8Array {
  return Buffer.concat(
    fields.map((field) =>
      field.wire === 0
        ? Buffer.from([...encodeVarint((field.number << 3) | 0), ...encodeVarint(field.value)])
        : Buffer.from([
            ...encodeVarint((field.number << 3) | 2),
            ...encodeVarint(field.value.byteLength),
            ...field.value,
          ]),
    ),
  );
}

export type RootField =
  | {
      readonly number: number;
      readonly wire: 0;
      readonly value: number;
    }
  | {
      readonly number: number;
      readonly wire: 2;
      readonly value: Uint8Array;
    };

function encodeVarint(input: number): readonly number[] {
  let value = input;
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(value === 0 ? next : next | 0x80);
  } while (value !== 0);
  return bytes;
}
