import { describe, expect, test } from "vitest";

import { SESSION_DOCUMENT_DIGEST_SCHEME } from "../../src/domain/public-session-document.ts";
import {
  decodeSqliteDocumentDigest,
  encodeSqliteDocumentDigest,
} from "../../src/infrastructure/sqlite/sqlite-document-digest.ts";

describe("SQLite document digest codec", () => {
  test("round-trips the fixed scheme and lowercase SHA-256 representation", () => {
    const digest = "0123456789abcdef".repeat(4);
    const encoded = encodeSqliteDocumentDigest({
      scheme: SESSION_DOCUMENT_DIGEST_SCHEME,
      digest,
    });

    expect(encoded.scheme).toBe(SESSION_DOCUMENT_DIGEST_SCHEME);
    expect(encoded.bytes).toBeInstanceOf(Uint8Array);
    expect(encoded.bytes.byteLength).toBe(32);
    expect(decodeSqliteDocumentDigest(encoded.scheme, encoded.bytes)).toEqual({
      scheme: SESSION_DOCUMENT_DIGEST_SCHEME,
      digest,
    });
  });

  test.each([
    null,
    {},
    { scheme: "unknown", digest: "a".repeat(64) },
    { scheme: SESSION_DOCUMENT_DIGEST_SCHEME, digest: "A".repeat(64) },
    { scheme: SESSION_DOCUMENT_DIGEST_SCHEME, digest: "a".repeat(63) },
  ])("rejects malformed domain digest %#", (digest) => {
    expect(() => encodeSqliteDocumentDigest(digest)).toThrowError(
      expect.objectContaining({ code: "corrupt-data" }),
    );
  });

  test.each([
    ["unknown", new Uint8Array(32)],
    [SESSION_DOCUMENT_DIGEST_SCHEME, "not-bytes"],
    [SESSION_DOCUMENT_DIGEST_SCHEME, new ArrayBuffer(32)],
    [SESSION_DOCUMENT_DIGEST_SCHEME, new Uint8Array(31)],
    [SESSION_DOCUMENT_DIGEST_SCHEME, new Uint8Array(33)],
  ])("rejects malformed stored digest %#", (scheme, bytes) => {
    expect(() => decodeSqliteDocumentDigest(scheme, bytes)).toThrowError(
      expect.objectContaining({ code: "corrupt-data" }),
    );
  });
});
