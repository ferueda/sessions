import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import {
  IndexMaintenanceError,
  type RepairOrphansResult,
} from "../../application/ports/index-maintenance.ts";
import { yieldToEventLoop } from "../../application/yield-to-event-loop.ts";
import { ftsProjectionStructureIsValid } from "./fts-projection.ts";
import { MigrationHistoryError, readMigrationHistory, type SqliteMigration } from "./migrations.ts";
import {
  assertCanonicalIndexPaths,
  inspectIndexPathSafety,
  secureIndexFiles,
} from "./permissions.ts";
import {
  deleteUnreferencedContentCandidates,
  type SqliteContentId,
} from "./sqlite-content-maintenance.ts";
import { inspectFtsSecureDeleteHealth } from "./sqlite-index-health.ts";
import { inspectSqlitePageReclamation } from "./sqlite-page-reclamation.ts";
import {
  configureSqliteWriterDatabase,
  openExistingSqliteWriterDatabase,
} from "./sqlite-writer-database.ts";
import { acquireWriterSchema, applyWriterMigrations } from "./writer-schema.ts";
import {
  interruptOwnedRunsAndReleaseWriterLease,
  runLeasedImmediateTransaction,
  SqliteWriterLeaseError,
  startWriterLeaseHeartbeat,
  type WriterLeaseHeartbeat,
  type WriterLeaseIdentity,
  type WriterLeaseScheduler,
} from "./writer-lease.ts";

const DEFAULT_SCAN_LIMIT = 10_000;
const DEFAULT_PAYLOAD_BYTE_LIMIT = 64 * 1024 * 1024;

export interface SqliteRepairBatchProgress {
  readonly ordinal: number;
  readonly deletedContentRows: string;
  readonly deletedContentBytes: string;
}

export interface SqliteRepairObserver {
  afterBatch?(progress: SqliteRepairBatchProgress): void | Promise<void>;
}

export interface SqliteIndexRepairOrphansOptions {
  readonly busyTimeoutMs: number;
  readonly fts5SecureDeleteRequired: () => boolean;
  readonly migrations: readonly SqliteMigration[];
  readonly now: () => Date;
  readonly observer?: SqliteRepairObserver;
  readonly payloadByteLimit?: number;
  readonly platform: NodeJS.Platform;
  readonly scanLimit?: number;
  readonly supportedSchemaVersion: number;
  readonly token?: () => string;
  readonly writerScheduler?: WriterLeaseScheduler;
}

export async function repairSqliteOrphanedContent(
  paths: IndexPaths,
  options: SqliteIndexRepairOrphansOptions,
): Promise<RepairOrphansResult> {
  const scanLimit = positiveSafeInteger(options.scanLimit ?? DEFAULT_SCAN_LIMIT, "scan limit");
  const payloadByteLimit = positiveSafeInteger(
    options.payloadByteLimit ?? DEFAULT_PAYLOAD_BYTE_LIMIT,
    "payload byte limit",
  );
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
    return unchangedResult;
  }

  const preflight = await inspectRepairDatabase(
    paths.database,
    safety.presence.wal || safety.presence.shm,
    options,
  );
  if (preflight.status === "empty") {
    if (safety.presence.wal || safety.presence.shm) {
      throw new IndexMaintenanceError("recovery-required");
    }
    return unchangedResult;
  }
  if (preflight.status === "unsupported") throw new IndexMaintenanceError("corrupt-data");

  let database: DatabaseSync | undefined;
  let lease: WriterLeaseIdentity | undefined;
  let heartbeat: WriterLeaseHeartbeat | undefined;
  let result: RepairOrphansResult | undefined;
  let operationError: unknown;

  try {
    database = openExistingSqliteWriterDatabase(paths.database, options.busyTimeoutMs);
    assertDatabaseSnapshot(preflight.snapshot, await snapshotDatabase(paths.database));
    const fts5SecureDeleteRequired = options.fts5SecureDeleteRequired();
    if (typeof fts5SecureDeleteRequired !== "boolean") {
      throw new TypeError("Invalid FTS5 secure-delete capability");
    }
    configureSqliteWriterDatabase(database, options.busyTimeoutMs, {
      initializePageReclamation: false,
    });
    const acquired = acquireWriterSchema(database, "repair", options.migrations, {
      now: options.now,
      ...(options.token === undefined ? {} : { token: options.token }),
    });
    lease = acquired.lease;
    heartbeat = startWriterLeaseHeartbeat(database, lease, {
      now: options.now,
      ...(options.writerScheduler === undefined ? {} : { scheduler: options.writerScheduler }),
    });
    const history = applyWriterMigrations(database, options.migrations, lease, {
      now: options.now,
    });
    if (history.currentVersion !== options.supportedSchemaVersion || history.pending.length !== 0) {
      throw new MigrationHistoryError("invalid-history", history.currentVersion);
    }
    result = await repairOwnedDatabase(
      database,
      lease,
      scanLimit,
      BigInt(payloadByteLimit),
      fts5SecureDeleteRequired,
      options,
    );
  } catch (error) {
    operationError = mapRepairError(error);
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
  const primary = operationError ?? cleanupErrors[0] ?? new IndexMaintenanceError("repair-failed");
  if (cleanupErrors.length === 0) throw primary;
  throw new IndexMaintenanceError(
    primary instanceof IndexMaintenanceError ? primary.code : "repair-failed",
    {
      cause: new AggregateError(
        [primary, ...cleanupErrors],
        "SQLite orphan repair and cleanup failed",
        { cause: primary },
      ),
    },
  );
}

const unchangedResult: RepairOrphansResult = Object.freeze({
  outcome: "unchanged",
  deletedContentRows: "0",
  deletedContentBytes: "0",
});

interface RepairDatabasePreflight {
  readonly snapshot: DatabaseSnapshot;
  readonly status: "empty" | "recognized" | "unsupported";
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

async function inspectRepairDatabase(
  file: string,
  includeRecoveryState: boolean,
  options: SqliteIndexRepairOrphansOptions,
): Promise<RepairDatabasePreflight> {
  const before = await snapshotDatabase(file);
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  if (!includeRecoveryState) url.searchParams.set("immutable", "1");
  let database: DatabaseSync | undefined;
  let status: RepairDatabasePreflight["status"] = "unsupported";
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
    status =
      history.currentVersion === 0
        ? "empty"
        : history.currentVersion === options.supportedSchemaVersion &&
            history.pending.length === 0 &&
            inspectSqlitePageReclamation(database) === "incremental"
          ? "recognized"
          : "unsupported";
  } catch {
    status = "unsupported";
  }
  try {
    database?.close();
  } catch (error) {
    throw new IndexMaintenanceError("repair-failed", { cause: error });
  }
  assertDatabaseSnapshot(before, await snapshotDatabase(file));
  return { snapshot: before, status };
}

async function repairOwnedDatabase(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  scanLimit: number,
  payloadByteLimit: bigint,
  fts5SecureDeleteRequired: boolean,
  options: SqliteIndexRepairOrphansOptions,
): Promise<RepairOrphansResult> {
  checkpointAndFence(database, lease, options);
  let cursor: bigint | null = null;
  let deletedRows = 0n;
  let deletedBytes = 0n;
  let batchOrdinal = 0;

  while (true) {
    const batch = runRepairBatch(
      database,
      lease,
      cursor,
      scanLimit,
      payloadByteLimit,
      fts5SecureDeleteRequired,
      options,
    );
    if (batch === undefined) break;
    cursor = batch.cursor;
    deletedRows += batch.deletedRows;
    deletedBytes += batch.deletedBytes;
    batchOrdinal += 1;
    checkpointAndFence(database, lease, options);
    await options.observer?.afterBatch?.({
      ordinal: batchOrdinal,
      deletedContentRows: batch.deletedRows.toString(),
      deletedContentBytes: batch.deletedBytes.toString(),
    });
    await yieldToEventLoop();
  }

  return {
    outcome: deletedRows === 0n ? "unchanged" : "repaired",
    deletedContentRows: deletedRows.toString(),
    deletedContentBytes: deletedBytes.toString(),
  };
}

interface RepairBatch {
  readonly cursor: bigint;
  readonly deletedRows: bigint;
  readonly deletedBytes: bigint;
}

function runRepairBatch(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  cursor: bigint | null,
  scanLimit: number,
  payloadByteLimit: bigint,
  fts5SecureDeleteRequired: boolean,
  options: SqliteIndexRepairOrphansOptions,
): RepairBatch | undefined {
  return runLeasedImmediateTransaction(database, lease, { now: options.now }, () => {
    assertRepairBatchPreconditions(database, fts5SecureDeleteRequired, options);
    const rows = readContentWindow(database, cursor, scanLimit);
    if (rows.length === 0) return undefined;

    const selected = selectOrphanCandidates(rows, payloadByteLimit);
    const assertions = prepareCandidateAssertions(database);
    for (const candidate of selected.candidates) {
      assertCandidateReady(assertions, candidate.id);
    }
    const deleted = deleteUnreferencedContentCandidates(
      database,
      selected.candidates.map(({ id }) => id),
    );
    if (deleted !== selected.candidates.length) {
      throw new IndexMaintenanceError("corrupt-data");
    }
    for (const candidate of selected.candidates) {
      assertCandidateDeleted(assertions, candidate.id);
    }

    return {
      cursor: selected.cursor,
      deletedRows: BigInt(selected.candidates.length),
      deletedBytes: selected.candidates.reduce((total, row) => total + row.bytes, 0n),
    };
  });
}

interface ContentWindowRow {
  readonly id: SqliteContentId;
  readonly bytes: bigint;
  readonly referenced: boolean;
}

function readContentWindow(
  database: DatabaseSync,
  cursor: bigint | null,
  limit: number,
): readonly ContentWindowRow[] {
  const statement = database.prepare(
    cursor === null
      ? `SELECT content.content_id,
                length(CAST(content.text AS BLOB)) AS content_bytes,
                EXISTS (
                  SELECT 1
                  FROM sessions_content_occurrences AS occurrence
                  WHERE occurrence.content_id = content.content_id
                ) AS referenced
         FROM sessions_content_values AS content
         ORDER BY content.content_id
         LIMIT ?`
      : `SELECT content.content_id,
                length(CAST(content.text AS BLOB)) AS content_bytes,
                EXISTS (
                  SELECT 1
                  FROM sessions_content_occurrences AS occurrence
                  WHERE occurrence.content_id = content.content_id
                ) AS referenced
         FROM sessions_content_values AS content
         WHERE content.content_id > ?
         ORDER BY content.content_id
         LIMIT ?`,
  );
  statement.setReadBigInts(true);
  const rawRows = (cursor === null
    ? statement.all(limit)
    : statement.all(cursor, limit)) as unknown as readonly Record<string, unknown>[];
  return rawRows.map((row) => ({
    id: signedInteger(row.content_id),
    bytes: nonNegativeInteger(row.content_bytes),
    referenced: booleanInteger(row.referenced),
  }));
}

function selectOrphanCandidates(
  rows: readonly ContentWindowRow[],
  payloadByteLimit: bigint,
): { readonly candidates: readonly ContentWindowRow[]; readonly cursor: bigint } {
  const candidates: ContentWindowRow[] = [];
  let selectedBytes = 0n;
  let truncated = false;
  for (const row of rows) {
    if (row.referenced) continue;
    if (candidates.length > 0 && selectedBytes + row.bytes > payloadByteLimit) {
      truncated = true;
      break;
    }
    candidates.push(row);
    selectedBytes += row.bytes;
    if (selectedBytes > payloadByteLimit) {
      truncated = true;
      break;
    }
  }
  const lastRow = rows.at(-1);
  if (lastRow === undefined) throw new IndexMaintenanceError("repair-failed");
  const cursor = truncated ? candidates.at(-1)?.id : lastRow.id;
  if (cursor === undefined) throw new IndexMaintenanceError("repair-failed");
  return { candidates, cursor };
}

function assertRepairBatchPreconditions(
  database: DatabaseSync,
  fts5SecureDeleteRequired: boolean,
  options: SqliteIndexRepairOrphansOptions,
): void {
  const history = readMigrationHistory(database, options.migrations);
  if (history.currentVersion !== options.supportedSchemaVersion || history.pending.length !== 0) {
    throw new IndexMaintenanceError("concurrent-change");
  }
  if (
    readPragmaInteger(database, "foreign_keys") !== 1n ||
    readPragmaInteger(database, "secure_delete") !== 1n ||
    inspectSqlitePageReclamation(database) !== "incremental" ||
    !ftsProjectionStructureIsValid(database) ||
    !inspectFtsSecureDeleteHealth(database, fts5SecureDeleteRequired).healthy
  ) {
    throw new IndexMaintenanceError("corrupt-data");
  }
}

interface CandidateAssertions {
  readonly occurrence: StatementSync;
  readonly fts: StatementSync;
  readonly content: StatementSync;
}

function prepareCandidateAssertions(database: DatabaseSync): CandidateAssertions {
  const fts = database.prepare(
    `SELECT id
     FROM sessions_content_fts_docsize
     WHERE id = ?`,
  );
  fts.setReadBigInts(true);
  return {
    occurrence: database.prepare(
      `SELECT 1
       FROM sessions_content_occurrences
       WHERE content_id = ?
       LIMIT 1`,
    ),
    fts,
    content: database.prepare("SELECT 1 FROM sessions_content_values WHERE content_id = ?"),
  };
}

function assertCandidateReady(assertions: CandidateAssertions, contentId: bigint): void {
  if (assertions.occurrence.get(contentId) !== undefined) {
    throw new IndexMaintenanceError("corrupt-data");
  }
  const row = assertions.fts.get(contentId) as { readonly id?: unknown } | undefined;
  if (row === undefined || signedInteger(row.id) !== contentId) {
    throw new IndexMaintenanceError("corrupt-data");
  }
}

function assertCandidateDeleted(assertions: CandidateAssertions, contentId: bigint): void {
  if (
    assertions.content.get(contentId) !== undefined ||
    assertions.fts.get(contentId) !== undefined
  ) {
    throw new IndexMaintenanceError("corrupt-data");
  }
}

function checkpointAndFence(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  options: SqliteIndexRepairOrphansOptions,
): void {
  runLeasedImmediateTransaction(database, lease, { now: options.now }, () => undefined);
  const statement = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)");
  statement.setReadBigInts(true);
  const checkpoint = statement.get() as Record<string, unknown> | undefined;
  if (checkpoint === undefined || nonNegativeInteger(checkpoint.busy) !== 0n) {
    throw new IndexMaintenanceError("repair-failed");
  }
  runLeasedImmediateTransaction(database, lease, { now: options.now }, () => undefined);
}

function readPragmaInteger(database: DatabaseSync, pragma: string): bigint {
  const statement = database.prepare(`PRAGMA ${pragma}`);
  statement.setReadBigInts(true);
  const row = statement.get();
  return nonNegativeInteger(row === undefined ? undefined : Object.values(row)[0]);
}

function signedInteger(value: unknown): bigint {
  if (typeof value !== "bigint") throw new IndexMaintenanceError("corrupt-data");
  return value;
}

function nonNegativeInteger(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 0n) {
    throw new IndexMaintenanceError("corrupt-data");
  }
  return value;
}

function booleanInteger(value: unknown): boolean {
  if (value === 0n) return false;
  if (value === 1n) return true;
  throw new IndexMaintenanceError("corrupt-data");
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`SQLite repair ${label} must be a positive integer`);
  }
  return value;
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

function mapRepairError(error: unknown): unknown {
  if (error instanceof IndexMaintenanceError) return error;
  if (error instanceof SqliteWriterLeaseError) {
    return new IndexMaintenanceError(
      error.code === "writer-busy"
        ? "library-busy"
        : error.code === "corrupt-data"
          ? "corrupt-data"
          : "repair-failed",
      { cause: error },
    );
  }
  if (error instanceof MigrationHistoryError) {
    return new IndexMaintenanceError("corrupt-data", { cause: error });
  }
  return new IndexMaintenanceError("repair-failed", { cause: error });
}
