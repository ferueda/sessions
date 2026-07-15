import { DatabaseSync } from "node:sqlite";

export interface Fts5SecurityCapability {
  readonly sqliteVersion: string;
  readonly fts5: true;
  readonly secureDelete: boolean;
}

export class Fts5UnavailableError extends Error {
  readonly sqliteVersion: string;

  constructor(sqliteVersion: string) {
    super("SQLite FTS5 is unavailable");
    this.name = "Fts5UnavailableError";
    this.sqliteVersion = sqliteVersion;
  }
}

export class Fts5SecureDeleteConfigurationError extends Error {
  readonly tableName: string;

  constructor(tableName: string, cause: unknown) {
    super("SQLite FTS5 secure-delete could not be enabled for the persistent index", { cause });
    this.name = "Fts5SecureDeleteConfigurationError";
    this.tableName = tableName;
  }
}

export function enableFts5SecureDelete(database: DatabaseSync, tableName: string): boolean {
  const identifier = quoteFts5Identifier(tableName);
  try {
    enableFts5SecureDeleteCommand(database, identifier);
    return true;
  } catch {
    return false;
  }
}

export function configureFts5SecureDelete(
  database: DatabaseSync,
  tableName: string,
  capability: Fts5SecurityCapability,
): boolean {
  if (!capability.secureDelete) return false;
  const identifier = quoteFts5Identifier(tableName);
  try {
    enableFts5SecureDeleteCommand(database, identifier);
    return true;
  } catch (error) {
    // A positive probe means failure here is a persistent-index configuration error,
    // not evidence that this SQLite runtime lacks the feature.
    throw new Fts5SecureDeleteConfigurationError(tableName, error);
  }
}

function quoteFts5Identifier(tableName: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tableName)) {
    throw new TypeError("FTS5 table name must be a simple SQLite identifier");
  }
  return `"${tableName}"`;
}

function enableFts5SecureDeleteCommand(database: DatabaseSync, identifier: string): void {
  database.exec(`INSERT INTO ${identifier} (${identifier}, rank) VALUES ('secure-delete', 1)`);
}

export function probeFts5Security(): Fts5SecurityCapability {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  let sqliteVersion = "unknown";

  try {
    const row = database.prepare("SELECT sqlite_version() AS version").get() as
      | { version?: unknown }
      | undefined;
    if (typeof row?.version === "string") sqliteVersion = row.version;

    try {
      database.exec("CREATE VIRTUAL TABLE sessions_fts5_security_probe USING fts5(content)");
    } catch {
      throw new Fts5UnavailableError(sqliteVersion);
    }

    // Older FTS5 builds can index safely but cannot scrub old index entries.
    const secureDelete = enableFts5SecureDelete(database, "sessions_fts5_security_probe");

    return { sqliteVersion, fts5: true, secureDelete };
  } finally {
    database.close();
  }
}
