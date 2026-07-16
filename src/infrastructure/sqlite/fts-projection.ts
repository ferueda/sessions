import type { DatabaseSync } from "node:sqlite";

import { runLeasedImmediateTransaction, type WriterLeaseIdentity } from "./writer-lease.ts";

export const SESSIONS_CONTENT_FTS_TABLE = "sessions_content_fts";

const DOCTOR_CONTENT_WINDOW_SIZE = 512;
const DOCTOR_EXPECTED_FTS_TABLE = "sessions_doctor_expected_fts";
const DOCTOR_EXPECTED_VOCAB_TABLE = "sessions_doctor_expected_fts_vocab";
const DOCTOR_ACTUAL_VOCAB_TABLE = "sessions_doctor_actual_fts_vocab";
const SQLITE_INTEGER_MIN = -9_223_372_036_854_775_808n;
const SQLITE_INTEGER_MAX = 9_223_372_036_854_775_807n;

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
  readonly lease: WriterLeaseIdentity;
  readonly now: () => Date;
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
  try {
    return runLeasedImmediateTransaction(database, options.lease, { now: options.now }, () => {
      assertCanonical(options.assertCanonicalIntegrity);

      const before = inspectFtsProjectionSafely(database);
      if (before.structure && before.content && ftsProjectionSemanticContentIsValid(database)) {
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

/** Compare canonical text with the real FTS term and position index without writing main. */
export function ftsProjectionSemanticContentIsValidReadOnly(database: DatabaseSync): boolean {
  let valid = false;
  try {
    database.exec("PRAGMA temp_store = MEMORY");
    if (!tempStorageIsMemory(database)) return false;

    dropDoctorProjection(database);
    database.exec(`CREATE VIRTUAL TABLE temp.${DOCTOR_EXPECTED_FTS_TABLE} USING fts5(
  text,
  content='',
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE temp.${DOCTOR_EXPECTED_VOCAB_TABLE}
USING fts5vocab(temp, ${DOCTOR_EXPECTED_FTS_TABLE}, 'instance');

CREATE VIRTUAL TABLE temp.${DOCTOR_ACTUAL_VOCAB_TABLE}
USING fts5vocab(main, ${SESSIONS_CONTENT_FTS_TABLE}, 'instance');`);

    loadExpectedDoctorProjection(database);
    valid =
      tablesMatchExactly(
        database,
        "main.sessions_content_fts_docsize",
        `temp.${DOCTOR_EXPECTED_FTS_TABLE}_docsize`,
        "id, sz",
      ) &&
      tablesMatchExactly(
        database,
        `temp.${DOCTOR_ACTUAL_VOCAB_TABLE}`,
        `temp.${DOCTOR_EXPECTED_VOCAB_TABLE}`,
        "term, doc, col, offset",
      );
  } catch {
    valid = false;
  } finally {
    try {
      dropDoctorProjection(database);
    } catch {
      valid = false;
    }
  }
  return valid;
}

/** Assert canonical and FTS row presence for the exact content IDs changed by one writer. */
export function assertFtsProjectionContentParityForIds(
  database: DatabaseSync,
  contentIds: readonly bigint[],
): void {
  const statement = database.prepare(
    `SELECT EXISTS (
              SELECT 1
              FROM sessions_content_values
              WHERE content_id = ?
            ) AS canonical_present,
            EXISTS (
              SELECT 1
              FROM sessions_content_fts_docsize
              WHERE id = ?
            ) AS projection_present`,
  );
  statement.setReadBigInts(true);
  for (const contentId of contentIds) {
    assertSqliteInteger(contentId);
    const row = statement.get(contentId, contentId) as Record<string, unknown> | undefined;
    if (
      row === undefined ||
      !booleanInteger(row.canonical_present) ||
      !booleanInteger(row.projection_present) ||
      row.canonical_present !== row.projection_present
    ) {
      throw new Error("SQLite canonical content and FTS projection disagree");
    }
  }
}

function inspectFtsProjectionSafely(database: DatabaseSync): FtsProjectionHealth {
  try {
    return inspectFtsProjection(database);
  } catch {
    return { structure: false, content: false };
  }
}

interface DoctorContentRow {
  readonly content_id: unknown;
  readonly text: unknown;
}

function loadExpectedDoctorProjection(database: DatabaseSync): void {
  const first = database.prepare(
    `SELECT content_id, text
     FROM sessions_content_values
     ORDER BY content_id
     LIMIT ${DOCTOR_CONTENT_WINDOW_SIZE}`,
  );
  const next = database.prepare(
    `SELECT content_id, text
     FROM sessions_content_values
     WHERE content_id > ?
     ORDER BY content_id
     LIMIT ${DOCTOR_CONTENT_WINDOW_SIZE}`,
  );
  first.setReadBigInts(true);
  next.setReadBigInts(true);
  const insert = database.prepare(
    `INSERT INTO temp.${DOCTOR_EXPECTED_FTS_TABLE} (rowid, text)
     VALUES (?, ?)`,
  );

  let cursor: bigint | null = null;
  while (true) {
    const rows = (cursor === null
      ? first.all()
      : next.all(cursor)) as unknown as readonly DoctorContentRow[];
    if (rows.length === 0) return;

    let previous: bigint | null = cursor;
    for (const row of rows) {
      const contentId = row.content_id;
      assertSqliteInteger(contentId);
      if (previous !== null && contentId <= previous) {
        throw new Error("SQLite canonical content IDs are not ordered");
      }
      if (typeof row.text !== "string") {
        throw new Error("SQLite canonical content text is malformed");
      }
      insert.run(contentId, row.text);
      previous = contentId;
    }
    cursor = previous;
  }
}

function tablesMatchExactly(
  database: DatabaseSync,
  left: string,
  right: string,
  columns: string,
): boolean {
  const leftOnly = database
    .prepare(
      `SELECT 1 AS mismatch
       FROM (
         SELECT ${columns} FROM ${left}
         EXCEPT
         SELECT ${columns} FROM ${right}
       )
       LIMIT 1`,
    )
    .get();
  if (leftOnly !== undefined) return false;
  return (
    database
      .prepare(
        `SELECT 1 AS mismatch
         FROM (
           SELECT ${columns} FROM ${right}
           EXCEPT
           SELECT ${columns} FROM ${left}
         )
         LIMIT 1`,
      )
      .get() === undefined
  );
}

function tempStorageIsMemory(database: DatabaseSync): boolean {
  const row = database.prepare("PRAGMA temp_store").get() as
    | { readonly temp_store?: unknown }
    | undefined;
  return row?.temp_store === 2;
}

function dropDoctorProjection(database: DatabaseSync): void {
  database.exec(`DROP TABLE IF EXISTS temp.${DOCTOR_ACTUAL_VOCAB_TABLE};
DROP TABLE IF EXISTS temp.${DOCTOR_EXPECTED_VOCAB_TABLE};
DROP TABLE IF EXISTS temp.${DOCTOR_EXPECTED_FTS_TABLE};`);
}

function assertSqliteInteger(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint" || value < SQLITE_INTEGER_MIN || value > SQLITE_INTEGER_MAX) {
    throw new Error("SQLite content ID is malformed");
  }
}

function booleanInteger(value: unknown): value is 0n | 1n {
  return value === 0n || value === 1n;
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
