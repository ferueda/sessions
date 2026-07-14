import type { IndexPaths } from "./index-lifecycle.ts";

export type IndexHealthCheck = "failed" | "ok";
export type IndexFtsSecureDeleteHealth = "enabled" | "missing" | "unsupported";
export type IndexWriterLeaseHealth = "clear-live" | "expired" | "free" | "index-live" | "invalid";

export interface ReadyIndexHealth {
  readonly ok: boolean;
  readonly integrity: IndexHealthCheck;
  readonly foreignKeys: IndexHealthCheck;
  readonly ftsStructure: IndexHealthCheck;
  readonly ftsContent: IndexHealthCheck;
  readonly ftsSecureDelete: IndexFtsSecureDeleteHealth;
  readonly runRecords: IndexHealthCheck;
  readonly writerLease: IndexWriterLeaseHealth;
  readonly activeRuns: number;
  readonly interruptedRuns: number;
}

export interface IndexHealthInspector {
  inspectHealth(paths: IndexPaths): Promise<ReadyIndexHealth>;
}
