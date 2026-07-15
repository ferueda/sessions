import { describe, expect, test } from "vitest";

import { CONTENT_HASH_SCHEME } from "../../src/domain/content-hash.ts";
import {
  decodeSqliteContentDigest,
  encodeSqliteContentDigest,
} from "../../src/infrastructure/sqlite/sqlite-content-digest.ts";

describe("SQLite content digest codec", () => {
  test("round-trips the fixed lowercase SHA-256 representation", () => {
    const digest = "0123456789abcdef".repeat(4);
    const encoded = encodeSqliteContentDigest(digest);

    expect(encoded).toBeInstanceOf(Uint8Array);
    expect(encoded.byteLength).toBe(32);
    expect(decodeSqliteContentDigest(encoded)).toEqual({
      scheme: CONTENT_HASH_SCHEME,
      digest,
    });
  });

  test.each(["", "a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`, 42, null])(
    "rejects a malformed domain digest %#",
    (digest) => {
      expect(() => encodeSqliteContentDigest(digest)).toThrowError(
        expect.objectContaining({ code: "corrupt-data" }),
      );
    },
  );

  test.each(["not-bytes", new ArrayBuffer(32), new Uint8Array(31), new Uint8Array(33)])(
    "rejects malformed stored bytes %#",
    (stored) => {
      expect(() => decodeSqliteContentDigest(stored)).toThrowError(
        expect.objectContaining({ code: "corrupt-data" }),
      );
    },
  );
});
