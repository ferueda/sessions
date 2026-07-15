import { SessionLibraryError } from "./library-error.ts";
import { withReader } from "./list-sessions.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import { admitSessionQueryCursor, SessionQueryOperationalError } from "./session-query-error.ts";
import {
  createSessionSearchQuery,
  MAX_SESSION_QUERY_LIMIT,
  MAX_SESSION_SEARCH_CONTEXT,
  type SessionSearchFilterInput,
  type SessionSearchPage,
} from "../domain/session-query.ts";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = MAX_SESSION_QUERY_LIMIT;
export const DEFAULT_SEARCH_CONTEXT = 0;
export const MAX_SEARCH_CONTEXT = MAX_SESSION_SEARCH_CONTEXT;

export type SearchSessionsResult = SessionSearchPage;

export async function searchSessions(input: {
  readonly paths: IndexPaths;
  readonly lifecycle: IndexLifecycle;
  readonly text: string;
  readonly filter?: SessionSearchFilterInput;
  readonly limit?: number;
  readonly context?: number;
  readonly cursor?: string;
}): Promise<SearchSessionsResult> {
  const cursor = admitSessionQueryCursor(input.cursor);
  const query = createSessionSearchQuery({
    text: input.text,
    limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
    context: input.context ?? DEFAULT_SEARCH_CONTEXT,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const state = await input.lifecycle.inspect(input.paths);
  if (state.status === "uninitialized") {
    if (query.cursor !== undefined) throw new SessionQueryOperationalError("stale-cursor");
    return Object.freeze({
      hits: Object.freeze([]),
      support: Object.freeze({
        occurrences: 0,
        uniqueContent: 0,
        uniqueKnownRoots: 0,
        unknownLineageSessions: 0,
      }),
    });
  }
  if (state.status !== "ready") throw new SessionLibraryError("library-unavailable");

  return withReader(input.lifecycle, input.paths, (reader) => reader.query.search(query));
}
