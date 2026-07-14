import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  applyWriterMigrations,
  acquireWriterSchema,
} from "../../src/infrastructure/sqlite/writer-schema-cutover.ts";
import {
  applyMigrations,
  readMigrationHistory,
  sqliteMigrations,
  type SqliteMigration,
} from "../../src/infrastructure/sqlite/migrations.ts";
import {
  acquireWriterLease,
  heartbeatWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  readWriterLeaseHealth,
} from "../../src/infrastructure/sqlite/writer-lease.ts";

const ACQUIRED_AT = "2026-07-14T12:00:00.000Z";
const HEARTBEAT_AT = "2026-07-14T12:00:10.000Z";
const EXPIRES_AT = "2026-07-14T12:00:40.000Z";

describe("SQLite writer schema cutover", () => {
  test("migrates pre-coordination state before carrying the first lease", () => {
    const database = openDatabase();
    const now = () => new Date("2026-07-14T11:00:00.000Z");
    try {
      applyMigrations(database, sqliteMigrations.slice(0, 2));
      database
        .prepare(
          `INSERT INTO sessions_source_instances (kind, instance_id)
           VALUES ('synthetic', 'preserved-before-coordination')`,
        )
        .run();

      const acquired = acquireWriterSchema(database, "index", sqliteMigrations, {
        now,
        token: () => "first-coordinated-owner",
      });

      expect(acquired.history.currentVersion).toBe(4);
      expect(acquired.lease.generation).toBe(1);
      expect(
        database.prepare("SELECT kind, instance_id FROM sessions_source_instances").get(),
      ).toEqual({
        kind: "synthetic",
        instance_id: "preserved-before-coordination",
      });
      expect(interruptOwnedRunsAndReleaseWriterLease(database, acquired.lease, { now })).toBe(true);
    } finally {
      database.close();
    }
  });

  test("uses normal lease acquisition for an already-current schema", () => {
    const database = openDatabase();
    const now = () => new Date("2026-07-14T11:30:00.000Z");
    try {
      applyMigrations(database);
      const acquired = acquireWriterSchema(database, "forget", sqliteMigrations, {
        now,
        token: () => "current-schema-owner",
      });

      expect(acquired.history.currentVersion).toBe(4);
      expect(acquired.lease).toEqual({
        purpose: "forget",
        generation: 1,
        token: "current-schema-owner",
      });
      expect(interruptOwnedRunsAndReleaseWriterLease(database, acquired.lease, { now })).toBe(true);
    } finally {
      database.close();
    }
  });

  test("refuses a live schema-3 owner without applying schema 4", () => {
    const database = schemaThreeDatabase();
    try {
      setSchemaThreeLease(database, {
        generation: 7,
        purpose: "index",
        token: "live-schema-three-owner",
      });
      const before = database.prepare("SELECT * FROM sessions_writer_lease").get();

      expect(() =>
        acquireWriterSchema(database, "index", sqliteMigrations, {
          now: () => new Date("2026-07-14T12:00:20.000Z"),
          token: () => "refused-owner",
        }),
      ).toThrow(expect.objectContaining({ code: "writer-busy" }));

      expect(readMigrationHistory(database, sqliteMigrations).currentVersion).toBe(3);
      expect(database.prepare("SELECT * FROM sessions_writer_lease").get()).toEqual(before);
      expect(
        database.prepare("SELECT name FROM pragma_table_info('sessions_entries')").all(),
      ).not.toContainEqual({ name: "tool_name" });
    } finally {
      database.close();
    }
  });

  test("atomically migrates an expired schema-3 index owner and carries ownership", () => {
    const database = schemaThreeDatabase();
    try {
      setSchemaThreeLease(database, {
        generation: 7,
        purpose: "index",
        token: "expired-schema-three-owner",
      });
      const runId = insertActiveRun(database);
      const now = () => new Date("2026-07-14T12:01:00.000Z");

      const acquired = acquireWriterSchema(database, "index", sqliteMigrations, {
        now,
        token: () => "carried-schema-four-owner",
      });

      expect(acquired.history.currentVersion).toBe(4);
      expect(acquired.lease).toEqual({
        purpose: "index",
        generation: 8,
        token: "carried-schema-four-owner",
      });
      expect(readWriterLeaseHealth(database, { now })).toMatchObject({
        status: "live",
        generation: 8,
        purpose: "index",
      });
      expect(
        database
          .prepare(
            "SELECT status, finished_at, failure_code FROM sessions_index_runs WHERE run_id = ?",
          )
          .get(runId),
      ).toEqual({
        status: "interrupted",
        finished_at: "2026-07-14T12:01:00.000Z",
        failure_code: "interrupted",
      });
      expect(() => heartbeatWriterLease(database, acquired.lease, { now })).not.toThrow();
      expect(interruptOwnedRunsAndReleaseWriterLease(database, acquired.lease, { now })).toBe(true);
    } finally {
      database.close();
    }
  });

  test("refuses expired schema-3 clear intent without persisting the migration", () => {
    const database = schemaThreeDatabase();
    try {
      setSchemaThreeLease(database, {
        generation: 3,
        purpose: "clear",
        token: "expired-clear-owner",
      });

      expect(() =>
        acquireWriterSchema(database, "forget", sqliteMigrations, {
          now: () => new Date("2026-07-14T12:01:00.000Z"),
          token: () => "blocked-forget-owner",
        }),
      ).toThrow(expect.objectContaining({ code: "writer-busy" }));
      expect(readMigrationHistory(database, sqliteMigrations).currentVersion).toBe(3);
      expect(
        database.prepare("SELECT generation, purpose FROM sessions_writer_lease").get(),
      ).toEqual({
        generation: 3,
        purpose: "clear",
      });
    } finally {
      database.close();
    }
  });

  test("classifies an impossible schema-3 forget owner as corrupt", () => {
    const database = schemaThreeDatabase();
    try {
      database.exec("PRAGMA ignore_check_constraints = ON");
      database
        .prepare(
          `UPDATE sessions_writer_lease
           SET generation = 1,
               purpose = 'forget',
               owner_token = 'impossible-owner',
               acquired_at = ?,
               heartbeat_at = ?,
               expires_at = ?
           WHERE singleton = 1`,
        )
        .run(ACQUIRED_AT, HEARTBEAT_AT, EXPIRES_AT);
      database.exec("PRAGMA ignore_check_constraints = OFF");

      expect(() =>
        acquireWriterSchema(database, "index", sqliteMigrations, {
          now: () => new Date("2026-07-14T12:01:00.000Z"),
          token: () => "replacement-owner",
        }),
      ).toThrow(expect.objectContaining({ code: "corrupt-data" }));
      expect(readMigrationHistory(database, sqliteMigrations).currentVersion).toBe(3);
    } finally {
      database.close();
    }
  });

  test("rolls back cutover when the lifecycle clock moves behind the old heartbeat", () => {
    const database = schemaThreeDatabase();
    try {
      setSchemaThreeLease(database, {
        generation: 2,
        purpose: "index",
        token: "clock-owner",
      });
      const timestamps = ["2026-07-14T12:01:00.000Z", "2026-07-14T12:00:09.000Z"];

      expect(() =>
        acquireWriterSchema(database, "index", sqliteMigrations, {
          now: () => new Date(timestamps.shift() ?? "invalid"),
          token: () => "backward-clock-owner",
        }),
      ).toThrow(expect.objectContaining({ code: "writer-lease-lost" }));
      expect(readMigrationHistory(database, sqliteMigrations).currentVersion).toBe(3);
      expect(
        database.prepare("SELECT generation, purpose FROM sessions_writer_lease").get(),
      ).toEqual({
        generation: 2,
        purpose: "index",
      });
    } finally {
      database.close();
    }
  });

  test("applies custom releases only while the carried lease is visible", () => {
    const database = openDatabase();
    const now = () => new Date("2026-07-14T13:00:00.000Z");
    const markerMigration = {
      version: 5,
      name: "lease_marker",
      sql: `CREATE TABLE lease_marker AS
SELECT generation, purpose, owner_token
FROM sessions_writer_lease
WHERE singleton = 1;`,
    } satisfies SqliteMigration;
    const migrations = [...sqliteMigrations, markerMigration];
    try {
      const acquired = acquireWriterSchema(database, "index", migrations, {
        now,
        token: () => "custom-release-owner",
      });
      const history = applyWriterMigrations(database, migrations, acquired.lease, { now });

      expect(history.currentVersion).toBe(5);
      expect(database.prepare("SELECT * FROM lease_marker").get()).toEqual({
        generation: 1,
        purpose: "index",
        owner_token: "custom-release-owner",
      });
      expect(interruptOwnedRunsAndReleaseWriterLease(database, acquired.lease, { now })).toBe(true);
    } finally {
      database.close();
    }
  });

  test("supports forget ownership and preserves expired-clear exclusivity in schema 4", () => {
    const database = openDatabase();
    const clock = { now: new Date("2026-07-14T14:00:00.000Z") };
    try {
      applyMigrations(database);
      const forget = acquireWriterLease(database, "forget", {
        now: () => clock.now,
        token: () => "forget-owner",
      });
      expect(readWriterLeaseHealth(database, { now: () => clock.now })).toMatchObject({
        status: "live",
        purpose: "forget",
      });
      expect(
        interruptOwnedRunsAndReleaseWriterLease(database, forget, { now: () => clock.now }),
      ).toBe(true);

      const clear = acquireWriterLease(database, "clear", {
        now: () => clock.now,
        token: () => "clear-owner",
      });
      clock.now = new Date("2026-07-14T14:01:00.000Z");
      expect(() =>
        acquireWriterLease(database, "forget", {
          now: () => clock.now,
          token: () => "blocked-after-clear",
        }),
      ).toThrow(expect.objectContaining({ code: "writer-busy" }));
      expect(clear.purpose).toBe("clear");
    } finally {
      database.close();
    }
  });
});

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  return database;
}

function schemaThreeDatabase(): DatabaseSync {
  const database = openDatabase();
  applyMigrations(database, sqliteMigrations.slice(0, 3));
  return database;
}

function setSchemaThreeLease(
  database: DatabaseSync,
  input: {
    readonly generation: number;
    readonly purpose: "index" | "clear";
    readonly token: string;
  },
): void {
  database
    .prepare(
      `UPDATE sessions_writer_lease
       SET generation = ?, purpose = ?, owner_token = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
       WHERE singleton = 1`,
    )
    .run(input.generation, input.purpose, input.token, ACQUIRED_AT, HEARTBEAT_AT, EXPIRES_AT);
}

function insertActiveRun(database: DatabaseSync): number {
  const source = database
    .prepare(
      `INSERT INTO sessions_source_instances (kind, instance_id)
       VALUES ('synthetic', 'cutover-source')
       RETURNING source_instance_id`,
    )
    .get() as { readonly source_instance_id: number | bigint };
  const run = database
    .prepare(
      `INSERT INTO sessions_index_runs (source_instance_id, status, started_at)
       VALUES (?, 'active', ?)
       RETURNING run_id`,
    )
    .get(source.source_instance_id, ACQUIRED_AT) as { readonly run_id: number | bigint };
  return Number(run.run_id);
}
