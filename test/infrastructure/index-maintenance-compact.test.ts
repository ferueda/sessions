import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { createSqliteIndexMaintenance } from "../../src/infrastructure/sqlite/index-maintenance.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  readWriterLeaseHealth,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import {
  admittedReplacement,
  completeDocument,
  identity,
  observation,
} from "../contracts/session-index.contract.ts";

const temporaryDirectories: string[] = [];
const now = () => new Date("2026-07-14T12:00:00.000Z");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite index compaction", () => {
  test("returns absent without creating Sessions-owned state", async () => {
    const paths = await fixturePaths();

    await expect(createSqliteIndexMaintenance({ now }).compact(paths)).resolves.toEqual({
      outcome: "absent",
      databaseBytesBefore: 0,
      databaseBytesAfter: 0,
      reclaimedDatabaseBytes: 0,
    });
    await expect(stat(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("reports an unchanged current library with no reusable pages", async () => {
    const paths = await initializedPaths();

    const result = await createSqliteIndexMaintenance({ now }).compact(paths);

    expect(result).toEqual({
      outcome: "unchanged",
      databaseBytesBefore: expect.any(Number),
      databaseBytesAfter: result.databaseBytesBefore,
      reclaimedDatabaseBytes: 0,
    });
    expect(result.databaseBytesBefore).toBeGreaterThan(0);
    expect(readPragma(paths.database, "freelist_count")).toBe(0);
    await expectNoSidecars(paths);
  });

  test("reclaims a large deletion in bounded batches without changing retained evidence", async () => {
    const paths = await initializedPaths(true);
    const seeded = await seedReusablePages(paths);
    const batches: {
      readonly beforeFreelist: number;
      readonly afterFreelist: number;
      readonly maximumPages: number;
    }[] = [];

    const result = await createSqliteIndexMaintenance({
      now,
      compactBatchPageBudgetBytes: 64 * 1024,
      compactObserver: {
        afterBatch(progress) {
          batches.push(progress);
        },
      },
    }).compact(paths);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.beforeFreelist).toBeGreaterThan(batch.afterFreelist);
      expect(batch.beforeFreelist - batch.afterFreelist).toBeLessThanOrEqual(batch.maximumPages);
      expect(batch.maximumPages).toBeGreaterThan(0);
      expect(batch.maximumPages).toBeLessThanOrEqual(16);
    }
    expect(result.outcome).toBe("compacted");
    expect(result.databaseBytesBefore).toBe(seeded.databaseBytes);
    expect(result.databaseBytesAfter).toBeLessThan(result.databaseBytesBefore);
    expect(result.reclaimedDatabaseBytes).toBe(
      result.databaseBytesBefore - result.databaseBytesAfter,
    );
    expect(readPragma(paths.database, "freelist_count")).toBe(0);
    await expectRetainedEvidence(paths, seeded.retainedText);
    await expect(createSqliteIndexLifecycle({ now }).inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      canonicalIntegrity: "ok",
      ftsContent: "ok",
      pageReclamation: "incremental",
      writerLease: "free",
    });
    await expectNoSidecars(paths);
  });

  test("keeps committed batch progress after a later failure and resumes safely", async () => {
    const paths = await initializedPaths(true);
    const seeded = await seedReusablePages(paths);

    await expect(
      createSqliteIndexMaintenance({
        now,
        compactBatchPageBudgetBytes: 64 * 1024,
        compactObserver: {
          afterCheckpoint(ordinal) {
            if (ordinal === 1) throw new Error("synthetic post-checkpoint failure");
          },
        },
      }).compact(paths),
    ).rejects.toMatchObject({ code: "compact-failed" });

    const afterFailure = readPragma(paths.database, "freelist_count");
    expect(afterFailure).toBeGreaterThan(0);
    expect(afterFailure).toBeLessThan(seeded.freelistPages);
    expect(readLeaseHealth(paths)).toMatchObject({ status: "free" });
    await expectRetainedEvidence(paths, seeded.retainedText);

    const retry = await createSqliteIndexMaintenance({
      now,
      compactBatchPageBudgetBytes: 64 * 1024,
    }).compact(paths);
    expect(retry.outcome).toBe("compacted");
    expect(retry.reclaimedDatabaseBytes).toBe(retry.databaseBytesBefore - retry.databaseBytesAfter);
    expect(readPragma(paths.database, "freelist_count")).toBe(0);
    await expectRetainedEvidence(paths, seeded.retainedText);
  });

  test("fails on a busy truncating checkpoint and succeeds after the reader leaves", async () => {
    const paths = await initializedPaths(true);
    await seedReusablePages(paths);
    const reader = new DatabaseSync(paths.database, { readOnly: true, timeout: 0 });
    reader.exec("BEGIN");
    reader.prepare("SELECT singleton FROM sessions_library").get();
    appendWalFrame(paths.database);

    try {
      await expect(
        createSqliteIndexMaintenance({ busyTimeoutMs: 0, now }).compact(paths),
      ).rejects.toMatchObject({ code: "compact-failed" });
      expect(readPragma(paths.database, "freelist_count")).toBeGreaterThan(0);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }

    await expect(
      createSqliteIndexMaintenance({ busyTimeoutMs: 0, now }).compact(paths),
    ).resolves.toMatchObject({ outcome: "compacted" });
    expect(readPragma(paths.database, "freelist_count")).toBe(0);
  });

  test("fences an expired owner after a checkpoint takeover and preserves its committed batch", async () => {
    const paths = await initializedPaths(true);
    const seeded = await seedReusablePages(paths);
    let clock = new Date("2026-07-14T12:00:00.000Z");

    await expect(
      createSqliteIndexMaintenance({
        now: () => clock,
        token: () => "expiring-compact-owner",
        compactBatchPageBudgetBytes: 64 * 1024,
        compactObserver: {
          afterCheckpoint(ordinal) {
            if (ordinal !== 1) return;
            clock = new Date("2026-07-14T12:01:00.000Z");
            const contender = new DatabaseSync(paths.database, { timeout: 0 });
            try {
              const replacement = acquireWriterLease(contender, "compact", {
                now: () => clock,
                token: () => "replacement-compact-owner",
              });
              expect(
                interruptOwnedRunsAndReleaseWriterLease(contender, replacement, {
                  now: () => clock,
                }),
              ).toBe(true);
            } finally {
              contender.close();
            }
          },
        },
      }).compact(paths),
    ).rejects.toMatchObject({ code: "compact-failed" });

    const afterTakeover = readPragma(paths.database, "freelist_count");
    expect(afterTakeover).toBeGreaterThan(0);
    expect(afterTakeover).toBeLessThan(seeded.freelistPages);
    expect(readLeaseHealth(paths)).toMatchObject({ status: "free", generation: 3 });

    await expect(
      createSqliteIndexMaintenance({
        now: () => clock,
        token: () => "retry-compact-owner",
      }).compact(paths),
    ).resolves.toMatchObject({ outcome: "compacted" });
    expect(readPragma(paths.database, "freelist_count")).toBe(0);
  });

  test("refuses a live writer and exposes compact ownership through health", async () => {
    const paths = await initializedPaths();
    const database = new DatabaseSync(paths.database);
    acquireWriterLease(database, "compact", { now, token: () => "live-compact-owner" });
    database.close();

    await expect(createSqliteIndexLifecycle({ now }).inspectHealth(paths)).resolves.toMatchObject({
      ok: true,
      writerLease: "compact-live",
    });
    await expect(
      createSqliteIndexMaintenance({
        now: () => new Date("2026-07-14T12:00:01.000Z"),
        token: () => "blocked-compact-owner",
      }).compact(paths),
    ).rejects.toMatchObject({ code: "library-busy" });
  });
});

interface ReusablePageFixture {
  readonly databaseBytes: number;
  readonly freelistPages: number;
  readonly retainedText: string;
}

async function initializedPaths(retainEvidence = false): Promise<IndexPaths> {
  const paths = await fixturePaths();
  const lifecycle = createSqliteIndexLifecycle({ now });
  const writer = await lifecycle.openWriter(paths);
  if (retainEvidence) {
    const sessionIdentity = identity("compact-profile", "retained-session");
    const sessionObservation = observation(sessionIdentity, "retained-revision");
    const replacement = admittedReplacement(sessionObservation, completeDocument(sessionIdentity));
    const run = await writer.sessions.startRun({
      source: sessionIdentity.source,
      startedAt: "2026-07-14T11:00:00.000Z",
    });
    await writer.sessions.replaceSession(run, replacement);
    await writer.sessions.finishRun(run, {
      status: "completed",
      finishedAt: "2026-07-14T11:01:00.000Z",
    });
  }
  await writer.close();
  return paths;
}

async function seedReusablePages(paths: IndexPaths): Promise<ReusablePageFixture> {
  const database = new DatabaseSync(paths.database, {
    enableForeignKeyConstraints: true,
  });
  const retainedText = "old searchable token; quote='; delimiter=@:\nNUL:\0";
  try {
    database.exec(`PRAGMA journal_mode = WAL;
      PRAGMA secure_delete = ON;
      CREATE TABLE compact_generic_payload (
        ordinal INTEGER PRIMARY KEY,
        payload BLOB NOT NULL
      ) STRICT;`);
    const insert = database.prepare(
      "INSERT INTO compact_generic_payload (ordinal, payload) VALUES (?, ?)",
    );
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let ordinal = 0; ordinal < 96; ordinal += 1) {
        insert.run(ordinal, Buffer.alloc(32 * 1024, ordinal % 251));
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assertCheckpoint(database);
    database.exec("DELETE FROM compact_generic_payload");
    assertCheckpoint(database);
    const freelistPages = pragmaInteger(database, "freelist_count");
    expect(freelistPages).toBeGreaterThan(16);
  } finally {
    database.close();
  }
  return {
    databaseBytes: Number((await stat(paths.database)).size),
    freelistPages: readPragma(paths.database, "freelist_count"),
    retainedText,
  };
}

function appendWalFrame(file: string): void {
  const database = new DatabaseSync(file, { timeout: 0 });
  try {
    database.exec("PRAGMA journal_mode = WAL");
    database
      .prepare("INSERT INTO compact_generic_payload (ordinal, payload) VALUES (999, x'01')")
      .run();
  } finally {
    database.close();
  }
}

async function expectRetainedEvidence(paths: IndexPaths, retainedText: string): Promise<void> {
  const database = openImmutable(paths.database);
  try {
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM sessions_content_occurrences").get(),
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sessions_content_fts
           WHERE sessions_content_fts MATCH 'searchable'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM sessions_content_values WHERE text = ?")
        .get(retainedText),
    ).toEqual({ count: 1 });
  } finally {
    database.close();
  }
}

function readLeaseHealth(paths: IndexPaths): ReturnType<typeof readWriterLeaseHealth> {
  const database = openImmutable(paths.database);
  try {
    return readWriterLeaseHealth(database, { now });
  } finally {
    database.close();
  }
}

function readPragma(file: string, name: "freelist_count"): number {
  const database = openImmutable(file);
  try {
    return pragmaInteger(database, name);
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

function pragmaInteger(database: DatabaseSync, name: "freelist_count"): number {
  const row = database.prepare(`PRAGMA ${name}`).get();
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  throw new TypeError("Expected an integer SQLite pragma result");
}

function assertCheckpoint(database: DatabaseSync): void {
  expect(database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
}

async function expectNoSidecars(paths: IndexPaths): Promise<void> {
  const entries = await readdir(paths.directory);
  expect(entries).not.toContain(path.basename(paths.wal));
  expect(entries).not.toContain(path.basename(paths.shm));
}

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-compact-"));
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
