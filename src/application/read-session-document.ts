import {
  SourceCaptureWorkspaceError,
  type DiscoveredSession,
  type SessionSource,
  type SourceCaptureWorkspace,
} from "./ports/session-source.ts";
import { isSourceFailureError, SourceFailureError } from "./source-failure.ts";
import {
  admitDiscoveredSession,
  admitSessionReplacement,
  isAdmittedDiscoveredSession,
  type AdmittedDiscoveredSession,
  type ValidatedSessionReplacement,
} from "./validate-session.ts";
import { snapshotPlainRecord } from "../domain/data-snapshot.ts";
import { isSessionIdentity } from "../domain/session-identity.ts";
import type { SessionDocument, SourceInstance } from "../domain/session.ts";

export async function readSessionDocument(
  source: SessionSource,
  candidate: DiscoveredSession | AdmittedDiscoveredSession,
  workspace: SourceCaptureWorkspace,
): Promise<SessionDocument> {
  return (await readSessionReplacement(source, candidate, workspace)).document;
}

export async function readSessionReplacement(
  source: SessionSource,
  candidate: DiscoveredSession | AdmittedDiscoveredSession,
  workspace: SourceCaptureWorkspace,
): Promise<ValidatedSessionReplacement> {
  const admission = isAdmittedDiscoveredSession(candidate)
    ? { ok: true as const, admitted: candidate }
    : admitDiscoveredSession(candidate);
  if (!admission.ok) {
    const sourceInstance = safeCandidateSource(candidate, source.kind);
    if (
      admission.issues.some(
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

  const { admitted } = admission;
  const { observation } = admitted;
  if (source.kind !== observation.identity.source.kind) {
    throw new SourceFailureError({
      kind: "malformed",
      source: observation.identity.source,
      reason: "candidate-kind-mismatch",
    });
  }

  let value: unknown;
  try {
    value = await source.read(admitted.candidate, workspace);
  } catch (error) {
    if (error instanceof SourceCaptureWorkspaceError) throw error;
    if (isSourceFailureError(error)) {
      if (sameSource(error.failure.source, observation.identity.source)) throw error;
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

function sameSource(left: SourceInstance, right: SourceInstance): boolean {
  return left.kind === right.kind && left.instanceId === right.instanceId;
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
