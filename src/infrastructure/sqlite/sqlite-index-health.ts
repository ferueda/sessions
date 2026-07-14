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
import { readCanonicalDocument } from "./sqlite-session-document.ts";
import { readSessionFreshness, readSessionSummary } from "./sqlite-session-state.ts";
import { isSessionIdentity } from "../../domain/session-identity.ts";

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
  const canonicalIntegrity = check(() => canonicalIntegrityIsValid(database));
  const foreignKeys = check(() => foreignKeysAreValid(database));
  const ftsStructure = check(() => ftsStructureIsValid(database));
  const ftsContent = check(() => ftsContentRowsAreConsistent(database));
  const ftsSecureDelete = inspectFtsSecureDelete(database, fts5SecureDeleteRequired);
  const ftsRemediation =
    ftsStructure === "ok" && ftsContent === "ok" && ftsSecureDelete.healthy
      ? "not-needed"
      : "rebuild-required";
  const runs = readRunCounts(database);
  const writerLease = readLeaseHealth(database, clock);
  const activeRunHasLiveIndexLease = runs.active === 0 || writerLease === "index-live";
  const ok =
    canonicalIntegrity === "ok" &&
    foreignKeys === "ok" &&
    ftsStructure === "ok" &&
    ftsContent === "ok" &&
    ftsSecureDelete.healthy &&
    runs.health === "ok" &&
    writerLease !== "invalid" &&
    activeRunHasLiveIndexLease;

  return Object.freeze({
    ok,
    canonicalIntegrity,
    foreignKeys,
    ftsStructure,
    ftsContent,
    ftsSecureDelete: ftsSecureDelete.status,
    ftsRemediation,
    runRecords: runs.health,
    writerLease,
    activeRuns: runs.active,
    interruptedRuns: runs.interrupted,
  });
}

function canonicalIntegrityIsValid(database: DatabaseSync): boolean {
  return sourceInstancesAreValid(database) && sessionTrackingIsValid(database);
}

function sourceInstancesAreValid(database: DatabaseSync): boolean {
  const rows = database
    .prepare(
      `SELECT source_instance_id, kind, instance_id, coverage_status, coverage_observed_at
       FROM sessions_source_instances
       ORDER BY source_instance_id`,
    )
    .all() as readonly Record<string, unknown>[];
  return rows.every((row) => {
    nonNegativeInteger(row.source_instance_id);
    // Reuse the public identity grammar to validate a source tuple with a fixed valid native ID.
    return (
      isSessionIdentity({
        source: { kind: row.kind, instanceId: row.instance_id },
        nativeId: "health-check",
      }) &&
      (row.coverage_status === "complete" || row.coverage_status === "unknown") &&
      optionalCanonicalTimestampIsValid(row.coverage_observed_at) &&
      (row.coverage_status !== "complete" || row.coverage_observed_at !== null)
    );
  });
}

function sessionTrackingIsValid(database: DatabaseSync): boolean {
  const rows = database
    .prepare(
      `SELECT tracking.session_id,
              tracking.source_instance_id,
              tracking.native_id,
              tracking.presence_status,
              tracking.presence_observed_at,
              tracking.captured_at,
              tracking.last_seen_at,
              source.kind,
              source.instance_id
       FROM sessions_session_tracking AS tracking
       LEFT JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       ORDER BY tracking.session_id`,
    )
    .all() as readonly Record<string, unknown>[];
  for (const row of rows) {
    const sessionId = nonNegativeInteger(row.session_id);
    nonNegativeInteger(row.source_instance_id);
    const identity = {
      source: { kind: row.kind, instanceId: row.instance_id },
      nativeId: row.native_id,
    };
    if (!isSessionIdentity(identity)) return false;
    if (
      (row.presence_status !== "present" && row.presence_status !== "missing") ||
      !optionalCanonicalTimestampIsValid(row.presence_observed_at) ||
      !optionalCanonicalTimestampIsValid(row.captured_at) ||
      !optionalCanonicalTimestampIsValid(row.last_seen_at)
    ) {
      return false;
    }

    const freshness = readSessionFreshness(database, identity);
    const document = readCanonicalDocument(database, identity, sessionId);
    const summary = readSessionSummary(database, identity);
    if (freshness.status === "current" || freshness.status === "stale") {
      if (document === undefined || summary === undefined) return false;
      continue;
    }
    // First-seen failures and legacy removals legitimately retain tracking without a document.
    if (freshness.status === "untracked" || document !== undefined || summary !== undefined) {
      return false;
    }
    if (row.captured_at !== null) return false;
    if (freshness.status === "removed" && row.presence_status !== "missing") return false;
    if (freshness.status === "unindexed" && row.presence_status !== "present") return false;
  }
  return true;
}

function optionalCanonicalTimestampIsValid(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
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
    if (
      database
        .prepare(
          `SELECT 1 AS invalid
           FROM sessions_index_runs AS run
           WHERE run.discovered_count <> run.unchanged_count + run.indexed_count + run.failed_count
              OR run.stale_count > run.failed_count
              OR run.failed_count + run.missing_count + run.removed_count <>
                 run.omitted_item_count + (
                   SELECT COUNT(*)
                   FROM sessions_index_run_items AS item
                   WHERE item.run_id = run.run_id
                 )
           LIMIT 1`,
        )
        .get() !== undefined
    ) {
      return { health: "failed", active: 0, interrupted: 0 };
    }
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
    if (health.purpose === "index") return "index-live";
    if (health.purpose === "forget") return "forget-live";
    return "clear-live";
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
