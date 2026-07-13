import { DatabaseSync } from "node:sqlite";

import type { RuntimeDiagnostic } from "../../application/ports/runtime-diagnostic.ts";

export function createSqliteDiagnostic(): RuntimeDiagnostic {
  return {
    id: "sqlite-fts5",
    label: "SQLite FTS5",
    run() {
      let database: DatabaseSync | undefined;
      let sqliteVersion = "unknown";

      try {
        database = new DatabaseSync(":memory:");
        const row = database.prepare("SELECT sqlite_version() AS version").get() as
          | { version?: unknown }
          | undefined;
        if (typeof row?.version === "string") sqliteVersion = row.version;

        database.exec("CREATE VIRTUAL TABLE sessions_doctor_fts USING fts5(content)");

        return {
          ok: true,
          summary: `SQLite ${sqliteVersion} supports FTS5`,
          details: { sqliteVersion },
        };
      } catch {
        return {
          ok: false,
          summary: "SQLite FTS5 is unavailable",
          details: { sqliteVersion, error: "fts5-unavailable" },
        };
      } finally {
        database?.close();
      }
    },
  };
}
