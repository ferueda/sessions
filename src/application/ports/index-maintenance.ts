import type { IndexPaths } from "./index-lifecycle.ts";
import type { SessionIdentity } from "../../domain/session.ts";

export type ClearIndexOutcome = "absent" | "cleared";

export interface ClearIndexResult {
  readonly outcome: ClearIndexOutcome;
  readonly scratchRemoved: boolean;
  readonly databaseRemoved: boolean;
  readonly walRemoved: boolean;
  readonly shmRemoved: boolean;
}

export interface IndexMaintenance {
  clear(paths: IndexPaths): Promise<ClearIndexResult>;
  forget(paths: IndexPaths, identity: SessionIdentity): Promise<"forgotten" | "absent">;
}

export type IndexMaintenanceErrorCode =
  | "clear-failed"
  | "concurrent-change"
  | "corrupt-data"
  | "forget-failed"
  | "library-busy"
  | "recovery-required"
  | "unsafe-index";

export class IndexMaintenanceError extends Error {
  readonly code: IndexMaintenanceErrorCode;

  constructor(code: IndexMaintenanceErrorCode, options?: { readonly cause?: unknown }) {
    super(
      `Session library maintenance failed: ${code}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "IndexMaintenanceError";
    this.code = code;
  }
}
