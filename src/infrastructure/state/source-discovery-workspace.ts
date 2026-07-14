import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import type { SourceDiscoveryWorkspace } from "../../application/ports/session-source.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;

export type SourceDiscoveryWorkspaceErrorCode =
  | "invalid-scratch-path"
  | "unsafe-scratch-root"
  | "workspace-busy"
  | "workspace-closed";

export class SourceDiscoveryWorkspaceError extends Error {
  readonly code: SourceDiscoveryWorkspaceErrorCode;

  constructor(code: SourceDiscoveryWorkspaceErrorCode, options?: { readonly cause?: unknown }) {
    super(
      workspaceErrorMessage(code),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SourceDiscoveryWorkspaceError";
    this.code = code;
  }
}

export interface SourceDiscoveryWorkspaceLifecycle {
  readonly workspace: SourceDiscoveryWorkspace;
  close(): Promise<void>;
}

export interface OpenSourceDiscoveryWorkspaceOptions {
  readonly assertLease: () => void | Promise<void>;
  readonly platform?: NodeJS.Platform;
}

/** Prepare the one Sessions-owned scratch root while the caller holds its writer lease. */
export async function openSourceDiscoveryWorkspace(
  paths: Pick<IndexPaths, "directory" | "scratch">,
  options: OpenSourceDiscoveryWorkspaceOptions,
): Promise<SourceDiscoveryWorkspaceLifecycle> {
  assertCanonicalScratchPath(paths);
  const platform = options.platform ?? process.platform;
  await options.assertLease();
  await removeSafeScratchRoot(paths.scratch, platform);
  await options.assertLease();
  await createPrivateDirectory(paths.scratch, platform);
  await options.assertLease();

  let closed = false;
  let activeOperations = 0;

  const workspace: SourceDiscoveryWorkspace = {
    async withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
      if (closed) throw new SourceDiscoveryWorkspaceError("workspace-closed");
      activeOperations += 1;
      try {
        await options.assertLease();
        await assertSafeScratchRoot(paths.scratch, platform);

        let directory: string;
        try {
          directory = await mkdtemp(path.join(paths.scratch, "attempt-"));
          await securePrivateDirectory(directory, platform);
        } catch (error) {
          throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root", { cause: error });
        }

        let result: T | undefined;
        const errors: unknown[] = [];
        try {
          result = await operation(directory);
        } catch (error) {
          errors.push(error);
        } finally {
          try {
            await removePrivateAttempt(paths.scratch, directory, platform);
          } catch (error) {
            errors.push(new SourceDiscoveryWorkspaceError("unsafe-scratch-root", { cause: error }));
          }
          try {
            await options.assertLease();
          } catch (error) {
            errors.push(error);
          }
        }

        throwCollectedErrors(errors, "Source discovery operation cleanup failed");
        return result as T;
      } finally {
        activeOperations -= 1;
      }
    },
  };

  return {
    workspace,
    async close() {
      if (closed) return;
      if (activeOperations !== 0) throw new SourceDiscoveryWorkspaceError("workspace-busy");

      await options.assertLease();
      const errors: unknown[] = [];
      try {
        await removeSafeScratchRoot(paths.scratch, platform);
      } catch (error) {
        errors.push(error);
      }
      try {
        await options.assertLease();
      } catch (error) {
        errors.push(error);
      }

      throwCollectedErrors(errors, "Source discovery workspace cleanup failed");
      closed = true;
    },
  };
}

export function assertCanonicalScratchPath(paths: Pick<IndexPaths, "directory" | "scratch">): void {
  if (!path.isAbsolute(paths.directory) || !path.isAbsolute(paths.scratch)) {
    throw new SourceDiscoveryWorkspaceError("invalid-scratch-path");
  }
  if (path.resolve(paths.scratch) !== path.join(path.resolve(paths.directory), ".scratch")) {
    throw new SourceDiscoveryWorkspaceError("invalid-scratch-path");
  }
}

async function createPrivateDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  let created = false;
  try {
    await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
    created = true;
    await securePrivateDirectory(directory, platform);
  } catch (error) {
    if (created) await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    if (error instanceof SourceDiscoveryWorkspaceError) throw error;
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root", { cause: error });
  }
}

async function removePrivateAttempt(
  root: string,
  directory: string,
  platform: NodeJS.Platform,
): Promise<void> {
  await assertSafeScratchRoot(root, platform);
  try {
    await rm(directory, { force: true, recursive: true });
  } catch (error) {
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root", { cause: error });
  }
}

async function securePrivateDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root");
  }
  if (platform === "win32") return;

  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root");
  }
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function assertSafeScratchRoot(root: string, platform: NodeJS.Platform): Promise<void> {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root", { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root");
  }
  if (platform === "win32") return;

  const uid = process.getuid?.();
  if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root");
  }
}

async function removeSafeScratchRoot(root: string, platform: NodeJS.Platform): Promise<void> {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root", { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root");
  }
  if (platform !== "win32") {
    const uid = process.getuid?.();
    if (
      (uid !== undefined && stats.uid !== uid) ||
      (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root");
    }
  }

  try {
    // fs.rm unlinks symlink children; it does not traverse their targets.
    await rm(root, { force: false, recursive: true });
  } catch (error) {
    throw new SourceDiscoveryWorkspaceError("unsafe-scratch-root", { cause: error });
  }
}

function throwCollectedErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message, { cause: errors[0] });
}

function workspaceErrorMessage(code: SourceDiscoveryWorkspaceErrorCode): string {
  switch (code) {
    case "invalid-scratch-path":
      return "Source discovery scratch path is invalid";
    case "unsafe-scratch-root":
      return "Source discovery scratch root is unsafe";
    case "workspace-busy":
      return "Source discovery workspace is still in use";
    case "workspace-closed":
      return "Source discovery workspace is closed";
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
