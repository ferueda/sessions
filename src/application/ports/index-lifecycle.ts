import type { IndexState, ReadyIndexState } from "../../domain/index-state.ts";

export interface IndexPaths {
  readonly directory: string;
  readonly database: string;
  readonly wal: string;
  readonly shm: string;
}

export interface IndexStateInspector {
  inspect(paths: IndexPaths): Promise<IndexState>;
}

export interface IndexWriter {
  readonly state: ReadyIndexState;
  close(): Promise<void>;
}

export interface IndexLifecycle extends IndexStateInspector {
  openWriter(paths: IndexPaths): Promise<IndexWriter>;
}
