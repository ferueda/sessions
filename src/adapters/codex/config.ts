import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { parse } from "smol-toml";

const MAX_CONFIG_BYTES = 1024 * 1024;

export type CodexConfigFailure = "malformed" | "unreadable";

export class CodexConfigError extends Error {
  readonly failure: CodexConfigFailure;

  constructor(failure: CodexConfigFailure, options?: { readonly cause?: unknown }) {
    super("Codex configuration could not be read", options);
    this.name = "CodexConfigError";
    this.failure = failure;
  }
}

export async function readConfiguredSqliteHome(file: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let configuredHome: string | undefined;
  let operationError: unknown;
  try {
    handle = await open(file, constants.O_RDONLY);
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.size > BigInt(MAX_CONFIG_BYTES)) {
      throw new CodexConfigError("malformed");
    }
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } catch (error) {
      throw new CodexConfigError("unreadable", { cause: error });
    }
    if (bytes.byteLength > MAX_CONFIG_BYTES) throw new CodexConfigError("malformed");
    configuredHome = parseConfiguredSqliteHome(bytes);
  } catch (error) {
    if (error instanceof CodexConfigError) {
      operationError = error;
    } else if (isMissing(error)) {
      operationError = undefined;
    } else {
      operationError = new CodexConfigError("unreadable", { cause: error });
    }
  }

  let closeError: unknown;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      closeError = new CodexConfigError("unreadable", { cause: error });
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Codex configuration read and close both failed",
      { cause: operationError },
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  return configuredHome;
}

function parseConfiguredSqliteHome(bytes: Uint8Array): string | undefined {
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = parse(text);
  } catch (error) {
    throw new CodexConfigError("malformed", { cause: error });
  }
  if (!isPlainObject(parsed)) throw new CodexConfigError("malformed");
  if (!Object.hasOwn(parsed, "sqlite_home")) return undefined;

  const value = parsed.sqlite_home;
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    throw new CodexConfigError("malformed");
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
