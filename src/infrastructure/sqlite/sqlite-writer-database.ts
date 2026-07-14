import { DatabaseSync } from "node:sqlite";

export function openSqliteWriterDatabase(file: string, busyTimeoutMs: number): DatabaseSync {
  return new DatabaseSync(file, {
    allowBareNamedParameters: false,
    allowExtension: false,
    allowUnknownNamedParameters: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: busyTimeoutMs,
  });
}

export function configureSqliteWriterDatabase(database: DatabaseSync, busyTimeoutMs: number): void {
  database.enableDefensive(true);
  database.enableLoadExtension(false);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA trusted_schema = OFF");
  database.exec("PRAGMA secure_delete = ON");

  const journalMode = pragmaValue(database, "PRAGMA journal_mode = WAL");
  if (journalMode !== "wal") throw new Error("SQLite WAL mode is unavailable");
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
}

function pragmaValue(database: DatabaseSync, sql: string): string | number | null {
  const row = database.prepare(sql).get();
  if (row === undefined) return null;
  const value = Object.values(row)[0];
  return typeof value === "string" || typeof value === "number" ? value : null;
}
