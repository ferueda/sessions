import type { IndexState } from "../../domain/index-state.ts";

export class SqliteIndexLifecycleError extends Error {
  readonly state: IndexState;

  constructor(state: IndexState, options?: { readonly cause?: unknown }) {
    super(
      lifecycleErrorMessage(state),
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SqliteIndexLifecycleError";
    this.state = state;
  }
}

function lifecycleErrorMessage(state: IndexState): string {
  if (state.status === "incompatible" && state.reason === "migration-checksum-mismatch") {
    return [
      "Session library was created by an incompatible pre-release build.",
      "Use a fresh SESSIONS_DATA_DIR, or back up and remove only the Sessions-owned directory",
      'shown by "sessions paths", then run "sessions index" again',
    ].join(" ");
  }
  return `SQLite index cannot be opened while state is ${state.status}`;
}

export class SqliteIndexReaderClosedError extends Error {
  constructor() {
    super("SQLite index reader is closed");
    this.name = "SqliteIndexReaderClosedError";
  }
}
