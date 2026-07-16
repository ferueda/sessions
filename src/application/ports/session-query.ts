import type {
  SessionEntryPage,
  SessionEntryQuery,
  SessionListPage,
  SessionListQuery,
  SessionSearchPage,
  SessionSearchQuery,
} from "../../domain/session-query.ts";

/** One call observes and returns one immutable retained-library snapshot. */
export interface SessionQueryRepository {
  entries(query: SessionEntryQuery): Promise<SessionEntryPage>;
  list(query: SessionListQuery): Promise<SessionListPage>;
  search(query: SessionSearchQuery): Promise<SessionSearchPage>;
}
