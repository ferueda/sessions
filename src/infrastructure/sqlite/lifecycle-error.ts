import type { IndexState } from "../../domain/index-state.ts";

export class SqliteIndexLifecycleError extends Error {
  readonly state: IndexState;

  constructor(state: IndexState, options?: { readonly cause?: unknown }) {
    super(
      `SQLite index cannot be opened while state is ${state.status}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "SqliteIndexLifecycleError";
    this.state = state;
  }
}

export class SqliteIndexReaderClosedError extends Error {
  constructor() {
    super("SQLite index reader is closed");
    this.name = "SqliteIndexReaderClosedError";
  }
}
