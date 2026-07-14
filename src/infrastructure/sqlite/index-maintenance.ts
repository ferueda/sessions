import { lstat, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import {
  IndexMaintenanceError,
  type ClearIndexResult,
  type IndexMaintenance,
} from "../../application/ports/index-maintenance.ts";
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  readMigrationHistory,
  sqliteMigrations,
  type SqliteMigration,
  validateMigrationCatalog,
} from "./migrations.ts";
import { assertCanonicalIndexPaths, inspectIndexPathSafety } from "./permissions.ts";
import {
  configureSqliteWriterDatabase,
  openSqliteWriterDatabase,
} from "./sqlite-writer-database.ts";
import {
  acquireWriterLease,
  assertWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  SqliteWriterLeaseError,
  type WriterLeaseIdentity,
} from "./writer-lease.ts";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteIndexMaintenanceOptions {
  readonly beforeFileRemoval?: (paths: IndexPaths) => Promise<void>;
  readonly busyTimeoutMs?: number;
  readonly migrations?: readonly SqliteMigration[];
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly supportedSchemaVersion?: number;
  readonly token?: () => string;
  readonly unlinkFile?: (file: string) => Promise<void>;
}

export function createSqliteIndexMaintenance(
  options: SqliteIndexMaintenanceOptions = {},
): IndexMaintenance {
  const migrations = options.migrations ?? sqliteMigrations;
  validateMigrationCatalog(migrations);
  const supportedSchemaVersion = options.supportedSchemaVersion ?? CURRENT_INDEX_SCHEMA_VERSION;
  if (supportedSchemaVersion !== migrations.length) {
    throw new TypeError("Supported SQLite schema version must match the migration catalog");
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError("SQLite busy timeout must be a non-negative integer");
  }
  const platform = options.platform ?? process.platform;
  const now = options.now ?? currentTime;

  return {
    async clear(paths) {
      return clearSqliteIndex(paths, {
        busyTimeoutMs,
        migrations,
        now,
        platform,
        supportedSchemaVersion,
        ...(options.beforeFileRemoval === undefined
          ? {}
          : { beforeFileRemoval: options.beforeFileRemoval }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.unlinkFile === undefined ? {} : { unlinkFile: options.unlinkFile }),
      });
    },
  };
}

interface ResolvedMaintenanceOptions {
  readonly busyTimeoutMs: number;
  readonly migrations: readonly SqliteMigration[];
  readonly now: () => Date;
  readonly platform: NodeJS.Platform;
  readonly supportedSchemaVersion: number;
  readonly beforeFileRemoval?: (paths: IndexPaths) => Promise<void>;
  readonly token?: () => string;
  readonly unlinkFile?: (file: string) => Promise<void>;
}

async function clearSqliteIndex(
  paths: IndexPaths,
  options: ResolvedMaintenanceOptions,
): Promise<ClearIndexResult> {
  try {
    assertCanonicalIndexPaths(paths);
  } catch (error) {
    throw new IndexMaintenanceError("unsafe-index", { cause: error });
  }

  const safety = await inspectIndexPathSafety(paths, { platform: options.platform });
  const knownStatePresent = safety.presence.database || safety.presence.wal || safety.presence.shm;
  if (!knownStatePresent) return absentResult;
  if (!safety.safe) {
    throw new IndexMaintenanceError("unsafe-index");
  }
  if (!safety.presence.database) {
    throw new IndexMaintenanceError("recovery-required");
  }

  const hasRecoveryState = safety.presence.wal || safety.presence.shm;
  const currentSchema = inspectDatabaseSchema(paths.database, hasRecoveryState, options);
  if (!currentSchema) {
    if (hasRecoveryState) {
      throw new IndexMaintenanceError("recovery-required");
    }
    return removeKnownIndexFiles(paths, options);
  }

  const lease = await checkpointCurrentIndexWhileFenced(paths, options);
  return removeCurrentIndexFiles(paths, lease, options);
}

const absentResult: ClearIndexResult = Object.freeze({
  outcome: "absent",
  databaseRemoved: false,
  walRemoved: false,
  shmRemoved: false,
});

function inspectDatabaseSchema(
  file: string,
  includeRecoveryState: boolean,
  options: ResolvedMaintenanceOptions,
): boolean {
  let database: DatabaseSync | undefined;
  let current = false;
  try {
    const url = pathToFileURL(file);
    url.searchParams.set("mode", "ro");
    if (!includeRecoveryState) url.searchParams.set("immutable", "1");
    database = new DatabaseSync(url.href, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: options.busyTimeoutMs,
    });
    const history = readMigrationHistory(database, options.migrations);
    current =
      history.currentVersion === options.supportedSchemaVersion && history.pending.length === 0;
  } catch {
    current = false;
  }
  try {
    database?.close();
  } catch (error) {
    throw new IndexMaintenanceError("clear-failed", { cause: error });
  }
  return current;
}

async function checkpointCurrentIndexWhileFenced(
  paths: IndexPaths,
  options: ResolvedMaintenanceOptions,
): Promise<WriterLeaseIdentity> {
  let database: DatabaseSync | undefined;
  let lease: WriterLeaseIdentity | undefined;
  let operationError: unknown;

  try {
    database = openSqliteWriterDatabase(paths.database, options.busyTimeoutMs);
    configureSqliteWriterDatabase(database, options.busyTimeoutMs);
    const history = readMigrationHistory(database, options.migrations);
    if (history.currentVersion !== options.supportedSchemaVersion || history.pending.length !== 0) {
      throw new IndexMaintenanceError("concurrent-change");
    }
    lease = acquireWriterLease(database, "clear", {
      now: options.now,
      ...(options.token === undefined ? {} : { token: options.token }),
    });
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | Record<string, unknown>
      | undefined;
    if (checkpoint === undefined || integer(checkpoint.busy) !== 0) {
      throw new IndexMaintenanceError("clear-failed");
    }
    database.close();
    database = undefined;
  } catch (error) {
    operationError = mapClearOperationError(error);
  }

  if (operationError === undefined && lease !== undefined) return lease;

  const cleanupErrors: unknown[] = [];
  if (database !== undefined) {
    if (lease !== undefined) {
      try {
        interruptOwnedRunsAndReleaseWriterLease(database, lease, { now: options.now });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      database.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length === 0) throw operationError;
  const aggregate = new AggregateError(
    [operationError, ...cleanupErrors],
    "Index clear operation and cleanup failed",
    { cause: operationError },
  );
  throw new IndexMaintenanceError(
    operationError instanceof IndexMaintenanceError ? operationError.code : "clear-failed",
    { cause: aggregate },
  );
}

async function removeCurrentIndexFiles(
  paths: IndexPaths,
  lease: WriterLeaseIdentity,
  options: ResolvedMaintenanceOptions,
): Promise<ClearIndexResult> {
  let expectedFiles: KnownFileSnapshots | undefined;
  try {
    expectedFiles = await snapshotKnownFiles(paths);
    return await removeKnownIndexFiles(paths, options, lease, expectedFiles);
  } catch (error) {
    const operationError =
      error instanceof IndexMaintenanceError
        ? error
        : new IndexMaintenanceError("clear-failed", { cause: error });
    const cleanupError =
      expectedFiles === undefined
        ? undefined
        : await releaseClearLeaseAfterFailure(paths, expectedFiles.database, lease, options);
    if (cleanupError === undefined) throw operationError;
    throw new IndexMaintenanceError(operationError.code, {
      cause: new AggregateError(
        [operationError, cleanupError],
        "Index clear operation and lease cleanup failed",
        { cause: operationError },
      ),
    });
  }
}

function mapClearOperationError(error: unknown): unknown {
  if (error instanceof IndexMaintenanceError) return error;
  if (error instanceof SqliteWriterLeaseError && error.code === "writer-busy") {
    return new IndexMaintenanceError("index-busy", { cause: error });
  }
  return new IndexMaintenanceError("clear-failed", { cause: error });
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly device?: bigint;
  readonly inode?: bigint;
  readonly mode?: bigint;
  readonly links?: bigint;
  readonly size?: bigint;
  readonly modified?: bigint;
  readonly changed?: bigint;
}

interface KnownFileSnapshots {
  readonly shm: FileSnapshot;
  readonly wal: FileSnapshot;
  readonly database: FileSnapshot;
}

async function removeKnownIndexFiles(
  paths: IndexPaths,
  options: ResolvedMaintenanceOptions,
  lease?: WriterLeaseIdentity,
  expectedFiles?: KnownFileSnapshots,
): Promise<ClearIndexResult> {
  const snapshots = expectedFiles ?? (await snapshotKnownFiles(paths));
  try {
    await options.beforeFileRemoval?.(paths);
  } catch (error) {
    throw new IndexMaintenanceError("clear-failed", { cause: error });
  }
  let safety;
  try {
    safety = await inspectIndexPathSafety(paths, { platform: options.platform });
  } catch (error) {
    throw new IndexMaintenanceError("clear-failed", { cause: error });
  }
  if (!safety.safe) throw new IndexMaintenanceError("concurrent-change");
  if (lease !== undefined) assertClearLeaseStillOwned(paths.database, lease, options);
  const removed = { shm: false, wal: false, database: false };

  try {
    const removeFile = options.unlinkFile ?? unlink;
    removed.shm = await removeIfUnchanged(paths.shm, snapshots.shm, removeFile);
    removed.wal = await removeIfUnchanged(paths.wal, snapshots.wal, removeFile);
    removed.database = await removeIfUnchanged(paths.database, snapshots.database, removeFile);
  } catch (error) {
    if (error instanceof IndexMaintenanceError) throw error;
    throw new IndexMaintenanceError("clear-failed", { cause: error });
  }

  return {
    outcome: "cleared",
    databaseRemoved: removed.database,
    walRemoved: removed.wal,
    shmRemoved: removed.shm,
  };
}

async function snapshotKnownFiles(paths: IndexPaths): Promise<KnownFileSnapshots> {
  const [shm, wal, database] = await Promise.all([
    snapshotFile(paths.shm),
    snapshotFile(paths.wal),
    snapshotFile(paths.database),
  ]);
  return { shm, wal, database };
}

function assertClearLeaseStillOwned(
  file: string,
  lease: WriterLeaseIdentity,
  options: ResolvedMaintenanceOptions,
): void {
  let database: DatabaseSync | undefined;
  let operationError: IndexMaintenanceError | undefined;
  try {
    const url = pathToFileURL(file);
    url.searchParams.set("mode", "ro");
    url.searchParams.set("immutable", "1");
    database = new DatabaseSync(url.href, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: options.busyTimeoutMs,
    });
    assertWriterLease(database, lease, { now: options.now });
  } catch (error) {
    operationError = new IndexMaintenanceError("concurrent-change", { cause: error });
  }
  let closeError: unknown;
  if (database !== undefined) {
    try {
      database.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new IndexMaintenanceError(operationError.code, {
      cause: new AggregateError(
        [operationError, closeError],
        "Index clear lease inspection and database close failed",
        { cause: operationError },
      ),
    });
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined)
    throw new IndexMaintenanceError("clear-failed", { cause: closeError });
}

async function releaseClearLeaseAfterFailure(
  paths: IndexPaths,
  expectedDatabase: FileSnapshot,
  lease: WriterLeaseIdentity,
  options: ResolvedMaintenanceOptions,
): Promise<unknown | undefined> {
  let database: DatabaseSync | undefined;
  let cleanupError: unknown;
  try {
    const safety = await inspectIndexPathSafety(paths, { platform: options.platform });
    if (!safety.safe) return new IndexMaintenanceError("concurrent-change");
    if (!safety.presence.database) return undefined;
    const actualDatabase = await snapshotFile(paths.database);
    if (!sameFileSnapshot(expectedDatabase, actualDatabase)) {
      return new IndexMaintenanceError("concurrent-change");
    }

    database = openSqliteWriterDatabase(paths.database, options.busyTimeoutMs);
    const released = interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: options.now,
    });
    if (released) database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch (error) {
    cleanupError = error;
  }
  if (database !== undefined) {
    try {
      database.close();
    } catch (error) {
      cleanupError =
        cleanupError === undefined
          ? error
          : new AggregateError(
              [cleanupError, error],
              "Index clear lease release and database close failed",
              { cause: cleanupError },
            );
    }
  }
  return cleanupError;
}

async function snapshotFile(file: string): Promise<FileSnapshot> {
  try {
    const stats = await lstat(file, { bigint: true });
    return snapshotFromStats(stats);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { exists: false };
    throw new IndexMaintenanceError("clear-failed", { cause: error });
  }
}

function snapshotFromStats(stats: BigIntStats): FileSnapshot {
  return {
    exists: true,
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    links: stats.nlink,
    size: stats.size,
    modified: stats.mtimeNs,
    changed: stats.ctimeNs,
  };
}

async function removeIfUnchanged(
  file: string,
  expected: FileSnapshot,
  removeFile: (file: string) => Promise<void>,
): Promise<boolean> {
  let actual: FileSnapshot;
  try {
    actual = snapshotFromStats(await lstat(file, { bigint: true }));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  if (!sameFileSnapshot(expected, actual)) {
    throw new IndexMaintenanceError("concurrent-change");
  }
  try {
    await removeFile(file);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.exists === right.exists &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.links === right.links &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

function integer(value: unknown): number {
  if (typeof value === "bigint") return Number(value);
  if (Number.isSafeInteger(value)) return Number(value);
  throw new IndexMaintenanceError("clear-failed");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function currentTime(): Date {
  return new Date();
}
