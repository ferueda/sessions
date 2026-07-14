import type { BigIntStats } from "node:fs";
import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import { IndexMaintenanceError } from "../../application/ports/index-maintenance.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";
import type { SessionIdentity } from "../../domain/session.ts";
import { MigrationHistoryError, readMigrationHistory, type SqliteMigration } from "./migrations.ts";
import {
  assertCanonicalIndexPaths,
  inspectIndexPathSafety,
  secureIndexFiles,
} from "./permissions.ts";
import { runImmediateTransaction } from "./sqlite-session-transaction.ts";
import {
  configureSqliteWriterDatabase,
  openExistingSqliteWriterDatabase,
} from "./sqlite-writer-database.ts";
import { acquireWriterSchema, applyWriterMigrations } from "./writer-schema.ts";
import {
  assertWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  SqliteWriterLeaseError,
  startWriterLeaseHeartbeat,
  type WriterLeaseHeartbeat,
  type WriterLeaseIdentity,
  type WriterLeaseScheduler,
} from "./writer-lease.ts";

export interface SqliteIndexForgetOptions {
  readonly busyTimeoutMs: number;
  readonly migrations: readonly SqliteMigration[];
  readonly now: () => Date;
  readonly platform: NodeJS.Platform;
  readonly supportedSchemaVersion: number;
  readonly token?: () => string;
  readonly writerScheduler?: WriterLeaseScheduler;
}

export async function forgetSqliteSession(
  paths: IndexPaths,
  identity: SessionIdentity,
  options: SqliteIndexForgetOptions,
): Promise<"forgotten" | "absent"> {
  if (!isSessionIdentity(identity)) throw new TypeError("Invalid session identity");
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
    return "absent";
  }
  const preflight = await inspectForgetDatabase(
    paths.database,
    options.migrations,
    options.busyTimeoutMs,
  );
  if (preflight.status === "empty") {
    if (safety.presence.wal || safety.presence.shm) {
      throw new IndexMaintenanceError("recovery-required");
    }
    return "absent";
  }
  if (preflight.status === "unsupported") {
    throw new IndexMaintenanceError("corrupt-data");
  }

  let database: DatabaseSync | undefined;
  let lease: WriterLeaseIdentity | undefined;
  let heartbeat: WriterLeaseHeartbeat | undefined;
  let outcome: "forgotten" | "absent" | undefined;
  let operationError: unknown;

  try {
    database = openExistingSqliteWriterDatabase(paths.database, options.busyTimeoutMs);
    assertDatabaseSnapshot(preflight.snapshot, await snapshotDatabase(paths.database));
    const openedHistory = readMigrationHistory(database, options.migrations);
    if (openedHistory.currentVersion === 0) {
      throw new MigrationHistoryError("invalid-history", 0);
    }
    assertDatabaseSnapshot(preflight.snapshot, await snapshotDatabase(paths.database));
    configureSqliteWriterDatabase(database, options.busyTimeoutMs);
    const acquired = acquireWriterSchema(database, "forget", options.migrations, {
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
    if (history.currentVersion !== options.supportedSchemaVersion) {
      throw new MigrationHistoryError("invalid-history", history.currentVersion);
    }
    outcome = forgetInTransaction(database, lease, identity, options.now);
  } catch (error) {
    operationError = mapForgetError(error);
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

  if (operationError === undefined && cleanupErrors.length === 0 && outcome !== undefined) {
    return outcome;
  }
  const primary = operationError ?? cleanupErrors[0] ?? new IndexMaintenanceError("forget-failed");
  if (cleanupErrors.length === 0) throw primary;
  throw new IndexMaintenanceError(
    primary instanceof IndexMaintenanceError ? primary.code : "forget-failed",
    {
      cause: new AggregateError(
        [primary, ...cleanupErrors],
        "Session forget operation and cleanup failed",
        { cause: primary },
      ),
    },
  );
}

type ForgetDatabasePreflight =
  | { readonly status: "empty" | "recognized"; readonly snapshot: DatabaseSnapshot }
  | { readonly status: "unsupported"; readonly snapshot: DatabaseSnapshot };

interface DatabaseSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
}

async function inspectForgetDatabase(
  file: string,
  migrations: readonly SqliteMigration[],
  timeoutMs: number,
): Promise<ForgetDatabasePreflight> {
  const before = await snapshotDatabase(file);
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  let database: DatabaseSync | undefined;
  let status: ForgetDatabasePreflight["status"] = "unsupported";
  try {
    database = new DatabaseSync(url.href, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: timeoutMs,
    });
    status =
      readMigrationHistory(database, migrations).currentVersion === 0 ? "empty" : "recognized";
  } catch {
    status = "unsupported";
  } finally {
    database?.close();
  }
  assertDatabaseSnapshot(before, await snapshotDatabase(file));
  return { status, snapshot: before };
}

async function snapshotDatabase(file: string): Promise<DatabaseSnapshot> {
  try {
    return snapshotFromStats(await lstat(file, { bigint: true }));
  } catch (error) {
    throw new IndexMaintenanceError("concurrent-change", { cause: error });
  }
}

function snapshotFromStats(stats: BigIntStats): DatabaseSnapshot {
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

function forgetInTransaction(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  identity: SessionIdentity,
  now: () => Date,
): "forgotten" | "absent" {
  return runImmediateTransaction(database, () => {
    assertWriterLease(database, lease, { now });
    const row = database
      .prepare(
        `SELECT tracking.session_id
         FROM sessions_session_tracking AS tracking
         JOIN sessions_source_instances AS source
           ON source.source_instance_id = tracking.source_instance_id
         WHERE source.kind = ?
           AND source.instance_id = ?
           AND tracking.native_id = ?`,
      )
      .get(identity.source.kind, identity.source.instanceId, identity.nativeId) as
      | { readonly session_id?: unknown }
      | undefined;
    if (row === undefined) {
      assertWriterLease(database, lease, { now });
      return "absent";
    }
    const sessionId = integer(row.session_id);

    database
      .prepare(
        `UPDATE sessions_index_runs
         SET omitted_item_count = omitted_item_count + (
           SELECT COUNT(*)
           FROM sessions_index_run_items AS item
           WHERE item.run_id = sessions_index_runs.run_id
             AND item.session_id = ?
         )
         WHERE EXISTS (
           SELECT 1
           FROM sessions_index_run_items AS item
           WHERE item.run_id = sessions_index_runs.run_id
             AND item.session_id = ?
         )`,
      )
      .run(sessionId, sessionId);

    const deleted = database
      .prepare("DELETE FROM sessions_session_tracking WHERE session_id = ?")
      .run(sessionId);
    if (deleted.changes !== 1) throw new IndexMaintenanceError("corrupt-data");

    database.exec(
      `DELETE FROM sessions_content_values
       WHERE NOT EXISTS (
         SELECT 1
         FROM sessions_content_occurrences AS occurrence
         WHERE occurrence.content_id = sessions_content_values.content_id
       )`,
    );
    assertWriterLease(database, lease, { now });
    return "forgotten";
  });
}

function mapForgetError(error: unknown): IndexMaintenanceError {
  if (error instanceof IndexMaintenanceError) return error;
  if (error instanceof SqliteWriterLeaseError) {
    return new IndexMaintenanceError(
      error.code === "writer-busy"
        ? "library-busy"
        : error.code === "corrupt-data"
          ? "corrupt-data"
          : "forget-failed",
      { cause: error },
    );
  }
  if (error instanceof MigrationHistoryError) {
    return new IndexMaintenanceError("corrupt-data", { cause: error });
  }
  return new IndexMaintenanceError("forget-failed", { cause: error });
}

function integer(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new IndexMaintenanceError("corrupt-data");
  }
  return result;
}
