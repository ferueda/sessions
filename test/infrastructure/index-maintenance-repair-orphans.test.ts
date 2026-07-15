import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { SESSION_DOCUMENT_DIGEST_SCHEME } from "../../src/domain/public-session-document.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import type { Fts5SecurityCapability } from "../../src/infrastructure/sqlite/fts5-security.ts";
import { createSqliteIndexMaintenance } from "../../src/infrastructure/sqlite/index-maintenance.ts";
import {
  acquireWriterLease,
  readWriterLeaseHealth,
} from "../../src/infrastructure/sqlite/writer-lease.ts";

const temporaryDirectories: string[] = [];
const now = () => new Date("2026-07-15T12:00:00.000Z");
const PRIOR_BOOTSTRAP_CHECKSUM =
  "sha256-utf8-v1:50e38c12ed6def651bef1baa5597a8512b7751b6f474dca2a241e1572839dc55";
const noFtsSecureDelete = (): Fts5SecurityCapability => ({
  sqliteVersion: "synthetic",
  fts5: true,
  secureDelete: false,
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite orphan-content repair maintenance", () => {
  test("returns unchanged without creating Sessions-owned state or probing FTS", async () => {
    const paths = await fixturePaths();
    const fts5Probe = vi.fn<typeof noFtsSecureDelete>(noFtsSecureDelete);

    await expect(
      createSqliteIndexMaintenance({ fts5Probe, now }).repairOrphans(paths),
    ).resolves.toEqual({
      outcome: "unchanged",
      deletedContentRows: "0",
      deletedContentBytes: "0",
    });
    expect(fts5Probe).not.toHaveBeenCalled();
    await expect(stat(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("is unchanged and idempotent for a current library with no orphans", async () => {
    const paths = await initializedPaths();
    const maintenance = createSqliteIndexMaintenance({ fts5Probe: noFtsSecureDelete, now });

    await expect(maintenance.repairOrphans(paths)).resolves.toEqual({
      outcome: "unchanged",
      deletedContentRows: "0",
      deletedContentBytes: "0",
    });
    await expect(maintenance.repairOrphans(paths)).resolves.toEqual({
      outcome: "unchanged",
      deletedContentRows: "0",
      deletedContentBytes: "0",
    });
    expect(readLeaseHealth(paths)).toMatchObject({ status: "free", generation: 3 });
  });

  test("refuses the superseded pre-launch baseline without a compatibility mutation", async () => {
    const paths = await initializedPaths();
    mutateDatabase(paths, (database) => {
      database
        .prepare("UPDATE sessions_schema_migrations SET checksum = ? WHERE version = 1")
        .run(PRIOR_BOOTSTRAP_CHECKSUM);
    });
    const before = await readFile(paths.database);

    await expect(
      createSqliteIndexMaintenance({ fts5Probe: noFtsSecureDelete, now }).repairOrphans(paths),
    ).rejects.toMatchObject({ code: "corrupt-data" });

    await expect(readFile(paths.database)).resolves.toEqual(before);
  });

  test("deletes exact signed-64-bit orphan IDs and their FTS rows", async () => {
    const paths = await initializedPaths();
    const fixtures = [
      { id: -1n, text: "negative" },
      { id: 0n, text: "zero" },
      { id: BigInt(Number.MAX_SAFE_INTEGER) + 2n, text: "outside safe integer" },
      { id: 9_223_372_036_854_775_807n, text: "maximum signed integer é" },
    ] as const;
    seedOrphans(paths, fixtures);

    await expect(
      createSqliteIndexMaintenance({
        fts5Probe: noFtsSecureDelete,
        now,
        token: () => "signed-id-repair-owner",
      }).repairOrphans(paths),
    ).resolves.toEqual({
      outcome: "repaired",
      deletedContentRows: "4",
      deletedContentBytes: String(
        fixtures.reduce((total, fixture) => total + Buffer.byteLength(fixture.text), 0),
      ),
    });

    expect(readContentIds(paths)).toEqual([]);
    expect(readFtsIds(paths)).toEqual([]);
    expect(readLeaseHealth(paths)).toMatchObject({ status: "free", generation: 2 });
  });

  test("advances across referenced windows without deleting retained evidence", async () => {
    const paths = await initializedPaths();
    seedReferencedContent(paths, 1n, "retained evidence");
    seedOrphans(paths, [{ id: 2n, text: "orphan evidence" }]);

    await expect(
      createSqliteIndexMaintenance({
        fts5Probe: noFtsSecureDelete,
        now,
        repairScanLimit: 1,
      }).repairOrphans(paths),
    ).resolves.toEqual({
      outcome: "repaired",
      deletedContentRows: "1",
      deletedContentBytes: "15",
    });

    expect(readContentIds(paths)).toEqual([1n]);
    expect(readFtsIds(paths)).toEqual([1n]);
  });

  test("honors row and byte bounds across multiple batches and permits oversize progress", async () => {
    const paths = await initializedPaths();
    seedOrphans(paths, [
      { id: 1n, text: "aa" },
      { id: 2n, text: "bbb" },
      { id: 3n, text: "cccccc" },
      { id: 4n, text: "d" },
    ]);
    const batches: Array<{
      readonly ordinal: number;
      readonly deletedContentRows: string;
      readonly deletedContentBytes: string;
    }> = [];
    let eventLoopAdvanced = false;
    let eventLoopAdvancedBeforeSecond = false;
    let eventLoopTurn: Promise<void> | undefined;

    await expect(
      createSqliteIndexMaintenance({
        fts5Probe: noFtsSecureDelete,
        now,
        repairPayloadByteLimit: 4,
        repairScanLimit: 2,
        repairObserver: {
          afterBatch(progress) {
            batches.push(progress);
            if (batches.length === 1) {
              eventLoopTurn = new Promise((resolve) => {
                setImmediate(() => {
                  eventLoopAdvanced = true;
                  resolve();
                });
              });
            } else if (batches.length === 2) {
              eventLoopAdvancedBeforeSecond = eventLoopAdvanced;
            }
          },
        },
      }).repairOrphans(paths),
    ).resolves.toEqual({
      outcome: "repaired",
      deletedContentRows: "4",
      deletedContentBytes: "12",
    });
    await eventLoopTurn;

    expect(eventLoopAdvancedBeforeSecond).toBe(true);
    expect(batches).toEqual([
      { ordinal: 1, deletedContentRows: "1", deletedContentBytes: "2" },
      { ordinal: 2, deletedContentRows: "1", deletedContentBytes: "3" },
      { ordinal: 3, deletedContentRows: "1", deletedContentBytes: "6" },
      { ordinal: 4, deletedContentRows: "1", deletedContentBytes: "1" },
    ]);
    expect(readContentIds(paths)).toEqual([]);
  });

  test("keeps a committed batch after observer failure and restarts from the beginning", async () => {
    const paths = await initializedPaths();
    seedOrphans(paths, [
      { id: 1n, text: "first" },
      { id: 2n, text: "second" },
      { id: 3n, text: "third" },
    ]);

    await expect(
      createSqliteIndexMaintenance({
        fts5Probe: noFtsSecureDelete,
        now,
        repairScanLimit: 1,
        repairObserver: {
          afterBatch({ ordinal }) {
            if (ordinal === 1) throw new Error("synthetic post-commit failure");
          },
        },
      }).repairOrphans(paths),
    ).rejects.toMatchObject({ code: "repair-failed" });

    expect(readContentIds(paths)).toEqual([2n, 3n]);
    expect(readLeaseHealth(paths)).toMatchObject({ status: "free" });

    await expect(
      createSqliteIndexMaintenance({
        fts5Probe: noFtsSecureDelete,
        now,
        repairScanLimit: 1,
      }).repairOrphans(paths),
    ).resolves.toEqual({
      outcome: "repaired",
      deletedContentRows: "2",
      deletedContentBytes: "11",
    });
    expect(readContentIds(paths)).toEqual([]);
  });

  test("refuses live ownership, then takes over the expired repair lease", async () => {
    const paths = await initializedPaths();
    seedOrphans(paths, [{ id: 1n, text: "takeover" }]);
    const owner = new DatabaseSync(paths.database);
    acquireWriterLease(owner, "repair", { now, token: () => "live-repair-owner" });
    owner.close();

    await expect(
      createSqliteIndexMaintenance({
        fts5Probe: noFtsSecureDelete,
        now: () => new Date("2026-07-15T12:00:01.000Z"),
        token: () => "blocked-repair-owner",
      }).repairOrphans(paths),
    ).rejects.toMatchObject({ code: "library-busy" });
    expect(readContentIds(paths)).toEqual([1n]);

    const expiredClock = () => new Date("2026-07-15T12:01:00.000Z");
    await expect(
      createSqliteIndexMaintenance({
        fts5Probe: noFtsSecureDelete,
        now: expiredClock,
        token: () => "takeover-repair-owner",
      }).repairOrphans(paths),
    ).resolves.toEqual({
      outcome: "repaired",
      deletedContentRows: "1",
      deletedContentBytes: "8",
    });
    expect(readLeaseHealth(paths, expiredClock)).toMatchObject({ status: "free", generation: 3 });
  });

  test("rolls back the whole candidate batch when an orphan lacks its FTS row", async () => {
    const paths = await initializedPaths();
    seedOrphans(paths, [
      { id: 1n, text: "healthy candidate" },
      { id: 2n, text: "missing projection" },
    ]);
    mutateDatabase(paths, (database) => {
      database
        .prepare(
          `INSERT INTO sessions_content_fts (sessions_content_fts, rowid, text)
           VALUES ('delete', ?, ?)`,
        )
        .run(2n, "missing projection");
    });

    await expect(
      createSqliteIndexMaintenance({
        fts5Probe: noFtsSecureDelete,
        now,
      }).repairOrphans(paths),
    ).rejects.toMatchObject({ code: "corrupt-data" });

    expect(readContentIds(paths)).toEqual([1n, 2n]);
    expect(readFtsIds(paths)).toEqual([1n]);
    expect(readLeaseHealth(paths)).toMatchObject({ status: "free" });
  });
});

interface OrphanFixture {
  readonly id: bigint;
  readonly text: string;
}

async function initializedPaths(): Promise<IndexPaths> {
  const paths = await fixturePaths();
  const writer = await createSqliteIndexLifecycle({ now }).openWriter(paths);
  await writer.close();
  return paths;
}

function seedOrphans(paths: IndexPaths, fixtures: readonly OrphanFixture[]): void {
  mutateDatabase(paths, (database) => {
    const insert = database.prepare(
      `INSERT INTO sessions_content_values (content_id, digest, text)
       VALUES (?, ?, ?)`,
    );
    for (const [ordinal, fixture] of fixtures.entries()) {
      const digest = new Uint8Array(32);
      digest.fill((ordinal % 254) + 1);
      insert.run(fixture.id, digest, fixture.text);
    }
  });
}

function seedReferencedContent(paths: IndexPaths, contentId: bigint, text: string): void {
  mutateDatabase(paths, (database) => {
    const sourceId = database
      .prepare(
        "INSERT INTO sessions_source_instances (kind, instance_id) VALUES ('synthetic', 'one')",
      )
      .run().lastInsertRowid;
    const sessionId = database
      .prepare(
        `INSERT INTO sessions_session_tracking (
           source_instance_id, native_id,
           last_good_fingerprint_scheme, last_good_fingerprint_digest,
           last_good_adapter_version, latest_fingerprint_scheme,
           latest_fingerprint_digest, latest_adapter_version, latest_outcome
         ) VALUES (?, 'retained', 'synthetic-v1', 'digest', 'adapter-v1',
                   'synthetic-v1', 'digest', 'adapter-v1', 'indexed')`,
      )
      .run(sourceId).lastInsertRowid;
    database
      .prepare(
        `INSERT INTO sessions_canonical_sessions (
           session_id, lineage_coverage, document_digest_scheme, document_digest
         ) VALUES (?, 'unknown', ?, ?)`,
      )
      .run(sessionId, SESSION_DOCUMENT_DIGEST_SCHEME, new Uint8Array(32));
    database
      .prepare(
        `INSERT INTO sessions_entries (session_id, ordinal, kind, actor, source_locator_uri)
         VALUES (?, 0, 'message', 'human', 'memory://retained')`,
      )
      .run(sessionId);
    database
      .prepare(
        `INSERT INTO sessions_content_values (content_id, digest, text)
         VALUES (?, ?, ?)`,
      )
      .run(contentId, new Uint8Array(32).fill(255), text);
    database
      .prepare(
        `INSERT INTO sessions_content_occurrences (
           session_id, entry_ordinal, segment_ordinal, content_id,
           origin, confidence, source_metadata_json
         ) VALUES (?, 0, 0, ?, 'human', 'high', '{}')`,
      )
      .run(sessionId, contentId);
  });
}

function mutateDatabase(paths: IndexPaths, operation: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(paths.database, {
    enableForeignKeyConstraints: true,
  });
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON");
    operation(database);
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    expect(checkpoint).toMatchObject({ busy: 0 });
  } finally {
    database.close();
  }
}

function readContentIds(paths: IndexPaths): readonly bigint[] {
  return readBigIntIds(paths, "SELECT content_id AS id FROM sessions_content_values ORDER BY id");
}

function readFtsIds(paths: IndexPaths): readonly bigint[] {
  return readBigIntIds(paths, "SELECT id FROM sessions_content_fts_docsize ORDER BY id");
}

function readBigIntIds(paths: IndexPaths, sql: string): readonly bigint[] {
  const database = new DatabaseSync(paths.database, { readOnly: true });
  try {
    const statement = database.prepare(sql);
    statement.setReadBigInts(true);
    return (statement.all() as unknown as readonly { readonly id?: unknown }[]).map((row) => {
      if (typeof row.id !== "bigint") throw new TypeError("Expected a SQLite BigInt ID");
      return row.id;
    });
  } finally {
    database.close();
  }
}

function readLeaseHealth(
  paths: IndexPaths,
  clock: () => Date = now,
): ReturnType<typeof readWriterLeaseHealth> {
  const database = new DatabaseSync(paths.database, { readOnly: true });
  try {
    return readWriterLeaseHealth(database, { now: clock });
  } finally {
    database.close();
  }
}

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-repair-orphans-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "sessions");
  const database = path.join(directory, "sessions.sqlite3");
  return {
    directory,
    scratch: path.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}
