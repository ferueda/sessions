import type { DatabaseSync } from "node:sqlite";

import {
  createSessionRootResolver,
  type SessionLineageEvidence,
  type SessionRootResolver,
} from "../../domain/session-lineage.ts";
import { formatSessionIdentity, isSessionIdentity } from "../../domain/session-identity.ts";
import type {
  LineageCoverage,
  OriginConfidence,
  SessionIdentity,
  SessionRelation,
} from "../../domain/session.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const RELATION_KINDS = new Set<SessionRelation["kind"]>([
  "parent",
  "child",
  "fork",
  "continuation",
  "unknown",
]);
const CONFIDENCES = new Set<OriginConfidence>(["high", "medium", "low", "unknown"]);

export interface RootSupportCounts {
  readonly uniqueKnownRoots: number;
  readonly unknownLineageSessions: number;
}

export function countRootSupport(
  database: DatabaseSync,
  matchingSessions: readonly SessionIdentity[],
): RootSupportCounts {
  if (matchingSessions.length === 0) {
    return { uniqueKnownRoots: 0, unknownLineageSessions: 0 };
  }
  const resolveRoot = createRetainedSessionRootResolver(database);
  const roots = new Set<string>();
  let unknownLineageSessions = 0;
  for (const identity of matchingSessions) {
    const resolution = resolveRoot(identity);
    if (resolution.kind === "known") roots.add(formatSessionIdentity(resolution.root));
    else unknownLineageSessions += 1;
  }
  return { uniqueKnownRoots: roots.size, unknownLineageSessions };
}

export function createRetainedSessionRootResolver(database: DatabaseSync): SessionRootResolver {
  return createSessionRootResolver(readLineageEvidence(database));
}

function readLineageEvidence(database: DatabaseSync): readonly SessionLineageEvidence[] {
  const sessionRows = database
    .prepare(
      `SELECT canonical.session_id,
              canonical.lineage_coverage,
              source.kind,
              source.instance_id,
              tracking.native_id
       FROM sessions_canonical_sessions AS canonical
       JOIN sessions_session_tracking AS tracking
         ON tracking.session_id = canonical.session_id
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       ORDER BY canonical.session_id`,
    )
    .all() as unknown as readonly LineageSessionRow[];
  const relationsBySession = readRelations(database);
  return sessionRows.map((row) => {
    const identity = identityAt(row.kind, row.instance_id, row.native_id);
    const lineageCoverage = lineageCoverageAt(row.lineage_coverage);
    return {
      identity,
      lineageCoverage,
      relations: relationsBySession.get(integerAt(row.session_id)) ?? [],
    };
  });
}

function readRelations(database: DatabaseSync): ReadonlyMap<number, readonly SessionRelation[]> {
  const rows = database
    .prepare(
      `SELECT relation.session_id,
              relation.kind,
              relation.target_kind,
              relation.target_instance_id,
              relation.target_native_id,
              relation.confidence
       FROM sessions_relations AS relation
       ORDER BY relation.session_id, relation.ordinal`,
    )
    .all() as unknown as readonly LineageRelationRow[];
  const result = new Map<number, SessionRelation[]>();
  for (const row of rows) {
    const sessionId = integerAt(row.session_id);
    if (!RELATION_KINDS.has(row.kind) || !CONFIDENCES.has(row.confidence)) {
      throw new SqliteSessionIndexError("corrupt-data");
    }
    const relations = result.get(sessionId) ?? [];
    relations.push({
      kind: row.kind,
      target: identityAt(row.target_kind, row.target_instance_id, row.target_native_id),
      confidence: row.confidence,
    });
    result.set(sessionId, relations);
  }
  return result;
}

function identityAt(kind: unknown, instanceId: unknown, nativeId: unknown): SessionIdentity {
  const identity = {
    source: { kind, instanceId },
    nativeId,
  };
  if (!isSessionIdentity(identity)) throw new SqliteSessionIndexError("corrupt-data");
  return identity;
}

function lineageCoverageAt(value: unknown): LineageCoverage {
  if (value === "complete" || value === "unknown") return value;
  throw new SqliteSessionIndexError("corrupt-data");
}

function integerAt(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return number;
}

interface LineageSessionRow {
  readonly session_id: unknown;
  readonly lineage_coverage: unknown;
  readonly kind: unknown;
  readonly instance_id: unknown;
  readonly native_id: unknown;
}

interface LineageRelationRow {
  readonly session_id: unknown;
  readonly kind: SessionRelation["kind"];
  readonly target_kind: unknown;
  readonly target_instance_id: unknown;
  readonly target_native_id: unknown;
  readonly confidence: OriginConfidence;
}
