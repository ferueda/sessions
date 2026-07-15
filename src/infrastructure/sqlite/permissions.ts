import { access, chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import type { UnsafeIndexReason, UnsafeIndexTarget } from "../../domain/index-state.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface IndexPathPresence {
  readonly directory: boolean;
  readonly database: boolean;
  readonly wal: boolean;
  readonly shm: boolean;
}

export interface IndexPathSecurityIssue {
  readonly target: UnsafeIndexTarget;
  readonly reason: UnsafeIndexReason;
  readonly initialized: boolean;
}

export type IndexPathSafety =
  | { readonly safe: true; readonly presence: IndexPathPresence }
  | {
      readonly safe: false;
      readonly presence: IndexPathPresence;
      readonly issue: IndexPathSecurityIssue;
    };

export interface IndexPermissionOptions {
  readonly platform?: NodeJS.Platform;
}

export interface PreparedIndexPaths {
  readonly databaseCreated: boolean;
}

export class IndexPathSecurityError extends Error {
  readonly issue: IndexPathSecurityIssue;

  constructor(issue: IndexPathSecurityIssue) {
    super(`Unsafe SQLite index ${issue.target}: ${issue.reason}`);
    this.name = "IndexPathSecurityError";
    this.issue = issue;
  }
}

export function assertCanonicalIndexPaths(paths: IndexPaths): void {
  if (
    !path.isAbsolute(paths.directory) ||
    !path.isAbsolute(paths.scratch) ||
    !path.isAbsolute(paths.database) ||
    !path.isAbsolute(paths.wal) ||
    !path.isAbsolute(paths.shm)
  ) {
    throw new TypeError("SQLite index paths must be absolute");
  }
  const directory = path.resolve(paths.directory);
  const database = path.join(directory, "sessions.sqlite3");

  if (
    path.resolve(paths.scratch) !== path.join(directory, ".scratch") ||
    path.resolve(paths.database) !== database ||
    path.resolve(paths.wal) !== `${database}-wal` ||
    path.resolve(paths.shm) !== `${database}-shm`
  ) {
    throw new TypeError("SQLite index paths must remain inside the owned state directory");
  }
}

export async function inspectIndexPathSafety(
  paths: IndexPaths,
  options: IndexPermissionOptions = {},
): Promise<IndexPathSafety> {
  assertCanonicalIndexPaths(paths);
  const platform = options.platform ?? process.platform;
  const [directory, database, wal, shm] = await Promise.all([
    inspectPath(paths.directory, "directory", true, platform),
    inspectPath(paths.database, "database", false, platform),
    inspectPath(paths.wal, "wal", false, platform),
    inspectPath(paths.shm, "shm", false, platform),
  ]);
  const presence: IndexPathPresence = {
    directory: directory.exists,
    database: database.exists,
    wal: wal.exists,
    shm: shm.exists,
  };
  const initialized = presence.database;

  for (const result of [directory, database, wal, shm]) {
    if (result.issue !== undefined) {
      return {
        safe: false,
        presence,
        issue: { ...result.issue, initialized },
      };
    }
  }

  return { safe: true, presence };
}

export async function prepareIndexPathsForWriter(
  paths: IndexPaths,
  options: IndexPermissionOptions = {},
): Promise<PreparedIndexPaths> {
  assertCanonicalIndexPaths(paths);
  const platform = options.platform ?? process.platform;

  try {
    await mkdir(paths.directory, { mode: DIRECTORY_MODE, recursive: true });
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw new IndexPathSecurityError({
        target: "directory",
        reason: "unreadable",
        initialized: false,
      });
    }
  }
  await secureExistingPath(paths.directory, "directory", true, platform);

  let handle: FileHandle | undefined;
  let databaseCreated = false;
  try {
    handle = await open(paths.database, "wx", FILE_MODE);
    databaseCreated = true;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw new IndexPathSecurityError({
        target: "database",
        reason: "unreadable",
        initialized: false,
      });
    }
  } finally {
    await handle?.close();
  }

  await secureExistingPath(paths.database, "database", false, platform);
  await secureOptionalPath(paths.wal, "wal", platform);
  await secureOptionalPath(paths.shm, "shm", platform);
  return { databaseCreated };
}

export async function secureIndexFiles(
  paths: IndexPaths,
  options: IndexPermissionOptions = {},
): Promise<void> {
  assertCanonicalIndexPaths(paths);
  const platform = options.platform ?? process.platform;
  await secureExistingPath(paths.directory, "directory", true, platform);
  await secureExistingPath(paths.database, "database", false, platform);
  await secureOptionalPath(paths.wal, "wal", platform);
  await secureOptionalPath(paths.shm, "shm", platform);
}

interface InspectedPath {
  readonly exists: boolean;
  readonly issue?: Omit<IndexPathSecurityIssue, "initialized">;
}

async function inspectPath(
  file: string,
  target: UnsafeIndexTarget,
  directory: boolean,
  platform: NodeJS.Platform,
): Promise<InspectedPath> {
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { exists: false };
    return { exists: false, issue: { target, reason: "unreadable" } };
  }

  const typeMatches = directory ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink()) {
    return { exists: true, issue: { target, reason: "symlink" } };
  }
  if (!typeMatches) {
    return { exists: true, issue: { target, reason: "unexpected-type" } };
  }
  if (!directory && stats.nlink !== 1) {
    return { exists: true, issue: { target, reason: "unexpected-type" } };
  }
  if (platform !== "win32") {
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      return { exists: true, issue: { target, reason: "ownership" } };
    }
    const expectedMode = directory ? DIRECTORY_MODE : FILE_MODE;
    if ((stats.mode & 0o777) !== expectedMode) {
      return { exists: true, issue: { target, reason: "permissions" } };
    }
  }

  try {
    await access(file, directory ? constants.R_OK | constants.X_OK : constants.R_OK);
  } catch {
    return { exists: true, issue: { target, reason: "unreadable" } };
  }
  return { exists: true };
}

async function secureOptionalPath(
  file: string,
  target: "wal" | "shm",
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await secureExistingPath(file, target, false, platform);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw error;
  }
}

async function secureExistingPath(
  file: string,
  target: UnsafeIndexTarget,
  directory: boolean,
  platform: NodeJS.Platform,
): Promise<void> {
  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw error;
    throw new IndexPathSecurityError({
      target,
      reason: "unreadable",
      initialized: target !== "directory",
    });
  }

  if (stats.isSymbolicLink()) {
    throw new IndexPathSecurityError({
      target,
      reason: "symlink",
      initialized: target !== "directory",
    });
  }
  const typeMatches = directory ? stats.isDirectory() : stats.isFile();
  if (!typeMatches) {
    throw new IndexPathSecurityError({
      target,
      reason: "unexpected-type",
      initialized: target !== "directory",
    });
  }
  if (!directory && stats.nlink !== 1) {
    throw new IndexPathSecurityError({
      target,
      reason: "unexpected-type",
      initialized: true,
    });
  }

  if (platform === "win32") return;
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new IndexPathSecurityError({
      target,
      reason: "ownership",
      initialized: target !== "directory",
    });
  }

  try {
    await chmod(file, directory ? DIRECTORY_MODE : FILE_MODE);
  } catch {
    throw new IndexPathSecurityError({
      target,
      reason: "permissions",
      initialized: target !== "directory",
    });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
