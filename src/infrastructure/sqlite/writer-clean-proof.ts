import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

const PROOF_VERSION = 1;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PROOF_BYTES = 4_096;
const TEMPORARY_TOKEN_PATTERN = /^[a-f0-9]{32}$/u;
const LIBRARY_INSTANCE_PATTERN = /^[a-f0-9]{32}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

export interface WriterCleanProofClaim {
  readonly libraryInstanceId: string;
  readonly writerGeneration: number;
  readonly schemaVersion: number;
  readonly schemaCookie: number;
}

export interface WriterCleanProofDatabaseStat {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modifiedNanoseconds: string;
  readonly birthNanoseconds: string;
}

export interface WriterCleanProof extends WriterCleanProofClaim {
  readonly version: 1;
  readonly databaseStat: WriterCleanProofDatabaseStat;
}

export interface WriterCleanProofPaths {
  readonly proof: string;
  readonly temporaryPrefix: string;
}

export interface WriterCleanProofOptions {
  readonly platform?: NodeJS.Platform;
  /** Test seam for deterministic temporary names. */
  readonly token?: () => string;
}

export interface WriterCleanProofCleanupOptions {
  readonly platform?: NodeJS.Platform;
  readonly unlinkFile?: (file: string) => Promise<void>;
}

export type WriterCleanProofErrorCode =
  | "invalid-claim"
  | "unsafe-database"
  | "publication-failed"
  | "cleanup-failed";

export class WriterCleanProofError extends Error {
  readonly code: WriterCleanProofErrorCode;

  constructor(code: WriterCleanProofErrorCode, options?: ErrorOptions) {
    super(`SQLite writer clean proof failed: ${code}`, options);
    this.name = "WriterCleanProofError";
    this.code = code;
  }
}

export function writerCleanProofPaths(databasePath: string): WriterCleanProofPaths {
  if (!path.isAbsolute(databasePath)) {
    throw new TypeError("SQLite writer clean proof requires an absolute database path");
  }
  const proof = `${databasePath}.clean-proof`;
  return { proof, temporaryPrefix: `${proof}.tmp-` };
}

export function writerCleanProofMatchesClaim(
  proof: WriterCleanProof,
  claim: WriterCleanProofClaim,
): boolean {
  return (
    proof.libraryInstanceId === claim.libraryInstanceId &&
    proof.writerGeneration === claim.writerGeneration &&
    proof.schemaVersion === claim.schemaVersion &&
    proof.schemaCookie === claim.schemaCookie
  );
}

/**
 * Reads a private proof only when both the proof and database stayed unchanged.
 * Any uncertainty disables the optimization instead of failing the writer.
 */
export async function readWriterCleanProof(
  databasePath: string,
  options: Pick<WriterCleanProofOptions, "platform"> = {},
): Promise<WriterCleanProof | undefined> {
  const platform = options.platform ?? process.platform;
  const paths = writerCleanProofPaths(databasePath);
  return readProofBoundToDatabase(databasePath, paths.proof, platform);
}

/**
 * Atomically removes the current proof from its eligible path before returning
 * its claim. A later setup failure therefore cannot reuse the selected proof.
 */
export async function consumeWriterCleanProof(
  databasePath: string,
  options: Pick<WriterCleanProofOptions, "platform"> = {},
): Promise<WriterCleanProof | undefined> {
  const platform = options.platform ?? process.platform;
  const paths = writerCleanProofPaths(databasePath);
  const selected = await readProofBoundToDatabase(databasePath, paths.proof, platform);
  if (selected === undefined) return undefined;
  const consumed = `${paths.temporaryPrefix}${randomBytes(16).toString("hex")}`;

  try {
    await rename(paths.proof, consumed);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw new WriterCleanProofError("cleanup-failed", { cause: error });
  }

  const proof = await readProofBoundToDatabase(databasePath, consumed, platform);
  try {
    await removePrivateFile(consumed, platform, unlink);
  } catch (error) {
    throw new WriterCleanProofError("cleanup-failed", { cause: error });
  }
  return proof !== undefined && sameWriterCleanProof(selected, proof) ? proof : undefined;
}

/**
 * Captures the stat fields used by the proof after final database hardening.
 */
export async function snapshotWriterCleanProofDatabase(
  databasePath: string,
  options: Pick<WriterCleanProofOptions, "platform"> = {},
): Promise<WriterCleanProofDatabaseStat> {
  const platform = options.platform ?? process.platform;
  try {
    return (await snapshotPrivateDatabase(databasePath, platform)).publicStat;
  } catch (error) {
    if (error instanceof WriterCleanProofError) throw error;
    throw new WriterCleanProofError("unsafe-database", { cause: error });
  }
}

/**
 * Publishes the complete proof through one same-directory atomic rename.
 * Nothing fallible runs after the final rename succeeds.
 */
export async function publishWriterCleanProof(
  databasePath: string,
  claim: WriterCleanProofClaim,
  options: WriterCleanProofOptions = {},
): Promise<void> {
  assertClaim(claim);
  const platform = options.platform ?? process.platform;
  const paths = writerCleanProofPaths(databasePath);
  const token = options.token?.() ?? randomBytes(16).toString("hex");
  if (!TEMPORARY_TOKEN_PATTERN.test(token)) {
    throw new WriterCleanProofError("invalid-claim");
  }
  const temporary = `${paths.temporaryPrefix}${token}`;

  let handle: FileHandle | undefined;
  let temporaryCreated = false;
  let published = false;
  let operationError: unknown;
  try {
    const database = await snapshotPrivateDatabase(databasePath, platform);
    const proof: WriterCleanProof = {
      version: PROOF_VERSION,
      libraryInstanceId: claim.libraryInstanceId,
      writerGeneration: claim.writerGeneration,
      schemaVersion: claim.schemaVersion,
      schemaCookie: claim.schemaCookie,
      databaseStat: database.publicStat,
    };
    const serialized = `${JSON.stringify(proof)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_PROOF_BYTES) {
      throw new WriterCleanProofError("invalid-claim");
    }

    handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
    temporaryCreated = true;
    if (platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    const databaseAfterWrite = await snapshotPrivateDatabase(databasePath, platform);
    if (!sameFileSnapshot(database, databaseAfterWrite)) {
      throw new WriterCleanProofError("publication-failed");
    }
    await replaceProof(temporary, paths.proof, platform);
    published = true;
  } catch (error) {
    operationError = error;
  }

  if (published) return;

  const cleanupErrors: unknown[] = [];
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (temporaryCreated) {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) cleanupErrors.push(error);
    }
  }

  const primary = operationError ?? new WriterCleanProofError("publication-failed");
  const cause =
    cleanupErrors.length === 0
      ? primary
      : new AggregateError(
          [primary, ...cleanupErrors],
          "SQLite writer clean proof publication and cleanup failed",
          { cause: primary },
        );
  throw primary instanceof WriterCleanProofError
    ? new WriterCleanProofError(primary.code, { cause })
    : new WriterCleanProofError("publication-failed", { cause });
}

/** Removes only recognized abandoned temporary proof files. */
export async function removeWriterCleanProofTemporaryFiles(
  databasePath: string,
  options: WriterCleanProofCleanupOptions = {},
): Promise<number> {
  return removeWriterCleanProofFiles(databasePath, false, options);
}

/** Removes the fixed proof and recognized temporary residue during clear. */
export async function clearWriterCleanProofFiles(
  databasePath: string,
  options: WriterCleanProofCleanupOptions = {},
): Promise<number> {
  return removeWriterCleanProofFiles(databasePath, true, options);
}

interface PrivateFileSnapshot {
  readonly device: bigint;
  readonly inode: bigint;
  readonly mode: bigint;
  readonly links: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly birth: bigint;
  readonly uid: bigint;
}

interface PrivateDatabaseSnapshot extends PrivateFileSnapshot {
  readonly publicStat: WriterCleanProofDatabaseStat;
}

async function readProofBoundToDatabase(
  databasePath: string,
  proofPath: string,
  platform: NodeJS.Platform,
): Promise<WriterCleanProof | undefined> {
  try {
    const databaseBefore = await snapshotPrivateDatabase(databasePath, platform);
    const proof = await readPrivateProof(proofPath, platform);
    if (proof === undefined) return undefined;
    const databaseAfter = await snapshotPrivateDatabase(databasePath, platform);
    if (
      !sameFileSnapshot(databaseBefore, databaseAfter) ||
      !samePublicDatabaseStat(proof.databaseStat, databaseAfter.publicStat)
    ) {
      return undefined;
    }
    return proof;
  } catch {
    return undefined;
  }
}

function sameWriterCleanProof(left: WriterCleanProof, right: WriterCleanProof): boolean {
  return (
    left.version === right.version &&
    writerCleanProofMatchesClaim(left, right) &&
    samePublicDatabaseStat(left.databaseStat, right.databaseStat)
  );
}

async function snapshotPrivateDatabase(
  databasePath: string,
  platform: NodeJS.Platform,
): Promise<PrivateDatabaseSnapshot> {
  let stats: BigIntStats;
  try {
    stats = await lstat(databasePath, { bigint: true });
  } catch (error) {
    throw new WriterCleanProofError("unsafe-database", { cause: error });
  }
  if (!privateRegularFileIsSafe(stats, platform)) {
    throw new WriterCleanProofError("unsafe-database");
  }
  const snapshot = snapshotFromStats(stats);
  return {
    ...snapshot,
    publicStat: {
      device: decimal(snapshot.device),
      inode: decimal(snapshot.inode),
      size: decimal(snapshot.size),
      modifiedNanoseconds: decimal(snapshot.modified),
      birthNanoseconds: decimal(snapshot.birth),
    },
  };
}

async function readPrivateProof(
  proofPath: string,
  platform: NodeJS.Platform,
): Promise<WriterCleanProof | undefined> {
  let before: BigIntStats;
  try {
    before = await lstat(proofPath, { bigint: true });
  } catch {
    return undefined;
  }
  if (
    !privateRegularFileIsSafe(before, platform) ||
    before.size <= 0n ||
    before.size > BigInt(MAX_PROOF_BYTES)
  ) {
    return undefined;
  }

  let handle: FileHandle | undefined;
  let bytes: Buffer | undefined;
  let handleSnapshot: PrivateFileSnapshot | undefined;
  let closeFailed = false;
  try {
    const flags =
      platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    handle = await open(proofPath, flags);
    const opened = await handle.stat({ bigint: true });
    if (!privateRegularFileIsSafe(opened, platform)) return undefined;
    handleSnapshot = snapshotFromStats(opened);
    if (!sameFileSnapshot(snapshotFromStats(before), handleSnapshot)) return undefined;
    const pathAfterOpen = await lstat(proofPath, { bigint: true });
    if (
      !privateRegularFileIsSafe(pathAfterOpen, platform) ||
      !sameFileSnapshot(handleSnapshot, snapshotFromStats(pathAfterOpen))
    ) {
      return undefined;
    }
    bytes = await handle.readFile();
    const afterRead = snapshotFromStats(await handle.stat({ bigint: true }));
    if (!sameFileSnapshot(handleSnapshot, afterRead)) return undefined;
    const pathAfterRead = await lstat(proofPath, { bigint: true });
    if (
      !privateRegularFileIsSafe(pathAfterRead, platform) ||
      !sameFileSnapshot(handleSnapshot, snapshotFromStats(pathAfterRead))
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        closeFailed = true;
      }
    }
  }
  if (closeFailed || bytes === undefined || bytes.length === 0 || bytes.length > MAX_PROOF_BYTES) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return undefined;
  }
  return isWriterCleanProof(parsed) ? parsed : undefined;
}

async function replaceProof(
  temporary: string,
  proof: string,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await rename(temporary, proof);
    return;
  } catch (error) {
    if (platform !== "win32" || !isWindowsReplacementError(error)) throw error;
  }

  try {
    await unlink(proof);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  await rename(temporary, proof);
}

async function removeWriterCleanProofFiles(
  databasePath: string,
  includeProof: boolean,
  options: WriterCleanProofCleanupOptions,
): Promise<number> {
  const platform = options.platform ?? process.platform;
  const paths = writerCleanProofPaths(databasePath);
  const directory = path.dirname(paths.proof);
  const proofName = path.basename(paths.proof);
  const temporaryNamePrefix = path.basename(paths.temporaryPrefix);
  let names: string[];
  try {
    const directoryStats = await lstat(directory, { bigint: true });
    if (!privateDirectoryIsSafe(directoryStats, platform)) {
      throw new WriterCleanProofError("cleanup-failed");
    }
    names = (await readdir(directory))
      .filter(
        (name) =>
          (includeProof && name === proofName) ||
          (name.startsWith(temporaryNamePrefix) &&
            TEMPORARY_TOKEN_PATTERN.test(name.slice(temporaryNamePrefix.length))),
      )
      .sort();
  } catch (error) {
    if (isErrno(error, "ENOENT")) return 0;
    throw new WriterCleanProofError("cleanup-failed", { cause: error });
  }

  const removeFile = options.unlinkFile ?? unlink;
  let removed = 0;
  try {
    for (const name of names) {
      if (await removePrivateFile(path.join(directory, name), platform, removeFile)) removed += 1;
    }
  } catch (error) {
    throw new WriterCleanProofError("cleanup-failed", { cause: error });
  }
  return removed;
}

async function removePrivateFile(
  file: string,
  platform: NodeJS.Platform,
  removeFile: (file: string) => Promise<void>,
): Promise<boolean> {
  let expected: PrivateFileSnapshot;
  try {
    const stats = await lstat(file, { bigint: true });
    if (!privateRegularFileIsSafe(stats, platform)) {
      throw new WriterCleanProofError("cleanup-failed");
    }
    expected = snapshotFromStats(stats);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }

  let actual: PrivateFileSnapshot;
  try {
    actual = snapshotFromStats(await lstat(file, { bigint: true }));
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  if (!sameFileSnapshot(expected, actual)) {
    throw new WriterCleanProofError("cleanup-failed");
  }

  try {
    await removeFile(file);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function privateRegularFileIsSafe(stats: BigIntStats, platform: NodeJS.Platform): boolean {
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1n) return false;
  if (platform === "win32") return true;
  const uid = process.getuid?.();
  return (
    (uid === undefined || stats.uid === BigInt(uid)) &&
    (stats.mode & 0o777n) === BigInt(PRIVATE_FILE_MODE)
  );
}

function privateDirectoryIsSafe(stats: BigIntStats, platform: NodeJS.Platform): boolean {
  if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
  if (platform === "win32") return true;
  const uid = process.getuid?.();
  return (uid === undefined || stats.uid === BigInt(uid)) && (stats.mode & 0o777n) === 0o700n;
}

function snapshotFromStats(stats: BigIntStats): PrivateFileSnapshot {
  return {
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode,
    links: stats.nlink,
    size: stats.size,
    modified: stats.mtimeNs,
    changed: stats.ctimeNs,
    birth: stats.birthtimeNs,
    uid: stats.uid,
  };
}

function sameFileSnapshot(left: PrivateFileSnapshot, right: PrivateFileSnapshot): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.links === right.links &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.birth === right.birth &&
    left.uid === right.uid
  );
}

function samePublicDatabaseStat(
  left: WriterCleanProofDatabaseStat,
  right: WriterCleanProofDatabaseStat,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.birthNanoseconds === right.birthNanoseconds
  );
}

function isWriterCleanProof(value: unknown): value is WriterCleanProof {
  if (
    !hasExactKeys(value, [
      "version",
      "libraryInstanceId",
      "writerGeneration",
      "schemaVersion",
      "schemaCookie",
      "databaseStat",
    ])
  ) {
    return false;
  }
  return (
    value.version === PROOF_VERSION &&
    typeof value.libraryInstanceId === "string" &&
    LIBRARY_INSTANCE_PATTERN.test(value.libraryInstanceId) &&
    isPositiveSafeInteger(value.writerGeneration) &&
    isPositiveSafeInteger(value.schemaVersion) &&
    isNonNegativeSafeInteger(value.schemaCookie) &&
    isDatabaseStat(value.databaseStat)
  );
}

function isDatabaseStat(value: unknown): value is WriterCleanProofDatabaseStat {
  if (
    !hasExactKeys(value, ["device", "inode", "size", "modifiedNanoseconds", "birthNanoseconds"])
  ) {
    return false;
  }
  return (
    isDecimal(value.device) &&
    isDecimal(value.inode) &&
    isDecimal(value.size) &&
    isDecimal(value.modifiedNanoseconds) &&
    isDecimal(value.birthNanoseconds)
  );
}

function assertClaim(claim: WriterCleanProofClaim): void {
  if (
    typeof claim.libraryInstanceId !== "string" ||
    !LIBRARY_INSTANCE_PATTERN.test(claim.libraryInstanceId) ||
    !isPositiveSafeInteger(claim.writerGeneration) ||
    !isPositiveSafeInteger(claim.schemaVersion) ||
    !isNonNegativeSafeInteger(claim.schemaCookie)
  ) {
    throw new WriterCleanProofError("invalid-claim");
  }
}

function hasExactKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

function decimal(value: bigint): string {
  if (value < 0n) throw new WriterCleanProofError("unsafe-database");
  return value.toString(10);
}

function isWindowsReplacementError(error: unknown): boolean {
  return isErrno(error, "EEXIST") || isErrno(error, "ENOTEMPTY") || isErrno(error, "EPERM");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
