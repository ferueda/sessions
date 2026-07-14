import type {
  DiscoveredSession,
  SelectedSessionSource,
  SessionSource,
  SourceDiscoveryWorkspace,
  SourceProbe,
} from "../../src/application/ports/session-source.ts";
import { SourceFailureError, type SourceFailure } from "../../src/application/source-failure.ts";
import { createDiscoveredSession } from "../../src/application/source-input-fingerprint.ts";
import { selectSessionSource } from "../../src/application/validate-session.ts";
import type { SessionDocument, SourceInstance } from "../../src/domain/session.ts";

export interface FakeIndexingSource {
  readonly instance: SourceInstance;
  readonly adapter: SessionSource;
  readonly selected: SelectedSessionSource;
  readonly readNativeIds: readonly string[];
  readonly discoveryWorkspaces: readonly SourceDiscoveryWorkspace[];
  candidate(nativeId: string, revision?: string, adapterVersion?: string): DiscoveredSession;
  setDiscovery(candidates: readonly DiscoveredSession[]): void;
  failDiscovery(error: unknown, afterCandidates?: number): void;
  setProbe(probe: SourceProbe): void;
  failProbe(error: unknown): void;
  setDocument(nativeId: string, document: SessionDocument): void;
  failRead(nativeId: string, kind: SourceFailure["kind"]): void;
  clearReadFailure(nativeId: string): void;
}

export function createFakeIndexingSource(
  instance: SourceInstance = { kind: "synthetic", instanceId: "default" },
): FakeIndexingSource {
  let candidates: readonly DiscoveredSession[] = [];
  let discoveryFailure: { readonly error: unknown; readonly after: number } | undefined;
  let probe: SourceProbe = readyProbe(instance);
  let probeFailure: unknown;
  let hasProbeFailure = false;
  const documents = new Map<string, SessionDocument>();
  const readFailures = new Map<string, SourceFailure["kind"]>();
  const readNativeIds: string[] = [];
  const discoveryWorkspaces: SourceDiscoveryWorkspace[] = [];

  const adapter: SessionSource = {
    kind: instance.kind,
    async probe() {
      if (hasProbeFailure) throw probeFailure;
      return probe;
    },
    async *discover(workspace) {
      discoveryWorkspaces.push(workspace);
      for (const [index, candidate] of candidates.entries()) {
        if (discoveryFailure !== undefined && index === discoveryFailure.after) {
          throw discoveryFailure.error;
        }
        yield candidate;
      }
      if (discoveryFailure !== undefined && discoveryFailure.after >= candidates.length) {
        throw discoveryFailure.error;
      }
    },
    async read(candidate) {
      readNativeIds.push(candidate.identity.nativeId);
      const failure = readFailures.get(candidate.identity.nativeId);
      if (failure !== undefined) {
        throw new SourceFailureError({ kind: failure, source: instance } as SourceFailure);
      }
      return documents.get(candidate.identity.nativeId) ?? minimalDocument(candidate);
    },
  };

  const selected = selectSessionSource(instance, adapter);
  return {
    instance: selected.instance,
    adapter,
    selected,
    readNativeIds,
    discoveryWorkspaces,
    candidate(nativeId, revision = "revision-1", adapterVersion = "synthetic-v1") {
      return createDiscoveredSession({
        identity: { source: instance, nativeId },
        inputs: [
          {
            role: "transcript",
            locator: { uri: `memory://sessions/${encodeURIComponent(nativeId)}` },
            fingerprint: revision,
          },
        ],
        adapterVersion,
      });
    },
    setDiscovery(value) {
      candidates = [...value];
      discoveryFailure = undefined;
    },
    failDiscovery(error, afterCandidates = 0) {
      discoveryFailure = { error, after: afterCandidates };
    },
    setProbe(value) {
      probe = value;
      hasProbeFailure = false;
    },
    failProbe(error) {
      hasProbeFailure = true;
      probeFailure = error;
    },
    setDocument(nativeId, document) {
      documents.set(nativeId, document);
    },
    failRead(nativeId, kind) {
      readFailures.set(nativeId, kind);
    },
    clearReadFailure(nativeId) {
      readFailures.delete(nativeId);
    },
  };
}

function readyProbe(source: SourceInstance): SourceProbe {
  return {
    source,
    status: "ready",
    locations: [{ role: "root", locator: { uri: "memory://sessions" } }],
    summary: "Synthetic source is ready",
  };
}

function minimalDocument(candidate: DiscoveredSession): SessionDocument {
  return {
    identity: candidate.identity,
    lineageCoverage: "unknown",
    relations: [],
    entries: [],
  };
}
