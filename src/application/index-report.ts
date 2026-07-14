import type {
  IndexRunCounts,
  IndexRunFailureCode,
  IndexRunItem,
  IndexRunResult,
} from "./ports/session-index.ts";
import type { SourceInstance } from "../domain/session.ts";

export type IndexSourceReport =
  | {
      readonly schemaVersion: 1;
      readonly source: SourceInstance;
      readonly status: "completed";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly counts: IndexRunCounts;
      readonly items: readonly IndexRunItem[];
      readonly omittedItemCount: number;
    }
  | {
      readonly schemaVersion: 1;
      readonly source: SourceInstance;
      readonly status: "incomplete";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly counts: IndexRunCounts;
      readonly items: readonly IndexRunItem[];
      readonly omittedItemCount: number;
      readonly failure: IndexRunFailureCode;
    };

export interface IndexReport {
  readonly schemaVersion: 1;
  readonly command: "index";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly counts: IndexRunCounts;
  readonly sources: readonly IndexSourceReport[];
  readonly incompleteSources: number;
  readonly omittedItemCount: number;
}

export function createIndexSourceReport(
  selectedSource: SourceInstance,
  result: IndexRunResult,
): IndexSourceReport {
  const common = {
    schemaVersion: 1 as const,
    source: freezeSource(selectedSource),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    counts: freezeCounts(result.counts),
    items: Object.freeze(result.items.map(freezeItem)),
    omittedItemCount: result.omittedItemCount,
  };
  return result.status === "completed"
    ? Object.freeze({ ...common, status: "completed" as const })
    : Object.freeze({ ...common, status: "incomplete" as const, failure: result.failure });
}

export function createIndexReport(
  startedAt: string,
  finishedAt: string,
  sourceReports: readonly IndexSourceReport[],
): IndexReport {
  const sources = Object.freeze([...sourceReports]);
  const counts = sources.reduce<IndexRunCounts>(
    (total, report) => ({
      discovered: addSafe(total.discovered, report.counts.discovered),
      unchanged: addSafe(total.unchanged, report.counts.unchanged),
      updated: addSafe(total.updated, report.counts.updated),
      failed: addSafe(total.failed, report.counts.failed),
      removed: addSafe(total.removed, report.counts.removed),
      stale: addSafe(total.stale, report.counts.stale),
    }),
    emptyCounts(),
  );

  return Object.freeze({
    schemaVersion: 1,
    command: "index",
    startedAt,
    finishedAt,
    counts: freezeCounts(counts),
    sources,
    incompleteSources: sources.filter(({ status }) => status === "incomplete").length,
    omittedItemCount: sources.reduce(
      (total, { omittedItemCount }) => addSafe(total, omittedItemCount),
      0,
    ),
  });
}

function emptyCounts(): IndexRunCounts {
  return { discovered: 0, unchanged: 0, updated: 0, failed: 0, removed: 0, stale: 0 };
}

function freezeCounts(counts: IndexRunCounts): IndexRunCounts {
  return Object.freeze({ ...counts });
}

function freezeItem(item: IndexRunItem): IndexRunItem {
  const identity = Object.freeze({
    source: freezeSource(item.identity.source),
    nativeId: item.identity.nativeId,
  });
  return item.outcome === "failed"
    ? Object.freeze({ identity, outcome: item.outcome, failure: item.failure })
    : Object.freeze({ identity, outcome: item.outcome });
}

function freezeSource(source: SourceInstance): SourceInstance {
  return Object.freeze({ kind: source.kind, instanceId: source.instanceId });
}

function addSafe(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("Index report count exceeds the safe integer range");
  }
  return result;
}
