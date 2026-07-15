import {
  isSessionDocumentDigest,
  SESSION_DOCUMENT_DIGEST_SCHEME,
  type SessionDocumentDigest,
} from "../../domain/public-session-document.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const SHA_256_BYTE_LENGTH = 32;

export interface SqliteDocumentDigest {
  readonly scheme: typeof SESSION_DOCUMENT_DIGEST_SCHEME;
  readonly bytes: Uint8Array;
}

export function encodeSqliteDocumentDigest(value: unknown): SqliteDocumentDigest {
  if (!isSessionDocumentDigest(value)) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return {
    scheme: value.scheme,
    bytes: Buffer.from(value.digest, "hex"),
  };
}

export function decodeSqliteDocumentDigest(scheme: unknown, bytes: unknown): SessionDocumentDigest {
  if (
    scheme !== SESSION_DOCUMENT_DIGEST_SCHEME ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== SHA_256_BYTE_LENGTH
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return Object.freeze({
    scheme,
    digest: Buffer.from(bytes).toString("hex"),
  });
}
