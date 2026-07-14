import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type {
  IndexLifecycle,
  IndexPaths,
  IndexWriter,
} from "../../application/ports/index-lifecycle.ts";
import type { IndexState, ReadyIndexState } from "../../domain/index-state.ts";
import { type Fts5SecurityCapability, probeFts5Security } from "./fts5-security.ts";
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

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteIndexWriter extends IndexWriter {
  readonly database: DatabaseSync;
  readonly fts5Security: Fts5SecurityCapability;
  readonly fts5SecureDelete: boolean;
}

export interface SqliteIndexLifecycle extends IndexLifecycle {
  openWriter(paths: IndexPaths): Promise<SqliteIndexWriter>;
}

export interface SqliteIndexLifecycleOptions {
  readonly busyTimeoutMs?: number;
  readonly migrations?: readonly SqliteMigration[];
  readonly platform?: NodeJS.Platform;
  readonly supportedSchemaVersion?: number;
  readonly fts5Probe?: () => Fts5SecurityCapability;
}

export class SqliteIndexLifecycleError extends Error {
  readonly state: IndexState;

  constructor(state: IndexState) {
    super(`SQLite index cannot be opened while state is ${state.status}`);
    this.name = "SqliteIndexLifecycleError";
    this.state = state;
  }
}

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

  return {
    async inspect(paths) {
      return inspectSqliteIndex(paths, {
        migrations,
        platform,
        supportedSchemaVersion,
      });
    },

    async openWriter(paths) {
      const fts5Security = fts5Probe();
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
      if (state.status !== "ready" && state.status !== "migration-required") {
        throw new SqliteIndexLifecycleError(state);
      }

      let database: DatabaseSync;
      try {
        database = openConfiguredWriter(paths.database, busyTimeoutMs);
      } catch (error) {
        await secureIndexFiles(paths, { platform });
        throw error;
      }
      try {
        const history = applyMigrations(database, migrations);
        if (history.currentVersion !== supportedSchemaVersion) {
          throw new Error("SQLite migrations did not reach the supported schema");
        }
        await secureIndexFiles(paths, { platform });

        return createWriter(database, paths, platform, supportedSchemaVersion, fts5Security);
      } catch (error) {
        try {
          database.close();
        } finally {
          await secureIndexFiles(paths, { platform });
        }
        throw error;
      }
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

function openConfiguredWriter(file: string, busyTimeoutMs: number): DatabaseSync {
  const database = new DatabaseSync(file, {
    allowBareNamedParameters: false,
    allowExtension: false,
    allowUnknownNamedParameters: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: busyTimeoutMs,
  });

  try {
    database.enableDefensive(true);
    database.enableLoadExtension(false);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA trusted_schema = OFF");
    database.exec("PRAGMA secure_delete = ON");

    const journalMode = pragmaValue(database, "PRAGMA journal_mode = WAL");
    if (journalMode !== "wal") {
      throw new Error("SQLite WAL mode is unavailable");
    }
    if (pragmaValue(database, "PRAGMA foreign_keys") !== 1) {
      throw new Error("SQLite foreign keys are unavailable");
    }
    if (pragmaValue(database, "PRAGMA secure_delete") !== 1) {
      throw new Error("SQLite secure_delete is unavailable");
    }
    if (pragmaValue(database, "PRAGMA trusted_schema") !== 0) {
      throw new Error("SQLite trusted_schema could not be disabled");
    }
    if (pragmaValue(database, "PRAGMA busy_timeout") !== busyTimeoutMs) {
      throw new Error("SQLite busy timeout could not be configured");
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function pragmaValue(database: DatabaseSync, sql: string): string | number | null {
  const row = database.prepare(sql).get();
  if (row === undefined) return null;
  const value = Object.values(row)[0];
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function createWriter(
  database: DatabaseSync,
  paths: IndexPaths,
  platform: NodeJS.Platform,
  supportedSchemaVersion: number,
  fts5Security: Fts5SecurityCapability,
): SqliteIndexWriter {
  let closed = false;
  let databaseClosed = false;
  const state: ReadyIndexState = ready(supportedSchemaVersion, supportedSchemaVersion);

  return {
    database,
    state,
    fts5Security,
    fts5SecureDelete: fts5Security.secureDelete,
    async close() {
      if (closed) return;
      if (!databaseClosed) {
        database.close();
        databaseClosed = true;
      }
      await secureIndexFiles(paths, { platform });
      closed = true;
    },
  };
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
