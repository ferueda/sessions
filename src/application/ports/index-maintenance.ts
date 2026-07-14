import type { IndexPaths } from "./index-lifecycle.ts";

export type ClearIndexOutcome = "absent" | "cleared";

export interface ClearIndexResult {
  readonly outcome: ClearIndexOutcome;
  readonly databaseRemoved: boolean;
  readonly walRemoved: boolean;
  readonly shmRemoved: boolean;
}

export interface IndexMaintenance {
  clear(paths: IndexPaths): Promise<ClearIndexResult>;
}

export type IndexMaintenanceErrorCode =
  | "clear-failed"
  | "concurrent-change"
  | "index-busy"
  | "recovery-required"
  | "unsafe-index";

export class IndexMaintenanceError extends Error {
  readonly code: IndexMaintenanceErrorCode;

  constructor(code: IndexMaintenanceErrorCode, options?: { readonly cause?: unknown }) {
    super(
      `Index maintenance failed: ${code}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "IndexMaintenanceError";
    this.code = code;
  }
}
