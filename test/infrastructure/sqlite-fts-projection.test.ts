import { constants, DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  assertFtsProjectionContentParityForIds,
  FTS_PROJECTION_SCHEMA_SQL,
  ftsProjectionSemanticContentIsValidReadOnly,
} from "../../src/infrastructure/sqlite/fts-projection.ts";

const ABOVE_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
const SQLITE_INTEGER_MAX = 9_223_372_036_854_775_807n;
const DOCTOR_EXPECTED_FTS_TABLE = "sessions_doctor_expected_fts";
const ORACLE_EXPECTED_FTS_TABLE = "sessions_test_oracle_expected_fts";
const ORACLE_EXPECTED_VOCAB_TABLE = "sessions_test_oracle_expected_fts_vocab";
const ORACLE_ACTUAL_VOCAB_TABLE = "sessions_test_oracle_actual_fts_vocab";

describe("SQLite FTS projection invariants", () => {
  test("compares complete semantic content across signed-ID keyset windows and cleans TEMP state", () => {
    const database = createProjectionDatabase();
    try {
      const insert = database.prepare(
        "INSERT INTO sessions_content_values (content_id, text) VALUES (?, ?)",
      );
      insert.run(-1n, "negative common evidence");
      insert.run(0n, "zero common evidence");
      for (let id = 1n; id <= 510n; id += 1n) {
        insert.run(id, id === 510n ? "!!!" : `common evidence token${id}`);
      }
      insert.run(ABOVE_SAFE_INTEGER, "outside safe integer");
      insert.run(SQLITE_INTEGER_MAX, "signed integer maximum");

      expect(ftsProjectionSemanticContentIsValidReadOnly(database)).toBe(true);
      expect(readDoctorTempObjects(database)).toEqual([]);
      expect(database.prepare("PRAGMA temp_store").get()).toEqual({ temp_store: 2 });
      expect(database.isTransaction).toBe(false);

      expect(ftsProjectionSemanticContentIsValidReadOnly(database)).toBe(true);
      expect(readDoctorTempObjects(database)).toEqual([]);
      expect(database.isTransaction).toBe(false);
    } finally {
      database.close();
    }
  });

  test("composes the expected FTS load with an outer transaction", () => {
    const database = createProjectionDatabase();
    try {
      insertContent(database, 1n, "canonical evidence");
      database.exec("BEGIN");

      expect(ftsProjectionSemanticContentIsValidReadOnly(database)).toBe(true);
      expect(database.isTransaction).toBe(true);
      expect(readDoctorTempObjects(database)).toEqual([]);

      database.exec("ROLLBACK");
      expect(database.isTransaction).toBe(false);
      expect(readDoctorTempObjects(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("partitions exact comparison by UTF-8 term order and keeps an oversized term whole", () => {
    const database = createProjectionDatabase();
    try {
      insertContent(database, 1n, "alpha alpha beta ａ 𐀀 𐀀 𐀀 𐀀");
      const rangeInstances: bigint[] = [];

      const bounded = ftsProjectionSemanticContentIsValidReadOnly(database, {
        maxTermInstances: 3n,
        observeTermRange: (instances) => rangeInstances.push(instances),
      });

      expect(bounded).toBe(true);
      expect(bounded).toBe(wholeVocabularySemanticContentIsValid(database));
      expect(rangeInstances).toEqual([3n, 1n, 4n]);
      expect(readDoctorTempObjects(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("fails closed for invalid internal term-range targets", () => {
    const database = createProjectionDatabase();
    try {
      insertContent(database, 1n, "canonical evidence");

      expect(ftsProjectionSemanticContentIsValidReadOnly(database, { maxTermInstances: 0n })).toBe(
        false,
      );
      expect(
        ftsProjectionSemanticContentIsValidReadOnly(database, {
          maxTermInstances: 1 as unknown as bigint,
        }),
      ).toBe(false);
      expect(readDoctorTempObjects(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("rolls back a partial expected FTS load before failure cleanup", () => {
    const database = createProjectionDatabase({ textType: "BLOB" });
    try {
      insertContent(database, 1n, "valid first row");
      database
        .prepare("INSERT INTO sessions_content_values (content_id, text) VALUES (?, ?)")
        .run(2n, new Uint8Array([1, 2, 3]));

      expect(ftsProjectionSemanticContentIsValidReadOnly(database)).toBe(false);
      expect(database.isTransaction).toBe(false);
      expect(readDoctorTempObjects(database)).toEqual([]);

      // Keep the expected table after a second failed load so its post-savepoint
      // contents can prove that the valid first row was rolled back.
      database.setAuthorizer((action, name, _argument, schema) =>
        action === constants.SQLITE_DROP_VTABLE &&
        name === DOCTOR_EXPECTED_FTS_TABLE &&
        schema === "temp"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );

      expect(ftsProjectionSemanticContentIsValidReadOnly(database)).toBe(false);
      database.setAuthorizer(null);

      expect(database.isTransaction).toBe(false);
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM temp.${DOCTOR_EXPECTED_FTS_TABLE}`).get(),
      ).toEqual({ count: 0 });

      database.exec(`DROP TABLE temp.${DOCTOR_EXPECTED_FTS_TABLE}`);
      expect(readDoctorTempObjects(database)).toEqual([]);
    } finally {
      database.setAuthorizer(null);
      database.close();
    }
  });

  test.each([
    {
      name: "wrong terms with the same token count",
      canonical: "alpha beta alpha",
      indexed: "alpha poison alpha",
    },
    {
      name: "the same terms at different offsets",
      canonical: "alpha beta gamma",
      indexed: "alpha gamma beta",
    },
    {
      name: "different counts for the same term universe",
      canonical: "alpha alpha beta",
      indexed: "alpha beta beta",
    },
    {
      name: "an unexpected term for zero-token canonical text",
      canonical: "!!!",
      indexed: "unexpected",
    },
  ])("detects $name", ({ canonical, indexed }) => {
    const database = createProjectionDatabase();
    try {
      insertContent(database, ABOVE_SAFE_INTEGER, canonical);
      replaceIndexedText(database, ABOVE_SAFE_INTEGER, canonical, indexed);

      const bounded = ftsProjectionSemanticContentIsValidReadOnly(database, {
        maxTermInstances: 1n,
      });
      expect(bounded).toBe(wholeVocabularySemanticContentIsValid(database));
      expect(bounded).toBe(false);
      expect(readDoctorTempObjects(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("detects cross-document position damage with matching vocabulary counts and docsize", () => {
    const database = createProjectionDatabase();
    try {
      insertContent(database, 1n, "alpha beta");
      insertContent(database, 2n, "gamma delta");
      replaceIndexedText(database, 1n, "alpha beta", "alpha delta");
      replaceIndexedText(database, 2n, "gamma delta", "gamma beta");

      const bounded = ftsProjectionSemanticContentIsValidReadOnly(database, {
        maxTermInstances: 1n,
      });
      expect(bounded).toBe(wholeVocabularySemanticContentIsValid(database));
      expect(bounded).toBe(false);
      expect(readDoctorTempObjects(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("detects docsize-only shadow damage", () => {
    const database = createProjectionDatabase();
    try {
      insertContent(database, 1n, "alpha beta");
      database.enableDefensive(false);
      database
        .prepare("UPDATE sessions_content_fts_docsize SET sz = ? WHERE id = ?")
        .run(new Uint8Array([1]), 1n);

      const bounded = ftsProjectionSemanticContentIsValidReadOnly(database, {
        maxTermInstances: 1n,
      });
      expect(bounded).toBe(wholeVocabularySemanticContentIsValid(database));
      expect(bounded).toBe(false);
      expect(readDoctorTempObjects(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("asserts affected canonical and FTS presence for full signed IDs", () => {
    const database = createProjectionDatabase();
    try {
      const ids = [-1n, 0n, ABOVE_SAFE_INTEGER, SQLITE_INTEGER_MAX] as const;
      for (const id of ids) insertContent(database, id, `content ${id}`);

      expect(() => assertFtsProjectionContentParityForIds(database, ids)).not.toThrow();

      database.prepare("DELETE FROM sessions_content_values WHERE content_id = ?").run(-1n);
      expect(() => assertFtsProjectionContentParityForIds(database, [-1n])).not.toThrow();
    } finally {
      database.close();
    }
  });

  test("rejects missing, extra, and malformed affected content parity", () => {
    const database = createProjectionDatabase();
    try {
      insertContent(database, ABOVE_SAFE_INTEGER, "canonical evidence");
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(ABOVE_SAFE_INTEGER, "canonical evidence");
      expect(() => assertFtsProjectionContentParityForIds(database, [ABOVE_SAFE_INTEGER])).toThrow(
        /canonical content and FTS projection disagree/u,
      );

      database
        .prepare("INSERT INTO sessions_content_fts (rowid, text) VALUES (?, ?)")
        .run(SQLITE_INTEGER_MAX, "projection only");
      expect(() => assertFtsProjectionContentParityForIds(database, [SQLITE_INTEGER_MAX])).toThrow(
        /canonical content and FTS projection disagree/u,
      );

      expect(() =>
        assertFtsProjectionContentParityForIds(database, [0 as unknown as bigint]),
      ).toThrow(/content ID is malformed/u);
    } finally {
      database.close();
    }
  });
});

function createProjectionDatabase(
  options: { readonly textType?: "TEXT" | "BLOB" } = {},
): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const textType = options.textType ?? "TEXT";
  database.exec(`CREATE TABLE sessions_content_values (
  content_id INTEGER PRIMARY KEY,
  text ${textType} NOT NULL COLLATE BINARY
)${textType === "TEXT" ? " STRICT" : ""};

${FTS_PROJECTION_SCHEMA_SQL};`);
  return database;
}

function insertContent(database: DatabaseSync, id: bigint, text: string): void {
  database
    .prepare("INSERT INTO sessions_content_values (content_id, text) VALUES (?, ?)")
    .run(id, text);
}

function replaceIndexedText(
  database: DatabaseSync,
  id: bigint,
  canonical: string,
  indexed: string,
): void {
  database
    .prepare(
      `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
       VALUES ('delete', ?, ?)`,
    )
    .run(id, canonical);
  database.prepare("INSERT INTO sessions_content_fts (rowid, text) VALUES (?, ?)").run(id, indexed);
}

function readDoctorTempObjects(database: DatabaseSync): readonly Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT name, type
       FROM temp.sqlite_schema
       WHERE name LIKE 'sessions_doctor_%'
       ORDER BY name`,
    )
    .all();
}

function wholeVocabularySemanticContentIsValid(database: DatabaseSync): boolean {
  let valid = false;
  try {
    dropOracleProjection(database);
    database.exec(`CREATE VIRTUAL TABLE temp.${ORACLE_EXPECTED_FTS_TABLE} USING fts5(
  text,
  content='',
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE temp.${ORACLE_EXPECTED_VOCAB_TABLE}
USING fts5vocab(temp, ${ORACLE_EXPECTED_FTS_TABLE}, 'instance');

CREATE VIRTUAL TABLE temp.${ORACLE_ACTUAL_VOCAB_TABLE}
USING fts5vocab(main, sessions_content_fts, 'instance');`);

    const rowsStatement = database.prepare(
      `SELECT content_id, text
       FROM sessions_content_values
       ORDER BY content_id`,
    );
    rowsStatement.setReadBigInts(true);
    const insert = database.prepare(
      `INSERT INTO temp.${ORACLE_EXPECTED_FTS_TABLE} (rowid, text)
       VALUES (?, ?)`,
    );
    const rows = rowsStatement.all() as unknown as readonly {
      readonly content_id: unknown;
      readonly text: unknown;
    }[];
    for (const row of rows) {
      if (typeof row.content_id !== "bigint" || typeof row.text !== "string") {
        throw new Error("Malformed whole-vocabulary oracle fixture");
      }
      insert.run(row.content_id, row.text);
    }

    valid =
      oracleTablesMatchExactly(
        database,
        "main.sessions_content_fts_docsize",
        `temp.${ORACLE_EXPECTED_FTS_TABLE}_docsize`,
        "id, sz",
      ) &&
      oracleTablesMatchExactly(
        database,
        `temp.${ORACLE_ACTUAL_VOCAB_TABLE}`,
        `temp.${ORACLE_EXPECTED_VOCAB_TABLE}`,
        "term, doc, col, offset",
      );
  } catch {
    valid = false;
  } finally {
    try {
      dropOracleProjection(database);
    } catch {
      valid = false;
    }
  }
  return valid;
}

function oracleTablesMatchExactly(
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

function dropOracleProjection(database: DatabaseSync): void {
  database.exec(`DROP TABLE IF EXISTS temp.${ORACLE_ACTUAL_VOCAB_TABLE};
DROP TABLE IF EXISTS temp.${ORACLE_EXPECTED_VOCAB_TABLE};
DROP TABLE IF EXISTS temp.${ORACLE_EXPECTED_FTS_TABLE};`);
}
