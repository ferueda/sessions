import { SessionLibraryError } from "./library-error.ts";
import { withReader } from "./list-sessions.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import { selectSessionSummary, type SelectedSessionSummary } from "./session-presentation.ts";
import { admitSessionQueryCursor, SessionQueryOperationalError } from "./session-query-error.ts";
import { selectSessionRoot } from "./session-root-presentation.ts";
import {
  createSessionEntryQuery,
  MAX_ENTRY_LIST_LIMIT,
  type SessionEntryContentSummary,
  type SessionEntryFilterInput,
  type SessionEntryInventoryItem,
  type SessionEntrySelection,
  type SessionQueryCursor,
  type SessionSearchEntry,
} from "../domain/session-query.ts";
import type { SessionRootResolution } from "../domain/session-lineage.ts";
import {
  copySessionCaptureScope,
  createUninitializedCaptureScope,
  type SessionCaptureScope,
} from "../domain/session-capture-scope.ts";

export const DEFAULT_ENTRY_LIST_LIMIT = 50;

export interface SelectedSessionEntryInventoryItem {
  readonly session: SelectedSessionSummary;
  readonly entry: SessionSearchEntry;
  readonly root: SessionRootResolution;
  readonly content: SessionEntryContentSummary;
}

export interface ListSessionEntriesResult {
  readonly entries: readonly SelectedSessionEntryInventoryItem[];
  readonly captureScope: SessionCaptureScope;
  readonly nextCursor?: SessionQueryCursor;
}

export async function listSessionEntries(input: {
  readonly paths: IndexPaths;
  readonly lifecycle: IndexLifecycle;
  readonly filter?: SessionEntryFilterInput;
  readonly selection?: SessionEntrySelection;
  readonly limit?: number;
  readonly cursor?: string;
}): Promise<ListSessionEntriesResult> {
  const cursor = admitSessionQueryCursor(input.cursor);
  const query = createSessionEntryQuery({
    limit: input.limit ?? DEFAULT_ENTRY_LIST_LIMIT,
    ...(input.filter === undefined ? {} : { filter: input.filter }),
    ...(input.selection === undefined ? {} : { selection: input.selection }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  const state = await input.lifecycle.inspect(input.paths);
  if (state.status === "uninitialized") {
    if (query.cursor !== undefined) throw new SessionQueryOperationalError("stale-cursor");
    return Object.freeze({
      entries: Object.freeze([]),
      captureScope: createUninitializedCaptureScope(query.filter),
    });
  }
  if (state.status !== "ready") throw new SessionLibraryError("library-unavailable");

  return withReader(input.lifecycle, input.paths, async (reader) => {
    const page = await reader.query.entries(query);
    return Object.freeze({
      entries: Object.freeze(page.entries.map(selectEntryInventoryItem)),
      captureScope: copySessionCaptureScope(page.captureScope),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });
}

function selectEntryInventoryItem(
  item: SessionEntryInventoryItem,
): SelectedSessionEntryInventoryItem {
  return Object.freeze({
    session: selectSessionSummary(item.session),
    entry: copyEntry(item.entry),
    root: selectSessionRoot(item.root),
    content: Object.freeze({
      textSegmentCount: item.content.textSegmentCount,
      omittedSegmentCount: item.content.omittedSegmentCount,
      unpreviewedTextSegmentCount: item.content.unpreviewedTextSegmentCount,
      ...(item.content.preview === undefined
        ? {}
        : {
            preview: Object.freeze({
              segmentOrdinal: item.content.preview.segmentOrdinal,
              origin: item.content.preview.origin,
              originConfidence: item.content.preview.originConfidence,
              contentHash: Object.freeze({ ...item.content.preview.contentHash }),
              text: item.content.preview.text,
              truncated: item.content.preview.truncated,
            }),
          }),
    }),
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

export { MAX_ENTRY_LIST_LIMIT };
