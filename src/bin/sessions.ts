#!/usr/bin/env node

import { createRequire } from "node:module";
import { homedir } from "node:os";

import type { DoctorProgressObserver } from "../application/doctor-progress.ts";
import type { IndexProgressObserver } from "../application/index-progress.ts";
import type { ProgramOptions } from "../cli/program.ts";
import { CliSignalExit, runCli } from "../cli/run.ts";

const require = createRequire(import.meta.url);
const manifest = require("../../package.json") as { version?: unknown };
const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
const indexTimingsEnabled = process.env.SESSIONS_INDEX_TIMINGS === "1";
const doctorTimingsEnabled = process.env.SESSIONS_DOCTOR_TIMINGS === "1";

const resolveCodexSource = memoizeAsync(async () => {
  const { createCodexSource } = await import("../adapters/codex/source.ts");
  return createCodexSource();
});
const resolveCursorSource = memoizeAsync(async () => {
  const { createCursorSource } = await import("../adapters/cursor/source.ts");
  return createCursorSource();
});
const registeredSources = Object.freeze([
  Object.freeze({ kind: "codex", resolve: resolveCodexSource }),
  Object.freeze({ kind: "cursor", resolve: resolveCursorSource }),
]);
const resolveAllSources = () => Promise.all(registeredSources.map((source) => source.resolve()));
const resolveIndexSources = async (kind: string | undefined) => {
  const selected =
    kind === undefined
      ? registeredSources
      : registeredSources.filter((source) => source.kind === kind);
  if (selected.length === 0) throw new TypeError("Unknown session source");
  return Promise.all(selected.map((source) => source.resolve()));
};

const loadPathResolver = memoizeAsync(() => import("../infrastructure/state/paths.ts"));
const resolvePaths = async () => {
  const { resolveIndexPaths } = await loadPathResolver();
  return resolveIndexPaths({
    platform: process.platform,
    env: process.env,
    homeDirectory: homedir(),
  });
};
const resolveIndexLifecycle = memoizeAsync(async () => {
  const { createSqliteIndexLifecycle } = await import("../infrastructure/sqlite/database.ts");
  return createSqliteIndexLifecycle();
});
const resolveMaintenance = memoizeAsync(async () => {
  const { createSqliteIndexMaintenance } =
    await import("../infrastructure/sqlite/index-maintenance.ts");
  return createSqliteIndexMaintenance();
});

const loadIndexComposition = memoizeAsync(async () => {
  const [
    { isIndexInterruptedError },
    { runIndex },
    { timeIndexOperation },
    { createIndexTimingCollector, encodeIndexTimingDiagnostic },
    { installIndexInterrupt },
  ] = await Promise.all([
    import("../application/index-interruption.ts"),
    import("../application/run-index.ts"),
    import("../application/index-timing.ts"),
    import("../infrastructure/runtime/index-timings.ts"),
    import("../infrastructure/runtime/index-interrupt.ts"),
  ]);
  return {
    isIndexInterruptedError,
    runIndex,
    timeIndexOperation,
    createIndexTimingCollector,
    encodeIndexTimingDiagnostic,
    installIndexInterrupt,
  };
});

const executeIndex = async (
  source: string | undefined,
  signal: AbortSignal,
  progress: IndexProgressObserver | undefined,
) => {
  const [composition, lifecycle] = await Promise.all([
    loadIndexComposition(),
    resolveIndexLifecycle(),
  ]);
  const collector = indexTimingsEnabled ? composition.createIndexTimingCollector() : undefined;
  try {
    const execute = async () => {
      const paths = await resolvePaths();
      const sources = collector
        ? await composition.timeIndexOperation(collector.recorder, "sourceResolution", async () =>
            resolveIndexSources(source),
          )
        : await resolveIndexSources(source);
      return composition.runIndex({
        paths,
        sources,
        sourceSelection: source === undefined ? "optional" : "required",
        lifecycle,
        clock: { now: () => new Date() },
        signal,
        ...(progress === undefined ? {} : { progress }),
        ...(collector === undefined ? {} : { timing: collector.recorder }),
      });
    };
    return collector === undefined
      ? await execute()
      : await composition.timeIndexOperation(collector.recorder, "total", execute);
  } finally {
    if (collector !== undefined) {
      try {
        process.stderr.write(composition.encodeIndexTimingDiagnostic(collector.snapshot()));
      } catch {
        // Opt-in timing output is best-effort and must not change indexing.
      }
    }
  }
};

const indexSessions = async (
  source: string | undefined,
  options: { readonly progress?: IndexProgressObserver } = {},
) => {
  const composition = await loadIndexComposition();
  const interrupt = composition.installIndexInterrupt();
  try {
    return await executeIndex(source, interrupt.signal, options.progress);
  } catch (error) {
    if (composition.isIndexInterruptedError(error) && interrupt.interruption !== undefined) {
      throw new CliSignalExit(interrupt.interruption.exitCode);
    }
    throw error;
  } finally {
    interrupt.dispose();
  }
};

const loadDoctorComposition = memoizeAsync(async () => {
  const [
    { runDoctor },
    { timeDoctorOperation },
    { createSourceDiagnostic },
    { createDoctorTimingCollector, encodeDoctorTimingDiagnostic },
    { createNodeDiagnostic },
    { createIndexStateDiagnostic },
    { createSqliteDiagnostic },
  ] = await Promise.all([
    import("../application/run-doctor.ts"),
    import("../application/doctor-timing.ts"),
    import("../application/source-diagnostic.ts"),
    import("../infrastructure/runtime/doctor-timings.ts"),
    import("../infrastructure/runtime/node-diagnostic.ts"),
    import("../infrastructure/state/index-state-diagnostic.ts"),
    import("../infrastructure/sqlite/sqlite-diagnostic.ts"),
  ]);
  return {
    runDoctor,
    timeDoctorOperation,
    createSourceDiagnostic,
    createDoctorTimingCollector,
    encodeDoctorTimingDiagnostic,
    createNodeDiagnostic,
    createIndexStateDiagnostic,
    createSqliteDiagnostic,
  };
});

const doctorSessions = async (options: { readonly progress?: DoctorProgressObserver } = {}) => {
  const [composition, lifecycle, { resolveIndexPaths }] = await Promise.all([
    loadDoctorComposition(),
    resolveIndexLifecycle(),
    loadPathResolver(),
  ]);
  const collector = doctorTimingsEnabled ? composition.createDoctorTimingCollector() : undefined;
  try {
    const execute = async () => {
      const sources =
        collector === undefined
          ? await resolveAllSources()
          : await composition.timeDoctorOperation(
              collector.recorder,
              "sourceResolution",
              resolveAllSources,
            );
      const resolveDoctorPaths = () =>
        resolveIndexPaths({
          platform: process.platform,
          env: process.env,
          homeDirectory: homedir(),
        });
      return composition.runDoctor([
        composition.createNodeDiagnostic(),
        composition.createSqliteDiagnostic(),
        composition.createIndexStateDiagnostic(resolveDoctorPaths, lifecycle, {
          ...(options.progress === undefined ? {} : { progress: options.progress }),
          ...(collector === undefined ? {} : { timing: collector.recorder }),
        }),
        ...sources.map(composition.createSourceDiagnostic),
      ]);
    };
    return collector === undefined
      ? await execute()
      : await composition.timeDoctorOperation(collector.recorder, "total", execute);
  } finally {
    if (collector !== undefined) {
      try {
        process.stderr.write(composition.encodeDoctorTimingDiagnostic(collector.snapshot()));
      } catch {
        // Opt-in timing output is best-effort and must not change doctor.
      }
    }
  }
};

const loadGetPaths = memoizeAsync(
  async () => (await import("../application/get-paths.ts")).getPaths,
);
const loadListSessions = memoizeAsync(
  async () => (await import("../application/list-sessions.ts")).listSessions,
);
const loadCreateSessionManifest = memoizeAsync(
  async () => (await import("../application/create-session-manifest.ts")).createSessionManifest,
);
const loadListSessionEntries = memoizeAsync(
  async () => (await import("../application/list-session-entries.ts")).listSessionEntries,
);
const loadSearchSessions = memoizeAsync(
  async () => (await import("../application/search-sessions.ts")).searchSessions,
);
const loadShowSession = memoizeAsync(
  async () => (await import("../application/show-session.ts")).showSession,
);
const loadExportSession = memoizeAsync(
  async () => (await import("../application/export-session.ts")).exportSession,
);
const loadForgetSession = memoizeAsync(
  async () => (await import("../application/forget-session.ts")).forgetSession,
);
const loadClearData = memoizeAsync(
  async () => (await import("../application/clear-index.ts")).clearData,
);
const loadCompactIndex = memoizeAsync(
  async () => (await import("../application/compact-index.ts")).compactIndex,
);
const loadRepairOrphanedContent = memoizeAsync(
  async () => (await import("../application/repair-orphaned-content.ts")).repairOrphanedContent,
);

const programOptions: ProgramOptions = {
  version,
  output: {
    stderrIsInteractive: process.stderr.isTTY === true && process.env.TERM !== "dumb",
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  },
  doctor: doctorSessions,
  paths: async () => {
    const [getPaths, paths, lifecycle, sources] = await Promise.all([
      loadGetPaths(),
      resolvePaths(),
      resolveIndexLifecycle(),
      resolveAllSources(),
    ]);
    return getPaths(paths, lifecycle, sources);
  },
  indexSources: registeredSources.map(({ kind }) => kind),
  index: indexSessions,
  list: async ({ filter, limit, cursor }) => {
    const [listSessions, paths, lifecycle] = await Promise.all([
      loadListSessions(),
      resolvePaths(),
      resolveIndexLifecycle(),
    ]);
    return listSessions({
      paths,
      lifecycle,
      ...(filter === undefined ? {} : { filter }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
  },
  manifest: async ({ filter }) => {
    const [createSessionManifest, paths, lifecycle] = await Promise.all([
      loadCreateSessionManifest(),
      resolvePaths(),
      resolveIndexLifecycle(),
    ]);
    return createSessionManifest({
      paths,
      lifecycle,
      ...(filter === undefined ? {} : { filter }),
    });
  },
  entries: async ({ filter, selection, limit, cursor }) => {
    const [listSessionEntries, paths, lifecycle] = await Promise.all([
      loadListSessionEntries(),
      resolvePaths(),
      resolveIndexLifecycle(),
    ]);
    return listSessionEntries({
      paths,
      lifecycle,
      ...(filter === undefined ? {} : { filter }),
      ...(selection === undefined ? {} : { selection }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    });
  },
  search: async ({ text, termMode, filter, limit, context, cursor }) => {
    const [searchSessions, paths, lifecycle] = await Promise.all([
      loadSearchSessions(),
      resolvePaths(),
      resolveIndexLifecycle(),
    ]);
    return searchSessions({
      paths,
      lifecycle,
      text,
      ...(termMode === undefined ? {} : { termMode }),
      ...(filter === undefined ? {} : { filter }),
      ...(limit === undefined ? {} : { limit }),
      ...(context === undefined ? {} : { context }),
      ...(cursor === undefined ? {} : { cursor }),
    });
  },
  show: async ({ identity, expectedDocumentDigest, entry, context, fromEntry, toEntry }) => {
    const [showSession, paths, lifecycle] = await Promise.all([
      loadShowSession(),
      resolvePaths(),
      resolveIndexLifecycle(),
    ]);
    return showSession({
      paths,
      lifecycle,
      identity,
      ...(expectedDocumentDigest === undefined ? {} : { expectedDocumentDigest }),
      ...(entry === undefined ? {} : { entry }),
      ...(context === undefined ? {} : { context }),
      ...(fromEntry === undefined ? {} : { fromEntry }),
      ...(toEntry === undefined ? {} : { toEntry }),
    });
  },
  export: async ({ identity, expectedDocumentDigest, full, fromEntry, toEntry }) => {
    const [exportSession, paths, lifecycle] = await Promise.all([
      loadExportSession(),
      resolvePaths(),
      resolveIndexLifecycle(),
    ]);
    return exportSession({
      paths,
      lifecycle,
      identity,
      ...(expectedDocumentDigest === undefined ? {} : { expectedDocumentDigest }),
      ...(full === undefined ? {} : { full }),
      ...(fromEntry === undefined ? {} : { fromEntry }),
      ...(toEntry === undefined ? {} : { toEntry }),
    });
  },
  forget: async (identity) => {
    const [forgetSession, paths, maintenance] = await Promise.all([
      loadForgetSession(),
      resolvePaths(),
      resolveMaintenance(),
    ]);
    return forgetSession(paths, maintenance, identity);
  },
  clearData: async () => {
    const [clearData, paths, maintenance] = await Promise.all([
      loadClearData(),
      resolvePaths(),
      resolveMaintenance(),
    ]);
    return clearData(paths, maintenance);
  },
  compactData: async () => {
    const [compactIndex, paths, maintenance] = await Promise.all([
      loadCompactIndex(),
      resolvePaths(),
      resolveMaintenance(),
    ]);
    return compactIndex(paths, maintenance);
  },
  repairOrphanedData: async () => {
    const [repairOrphanedContent, paths, maintenance] = await Promise.all([
      loadRepairOrphanedContent(),
      resolvePaths(),
      resolveMaintenance(),
    ]);
    return repairOrphanedContent(paths, maintenance);
  },
};

const exitCode = await runCli(process.argv.slice(2), programOptions);
process.exitCode = exitCode;

function memoizeAsync<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= load());
}
