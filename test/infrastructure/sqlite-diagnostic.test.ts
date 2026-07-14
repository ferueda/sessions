import { describe, expect, test } from "vitest";

import { createSqliteDiagnostic } from "../../src/infrastructure/sqlite/sqlite-diagnostic.ts";

describe("createSqliteDiagnostic", () => {
  test("probes the runtime's actual in-memory FTS5 support", async () => {
    const result = await createSqliteDiagnostic().run();

    expect(result).toMatchObject({ ok: true });
    expect(result.details?.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(result.details?.fts5SecureDelete).toMatch(/^(?:supported|unsupported)$/u);
  });
});
