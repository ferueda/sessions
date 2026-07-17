import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";
import {
  SourceCaptureWorkspaceError,
  type SourceCaptureWorkspace,
} from "../../application/ports/session-source.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;

export type SourceCaptureWorkspaceLifecycleErrorCode =
  | "invalid-scratch-path"
  | "unsafe-scratch-root"
  | "workspace-busy"
  | "workspace-closed";

export class SourceCaptureWorkspaceLifecycleError extends SourceCaptureWorkspaceError {
  readonly code: SourceCaptureWorkspaceLifecycleErrorCode;

  constructor(
    code: SourceCaptureWorkspaceLifecycleErrorCode,
    options?: { readonly cause?: unknown },
  ) {
    super(options?.cause);
    this.message = workspaceErrorMessage(code);
    this.name = "SourceCaptureWorkspaceLifecycleError";
    this.code = code;
  }
}

export interface SourceCaptureWorkspaceLifecycle {
  readonly workspace: SourceCaptureWorkspace;
  close(): Promise<void>;
}

export interface OpenSourceCaptureWorkspaceOptions {
  readonly assertLease: () => void | Promise<void>;
  readonly platform?: NodeJS.Platform;
}

/** Prepare the one Sessions-owned scratch root while the caller holds its writer lease. */
export async function openSourceCaptureWorkspace(
  paths: Pick<IndexPaths, "directory" | "scratch">,
  options: OpenSourceCaptureWorkspaceOptions,
): Promise<SourceCaptureWorkspaceLifecycle> {
  assertCanonicalScratchPath(paths);
  const platform = options.platform ?? process.platform;
  await assertCaptureLease(options.assertLease);
  await removeSafeScratchRoot(paths.scratch, platform);
  await assertCaptureLease(options.assertLease);
  await createPrivateDirectory(paths.scratch, platform);
  await assertCaptureLease(options.assertLease);

  let closed = false;
  let activeOperations = 0;

  const workspace: SourceCaptureWorkspace = {
    async withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
      if (closed) throw new SourceCaptureWorkspaceLifecycleError("workspace-closed");
      activeOperations += 1;
      try {
        await assertCaptureLease(options.assertLease);
        await assertSafeScratchRoot(paths.scratch, platform);

        let directory: string;
        try {
          directory = await mkdtemp(path.join(paths.scratch, "attempt-"));
          await securePrivateDirectory(directory, platform);
        } catch (error) {
          throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root", { cause: error });
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
            errors.push(
              error instanceof SourceCaptureWorkspaceError
                ? error
                : new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root", {
                    cause: error,
                  }),
            );
          }
          try {
            await assertCaptureLease(options.assertLease);
          } catch (error) {
            errors.push(error);
          }
        }

        throwCaptureErrors(errors, "Source capture operation cleanup failed");
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
      if (activeOperations !== 0) {
        throw new SourceCaptureWorkspaceLifecycleError("workspace-busy");
      }

      await assertCaptureLease(options.assertLease);
      const errors: unknown[] = [];
      try {
        await removeSafeScratchRoot(paths.scratch, platform);
      } catch (error) {
        errors.push(error);
      }
      try {
        await assertCaptureLease(options.assertLease);
      } catch (error) {
        errors.push(error);
      }

      throwCaptureErrors(errors, "Source capture workspace cleanup failed");
      closed = true;
    },
  };
}

export function assertCanonicalScratchPath(paths: Pick<IndexPaths, "directory" | "scratch">): void {
  if (!path.isAbsolute(paths.directory) || !path.isAbsolute(paths.scratch)) {
    throw new SourceCaptureWorkspaceLifecycleError("invalid-scratch-path");
  }
  if (path.resolve(paths.scratch) !== path.join(path.resolve(paths.directory), ".scratch")) {
    throw new SourceCaptureWorkspaceLifecycleError("invalid-scratch-path");
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
    if (error instanceof SourceCaptureWorkspaceError) throw error;
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root", { cause: error });
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
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root", { cause: error });
  }
}

async function securePrivateDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root");
  }
  if (platform === "win32") return;

  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root");
  }
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function assertSafeScratchRoot(root: string, platform: NodeJS.Platform): Promise<void> {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root", { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root");
  }
  if (platform === "win32") return;

  const uid = process.getuid?.();
  if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root");
  }
}

async function removeSafeScratchRoot(root: string, platform: NodeJS.Platform): Promise<void> {
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return;
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root", { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root");
  }
  if (platform !== "win32") {
    const uid = process.getuid?.();
    if (
      (uid !== undefined && stats.uid !== uid) ||
      (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
    ) {
      throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root");
    }
  }

  try {
    // fs.rm unlinks symlink children; it does not traverse their targets.
    await rm(root, { force: false, recursive: true });
  } catch (error) {
    throw new SourceCaptureWorkspaceLifecycleError("unsafe-scratch-root", { cause: error });
  }
}

async function assertCaptureLease(assertLease: () => void | Promise<void>): Promise<void> {
  try {
    await assertLease();
  } catch (error) {
    if (error instanceof SourceCaptureWorkspaceError) throw error;
    throw new SourceCaptureWorkspaceError(error);
  }
}

function throwCaptureErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new SourceCaptureWorkspaceError(new AggregateError(errors, message, { cause: errors[0] }));
}

function workspaceErrorMessage(code: SourceCaptureWorkspaceLifecycleErrorCode): string {
  switch (code) {
    case "invalid-scratch-path":
      return "Source capture scratch path is invalid";
    case "unsafe-scratch-root":
      return "Source capture scratch root is unsafe";
    case "workspace-busy":
      return "Source capture workspace is still in use";
    case "workspace-closed":
      return "Source capture workspace is closed";
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
