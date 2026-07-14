import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type {
  IndexLifecycle,
  IndexPaths,
  IndexReader,
  IndexWriter,
} from "../../application/ports/index-lifecycle.ts";
import type { SessionIndexReader } from "../../application/ports/session-index.ts";
import type { IndexState, ReadyIndexState } from "../../domain/index-state.ts";
import {
  configureFts5SecureDelete,
  type Fts5SecurityCapability,
  probeFts5Security,
  SESSIONS_CONTENT_FTS_TABLE,
} from "./fts5-security.ts";
import { SqliteIndexLifecycleError } from "./lifecycle-error.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
  MigrationHistoryError,
  readMigrationHistory,
  sqliteMigrations,
  type SqliteMigration,
  validateMigrationCatalog,
} from "./migrations.ts";
import {
  IndexPathSecurityError,
  inspectIndexPathSafety,
  prepareIndexPathsForWriter,
  secureIndexFiles,
} from "./permissions.ts";
import { createSqliteReadSnapshot, type SqliteReadSnapshot } from "./read-snapshot.ts";
import { inspectSqliteReadyIndexHealth } from "./sqlite-index-health.ts";
import {
  createCoordinatedSqliteSessionIndex,
  createSqliteSessionIndexReader,
} from "./sqlite-session-index.ts";
import {
  configureSqliteWriterDatabase,
  openSqliteWriterDatabase,
} from "./sqlite-writer-database.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  SqliteWriterLeaseError,
  startWriterLeaseHeartbeat,
  type WriterLeaseHeartbeat,
  type WriterLeaseIdentity,
  type WriterLeaseScheduler,
} from "./writer-lease.ts";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export type SqliteIndexReader = IndexReader;

export interface SqliteIndexWriter extends IndexWriter {
  readonly database: DatabaseSync;
  readonly fts5Security: Fts5SecurityCapability;
  readonly fts5SecureDelete: boolean;
}

export interface SqliteIndexLifecycle extends IndexLifecycle {
  openReader(paths: IndexPaths): Promise<SqliteIndexReader>;
  openWriter(paths: IndexPaths): Promise<SqliteIndexWriter>;
}

export interface SqliteIndexLifecycleOptions {
  readonly busyTimeoutMs?: number;
  readonly migrations?: readonly SqliteMigration[];
  readonly platform?: NodeJS.Platform;
  readonly supportedSchemaVersion?: number;
  readonly fts5Probe?: () => Fts5SecurityCapability;
  readonly now?: () => Date;
  readonly writerScheduler?: WriterLeaseScheduler;
  readonly writerToken?: () => string;
}

export { SqliteIndexLifecycleError } from "./lifecycle-error.ts";

export function createSqliteIndexLifecycle(
  options: SqliteIndexLifecycleOptions = {},
): SqliteIndexLifecycle {
  const migrations = options.migrations ?? sqliteMigrations;
  validateMigrationCatalog(migrations);
  const supportedSchemaVersion =
    options.supportedSchemaVersion ??
    (options.migrations === undefined ? CURRENT_INDEX_SCHEMA_VERSION : migrations.length);
  if (supportedSchemaVersion !== migrations.length) {
    throw new TypeError("Supported SQLite schema version must match the migration catalog");
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new TypeError("SQLite busy timeout must be a non-negative integer");
  }
  const platform = options.platform ?? process.platform;
  const fts5Probe = options.fts5Probe ?? probeFts5Security;
  const now = options.now ?? (() => new Date());

  return {
    async inspect(paths) {
      return inspectSqliteIndex(paths, {
        migrations,
        platform,
        supportedSchemaVersion,
      });
    },

    async inspectHealth(paths) {
      const fts5Security = fts5Probe();
      return inspectSqliteReadyIndexHealth(paths, {
        fts5SecureDeleteRequired: fts5Security.secureDelete,
        migrations,
        platform,
        supportedSchemaVersion,
        timeoutMs: busyTimeoutMs,
        now,
      });
    },

    async openReader(paths) {
      const state = await inspectSqliteIndex(paths, {
        migrations,
        platform,
        supportedSchemaVersion,
      });
      if (state.status !== "ready") {
        throw new SqliteIndexLifecycleError(state);
      }

      const snapshot = createSqliteReadSnapshot(paths, {
        migrations,
        platform,
        supportedSchemaVersion,
        timeoutMs: busyTimeoutMs,
      });
      return createReader(snapshot, state);
    },

    async openWriter(paths) {
      const fts5Security = fts5Probe();
      await refuseSidecarOnlyWriterState(paths, platform, supportedSchemaVersion);
      try {
        await prepareIndexPathsForWriter(paths, { platform });
      } catch (error) {
        if (error instanceof IndexPathSecurityError) {
          throw new SqliteIndexLifecycleError({
            status: "unsafe",
            initialized: error.issue.initialized,
            schemaVersion: null,
            supportedSchemaVersion,
            target: error.issue.target,
            reason: error.issue.reason,
          });
        }
        throw error;
      }

      const state = await inspectSqliteIndex(paths, {
        migrations,
        platform,
        supportedSchemaVersion,
      });
      if (
        state.status !== "ready" &&
        state.status !== "migration-required" &&
        state.status !== "recovery-required"
      ) {
        throw new SqliteIndexLifecycleError(state);
      }

      const database = await openWriterWithFailureCleanup(paths, busyTimeoutMs, platform);
      try {
        configureSqliteWriterDatabase(database, busyTimeoutMs);
        const history = applyMigrations(database, migrations);
        if (history.currentVersion !== supportedSchemaVersion) {
          throw new Error("SQLite migrations did not reach the supported schema");
        }
        await secureIndexFiles(paths, { platform });
        const lease = acquireWriterLease(database, "index", {
          now,
          ...(options.writerToken === undefined ? {} : { token: options.writerToken }),
        });
        let heartbeat: WriterLeaseHeartbeat | undefined;
        try {
          // Persistent FTS configuration is a write and must happen only after
          // this handle owns the high-level writer lease.
          const fts5SecureDelete = configureFts5SecureDelete(
            database,
            SESSIONS_CONTENT_FTS_TABLE,
            fts5Security,
          );
          const sessions = createCoordinatedSqliteSessionIndex(database, { lease, now });
          heartbeat = startWriterLeaseHeartbeat(database, lease, {
            now,
            ...(options.writerScheduler === undefined
              ? {}
              : { scheduler: options.writerScheduler }),
          });

          return createWriter(
            database,
            paths,
            platform,
            supportedSchemaVersion,
            fts5Security,
            fts5SecureDelete,
            sessions,
            lease,
            heartbeat,
            now,
          );
        } catch (error) {
          let operationError = error;
          try {
            heartbeat?.stop();
          } catch (heartbeatError) {
            operationError = new AggregateError(
              [error, heartbeatError],
              "SQLite writer setup and heartbeat cleanup failed",
              { cause: error },
            );
          }
          return throwAfterLeaseCleanup(operationError, database, lease, now, paths, platform);
        }
      } catch (error) {
        return throwAfterDatabaseCleanup(error, database, paths, platform);
      }
    },
  };
}

async function refuseSidecarOnlyWriterState(
  paths: IndexPaths,
  platform: NodeJS.Platform,
  supportedSchemaVersion: number,
): Promise<void> {
  const safety = await inspectIndexPathSafety(paths, { platform });
  if (safety.presence.database || (!safety.presence.wal && !safety.presence.shm)) return;
  if (!safety.safe) {
    throw new SqliteIndexLifecycleError({
      status: "unsafe",
      initialized: safety.issue.initialized,
      schemaVersion: null,
      supportedSchemaVersion,
      target: safety.issue.target,
      reason: safety.issue.reason,
    });
  }
  throw new SqliteIndexLifecycleError(recoveryRequired(supportedSchemaVersion));
}

function createReader(snapshot: SqliteReadSnapshot, state: ReadyIndexState): SqliteIndexReader {
  const sessions: SessionIndexReader = {
    getFreshness(identity) {
      return snapshot.run((database) =>
        createSqliteSessionIndexReader(database).getFreshness(identity),
      );
    },
    getSummary(identity) {
      return snapshot.run((database) =>
        createSqliteSessionIndexReader(database).getSummary(identity),
      );
    },
    getDocument(identity) {
      return snapshot.run((database) =>
        createSqliteSessionIndexReader(database).getDocument(identity),
      );
    },
  };

  return {
    state,
    sessions,
    close() {
      return snapshot.close();
    },
  };
}

interface InspectionOptions {
  readonly migrations: readonly SqliteMigration[];
  readonly platform: NodeJS.Platform;
  readonly supportedSchemaVersion: number;
}

async function inspectSqliteIndex(
  paths: IndexPaths,
  options: InspectionOptions,
): Promise<IndexState> {
  const safety = await inspectIndexPathSafety(paths, {
    platform: options.platform,
  });
  if (!safety.safe) {
    return {
      status: "unsafe",
      initialized: safety.issue.initialized,
      schemaVersion: null,
      supportedSchemaVersion: options.supportedSchemaVersion,
      target: safety.issue.target,
      reason: safety.issue.reason,
    };
  }

  if (safety.presence.wal || safety.presence.shm) {
    return recoveryRequired(options.supportedSchemaVersion);
  }
  if (!safety.presence.database) {
    return {
      status: "uninitialized",
      initialized: false,
      schemaVersion: null,
      supportedSchemaVersion: options.supportedSchemaVersion,
    };
  }

  let before: DatabaseSnapshot;
  try {
    before = await snapshotDatabase(paths.database);
  } catch {
    return incompatible("concurrent-change", options.supportedSchemaVersion);
  }
  if (await sidecarExists(paths)) {
    return recoveryRequired(options.supportedSchemaVersion);
  }

  let inspectedState: IndexState;
  let database: DatabaseSync | undefined;
  try {
    database = openImmutableDatabase(paths.database);
    const history = readMigrationHistory(database, options.migrations);
    inspectedState =
      history.pending.length === 0
        ? ready(history.currentVersion, options.supportedSchemaVersion)
        : {
            status: "migration-required",
            initialized: true,
            schemaVersion: history.currentVersion,
            supportedSchemaVersion: options.supportedSchemaVersion,
          };
  } catch (error) {
    inspectedState = migrationErrorState(error, options.supportedSchemaVersion);
  } finally {
    database?.close();
  }

  if (await sidecarExists(paths)) {
    return recoveryRequired(options.supportedSchemaVersion);
  }
  try {
    const after = await snapshotDatabase(paths.database);
    if (!sameSnapshot(before, after)) {
      return incompatible("concurrent-change", options.supportedSchemaVersion);
    }
  } catch {
    return incompatible("concurrent-change", options.supportedSchemaVersion);
  }

  return inspectedState;
}

function openImmutableDatabase(file: string): DatabaseSync {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: DEFAULT_BUSY_TIMEOUT_MS,
  });
}

async function openWriterWithFailureCleanup(
  paths: IndexPaths,
  busyTimeoutMs: number,
  platform: NodeJS.Platform,
): Promise<DatabaseSync> {
  try {
    return openSqliteWriterDatabase(paths.database, busyTimeoutMs);
  } catch (error) {
    return throwAfterHardening(error, paths, platform);
  }
}

function createWriter(
  database: DatabaseSync,
  paths: IndexPaths,
  platform: NodeJS.Platform,
  supportedSchemaVersion: number,
  fts5Security: Fts5SecurityCapability,
  fts5SecureDelete: boolean,
  sessions: SqliteIndexWriter["sessions"],
  lease: WriterLeaseIdentity,
  heartbeat: WriterLeaseHeartbeat,
  now: () => Date,
): SqliteIndexWriter {
  let closed = false;
  let databaseClosed = false;
  const state: ReadyIndexState = ready(supportedSchemaVersion, supportedSchemaVersion);

  return {
    database,
    state,
    sessions,
    fts5Security,
    fts5SecureDelete,
    async close() {
      if (closed) return;
      const cleanupErrors: unknown[] = [];
      try {
        heartbeat.stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (heartbeat.failure !== undefined) cleanupErrors.push(heartbeat.failure);
      if (!databaseClosed) {
        try {
          if (database.isOpen) {
            const released = interruptOwnedRunsAndReleaseWriterLease(database, lease, { now });
            if (!released && heartbeat.failure === undefined) {
              cleanupErrors.push(new SqliteWriterLeaseError("writer-lease-lost"));
            }
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          database.close();
          databaseClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
          try {
            databaseClosed = !database.isOpen;
          } catch (stateError) {
            cleanupErrors.push(stateError);
          }
        }
      }
      let hardened = false;
      try {
        await secureIndexFiles(paths, { platform });
        hardened = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      closed = databaseClosed && hardened;
      throwCleanupErrors(cleanupErrors, "SQLite writer cleanup failed");
    },
  };
}

async function throwAfterLeaseCleanup(
  operationError: unknown,
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  now: () => Date,
  paths: IndexPaths,
  platform: NodeJS.Platform,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, { now });
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    database.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await secureIndexFiles(paths, { platform });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length === 0) throw operationError;
  throw new AggregateError(
    [operationError, ...cleanupErrors],
    "SQLite operation and lease cleanup failed",
    { cause: operationError },
  );
}

async function throwAfterDatabaseCleanup(
  operationError: unknown,
  database: DatabaseSync,
  paths: IndexPaths,
  platform: NodeJS.Platform,
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  try {
    database.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await secureIndexFiles(paths, { platform });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (cleanupErrors.length === 0) throw operationError;
  throw new AggregateError(
    [operationError, ...cleanupErrors],
    "SQLite operation and cleanup failed",
    { cause: operationError },
  );
}

async function throwAfterHardening(
  operationError: unknown,
  paths: IndexPaths,
  platform: NodeJS.Platform,
): Promise<never> {
  try {
    await secureIndexFiles(paths, { platform });
  } catch (cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      "SQLite operation and cleanup failed",
      { cause: operationError },
    );
  }
  throw operationError;
}

function throwCleanupErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
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

function ready(schemaVersion: number, supportedSchemaVersion: number): ReadyIndexState {
  return {
    status: "ready",
    initialized: true,
    schemaVersion,
    supportedSchemaVersion,
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
