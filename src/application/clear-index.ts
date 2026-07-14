import type { IndexPaths } from "./ports/index-lifecycle.ts";
import type { IndexMaintenance } from "./ports/index-maintenance.ts";
import { mapLibraryBusyError } from "./library-error.ts";

export interface DataClearReport {
  readonly schemaVersion: 1;
  readonly command: "data-clear";
  readonly outcome: "absent" | "cleared";
  readonly scratchRemoved: boolean;
  readonly databaseRemoved: boolean;
  readonly walRemoved: boolean;
  readonly shmRemoved: boolean;
}

export async function clearData(
  paths: IndexPaths,
  maintenance: IndexMaintenance,
): Promise<DataClearReport> {
  let result: Awaited<ReturnType<IndexMaintenance["clear"]>>;
  try {
    result = await maintenance.clear(paths);
  } catch (error) {
    throw mapLibraryBusyError(error);
  }
  return Object.freeze({
    schemaVersion: 1,
    command: "data-clear",
    outcome: result.outcome,
    scratchRemoved: result.scratchRemoved,
    databaseRemoved: result.databaseRemoved,
    walRemoved: result.walRemoved,
    shmRemoved: result.shmRemoved,
  });
}
