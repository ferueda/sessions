import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  CURRENT_INDEX_SCHEMA_VERSION,
  applyMigrations,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { INDEX_GENERATION_RECEIPT_TABLE } from "../../src/infrastructure/sqlite/migrations/0003-index-generation-receipt.ts";
import { runImmediateTransaction } from "../../src/infrastructure/sqlite/sqlite-session-transaction.ts";
import {
  advanceWriterRecoveryReceiptInTransaction,
  certifiedRecoveryCandidateMatchesCurrentOwner,
  clearWriterRecoveryReceiptInTransaction,
  initializeWriterRecoveryReceiptInTransaction,
  inspectWriterRecoveryReceiptCandidate,
  inspectWriterRecoveryReceiptStructure,
  repairWriterRecoveryReceiptStructureInTransaction,
  runCertifiedIndexMutation,
  WriterRecoveryReceiptError,
} from "../../src/infrastructure/sqlite/writer-recovery-receipt.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
  readWriterLeaseHealth,
  runLeasedImmediateTransaction,
  type WriterLeaseIdentity,
} from "../../src/infrastructure/sqlite/writer-lease.ts";

const START = new Date("2026-07-21T12:00:00.000Z");
const BEFORE_EXPIRY = new Date("2026-07-21T12:00:01.000Z");
const AFTER_EXPIRY = new Date("2026-07-21T12:00:31.000Z");

describe("writer recovery receipt", () => {
  test("initializes sequence zero and advances one atomic mutation at a time", () => {
    const database = migratedDatabase();
    try {
      const lease = acquireIndexLease(database);
      initializeReceipt(database, lease);
      expect(receiptRow(database)).toMatchObject({ operation_sequence: 0 });

      const result = runCertifiedIndexMutation(
        database,
        lease,
        receiptOptions(BEFORE_EXPIRY),
        () => {
          database
            .prepare(
              `INSERT INTO sessions_source_instances (kind, instance_id)
               VALUES ('synthetic', 'committed')`,
            )
            .run();
          return "committed";
        },
      );

      expect(result).toBe("committed");
      expect(receiptRow(database)).toMatchObject({ operation_sequence: 1 });
      expect(sourceInstances(database)).toEqual(["committed"]);
    } finally {
      database.close();
    }
  });

  test("rolls back both operation and receipt when the operation or postcondition throws", () => {
    const database = migratedDatabase();
    try {
      const lease = acquireIndexLease(database);
      initializeReceipt(database, lease);

      expect(() =>
        runCertifiedIndexMutation(database, lease, receiptOptions(BEFORE_EXPIRY), () => {
          database
            .prepare(
              `INSERT INTO sessions_source_instances (kind, instance_id)
               VALUES ('synthetic', 'rolled-back')`,
            )
            .run();
          throw new Error("forced postcondition failure");
        }),
      ).toThrow("forced postcondition failure");

      expect(sourceInstances(database)).toEqual([]);
      expect(receiptRow(database)).toMatchObject({ operation_sequence: 0 });
    } finally {
      database.close();
    }
  });

  test("rolls back the operation when receipt ownership is stale", () => {
    const database = migratedDatabase();
    try {
      const lease = acquireIndexLease(database);
      initializeReceipt(database, lease);
      database
        .prepare(
          `UPDATE ${INDEX_GENERATION_RECEIPT_TABLE}
           SET writer_generation = writer_generation + 1`,
        )
        .run();

      expect(() =>
        runCertifiedIndexMutation(database, lease, receiptOptions(BEFORE_EXPIRY), () => {
          database
            .prepare(
              `INSERT INTO sessions_source_instances (kind, instance_id)
               VALUES ('synthetic', 'not-certified')`,
            )
            .run();
        }),
      ).toThrowError(WriterRecoveryReceiptError);

      expect(sourceInstances(database)).toEqual([]);
      expect(receiptRow(database)).toMatchObject({ writer_generation: 2, operation_sequence: 0 });
    } finally {
      database.close();
    }
  });

  test("rolls back receipt advancement when SQLite rejects the shared commit", () => {
    const database = migratedDatabase();
    try {
      const lease = acquireIndexLease(database);
      initializeReceipt(database, lease);

      expect(() =>
        runCertifiedIndexMutation(database, lease, receiptOptions(BEFORE_EXPIRY), () => {
          database.exec("PRAGMA defer_foreign_keys = ON");
          database
            .prepare(
              `INSERT INTO sessions_relations (
                 session_id, ordinal, kind, target_kind,
                 target_instance_id, target_native_id, confidence
               ) VALUES (999, 0, 'parent', 'synthetic', 'generic', 'missing', 'high')`,
            )
            .run();
        }),
      ).toThrow(/FOREIGN KEY constraint failed/u);

      expect(receiptRow(database)).toMatchObject({ operation_sequence: 0 });
      expect(database.prepare("SELECT * FROM sessions_relations").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("selects only an exact expired index generation and rechecks the new owner", () => {
    const database = migratedDatabase();
    try {
      const priorLease = acquireIndexLease(database);
      initializeReceipt(database, priorLease);
      runCertifiedIndexMutation(
        database,
        priorLease,
        receiptOptions(BEFORE_EXPIRY),
        () => undefined,
      );

      expect(inspectCandidate(database, START)).toBeUndefined();
      const candidate = inspectCandidate(database, AFTER_EXPIRY);
      expect(candidate).toMatchObject({
        kind: "certified-recovery",
        writerGeneration: 1,
        schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
        operationSequence: 1,
      });
      if (candidate === undefined) throw new Error("Expected a certified recovery candidate");

      const nextLease = acquireWriterLease(database, "index", {
        now: () => AFTER_EXPIRY,
        token: () => "index-owner-two",
      });
      expect(
        certifiedRecoveryCandidateMatchesCurrentOwner(
          database,
          candidate,
          nextLease,
          receiptOptions(AFTER_EXPIRY),
        ),
      ).toBe(true);

      runImmediateTransaction(database, () =>
        clearWriterRecoveryReceiptInTransaction(database, nextLease, {
          now: () => AFTER_EXPIRY,
        }),
      );
      expect(receiptRows(database)).toEqual([]);

      database.exec("CREATE TABLE unrelated_schema_change (value INTEGER) STRICT");
      expect(
        certifiedRecoveryCandidateMatchesCurrentOwner(
          database,
          candidate,
          nextLease,
          receiptOptions(AFTER_EXPIRY),
        ),
      ).toBe(false);
    } finally {
      database.close();
    }
  });

  test("rejects free, maintenance, wrong-schema, and changed-cookie evidence", () => {
    const database = migratedDatabase();
    try {
      const lease = acquireIndexLease(database);
      initializeReceipt(database, lease);
      expect(
        inspectCandidate(database, AFTER_EXPIRY, CURRENT_INDEX_SCHEMA_VERSION - 1),
      ).toBeUndefined();

      database.exec("CREATE TABLE out_of_band_schema_change (value INTEGER) STRICT");
      expect(inspectCandidate(database, AFTER_EXPIRY)).toBeUndefined();

      expect(
        interruptOwnedRunsAndReleaseWriterLease(database, lease, {
          now: () => BEFORE_EXPIRY,
        }),
      ).toBe(true);
      expect(inspectCandidate(database, BEFORE_EXPIRY)).toBeUndefined();

      const repairLease = acquireWriterLease(database, "repair", {
        now: () => BEFORE_EXPIRY,
        token: () => "repair-owner",
      });
      expect(repairLease.purpose).toBe("repair");
      expect(inspectCandidate(database, AFTER_EXPIRY)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  test("treats malformed, missing, and duplicate receipt data as ineligible", () => {
    for (const corruption of [
      "missing",
      "malformed",
      "wrong-singleton",
      "multiple-singletons",
      "altered-duplicate",
    ] as const) {
      const database = migratedDatabase();
      try {
        const lease = acquireIndexLease(database);
        initializeReceipt(database, lease);

        if (corruption === "missing") {
          database.exec(`DELETE FROM ${INDEX_GENERATION_RECEIPT_TABLE}`);
        } else if (corruption === "malformed") {
          database.exec("PRAGMA ignore_check_constraints = ON");
          database.exec(
            `UPDATE ${INDEX_GENERATION_RECEIPT_TABLE}
             SET receipt_version = 2`,
          );
          database.exec("PRAGMA ignore_check_constraints = OFF");
        } else if (corruption === "wrong-singleton") {
          database.exec("PRAGMA ignore_check_constraints = ON");
          database.exec(`UPDATE ${INDEX_GENERATION_RECEIPT_TABLE} SET singleton = 2`);
          database.exec("PRAGMA ignore_check_constraints = OFF");
        } else if (corruption === "multiple-singletons") {
          database.exec("PRAGMA ignore_check_constraints = ON");
          database.exec(`UPDATE ${INDEX_GENERATION_RECEIPT_TABLE} SET singleton = 2`);
          database.exec(
            `INSERT INTO ${INDEX_GENERATION_RECEIPT_TABLE}
               (singleton, receipt_version, writer_generation, schema_version,
                schema_cookie, operation_sequence)
             SELECT 3, receipt_version, writer_generation, schema_version,
                    schema_cookie, operation_sequence
             FROM ${INDEX_GENERATION_RECEIPT_TABLE}
             WHERE singleton = 2`,
          );
          database.exec("PRAGMA ignore_check_constraints = OFF");
        } else {
          database.exec(`DROP TABLE ${INDEX_GENERATION_RECEIPT_TABLE}`);
          database.exec(
            `CREATE TABLE ${INDEX_GENERATION_RECEIPT_TABLE} (
               singleton INTEGER,
               receipt_version INTEGER,
               writer_generation INTEGER,
               schema_version INTEGER,
               schema_cookie INTEGER,
               operation_sequence INTEGER
             ) STRICT`,
          );
          database.exec(
            `INSERT INTO ${INDEX_GENERATION_RECEIPT_TABLE}
             VALUES (1, 1, 1, 3, 1, 0), (1, 1, 1, 3, 1, 0)`,
          );
        }

        expect(inspectCandidate(database, AFTER_EXPIRY)).toBeUndefined();
        expect(() =>
          runImmediateTransaction(database, () =>
            advanceWriterRecoveryReceiptInTransaction(
              database,
              lease,
              receiptOptions(BEFORE_EXPIRY),
            ),
          ),
        ).toThrowError(WriterRecoveryReceiptError);
      } finally {
        database.close();
      }
    }
  });

  test("fails closed when the safe operation sequence is exhausted", () => {
    const database = migratedDatabase();
    try {
      const lease = acquireIndexLease(database);
      initializeReceipt(database, lease);
      database
        .prepare(
          `UPDATE ${INDEX_GENERATION_RECEIPT_TABLE}
           SET operation_sequence = ?`,
        )
        .run(Number.MAX_SAFE_INTEGER);

      expect(() =>
        runCertifiedIndexMutation(database, lease, receiptOptions(BEFORE_EXPIRY), () => {
          database
            .prepare(
              `INSERT INTO sessions_source_instances (kind, instance_id)
               VALUES ('synthetic', 'sequence-exhausted')`,
            )
            .run();
        }),
      ).toThrowError(
        expect.objectContaining<Partial<WriterRecoveryReceiptError>>({
          code: "sequence-exhausted",
        }),
      );
      expect(sourceInstances(database)).toEqual([]);
      expect(receiptRow(database)).toMatchObject({
        operation_sequence: Number.MAX_SAFE_INTEGER,
      });
    } finally {
      database.close();
    }
  });

  test("repairs only a missing or altered receipt table under exact index ownership", () => {
    for (const structure of ["missing", "altered"] as const) {
      const database = migratedDatabase();
      try {
        const lease = acquireIndexLease(database);
        if (structure === "missing") {
          database.exec(`DROP TABLE ${INDEX_GENERATION_RECEIPT_TABLE}`);
        } else {
          database.exec(
            `CREATE INDEX sessions_index_generation_receipt_extra
             ON ${INDEX_GENERATION_RECEIPT_TABLE}(writer_generation)`,
          );
        }
        expect(inspectWriterRecoveryReceiptStructure(database)).toBe(structure);

        const repaired = runLeasedImmediateTransaction(
          database,
          lease,
          { now: () => BEFORE_EXPIRY },
          () =>
            repairWriterRecoveryReceiptStructureInTransaction(database, lease, {
              now: () => BEFORE_EXPIRY,
            }),
        );

        expect(repaired).toBe(true);
        expect(inspectWriterRecoveryReceiptStructure(database)).toBe("exact");
        expect(receiptRows(database)).toEqual([]);
      } finally {
        database.close();
      }
    }
  });

  test.each([
    {
      label: "an external schema dependency",
      mutate(database: DatabaseSync) {
        database.exec(`DROP TABLE ${INDEX_GENERATION_RECEIPT_TABLE};
CREATE VIEW receipt_dependency_view AS
SELECT extra FROM ${INDEX_GENERATION_RECEIPT_TABLE};`);
      },
    },
    {
      label: "a temporary name collision",
      mutate(database: DatabaseSync) {
        database.exec(`DROP TABLE ${INDEX_GENERATION_RECEIPT_TABLE};
CREATE TEMP TABLE ${INDEX_GENERATION_RECEIPT_TABLE} (singleton INTEGER PRIMARY KEY) STRICT;`);
      },
    },
    {
      label: "an attached schema",
      mutate(database: DatabaseSync) {
        database.exec(`DROP TABLE ${INDEX_GENERATION_RECEIPT_TABLE};
ATTACH ':memory:' AS attached_receipt_dependency;`);
      },
    },
  ])("refuses missing-table repair with $label", ({ mutate }) => {
    const database = migratedDatabase();
    try {
      const lease = acquireIndexLease(database);
      mutate(database);
      expect(inspectWriterRecoveryReceiptStructure(database)).toBe("missing");

      expect(() =>
        runLeasedImmediateTransaction(database, lease, { now: () => BEFORE_EXPIRY }, () =>
          repairWriterRecoveryReceiptStructureInTransaction(database, lease, {
            now: () => BEFORE_EXPIRY,
          }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<WriterRecoveryReceiptError>>({
          code: "invalid-structure",
        }),
      );
      expect(inspectWriterRecoveryReceiptStructure(database)).toBe("missing");
    } finally {
      database.close();
    }
  });

  test("refuses unsafe structure repair and every stale-owner mutation", () => {
    const database = migratedDatabase();
    try {
      const staleLease = acquireIndexLease(database);
      database.exec(`DROP TABLE ${INDEX_GENERATION_RECEIPT_TABLE}`);
      database.exec(
        `CREATE VIEW ${INDEX_GENERATION_RECEIPT_TABLE} AS
         SELECT 1 AS singleton`,
      );
      expect(() =>
        runLeasedImmediateTransaction(database, staleLease, { now: () => BEFORE_EXPIRY }, () =>
          repairWriterRecoveryReceiptStructureInTransaction(database, staleLease, {
            now: () => BEFORE_EXPIRY,
          }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<WriterRecoveryReceiptError>>({
          code: "invalid-structure",
        }),
      );
      expect(inspectWriterRecoveryReceiptStructure(database)).toBe("altered");

      database.exec(`DROP VIEW ${INDEX_GENERATION_RECEIPT_TABLE}`);
      database.exec(`CREATE VIRTUAL TABLE ${INDEX_GENERATION_RECEIPT_TABLE} USING fts5(value)`);
      expect(() =>
        runLeasedImmediateTransaction(database, staleLease, { now: () => BEFORE_EXPIRY }, () =>
          repairWriterRecoveryReceiptStructureInTransaction(database, staleLease, {
            now: () => BEFORE_EXPIRY,
          }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<WriterRecoveryReceiptError>>({
          code: "invalid-structure",
        }),
      );
      expect(inspectWriterRecoveryReceiptStructure(database)).toBe("altered");

      database.exec(`DROP TABLE ${INDEX_GENERATION_RECEIPT_TABLE}`);
      runLeasedImmediateTransaction(database, staleLease, { now: () => BEFORE_EXPIRY }, () =>
        repairWriterRecoveryReceiptStructureInTransaction(database, staleLease, {
          now: () => BEFORE_EXPIRY,
        }),
      );
      initializeReceipt(database, staleLease, BEFORE_EXPIRY);
      const nextLease = acquireWriterLease(database, "index", {
        now: () => AFTER_EXPIRY,
        token: () => "new-index-owner",
      });
      expect(nextLease.generation).toBe(2);

      for (const mutation of [
        () =>
          clearWriterRecoveryReceiptInTransaction(database, staleLease, {
            now: () => AFTER_EXPIRY,
          }),
        () =>
          initializeWriterRecoveryReceiptInTransaction(
            database,
            staleLease,
            receiptOptions(AFTER_EXPIRY),
          ),
        () =>
          advanceWriterRecoveryReceiptInTransaction(
            database,
            staleLease,
            receiptOptions(AFTER_EXPIRY),
          ),
        () =>
          repairWriterRecoveryReceiptStructureInTransaction(database, staleLease, {
            now: () => AFTER_EXPIRY,
          }),
      ]) {
        expect(() => runImmediateTransaction(database, mutation)).toThrow(/writer-lease-lost/u);
      }
      expect(receiptRow(database)).toMatchObject({ writer_generation: 1 });
    } finally {
      database.close();
    }
  });
});

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  applyMigrations(database);
  return database;
}

function acquireIndexLease(database: DatabaseSync): WriterLeaseIdentity {
  return acquireWriterLease(database, "index", {
    now: () => START,
    token: () => "index-owner-one",
  });
}

function initializeReceipt(database: DatabaseSync, lease: WriterLeaseIdentity, now = START): void {
  runImmediateTransaction(database, () =>
    initializeWriterRecoveryReceiptInTransaction(database, lease, receiptOptions(now)),
  );
}

function inspectCandidate(
  database: DatabaseSync,
  now: Date,
  schemaVersion: number = CURRENT_INDEX_SCHEMA_VERSION,
) {
  return runImmediateTransaction(database, () =>
    inspectWriterRecoveryReceiptCandidate(
      database,
      readWriterLeaseHealth(database, { now: () => now }),
      schemaVersion,
    ),
  );
}

function receiptOptions(now: Date) {
  return {
    now: () => now,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
  } as const;
}

function receiptRows(database: DatabaseSync): readonly Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT receipt_version, writer_generation, schema_version,
              schema_cookie, operation_sequence
       FROM ${INDEX_GENERATION_RECEIPT_TABLE}
       ORDER BY singleton`,
    )
    .all() as readonly Record<string, unknown>[];
}

function receiptRow(database: DatabaseSync): Record<string, unknown> {
  const row = receiptRows(database)[0];
  if (row === undefined) throw new Error("Expected writer recovery receipt");
  return row;
}

function sourceInstances(database: DatabaseSync): readonly string[] {
  return (
    database
      .prepare(
        `SELECT instance_id
         FROM sessions_source_instances
         ORDER BY instance_id COLLATE BINARY`,
      )
      .all() as unknown as readonly { readonly instance_id: string }[]
  ).map(({ instance_id }) => instance_id);
}
