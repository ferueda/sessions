import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite FTS projection repair", () => {
  test("an explicit index writer rebuilds damaged FTS state from unchanged canonical content", async () => {
    const paths = await initializedPaths();
    const text = "retained indexed evidence";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      const inserted = database
        .prepare(
          `INSERT INTO sessions_content_values (hash_scheme, digest, text)
           VALUES (?, ?, ?)`,
        )
        .run(contentHash.scheme, contentHash.digest, text);
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(inserted.lastInsertRowid, text);
      database.exec("DROP TRIGGER sessions_content_values_ai");
    });
    const canonicalBefore = readCanonicalRows(paths.database);
    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      canonicalIntegrity: "ok",
      foreignKeys: "ok",
      ftsStructure: "failed",
      ftsContent: "failed",
      ftsRemediation: "rebuild-required",
    });

    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();

    expect(readCanonicalRows(paths.database)).toEqual(canonicalBefore);
    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      canonicalIntegrity: "ok",
      foreignKeys: "ok",
      ftsStructure: "ok",
      ftsContent: "ok",
      ftsRemediation: "not-needed",
    });
    const database = openImmutable(paths.database);
    try {
      expect(
        database
          .prepare(
            `SELECT count(*) AS count
             FROM sessions_content_fts
             WHERE sessions_content_fts MATCH '"indexed"'`,
          )
          .get(),
      ).toMatchObject({ count: 1 });
    } finally {
      database.close();
    }
  });

  test("repairs wrong terms that retain the same FTS row ID", async () => {
    const paths = await initializedPaths();
    const text = "canonical alpha";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      const inserted = database
        .prepare(
          `INSERT INTO sessions_content_values (hash_scheme, digest, text)
           VALUES (?, ?, ?)`,
        )
        .run(contentHash.scheme, contentHash.digest, text);
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(inserted.lastInsertRowid, text);
      database
        .prepare("INSERT INTO sessions_content_fts (rowid, text) VALUES (?, ?)")
        .run(inserted.lastInsertRowid, "poison beta");

      expect(
        database.prepare("SELECT count(*) AS count FROM sessions_content_values").get(),
      ).toEqual({ count: 1 });
      expect(
        database.prepare("SELECT count(*) AS count FROM sessions_content_fts_docsize").get(),
      ).toEqual({ count: 1 });
    });
    const canonicalBefore = readCanonicalRows(paths.database);

    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();

    expect(readCanonicalRows(paths.database)).toEqual(canonicalBefore);
    const database = openImmutable(paths.database);
    try {
      expect(ftsMatchCount(database, "alpha")).toBe(1);
      expect(ftsMatchCount(database, "beta")).toBe(0);
    } finally {
      database.close();
    }
  });

  test("rebuilds an alternate tokenizer without changing canonical content", async () => {
    const paths = await initializedPaths();
    const text = "running evidence";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      database.exec(`DROP TRIGGER sessions_content_values_ai;
DROP TRIGGER sessions_content_values_bd;
DROP TRIGGER sessions_content_values_bu;
DROP TABLE sessions_content_fts;

CREATE VIRTUAL TABLE sessions_content_fts USING fts5(
  text,
  content='sessions_content_values',
  content_rowid='content_id',
  tokenize='porter unicode61'
);

CREATE TRIGGER sessions_content_values_ai
AFTER INSERT ON sessions_content_values
BEGIN
  INSERT INTO sessions_content_fts(rowid, text)
  VALUES (new.content_id, new.text);
END;

CREATE TRIGGER sessions_content_values_bd
BEFORE DELETE ON sessions_content_values
BEGIN
  INSERT INTO sessions_content_fts(sessions_content_fts, rowid, text)
  VALUES ('delete', old.content_id, old.text);
END;

CREATE TRIGGER sessions_content_values_bu
BEFORE UPDATE ON sessions_content_values
BEGIN
  SELECT RAISE(ABORT, 'sessions content values are immutable');
END;`);
      database
        .prepare(
          `INSERT INTO sessions_content_values (hash_scheme, digest, text)
           VALUES (?, ?, ?)`,
        )
        .run(contentHash.scheme, contentHash.digest, text);
    });
    const alternateDefinition = readFtsTableDefinition(paths.database);
    const canonicalBefore = readCanonicalRows(paths.database);
    expect(alternateDefinition).toContain("tokenize='porter unicode61'");
    expect(readFtsMatchCount(paths.database, "run")).toBe(1);

    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      canonicalIntegrity: "ok",
      foreignKeys: "ok",
      ftsStructure: "failed",
      ftsContent: "ok",
      ftsRemediation: "rebuild-required",
    });
    expect(readFtsTableDefinition(paths.database)).toBe(alternateDefinition);

    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();

    expect(readCanonicalRows(paths.database)).toEqual(canonicalBefore);
    expect(readFtsTableDefinition(paths.database))
      .toBe(`CREATE VIRTUAL TABLE sessions_content_fts USING fts5(
  text,
  content='sessions_content_values',
  content_rowid='content_id',
  tokenize='unicode61'
)`);
    expect(readFtsMatchCount(paths.database, "run")).toBe(0);
    expect(readFtsMatchCount(paths.database, "running")).toBe(1);
  });

  test("canonical corruption fails closed without rebuilding the projection", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths.database, (database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      database
        .prepare(
          `INSERT INTO sessions_content_occurrences (
             session_id, entry_ordinal, segment_ordinal, content_id,
             content_class, source_type, origin, confidence, source_metadata_json
           ) VALUES (999, 0, 0, NULL, 'unknown', 'corrupt-fixture', 'unknown', 'unknown', '{}')`,
        )
        .run();
    });

    await expect(createSqliteIndexLifecycle().openWriter(paths)).rejects.toMatchObject({
      code: "canonical-corrupt",
    });
    const database = openImmutable(paths.database);
    try {
      expect(
        database
          .prepare(
            `SELECT 1
             FROM sqlite_schema
             WHERE type = 'trigger' AND name = 'sessions_content_values_ai'`,
          )
          .get(),
      ).toBeDefined();
    } finally {
      database.close();
    }
  });
});

async function initializedPaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-fts-repair-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "sessions");
  const database = path.join(directory, "sessions.sqlite3");
  const paths: IndexPaths = {
    directory,
    scratch: path.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
  const writer = await createSqliteIndexLifecycle().openWriter(paths);
  await writer.close();
  return paths;
}

const CANONICAL_TABLES = [
  "sessions_library",
  "sessions_source_instances",
  "sessions_session_tracking",
  "sessions_canonical_sessions",
  "sessions_relations",
  "sessions_entries",
  "sessions_content_values",
  "sessions_content_occurrences",
] as const;

function readCanonicalRows(file: string): Readonly<Record<string, readonly unknown[]>> {
  const database = openImmutable(file);
  try {
    return Object.fromEntries(
      CANONICAL_TABLES.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ]),
    );
  } finally {
    database.close();
  }
}

function openImmutable(file: string): DatabaseSync {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, { readOnly: true });
}

function ftsMatchCount(database: DatabaseSync, text: string): number {
  const row = database
    .prepare(
      `SELECT count(*) AS count
       FROM sessions_content_fts
       WHERE sessions_content_fts MATCH ?`,
    )
    .get(text) as { readonly count: number };
  return row.count;
}

function readFtsMatchCount(file: string, text: string): number {
  const database = openImmutable(file);
  try {
    return ftsMatchCount(database, text);
  } finally {
    database.close();
  }
}

function readFtsTableDefinition(file: string): string {
  const database = openImmutable(file);
  try {
    const row = database
      .prepare("SELECT sql FROM sqlite_schema WHERE name = 'sessions_content_fts'")
      .get() as { readonly sql?: unknown } | undefined;
    if (typeof row?.sql !== "string") throw new Error("Expected FTS table definition");
    return row.sql;
  } finally {
    database.close();
  }
}

function mutateDatabase(file: string, mutate: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(file);
  try {
    mutate(database);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec("PRAGMA journal_mode = DELETE");
  } finally {
    database.close();
  }
}
