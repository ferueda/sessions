import type { DatabaseSync } from "node:sqlite";

import type {
  FinishIndexRunInput,
  IndexRunCounts,
  IndexRunItem,
  IndexRunResult,
  SessionIndexFailureCode,
  SessionIndexRun,
} from "../../application/ports/session-index.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import { SqliteSessionIndexError } from "./sqlite-session-transaction.ts";

const FAILURE_CODES: ReadonlySet<string> = new Set<SessionIndexFailureCode>([
  "unavailable",
  "unreadable",
  "malformed",
  "source-changed",
  "unsupported-format",
  "repository-write",
]);

export function readImmutableIndexRunResult(
  database: DatabaseSync,
  runId: number,
  run: SessionIndexRun,
  completion: FinishIndexRunInput,
): IndexRunResult {
  const counts = readRunCounts(database, runId);
  const items = readRunItems(database, runId, run);
  const omittedItemCount = readOmittedItemCount(database, runId);
  assertRunResultConsistency(counts, items, omittedItemCount);
  const common = {
    source: Object.freeze({ ...run.source }),
    startedAt: run.startedAt,
    finishedAt: completion.finishedAt,
    counts: Object.freeze(counts),
    items,
    omittedItemCount,
  };
  return completion.status === "completed"
    ? Object.freeze({ ...common, status: "completed" })
    : Object.freeze({ ...common, status: "incomplete", failure: completion.failure });
}

function readRunCounts(database: DatabaseSync, runId: number): IndexRunCounts {
  const row = database
    .prepare(
      `SELECT discovered_count, unchanged_count, indexed_count,
              failed_count, removed_count, stale_count
       FROM sessions_index_runs
       WHERE run_id = ?`,
    )
    .get(runId) as CountRow | undefined;
  if (row === undefined) throw new SqliteSessionIndexError("invalid-run");
  return {
    discovered: integerAt(row.discovered_count),
    unchanged: integerAt(row.unchanged_count),
    updated: integerAt(row.indexed_count),
    failed: integerAt(row.failed_count),
    removed: integerAt(row.removed_count),
    stale: integerAt(row.stale_count),
  };
}

function readRunItems(
  database: DatabaseSync,
  runId: number,
  run: SessionIndexRun,
): readonly IndexRunItem[] {
  const rows = database
    .prepare(
      `SELECT item.outcome,
              item.failure_code,
              tracking.native_id,
              source.kind,
              source.instance_id
       FROM sessions_index_run_items AS item
       JOIN sessions_session_tracking AS tracking
         ON tracking.session_id = item.session_id
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       WHERE item.run_id = ?
       ORDER BY item.ordinal`,
    )
    .all(runId) as unknown as readonly RunItemRow[];

  return Object.freeze(
    rows.map((row): IndexRunItem => {
      const identity = {
        source: { kind: row.kind, instanceId: row.instance_id },
        nativeId: row.native_id,
      };
      if (
        !isSessionIdentity(identity) ||
        identity.source.kind !== run.source.kind ||
        identity.source.instanceId !== run.source.instanceId
      ) {
        throw new SqliteSessionIndexError("corrupt-data");
      }
      const frozenIdentity = Object.freeze({
        source: Object.freeze({ ...identity.source }),
        nativeId: identity.nativeId,
      });
      if (row.outcome === "removed" && row.failure_code === null) {
        return Object.freeze({ identity: frozenIdentity, outcome: "removed" });
      }
      if (
        row.outcome === "failed" &&
        typeof row.failure_code === "string" &&
        FAILURE_CODES.has(row.failure_code)
      ) {
        return Object.freeze({
          identity: frozenIdentity,
          outcome: "failed",
          failure: row.failure_code as SessionIndexFailureCode,
        });
      }
      throw new SqliteSessionIndexError("corrupt-data");
    }),
  );
}

function readOmittedItemCount(database: DatabaseSync, runId: number): number {
  const row = database
    .prepare("SELECT omitted_item_count FROM sessions_index_runs WHERE run_id = ?")
    .get(runId) as { readonly omitted_item_count?: unknown } | undefined;
  if (row === undefined) throw new SqliteSessionIndexError("invalid-run");
  return integerAt(row.omitted_item_count);
}

function assertRunResultConsistency(
  counts: IndexRunCounts,
  items: readonly IndexRunItem[],
  omittedItemCount: number,
): void {
  if (
    counts.discovered !== counts.unchanged + counts.updated + counts.failed ||
    counts.stale > counts.failed ||
    counts.failed + counts.removed !== items.length + omittedItemCount
  ) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
}

function integerAt(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new SqliteSessionIndexError("corrupt-data");
  }
  return result;
}

interface CountRow {
  readonly discovered_count: number | bigint;
  readonly unchanged_count: number | bigint;
  readonly indexed_count: number | bigint;
  readonly failed_count: number | bigint;
  readonly removed_count: number | bigint;
  readonly stale_count: number | bigint;
}

interface RunItemRow {
  readonly outcome: unknown;
  readonly failure_code: unknown;
  readonly native_id: unknown;
  readonly kind: unknown;
  readonly instance_id: unknown;
}
