import type {
  IndexRunCounts,
  IndexRunFailureCode,
  IndexRunItem,
  IndexRunResult,
} from "./ports/session-index.ts";
import { formatSessionIdentity } from "../domain/session-identity.ts";
import type { SessionIdentity, SourceInstance } from "../domain/session.ts";

export interface SessionRef {
  readonly canonicalId: string;
  readonly source: SourceInstance;
  readonly nativeId: string;
}

export type IndexReportItem =
  | { readonly identity: SessionRef; readonly outcome: "missing" }
  | {
      readonly identity: SessionRef;
      readonly outcome: "failed";
      readonly failure: Extract<IndexRunItem, { readonly outcome: "failed" }>["failure"];
    };

export type IndexSourceReport =
  | {
      readonly schemaVersion: 2;
      readonly source: SourceInstance;
      readonly status: "completed";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly counts: IndexRunCounts;
      readonly coverage: { readonly status: "complete"; readonly observedAt: string };
      readonly items: readonly IndexReportItem[];
      readonly omittedItemCount: number;
    }
  | {
      readonly schemaVersion: 2;
      readonly source: SourceInstance;
      readonly status: "incomplete";
      readonly startedAt: string;
      readonly finishedAt: string;
      readonly counts: IndexRunCounts;
      readonly coverage: { readonly status: "unknown"; readonly observedAt: string };
      readonly items: readonly IndexReportItem[];
      readonly omittedItemCount: number;
      readonly failure: IndexRunFailureCode;
    };

export interface IndexReport {
  readonly schemaVersion: 2;
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
    schemaVersion: 2 as const,
    source: freezeSource(selectedSource),
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    counts: freezeCounts(result.counts),
    items: Object.freeze(result.items.map(freezeItem)),
    omittedItemCount: result.omittedItemCount,
  };
  return result.status === "completed"
    ? Object.freeze({
        ...common,
        status: "completed" as const,
        coverage: Object.freeze({ ...result.coverage }),
      })
    : Object.freeze({
        ...common,
        status: "incomplete" as const,
        coverage: Object.freeze({ ...result.coverage }),
        failure: result.failure,
      });
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
      missing: addSafe(total.missing, report.counts.missing),
      stale: addSafe(total.stale, report.counts.stale),
    }),
    emptyCounts(),
  );

  return Object.freeze({
    schemaVersion: 2,
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
  return { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0 };
}

function freezeCounts(counts: IndexRunCounts): IndexRunCounts {
  return Object.freeze({ ...counts });
}

function freezeItem(item: IndexRunItem): IndexReportItem {
  const identity = freezeSessionRef(item.identity);
  return item.outcome === "failed"
    ? Object.freeze({ identity, outcome: item.outcome, failure: item.failure })
    : Object.freeze({ identity, outcome: item.outcome });
}

function freezeSessionRef(value: SessionIdentity): SessionRef {
  return Object.freeze({
    canonicalId: formatSessionIdentity(value),
    source: freezeSource(value.source),
    nativeId: value.nativeId,
  });
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
