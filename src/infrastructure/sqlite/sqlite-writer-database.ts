import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { configureSqlitePageReclamation } from "./sqlite-page-reclamation.ts";

export function openSqliteWriterDatabase(file: string, busyTimeoutMs: number): DatabaseSync {
  return new DatabaseSync(file, writerOptions(busyTimeoutMs));
}

/** Open an existing database without SQLite's default create-if-missing behavior. */
export function openExistingSqliteWriterDatabase(
  file: string,
  busyTimeoutMs: number,
): DatabaseSync {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "rw");
  return new DatabaseSync(url.href, writerOptions(busyTimeoutMs));
}

function writerOptions(
  busyTimeoutMs: number,
): NonNullable<ConstructorParameters<typeof DatabaseSync>[1]> {
  return {
    allowBareNamedParameters: false,
    allowExtension: false,
    allowUnknownNamedParameters: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: busyTimeoutMs,
  };
}

export function configureSqliteWriterDatabase(
  database: DatabaseSync,
  busyTimeoutMs: number,
  options: { readonly initializePageReclamation?: boolean } = {},
): void {
  database.enableDefensive(true);
  database.enableLoadExtension(false);
  // This persistent file-header choice must precede WAL and all schema writes.
  configureSqlitePageReclamation(database, options.initializePageReclamation ?? false);
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
