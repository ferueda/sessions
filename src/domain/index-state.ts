export type IndexIncompatibilityReason =
  | "concurrent-change"
  | "invalid-migration-history"
  | "migration-checksum-mismatch"
  | "unreadable-database"
  | "unrecognized-database";

export type UnsafeIndexTarget = "directory" | "database" | "wal" | "shm";

export type UnsafeIndexReason =
  | "ownership"
  | "permissions"
  | "symlink"
  | "unexpected-type"
  | "unreadable";

interface IndexStateVersion {
  readonly schemaVersion: number | null;
  readonly supportedSchemaVersion: number;
}

export interface UninitializedIndexState extends IndexStateVersion {
  readonly status: "uninitialized";
  readonly initialized: false;
  readonly schemaVersion: null;
}

export interface ReadyIndexState extends IndexStateVersion {
  readonly status: "ready";
  readonly initialized: true;
  readonly schemaVersion: number;
}

export interface MigrationRequiredIndexState extends IndexStateVersion {
  readonly status: "migration-required";
  readonly initialized: true;
  readonly schemaVersion: number;
}

export interface NewerSchemaIndexState extends IndexStateVersion {
  readonly status: "newer-schema";
  readonly initialized: true;
  readonly schemaVersion: number;
}

export interface IncompatibleIndexState extends IndexStateVersion {
  readonly status: "incompatible";
  readonly initialized: boolean;
  readonly reason: IndexIncompatibilityReason;
}

export interface RecoveryRequiredIndexState extends IndexStateVersion {
  readonly status: "recovery-required";
  readonly initialized: true;
  readonly schemaVersion: null;
}

export interface UnsafeIndexState extends IndexStateVersion {
  readonly status: "unsafe";
  readonly initialized: boolean;
  readonly schemaVersion: null;
  readonly target: UnsafeIndexTarget;
  readonly reason: UnsafeIndexReason;
}

export type IndexState =
  | UninitializedIndexState
  | ReadyIndexState
  | MigrationRequiredIndexState
  | NewerSchemaIndexState
  | IncompatibleIndexState
  | RecoveryRequiredIndexState
  | UnsafeIndexState;
