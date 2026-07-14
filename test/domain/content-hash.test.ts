import { describe, expect, it } from "vitest";

import {
  CONTENT_HASH_SCHEME,
  contentHashMatches,
  hashContent,
  isContentHash,
  sameHashedContent,
} from "../../src/domain/content-hash.ts";

describe("content hashing", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("matches the published SHA-256 vector for %j", (text, digest) => {
    expect(hashContent(text)).toEqual({ scheme: CONTENT_HASH_SCHEME, digest });
  });

  it("hashes exact UTF-8 text without trimming or rewriting", () => {
    expect(hashContent("text")).not.toEqual(hashContent("text\n"));
    expect(hashContent("text")).not.toEqual(hashContent(" text"));
    expect(hashContent("\u00e9")).not.toEqual(hashContent("e\u0301"));
  });

  it("rejects ill-formed Unicode", () => {
    expect(() => hashContent("before\ud800after")).toThrow(TypeError);
    expect(contentHashMatches("\udfff", hashContent("valid"))).toBe(false);
  });

  it("recognizes only the canonical structured hash", () => {
    const valid = hashContent("valid");

    expect(isContentHash(valid)).toBe(true);
    expect(isContentHash({ ...valid, extra: true })).toBe(false);
    expect(isContentHash({ ...valid, digest: valid.digest.toUpperCase() })).toBe(false);
    expect(isContentHash({ scheme: "sha256", digest: valid.digest })).toBe(false);
  });

  it("detects hash mismatches", () => {
    const contentHash = hashContent("expected");

    expect(contentHashMatches("expected", contentHash)).toBe(true);
    expect(contentHashMatches("different", contentHash)).toBe(false);
  });

  it("never equates unequal text with a forged identical digest", () => {
    const forgedHash = hashContent("left");

    expect(
      sameHashedContent(
        { text: "left", contentHash: forgedHash },
        { text: "right", contentHash: forgedHash },
      ),
    ).toBe(false);
  });

  it("rejects equal text carrying a forged hash", () => {
    const forgedHash = hashContent("other");

    expect(
      sameHashedContent(
        { text: "same", contentHash: forgedHash },
        { text: "same", contentHash: forgedHash },
      ),
    ).toBe(false);
  });
});
