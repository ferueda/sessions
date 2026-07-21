import type {
  SessionEntryPage,
  SessionEntryQuery,
  SessionListPage,
  SessionListQuery,
  SessionSearchPage,
  SessionSearchQuery,
} from "../../domain/session-query.ts";
import type { SessionManifestQuery, SessionManifestResult } from "../../domain/session-manifest.ts";

/** One call observes and returns one immutable retained-library snapshot. */
export interface SessionQueryRepository {
  entries(query: SessionEntryQuery): Promise<SessionEntryPage>;
  list(query: SessionListQuery): Promise<SessionListPage>;
  manifest(query: SessionManifestQuery): Promise<SessionManifestResult>;
  search(query: SessionSearchQuery): Promise<SessionSearchPage>;
}
