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

export type CompactIndexOutcome = "absent" | "unchanged" | "compacted";

export interface CompactIndexResult {
  readonly outcome: CompactIndexOutcome;
  readonly databaseBytesBefore: number;
  readonly databaseBytesAfter: number;
  readonly reclaimedDatabaseBytes: number;
}

export type RepairOrphansOutcome = "repaired" | "unchanged";

export interface RepairOrphansResult {
  readonly outcome: RepairOrphansOutcome;
  readonly deletedContentRows: string;
  readonly deletedContentBytes: string;
}

export interface IndexMaintenance {
  clear(paths: IndexPaths): Promise<ClearIndexResult>;
  compact(paths: IndexPaths): Promise<CompactIndexResult>;
  forget(paths: IndexPaths, identity: SessionIdentity): Promise<"forgotten" | "absent">;
  repairOrphans(paths: IndexPaths): Promise<RepairOrphansResult>;
}

export type IndexMaintenanceErrorCode =
  | "clear-failed"
  | "compact-failed"
  | "concurrent-change"
  | "corrupt-data"
  | "forget-failed"
  | "library-busy"
  | "repair-failed"
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
