import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { createSqliteIndexMaintenance } from "../../src/infrastructure/sqlite/index-maintenance.ts";
import { encodeSqliteContentDigest } from "../../src/infrastructure/sqlite/sqlite-content-digest.ts";
import { readWriterLeaseHealth } from "../../src/infrastructure/sqlite/writer-lease.ts";
import {
  publishWriterCleanProof,
  readWriterCleanProof,
} from "../../src/infrastructure/sqlite/writer-clean-proof.ts";

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
      const contentId = insertContent(database, contentHash.digest, text);
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(contentId, text);
      database.exec("DROP TRIGGER sessions_content_values_ai");
    });
    const canonicalBefore = readCanonicalRows(paths.database);
    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      canonicalIntegrity: "ok",
      foreignKeys: "ok",
      contentReachability: "orphaned",
      orphanContentRows: "1",
      ftsStructure: "failed",
      ftsContent: "failed",
      ftsRemediation: "rebuild-required",
    });

    const clock = sequencedClock([
      "2026-07-14T12:00:00.000Z",
      "2026-07-14T12:00:20.000Z",
      "2026-07-14T12:01:00.000Z",
    ]);
    const writer = await createSqliteIndexLifecycle({
      now: clock.now,
      writerToken: () => "cross-expiry-repair-owner",
    }).openWriter(paths);
    expect(clock.reads().slice(0, 3)).toEqual([
      "2026-07-14T12:00:00.000Z",
      "2026-07-14T12:00:20.000Z",
      "2026-07-14T12:01:00.000Z",
    ]);
    expect(readWriterLeaseHealth(writer.database, { now: clock.now })).toMatchObject({
      status: "live",
      generation: 2,
      heartbeatAt: "2026-07-14T12:01:00.000Z",
      expiresAt: "2026-07-14T12:01:30.000Z",
    });
    await writer.close();

    expect(readCanonicalRows(paths.database)).toEqual(canonicalBefore);
    expectCanonicalDuplicateGuard(paths.database, contentHash.digest, text);
    await expect(createSqliteIndexLifecycle().inspectHealth(paths)).resolves.toMatchObject({
      ok: false,
      canonicalIntegrity: "ok",
      foreignKeys: "ok",
      contentReachability: "orphaned",
      orphanContentRows: "1",
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
      const contentId = insertContent(database, contentHash.digest, text);
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(contentId, text);
      database
        .prepare("INSERT INTO sessions_content_fts (rowid, text) VALUES (?, ?)")
        .run(contentId, "poison beta");

      expect(
        database.prepare("SELECT count(*) AS count FROM sessions_content_values").get(),
      ).toEqual({ count: 1 });
      expect(
        database.prepare("SELECT count(*) AS count FROM sessions_content_fts_docsize").get(),
      ).toEqual({ count: 1 });
    });
    const canonicalBefore = readCanonicalRows(paths.database);
    await expect(readWriterCleanProof(paths.database)).resolves.toBeUndefined();

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

  test("uses the full repair path after conservative maintenance", async () => {
    const paths = await initializedPaths();
    const priorProof = await readWriterCleanProof(paths.database);
    expect(priorProof).toBeDefined();
    if (priorProof === undefined) throw new Error("Expected the initial clean proof");

    await expect(createSqliteIndexMaintenance().compact(paths)).resolves.toMatchObject({
      outcome: "unchanged",
    });
    const afterMaintenance = openImmutable(paths.database);
    try {
      expect(afterMaintenance.prepare("SELECT * FROM sessions_writer_lease").get()).toMatchObject({
        generation: priorProof.writerGeneration + 1,
        clean_generation: priorProof.writerGeneration,
        purpose: null,
      });
    } finally {
      afterMaintenance.close();
    }

    const text = "canonical maintenance alpha";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      const contentId = insertContent(database, contentHash.digest, text);
      poisonFtsTerms(database, contentId, text, "poison maintenance beta");
    });
    await publishWriterCleanProof(paths.database, {
      libraryInstanceId: priorProof.libraryInstanceId,
      writerGeneration: priorProof.writerGeneration,
      schemaVersion: priorProof.schemaVersion,
      schemaCookie: priorProof.schemaCookie,
    });
    await expect(readWriterCleanProof(paths.database)).resolves.toMatchObject({
      writerGeneration: priorProof.writerGeneration,
    });

    const writer = await createSqliteIndexLifecycle().openWriter(paths);
    await writer.close();

    expect(readFtsMatchCount(paths.database, "alpha")).toBe(1);
    expect(readFtsMatchCount(paths.database, "beta")).toBe(0);
  });

  test("uses the full repair path when WAL recovery state accompanies a clean proof", async () => {
    const paths = await initializedPaths();
    const external = new DatabaseSync(paths.database);
    try {
      external.exec("PRAGMA wal_autocheckpoint = 0");
      const text = "canonical recovery alpha";
      const contentHash = hashContent(text);
      const contentId = insertContent(external, contentHash.digest, text);
      poisonFtsTerms(external, contentId, text, "poison recovery beta");

      await expect(lstat(paths.wal)).resolves.toMatchObject({ isFile: expect.any(Function) });
      await expect(lstat(paths.shm)).resolves.toMatchObject({ isFile: expect.any(Function) });
      await expect(readWriterCleanProof(paths.database)).resolves.toBeDefined();

      const writer = await createSqliteIndexLifecycle().openWriter(paths);
      expect(ftsMatchCount(writer.database, "alpha")).toBe(1);
      expect(ftsMatchCount(writer.database, "beta")).toBe(0);
      external.close();
      await writer.close();
    } finally {
      if (external.isOpen) external.close();
    }
  });

  test("falls back to same-open repair when the fast structure probe throws", async () => {
    const paths = await initializedPaths();
    const cleanProof = await readWriterCleanProof(paths.database);
    expect(cleanProof).toBeDefined();
    if (cleanProof === undefined) throw new Error("Expected the initial clean proof");

    const text = "canonical alpha";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      const contentId = insertContent(database, contentHash.digest, text);
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(contentId, text);
      database
        .prepare("INSERT INTO sessions_content_fts (rowid, text) VALUES (?, ?)")
        .run(contentId, "poison beta");
    });
    await publishWriterCleanProof(paths.database, {
      libraryInstanceId: cleanProof.libraryInstanceId,
      writerGeneration: cleanProof.writerGeneration,
      schemaVersion: cleanProof.schemaVersion,
      schemaCookie: cleanProof.schemaCookie,
    });

    const originalPrepare = DatabaseSync.prototype.prepare;
    let probeFailed = false;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (!probeFailed && sql === "SELECT 1 FROM sessions_content_fts_data LIMIT 1") {
        probeFailed = true;
        throw new Error("synthetic FTS shadow inspection failure");
      }
      return originalPrepare.call(this, sql);
    });

    try {
      const writer = await createSqliteIndexLifecycle().openWriter(paths);
      await writer.close();
    } finally {
      prepareSpy.mockRestore();
    }
    expect(probeFailed).toBe(true);

    const database = openImmutable(paths.database);
    try {
      expect(ftsMatchCount(database, "alpha")).toBe(1);
      expect(ftsMatchCount(database, "beta")).toBe(0);
    } finally {
      database.close();
    }
  });

  test("rejects a stat-valid clean proof from an older writer generation", async () => {
    const paths = await initializedPaths();
    const oldProof = await readWriterCleanProof(paths.database);
    expect(oldProof).toBeDefined();
    if (oldProof === undefined) throw new Error("Expected the initial clean proof");

    const secondWriter = await createSqliteIndexLifecycle().openWriter(paths);
    await secondWriter.close();

    const text = "canonical alpha";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      const contentId = insertContent(database, contentHash.digest, text);
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(contentId, text);
      database
        .prepare("INSERT INTO sessions_content_fts (rowid, text) VALUES (?, ?)")
        .run(contentId, "poison beta");
    });

    // Bind the older generation to the current file stats. File identity alone
    // must not authorize the fast path after a later writer sealed the library.
    await publishWriterCleanProof(paths.database, {
      libraryInstanceId: oldProof.libraryInstanceId,
      writerGeneration: oldProof.writerGeneration,
      schemaVersion: oldProof.schemaVersion,
      schemaCookie: oldProof.schemaCookie,
    });
    await expect(readWriterCleanProof(paths.database)).resolves.toMatchObject({
      writerGeneration: oldProof.writerGeneration,
    });

    const repairingWriter = await createSqliteIndexLifecycle().openWriter(paths);
    await repairingWriter.close();

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
      insertContent(database, contentHash.digest, text);
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
      ftsContent: "failed",
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
    const text = "damaged projection evidence";
    const contentHash = hashContent(text);
    mutateDatabase(paths.database, (database) => {
      database.exec("PRAGMA foreign_keys = OFF");
      const contentId = insertContent(database, contentHash.digest, text);
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(contentId, text);
      database.exec("DROP TRIGGER sessions_content_values_ai");
      database
        .prepare(
          `INSERT INTO sessions_content_occurrences (
             session_id, entry_ordinal, segment_ordinal, content_id,
             content_class, source_type, origin, confidence, source_metadata_json
           ) VALUES (999, 0, 0, NULL, 'unknown', 'corrupt-fixture', 'unknown', 'unknown', '{}')`,
        )
        .run();
    });
    const canonicalBefore = readCanonicalRows(paths.database);
    const projectionBefore = readFtsProjectionState(paths.database);

    await expect(createSqliteIndexLifecycle().openWriter(paths)).rejects.toMatchObject({
      code: "canonical-corrupt",
    });
    expect(readCanonicalRows(paths.database)).toEqual(canonicalBefore);
    expect(readFtsProjectionState(paths.database)).toEqual(projectionBefore);
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

function insertContent(database: DatabaseSync, digest: string, text: string): number | bigint {
  const row = database
    .prepare(
      `INSERT INTO sessions_content_values (digest, text)
       VALUES (?, ?)
       RETURNING content_id`,
    )
    .get(encodeSqliteContentDigest(digest), text) as {
    readonly content_id: number | bigint;
  };
  return row.content_id;
}

function expectCanonicalDuplicateGuard(file: string, digest: string, text: string): void {
  const database = new DatabaseSync(file);
  try {
    expect(() => insertContent(database, digest, text)).toThrow(
      /duplicate sessions content value/u,
    );
  } finally {
    database.close();
  }
}

function poisonFtsTerms(
  database: DatabaseSync,
  contentId: number | bigint,
  canonicalText: string,
  poisonText: string,
): void {
  database
    .prepare(
      `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
       VALUES ('delete', ?, ?)`,
    )
    .run(contentId, canonicalText);
  database
    .prepare("INSERT INTO sessions_content_fts (rowid, text) VALUES (?, ?)")
    .run(contentId, poisonText);
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

function readFtsProjectionState(file: string): unknown {
  const database = openImmutable(file);
  try {
    const schema = database
      .prepare(
        `SELECT name, type, sql
         FROM sqlite_schema
         WHERE name = 'sessions_content_fts'
            OR name LIKE 'sessions_content_fts\\_%' ESCAPE '\\'
            OR name LIKE 'sessions_content_values\\_%' ESCAPE '\\'
         ORDER BY name COLLATE BINARY`,
      )
      .all();
    const rows = [
      ["sessions_content_fts_config", "k"],
      ["sessions_content_fts_data", "id"],
      ["sessions_content_fts_docsize", "id"],
      ["sessions_content_fts_idx", "segid, term"],
    ].map(([table, order]) => [
      table,
      database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all(),
    ]);
    return { schema, rows };
  } finally {
    database.close();
  }
}

function sequencedClock(timestamps: readonly string[]): {
  readonly now: () => Date;
  readonly reads: () => readonly string[];
} {
  const milliseconds = timestamps.map(Date.parse);
  const last = milliseconds.at(-1);
  if (last === undefined) throw new TypeError("Sequenced clock requires a timestamp");
  let index = 0;
  const reads: string[] = [];
  return {
    now() {
      const date = new Date(milliseconds[Math.min(index++, milliseconds.length - 1)] ?? last);
      reads.push(date.toISOString());
      return date;
    },
    reads: () => reads,
  };
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
