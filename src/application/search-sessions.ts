import { SessionLibraryError } from "./library-error.ts";
import { withReader } from "./list-sessions.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import { selectSessionSummary, type SelectedSessionSummary } from "./session-presentation.ts";
import { admitSessionQueryCursor, SessionQueryOperationalError } from "./session-query-error.ts";
import {
  createSessionSearchQuery,
  MAX_SESSION_QUERY_LIMIT,
  MAX_SESSION_SEARCH_CONTEXT,
  type SessionQueryCursor,
  type SessionSearchContextEntry,
  type SessionSearchEntry,
  type SessionSearchFilterInput,
  type SessionSearchHit,
  type SessionSearchSnippet,
  type SessionSearchSupport,
} from "../domain/session-query.ts";

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = MAX_SESSION_QUERY_LIMIT;
export const DEFAULT_SEARCH_CONTEXT = 0;
export const MAX_SEARCH_CONTEXT = MAX_SESSION_SEARCH_CONTEXT;

export interface SelectedSessionSearchHit {
  readonly session: SelectedSessionSummary;
  readonly entry: SessionSearchEntry;
  readonly snippet: SessionSearchSnippet;
  readonly context: readonly SessionSearchContextEntry[];
  readonly linkedContextTruncated: boolean;
}

export interface SearchSessionsResult {
  readonly hits: readonly SelectedSessionSearchHit[];
  readonly support: SessionSearchSupport;
  readonly nextCursor?: SessionQueryCursor;
}

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

  return withReader(input.lifecycle, input.paths, async (reader) => {
    const page = await reader.query.search(query);
    return Object.freeze({
      hits: Object.freeze(page.hits.map(selectSearchHit)),
      support: copySupport(page.support),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });
}

function selectSearchHit(hit: SessionSearchHit): SelectedSessionSearchHit {
  return Object.freeze({
    session: selectSessionSummary(hit.session),
    entry: copyEntry(hit.entry),
    snippet: Object.freeze({
      segmentOrdinal: hit.snippet.segmentOrdinal,
      origin: hit.snippet.origin,
      originConfidence: hit.snippet.originConfidence,
      contentHash: Object.freeze({
        scheme: hit.snippet.contentHash.scheme,
        digest: hit.snippet.contentHash.digest,
      }),
      text: hit.snippet.text,
      truncated: hit.snippet.truncated,
      additionalMatchingSegments: hit.snippet.additionalMatchingSegments,
    }),
    context: Object.freeze(
      hit.context.map((context) =>
        Object.freeze({
          ...copyEntry(context),
          body: context.body,
          bodyTruncated: context.bodyTruncated,
          adjacent: context.adjacent,
          linked: context.linked,
        }),
      ),
    ),
    linkedContextTruncated: hit.linkedContextTruncated,
  });
}

function copyEntry(entry: SessionSearchEntry): SessionSearchEntry {
  return Object.freeze({
    ordinal: entry.ordinal,
    kind: entry.kind,
    actor: entry.actor,
    ...(entry.timestamp === undefined ? {} : { timestamp: entry.timestamp }),
    ...(entry.relatedEntryOrdinal === undefined
      ? {}
      : { relatedEntryOrdinal: entry.relatedEntryOrdinal }),
    ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
    ...(entry.toolName === undefined ? {} : { toolName: entry.toolName }),
    ...(entry.toolNamespace === undefined ? {} : { toolNamespace: entry.toolNamespace }),
  });
}

function copySupport(support: SessionSearchSupport): SessionSearchSupport {
  return Object.freeze({
    occurrences: support.occurrences,
    uniqueContent: support.uniqueContent,
    uniqueKnownRoots: support.uniqueKnownRoots,
    unknownLineageSessions: support.unknownLineageSessions,
  });
}
