import type { DatabaseSync } from "node:sqlite";

import type {
  IndexHealthCheck,
  IndexFtsSecureDeleteHealth,
  IndexWriterLeaseHealth,
  ReadyIndexHealth,
} from "../../application/ports/index-health.ts";
import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import { createSqliteReadSnapshot } from "./read-snapshot.ts";
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  sqliteMigrations,
  type SqliteMigration,
} from "./migrations.ts";
import { readWriterLeaseHealth } from "./writer-lease.ts";

const DEFAULT_READ_TIMEOUT_MS = 5_000;

export interface SqliteIndexHealthOptions {
  readonly fts5SecureDeleteRequired?: boolean;
  readonly migrations?: readonly SqliteMigration[];
  readonly now?: () => Date;
  readonly platform?: NodeJS.Platform;
  readonly supportedSchemaVersion?: number;
  readonly timeoutMs?: number;
}

export async function inspectSqliteReadyIndexHealth(
  paths: IndexPaths,
  options: SqliteIndexHealthOptions = {},
): Promise<ReadyIndexHealth> {
  const migrations = options.migrations ?? sqliteMigrations;
  const supportedSchemaVersion = options.supportedSchemaVersion ?? CURRENT_INDEX_SCHEMA_VERSION;
  const snapshot = createSqliteReadSnapshot(paths, {
    migrations,
    supportedSchemaVersion,
    timeoutMs: options.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });

  try {
    return await snapshot.run((database) =>
      inspectDatabaseHealth(database, options.now ?? now, options.fts5SecureDeleteRequired ?? true),
    );
  } finally {
    await snapshot.close();
  }
}

function inspectDatabaseHealth(
  database: DatabaseSync,
  clock: () => Date,
  fts5SecureDeleteRequired: boolean,
): ReadyIndexHealth {
  const integrity = check(() => databaseIntegrityIsValid(database));
  const foreignKeys = check(() => foreignKeysAreValid(database));
  const ftsStructure = check(() => ftsStructureIsValid(database));
  const ftsContent = check(() => ftsContentRowsAreConsistent(database));
  const ftsSecureDelete = inspectFtsSecureDelete(database, fts5SecureDeleteRequired);
  const runs = readRunCounts(database);
  const writerLease = readLeaseHealth(database, clock);
  const activeRunHasLiveIndexLease = runs.active === 0 || writerLease === "index-live";
  const ok =
    integrity === "ok" &&
    foreignKeys === "ok" &&
    ftsStructure === "ok" &&
    ftsContent === "ok" &&
    ftsSecureDelete.healthy &&
    runs.health === "ok" &&
    writerLease !== "invalid" &&
    activeRunHasLiveIndexLease;

  return Object.freeze({
    ok,
    integrity,
    foreignKeys,
    ftsStructure,
    ftsContent,
    ftsSecureDelete: ftsSecureDelete.status,
    runRecords: runs.health,
    writerLease,
    activeRuns: runs.active,
    interruptedRuns: runs.interrupted,
  });
}

function databaseIntegrityIsValid(database: DatabaseSync): boolean {
  const row = database.prepare("PRAGMA integrity_check(1)").get() as
    | Record<string, unknown>
    | undefined;
  return row !== undefined && Object.values(row)[0] === "ok";
}

function foreignKeysAreValid(database: DatabaseSync): boolean {
  return database.prepare("PRAGMA foreign_key_check").get() === undefined;
}

const EXPECTED_FTS_OBJECTS = [
  ["sessions_content_fts", "table"],
  ["sessions_content_fts_config", "table"],
  ["sessions_content_fts_data", "table"],
  ["sessions_content_fts_docsize", "table"],
  ["sessions_content_fts_idx", "table"],
] as const;

const EXPECTED_FTS_TRIGGERS = [
  [
    "sessions_content_values_ai",
    `CREATE TRIGGER sessions_content_values_ai
AFTER INSERT ON sessions_content_values
BEGIN
  INSERT INTO sessions_content_fts(rowid, text)
  VALUES (new.content_id, new.text);
END`,
  ],
  [
    "sessions_content_values_bd",
    `CREATE TRIGGER sessions_content_values_bd
BEFORE DELETE ON sessions_content_values
BEGIN
  INSERT INTO sessions_content_fts(sessions_content_fts, rowid, text)
  VALUES ('delete', old.content_id, old.text);
END`,
  ],
  [
    "sessions_content_values_bu",
    `CREATE TRIGGER sessions_content_values_bu
BEFORE UPDATE ON sessions_content_values
BEGIN
  SELECT RAISE(ABORT, 'sessions content values are immutable');
END`,
  ],
] as const;

function ftsStructureIsValid(database: DatabaseSync): boolean {
  const rows = database
    .prepare(
      `SELECT name, type
       FROM sqlite_schema
       WHERE name = 'sessions_content_fts'
          OR name LIKE 'sessions_content_fts\\_%' ESCAPE '\\'
       ORDER BY name COLLATE BINARY`,
    )
    .all() as readonly Record<string, unknown>[];
  if (
    rows.length !== EXPECTED_FTS_OBJECTS.length ||
    rows.some(
      (row, index) =>
        row.name !== EXPECTED_FTS_OBJECTS[index]?.[0] ||
        row.type !== EXPECTED_FTS_OBJECTS[index]?.[1],
    )
  ) {
    return false;
  }

  // Reading each structural shadow table detects missing or unreadable FTS state
  // without executing FTS5's write-shaped integrity command.
  database.prepare("SELECT 1 FROM sessions_content_fts_data LIMIT 1").get();
  database.prepare("SELECT 1 FROM sessions_content_fts_idx LIMIT 1").get();

  const triggers = database
    .prepare(
      `SELECT name, sql
       FROM sqlite_schema
       WHERE type = 'trigger'
         AND name IN (
           'sessions_content_values_ai',
           'sessions_content_values_bd',
           'sessions_content_values_bu'
         )
       ORDER BY name COLLATE BINARY`,
    )
    .all() as readonly Record<string, unknown>[];
  return (
    triggers.length === EXPECTED_FTS_TRIGGERS.length &&
    triggers.every(
      (row, index) =>
        row.name === EXPECTED_FTS_TRIGGERS[index]?.[0] &&
        row.sql === EXPECTED_FTS_TRIGGERS[index]?.[1],
    )
  );
}

function ftsContentRowsAreConsistent(database: DatabaseSync): boolean {
  const mismatch = database
    .prepare(
      `SELECT 1 AS mismatch
       FROM sessions_content_values AS content
       LEFT JOIN sessions_content_fts_docsize AS indexed
         ON indexed.id = content.content_id
       WHERE indexed.id IS NULL
       UNION ALL
       SELECT 1 AS mismatch
       FROM sessions_content_fts_docsize AS indexed
       LEFT JOIN sessions_content_values AS content
         ON content.content_id = indexed.id
       WHERE content.content_id IS NULL
       LIMIT 1`,
    )
    .get();
  return mismatch === undefined;
}

function inspectFtsSecureDelete(
  database: DatabaseSync,
  required: boolean,
): { readonly healthy: boolean; readonly status: IndexFtsSecureDeleteHealth } {
  try {
    const row = database
      .prepare("SELECT v FROM sessions_content_fts_config WHERE k = 'secure-delete'")
      .get() as { readonly v?: unknown } | undefined;
    if (row?.v === 1) return { healthy: true, status: "enabled" };
    return required
      ? { healthy: false, status: "missing" }
      : { healthy: true, status: "unsupported" };
  } catch {
    return { healthy: false, status: "missing" };
  }
}

interface RunCounts {
  readonly health: IndexHealthCheck;
  readonly active: number;
  readonly interrupted: number;
}

function readRunCounts(database: DatabaseSync): RunCounts {
  try {
    const row = database
      .prepare(
        `SELECT
           coalesce(sum(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active_count,
           coalesce(sum(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END), 0) AS interrupted_count
         FROM sessions_index_runs`,
      )
      .get() as Record<string, unknown> | undefined;
    return {
      health: "ok",
      active: nonNegativeInteger(row?.active_count),
      interrupted: nonNegativeInteger(row?.interrupted_count),
    };
  } catch {
    return { health: "failed", active: 0, interrupted: 0 };
  }
}

function readLeaseHealth(database: DatabaseSync, clock: () => Date): IndexWriterLeaseHealth {
  try {
    const health = readWriterLeaseHealth(database, { now: clock });
    if (health.status === "free") return "free";
    if (health.status === "expired") return "expired";
    return health.purpose === "index" ? "index-live" : "clear-live";
  } catch {
    return "invalid";
  }
}

function check(operation: () => boolean): IndexHealthCheck {
  try {
    return operation() ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    throw new TypeError("Invalid SQLite count");
  }
  if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
  throw new TypeError("Invalid SQLite count");
}

function now(): Date {
  return new Date();
}
