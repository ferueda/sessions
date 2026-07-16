import { performance } from "node:perf_hooks";

import {
  createSessionRootResolver,
  type SessionLineageEvidence,
  type SessionRootResolution,
} from "../src/domain/session-lineage.ts";
import type { SessionIdentity } from "../src/domain/session.ts";

const CORPUS_SIZE = 2_000;

const retained = Array.from({ length: CORPUS_SIZE }, (_, index) => evidence(index));
resolveQueryScoped(retained.slice(0, 25), retained.slice(0, 25));

const rebuilt = measure(() => resolveWithRebuild(retained));
const queryScoped = measure(() => resolveQueryScoped(retained, retained));
if (JSON.stringify(rebuilt.value) !== JSON.stringify(queryScoped.value)) {
  throw new Error("Lineage measurement strategies returned different results");
}

process.stdout.write(
  `${JSON.stringify({
    corpusSessions: CORPUS_SIZE,
    rebuildPerResolutionMs: rounded(rebuilt.elapsedMs),
    queryScopedMs: rounded(queryScoped.elapsedMs),
    speedup: rounded(rebuilt.elapsedMs / queryScoped.elapsedMs),
  })}\n`,
);

function resolveWithRebuild(
  sessions: readonly SessionLineageEvidence[],
): readonly SessionRootResolution[] {
  return sessions.map(({ identity }) => createSessionRootResolver(sessions)(identity));
}

function resolveQueryScoped(
  starts: readonly SessionLineageEvidence[],
  retainedSessions: readonly SessionLineageEvidence[],
): readonly SessionRootResolution[] {
  const resolveRoot = createSessionRootResolver(retainedSessions);
  return starts.map(({ identity }) => resolveRoot(identity));
}

function measure<T>(operation: () => T): { readonly value: T; readonly elapsedMs: number } {
  const startedAt = performance.now();
  const value = operation();
  return { value, elapsedMs: performance.now() - startedAt };
}

function evidence(index: number): SessionLineageEvidence {
  return {
    identity: identity(index),
    lineageCoverage: "complete",
    relations: [],
  };
}

function identity(index: number): SessionIdentity {
  return {
    source: { kind: "synthetic", instanceId: "query-measurement" },
    nativeId: `session-${String(index)}`,
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}
