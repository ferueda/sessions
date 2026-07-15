import type { IndexPaths } from "./ports/index-lifecycle.ts";
import type { CompactIndexOutcome, IndexMaintenance } from "./ports/index-maintenance.ts";
import { mapLibraryBusyError } from "./library-error.ts";

export interface DataCompactReport {
  readonly schemaVersion: 1;
  readonly command: "data-compact";
  readonly outcome: CompactIndexOutcome;
  readonly databaseBytesBefore: number;
  readonly databaseBytesAfter: number;
  readonly reclaimedDatabaseBytes: number;
}

export async function compactIndex(
  paths: IndexPaths,
  maintenance: IndexMaintenance,
): Promise<DataCompactReport> {
  let result: Awaited<ReturnType<IndexMaintenance["compact"]>>;
  try {
    result = await maintenance.compact(paths);
  } catch (error) {
    throw mapLibraryBusyError(error);
  }
  assertCompactResult(result);
  return Object.freeze({
    schemaVersion: 1,
    command: "data-compact",
    outcome: result.outcome,
    databaseBytesBefore: result.databaseBytesBefore,
    databaseBytesAfter: result.databaseBytesAfter,
    reclaimedDatabaseBytes: result.reclaimedDatabaseBytes,
  });
}

function assertCompactResult(result: Awaited<ReturnType<IndexMaintenance["compact"]>>): void {
  if (
    !isCompactOutcome(result.outcome) ||
    !isNonNegativeSafeInteger(result.databaseBytesBefore) ||
    !isNonNegativeSafeInteger(result.databaseBytesAfter) ||
    !isNonNegativeSafeInteger(result.reclaimedDatabaseBytes) ||
    result.databaseBytesBefore - result.databaseBytesAfter !== result.reclaimedDatabaseBytes ||
    (result.outcome === "absent" &&
      (result.databaseBytesBefore !== 0 ||
        result.databaseBytesAfter !== 0 ||
        result.reclaimedDatabaseBytes !== 0)) ||
    (result.outcome === "unchanged" && result.reclaimedDatabaseBytes !== 0) ||
    (result.outcome === "compacted" && result.reclaimedDatabaseBytes === 0)
  ) {
    throw new TypeError("Invalid compact result");
  }
}

function isCompactOutcome(value: unknown): value is CompactIndexOutcome {
  return value === "absent" || value === "unchanged" || value === "compacted";
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
