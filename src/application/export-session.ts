import { SessionLibraryError } from "./library-error.ts";
import { withReader } from "./list-sessions.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import { admitSessionEntryRange, resolveSessionEntryWindow } from "./session-entry-range.ts";
import { selectSessionTranscript, type SelectedSessionTranscript } from "./session-presentation.ts";
import { formatSessionIdentity } from "../domain/session-identity.ts";
import { projectPublicSessionDocument } from "../domain/public-session-document.ts";
import type { SessionIdentity } from "../domain/session.ts";

export type ExportSessionResult = SelectedSessionTranscript;

export async function exportSession(input: {
  readonly paths: IndexPaths;
  readonly lifecycle: IndexLifecycle;
  readonly identity: SessionIdentity;
  readonly full?: boolean;
  readonly fromEntry?: number;
  readonly toEntry?: number;
}): Promise<ExportSessionResult> {
  formatSessionIdentity(input.identity);
  const entryRange = admitSessionEntryRange(input);
  if (entryRange !== undefined && input.full === true) {
    throw new TypeError("Entry range cannot be combined with full export");
  }
  const state = await input.lifecycle.inspect(input.paths);
  if (state.status === "uninitialized") throw new SessionLibraryError("session-not-found");
  if (state.status !== "ready") throw new SessionLibraryError("library-unavailable");

  return withReader(input.lifecycle, input.paths, async (reader) => {
    const indexed = await reader.sessions.getSession(input.identity);
    if (indexed === undefined) throw new SessionLibraryError("session-not-found");
    const entryWindow =
      entryRange === undefined
        ? undefined
        : resolveSessionEntryWindow(entryRange, indexed.document.entries.length);
    return selectSessionTranscript({
      summary: indexed.summary,
      document: projectPublicSessionDocument(indexed.document),
      mode: input.full === true ? "full" : "bounded",
      ...(entryWindow === undefined ? {} : { entryWindow }),
    });
  });
}
