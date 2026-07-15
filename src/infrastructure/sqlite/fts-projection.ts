import type { DatabaseSync } from "node:sqlite";

import { runImmediateTransaction } from "./sqlite-session-transaction.ts";

export const SESSIONS_CONTENT_FTS_TABLE = "sessions_content_fts";

export const FTS_PROJECTION_OBJECTS = [
  [SESSIONS_CONTENT_FTS_TABLE, "table"],
  ["sessions_content_fts_config", "table"],
  ["sessions_content_fts_data", "table"],
  ["sessions_content_fts_docsize", "table"],
  ["sessions_content_fts_idx", "table"],
] as const;

export const FTS_PROJECTION_TRIGGERS = [
  {
    name: "sessions_content_values_ai",
    sql: `CREATE TRIGGER sessions_content_values_ai
AFTER INSERT ON sessions_content_values
BEGIN
  INSERT INTO sessions_content_fts(rowid, text)
  VALUES (new.content_id, new.text);
END`,
  },
  {
    name: "sessions_content_values_bd",
    sql: `CREATE TRIGGER sessions_content_values_bd
BEFORE DELETE ON sessions_content_values
BEGIN
  INSERT INTO sessions_content_fts(sessions_content_fts, rowid, text)
  VALUES ('delete', old.content_id, old.text);
END`,
  },
  {
    name: "sessions_content_values_bu",
    sql: `CREATE TRIGGER sessions_content_values_bu
BEFORE UPDATE ON sessions_content_values
BEGIN
  SELECT RAISE(ABORT, 'sessions content values are immutable');
END`,
  },
] as const;

export const FTS_PROJECTION_TABLE_SQL = `CREATE VIRTUAL TABLE sessions_content_fts USING fts5(
  text,
  content='sessions_content_values',
  content_rowid='content_id',
  tokenize='unicode61'
)`;

export const FTS_PROJECTION_SCHEMA_SQL = `${FTS_PROJECTION_TABLE_SQL};

${FTS_PROJECTION_TRIGGERS.map(({ sql }) => `${sql};`).join("\n\n")}`;

export interface FtsProjectionHealth {
  readonly structure: boolean;
  readonly content: boolean;
}

export interface RepairFtsProjectionOptions {
  readonly assertCanonicalIntegrity: () => void;
  readonly assertWriterLease: () => void;
}

export class SqliteFtsProjectionRepairError extends Error {
  readonly code: "canonical-corrupt" | "projection-repair-failed";

  constructor(
    code: "canonical-corrupt" | "projection-repair-failed",
    options?: { readonly cause?: unknown },
  ) {
    super(
      `SQLite FTS projection recovery failed: ${code}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SqliteFtsProjectionRepairError";
    this.code = code;
  }
}

export function inspectFtsProjection(database: DatabaseSync): FtsProjectionHealth {
  return {
    structure: ftsProjectionStructureIsValid(database),
    content: ftsProjectionContentIsValid(database),
  };
}

/** Rebuild only derived FTS state while an explicit index writer owns the lease. */
export function repairFtsProjection(
  database: DatabaseSync,
  options: RepairFtsProjectionOptions,
): boolean {
  assertCanonical(options.assertCanonicalIntegrity);

  try {
    return runImmediateTransaction(database, () => {
      options.assertWriterLease();
      assertCanonical(options.assertCanonicalIntegrity);

      const before = inspectFtsProjectionSafely(database);
      if (before.structure && before.content && ftsProjectionSemanticContentIsValid(database)) {
        options.assertWriterLease();
        return false;
      }

      dropFtsProjection(database);
      database.exec(FTS_PROJECTION_SCHEMA_SQL);
      database.exec(
        `INSERT INTO sessions_content_fts (sessions_content_fts)
         VALUES ('rebuild')`,
      );
      const repaired = inspectFtsProjection(database);
      if (
        !repaired.structure ||
        !repaired.content ||
        !ftsProjectionSemanticContentIsValid(database)
      ) {
        throw new SqliteFtsProjectionRepairError("projection-repair-failed");
      }
      assertCanonical(options.assertCanonicalIntegrity);
      options.assertWriterLease();
      return true;
    });
  } catch (error) {
    if (error instanceof SqliteFtsProjectionRepairError) throw error;
    throw new SqliteFtsProjectionRepairError("projection-repair-failed", { cause: error });
  }
}

export function ftsProjectionStructureIsValid(database: DatabaseSync): boolean {
  const rows = database
    .prepare(
      `SELECT name, type, sql
       FROM sqlite_schema
       WHERE name = 'sessions_content_fts'
          OR name LIKE 'sessions_content_fts\\_%' ESCAPE '\\'
       ORDER BY name COLLATE BINARY`,
    )
    .all() as readonly Record<string, unknown>[];
  if (
    rows.length !== FTS_PROJECTION_OBJECTS.length ||
    rows.some(
      (row, index) =>
        row.name !== FTS_PROJECTION_OBJECTS[index]?.[0] ||
        row.type !== FTS_PROJECTION_OBJECTS[index]?.[1],
    )
  ) {
    return false;
  }
  if (rows[0]?.sql !== FTS_PROJECTION_TABLE_SQL) return false;

  // These reads catch missing or unreadable shadow state without a write-shaped
  // FTS integrity command in immutable doctor snapshots.
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
    triggers.length === FTS_PROJECTION_TRIGGERS.length &&
    triggers.every(
      (row, index) =>
        row.name === FTS_PROJECTION_TRIGGERS[index]?.name &&
        row.sql === FTS_PROJECTION_TRIGGERS[index]?.sql,
    )
  );
}

export function ftsProjectionContentIsValid(database: DatabaseSync): boolean {
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

function inspectFtsProjectionSafely(database: DatabaseSync): FtsProjectionHealth {
  try {
    return inspectFtsProjection(database);
  } catch {
    return { structure: false, content: false };
  }
}

function ftsProjectionSemanticContentIsValid(database: DatabaseSync): boolean {
  try {
    // Rank 1 compares every indexed token against the external canonical content.
    // This write-shaped FTS command stays inside the leased writer transaction.
    database.exec(
      `INSERT INTO ${SESSIONS_CONTENT_FTS_TABLE} (${SESSIONS_CONTENT_FTS_TABLE}, rank)
       VALUES ('integrity-check', 1)`,
    );
    return true;
  } catch {
    return false;
  }
}

function assertCanonical(assertion: () => void): void {
  try {
    assertion();
  } catch (error) {
    throw new SqliteFtsProjectionRepairError("canonical-corrupt", { cause: error });
  }
}

function dropFtsProjection(database: DatabaseSync): void {
  for (const { name } of FTS_PROJECTION_TRIGGERS) {
    database.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  database.exec(`DROP TABLE IF EXISTS ${SESSIONS_CONTENT_FTS_TABLE}`);
  // Normal virtual-table deletion removes these shadows. Explicit cleanup also
  // recovers a partially missing main table left by external damage.
  for (const [name] of FTS_PROJECTION_OBJECTS.slice(1).toReversed()) {
    database.exec(`DROP TABLE IF EXISTS ${name}`);
  }
}
