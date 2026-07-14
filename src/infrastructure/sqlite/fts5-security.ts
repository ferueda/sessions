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

export function enableFts5SecureDelete(database: DatabaseSync, tableName: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(tableName)) {
    throw new TypeError("FTS5 table name must be a simple SQLite identifier");
  }

  const identifier = `"${tableName}"`;
  try {
    database.exec(`INSERT INTO ${identifier} (${identifier}, rank) VALUES ('secure-delete', 1)`);
    return true;
  } catch {
    return false;
  }
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
