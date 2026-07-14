import { admitSourceProbe } from "./admit-source-probe.ts";
import { compareBinaryStrings } from "./discover-sessions.ts";
import type { IndexPaths, IndexStateInspector } from "./ports/index-lifecycle.ts";
import type { SelectedSessionSource } from "./ports/session-source.ts";
import type { IndexState } from "../domain/index-state.ts";
import type { SourceInstance } from "../domain/session.ts";

export interface PathsReportLibrary {
  readonly directory: string;
  readonly scratch: string;
  readonly database: string;
  readonly wal: string;
  readonly shm: string;
  readonly initialized: boolean;
  readonly state: IndexState["status"];
  readonly schemaVersion: number | null;
  readonly supportedSchemaVersion: number;
}

export type PathsSourceProbe =
  | {
      readonly status: "ready" | "unavailable" | "unreadable";
      readonly locations: readonly { readonly role: string; readonly uri: string }[];
    }
  | {
      readonly status: "failed";
      readonly failure: "invalid-probe" | "probe-error";
      readonly locations: readonly [];
    };

export interface PathsReport {
  readonly schemaVersion: 2;
  readonly command: "paths";
  readonly library: PathsReportLibrary;
  readonly sources: readonly {
    readonly source: SourceInstance;
    readonly probe: PathsSourceProbe;
  }[];
}

export async function getPaths(
  paths: IndexPaths,
  inspector: IndexStateInspector,
  sources: readonly SelectedSessionSource[] = [],
): Promise<PathsReport> {
  const state = await inspector.inspect(paths);
  const ordered = [...sources].sort(
    (left, right) =>
      compareBinaryStrings(left.instance.kind, right.instance.kind) ||
      compareBinaryStrings(left.instance.instanceId, right.instance.instanceId),
  );
  const sourceReports = [];
  for (const selected of ordered) {
    sourceReports.push({
      source: Object.freeze({ ...selected.instance }),
      probe: await inspectProbe(selected),
    });
  }

  return Object.freeze({
    schemaVersion: 2,
    command: "paths",
    library: Object.freeze({
      directory: paths.directory,
      scratch: paths.scratch,
      database: paths.database,
      wal: paths.wal,
      shm: paths.shm,
      initialized: state.initialized,
      state: state.status,
      schemaVersion: state.schemaVersion,
      supportedSchemaVersion: state.supportedSchemaVersion,
    }),
    sources: Object.freeze(sourceReports),
  });
}

async function inspectProbe(selected: SelectedSessionSource): Promise<PathsSourceProbe> {
  let value: unknown;
  try {
    value = await selected.adapter.probe();
  } catch {
    return Object.freeze({
      status: "failed",
      failure: "probe-error",
      locations: Object.freeze([]) as readonly [],
    });
  }
  const probe = admitSourceProbe(value);
  if (
    probe === undefined ||
    probe.source.kind !== selected.instance.kind ||
    probe.source.instanceId !== selected.instance.instanceId
  ) {
    return Object.freeze({
      status: "failed",
      failure: "invalid-probe",
      locations: Object.freeze([]) as readonly [],
    });
  }
  return Object.freeze({
    status: probe.status,
    locations: Object.freeze(
      probe.locations.map(({ role, locator }) => Object.freeze({ role, uri: locator.uri })),
    ),
  });
}
