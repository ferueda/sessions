import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import type { IndexState } from "../../domain/index-state.ts";
import { SqliteIndexLifecycleError, SqliteIndexReaderClosedError } from "./lifecycle-error.ts";
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  MigrationHistoryError,
  readMigrationHistory,
  sqliteMigrations,
  type SqliteMigration,
  validateMigrationCatalog,
} from "./migrations.ts";
import { inspectIndexPathSafety } from "./permissions.ts";
import { assertSqlitePageReclamation } from "./sqlite-page-reclamation.ts";

const DEFAULT_READ_TIMEOUT_MS = 5_000;

export interface SqliteReadSnapshot {
  run<T>(operation: (database: DatabaseSync) => T | Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SqliteReadSnapshotOptions {
  readonly enforcePageReclamation?: boolean;
  readonly migrations?: readonly SqliteMigration[];
  readonly platform?: NodeJS.Platform;
  readonly supportedSchemaVersion?: number;
  readonly timeoutMs?: number;
}

export function createSqliteReadSnapshot(
  paths: IndexPaths,
  options: SqliteReadSnapshotOptions = {},
): SqliteReadSnapshot {
  const migrations = options.migrations ?? sqliteMigrations;
  validateMigrationCatalog(migrations);
  const platform = options.platform ?? process.platform;
  const supportedSchemaVersion = options.supportedSchemaVersion ?? CURRENT_INDEX_SCHEMA_VERSION;
  const timeoutMs = options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  if (supportedSchemaVersion !== migrations.length) {
    throw new TypeError("Supported SQLite schema version must match the migration catalog");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("SQLite read timeout must be a non-negative integer");
  }
  let closed = false;
  let activeOperations = 0;
  const closeWaiters: (() => void)[] = [];

  return {
    async run(operation) {
      if (closed) throw new SqliteIndexReaderClosedError();
      activeOperations += 1;
      try {
        return await runSnapshotOperation(paths, operation, {
          migrations,
          platform,
          supportedSchemaVersion,
          timeoutMs,
          enforcePageReclamation: options.enforcePageReclamation ?? true,
        });
      } finally {
        activeOperations -= 1;
        if (activeOperations === 0) {
          for (const resolve of closeWaiters.splice(0)) resolve();
        }
      }
    },

    async close() {
      closed = true;
      if (activeOperations === 0) return;
      await new Promise<void>((resolve) => closeWaiters.push(resolve));
    },
  };
}

interface ResolvedReadOptions {
  readonly enforcePageReclamation: boolean;
  readonly migrations: readonly SqliteMigration[];
  readonly platform: NodeJS.Platform;
  readonly supportedSchemaVersion: number;
  readonly timeoutMs: number;
}

async function runSnapshotOperation<T>(
  paths: IndexPaths,
  operation: (database: DatabaseSync) => T | Promise<T>,
  options: ResolvedReadOptions,
): Promise<T> {
  const before = await precheckSnapshot(paths, options);
  let result: T | undefined;
  const operationFailure: CapturedFailure = { caught: false, error: undefined };
  const closeFailure: CapturedFailure = { caught: false, error: undefined };
  let database: DatabaseSync | undefined;

  try {
    database = openImmutableDatabase(paths.database, options.timeoutMs);
    const schemaVersion = assertReadyHistory(database, options);
    if (options.enforcePageReclamation) {
      try {
        assertSqlitePageReclamation(database);
      } catch (error) {
        throw new SqliteIndexLifecycleError(
          {
            status: "incompatible",
            initialized: true,
            schemaVersion,
            supportedSchemaVersion: options.supportedSchemaVersion,
            reason: "page-reclamation-mode-mismatch",
          },
          { cause: error },
        );
      }
    }
    result = await operation(database);
  } catch (error) {
    operationFailure.caught = true;
    operationFailure.error = error;
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch (error) {
        closeFailure.caught = true;
        closeFailure.error = error;
      }
    }
  }

  const verificationFailure: CapturedFailure = { caught: false, error: undefined };
  try {
    await verifySnapshot(paths, before, options);
  } catch (error) {
    verificationFailure.caught = true;
    verificationFailure.error = error;
  }

  throwReadErrors(operationFailure, closeFailure, verificationFailure);
  return result as T;
}

async function precheckSnapshot(
  paths: IndexPaths,
  options: ResolvedReadOptions,
): Promise<DatabaseSnapshot> {
  const safety = await inspectIndexPathSafety(paths, { platform: options.platform });
  if (!safety.safe) {
    throw new SqliteIndexLifecycleError({
      status: "unsafe",
      initialized: safety.issue.initialized,
      schemaVersion: null,
      supportedSchemaVersion: options.supportedSchemaVersion,
      target: safety.issue.target,
      reason: safety.issue.reason,
    });
  }
  if (safety.presence.wal || safety.presence.shm) {
    throw new SqliteIndexLifecycleError(recoveryRequired(options.supportedSchemaVersion));
  }
  if (!safety.presence.database) {
    throw new SqliteIndexLifecycleError({
      status: "uninitialized",
      initialized: false,
      schemaVersion: null,
      supportedSchemaVersion: options.supportedSchemaVersion,
    });
  }

  let snapshot: DatabaseSnapshot;
  try {
    snapshot = await snapshotDatabase(paths.database);
  } catch (error) {
    throw new SqliteIndexLifecycleError(
      incompatible("concurrent-change", options.supportedSchemaVersion),
      { cause: error },
    );
  }
  if (await sidecarExists(paths)) {
    throw new SqliteIndexLifecycleError(recoveryRequired(options.supportedSchemaVersion));
  }
  return snapshot;
}

async function verifySnapshot(
  paths: IndexPaths,
  before: DatabaseSnapshot,
  options: ResolvedReadOptions,
): Promise<void> {
  const safety = await inspectIndexPathSafety(paths, { platform: options.platform });
  if (!safety.safe) {
    throw new SqliteIndexLifecycleError({
      status: "unsafe",
      initialized: safety.issue.initialized,
      schemaVersion: null,
      supportedSchemaVersion: options.supportedSchemaVersion,
      target: safety.issue.target,
      reason: safety.issue.reason,
    });
  }
  if (safety.presence.wal || safety.presence.shm || (await sidecarExists(paths))) {
    throw new SqliteIndexLifecycleError(recoveryRequired(options.supportedSchemaVersion));
  }

  try {
    const after = await snapshotDatabase(paths.database);
    if (!sameSnapshot(before, after)) {
      throw new SqliteIndexLifecycleError(
        incompatible("concurrent-change", options.supportedSchemaVersion),
      );
    }
  } catch (error) {
    if (error instanceof SqliteIndexLifecycleError) throw error;
    throw new SqliteIndexLifecycleError(
      incompatible("concurrent-change", options.supportedSchemaVersion),
      { cause: error },
    );
  }
}

function openImmutableDatabase(file: string, timeoutMs: number): DatabaseSync {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: timeoutMs,
  });
}

function assertReadyHistory(database: DatabaseSync, options: ResolvedReadOptions): number {
  let history;
  try {
    history = readMigrationHistory(database, options.migrations);
  } catch (error) {
    throw new SqliteIndexLifecycleError(
      migrationErrorState(error, options.supportedSchemaVersion),
      { cause: error },
    );
  }
  if (history.pending.length > 0) {
    throw new SqliteIndexLifecycleError({
      status: "migration-required",
      initialized: true,
      schemaVersion: history.currentVersion,
      supportedSchemaVersion: options.supportedSchemaVersion,
    });
  }
  return history.currentVersion;
}

function migrationErrorState(error: unknown, supportedSchemaVersion: number): IndexState {
  if (!(error instanceof MigrationHistoryError)) {
    return incompatible("unreadable-database", supportedSchemaVersion);
  }
  if (error.kind === "newer-schema") {
    return {
      status: "newer-schema",
      initialized: true,
      schemaVersion: error.schemaVersion ?? supportedSchemaVersion + 1,
      supportedSchemaVersion,
    };
  }
  const reason =
    error.kind === "checksum-mismatch"
      ? "migration-checksum-mismatch"
      : error.kind === "unrecognized-database"
        ? "unrecognized-database"
        : "invalid-migration-history";
  return {
    status: "incompatible",
    initialized: true,
    schemaVersion: error.schemaVersion,
    supportedSchemaVersion,
    reason,
  };
}

function incompatible(
  reason: "concurrent-change" | "unreadable-database",
  supportedSchemaVersion: number,
): IndexState {
  return {
    status: "incompatible",
    initialized: true,
    schemaVersion: null,
    supportedSchemaVersion,
    reason,
  };
}

function recoveryRequired(supportedSchemaVersion: number): IndexState {
  return {
    status: "recovery-required",
    initialized: true,
    schemaVersion: null,
    supportedSchemaVersion,
  };
}

interface DatabaseSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
}

async function snapshotDatabase(file: string): Promise<DatabaseSnapshot> {
  const stats = await lstat(file, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("SQLite database changed type during inspection");
  }
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    modified: stats.mtimeNs,
    changed: stats.ctimeNs,
  };
}

function sameSnapshot(left: DatabaseSnapshot, right: DatabaseSnapshot): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

async function sidecarExists(paths: IndexPaths): Promise<boolean> {
  return (await Promise.all([exists(paths.wal), exists(paths.shm)])).some(Boolean);
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    return true;
  }
}

interface CapturedFailure {
  caught: boolean;
  error: unknown;
}

function throwReadErrors(...failures: readonly CapturedFailure[]): void {
  const errors = failures.filter(({ caught }) => caught).map(({ error }) => error);
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "SQLite read and snapshot verification failed", {
    cause: errors[0],
  });
}
