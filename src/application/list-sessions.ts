import { SessionLibraryError } from "./library-error.ts";
import type { IndexLifecycle, IndexPaths, IndexReader } from "./ports/index-lifecycle.ts";
import type { IndexedSessionSummary } from "./ports/session-index.ts";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

export interface ListSessionsResult {
  readonly sessions: readonly IndexedSessionSummary[];
  readonly truncated: boolean;
}

export async function listSessions(input: {
  readonly paths: IndexPaths;
  readonly lifecycle: IndexLifecycle;
  readonly limit?: number;
}): Promise<ListSessionsResult> {
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new TypeError(`List limit must be an integer from 1 through ${MAX_LIST_LIMIT}`);
  }
  const state = await input.lifecycle.inspect(input.paths);
  if (state.status === "uninitialized") {
    return Object.freeze({ sessions: Object.freeze([]), truncated: false });
  }
  if (state.status !== "ready") throw new SessionLibraryError("library-unavailable");

  return withReader(input.lifecycle, input.paths, async (reader) => {
    const rows = await reader.sessions.listSummaries({ limit: limit + 1 });
    return Object.freeze({
      sessions: Object.freeze(rows.slice(0, limit)),
      truncated: rows.length > limit,
    });
  });
}

export async function withReader<T>(
  lifecycle: IndexLifecycle,
  paths: IndexPaths,
  operation: (reader: IndexReader) => Promise<T>,
): Promise<T> {
  let reader: IndexReader | undefined;
  let result: T | undefined;
  let operationError: unknown;
  try {
    reader = await lifecycle.openReader(paths);
    result = await operation(reader);
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (reader !== undefined) {
    try {
      await reader.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Session library read and close both failed",
      { cause: operationError },
    );
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  return result as T;
}
