import type { IndexState } from "../domain/index-state.ts";
import type { IndexPaths, IndexStateInspector } from "./ports/index-lifecycle.ts";

export interface PathsReportIndex {
  readonly directory: string;
  readonly database: string;
  readonly wal: string;
  readonly shm: string;
  readonly initialized: boolean;
  readonly state: IndexState["status"];
  readonly schemaVersion: number | null;
  readonly supportedSchemaVersion: number;
}

export interface PathsReport {
  readonly schemaVersion: 1;
  readonly command: "paths";
  readonly index: PathsReportIndex;
}

export async function getPaths(
  paths: IndexPaths,
  inspector: IndexStateInspector,
): Promise<PathsReport> {
  const state = await inspector.inspect(paths);

  return {
    schemaVersion: 1,
    command: "paths",
    index: {
      directory: paths.directory,
      database: paths.database,
      wal: paths.wal,
      shm: paths.shm,
      initialized: state.initialized,
      state: state.status,
      schemaVersion: state.schemaVersion,
      supportedSchemaVersion: state.supportedSchemaVersion,
    },
  };
}
