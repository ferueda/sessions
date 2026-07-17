import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface CursorEnvironment {
  readonly home: string;
  /** Test-only injection seam. This is not a public environment variable. */
  readonly cursorHome?: string;
}

export interface ResolvedCursorPaths {
  readonly cursorHome: string;
}

export async function resolveCursorPaths(
  environment: CursorEnvironment = captureCursorEnvironment(),
): Promise<ResolvedCursorPaths> {
  assertPath(environment.home, "home");
  if (environment.cursorHome !== undefined) {
    assertPath(environment.cursorHome, "cursorHome");
  }

  const cursorHome = await canonicalRoot(
    environment.cursorHome === undefined
      ? join(resolve(environment.home), ".cursor")
      : resolve(environment.cursorHome),
  );

  return Object.freeze({ cursorHome });
}

export function captureCursorEnvironment(): CursorEnvironment {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined || home.length === 0) {
    throw new TypeError("A user home is required to resolve Cursor paths");
  }
  return { home };
}

async function canonicalRoot(path: string): Promise<string> {
  try {
    await lstat(path);
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return resolve(path);
  }
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function assertPath(value: string, field: string): void {
  if (value.length === 0 || !value.isWellFormed()) {
    throw new TypeError(`Cursor ${field} must be a non-empty well-formed path`);
  }
}
