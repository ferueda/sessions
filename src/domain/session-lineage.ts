import { formatSessionIdentity, sameSessionIdentity } from "./session-identity.ts";
import type { LineageCoverage, SessionIdentity, SessionRelation } from "./session.ts";

export interface SessionLineageEvidence {
  readonly identity: SessionIdentity;
  readonly lineageCoverage: LineageCoverage;
  readonly relations: readonly SessionRelation[];
}

export type SessionRootResolution =
  | { readonly kind: "known"; readonly root: SessionIdentity }
  | { readonly kind: "unknown" };

interface Frame {
  readonly key: string;
  readonly evidence: SessionLineageEvidence;
  readonly dependencies: readonly string[];
  nextDependency: number;
  root: SessionIdentity | undefined;
  failed: boolean;
}

const UNKNOWN_ROOT: SessionRootResolution = Object.freeze({ kind: "unknown" });

/** Resolve retained ancestry without inferring inverse or content-based relations. */
export function resolveSessionRoot(
  start: SessionIdentity,
  retainedSessions: readonly SessionLineageEvidence[],
): SessionRootResolution {
  const sessions = indexSessions(retainedSessions);
  const startKey = formatSessionIdentity(start);
  const startEvidence = sessions.get(startKey);
  if (startEvidence === undefined || !sameSessionIdentity(startEvidence.identity, start)) {
    return UNKNOWN_ROOT;
  }

  const memo = new Map<string, SessionRootResolution>();
  const visiting = new Set<string>();
  const first = createFrame(startKey, startEvidence);
  if (first === undefined) return UNKNOWN_ROOT;
  const stack: Frame[] = [first];
  visiting.add(startKey);

  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.failed || frame.nextDependency >= frame.dependencies.length) {
      const resolution = finishFrame(frame);
      memo.set(frame.key, resolution);
      visiting.delete(frame.key);
      stack.pop();
      continue;
    }

    const dependencyKey = frame.dependencies[frame.nextDependency++]!;
    const resolved = memo.get(dependencyKey);
    if (resolved !== undefined) {
      applyDependency(frame, resolved);
      continue;
    }
    if (visiting.has(dependencyKey)) {
      frame.failed = true;
      continue;
    }

    const dependency = sessions.get(dependencyKey);
    if (dependency === undefined) {
      frame.failed = true;
      continue;
    }
    const child = createFrame(dependencyKey, dependency);
    if (child === undefined) {
      memo.set(dependencyKey, UNKNOWN_ROOT);
      frame.failed = true;
      continue;
    }
    // Revisit the dependency after its frame memoizes a result.
    frame.nextDependency -= 1;
    visiting.add(dependencyKey);
    stack.push(child);
  }

  return memo.get(startKey) ?? UNKNOWN_ROOT;
}

function indexSessions(
  retainedSessions: readonly SessionLineageEvidence[],
): ReadonlyMap<string, SessionLineageEvidence> {
  const indexed = new Map<string, SessionLineageEvidence>();
  const duplicates = new Set<string>();
  for (const session of retainedSessions) {
    const key = formatSessionIdentity(session.identity);
    if (indexed.has(key)) duplicates.add(key);
    else indexed.set(key, session);
  }
  for (const key of duplicates) indexed.delete(key);
  return indexed;
}

function createFrame(key: string, evidence: SessionLineageEvidence): Frame | undefined {
  if (evidence.lineageCoverage !== "complete") return undefined;
  const dependencies = new Set<string>();
  for (const relation of evidence.relations) {
    if (relation.kind === "unknown") return undefined;
    if (relation.kind === "child") continue;
    if (relation.confidence !== "high") return undefined;
    dependencies.add(formatSessionIdentity(relation.target));
  }
  return {
    key,
    evidence,
    dependencies: [...dependencies],
    nextDependency: 0,
    root: undefined,
    failed: false,
  };
}

function finishFrame(frame: Frame): SessionRootResolution {
  if (frame.failed) return UNKNOWN_ROOT;
  const root = frame.root ?? frame.evidence.identity;
  return Object.freeze({
    kind: "known",
    root: Object.freeze({
      source: Object.freeze({ ...root.source }),
      nativeId: root.nativeId,
    }),
  });
}

function applyDependency(frame: Frame, resolution: SessionRootResolution): void {
  if (resolution.kind === "unknown") {
    frame.failed = true;
    return;
  }
  if (frame.root === undefined) {
    frame.root = resolution.root;
    return;
  }
  if (!sameSessionIdentity(frame.root, resolution.root)) frame.failed = true;
}
