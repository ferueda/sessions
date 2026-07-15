import type { DatabaseSync } from "node:sqlite";

const INCREMENTAL_AUTO_VACUUM_MODE = 2;
const NEW_DATABASE_AUTO_VACUUM_MODE = 0;

export type SqlitePageReclamationHealth = "incremental" | "invalid";

export class SqlitePageReclamationModeError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super(
      "SQLite page reclamation mode is incompatible",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SqlitePageReclamationModeError";
  }
}

export function configureSqlitePageReclamation(database: DatabaseSync, initialize: boolean): void {
  const initialMode = readSqliteAutoVacuumMode(database);
  if (initialize) {
    if (initialMode !== NEW_DATABASE_AUTO_VACUUM_MODE) {
      throw new SqlitePageReclamationModeError();
    }
    try {
      database.exec("PRAGMA auto_vacuum = INCREMENTAL");
    } catch (error) {
      throw new SqlitePageReclamationModeError({ cause: error });
    }
  }
  assertSqlitePageReclamation(database);
}

export function assertSqlitePageReclamation(database: DatabaseSync): void {
  if (readSqliteAutoVacuumMode(database) !== INCREMENTAL_AUTO_VACUUM_MODE) {
    throw new SqlitePageReclamationModeError();
  }
}

export function inspectSqlitePageReclamation(database: DatabaseSync): SqlitePageReclamationHealth {
  try {
    assertSqlitePageReclamation(database);
    return "incremental";
  } catch {
    return "invalid";
  }
}

function readSqliteAutoVacuumMode(database: DatabaseSync): number {
  try {
    const row = database.prepare("PRAGMA auto_vacuum").get();
    const value = row === undefined ? undefined : Object.values(row)[0];
    if (typeof value === "bigint") {
      if (value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
    } else if (Number.isSafeInteger(value) && Number(value) >= 0) {
      return Number(value);
    }
  } catch (error) {
    throw new SqlitePageReclamationModeError({ cause: error });
  }
  throw new SqlitePageReclamationModeError();
}
