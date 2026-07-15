import type { IndexPaths } from "./ports/index-lifecycle.ts";
import type {
  IndexMaintenance,
  RepairOrphansOutcome,
  RepairOrphansResult,
} from "./ports/index-maintenance.ts";
import { mapLibraryBusyError } from "./library-error.ts";

export interface DataRepairOrphansReport {
  readonly schemaVersion: 1;
  readonly command: "data-repair-orphans";
  readonly outcome: RepairOrphansOutcome;
  readonly deletedContentRows: string;
  readonly deletedContentBytes: string;
}

export async function repairOrphanedContent(
  paths: IndexPaths,
  maintenance: IndexMaintenance,
): Promise<DataRepairOrphansReport> {
  let result: RepairOrphansResult;
  try {
    result = await maintenance.repairOrphans(paths);
  } catch (error) {
    throw mapLibraryBusyError(error);
  }
  assertRepairOrphansResult(result);
  return Object.freeze({
    schemaVersion: 1,
    command: "data-repair-orphans",
    outcome: result.outcome,
    deletedContentRows: result.deletedContentRows,
    deletedContentBytes: result.deletedContentBytes,
  });
}

function assertRepairOrphansResult(result: RepairOrphansResult): void {
  if (
    !isRepairOrphansOutcome(result.outcome) ||
    !isCanonicalNonNegativeDecimal(result.deletedContentRows) ||
    !isCanonicalNonNegativeDecimal(result.deletedContentBytes) ||
    (result.outcome === "unchanged" &&
      (result.deletedContentRows !== "0" || result.deletedContentBytes !== "0")) ||
    (result.outcome === "repaired" && result.deletedContentRows === "0")
  ) {
    throw new TypeError("Invalid orphan repair result");
  }
}

function isRepairOrphansOutcome(value: unknown): value is RepairOrphansOutcome {
  return value === "repaired" || value === "unchanged";
}

function isCanonicalNonNegativeDecimal(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value);
}
