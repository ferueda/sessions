import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import { SourceCaptureWorkspaceError } from "../../src/application/ports/session-source.ts";
import {
  admittedReplacement,
  identity,
  minimalDocument,
  observation,
} from "../contracts/session-index.contract.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
  sqliteMigrations,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import { acquireWriterSchema } from "../../src/infrastructure/sqlite/writer-schema.ts";
import {
  acquireWriterLease,
  heartbeatWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  interruptOwnedRunsMarkCleanAndReleaseWriterLease,
  readWriterLeaseHealth,
  runLeasedImmediateTransaction,
  startWriterLeaseHeartbeat,
  type WriterLeaseScheduler,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import {
  initializeWriterRecoveryReceipt,
  type WriterRecoveryReceipt,
} from "../../src/infrastructure/sqlite/writer-recovery-receipt.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite writer coordination", () => {
  test.each(["compact", "repair"] as const)(
    "coordinates %s ownership, heartbeat, contention, and expired takeover",
    (purpose) => {
      const database = migratedDatabase();
      const clock = fakeClock("2026-07-13T12:00:00.000Z");
      const scheduler = fakeScheduler();
      try {
        const first = acquireWriterLease(database, purpose, {
          now: clock.now,
          token: () => `first-${purpose}-owner`,
        });
        const heartbeat = startWriterLeaseHeartbeat(database, first, {
          now: clock.now,
          scheduler,
        });
        expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
          status: "live",
          purpose,
          generation: 1,
        });
        expect(() =>
          acquireWriterLease(database, "index", {
            now: clock.now,
            token: () => "blocked-index-owner",
          }),
        ).toThrow(expect.objectContaining({ code: "writer-busy" }));

        clock.set("2026-07-13T12:00:10.000Z");
        scheduler.tick();
        expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
          heartbeatAt: "2026-07-13T12:00:10.000Z",
          expiresAt: "2026-07-13T12:00:40.000Z",
        });
        heartbeat.stop();

        clock.set("2026-07-13T12:01:00.000Z");
        const replacement = acquireWriterLease(database, purpose, {
          now: clock.now,
          token: () => `replacement-${purpose}-owner`,
        });
        expect(replacement.generation).toBe(first.generation + 1);
        expect(() =>
          runLeasedImmediateTransaction(database, first, { now: clock.now }, () => undefined),
        ).toThrow(expect.objectContaining({ code: "writer-lease-lost" }));
        expect(
          interruptOwnedRunsAndReleaseWriterLease(database, replacement, { now: clock.now }),
        ).toBe(true);
        expect(scheduler.clear).toHaveBeenCalledOnce();
      } finally {
        database.close();
      }
    },
  );

  test("admits one live writer and exposes no owner token in health", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const lease = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "opaque-first-owner",
      });

      expect(lease).toEqual({
        purpose: "index",
        generation: 1,
        token: "opaque-first-owner",
      });
      expect(readWriterLeaseHealth(database, { now: clock.now })).toEqual({
        status: "live",
        generation: 1,
        purpose: "index",
        acquiredAt: "2026-07-13T12:00:00.000Z",
        heartbeatAt: "2026-07-13T12:00:00.000Z",
        expiresAt: "2026-07-13T12:00:30.000Z",
      });
      expect(() =>
        acquireWriterLease(database, "clear", {
          now: clock.now,
          token: () => "opaque-second-owner",
        }),
      ).toThrow(expect.objectContaining({ code: "writer-busy" }));

      expect(interruptOwnedRunsAndReleaseWriterLease(database, lease, { now: clock.now })).toBe(
        true,
      );
      expect(readWriterLeaseHealth(database, { now: clock.now })).toEqual({
        status: "free",
        generation: 1,
      });
    } finally {
      database.close();
    }
  });

  test("binds fast-path eligibility to the exact clean generation and schema", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const first = acquireWriterSchema(database, "index", sqliteMigrations, {
        now: clock.now,
        token: () => "first-clean-owner",
      });
      expect(first.fastPathEligible).toBe(false);

      const clean = interruptOwnedRunsMarkCleanAndReleaseWriterLease(database, first.lease, {
        now: clock.now,
      });
      const libraryInstanceId = String(
        database.prepare("SELECT instance_id FROM sessions_library WHERE singleton = 1").get()
          ?.instance_id,
      );
      expect(clean).toEqual({
        generation: 1,
        schemaCookie: expect.any(Number),
      });
      expect(leaseRow(database)).toMatchObject({
        generation: 1,
        clean_generation: 1,
        clean_schema_cookie: clean?.schemaCookie,
        purpose: null,
      });

      const second = acquireWriterSchema(database, "index", sqliteMigrations, {
        now: clock.now,
        token: () => "second-clean-owner",
        cleanClaim: {
          generation: clean?.generation ?? -1,
          schemaCookie: clean?.schemaCookie ?? -1,
          schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
          libraryInstanceId,
        },
      });
      expect(second.fastPathEligible).toBe(true);
      expect(second.lease.generation).toBe(2);
      expect(leaseRow(database)).toMatchObject({
        generation: 2,
        clean_generation: 1,
        clean_schema_cookie: clean?.schemaCookie,
        purpose: "index",
      });
      expect(
        interruptOwnedRunsAndReleaseWriterLease(database, second.lease, { now: clock.now }),
      ).toBe(true);

      const mismatched = acquireWriterSchema(database, "index", sqliteMigrations, {
        now: clock.now,
        token: () => "mismatched-clean-owner",
        cleanClaim: {
          generation: 2,
          schemaCookie: clean?.schemaCookie ?? -1,
          schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
          libraryInstanceId: "different-library",
        },
      });
      expect(mismatched.fastPathEligible).toBe(false);
    } finally {
      database.close();
    }
  });

  test("does not let a stale or backward-clock owner mark a generation clean", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const first = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "stale-clean-owner",
      });
      clock.set("2026-07-13T12:01:00.000Z");
      const replacement = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "replacement-clean-owner",
      });
      expect(
        interruptOwnedRunsMarkCleanAndReleaseWriterLease(database, first, { now: clock.now }),
      ).toBeUndefined();
      expect(leaseRow(database)).toMatchObject({
        generation: 2,
        clean_generation: null,
        clean_schema_cookie: null,
        purpose: "index",
      });

      clock.set("2026-07-13T11:59:59.000Z");
      expect(() =>
        interruptOwnedRunsMarkCleanAndReleaseWriterLease(database, replacement, {
          now: clock.now,
        }),
      ).toThrow(expect.objectContaining({ code: "writer-lease-lost" }));
      expect(leaseRow(database)).toMatchObject({
        generation: 2,
        clean_generation: null,
        clean_schema_cookie: null,
        purpose: "index",
      });
    } finally {
      database.close();
    }
  });

  test.each([new Date("+010000-01-01T00:00:00.000Z"), new Date("9999-12-31T23:59:40.000Z")])(
    "rejects unsupported lease timestamp boundaries before writing",
    (now) => {
      const database = migratedDatabase();
      try {
        expect(() =>
          acquireWriterLease(database, "index", {
            now: () => now,
            token: () => "out-of-range-clock-owner",
          }),
        ).toThrow(TypeError);
        expect(database.prepare("SELECT * FROM sessions_writer_lease").get()).toMatchObject({
          generation: 0,
          purpose: null,
          owner_token: null,
        });
      } finally {
        database.close();
      }
    },
  );

  test("renews through the injected scheduler and stops deterministically", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    const scheduler = fakeScheduler();
    try {
      const lease = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "heartbeat-owner",
      });
      const heartbeat = startWriterLeaseHeartbeat(database, lease, {
        now: clock.now,
        scheduler,
      });

      clock.set("2026-07-13T12:00:10.000Z");
      scheduler.tick();
      expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
        status: "live",
        heartbeatAt: "2026-07-13T12:00:10.000Z",
        expiresAt: "2026-07-13T12:00:40.000Z",
      });
      expect(heartbeat.failure).toBeUndefined();

      heartbeat.stop();
      clock.set("2026-07-13T12:00:20.000Z");
      scheduler.tick();
      expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
        heartbeatAt: "2026-07-13T12:00:10.000Z",
      });
      expect(scheduler.clear).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  test("rejects a backward heartbeat without corrupting the lease", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const lease = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "monotonic-heartbeat-owner",
      });

      clock.set("2026-07-13T11:59:59.000Z");
      expect(() => heartbeatWriterLease(database, lease, { now: clock.now })).toThrow(
        expect.objectContaining({ code: "writer-lease-lost" }),
      );
      clock.set("2026-07-13T12:00:01.000Z");
      expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
        status: "live",
        heartbeatAt: "2026-07-13T12:00:00.000Z",
        expiresAt: "2026-07-13T12:00:30.000Z",
      });
    } finally {
      database.close();
    }
  });

  test("expired takeover interrupts abandoned runs and fences the stale owner", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const first = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "expired-owner",
      });
      const runId = insertActiveRun(database);

      clock.set("2026-07-13T12:01:00.000Z");
      expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
        status: "expired",
        generation: 1,
      });
      const second = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "replacement-owner",
      });

      expect(second).toEqual({
        purpose: "index",
        generation: 2,
        token: "replacement-owner",
      });
      expect(
        database
          .prepare(
            `SELECT status, finished_at, failure_code
             FROM sessions_index_runs
             WHERE run_id = ?`,
          )
          .get(runId),
      ).toEqual({
        status: "interrupted",
        finished_at: "2026-07-13T12:01:00.000Z",
        failure_code: "interrupted",
      });
      expect(() => heartbeatWriterLease(database, first, { now: clock.now })).toThrow(
        expect.objectContaining({ code: "writer-lease-lost" }),
      );
      expect(interruptOwnedRunsAndReleaseWriterLease(database, first, { now: clock.now })).toBe(
        false,
      );
      expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
        status: "live",
        generation: 2,
        purpose: "index",
      });
    } finally {
      database.close();
    }
  });

  test("rolls back the generation and receipt when acquisition fails before commit", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const abandonedLease = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "rollback-abandoned-owner",
      });
      const runId = insertActiveRun(database);
      initializeWriterRecoveryReceipt(database, abandonedLease, {
        now: clock.now,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      });
      const leaseBefore = leaseRow(database);
      const receiptBefore = receiptRow(database);
      database.exec(`CREATE TEMP TRIGGER test_fail_takeover_receipt_clear
                     BEFORE DELETE ON sessions_index_generation_receipt
                     BEGIN
                       SELECT RAISE(ABORT, 'synthetic acquisition failure');
                     END`);

      clock.set("2026-07-13T12:01:00.000Z");
      expect(() =>
        acquireWriterSchema(database, "index", sqliteMigrations, {
          now: clock.now,
          token: () => "rollback-failed-takeover",
        }),
      ).toThrow("synthetic acquisition failure");

      expect(leaseRow(database)).toEqual(leaseBefore);
      expect(receiptRow(database)).toEqual(receiptBefore);
      expect(
        database
          .prepare(
            `SELECT status, finished_at, failure_code
             FROM sessions_index_runs
             WHERE run_id = ?`,
          )
          .get(runId),
      ).toEqual({ status: "active", finished_at: null, failure_code: null });

      database.exec("DROP TRIGGER temp.test_fail_takeover_receipt_clear");
      const replacement = acquireWriterSchema(database, "index", sqliteMigrations, {
        now: clock.now,
        token: () => "rollback-successful-takeover",
      });
      expect(replacement).toMatchObject({
        lease: { generation: abandonedLease.generation + 1, purpose: "index" },
        certifiedRecoveryCandidate: receiptBefore,
      });
      expect(receiptRow(database)).toBeUndefined();
      expect(
        database
          .prepare(
            `SELECT status, finished_at, failure_code
             FROM sessions_index_runs
             WHERE run_id = ?`,
          )
          .get(runId),
      ).toEqual({
        status: "interrupted",
        finished_at: "2026-07-13T12:01:00.000Z",
        failure_code: "interrupted",
      });
      expect(
        interruptOwnedRunsAndReleaseWriterLease(database, replacement.lease, { now: clock.now }),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  test("renews an expired exact owner without changing its generation", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const lease = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "recovering-owner",
      });
      clock.set("2026-07-13T12:01:00.000Z");

      expect(runLeasedImmediateTransaction(database, lease, { now: clock.now }, () => 42)).toBe(42);
      expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
        status: "live",
        generation: lease.generation,
        purpose: lease.purpose,
        heartbeatAt: "2026-07-13T12:01:00.000Z",
        expiresAt: "2026-07-13T12:01:30.000Z",
      });
    } finally {
      database.close();
    }
  });

  test("renews after body expiry while the immediate transaction blocks takeover", async () => {
    const { first, second } = await fileBackedDatabases();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const lease = acquireWriterLease(first, "index", {
        now: clock.now,
        token: () => "long-transaction-owner",
      });
      clock.set("2026-07-13T12:00:20.000Z");

      runLeasedImmediateTransaction(first, lease, { now: clock.now }, () => {
        first.exec("CREATE TABLE lease_sentinel (value TEXT NOT NULL)");
        first.prepare("INSERT INTO lease_sentinel VALUES (?)").run("committed");
        clock.set("2026-07-13T12:01:00.000Z");

        expect(() =>
          acquireWriterLease(second, "index", {
            now: clock.now,
            token: () => "blocked-takeover-owner",
          }),
        ).toThrow(expect.objectContaining({ errcode: 5 }));
      });

      expect(second.prepare("SELECT value FROM lease_sentinel").get()).toEqual({
        value: "committed",
      });
      expect(readWriterLeaseHealth(second, { now: clock.now })).toMatchObject({
        status: "live",
        generation: lease.generation,
        heartbeatAt: "2026-07-13T12:01:00.000Z",
        expiresAt: "2026-07-13T12:01:30.000Z",
      });
    } finally {
      first.close();
      second.close();
    }
  });

  test("fences an owner after a committed takeover before running its body", async () => {
    const { first, second } = await fileBackedDatabases();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const stale = acquireWriterLease(first, "index", {
        now: clock.now,
        token: () => "stale-transaction-owner",
      });
      clock.set("2026-07-13T12:01:00.000Z");
      const replacement = acquireWriterLease(second, "index", {
        now: clock.now,
        token: () => "replacement-transaction-owner",
      });
      let bodyRan = false;

      expect(() =>
        runLeasedImmediateTransaction(first, stale, { now: clock.now }, () => {
          bodyRan = true;
          first.exec("CREATE TABLE stale_owner_sentinel (value INTEGER NOT NULL)");
        }),
      ).toThrow(expect.objectContaining({ code: "writer-lease-lost" }));

      expect(bodyRan).toBe(false);
      expect(
        first.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'stale_owner_sentinel'").get(),
      ).toBeUndefined();
      expect(readWriterLeaseHealth(first, { now: clock.now })).toMatchObject({
        status: "live",
        generation: replacement.generation,
      });
    } finally {
      first.close();
      second.close();
    }
  });

  test("rolls back entry renewal and body writes when the body throws", async () => {
    const { first, second } = await fileBackedDatabases();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const lease = acquireWriterLease(first, "index", {
        now: clock.now,
        token: () => "rolling-back-owner",
      });
      const leaseBefore = leaseRow(first);
      clock.set("2026-07-13T12:01:00.000Z");

      expect(() =>
        runLeasedImmediateTransaction(first, lease, { now: clock.now }, () => {
          first.exec("CREATE TABLE rolled_back_sentinel (value INTEGER NOT NULL)");
          first.prepare("INSERT INTO rolled_back_sentinel VALUES (1)").run();
          throw new Error("synthetic body failure");
        }),
      ).toThrow("synthetic body failure");

      expect(leaseRow(second)).toEqual(leaseBefore);
      expect(
        second.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'rolled_back_sentinel'").get(),
      ).toBeUndefined();
      const replacement = acquireWriterLease(second, "index", {
        now: clock.now,
        token: () => "post-rollback-owner",
      });
      expect(replacement.generation).toBe(lease.generation + 1);
    } finally {
      first.close();
      second.close();
    }
  });

  test("rolls back when the leased transaction clock moves backward at exit", () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const lease = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "backward-transaction-owner",
      });
      const leaseBefore = leaseRow(database);
      let bodyRan = false;
      clock.set("2026-07-13T12:00:10.000Z");

      expect(() =>
        runLeasedImmediateTransaction(database, lease, { now: clock.now }, () => {
          bodyRan = true;
          database.exec("CREATE TABLE backward_clock_sentinel (value INTEGER NOT NULL)");
          clock.set("2026-07-13T12:00:09.000Z");
        }),
      ).toThrow(expect.objectContaining({ code: "writer-lease-lost" }));
      expect(bodyRan).toBe(true);
      expect(leaseRow(database)).toEqual(leaseBefore);
      expect(
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'backward_clock_sentinel'")
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });

  test("renews repository replacement after its transaction crosses lease expiry", async () => {
    const database = migratedDatabase();
    const acquiredAt = () => new Date("2026-07-13T12:00:00.000Z");
    try {
      const lease = acquireWriterLease(database, "index", {
        now: acquiredAt,
        token: () => "long-replacement-owner",
      });
      initializeWriterRecoveryReceipt(database, lease, {
        now: acquiredAt,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      });
      const index = createCoordinatedSqliteSessionIndex(database, {
        lease,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
        now: sequencedClock([
          "2026-07-13T12:00:00.000Z",
          "2026-07-13T12:00:00.000Z",
          "2026-07-13T12:00:20.000Z",
          "2026-07-13T12:01:00.000Z",
        ]),
      });
      const sessionIdentity = identity("long-replacement-profile", "session-one");
      const sessionObservation = observation(sessionIdentity, "revision-a");
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });

      await index.replaceSession(
        run,
        admittedReplacement(sessionObservation, minimalDocument(sessionIdentity)),
      );

      await expect(index.getFreshness(sessionIdentity)).resolves.toMatchObject({
        status: "current",
        lastGood: sessionObservation.revision,
      });
      const after = () => new Date("2026-07-13T12:01:00.000Z");
      expect(readWriterLeaseHealth(database, { now: after })).toMatchObject({
        status: "live",
        generation: lease.generation,
        heartbeatAt: "2026-07-13T12:01:00.000Z",
        expiresAt: "2026-07-13T12:01:30.000Z",
      });
      expect(interruptOwnedRunsAndReleaseWriterLease(database, lease, { now: after })).toBe(true);
    } finally {
      database.close();
    }
  });

  test("recovers an expired exact owner while recording a replacement failure", async () => {
    const database = migratedDatabase();
    const acquiredAt = () => new Date("2026-07-13T12:00:00.000Z");
    try {
      const lease = acquireWriterLease(database, "index", {
        now: acquiredAt,
        token: () => "failed-replacement-owner",
      });
      initializeWriterRecoveryReceipt(database, lease, {
        now: acquiredAt,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      });
      const index = createCoordinatedSqliteSessionIndex(database, {
        lease,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
        now: sequencedClock([
          "2026-07-13T12:00:00.000Z",
          "2026-07-13T12:00:00.000Z",
          "2026-07-13T12:00:20.000Z",
          "2026-07-13T12:01:00.000Z",
          "2026-07-13T12:01:00.000Z",
        ]),
      });
      const sessionIdentity = identity("failed-replacement-profile", "session-one");
      const sessionObservation = observation(sessionIdentity, "revision-a");
      const run = await index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });
      database.exec(`CREATE TEMP TRIGGER fail_canonical_insert
                     BEFORE INSERT ON sessions_canonical_sessions
                     BEGIN
                       SELECT RAISE(ABORT, 'synthetic replacement failure');
                     END`);

      await expect(
        index.replaceSession(
          run,
          admittedReplacement(sessionObservation, minimalDocument(sessionIdentity)),
        ),
      ).rejects.toThrow("synthetic replacement failure");

      await expect(index.getFreshness(sessionIdentity)).resolves.toMatchObject({
        status: "unindexed",
        latest: { outcome: "failed", failure: "repository-write" },
      });
      const after = () => new Date("2026-07-13T12:01:00.000Z");
      expect(readWriterLeaseHealth(database, { now: after })).toMatchObject({
        status: "live",
        generation: lease.generation,
        heartbeatAt: "2026-07-13T12:01:00.000Z",
      });
      expect(interruptOwnedRunsAndReleaseWriterLease(database, lease, { now: after })).toBe(true);
    } finally {
      database.close();
    }
  });

  test("fences every stale repository mutation before it can change state", async () => {
    const database = migratedDatabase();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    try {
      const firstLease = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "first-repository-owner",
      });
      initializeWriterRecoveryReceipt(database, firstLease, {
        now: clock.now,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      });
      const first = createCoordinatedSqliteSessionIndex(database, {
        lease: firstLease,
        now: clock.now,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      });
      const sessionIdentity = identity("fencing-profile", "session-one");
      const sessionObservation = observation(sessionIdentity, "revision-a");
      const replacement = admittedReplacement(sessionObservation, minimalDocument(sessionIdentity));
      const run = await first.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T12:00:00.000Z",
      });

      clock.set("2026-07-13T12:01:00.000Z");
      const secondLease = acquireWriterLease(database, "index", {
        now: clock.now,
        token: () => "second-repository-owner",
      });

      const staleMutations = [
        () =>
          first.startRun({
            source: sessionIdentity.source,
            startedAt: "2026-07-13T12:01:00.000Z",
          }),
        () => first.getFreshnessBatch(run, [sessionIdentity]),
        () => first.listTrackedIdentitiesPage(run),
        () => first.recordUnchangedBatch(run, [sessionObservation]),
        () => first.recordFailure(run, sessionObservation, "malformed"),
        () => first.replaceSession(run, replacement),
        () => first.recordMissingBatch(run, [sessionIdentity]),
        () =>
          first.finishRun(run, {
            status: "incomplete",
            finishedAt: "2026-07-13T12:01:00.000Z",
            failure: "interrupted",
          }),
      ];
      for (const mutate of staleMutations) {
        await expect(mutate()).rejects.toMatchObject({ code: "writer-lease-lost" });
      }

      expect(
        database.prepare("SELECT COUNT(*) AS count FROM sessions_session_tracking").get(),
      ).toEqual({ count: 0 });
      expect(readWriterLeaseHealth(database, { now: clock.now })).toMatchObject({
        status: "live",
        generation: secondLease.generation,
      });
      expect(
        interruptOwnedRunsAndReleaseWriterLease(database, secondLease, { now: clock.now }),
      ).toBe(true);
    } finally {
      database.close();
    }
  });

  test("rejects a second lifecycle writer while the first lease is live", async () => {
    const paths = await fixturePaths();
    const lifecycle = createSqliteIndexLifecycle({
      now: () => new Date("2026-07-13T12:00:00.000Z"),
      writerToken: () => "live-lifecycle-owner",
    });
    const first = await lifecycle.openWriter(paths);
    first.database.exec(
      `INSERT INTO sessions_content_fts (sessions_content_fts, rank)
       VALUES ('secure-delete', 0)`,
    );

    await expect(lifecycle.openWriter(paths)).rejects.toMatchObject({ code: "writer-busy" });
    expect(
      first.database
        .prepare("SELECT v FROM sessions_content_fts_config WHERE k = 'secure-delete'")
        .get(),
    ).toEqual({ v: 0 });

    await first.close();
  });

  test("renews the lifecycle lease through its injected scheduler", async () => {
    const paths = await fixturePaths();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    const scheduler = fakeScheduler();
    const writer = await createSqliteIndexLifecycle({
      now: clock.now,
      writerScheduler: scheduler,
      writerToken: () => "scheduled-lifecycle-owner",
    }).openWriter(paths);

    clock.set("2026-07-13T12:00:10.000Z");
    scheduler.tick();

    expect(readWriterLeaseHealth(writer.database, { now: clock.now })).toMatchObject({
      status: "live",
      heartbeatAt: "2026-07-13T12:00:10.000Z",
      expiresAt: "2026-07-13T12:00:40.000Z",
    });
    await writer.close();
    expect(scheduler.clear).toHaveBeenCalledOnce();
  });

  test("surfaces a heartbeat lease loss during writer close", async () => {
    const paths = await fixturePaths();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    const scheduler = fakeScheduler();
    const lifecycle = createSqliteIndexLifecycle({
      now: clock.now,
      writerScheduler: scheduler,
      writerToken: () => "expiring-lifecycle-owner",
    });
    const writer = await lifecycle.openWriter(paths);

    clock.set("2026-07-13T12:01:00.000Z");
    scheduler.tick();

    const closeFailure = await writer.close().catch((error: unknown) => error);
    expect(closeFailure).toBeInstanceOf(AggregateError);
    const errors = (closeFailure as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expectCaptureLeaseFailure(errors[0]);
    expect(errors[1]).toMatchObject({ code: "writer-lease-lost" });
    const replacement = await lifecycle.openWriter(paths);
    await replacement.close();
  });

  test("surfaces silent lease expiry during writer close", async () => {
    const paths = await fixturePaths();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    const lifecycle = createSqliteIndexLifecycle({
      now: clock.now,
      writerToken: () => "silently-expired-owner",
    });
    const writer = await lifecycle.openWriter(paths);
    await writer.sessions.startRun({
      source: { kind: "synthetic", instanceId: "expired-close-profile" },
      startedAt: "2026-07-13T12:00:00.000Z",
    });

    clock.set("2026-07-13T12:01:00.000Z");
    const closeFailure = await writer.close().catch((error: unknown) => error);
    expect(closeFailure).toBeInstanceOf(AggregateError);
    const errors = (closeFailure as AggregateError).errors;
    expect(errors).toHaveLength(2);
    expectCaptureLeaseFailure(errors[0]);
    expect(errors[1]).toMatchObject({ code: "writer-lease-lost" });

    const replacement = await lifecycle.openWriter(paths);
    await replacement.close();
  });

  test("normal close interrupts this writer's run and releases its lease", async () => {
    const paths = await fixturePaths();
    const clock = fakeClock("2026-07-13T12:00:00.000Z");
    const writer = await createSqliteIndexLifecycle({
      now: clock.now,
      writerToken: () => "closing-lifecycle-owner",
    }).openWriter(paths);
    const run = await writer.sessions.startRun({
      source: { kind: "synthetic", instanceId: "close-profile" },
      startedAt: "2026-07-13T12:00:00.000Z",
    });

    clock.set("2026-07-13T12:00:01.000Z");
    await writer.close();

    const database = new DatabaseSync(paths.database, { readOnly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT status, finished_at, failure_code
             FROM sessions_index_runs
             WHERE run_id = ?`,
          )
          .get(Number(run.id)),
      ).toEqual({
        status: "interrupted",
        finished_at: "2026-07-13T12:00:01.000Z",
        failure_code: "interrupted",
      });
      expect(readWriterLeaseHealth(database, { now: clock.now })).toEqual({
        status: "free",
        generation: 1,
      });
    } finally {
      database.close();
    }
  });
});

function expectCaptureLeaseFailure(error: unknown): void {
  expect(error).toBeInstanceOf(SourceCaptureWorkspaceError);
  expect((error as SourceCaptureWorkspaceError).cause).toMatchObject({
    code: "writer-lease-lost",
  });
}

function openDatabase(file = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(file, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  return database;
}

function migratedDatabase(): DatabaseSync {
  const database = openDatabase();
  applyMigrations(database);
  return database;
}

async function fileBackedDatabases(): Promise<{
  readonly first: DatabaseSync;
  readonly second: DatabaseSync;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-writer-lease-transaction-"));
  temporaryDirectories.push(root);
  const file = path.join(root, "sessions.sqlite3");
  const first = openDatabase(file);
  applyMigrations(first);
  const second = openDatabase(file);
  first.exec("PRAGMA busy_timeout = 0");
  second.exec("PRAGMA busy_timeout = 0");
  return { first, second };
}

function leaseRow(database: DatabaseSync): unknown {
  return database.prepare("SELECT * FROM sessions_writer_lease WHERE singleton = 1").get();
}

function receiptRow(database: DatabaseSync): WriterRecoveryReceipt | undefined {
  const row = database
    .prepare(
      `SELECT receipt_version, writer_generation, schema_version, schema_cookie,
              operation_sequence
       FROM sessions_index_generation_receipt
       WHERE singleton = 1`,
    )
    .get() as
    | {
        readonly receipt_version: number;
        readonly writer_generation: number;
        readonly schema_version: number;
        readonly schema_cookie: number;
        readonly operation_sequence: number;
      }
    | undefined;
  return row === undefined
    ? undefined
    : {
        receiptVersion: 1,
        writerGeneration: row.writer_generation,
        schemaVersion: row.schema_version,
        schemaCookie: row.schema_cookie,
        operationSequence: row.operation_sequence,
      };
}

function insertActiveRun(database: DatabaseSync): number {
  const source = database
    .prepare(
      `INSERT INTO sessions_source_instances (kind, instance_id)
       VALUES ('synthetic', 'abandoned-profile')
       RETURNING source_instance_id`,
    )
    .get() as { readonly source_instance_id: number | bigint };
  const run = database
    .prepare(
      `INSERT INTO sessions_index_runs (source_instance_id, status, started_at)
       VALUES (?, 'active', '2026-07-13T12:00:00.000Z')
       RETURNING run_id`,
    )
    .get(source.source_instance_id) as { readonly run_id: number | bigint };
  return Number(run.run_id);
}

function fakeClock(initial: string): {
  readonly now: () => Date;
  readonly set: (timestamp: string) => void;
} {
  let milliseconds = Date.parse(initial);
  return {
    now: () => new Date(milliseconds),
    set(timestamp) {
      milliseconds = Date.parse(timestamp);
    },
  };
}

function sequencedClock(timestamps: readonly string[]): () => Date {
  let index = 0;
  return () => {
    const timestamp = timestamps[index];
    if (timestamp === undefined) throw new Error("Sequenced clock was exhausted");
    index += 1;
    return new Date(timestamp);
  };
}

function fakeScheduler(): WriterLeaseScheduler & {
  readonly tick: () => void;
  readonly clear: ReturnType<typeof vi.fn>;
} {
  let callback: (() => void) | undefined;
  const clear = vi.fn<(handle: unknown) => void>();
  return {
    setInterval(next) {
      callback = next;
      return "heartbeat-handle";
    },
    clearInterval(handle) {
      clear(handle);
      callback = undefined;
    },
    tick() {
      callback?.();
    },
    clear,
  };
}

async function fixturePaths(): Promise<IndexPaths> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-writer-coordination-"));
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
