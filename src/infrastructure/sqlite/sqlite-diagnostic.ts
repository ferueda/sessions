import type { RuntimeDiagnostic } from "../../application/ports/runtime-diagnostic.ts";
import { Fts5UnavailableError, probeFts5Security } from "./fts5-security.ts";

export function createSqliteDiagnostic(): RuntimeDiagnostic {
  return {
    id: "sqlite-fts5",
    label: "SQLite FTS5",
    run() {
      try {
        const capability = probeFts5Security();
        const secureDelete = capability.secureDelete ? "supported" : "unsupported";

        return {
          ok: true,
          summary: `SQLite ${capability.sqliteVersion} supports FTS5; secure-delete is ${secureDelete}`,
          details: {
            sqliteVersion: capability.sqliteVersion,
            fts5SecureDelete: secureDelete,
          },
        };
      } catch (error) {
        const sqliteVersion =
          error instanceof Fts5UnavailableError ? error.sqliteVersion : "unknown";
        return {
          ok: false,
          summary: "SQLite FTS5 is unavailable",
          details: { sqliteVersion, error: "fts5-unavailable" },
        };
      }
    },
  };
}
