import { SessionLibraryError } from "./library-error.ts";
import type { IndexLifecycle, IndexPaths } from "./ports/index-lifecycle.ts";
import { withReader } from "./list-sessions.ts";
import {
  createSessionManifestQuery,
  createSessionManifestResult,
  type SessionManifestFilterInput,
  type SessionManifestResult,
} from "../domain/session-manifest.ts";
import { createUninitializedCaptureScope } from "../domain/session-capture-scope.ts";

export async function createSessionManifest(input: {
  readonly paths: IndexPaths;
  readonly lifecycle: IndexLifecycle;
  readonly filter?: SessionManifestFilterInput;
}): Promise<SessionManifestResult> {
  const query = createSessionManifestQuery(
    input.filter === undefined ? {} : { filter: input.filter },
  );
  const state = await input.lifecycle.inspect(input.paths);
  if (state.status === "uninitialized") {
    return createSessionManifestResult({
      selection: query.selection,
      captureScope: createUninitializedCaptureScope(query.filter),
      revisions: [],
    });
  }
  if (state.status !== "ready") throw new SessionLibraryError("library-unavailable");

  return withReader(input.lifecycle, input.paths, async (reader) => {
    const manifest = await reader.query.manifest(query);
    return createSessionManifestResult({
      selection: query.selection,
      captureScope: manifest.captureScope,
      revisions: manifest.revisions,
    });
  });
}
