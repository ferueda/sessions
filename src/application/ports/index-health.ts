import type { IndexPaths } from "./index-lifecycle.ts";
import type { SessionCaptureScope } from "../../domain/session-capture-scope.ts";
import type { DoctorProgressObserver } from "../doctor-progress.ts";
import type { DoctorTimingRecorder } from "../doctor-timing.ts";

export type IndexHealthCheck = "failed" | "ok";
export type IndexFtsSecureDeleteHealth = "enabled" | "missing" | "unsupported";
export type IndexPageReclamationHealth = "incremental" | "invalid";
export type IndexContentReachabilityHealth = "inspection-failed" | "ok" | "orphaned";
export type ReadySessionCaptureScope = Omit<SessionCaptureScope, "status"> & {
  readonly status: "complete" | "incomplete";
};
export type IndexCaptureScopeHealth =
  | ReadySessionCaptureScope
  | { readonly status: "inspection-failed" };
export type IndexWriterLeaseHealth =
  | "clear-live"
  | "compact-live"
  | "expired"
  | "forget-live"
  | "free"
  | "index-live"
  | "repair-live"
  | "invalid";

export interface ReadyIndexHealth {
  readonly ok: boolean;
  readonly captureScope: IndexCaptureScopeHealth;
  readonly canonicalIntegrity: IndexHealthCheck;
  readonly foreignKeys: IndexHealthCheck;
  readonly contentReachability: IndexContentReachabilityHealth;
  readonly orphanContentRows: string;
  readonly orphanContentBytes: string;
  readonly ftsStructure: IndexHealthCheck;
  readonly ftsContent: IndexHealthCheck;
  readonly ftsSecureDelete: IndexFtsSecureDeleteHealth;
  readonly ftsRemediation: "not-needed" | "rebuild-required";
  readonly pageReclamation: IndexPageReclamationHealth;
  readonly runRecords: IndexHealthCheck;
  readonly writerLease: IndexWriterLeaseHealth;
  readonly activeRuns: number;
  readonly interruptedRuns: number;
}

export interface IndexHealthInspector {
  inspectHealth(
    paths: IndexPaths,
    options?: IndexHealthInspectionOptions,
  ): Promise<ReadyIndexHealth>;
}

export interface IndexHealthInspectionOptions {
  readonly progress?: DoctorProgressObserver;
  readonly timing?: DoctorTimingRecorder;
}
