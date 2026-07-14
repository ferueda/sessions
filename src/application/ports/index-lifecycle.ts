import type { IndexState, ReadyIndexState } from "../../domain/index-state.ts";
import type { IndexHealthInspector } from "./index-health.ts";
import type { SessionIndexReader, SessionIndexWriter } from "./session-index.ts";
import type { SourceDiscoveryWorkspace } from "./session-source.ts";

export interface IndexPaths {
  readonly directory: string;
  readonly scratch: string;
  readonly database: string;
  readonly wal: string;
  readonly shm: string;
}

export interface IndexStateInspector {
  inspect(paths: IndexPaths): Promise<IndexState>;
}

export interface IndexReader {
  readonly state: ReadyIndexState;
  readonly sessions: SessionIndexReader;
  close(): Promise<void>;
}

export interface IndexWriter {
  readonly state: ReadyIndexState;
  readonly sessions: SessionIndexWriter;
  readonly workspace: SourceDiscoveryWorkspace;
  close(): Promise<void>;
}

export interface IndexLifecycle extends IndexStateInspector, IndexHealthInspector {
  openReader(paths: IndexPaths): Promise<IndexReader>;
  openWriter(paths: IndexPaths): Promise<IndexWriter>;
}
