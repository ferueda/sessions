import type { DiscoveredSession, SessionSource } from "./ports/session-source.ts";
import { isSourceFailureError, SourceFailureError } from "./source-failure.ts";
import {
  admitSessionObservation,
  admitSessionReplacement,
  type ValidatedSessionReplacement,
} from "./validate-session.ts";
import { snapshotPlainRecord } from "../domain/data-snapshot.ts";
import { isSessionIdentity } from "../domain/session-identity.ts";
import type { SessionDocument, SourceInstance } from "../domain/session.ts";

export async function readSessionDocument(
  source: SessionSource,
  candidate: DiscoveredSession,
): Promise<SessionDocument> {
  return (await readSessionReplacement(source, candidate)).document;
}

export async function readSessionReplacement(
  source: SessionSource,
  candidate: DiscoveredSession,
): Promise<ValidatedSessionReplacement> {
  const admittedObservation = admitSessionObservation(candidate);
  if (!admittedObservation.ok) {
    const sourceInstance = safeCandidateSource(candidate, source.kind);
    if (
      admittedObservation.issues.some(
        ({ code }) =>
          code === "invalid-aggregate-fingerprint" ||
          code === "invalid-input" ||
          code === "invalid-inputs",
      )
    ) {
      throw new SourceFailureError({ kind: "source-changed", source: sourceInstance });
    }
    throw new SourceFailureError({ kind: "malformed", source: sourceInstance });
  }

  const { observation } = admittedObservation;
  if (source.kind !== observation.identity.source.kind) {
    throw new SourceFailureError({
      kind: "malformed",
      source: observation.identity.source,
      reason: "candidate-kind-mismatch",
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
        source: observation.identity.source,
        reason: "adapter-read-failed",
      },
      { cause: error },
    );
  }

  let result: ReturnType<typeof admitSessionReplacement>;
  try {
    result = admitSessionReplacement(observation, value);
  } catch (error) {
    throw new SourceFailureError(
      {
        kind: "malformed",
        source: observation.identity.source,
        reason: "invalid-session-document",
      },
      { cause: error },
    );
  }
  if (!result.ok) {
    const identityMismatch = result.issues.some((issue) => issue.code === "identity-mismatch");
    throw new SourceFailureError({
      kind: "malformed",
      source: observation.identity.source,
      reason: identityMismatch ? "document-identity-mismatch" : "invalid-session-document",
      validation: { issues: result.issues, truncated: result.truncated },
    });
  }

  return result.replacement;
}

function safeCandidateSource(candidate: unknown, fallbackKind: string): SourceInstance {
  const root = snapshotPlainRecord(candidate);
  if (root.ok) {
    const identity = snapshotPlainRecord(root.record.identity);
    if (identity.ok) {
      const source = snapshotPlainRecord(identity.record.source);
      const snapshot = {
        source: source.ok
          ? { kind: source.record.kind, instanceId: source.record.instanceId }
          : undefined,
        nativeId: identity.record.nativeId,
      };
      if (isSessionIdentity(snapshot)) return snapshot.source;
    }
  }
  return { kind: fallbackKind, instanceId: "unknown" };
}
