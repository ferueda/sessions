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
  acquireWriterLeaseInTransaction,
  assertWriterLease,
  readWriterLeaseHealth,
  SqliteWriterLeaseError,
  type WriterLeaseIdentity,
  type WriterLeasePurpose,
} from "./writer-lease.ts";

const COORDINATION_SCHEMA_VERSION = 3;
const LEASE_AWARE_SCHEMA_VERSION = 4;
const MIGRATION_TABLE = "sessions_schema_migrations";

export interface WriterSchemaCutoverOptions {
  readonly now: () => Date;
  readonly token?: () => string;
}

export interface AcquiredWriterSchema {
  readonly history: MigrationHistory;
  readonly lease: WriterLeaseIdentity;
}

/** The lease-aware cutover depends on the canonical schema through version 4. */
export function validateWriterSchemaCatalog(migrations: readonly SqliteMigration[]): void {
  if (migrations.length < LEASE_AWARE_SCHEMA_VERSION) {
    throw new TypeError("SQLite writer migration catalog must include schema 4");
  }
  for (let index = 0; index < LEASE_AWARE_SCHEMA_VERSION; index += 1) {
    const actual = migrations[index];
    const expected = sqliteMigrations[index];
    if (
      actual === undefined ||
      expected === undefined ||
      migrationChecksum(actual) !== migrationChecksum(expected)
    ) {
      throw new TypeError("SQLite writer migration catalog must preserve the canonical prefix");
    }
  }
}

/**
 * Reach schema 4 while atomically carrying index/forget ownership across the
 * schema-3 cutover. Later migrations are deliberately applied separately.
 */
export function acquireWriterSchema(
  database: DatabaseSync,
  purpose: Extract<WriterLeasePurpose, "index" | "forget">,
  migrations: readonly SqliteMigration[],
  options: WriterSchemaCutoverOptions,
): AcquiredWriterSchema {
  validateWriterSchemaCatalog(migrations);
  let history = readMigrationHistory(database, migrations);

  if (history.currentVersion < COORDINATION_SCHEMA_VERSION) {
    try {
      applyMigrations(database, migrations.slice(0, COORDINATION_SCHEMA_VERSION), {
        now: options.now,
      });
    } catch (error) {
      // A concurrent writer may have completed schema 4 while this connection
      // waited for an earlier migration lock. Re-read the full catalog below.
      if (!(error instanceof MigrationHistoryError) || error.kind !== "newer-schema") throw error;
    }
    history = readMigrationHistory(database, migrations);
  }

  if (history.currentVersion === COORDINATION_SCHEMA_VERSION) {
    const carried = cutOverSchemaThree(database, purpose, migrations, options);
    if (carried !== undefined) return carried;
    history = readMigrationHistory(database, migrations);
  }

  if (history.currentVersion < LEASE_AWARE_SCHEMA_VERSION) {
    throw new MigrationHistoryError("invalid-history", history.currentVersion);
  }

  const lease = acquireWriterLease(database, purpose, options);
  return { history: readMigrationHistory(database, migrations), lease };
}

/** Apply schema versions above 4 only while the caller's lease remains live. */
export function applyWriterMigrations(
  database: DatabaseSync,
  migrations: readonly SqliteMigration[],
  lease: WriterLeaseIdentity,
  options: Pick<WriterSchemaCutoverOptions, "now">,
): MigrationHistory {
  if (lease.purpose !== "index" && lease.purpose !== "forget") {
    throw new TypeError("Writer migrations require index or forget ownership");
  }
  let history = readMigrationHistory(database, migrations);
  for (const migration of history.pending) {
    if (migration.version <= LEASE_AWARE_SCHEMA_VERSION) {
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

function cutOverSchemaThree(
  database: DatabaseSync,
  purpose: Extract<WriterLeasePurpose, "index" | "forget">,
  migrations: readonly SqliteMigration[],
  options: WriterSchemaCutoverOptions,
): AcquiredWriterSchema | undefined {
  return runImmediateTransaction(database, () => {
    const locked = readMigrationHistory(database, migrations);
    if (locked.currentVersion >= LEASE_AWARE_SCHEMA_VERSION) return undefined;
    if (locked.currentVersion !== COORDINATION_SCHEMA_VERSION) {
      throw new MigrationHistoryError("invalid-history", locked.currentVersion);
    }

    const before = readWriterLeaseHealth(database, { now: options.now });
    assertCutoverAvailable(before, purpose);
    const migration = migrations[LEASE_AWARE_SCHEMA_VERSION - 1];
    if (migration === undefined) throw new MigrationHistoryError("invalid-history");
    database.exec(migration.sql);

    const leaseTime = canonicalDate(options.now);
    if (before.status !== "free" && leaseTime.toISOString() < before.heartbeatAt) {
      throw new SqliteWriterLeaseError("writer-lease-lost");
    }
    const lease = acquireWriterLeaseInTransaction(database, purpose, {
      now: () => leaseTime,
      ...(options.token === undefined ? {} : { token: options.token }),
    });
    recordMigration(database, migration, leaseTime.toISOString());
    assertWriterLease(database, lease, { now: () => leaseTime });

    const history = readMigrationHistory(database, migrations);
    if (history.currentVersion !== LEASE_AWARE_SCHEMA_VERSION) {
      throw new MigrationHistoryError("invalid-history", history.currentVersion);
    }
    return { history, lease };
  });
}

function assertCutoverAvailable(
  health: ReturnType<typeof readWriterLeaseHealth>,
  requested: Extract<WriterLeasePurpose, "index" | "forget">,
): void {
  if (health.status !== "free" && health.purpose === "forget") {
    throw new SqliteWriterLeaseError("corrupt-data");
  }
  if (health.status === "live") throw new SqliteWriterLeaseError("writer-busy");
  if (health.status === "expired" && health.purpose === "clear") {
    throw new SqliteWriterLeaseError("writer-busy");
  }
  if (requested !== "index" && requested !== "forget") {
    throw new TypeError("Schema cutover requires index or forget ownership");
  }
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
  return canonicalDate(now).toISOString();
}

function canonicalDate(now: () => Date): Date {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Writer schema clock must return a valid Date");
  }
  const timestamp = date.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(timestamp)) {
    throw new TypeError("Writer schema clock must return a four-digit UTC timestamp");
  }
  return date;
}
