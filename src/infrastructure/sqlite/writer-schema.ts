import type { DatabaseSync } from "node:sqlite";

import {
  applyMigrations,
  type MigrationHistory,
  MigrationHistoryError,
  migrationChecksum,
  readMigrationHistory,
  sqliteMigrations,
  type SqliteMigration,
} from "./migrations.ts";
import { runImmediateTransaction } from "./sqlite-session-transaction.ts";
import {
  acquireWriterLease,
  assertWriterLease,
  type WriterLeaseIdentity,
  type WriterLeasePurpose,
} from "./writer-lease.ts";

const BASELINE_SCHEMA_VERSION = 1;
const MIGRATION_TABLE = "sessions_schema_migrations";

export interface WriterSchemaOptions {
  readonly now: () => Date;
  readonly token?: () => string;
}

export interface AcquiredWriterSchema {
  readonly history: MigrationHistory;
  readonly lease: WriterLeaseIdentity;
}

export function validateWriterSchemaCatalog(migrations: readonly SqliteMigration[]): void {
  const baseline = migrations[0];
  const canonicalBaseline = sqliteMigrations[0];
  if (
    baseline === undefined ||
    canonicalBaseline === undefined ||
    migrationChecksum(baseline) !== migrationChecksum(canonicalBaseline)
  ) {
    throw new TypeError("SQLite writer migration catalog must preserve the canonical baseline");
  }
}

/** Bootstrap the current baseline for index, then acquire its writer lease. */
export function acquireWriterSchema(
  database: DatabaseSync,
  purpose: Extract<WriterLeasePurpose, "index" | "forget" | "repair">,
  migrations: readonly SqliteMigration[],
  options: WriterSchemaOptions,
): AcquiredWriterSchema {
  validateWriterSchemaCatalog(migrations);
  let history = readMigrationHistory(database, migrations);

  if (history.currentVersion === 0) {
    if (purpose !== "index") throw new MigrationHistoryError("invalid-history", 0);
    history = applyMigrations(database, migrations.slice(0, BASELINE_SCHEMA_VERSION), {
      now: options.now,
    });
  }
  if (history.currentVersion < BASELINE_SCHEMA_VERSION) {
    throw new MigrationHistoryError("invalid-history", history.currentVersion);
  }

  const lease = acquireWriterLease(database, purpose, options);
  return { history: readMigrationHistory(database, migrations), lease };
}

/** Apply future released migrations only while the writer lease remains live. */
export function applyWriterMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[],
  lease: WriterLeaseIdentity,
  options: Pick<WriterSchemaOptions, "now">,
): MigrationHistory {
  if (lease.purpose !== "index" && lease.purpose !== "forget" && lease.purpose !== "repair") {
    throw new TypeError("Writer migrations require index, forget, or repair ownership");
  }

  let history = readMigrationHistory(database, migrations);
  for (const migration of history.pending) {
    if (migration.version <= BASELINE_SCHEMA_VERSION) {
      throw new MigrationHistoryError("invalid-history", history.currentVersion);
    }
    runImmediateTransaction(database, () => {
      const locked = readMigrationHistory(database, migrations);
      if (locked.currentVersion >= migration.version) {
        assertWriterLease(database, lease, options);
        return;
      }
      if (locked.currentVersion !== migration.version - 1) {
        throw new MigrationHistoryError("invalid-history", locked.currentVersion);
      }

      assertWriterLease(database, lease, options);
      database.exec(migration.sql);
      recordMigration(database, migration, canonicalTimestamp(options.now));
      assertWriterLease(database, lease, options);
    });
    history = readMigrationHistory(database, migrations);
  }
  return history;
}

function recordMigration(
  database: DatabaseSync,
  migration: SqliteMigration,
  appliedAt: string,
): void {
  database
    .prepare(
      `INSERT INTO ${MIGRATION_TABLE} (version, name, checksum, applied_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(migration.version, migration.name, migrationChecksum(migration), appliedAt);
}

function canonicalTimestamp(now: () => Date): string {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Writer schema clock must return a valid Date");
  }
  return date.toISOString();
}
