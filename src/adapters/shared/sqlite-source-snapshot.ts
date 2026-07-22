import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type { SourceCaptureWorkspace } from "../../application/ports/session-source.ts";

const MAX_SNAPSHOT_ATTEMPTS = 3;
const COPY_BUFFER_BYTES = 64 * 1024;
const PRIVATE_DATABASE_NAME = "state.sqlite";

export type SqliteSourceSnapshotFailureKind =
  | "malformed"
  | "source-changed"
  | "staging-failed"
  | "unreadable";

export class SqliteSourceSnapshotError extends Error {
  readonly kind: SqliteSourceSnapshotFailureKind;

  constructor(kind: SqliteSourceSnapshotFailureKind) {
    super(snapshotFailureMessage(kind));
    this.name = "SqliteSourceSnapshotError";
    this.kind = kind;
  }
}

export interface SqliteSourceSnapshotHooks {
  /** Test seam for deterministic provider mutation between copy and verification. */
  readonly beforePostVerification?: (attempt: number) => void | Promise<void>;
  /** Test seam after identities are observed but before post-copy bytes are hashed. */
  readonly beforePostHash?: (observation: SqliteSourceSnapshotBytePass) => void | Promise<void>;
  /** Sanitized test observation emitted after one complete provider byte pass. */
  readonly onBytePass?: (observation: SqliteSourceSnapshotBytePass) => void | Promise<void>;
}

export interface SqliteSourceSnapshotBytePass {
  readonly attempt: number;
  readonly phase: "copy" | "verify";
  readonly kind: "database" | "wal";
}

export interface SqliteSourceSnapshotOptions<T> {
  readonly databasePath: string;
  readonly workspace: SourceCaptureWorkspace;
  readonly materialize: (database: DatabaseSync) => T;
  readonly hooks?: SqliteSourceSnapshotHooks;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

interface OpenProviderFile {
  readonly kind: "database" | "wal";
  readonly path: string;
  readonly handle: FileHandle;
  readonly pathIdentity: FileIdentity;
  readonly handleIdentity: FileIdentity;
}

interface PrivateCopy {
  readonly databasePath: string;
  readonly copiedDigests: ReadonlyMap<OpenProviderFile["kind"], string>;
}

class SnapshotChangedError extends Error {}

/**
 * Materialize one state generation without ever giving SQLite a provider path.
 */
export async function materializeSqliteSourceSnapshot<T>(
  options: SqliteSourceSnapshotOptions<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
    try {
      return await options.workspace.withPrivateDirectory((directory) =>
        captureAttempt(options, directory, attempt),
      );
    } catch (error) {
      if (!(error instanceof SnapshotChangedError)) throw error;
      if (attempt === MAX_SNAPSHOT_ATTEMPTS) {
        throw new SqliteSourceSnapshotError("source-changed");
      }
    }
  }

  throw new SqliteSourceSnapshotError("source-changed");
}

async function captureAttempt<T>(
  options: SqliteSourceSnapshotOptions<T>,
  privateDirectory: string,
  attempt: number,
): Promise<T> {
  let providerFiles: readonly OpenProviderFile[];
  try {
    providerFiles = await openProviderSet(options.databasePath);
  } catch (error) {
    if (error instanceof SnapshotChangedError || error instanceof SqliteSourceSnapshotError) {
      throw error;
    }
    throw new SqliteSourceSnapshotError("unreadable");
  }

  try {
    const privateCopy = await copyProviderFiles(
      providerFiles,
      privateDirectory,
      attempt,
      options.hooks,
    );
    await options.hooks?.beforePostVerification?.(attempt);
    await verifyProviderFiles(providerFiles, privateCopy.copiedDigests, attempt, options.hooks);
    return materializePrivateCopy(privateCopy.databasePath, options.materialize);
  } finally {
    await closeAll(providerFiles);
  }
}

async function openProviderSet(databasePath: string): Promise<readonly OpenProviderFile[]> {
  const database = await openProviderFile("database", databasePath, true);
  if (database === undefined) throw new SqliteSourceSnapshotError("unreadable");

  try {
    const wal = await openProviderFile("wal", `${databasePath}-wal`, false);
    return wal === undefined ? [database] : [database, wal];
  } catch (error) {
    await database.handle.close().catch(() => undefined);
    throw error;
  }
}

async function openProviderFile(
  kind: OpenProviderFile["kind"],
  filePath: string,
  required: boolean,
): Promise<OpenProviderFile | undefined> {
  let pathStats: BigIntStats;
  try {
    pathStats = await lstat(filePath, { bigint: true });
  } catch (error) {
    if (!required && isFileSystemError(error, "ENOENT")) return undefined;
    throw new SqliteSourceSnapshotError("unreadable");
  }
  if (!pathStats.isFile()) throw new SqliteSourceSnapshotError("unreadable");

  let handle: FileHandle | undefined;
  try {
    handle = await open(filePath, readOnlyNoFollowFlags());
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isFile()) throw new SqliteSourceSnapshotError("unreadable");

    const pathIdentity = toIdentity(pathStats);
    const handleIdentity = toIdentity(handleStats);
    if (!sameIdentity(pathIdentity, handleIdentity)) throw new SnapshotChangedError();

    return { kind, path: filePath, handle, pathIdentity, handleIdentity };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof SnapshotChangedError || error instanceof SqliteSourceSnapshotError) {
      throw error;
    }
    if (!required && isFileSystemError(error, "ENOENT")) return undefined;
    throw new SqliteSourceSnapshotError("unreadable");
  }
}

function readOnlyNoFollowFlags(): number {
  return process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
}

async function copyProviderFiles(
  providerFiles: readonly OpenProviderFile[],
  privateDirectory: string,
  attempt: number,
  hooks: SqliteSourceSnapshotHooks | undefined,
): Promise<PrivateCopy> {
  const privateDatabasePath = path.join(privateDirectory, PRIVATE_DATABASE_NAME);
  const copiedDigests = new Map<OpenProviderFile["kind"], string>();

  try {
    await chmod(privateDirectory, 0o700);
  } catch (error) {
    if (error instanceof SnapshotChangedError) throw error;
    throw new SqliteSourceSnapshotError("staging-failed");
  }

  for (const file of providerFiles) {
    const destination =
      file.kind === "database" ? privateDatabasePath : `${privateDatabasePath}-wal`;
    let copiedDigest: string;
    try {
      copiedDigest = await copyHandle(file.handle, destination);
    } catch (error) {
      if (error instanceof SnapshotChangedError) throw error;
      throw new SqliteSourceSnapshotError("staging-failed");
    }
    copiedDigests.set(file.kind, copiedDigest);
    await hooks?.onBytePass?.({ attempt, phase: "copy", kind: file.kind });
  }

  return { databasePath: privateDatabasePath, copiedDigests };
}

async function verifyProviderFiles(
  originalFiles: readonly OpenProviderFile[],
  copiedDigests: ReadonlyMap<OpenProviderFile["kind"], string>,
  attempt: number,
  hooks: SqliteSourceSnapshotHooks | undefined,
): Promise<void> {
  let postFiles: readonly OpenProviderFile[];
  try {
    postFiles = await openProviderSet(originalFiles[0]?.path ?? "");
  } catch {
    throw new SnapshotChangedError();
  }

  try {
    if (postFiles.length !== originalFiles.length) throw new SnapshotChangedError();

    for (const [index, original] of originalFiles.entries()) {
      const post = postFiles[index];
      if (post === undefined || post.kind !== original.kind) throw new SnapshotChangedError();

      let originalHandleIdentity: FileIdentity;
      let originalPathIdentity: FileIdentity;
      try {
        originalHandleIdentity = toIdentity(await original.handle.stat({ bigint: true }));
        originalPathIdentity = toIdentity(await lstat(original.path, { bigint: true }));
      } catch {
        throw new SnapshotChangedError();
      }
      const observation = { attempt, phase: "verify" as const, kind: original.kind };
      await hooks?.beforePostHash?.(observation);
      let postDigest: string;
      try {
        postDigest = await hashHandle(post.handle);
      } catch {
        throw new SnapshotChangedError();
      }
      await hooks?.onBytePass?.(observation);
      const copiedDigest = copiedDigests.get(original.kind);

      if (
        !sameIdentity(original.handleIdentity, originalHandleIdentity) ||
        !sameIdentity(original.pathIdentity, originalPathIdentity) ||
        !sameIdentity(original.pathIdentity, post.pathIdentity) ||
        !sameIdentity(original.handleIdentity, post.handleIdentity) ||
        copiedDigest === undefined ||
        copiedDigest !== postDigest
      ) {
        throw new SnapshotChangedError();
      }
    }
  } finally {
    await closeAll(postFiles);
  }
}

async function hashHandle(handle: FileHandle): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;

  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }

  return digest.digest("hex");
}

async function copyHandle(source: FileHandle, destinationPath: string): Promise<string> {
  const destination = await open(destinationPath, "wx", 0o600);
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;

  try {
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      digest.update(chunk);
      await writeCompletely(destination, chunk, position);
      position += bytesRead;
    }
    await destination.chmod(0o600);
  } finally {
    await destination.close();
  }

  return digest.digest("hex");
}

async function writeCompletely(
  destination: FileHandle,
  bytes: Uint8Array,
  initialPosition: number,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await destination.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      initialPosition + offset,
    );
    if (bytesWritten === 0) throw new Error("Private snapshot copy made no progress");
    offset += bytesWritten;
  }
}

function materializePrivateCopy<T>(
  privateDatabasePath: string,
  materialize: (database: DatabaseSync) => T,
): T {
  let database: DatabaseSync;
  try {
    const url = pathToFileURL(privateDatabasePath);
    url.searchParams.set("mode", "ro");
    url.searchParams.set("cache", "private");
    database = new DatabaseSync(url.href, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readOnly: true,
      timeout: 1_000,
    });
  } catch {
    throw new SqliteSourceSnapshotError("malformed");
  }

  let operationError: unknown;
  let result: T | undefined;
  try {
    database.exec("PRAGMA query_only = ON; BEGIN DEFERRED;");
    result = materialize(database);
    database.exec("COMMIT;");
  } catch (error) {
    operationError = error;
    try {
      if (database.isTransaction) database.exec("ROLLBACK;");
    } catch (rollbackError) {
      operationError = new AggregateError(
        [error, rollbackError],
        "SQLite source materialization and rollback failed",
        { cause: error },
      );
    }
  }

  try {
    database.close();
  } catch (closeError) {
    operationError =
      operationError === undefined
        ? closeError
        : new AggregateError(
            [operationError, closeError],
            "SQLite source materialization and close failed",
            { cause: operationError },
          );
  }

  if (operationError !== undefined) throw operationError;
  return result as T;
}

function toIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    birthtimeNs: stats.birthtimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  );
}

async function closeAll(files: readonly OpenProviderFile[]): Promise<void> {
  const failures: unknown[] = [];
  for (const file of files) {
    try {
      await file.handle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Provider read handles failed to close");
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function snapshotFailureMessage(kind: SqliteSourceSnapshotFailureKind): string {
  switch (kind) {
    case "malformed":
      return "SQLite source data is malformed";
    case "source-changed":
      return "SQLite source changed while it was read";
    case "staging-failed":
      return "SQLite source staging failed";
    case "unreadable":
      return "SQLite source is unreadable";
  }
}
