import { createHash } from "node:crypto";

export const CONTENT_HASH_SCHEME = "sha256-utf8-v1" as const;

export interface ContentHash {
  readonly scheme: typeof CONTENT_HASH_SCHEME;
  readonly digest: string;
}

export interface HashedContent {
  readonly text: string;
  readonly contentHash: ContentHash;
}

const SHA_256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function isExactHashShape(value: object): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === 2 && keys.includes("scheme") && keys.includes("digest");
}

export function isContentHash(value: unknown): value is ContentHash {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isExactHashShape(value) &&
    "scheme" in value &&
    value.scheme === CONTENT_HASH_SCHEME &&
    "digest" in value &&
    typeof value.digest === "string" &&
    SHA_256_DIGEST_PATTERN.test(value.digest)
  );
}

export function hashContent(text: string): ContentHash {
  if (typeof text !== "string" || !text.isWellFormed()) {
    throw new TypeError("Content must be a well-formed Unicode string");
  }

  return {
    scheme: CONTENT_HASH_SCHEME,
    digest: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

export function contentHashMatches(text: string, contentHash: unknown): boolean {
  if (typeof text !== "string" || !text.isWellFormed() || !isContentHash(contentHash)) {
    return false;
  }

  const expected = hashContent(text);
  return contentHash.scheme === expected.scheme && contentHash.digest === expected.digest;
}

export function sameHashedContent(left: HashedContent, right: HashedContent): boolean {
  return (
    left.text === right.text &&
    left.contentHash.scheme === right.contentHash.scheme &&
    left.contentHash.digest === right.contentHash.digest &&
    contentHashMatches(left.text, left.contentHash) &&
    contentHashMatches(right.text, right.contentHash)
  );
}
