import type { DiscoveredSession, SessionSource } from "./ports/session-source.ts";
import { verifySourceInputFingerprint } from "./source-input-fingerprint.ts";
import { isSourceFailureError, SourceFailureError } from "./source-failure.ts";
import { validateSessionDocument } from "../domain/session-validation.ts";
import type { SessionDocument } from "../domain/session.ts";

export async function readSessionDocument(
  source: SessionSource,
  candidate: DiscoveredSession,
): Promise<SessionDocument> {
  if (source.kind !== candidate.identity.source.kind) {
    throw new SourceFailureError({
      kind: "malformed",
      source: candidate.identity.source,
      reason: "candidate-kind-mismatch",
    });
  }

  if (!verifySourceInputFingerprint(candidate)) {
    throw new SourceFailureError({
      kind: "source-changed",
      source: candidate.identity.source,
    });
  }

  let value: unknown;
  try {
    value = await source.read(candidate);
  } catch (error) {
    if (isSourceFailureError(error)) {
      throw error;
    }

    throw new SourceFailureError(
      {
        kind: "malformed",
        source: candidate.identity.source,
        reason: "adapter-read-failed",
      },
      { cause: error },
    );
  }

  let result: ReturnType<typeof validateSessionDocument>;
  try {
    result = validateSessionDocument(value, { expectedIdentity: candidate.identity });
  } catch (error) {
    throw new SourceFailureError(
      {
        kind: "malformed",
        source: candidate.identity.source,
        reason: "invalid-session-document",
      },
      { cause: error },
    );
  }
  if (!result.ok) {
    const identityMismatch = result.issues.some((issue) => issue.code === "identity-mismatch");
    throw new SourceFailureError({
      kind: "malformed",
      source: candidate.identity.source,
      reason: identityMismatch ? "document-identity-mismatch" : "invalid-session-document",
      validation: { issues: result.issues, truncated: result.truncated },
    });
  }

  return result.document;
}
