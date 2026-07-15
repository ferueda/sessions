import { lstat, rm, unlink } from "node:fs/promises";
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
import { runImmediateTransaction } from "./sqlite-session-transaction.ts";
import {
  configureSqliteWriterDatabase,
  openSqliteWriterDatabase,
} from "./sqlite-writer-database.ts";
import { forgetSqliteSession } from "./sqlite-index-forget.ts";
import { compactSqliteIndex, type SqliteCompactObserver } from "./sqlite-index-compact.ts";
import {
  repairSqliteOrphanedContent,
  type SqliteRepairObserver,
} from "./sqlite-index-repair-orphans.ts";
import { probeFts5Security, type Fts5SecurityCapability } from "./fts5-security.ts";
import {
  acquireWriterLeaseInTransaction,
  assertWriterLease,
  heartbeatWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  SqliteWriterLeaseError,
  startWriterLeaseHeartbeat,
  type WriterLeaseHeartbeat,
  type WriterLeaseIdentity,
  type WriterLeaseScheduler,
} from "./writer-lease.ts";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteIndexMaintenanceOptions {
  readonly beforeFileRemoval?: (paths: IndexPaths) => Promise<void>;
  readonly busyTimeoutMs?: number;
  readonly compactBatchPageBudgetBytes?: number;
  readonly compactObserver?: SqliteCompactObserver;
  readonly fts5Probe?: () => Fts5SecurityCapability;
  readonly migrations?: readonly SqliteMigration[];
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly repairObserver?: SqliteRepairObserver;
  readonly repairPayloadByteLimit?: number;
  readonly repairScanLimit?: number;
  readonly supportedSchemaVersion?: number;
  readonly token?: () => string;
  readonly unlinkFile?: (file: string) => Promise<void>;
  readonly writerScheduler?: WriterLeaseScheduler;
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
  const fts5Probe = options.fts5Probe ?? probeFts5Security;

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
        ...(options.writerScheduler === undefined
          ? {}
          : { writerScheduler: options.writerScheduler }),
      });
    },
    async compact(paths) {
      return compactSqliteIndex(paths, {
        busyTimeoutMs,
        migrations,
        now,
        platform,
        supportedSchemaVersion,
        ...(options.compactBatchPageBudgetBytes === undefined
          ? {}
          : { batchPageBudgetBytes: options.compactBatchPageBudgetBytes }),
        ...(options.compactObserver === undefined ? {} : { observer: options.compactObserver }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.writerScheduler === undefined
          ? {}
          : { writerScheduler: options.writerScheduler }),
      });
    },
    async forget(paths, identity) {
      return forgetSqliteSession(paths, identity, {
        busyTimeoutMs,
        migrations,
        now,
        platform,
        supportedSchemaVersion,
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.writerScheduler === undefined
          ? {}
          : { writerScheduler: options.writerScheduler }),
      });
    },
    async repairOrphans(paths) {
      return repairSqliteOrphanedContent(paths, {
        busyTimeoutMs,
        fts5SecureDeleteRequired: () => fts5Probe().secureDelete,
        migrations,
        now,
        platform,
        supportedSchemaVersion,
        ...(options.repairObserver === undefined ? {} : { observer: options.repairObserver }),
        ...(options.repairPayloadByteLimit === undefined
          ? {}
          : { payloadByteLimit: options.repairPayloadByteLimit }),
        ...(options.repairScanLimit === undefined ? {} : { scanLimit: options.repairScanLimit }),
        ...(options.token === undefined ? {} : { token: options.token }),
        ...(options.writerScheduler === undefined
          ? {}
          : { writerScheduler: options.writerScheduler }),
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
  readonly writerScheduler?: WriterLeaseScheduler;
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
  const scratch = await inspectScratchPresence(paths.scratch);
  const knownStatePresent =
    safety.presence.database || safety.presence.wal || safety.presence.shm || scratch.exists;
  if (!knownStatePresent) return absentResult;
  if (!safety.safe) {
    throw new IndexMaintenanceError("unsafe-index");
  }
  if (!safety.presence.database) {
    throw new IndexMaintenanceError("recovery-required");
  }

  const hasRecoveryState = safety.presence.wal || safety.presence.shm;
  const schema = inspectDatabaseSchema(paths.database, hasRecoveryState, options);
  if (schema === "invalid") {
    throw new IndexMaintenanceError("corrupt-data");
  }
  if (schema === "empty") {
    if (hasRecoveryState) {
      throw new IndexMaintenanceError("recovery-required");
    }
    if (scratch.exists) throw new IndexMaintenanceError("recovery-required");
    return removeKnownIndexFiles(paths, options);
  }

  return clearCoordinatedIndex(paths, scratch, options);
}

const absentResult: ClearIndexResult = Object.freeze({
  outcome: "absent",
  scratchRemoved: false,
  databaseRemoved: false,
  walRemoved: false,
  shmRemoved: false,
});

type ClearSchema = "current" | "empty" | "invalid";

function inspectDatabaseSchema(
  file: string,
  includeRecoveryState: boolean,
  options: ResolvedMaintenanceOptions,
): ClearSchema {
  let database: DatabaseSync | undefined;
  let schema: ClearSchema = "invalid";
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
    schema =
      history.currentVersion === options.supportedSchemaVersion && history.pending.length === 0
        ? "current"
        : history.currentVersion === 0
          ? "empty"
          : "invalid";
  } catch {
    schema = "invalid";
  }
  try {
    database?.close();
  } catch (error) {
    throw new IndexMaintenanceError("clear-failed", { cause: error });
  }
  return schema;
}

async function clearCoordinatedIndex(
  paths: IndexPaths,
  initialScratch: ScratchRootState,
  options: ResolvedMaintenanceOptions,
): Promise<ClearIndexResult> {
  let database: DatabaseSync | undefined;
  let lease: WriterLeaseIdentity | undefined;
  let heartbeat: WriterLeaseHeartbeat | undefined;
  let destructiveIntent = false;
  let scratchRemoved = false;
  let result: ClearIndexResult | undefined;
  let operationError: unknown;

  try {
    database = openSqliteWriterDatabase(paths.database, options.busyTimeoutMs);
    configureSqliteWriterDatabase(database, options.busyTimeoutMs, {
      initializePageReclamation: false,
    });
    lease = acquireClearLease(database, options);
    heartbeat = startWriterLeaseHeartbeat(database, lease, {
      now: options.now,
      ...(options.writerScheduler === undefined ? {} : { scheduler: options.writerScheduler }),
    });

    const scratch = await inspectScratchRoot(paths.scratch, options.platform);
    if (scratch.exists !== initialScratch.exists) {
      throw new IndexMaintenanceError("concurrent-change");
    }
    if (scratch.exists) {
      destructiveIntent = true;
      await removeScratchRoot(paths.scratch);
      scratchRemoved = true;
    }

    heartbeat.stop();
    if (heartbeat.failure !== undefined) throw heartbeat.failure;
    // With no scratch, final renewal is the first destructive step. Failures
    // after this point preserve clear-only recovery intent.
    destructiveIntent = true;
    heartbeatWriterLease(database, lease, { now: options.now });
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | Record<string, unknown>
      | undefined;
    if (checkpoint === undefined || integer(checkpoint.busy) !== 0) {
      throw new IndexMaintenanceError("clear-failed");
    }
    assertWriterLease(database, lease, { now: options.now });
    database.close();
    database = undefined;

    const expectedFiles = await snapshotKnownFiles(paths);
    result = await removeKnownIndexFiles(paths, options, lease, expectedFiles, scratchRemoved);
  } catch (error) {
    operationError = mapClearOperationError(error);
  }

  const cleanupErrors: unknown[] = [];
  try {
    heartbeat?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (heartbeat?.failure !== undefined && operationError === undefined) {
    cleanupErrors.push(heartbeat.failure);
  }
  if (database !== undefined && lease !== undefined && !destructiveIntent) {
    try {
      const released = interruptOwnedRunsAndReleaseWriterLease(database, lease, {
        now: options.now,
      });
      if (!released && heartbeat?.failure === undefined) {
        cleanupErrors.push(new SqliteWriterLeaseError("writer-lease-lost"));
      }
      if (released) database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (database !== undefined) {
    try {
      database.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (operationError === undefined && cleanupErrors.length === 0 && result !== undefined) {
    return result;
  }
  const primary = operationError ?? cleanupErrors[0] ?? new IndexMaintenanceError("clear-failed");
  if (cleanupErrors.length === 0) throw primary;
  throw new IndexMaintenanceError(
    primary instanceof IndexMaintenanceError ? primary.code : "clear-failed",
    {
      cause: new AggregateError(
        [primary, ...cleanupErrors],
        "Index clear operation and cleanup failed",
        { cause: primary },
      ),
    },
  );
}

function acquireClearLease(
  database: DatabaseSync,
  options: ResolvedMaintenanceOptions,
): WriterLeaseIdentity {
  return runImmediateTransaction(database, () => {
    const history = readMigrationHistory(database, options.migrations);
    if (history.currentVersion !== options.supportedSchemaVersion || history.pending.length !== 0) {
      throw new IndexMaintenanceError("concurrent-change");
    }
    return acquireWriterLeaseInTransaction(database, "clear", {
      now: options.now,
      ...(options.token === undefined ? {} : { token: options.token }),
    });
  });
}

interface ScratchRootState {
  readonly exists: boolean;
}

async function inspectScratchPresence(scratch: string): Promise<ScratchRootState> {
  try {
    await lstat(scratch);
    return { exists: true };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { exists: false };
    throw new IndexMaintenanceError("unsafe-index", { cause: error });
  }
}

async function inspectScratchRoot(
  scratch: string,
  platform: NodeJS.Platform,
): Promise<ScratchRootState> {
  let stats;
  try {
    stats = await lstat(scratch);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { exists: false };
    throw new IndexMaintenanceError("unsafe-index", { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new IndexMaintenanceError("unsafe-index");
  }
  if (platform !== "win32") {
    const uid = process.getuid?.();
    if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o777) !== 0o700) {
      throw new IndexMaintenanceError("unsafe-index");
    }
  }
  return { exists: true };
}

async function removeScratchRoot(scratch: string): Promise<void> {
  try {
    // Recursive rm unlinks nested symlinks and never traverses their targets.
    await rm(scratch, { force: false, recursive: true });
  } catch (error) {
    throw new IndexMaintenanceError("clear-failed", { cause: error });
  }
}

function mapClearOperationError(error: unknown): unknown {
  if (error instanceof IndexMaintenanceError) return error;
  if (error instanceof SqliteWriterLeaseError) {
    return new IndexMaintenanceError(
      error.code === "writer-busy"
        ? "library-busy"
        : error.code === "corrupt-data"
          ? "corrupt-data"
          : "clear-failed",
      { cause: error },
    );
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
  scratchRemoved = false,
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
    outcome:
      scratchRemoved || removed.database || removed.wal || removed.shm ? "cleared" : "absent",
    scratchRemoved,
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
