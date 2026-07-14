import type { IndexPaths } from "./ports/index-lifecycle.ts";
import type { IndexMaintenance } from "./ports/index-maintenance.ts";

export interface ClearIndexReport {
  readonly schemaVersion: 1;
  readonly command: "index-clear";
  readonly outcome: "absent" | "cleared";
  readonly databaseRemoved: boolean;
  readonly walRemoved: boolean;
  readonly shmRemoved: boolean;
}

export async function clearIndex(
  paths: IndexPaths,
  maintenance: IndexMaintenance,
): Promise<ClearIndexReport> {
  const result = await maintenance.clear(paths);
  return {
    schemaVersion: 1,
    command: "index-clear",
    outcome: result.outcome,
    databaseRemoved: result.databaseRemoved,
    walRemoved: result.walRemoved,
    shmRemoved: result.shmRemoved,
  };
}
