import { SessionLibraryError } from "./library-error.ts";
import type { IndexLifecycle, IndexPaths, IndexReader } from "./ports/index-lifecycle.ts";
import { selectSessionSummary, type SelectedSessionSummary } from "./session-presentation.ts";
import { admitSessionQueryCursor, SessionQueryOperationalError } from "./session-query-error.ts";
import { selectSessionRoot } from "./session-root-presentation.ts";
import {
  createSessionListQuery,
  MAX_SESSION_QUERY_LIMIT,
  type SessionFilterInput,
  type SessionListItem,
  type SessionQueryCursor,
} from "../domain/session-query.ts";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = MAX_SESSION_QUERY_LIMIT;

export interface SelectedSessionListItem extends SelectedSessionSummary {
  readonly root: SessionListItem["root"];
}

export interface ListSessionsResult {
  readonly sessions: readonly SelectedSessionListItem[];
  readonly nextCursor?: SessionQueryCursor;
}

export async function listSessions(input: {
  readonly paths: IndexPaths;
  readonly lifecycle: IndexLifecycle;
  readonly filter?: SessionFilterInput;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<ListSessionsResult> {
  const cursor = admitSessionQueryCursor(input.cursor);
  const query = createSessionListQuery({
    limit: input.limit ?? DEFAULT_LIST_LIMIT,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const state = await input.lifecycle.inspect(input.paths);
  if (state.status === "uninitialized") {
    if (query.cursor !== undefined) throw new SessionQueryOperationalError("stale-cursor");
    return Object.freeze({ sessions: Object.freeze([]) });
  }
  if (state.status !== "ready") throw new SessionLibraryError("library-unavailable");

  return withReader(input.lifecycle, input.paths, async (reader) => {
    const page = await reader.query.list(query);
    return Object.freeze({
      sessions: Object.freeze(page.sessions.map(selectListItem)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });
}

function selectListItem(item: SessionListItem): SelectedSessionListItem {
  return Object.freeze({
    ...selectSessionSummary(item),
    root: selectSessionRoot(item.root),
  });
}

export async function withReader<T>(
  lifecycle: IndexLifecycle,
  paths: IndexPaths,
  operation: (reader: IndexReader) => Promise<T>,
): Promise<T> {
  let reader: IndexReader | undefined;
  let result: T | undefined;
  const operationFailure: CapturedFailure = { caught: false, error: undefined };
  try {
    reader = await lifecycle.openReader(paths);
    result = await operation(reader);
  } catch (error) {
    operationFailure.caught = true;
    operationFailure.error = error;
  }

  const closeFailure: CapturedFailure = { caught: false, error: undefined };
  if (reader !== undefined) {
    try {
      await reader.close();
    } catch (error) {
      closeFailure.caught = true;
      closeFailure.error = error;
    }
  }
  if (operationFailure.caught && closeFailure.caught) {
    throw new AggregateError(
      [operationFailure.error, closeFailure.error],
      "Session library read and close both failed",
      { cause: operationFailure.error },
    );
  }
  if (operationFailure.caught) throw operationFailure.error;
  if (closeFailure.caught) throw closeFailure.error;
  return result as T;
}

interface CapturedFailure {
  caught: boolean;
  error: unknown;
}
