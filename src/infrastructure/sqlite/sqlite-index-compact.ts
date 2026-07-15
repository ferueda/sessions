import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import {
  IndexMaintenanceError,
  type CompactIndexResult,
} from "../../application/ports/index-maintenance.ts";
import { yieldToEventLoop } from "../../application/yield-to-event-loop.ts";
import { readMigrationHistory, type SqliteMigration } from "./migrations.ts";
import {
  assertCanonicalIndexPaths,
  inspectIndexPathSafety,
  secureIndexFiles,
} from "./permissions.ts";
import { inspectSqlitePageReclamation } from "./sqlite-page-reclamation.ts";
import { runImmediateTransaction } from "./sqlite-session-transaction.ts";
import {
  configureSqliteWriterDatabase,
  openExistingSqliteWriterDatabase,
} from "./sqlite-writer-database.ts";
import {
  acquireWriterLeaseInTransaction,
  interruptOwnedRunsAndReleaseWriterLease,
  runLeasedImmediateTransaction,
  SqliteWriterLeaseError,
  startWriterLeaseHeartbeat,
  type WriterLeaseHeartbeat,
  type WriterLeaseIdentity,
  type WriterLeaseScheduler,
} from "./writer-lease.ts";

const DEFAULT_BATCH_PAGE_BUDGET_BYTES = 16 * 1024 * 1024;

export interface SqliteCompactBatchProgress {
  readonly beforeFreelist: number;
  readonly afterFreelist: number;
  readonly maximumPages: number;
}

export interface SqliteCompactObserver {
  afterBatch?(progress: SqliteCompactBatchProgress): void | Promise<void>;
  afterCheckpoint?(ordinal: number): void | Promise<void>;
}

export interface SqliteIndexCompactOptions {
  readonly batchPageBudgetBytes?: number;
  readonly busyTimeoutMs: number;
  readonly migrations: readonly SqliteMigration[];
  readonly now: () => Date;
  readonly observer?: SqliteCompactObserver;
  readonly platform: NodeJS.Platform;
  readonly supportedSchemaVersion: number;
  readonly token?: () => string;
  readonly writerScheduler?: WriterLeaseScheduler;
}

export async function compactSqliteIndex(
  paths: IndexPaths,
  options: SqliteIndexCompactOptions,
): Promise<CompactIndexResult> {
  const batchPageBudgetBytes = options.batchPageBudgetBytes ?? DEFAULT_BATCH_PAGE_BUDGET_BYTES;
  if (!Number.isSafeInteger(batchPageBudgetBytes) || batchPageBudgetBytes < 1) {
    throw new TypeError("SQLite compact page budget must be a positive integer");
  }
  try {
    assertCanonicalIndexPaths(paths);
  } catch (error) {
    throw new IndexMaintenanceError("unsafe-index", { cause: error });
  }

  const safety = await inspectIndexPathSafety(paths, { platform: options.platform });
  if (!safety.safe) throw new IndexMaintenanceError("unsafe-index");
  if (!safety.presence.database) {
    if (safety.presence.wal || safety.presence.shm) {
      throw new IndexMaintenanceError("recovery-required");
    }
    return absentResult;
  }

  const preflight = await inspectCompactDatabase(
    paths.database,
    safety.presence.wal || safety.presence.shm,
    options,
  );
  if (!preflight.supported) throw new IndexMaintenanceError("corrupt-data");

  let database: DatabaseSync | undefined;
  let lease: WriterLeaseIdentity | undefined;
  let heartbeat: WriterLeaseHeartbeat | undefined;
  let result: CompactIndexResult | undefined;
  let operationError: unknown;

  try {
    database = openExistingSqliteWriterDatabase(paths.database, options.busyTimeoutMs);
    assertDatabaseSnapshot(preflight.snapshot, await snapshotDatabase(paths.database));
    configureSqliteWriterDatabase(database, options.busyTimeoutMs, {
      initializePageReclamation: false,
    });
    lease = acquireCompactLease(database, options);
    heartbeat = startWriterLeaseHeartbeat(database, lease, {
      now: options.now,
      ...(options.writerScheduler === undefined ? {} : { scheduler: options.writerScheduler }),
    });
    result = await compactOwnedDatabase(
      database,
      paths.database,
      preflight.snapshot,
      lease,
      batchPageBudgetBytes,
      options,
    );
  } catch (error) {
    operationError = mapCompactError(error);
  }

  const cleanupErrors: unknown[] = [];
  try {
    heartbeat?.stop();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (heartbeat?.failure !== undefined) cleanupErrors.push(heartbeat.failure);
  if (database !== undefined && lease !== undefined) {
    try {
      if (database.isOpen) {
        const released = interruptOwnedRunsAndReleaseWriterLease(database, lease, {
          now: options.now,
        });
        if (!released && heartbeat?.failure === undefined) {
          cleanupErrors.push(new SqliteWriterLeaseError("writer-lease-lost"));
        }
      }
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
  try {
    await secureIndexFiles(paths, { platform: options.platform });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationError === undefined && cleanupErrors.length === 0 && result !== undefined) {
    return result;
  }
  const primary = operationError ?? cleanupErrors[0] ?? new IndexMaintenanceError("compact-failed");
  if (cleanupErrors.length === 0) throw primary;
  throw new IndexMaintenanceError(
    primary instanceof IndexMaintenanceError ? primary.code : "compact-failed",
    {
      cause: new AggregateError(
        [primary, ...cleanupErrors],
        "SQLite compaction and cleanup failed",
        { cause: primary },
      ),
    },
  );
}

const absentResult: CompactIndexResult = Object.freeze({
  outcome: "absent",
  databaseBytesBefore: 0,
  databaseBytesAfter: 0,
  reclaimedDatabaseBytes: 0,
});

interface CompactDatabasePreflight {
  readonly snapshot: DatabaseSnapshot;
  readonly supported: boolean;
}

interface DatabaseSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
}

async function inspectCompactDatabase(
  file: string,
  includeRecoveryState: boolean,
  options: SqliteIndexCompactOptions,
): Promise<CompactDatabasePreflight> {
  const before = await snapshotDatabase(file);
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  if (!includeRecoveryState) url.searchParams.set("immutable", "1");
  let database: DatabaseSync | undefined;
  let supported = false;
  try {
    database = new DatabaseSync(url.href, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: options.busyTimeoutMs,
    });
    const history = readMigrationHistory(database, options.migrations);
    supported =
      history.currentVersion === options.supportedSchemaVersion &&
      history.pending.length === 0 &&
      inspectSqlitePageReclamation(database) === "incremental";
  } catch {
    supported = false;
  }
  try {
    database?.close();
  } catch (error) {
    throw new IndexMaintenanceError("compact-failed", { cause: error });
  }
  assertDatabaseSnapshot(before, await snapshotDatabase(file));
  return { snapshot: before, supported };
}

function acquireCompactLease(
  database: DatabaseSync,
  options: SqliteIndexCompactOptions,
): WriterLeaseIdentity {
  return runImmediateTransaction(database, () => {
    const history = readMigrationHistory(database, options.migrations);
    if (history.currentVersion !== options.supportedSchemaVersion || history.pending.length !== 0) {
      throw new IndexMaintenanceError("concurrent-change");
    }
    return acquireWriterLeaseInTransaction(database, "compact", {
      now: options.now,
      ...(options.token === undefined ? {} : { token: options.token }),
    });
  });
}

async function compactOwnedDatabase(
  database: DatabaseSync,
  file: string,
  expectedFile: DatabaseSnapshot,
  lease: WriterLeaseIdentity,
  batchPageBudgetBytes: number,
  options: SqliteIndexCompactOptions,
): Promise<CompactIndexResult> {
  await checkpointAndFence(database, lease, 0, options);
  const databaseBytesBefore = await readOwnedFileBytes(file, expectedFile);
  const pageSize = readPragmaInteger(database, "page_size");
  if (pageSize < 1) throw new IndexMaintenanceError("compact-failed");
  const maximumPages = Math.max(1, Math.floor(batchPageBudgetBytes / pageSize));

  let checkpointOrdinal = 0;
  while (true) {
    const progress = runCompactBatch(database, lease, maximumPages, options.now);
    if (progress === undefined) break;
    await options.observer?.afterBatch?.(progress);
    checkpointOrdinal += 1;
    await checkpointAndFence(database, lease, checkpointOrdinal, options);
    await yieldToEventLoop();
    if (progress.afterFreelist === 0) break;
  }

  const databaseBytesAfter = await readOwnedFileBytes(file, expectedFile);
  if (databaseBytesAfter > databaseBytesBefore) {
    throw new IndexMaintenanceError("compact-failed");
  }
  const reclaimedDatabaseBytes = databaseBytesBefore - databaseBytesAfter;
  return {
    outcome: reclaimedDatabaseBytes === 0 ? "unchanged" : "compacted",
    databaseBytesBefore,
    databaseBytesAfter,
    reclaimedDatabaseBytes,
  };
}

function runCompactBatch(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  maximumPages: number,
  now: () => Date,
): SqliteCompactBatchProgress | undefined {
  return runLeasedImmediateTransaction(database, lease, { now }, () => {
    const beforeFreelist = readPragmaInteger(database, "freelist_count");
    if (beforeFreelist === 0) return undefined;
    const requestedPages = Math.min(beforeFreelist, maximumPages);
    database.exec(`PRAGMA incremental_vacuum(${String(requestedPages)})`);
    const afterFreelist = readPragmaInteger(database, "freelist_count");
    const reclaimedPages = beforeFreelist - afterFreelist;
    if (reclaimedPages < 1 || reclaimedPages > requestedPages) {
      throw new IndexMaintenanceError("compact-failed");
    }
    return { beforeFreelist, afterFreelist, maximumPages: requestedPages };
  });
}

async function checkpointAndFence(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  ordinal: number,
  options: SqliteIndexCompactOptions,
): Promise<void> {
  runLeasedImmediateTransaction(database, lease, { now: options.now }, () => undefined);
  const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
    | Record<string, unknown>
    | undefined;
  if (checkpoint === undefined || readNonNegativeInteger(checkpoint.busy) !== 0) {
    throw new IndexMaintenanceError("compact-failed");
  }
  await options.observer?.afterCheckpoint?.(ordinal);
  runLeasedImmediateTransaction(database, lease, { now: options.now }, () => undefined);
}

function readPragmaInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  return readNonNegativeInteger(row === undefined ? undefined : Object.values(row)[0]);
}

function readNonNegativeInteger(value: unknown): number {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  } else if (Number.isSafeInteger(value) && Number(value) >= 0) {
    return Number(value);
  }
  throw new IndexMaintenanceError("compact-failed");
}

async function readOwnedFileBytes(file: string, expected: DatabaseSnapshot): Promise<number> {
  const current = await snapshotDatabase(file);
  assertDatabaseIdentity(expected, current);
  if (current.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IndexMaintenanceError("compact-failed");
  }
  return Number(current.size);
}

async function snapshotDatabase(file: string): Promise<DatabaseSnapshot> {
  try {
    return snapshotFromStats(await lstat(file, { bigint: true }));
  } catch (error) {
    throw new IndexMaintenanceError("concurrent-change", { cause: error });
  }
}

function snapshotFromStats(stats: BigIntStats): DatabaseSnapshot {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
    throw new IndexMaintenanceError("concurrent-change");
  }
  return {
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    links: stats.nlink,
    size: stats.size,
    modified: stats.mtimeNs,
    changed: stats.ctimeNs,
  };
}

function assertDatabaseSnapshot(expected: DatabaseSnapshot, actual: DatabaseSnapshot): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.mode !== actual.mode ||
    expected.links !== actual.links ||
    expected.size !== actual.size ||
    expected.modified !== actual.modified ||
    expected.changed !== actual.changed
  ) {
    throw new IndexMaintenanceError("concurrent-change");
  }
}

function assertDatabaseIdentity(expected: DatabaseSnapshot, actual: DatabaseSnapshot): void {
  if (
    expected.device !== actual.device ||
    expected.inode !== actual.inode ||
    expected.mode !== actual.mode ||
    expected.links !== actual.links
  ) {
    throw new IndexMaintenanceError("concurrent-change");
  }
}

function mapCompactError(error: unknown): unknown {
  if (error instanceof IndexMaintenanceError) return error;
  if (error instanceof SqliteWriterLeaseError) {
    return new IndexMaintenanceError(
      error.code === "writer-busy"
        ? "library-busy"
        : error.code === "corrupt-data"
          ? "corrupt-data"
          : "compact-failed",
      { cause: error },
    );
  }
  return new IndexMaintenanceError("compact-failed", { cause: error });
}
