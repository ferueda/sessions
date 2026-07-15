import { CONTENT_HASH_SCHEME, type ContentHash } from "../../domain/content-hash.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const LOWERCASE_SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const SHA_256_BYTE_LENGTH = 32;

export function encodeSqliteContentDigest(value: unknown): Uint8Array {
  if (typeof value !== "string" || !LOWERCASE_SHA_256_PATTERN.test(value)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return Buffer.from(value, "hex");
}

export function decodeSqliteContentDigest(value: unknown): ContentHash {
  if (!(value instanceof Uint8Array) || value.byteLength !== SHA_256_BYTE_LENGTH) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return {
    scheme: CONTENT_HASH_SCHEME,
    digest: Buffer.from(value).toString("hex"),
  };
}
