import { Buffer } from "node:buffer";

import {
  SourceCaptureWorkspaceError,
  type SelectedSessionSource,
  type SourceCaptureWorkspace,
} from "./ports/session-source.ts";
import { admitDiscoveredSession, type AdmittedDiscoveredSession } from "./validate-session.ts";

export type DiscoveryPreflight =
  | {
      readonly complete: true;
      readonly candidates: readonly AdmittedDiscoveredSession[];
    }
  | {
      readonly complete: false;
      readonly candidates: readonly [];
    };

/** Exhaust discovery before returning candidates that may cause repository writes. */
export async function discoverSessions(
  selection: SelectedSessionSource,
  workspace: SourceCaptureWorkspace,
): Promise<DiscoveryPreflight> {
  const candidates = new Map<string, AdmittedDiscoveredSession>();
  let complete = true;

  try {
    for await (const value of selection.adapter.discover(workspace)) {
      const result = admitDiscoveredSession(value);
      if (!result.ok || !belongsToSelection(result.admitted, selection)) {
        complete = false;
        continue;
      }

      const nativeId = result.admitted.observation.identity.nativeId;
      const previous = candidates.get(nativeId);
      if (previous === undefined) {
        candidates.set(nativeId, result.admitted);
      } else if (!sameCandidate(previous, result.admitted)) {
        complete = false;
      }
    }
  } catch (error) {
    if (error instanceof SourceCaptureWorkspaceError) throw error;
    complete = false;
  }

  if (!complete) {
    return Object.freeze({ complete: false, candidates: Object.freeze([]) as readonly [] });
  }
  return Object.freeze({
    complete: true,
    candidates: Object.freeze(
      [...candidates.values()].sort((left, right) =>
        compareBinaryStrings(
          left.observation.identity.nativeId,
          right.observation.identity.nativeId,
        ),
      ),
    ),
  });
}

export function compareBinaryStrings(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function belongsToSelection(
  candidate: AdmittedDiscoveredSession,
  selection: SelectedSessionSource,
): boolean {
  const source = candidate.observation.identity.source;
  return (
    source.kind === selection.instance.kind && source.instanceId === selection.instance.instanceId
  );
}

function sameCandidate(left: AdmittedDiscoveredSession, right: AdmittedDiscoveredSession): boolean {
  const leftCandidate = left.candidate;
  const rightCandidate = right.candidate;
  if (
    leftCandidate.identity.source.kind !== rightCandidate.identity.source.kind ||
    leftCandidate.identity.source.instanceId !== rightCandidate.identity.source.instanceId ||
    leftCandidate.identity.nativeId !== rightCandidate.identity.nativeId ||
    leftCandidate.adapterVersion !== rightCandidate.adapterVersion ||
    leftCandidate.aggregateFingerprint.scheme !== rightCandidate.aggregateFingerprint.scheme ||
    leftCandidate.aggregateFingerprint.digest !== rightCandidate.aggregateFingerprint.digest ||
    leftCandidate.inputs.length !== rightCandidate.inputs.length
  ) {
    return false;
  }

  return leftCandidate.inputs.every((input, index) => {
    const other = rightCandidate.inputs[index];
    return (
      other !== undefined &&
      input.role === other.role &&
      input.locator.uri === other.locator.uri &&
      input.locator.recordId === other.locator.recordId &&
      input.fingerprint === other.fingerprint
    );
  });
}
