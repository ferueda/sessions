import { SessionLibraryError } from "./library-error.ts";
import { admitExpectedDocumentDigest, requireExpectedSession } from "./guard-session-document.ts";
import { withReader } from "./list-sessions.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import { admitSessionEntryRange, resolveSessionEntryWindow } from "./session-entry-range.ts";
import { selectSessionTranscript, type SelectedSessionTranscript } from "./session-presentation.ts";
import {
  projectPublicSessionDocument,
  type SessionDocumentDigest,
} from "../domain/public-session-document.ts";
import type { SessionIdentity } from "../domain/session.ts";
import { formatSessionIdentity } from "../domain/session-identity.ts";

export const DEFAULT_SHOW_ENTRY_COUNT = 50;
export const DEFAULT_SHOW_CONTEXT = 3;
export const MAX_SHOW_CONTEXT = 100;

export type ShowSessionResult = SelectedSessionTranscript;

export async function showSession(input: {
  readonly paths: IndexPaths;
  readonly lifecycle: IndexLifecycle;
  readonly identity: SessionIdentity;
  readonly expectedDocumentDigest?: SessionDocumentDigest;
  readonly entry?: number;
  readonly context?: number;
  readonly fromEntry?: number;
  readonly toEntry?: number;
}): Promise<ShowSessionResult> {
  formatSessionIdentity(input.identity);
  const expectedDocumentDigest = admitExpectedDocumentDigest(input.expectedDocumentDigest);
  const entryRange = admitSessionEntryRange(input);
  validateSelection(input.entry, input.context, entryRange !== undefined);
  const state = await input.lifecycle.inspect(input.paths);
  if (state.status === "uninitialized") throw new SessionLibraryError("session-not-found");
  if (state.status !== "ready") throw new SessionLibraryError("library-unavailable");

  return withReader(input.lifecycle, input.paths, async (reader) => {
    const indexed = requireExpectedSession(
      await reader.sessions.getSession(input.identity),
      expectedDocumentDigest,
    );
    const total = indexed.document.entries.length;
    let start = 0;
    let end = Math.min(total, DEFAULT_SHOW_ENTRY_COUNT);
    if (entryRange !== undefined) {
      ({ start, end } = resolveSessionEntryWindow(entryRange, total));
    } else if (input.entry !== undefined) {
      if (input.entry >= total) throw new SessionLibraryError("entry-not-found");
      const context = input.context ?? DEFAULT_SHOW_CONTEXT;
      start = Math.max(0, input.entry - context);
      end = Math.min(total, input.entry + context + 1);
    }
    return selectSessionTranscript({
      summary: indexed.summary,
      document: projectPublicSessionDocument(indexed.document),
      mode: "bounded",
      entryWindow: { start, end },
    });
  });
}

function validateSelection(
  entry: number | undefined,
  context: number | undefined,
  hasEntryRange: boolean,
): void {
  if (hasEntryRange && (entry !== undefined || context !== undefined)) {
    throw new TypeError("Entry range cannot be combined with entry or context");
  }
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
