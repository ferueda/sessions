import { SessionLibraryError } from "./library-error.ts";
import type { IndexedSession } from "./ports/session-index.ts";
import {
  isSessionDocumentDigest,
  sameSessionDocumentDigest,
  type SessionDocumentDigest,
} from "../domain/public-session-document.ts";

export function admitExpectedDocumentDigest(value: unknown): SessionDocumentDigest | undefined {
  if (value === undefined) return undefined;
  if (!isSessionDocumentDigest(value)) {
    throw new TypeError("Expected document digest is invalid");
  }
  return Object.freeze({ scheme: value.scheme, digest: value.digest });
}

export function requireExpectedSession(
  indexed: IndexedSession | undefined,
  expectedDocumentDigest: SessionDocumentDigest | undefined,
): IndexedSession {
  if (indexed === undefined) throw new SessionLibraryError("session-not-found");
  if (
    expectedDocumentDigest !== undefined &&
    !sameSessionDocumentDigest(indexed.summary.documentDigest, expectedDocumentDigest)
  ) {
    throw new SessionLibraryError("document-digest-mismatch");
  }
  return indexed;
}
