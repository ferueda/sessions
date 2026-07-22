import type { DatabaseSync } from "node:sqlite";

import {
  INDEX_GENERATION_RECEIPT_TABLE,
  INDEX_GENERATION_RECEIPT_TABLE_SQL,
} from "./migrations/0003-index-generation-receipt.ts";
import {
  assertWriterLease,
  runLeasedImmediateTransaction,
  type WriterLeaseHealth,
  type WriterLeaseIdentity,
} from "./writer-lease.ts";

const RECEIPT_VERSION = 1;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface WriterRecoveryReceipt {
  readonly receiptVersion: 1;
  readonly writerGeneration: number;
  readonly schemaVersion: number;
  readonly schemaCookie: number;
  readonly operationSequence: number;
}

export interface CertifiedRecoveryCandidate extends WriterRecoveryReceipt {
  readonly kind: "certified-recovery";
}

export type WriterRecoveryReceiptStructure = "exact" | "missing" | "altered";

export type WriterRecoveryReceiptErrorCode =
  | "invalid-structure"
  | "invalid-receipt"
  | "missing-receipt"
  | "sequence-exhausted";

export class WriterRecoveryReceiptError extends Error {
  readonly code: WriterRecoveryReceiptErrorCode;

  constructor(code: WriterRecoveryReceiptErrorCode, options?: ErrorOptions) {
    super(`SQLite writer recovery receipt failed: ${code}`, options);
    this.name = "WriterRecoveryReceiptError";
    this.code = code;
  }
}

export interface WriterRecoveryReceiptOptions {
  readonly now: () => Date;
  readonly schemaVersion: number;
}

/** Inspect proof only while acquisition still holds the old lease row locked. */
export function inspectWriterRecoveryReceiptCandidate(
  database: DatabaseSync,
  priorLease: WriterLeaseHealth,
  schemaVersion: number,
): CertifiedRecoveryCandidate | undefined {
  assertInTransaction(database);
  assertSchemaVersion(schemaVersion);
  if (
    priorLease.status !== "expired" ||
    priorLease.purpose !== "index" ||
    inspectWriterRecoveryReceiptStructure(database) !== "exact"
  ) {
    return undefined;
  }

  const receipt = readReceiptSafely(database);
  if (
    receipt === undefined ||
    receipt.writerGeneration !== priorLease.generation ||
    receipt.schemaVersion !== schemaVersion ||
    receipt.schemaCookie !== readSchemaCookie(database)
  ) {
    return undefined;
  }
  return { kind: "certified-recovery", ...receipt };
}

/** Recheck that acquisition and migrations did not change the candidate's proof boundary. */
export function certifiedRecoveryCandidateMatchesCurrentOwner(
  database: DatabaseSync,
  candidate: CertifiedRecoveryCandidate,
  lease: WriterLeaseIdentity,
  options: WriterRecoveryReceiptOptions,
): boolean {
  assertSchemaVersion(options.schemaVersion);
  if (lease.purpose !== "index") return false;
  assertWriterLease(database, lease, options);
  return (
    candidate.writerGeneration < MAX_SAFE_INTEGER &&
    candidate.writerGeneration + 1 === lease.generation &&
    candidate.schemaVersion === options.schemaVersion &&
    candidate.schemaCookie === readSchemaCookie(database) &&
    inspectWriterRecoveryReceiptStructure(database) === "exact"
  );
}

/** Remove old evidence only after acquisition has established the new exact owner. */
export function clearWriterRecoveryReceiptInTransaction(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  options: Pick<WriterRecoveryReceiptOptions, "now">,
): void {
  assertOwnedIndexTransaction(database, lease, options);
  assertExactStructure(database);
  database.prepare(`DELETE FROM ${INDEX_GENERATION_RECEIPT_TABLE}`).run();
}

/** Create sequence zero after every integrity-bearing writer setup step has passed. */
export function initializeWriterRecoveryReceiptInTransaction(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  options: WriterRecoveryReceiptOptions,
): WriterRecoveryReceipt {
  assertOwnedIndexTransaction(database, lease, options);
  assertSchemaVersion(options.schemaVersion);
  assertExactStructure(database);
  if (readReceiptRows(database).length !== 0) {
    throw new WriterRecoveryReceiptError("invalid-receipt");
  }

  const receipt: WriterRecoveryReceipt = {
    receiptVersion: RECEIPT_VERSION,
    writerGeneration: lease.generation,
    schemaVersion: options.schemaVersion,
    schemaCookie: readSchemaCookie(database),
    operationSequence: 0,
  };
  const result = database
    .prepare(
      `INSERT INTO ${INDEX_GENERATION_RECEIPT_TABLE} (
         singleton,
         receipt_version,
         writer_generation,
         schema_version,
         schema_cookie,
         operation_sequence
       ) VALUES (1, ?, ?, ?, ?, ?)`,
    )
    .run(
      receipt.receiptVersion,
      receipt.writerGeneration,
      receipt.schemaVersion,
      receipt.schemaCookie,
      receipt.operationSequence,
    );
  if (result.changes !== 1) throw new WriterRecoveryReceiptError("invalid-receipt");
  return assertReceiptOwnership(database, lease, options.schemaVersion);
}

/** Initialize sequence zero in one leased transaction for composed writer setup. */
export function initializeWriterRecoveryReceipt(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  options: WriterRecoveryReceiptOptions,
): WriterRecoveryReceipt {
  return runLeasedImmediateTransaction(database, lease, options, (transactionNow) =>
    initializeWriterRecoveryReceiptInTransaction(database, lease, {
      ...options,
      now: transactionNow,
    }),
  );
}

/** Advance once inside the same transaction as one certified index mutation. */
export function advanceWriterRecoveryReceiptInTransaction(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  options: WriterRecoveryReceiptOptions,
): WriterRecoveryReceipt {
  assertOwnedIndexTransaction(database, lease, options);
  assertSchemaVersion(options.schemaVersion);
  assertExactStructure(database);
  const receipt = assertReceiptOwnership(database, lease, options.schemaVersion);
  if (receipt.operationSequence === MAX_SAFE_INTEGER) {
    throw new WriterRecoveryReceiptError("sequence-exhausted");
  }

  const nextSequence = receipt.operationSequence + 1;
  const result = database
    .prepare(
      `UPDATE ${INDEX_GENERATION_RECEIPT_TABLE}
       SET operation_sequence = ?
       WHERE singleton = 1
         AND receipt_version = ?
         AND writer_generation = ?
         AND schema_version = ?
         AND schema_cookie = ?
         AND operation_sequence = ?`,
    )
    .run(
      nextSequence,
      receipt.receiptVersion,
      receipt.writerGeneration,
      receipt.schemaVersion,
      receipt.schemaCookie,
      receipt.operationSequence,
    );
  if (result.changes !== 1) throw new WriterRecoveryReceiptError("invalid-receipt");
  return { ...receipt, operationSequence: nextSequence };
}

/** Commit one supported index mutation and its receipt boundary atomically. */
export function runCertifiedIndexMutation<T>(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  options: WriterRecoveryReceiptOptions,
  operation: () => T,
): T {
  if (lease.purpose !== "index") {
    throw new TypeError("Certified index mutation requires index ownership");
  }
  return runLeasedImmediateTransaction(database, lease, options, (transactionNow) => {
    const result = operation();
    advanceWriterRecoveryReceiptInTransaction(database, lease, {
      ...options,
      now: transactionNow,
    });
    return result;
  });
}

/** Classify the complete fixed-table shape without trusting its rows. */
export function inspectWriterRecoveryReceiptStructure(
  database: DatabaseSync,
): WriterRecoveryReceiptStructure {
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database
      .prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE name = ? OR tbl_name = ?
         ORDER BY type COLLATE BINARY, name COLLATE BINARY`,
      )
      .all(INDEX_GENERATION_RECEIPT_TABLE, INDEX_GENERATION_RECEIPT_TABLE) as readonly Record<
      string,
      unknown
    >[];
  } catch {
    return "altered";
  }
  if (rows.length === 0) return "missing";
  return rows.length === 1 &&
    rows[0]?.type === "table" &&
    rows[0]?.name === INDEX_GENERATION_RECEIPT_TABLE &&
    rows[0]?.tbl_name === INDEX_GENERATION_RECEIPT_TABLE &&
    rows[0]?.sql === INDEX_GENERATION_RECEIPT_TABLE_SQL
    ? "exact"
    : "altered";
}

/** Rebuild only this operational-proof table; callers must still run full validation. */
export function repairWriterRecoveryReceiptStructureInTransaction(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  options: Pick<WriterRecoveryReceiptOptions, "now">,
): boolean {
  assertOwnedIndexTransaction(database, lease, options);
  const structure = inspectWriterRecoveryReceiptStructure(database);
  if (structure === "exact") return false;

  const namedObject = database
    .prepare("SELECT type FROM sqlite_schema WHERE name = ?")
    .get(INDEX_GENERATION_RECEIPT_TABLE) as { readonly type?: unknown } | undefined;
  if (namedObject !== undefined && namedObject.type !== "table") {
    throw new WriterRecoveryReceiptError("invalid-structure");
  }
  if (namedObject?.type === "table") {
    database.exec(`DROP TABLE ${INDEX_GENERATION_RECEIPT_TABLE}`);
  }
  database.exec(INDEX_GENERATION_RECEIPT_TABLE_SQL);
  assertExactStructure(database);
  return true;
}

function assertReceiptOwnership(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  schemaVersion: number,
): WriterRecoveryReceipt {
  const rows = readReceiptRows(database);
  if (rows.length === 0) throw new WriterRecoveryReceiptError("missing-receipt");
  if (rows.length !== 1) throw new WriterRecoveryReceiptError("invalid-receipt");
  const receipt = decodeReceipt(rows[0]);
  if (
    receipt.writerGeneration !== lease.generation ||
    receipt.schemaVersion !== schemaVersion ||
    receipt.schemaCookie !== readSchemaCookie(database)
  ) {
    throw new WriterRecoveryReceiptError("invalid-receipt");
  }
  return receipt;
}

function readReceiptSafely(database: DatabaseSync): WriterRecoveryReceipt | undefined {
  try {
    const rows = readReceiptRows(database);
    return rows.length === 1 ? decodeReceipt(rows[0]) : undefined;
  } catch {
    return undefined;
  }
}

function readReceiptRows(database: DatabaseSync): readonly Record<string, unknown>[] {
  try {
    return database
      .prepare(
        `SELECT singleton, receipt_version, writer_generation, schema_version,
                schema_cookie, operation_sequence
         FROM ${INDEX_GENERATION_RECEIPT_TABLE}
         ORDER BY singleton
         LIMIT 2`,
      )
      .all() as readonly Record<string, unknown>[];
  } catch (error) {
    throw new WriterRecoveryReceiptError("invalid-structure", { cause: error });
  }
}

function decodeReceipt(row: Record<string, unknown> | undefined): WriterRecoveryReceipt {
  if (row === undefined) throw new WriterRecoveryReceiptError("invalid-receipt");
  const singleton = safeInteger(row.singleton, 1);
  const receiptVersion = safeInteger(row.receipt_version, 1);
  const writerGeneration = safeInteger(row.writer_generation, 1);
  const schemaVersion = safeInteger(row.schema_version, 1);
  const schemaCookie = safeInteger(row.schema_cookie, 0);
  const operationSequence = safeInteger(row.operation_sequence, 0);
  if (singleton !== 1 || receiptVersion !== RECEIPT_VERSION) {
    throw new WriterRecoveryReceiptError("invalid-receipt");
  }
  return {
    receiptVersion,
    writerGeneration,
    schemaVersion,
    schemaCookie,
    operationSequence,
  };
}

function assertOwnedIndexTransaction(
  database: DatabaseSync,
  lease: WriterLeaseIdentity,
  options: Pick<WriterRecoveryReceiptOptions, "now">,
): void {
  assertInTransaction(database);
  if (lease.purpose !== "index") {
    throw new TypeError("Writer recovery receipt requires index ownership");
  }
  assertWriterLease(database, lease, options);
}

function assertExactStructure(database: DatabaseSync): void {
  if (inspectWriterRecoveryReceiptStructure(database) !== "exact") {
    throw new WriterRecoveryReceiptError("invalid-structure");
  }
}

function assertInTransaction(database: DatabaseSync): void {
  if (!database.isTransaction) {
    throw new TypeError("Writer recovery receipt transaction must already be active");
  }
}

function assertSchemaVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Writer recovery receipt schema version must be a positive safe integer");
  }
}

function readSchemaCookie(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA schema_version").get() as
    | { readonly schema_version?: unknown }
    | undefined;
  const value = row?.schema_version;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WriterRecoveryReceiptError("invalid-receipt");
  }
  return value;
}

function safeInteger(value: unknown, minimum: number): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (
    typeof result !== "number" ||
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > MAX_SAFE_INTEGER
  ) {
    throw new WriterRecoveryReceiptError("invalid-receipt");
  }
  return result;
}
