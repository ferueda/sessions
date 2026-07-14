import type { DatabaseSync } from "node:sqlite";

export type SqliteSessionIndexErrorCode =
  | "corrupt-data"
  | "invalid-run"
  | "invalid-state"
  | "repository-write";

export class SqliteSessionIndexError extends Error {
  readonly code: SqliteSessionIndexErrorCode;

  constructor(code: SqliteSessionIndexErrorCode, options?: { readonly cause?: unknown }) {
    super(
      `SQLite session index operation failed: ${code}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SqliteSessionIndexError";
    this.code = code;
  }
}

export function runImmediateTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (operationError) {
    if (!database.isTransaction) throw operationError;
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [operationError, rollbackError],
        "SQLite session operation and rollback both failed",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}
