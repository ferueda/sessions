import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { bootstrapMigration } from "./migrations/0001-bootstrap.ts";
import { sessionDocumentMetricsMigration } from "./migrations/0002-session-document-metrics.ts";

const CHECKSUM_SCHEME = "sha256-utf8-v1";
const MIGRATION_TABLE = "sessions_schema_migrations";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export type MigrationHistoryErrorKind =
  | "checksum-mismatch"
  | "invalid-history"
  | "newer-schema"
  | "unrecognized-database";

export class MigrationHistoryError extends Error {
  readonly kind: MigrationHistoryErrorKind;
  readonly schemaVersion: number | null;

  constructor(kind: MigrationHistoryErrorKind, schemaVersion: number | null = null) {
    super(`SQLite migration history is ${kind}`);
    this.name = "MigrationHistoryError";
    this.kind = kind;
    this.schemaVersion = schemaVersion;
  }
}

export interface MigrationHistory {
  readonly applied: readonly AppliedMigration[];
  readonly currentVersion: number;
  readonly pending: readonly SqliteMigration[];
}

export interface ApplyMigrationsOptions {
  readonly now?: () => Date;
}

export const sqliteMigrations: readonly SqliteMigration[] = [
  bootstrapMigration,
  sessionDocumentMetricsMigration,
];
export const CURRENT_INDEX_SCHEMA_VERSION = sessionDocumentMetricsMigration.version;

export function migrationChecksum(migration: SqliteMigration): string {
  const hash = createHash("sha256");
  hash.update(CHECKSUM_SCHEME, "utf8");
  hash.update("\0", "utf8");
  hash.update(String(migration.version), "utf8");
  hash.update("\0", "utf8");
  hash.update(migration.name, "utf8");
  hash.update("\0", "utf8");
  hash.update(migration.sql, "utf8");
  return `${CHECKSUM_SCHEME}:${hash.digest("hex")}`;
}

export function validateMigrationCatalog(migrations: readonly SqliteMigration[]): void {
  if (migrations.length === 0) {
    throw new TypeError("SQLite migration catalog must not be empty");
  }

  const names = new Set<string>();
  migrations.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new TypeError(
        `SQLite migration catalog must be contiguous from version 1; expected ${expectedVersion}`,
      );
    }
    if (migration.name.length === 0) {
      throw new TypeError(`SQLite migration ${expectedVersion} must have a name`);
    }
    if (names.has(migration.name)) {
      throw new TypeError(`SQLite migration name must be unique: ${migration.name}`);
    }
    names.add(migration.name);
    if (migration.sql.length === 0) {
      throw new TypeError(`SQLite migration ${expectedVersion} must contain SQL`);
    }
  });
}

export function readMigrationHistory(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[] = sqliteMigrations,
): MigrationHistory {
  validateMigrationCatalog(migrations);

  if (!migrationTableExists(database)) {
    if (databaseHasApplicationObjects(database)) {
      throw new MigrationHistoryError("unrecognized-database");
    }
    return {
      applied: [],
      currentVersion: 0,
      pending: migrations,
    };
  }

  const rows = readAppliedMigrations(database);
  if (rows.length === 0) {
    throw new MigrationHistoryError("invalid-history");
  }
  validateAppliedHistory(rows, migrations);
  const currentVersion = rows.at(-1)?.version ?? 0;

  if (currentVersion > migrations.length) {
    throw new MigrationHistoryError("newer-schema", currentVersion);
  }

  return {
    applied: rows,
    currentVersion,
    pending: migrations.slice(currentVersion),
  };
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[] = sqliteMigrations,
  options: ApplyMigrationsOptions = {},
): MigrationHistory {
  validateMigrationCatalog(migrations);
  const initialHistory = readMigrationHistory(database, migrations);
  const now = options.now ?? (() => new Date());

  for (const migration of initialHistory.pending) {
    database.exec("BEGIN IMMEDIATE");
    try {
      // Another writer may have advanced the database while this connection waited.
      const lockedHistory = readMigrationHistory(database, migrations);
      if (lockedHistory.currentVersion >= migration.version) {
        database.exec("COMMIT");
        continue;
      }
      if (lockedHistory.currentVersion !== migration.version - 1) {
        throw new MigrationHistoryError("invalid-history", lockedHistory.currentVersion);
      }

      database.exec(migration.sql);
      database
        .prepare(
          `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, applied_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(migration.version, migration.name, migrationChecksum(migration), now().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction) {
        try {
          database.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "SQLite migration and rollback both failed",
          );
        }
      }
      throw error;
    }
  }

  return readMigrationHistory(database, migrations);
}

function migrationTableExists(database: DatabaseSync): boolean {
  const row = database
    .prepare("SELECT type FROM sqlite_schema WHERE name = ?")
    .get(MIGRATION_TABLE) as { type?: unknown } | undefined;

  if (row === undefined) return false;
  if (row.type !== "table") {
    throw new MigrationHistoryError("invalid-history");
  }
  return true;
}

function databaseHasApplicationObjects(database: DatabaseSync): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS present
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
       LIMIT 1`,
    )
    .get();
  return row !== undefined;
}

function readAppliedMigrations(database: DatabaseSync): readonly AppliedMigration[] {
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database
      .prepare(
        `SELECT version, name, checksum
         FROM ${MIGRATION_TABLE}
         ORDER BY version`,
      )
      .all() as readonly Record<string, unknown>[];
  } catch {
    throw new MigrationHistoryError("invalid-history");
  }

  return rows.map((row) => {
    if (
      !Number.isSafeInteger(row.version) ||
      typeof row.name !== "string" ||
      typeof row.checksum !== "string"
    ) {
      throw new MigrationHistoryError("invalid-history");
    }
    return {
      version: row.version as number,
      name: row.name,
      checksum: row.checksum,
    };
  });
}

function validateAppliedHistory(
  applied: readonly AppliedMigration[],
  migrations: readonly SqliteMigration[],
): void {
  applied.forEach((record, index) => {
    const expectedVersion = index + 1;
    if (record.version !== expectedVersion) {
      throw new MigrationHistoryError("invalid-history", record.version);
    }

    const migration = migrations[index];
    if (migration === undefined) return;
    if (record.name !== migration.name) {
      throw new MigrationHistoryError("invalid-history", record.version);
    }
    if (record.checksum !== migrationChecksum(migration)) {
      throw new MigrationHistoryError("checksum-mismatch", record.version);
    }
  });
}
