import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { runImmediateTransaction } from "./sqlite-session-transaction.ts";

const LEASE_DURATION_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

export type WriterLeasePurpose = "index" | "forget" | "clear" | "compact";
export type SqliteWriterLeaseErrorCode = "writer-busy" | "writer-lease-lost" | "corrupt-data";

export class SqliteWriterLeaseError extends Error {
  readonly code: SqliteWriterLeaseErrorCode;

  constructor(code: SqliteWriterLeaseErrorCode, options?: { readonly cause?: unknown }) {
    super(
      `SQLite writer coordination failed: ${code}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SqliteWriterLeaseError";
    this.code = code;
  }
}

export interface WriterLeaseIdentity {
  readonly purpose: WriterLeasePurpose;
  readonly generation: number;
  readonly token: string;
}

export type WriterLeaseHealth =
  | {
      readonly status: "free";
      readonly generation: number;
    }
  | {
      readonly status: "live" | "expired";
      readonly generation: number;
      readonly purpose: WriterLeasePurpose;
      readonly acquiredAt: string;
      readonly heartbeatAt: string;
      readonly expiresAt: string;
    };

export interface WriterLeaseScheduler {
  setInterval(callback: () => void, milliseconds: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface WriterLeaseHeartbeat {
  readonly failure: unknown;
  stop(): void;
}

export interface AcquireWriterLeaseOptions {
  readonly now: () => Date;
  readonly token?: () => string;
}

interface WriterLeaseOperationOptions {
  readonly now: () => Date;
}

interface StartWriterLeaseHeartbeatOptions extends WriterLeaseOperationOptions {
  readonly scheduler?: WriterLeaseScheduler;
}

export function acquireWriterLease(
  database: DatabaseSync,
  purpose: WriterLeasePurpose,
  options: AcquireWriterLeaseOptions,
): WriterLeaseIdentity {
  return runImmediateTransaction(database, () =>
    acquireWriterLeaseInTransaction(database, purpose, options),
  );
}

/** Acquire while the caller holds the surrounding immediate transaction. */
export function acquireWriterLeaseInTransaction(
  database: DatabaseSync,
  purpose: WriterLeasePurpose,
  options: AcquireWriterLeaseOptions,
): WriterLeaseIdentity {
  if (!database.isTransaction) {
    throw new TypeError("Writer lease transaction must already be active");
  }
  if (!isPurpose(purpose)) throw new TypeError("Invalid writer lease purpose");
  const now = canonicalNow(options.now);
  const token = (options.token ?? randomUUID)();
  assertToken(token);
  const expiresAt = expiryFrom(now.date);

  const current = readLeaseRow(database);
  assertAcquirable(healthFromRow(current, now.timestamp), purpose);

  const generation = incrementGeneration(current.generation);
  const result = database
    .prepare(
      `UPDATE sessions_writer_lease
       SET generation = ?,
           purpose = ?,
           owner_token = ?,
           acquired_at = ?,
           heartbeat_at = ?,
           expires_at = ?
       WHERE singleton = 1 AND generation = ?`,
    )
    .run(generation, purpose, token, now.timestamp, now.timestamp, expiresAt, current.generation);
  if (result.changes !== 1) throw new SqliteWriterLeaseError("writer-lease-lost");

  database
    .prepare(
      `UPDATE sessions_index_runs
       SET status = 'interrupted',
           finished_at = ?,
           failure_code = 'interrupted'
       WHERE status = 'active'`,
    )
    .run(now.timestamp);

  return { purpose, generation, token };
}

/** Assert while the caller holds the surrounding write transaction. */
export function assertWriterLease(
  database: DatabaseSync,
  identity: WriterLeaseIdentity,
  options: WriterLeaseOperationOptions,
): void {
  const now = canonicalNow(options.now);
  assertWriterLeaseAt(database, identity, now.timestamp);
}

/** Run synchronous work while an immediate transaction fences this exact owner. */
export function runLeasedImmediateTransaction<T>(
  database: DatabaseSync,
  identity: WriterLeaseIdentity,
  options: WriterLeaseOperationOptions,
  operation: () => T,
): T {
  return runImmediateTransaction(database, () => {
    renewExactWriterLease(database, identity, canonicalNow(options.now), true);
    const result = operation();
    renewExactWriterLease(database, identity, canonicalNow(options.now), true);
    return result;
  });
}

export function heartbeatWriterLease(
  database: DatabaseSync,
  identity: WriterLeaseIdentity,
  options: WriterLeaseOperationOptions,
): void {
  const now = canonicalNow(options.now);
  runImmediateTransaction(database, () => {
    renewExactWriterLease(database, identity, now, false);
  });
}

export function interruptOwnedRunsAndReleaseWriterLease(
  database: DatabaseSync,
  identity: WriterLeaseIdentity,
  options: WriterLeaseOperationOptions,
): boolean {
  const now = canonicalNow(options.now);
  return runImmediateTransaction(database, () => {
    const row = readLeaseRow(database);
    assertLeaseClockDidNotMoveBackward(row, identity, now.timestamp);
    if (!isCurrentLiveLease(row, identity, now.timestamp)) return false;

    database
      .prepare(
        `UPDATE sessions_index_runs
         SET status = 'interrupted',
             finished_at = ?,
             failure_code = 'interrupted'
         WHERE status = 'active'`,
      )
      .run(now.timestamp);
    const result = database
      .prepare(
        `UPDATE sessions_writer_lease
         SET purpose = NULL,
             owner_token = NULL,
             acquired_at = NULL,
             heartbeat_at = NULL,
             expires_at = NULL
         WHERE singleton = 1
           AND generation = ?
           AND purpose = ?
           AND owner_token = ?
           AND expires_at > ?`,
      )
      .run(identity.generation, identity.purpose, identity.token, now.timestamp);
    if (result.changes !== 1) throw new SqliteWriterLeaseError("writer-lease-lost");
    return true;
  });
}

export function readWriterLeaseHealth(
  database: DatabaseSync,
  options: WriterLeaseOperationOptions,
): WriterLeaseHealth {
  return healthFromRow(readLeaseRow(database), canonicalNow(options.now).timestamp);
}

export function startWriterLeaseHeartbeat(
  database: DatabaseSync,
  identity: WriterLeaseIdentity,
  options: StartWriterLeaseHeartbeatOptions,
): WriterLeaseHeartbeat {
  const scheduler = options.scheduler ?? defaultScheduler;
  let stopped = false;
  let failure: unknown;
  let handle: unknown;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    scheduler.clearInterval(handle);
  };
  handle = scheduler.setInterval(() => {
    if (stopped) return;
    try {
      heartbeatWriterLease(database, identity, options);
    } catch (error) {
      failure = error;
      stop();
    }
  }, HEARTBEAT_INTERVAL_MS);
  unrefTimer(handle);

  return {
    get failure() {
      return failure;
    },
    stop,
  };
}

interface LeaseRow {
  readonly generation: unknown;
  readonly purpose: unknown;
  readonly owner_token: unknown;
  readonly acquired_at: unknown;
  readonly heartbeat_at: unknown;
  readonly expires_at: unknown;
}

function readLeaseRow(database: DatabaseSync): NormalizedLeaseRow {
  const row = database
    .prepare(
      `SELECT generation, purpose, owner_token, acquired_at, heartbeat_at, expires_at
       FROM sessions_writer_lease
       WHERE singleton = 1`,
    )
    .get() as LeaseRow | undefined;
  if (row === undefined) throw new SqliteWriterLeaseError("corrupt-data");

  const generation = integerAt(row.generation);
  const nullableValues = [
    row.purpose,
    row.owner_token,
    row.acquired_at,
    row.heartbeat_at,
    row.expires_at,
  ];
  if (nullableValues.every((value) => value === null)) {
    return {
      generation,
      purpose: null,
      owner_token: null,
      acquired_at: null,
      heartbeat_at: null,
      expires_at: null,
    };
  }
  if (
    !isPurpose(row.purpose) ||
    typeof row.owner_token !== "string" ||
    row.owner_token.length === 0 ||
    typeof row.acquired_at !== "string" ||
    typeof row.heartbeat_at !== "string" ||
    typeof row.expires_at !== "string"
  ) {
    throw new SqliteWriterLeaseError("corrupt-data");
  }
  assertCanonicalTimestamp(row.acquired_at);
  assertCanonicalTimestamp(row.heartbeat_at);
  assertCanonicalTimestamp(row.expires_at);
  if (row.acquired_at > row.heartbeat_at || row.heartbeat_at >= row.expires_at) {
    throw new SqliteWriterLeaseError("corrupt-data");
  }
  return {
    generation,
    purpose: row.purpose,
    owner_token: row.owner_token,
    acquired_at: row.acquired_at,
    heartbeat_at: row.heartbeat_at,
    expires_at: row.expires_at,
  };
}

interface NormalizedLeaseRow {
  readonly generation: number;
  readonly purpose: WriterLeasePurpose | null;
  readonly owner_token: string | null;
  readonly acquired_at: string | null;
  readonly heartbeat_at: string | null;
  readonly expires_at: string | null;
}

function healthFromRow(row: NormalizedLeaseRow, now: string): WriterLeaseHealth {
  if (row.purpose === null) return { status: "free", generation: row.generation };
  if (row.acquired_at === null || row.heartbeat_at === null || row.expires_at === null) {
    throw new SqliteWriterLeaseError("corrupt-data");
  }
  return {
    status: row.expires_at > now ? "live" : "expired",
    generation: row.generation,
    purpose: row.purpose,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
  };
}

function assertAcquirable(health: WriterLeaseHealth, requested: WriterLeasePurpose): void {
  if (health.status === "live") throw new SqliteWriterLeaseError("writer-busy");
  // An expired clear lease can represent a process between closing SQLite and
  // unlinking files. Only another clear may resume that destructive intent.
  if (health.status === "expired" && health.purpose === "clear" && requested !== "clear") {
    throw new SqliteWriterLeaseError("writer-busy");
  }
}

function assertWriterLeaseAt(
  database: DatabaseSync,
  identity: WriterLeaseIdentity,
  now: string,
): void {
  const row = readLeaseRow(database);
  assertLeaseClockDidNotMoveBackward(row, identity, now);
  if (!isCurrentLiveLease(row, identity, now)) {
    throw new SqliteWriterLeaseError("writer-lease-lost");
  }
}

function renewExactWriterLease(
  database: DatabaseSync,
  identity: WriterLeaseIdentity,
  now: { readonly date: Date; readonly timestamp: string },
  allowExpired: boolean,
): void {
  const row = readLeaseRow(database);
  assertLeaseClockDidNotMoveBackward(row, identity, now.timestamp);
  if (
    !isCurrentLease(row, identity) ||
    (!allowExpired && (row.expires_at === null || row.expires_at <= now.timestamp))
  ) {
    throw new SqliteWriterLeaseError("writer-lease-lost");
  }

  const result = database
    .prepare(
      `UPDATE sessions_writer_lease
       SET heartbeat_at = ?, expires_at = ?
       WHERE singleton = 1
         AND generation = ?
         AND purpose = ?
         AND owner_token = ?`,
    )
    .run(
      now.timestamp,
      expiryFrom(now.date),
      identity.generation,
      identity.purpose,
      identity.token,
    );
  if (result.changes !== 1) throw new SqliteWriterLeaseError("writer-lease-lost");
}

function assertLeaseClockDidNotMoveBackward(
  row: NormalizedLeaseRow,
  identity: WriterLeaseIdentity,
  now: string,
): void {
  if (
    row.generation === identity.generation &&
    row.purpose === identity.purpose &&
    row.owner_token === identity.token &&
    row.heartbeat_at !== null &&
    now < row.heartbeat_at
  ) {
    throw new SqliteWriterLeaseError("writer-lease-lost");
  }
}

function isCurrentLiveLease(
  row: NormalizedLeaseRow,
  identity: WriterLeaseIdentity,
  now: string,
): boolean {
  return isCurrentLease(row, identity) && row.expires_at !== null && row.expires_at > now;
}

function isCurrentLease(row: NormalizedLeaseRow, identity: WriterLeaseIdentity): boolean {
  return (
    row.generation === identity.generation &&
    row.purpose === identity.purpose &&
    row.owner_token === identity.token
  );
}

function canonicalNow(now: () => Date): { readonly date: Date; readonly timestamp: string } {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Writer lease clock must return a valid Date");
  }
  const timestamp = date.toISOString();
  if (!isCanonicalTimestamp(timestamp)) {
    throw new TypeError("Writer lease clock must return a four-digit UTC timestamp");
  }
  return { date, timestamp };
}

function expiryFrom(now: Date): string {
  const expiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();
  if (!isCanonicalTimestamp(expiresAt)) {
    throw new TypeError("Writer lease expiry exceeds the supported timestamp range");
  }
  return expiresAt;
}

function assertToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || token.length === 0 || !token.isWellFormed()) {
    throw new TypeError("Writer lease token must be a non-empty well-formed string");
  }
}

function incrementGeneration(value: number): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) throw new SqliteWriterLeaseError("corrupt-data");
  return next;
}

function integerAt(value: unknown): number {
  const result = typeof value === "bigint" ? Number(value) : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new SqliteWriterLeaseError("corrupt-data");
  }
  return result;
}

function isPurpose(value: unknown): value is WriterLeasePurpose {
  return value === "index" || value === "forget" || value === "clear" || value === "compact";
}

function assertCanonicalTimestamp(value: string): void {
  const milliseconds = Date.parse(value);
  if (!isCanonicalTimestamp(value) || !Number.isFinite(milliseconds)) {
    throw new SqliteWriterLeaseError("corrupt-data");
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

const defaultScheduler: WriterLeaseScheduler = {
  setInterval(callback, milliseconds) {
    return globalThis.setInterval(callback, milliseconds);
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
};

function unrefTimer(handle: unknown): void {
  if (
    typeof handle === "object" &&
    handle !== null &&
    "unref" in handle &&
    typeof handle.unref === "function"
  ) {
    handle.unref();
  }
}
