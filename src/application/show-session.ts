import { SessionLibraryError } from "./library-error.ts";
import { withReader } from "./list-sessions.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import type { IndexedSessionSummary } from "./ports/session-index.ts";
import type { SessionEntry, SessionIdentity } from "../domain/session.ts";
import { formatSessionIdentity } from "../domain/session-identity.ts";

export const DEFAULT_SHOW_ENTRY_COUNT = 50;
export const DEFAULT_SHOW_CONTEXT = 3;
export const MAX_SHOW_CONTEXT = 100;

export interface ShowSessionResult {
  readonly summary: IndexedSessionSummary;
  readonly entries: readonly SessionEntry[];
  readonly firstEntry: number | null;
  readonly lastEntry: number | null;
  readonly totalEntries: number;
}

export async function showSession(input: {
  readonly paths: IndexPaths;
  readonly lifecycle: IndexLifecycle;
  readonly identity: SessionIdentity;
  readonly entry?: number;
  readonly context?: number;
}): Promise<ShowSessionResult> {
  formatSessionIdentity(input.identity);
  validateSelection(input.entry, input.context);
  const state = await input.lifecycle.inspect(input.paths);
  if (state.status === "uninitialized") throw new SessionLibraryError("session-not-found");
  if (state.status !== "ready") throw new SessionLibraryError("library-unavailable");

  return withReader(input.lifecycle, input.paths, async (reader) => {
    const indexed = await reader.sessions.getSession(input.identity);
    if (indexed === undefined) throw new SessionLibraryError("session-not-found");
    const total = indexed.document.entries.length;
    let start = 0;
    let end = Math.min(total, DEFAULT_SHOW_ENTRY_COUNT);
    if (input.entry !== undefined) {
      if (input.entry >= total) throw new SessionLibraryError("entry-not-found");
      const context = input.context ?? DEFAULT_SHOW_CONTEXT;
      start = Math.max(0, input.entry - context);
      end = Math.min(total, input.entry + context + 1);
    }
    const entries = Object.freeze(indexed.document.entries.slice(start, end));
    return Object.freeze({
      summary: indexed.summary,
      entries,
      firstEntry: entries.length === 0 ? null : start,
      lastEntry: entries.length === 0 ? null : end - 1,
      totalEntries: total,
    });
  });
}

function validateSelection(entry: number | undefined, context: number | undefined): void {
  if (entry !== undefined && (!Number.isSafeInteger(entry) || entry < 0)) {
    throw new TypeError("Entry must be a non-negative integer");
  }
  if (context !== undefined) {
    if (entry === undefined) throw new TypeError("Context requires an entry");
    if (!Number.isSafeInteger(context) || context < 0 || context > MAX_SHOW_CONTEXT) {
      throw new TypeError(`Context must be an integer from 0 through ${MAX_SHOW_CONTEXT}`);
    }
  }
}
