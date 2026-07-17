import type {
  DiscoveredSession,
  SelectedSessionSource,
  SessionSource,
  SourceCaptureWorkspace,
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
  readonly probeCount: number;
  readonly readNativeIds: readonly string[];
  readonly readCandidates: readonly DiscoveredSession[];
  readonly discoveryWorkspaces: readonly SourceCaptureWorkspace[];
  readonly readWorkspaces: readonly SourceCaptureWorkspace[];
  candidate(nativeId: string, revision?: string, adapterVersion?: string): DiscoveredSession;
  setDiscovery(candidates: readonly DiscoveredSession[]): void;
  queueDiscoveries(...generations: readonly FakeDiscoveryGeneration[]): void;
  failDiscovery(error: unknown, afterCandidates?: number): void;
  setProbe(probe: SourceProbe): void;
  failProbe(error: unknown): void;
  setDocument(nativeId: string, document: SessionDocument): void;
  failRead(nativeId: string, kind: SourceFailure["kind"]): void;
  failNextRead(nativeId: string, kind: SourceFailure["kind"]): void;
  clearReadFailure(nativeId: string): void;
}

export interface FakeDiscoveryGeneration {
  readonly candidates: readonly DiscoveredSession[];
  readonly failure?: {
    readonly error: unknown;
    readonly afterCandidates?: number;
  };
}

export function createFakeIndexingSource(
  instance: SourceInstance = { kind: "synthetic", instanceId: "default" },
): FakeIndexingSource {
  let candidates: readonly DiscoveredSession[] = [];
  let discoveryFailure: { readonly error: unknown; readonly after: number } | undefined;
  const queuedDiscoveries: Array<{
    readonly candidates: readonly DiscoveredSession[];
    readonly failure?: { readonly error: unknown; readonly after: number };
  }> = [];
  let probe: SourceProbe = readyProbe(instance);
  let probeFailure: unknown;
  let hasProbeFailure = false;
  let probeCount = 0;
  const documents = new Map<string, SessionDocument>();
  const readFailures = new Map<string, SourceFailure["kind"]>();
  const queuedReadFailures = new Map<string, SourceFailure["kind"][]>();
  const readNativeIds: string[] = [];
  const readCandidates: DiscoveredSession[] = [];
  const discoveryWorkspaces: SourceCaptureWorkspace[] = [];
  const readWorkspaces: SourceCaptureWorkspace[] = [];

  const adapter: SessionSource = {
    kind: instance.kind,
    async probe() {
      probeCount += 1;
      if (hasProbeFailure) throw probeFailure;
      return probe;
    },
    async *discover(workspace) {
      discoveryWorkspaces.push(workspace);
      const queued = queuedDiscoveries.shift();
      const generationCandidates = queued?.candidates ?? candidates;
      const generationFailure = queued === undefined ? discoveryFailure : queued.failure;
      for (const [index, candidate] of generationCandidates.entries()) {
        if (generationFailure !== undefined && index === generationFailure.after) {
          throw generationFailure.error;
        }
        yield candidate;
      }
      if (
        generationFailure !== undefined &&
        generationFailure.after >= generationCandidates.length
      ) {
        throw generationFailure.error;
      }
    },
    async read(candidate, workspace) {
      readNativeIds.push(candidate.identity.nativeId);
      readCandidates.push(candidate);
      readWorkspaces.push(workspace);
      const queuedFailures = queuedReadFailures.get(candidate.identity.nativeId);
      const queuedFailure = queuedFailures?.shift();
      if (queuedFailures?.length === 0) queuedReadFailures.delete(candidate.identity.nativeId);
      const failure = queuedFailure ?? readFailures.get(candidate.identity.nativeId);
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
    get probeCount() {
      return probeCount;
    },
    readNativeIds,
    readCandidates,
    discoveryWorkspaces,
    readWorkspaces,
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
      queuedDiscoveries.length = 0;
    },
    queueDiscoveries(...generations) {
      queuedDiscoveries.push(
        ...generations.map((generation) => ({
          candidates: [...generation.candidates],
          ...(generation.failure === undefined
            ? {}
            : {
                failure: {
                  error: generation.failure.error,
                  after: generation.failure.afterCandidates ?? 0,
                },
              }),
        })),
      );
    },
    failDiscovery(error, afterCandidates = 0) {
      discoveryFailure = { error, after: afterCandidates };
      queuedDiscoveries.length = 0;
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
    failNextRead(nativeId, kind) {
      const failures = queuedReadFailures.get(nativeId) ?? [];
      failures.push(kind);
      queuedReadFailures.set(nativeId, failures);
    },
    clearReadFailure(nativeId) {
      readFailures.delete(nativeId);
      queuedReadFailures.delete(nativeId);
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
