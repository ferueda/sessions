import path from "node:path";

import type { IndexPaths } from "../../application/ports/index-lifecycle.ts";

export type StatePathErrorCode =
  | "invalid-data-override"
  | "invalid-home-directory"
  | "invalid-local-app-data"
  | "missing-local-app-data"
  | "unsupported-platform";

export class StatePathError extends Error {
  readonly code: StatePathErrorCode;

  constructor(code: StatePathErrorCode, message: string) {
    super(message);
    this.name = "StatePathError";
    this.code = code;
  }
}

export interface ResolveIndexPathsOptions {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}

export function resolveIndexPaths(options: ResolveIndexPathsOptions): IndexPaths {
  const pathImplementation = implementationFor(options.platform);
  const override = options.env.SESSIONS_DATA_DIR;
  const directory =
    override === undefined
      ? resolveDefaultDirectory(options, pathImplementation)
      : resolveOverride(override, options.platform, pathImplementation);
  const database = pathImplementation.join(directory, "sessions.sqlite3");

  return {
    directory,
    scratch: pathImplementation.join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}

function implementationFor(platform: NodeJS.Platform): typeof path.posix {
  switch (platform) {
    case "darwin":
    case "linux":
      return path.posix;
    case "win32":
      return path.win32;
    default:
      throw new StatePathError(
        "unsupported-platform",
        `Sessions does not support state paths on platform ${platform}`,
      );
  }
}

function resolveOverride(
  override: string,
  platform: NodeJS.Platform,
  pathImplementation: typeof path.posix,
): string {
  if (!isFullyQualified(override, platform, pathImplementation)) {
    throw new StatePathError("invalid-data-override", "SESSIONS_DATA_DIR must be an absolute path");
  }

  return pathImplementation.normalize(override);
}

function resolveDefaultDirectory(
  options: ResolveIndexPathsOptions,
  pathImplementation: typeof path.posix,
): string {
  switch (options.platform) {
    case "darwin":
      return pathImplementation.join(
        requireAbsoluteHome(options.homeDirectory),
        "Library",
        "Application Support",
        "sessions",
      );
    case "linux": {
      const xdgData = options.env.XDG_DATA_HOME;
      const dataRoot =
        xdgData !== undefined && pathImplementation.isAbsolute(xdgData)
          ? xdgData
          : pathImplementation.join(requireAbsoluteHome(options.homeDirectory), ".local", "share");
      return pathImplementation.join(dataRoot, "sessions");
    }
    case "win32": {
      const localAppData = options.env.LOCALAPPDATA;
      if (localAppData === undefined || localAppData.length === 0) {
        throw new StatePathError(
          "missing-local-app-data",
          "LOCALAPPDATA is required to resolve Sessions state paths on Windows",
        );
      }
      if (!isFullyQualified(localAppData, options.platform, pathImplementation)) {
        throw new StatePathError("invalid-local-app-data", "LOCALAPPDATA must be an absolute path");
      }
      return pathImplementation.join(localAppData, "sessions");
    }
    default:
      throw new StatePathError(
        "unsupported-platform",
        `Sessions does not support state paths on platform ${options.platform}`,
      );
  }
}

function isFullyQualified(
  candidate: string,
  platform: NodeJS.Platform,
  pathImplementation: typeof path.posix,
): boolean {
  if (platform !== "win32") return pathImplementation.isAbsolute(candidate);

  const root = path.win32.parse(path.win32.normalize(candidate)).root;
  return /^[A-Za-z]:\\$/u.test(root) || root.startsWith("\\\\");
}

function requireAbsoluteHome(homeDirectory: string): string {
  if (!path.posix.isAbsolute(homeDirectory)) {
    throw new StatePathError(
      "invalid-home-directory",
      "The home directory must be an absolute path",
    );
  }

  return homeDirectory;
}
