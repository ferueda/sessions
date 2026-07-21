#!/usr/bin/env node

import { createRequire } from "node:module";
import { homedir } from "node:os";

import { createCodexSource } from "../adapters/codex/source.ts";
import { createCursorSource } from "../adapters/cursor/source.ts";
import { clearData } from "../application/clear-index.ts";
import { compactIndex } from "../application/compact-index.ts";
import { exportSession } from "../application/export-session.ts";
import { repairOrphanedContent } from "../application/repair-orphaned-content.ts";
import { forgetSession } from "../application/forget-session.ts";
import { getPaths } from "../application/get-paths.ts";
import { timeIndexOperation } from "../application/index-timing.ts";
import { listSessions } from "../application/list-sessions.ts";
import { listSessionEntries } from "../application/list-session-entries.ts";
import { runDoctor } from "../application/run-doctor.ts";
import { runIndex } from "../application/run-index.ts";
import { isIndexInterruptedError } from "../application/index-interruption.ts";
import type { IndexProgressObserver } from "../application/index-progress.ts";
import { searchSessions } from "../application/search-sessions.ts";
import { showSession } from "../application/show-session.ts";
import { createSourceDiagnostic } from "../application/source-diagnostic.ts";
import { CliSignalExit, runCli } from "../cli/run.ts";
import { createNodeDiagnostic } from "../infrastructure/runtime/node-diagnostic.ts";
import { createIndexStateDiagnostic } from "../infrastructure/state/index-state-diagnostic.ts";
import { resolveIndexPaths } from "../infrastructure/state/paths.ts";
import { createSqliteIndexLifecycle } from "../infrastructure/sqlite/database.ts";
import { createSqliteDiagnostic } from "../infrastructure/sqlite/sqlite-diagnostic.ts";
import { createSqliteIndexMaintenance } from "../infrastructure/sqlite/index-maintenance.ts";
import {
  createIndexTimingCollector,
  encodeIndexTimingDiagnostic,
} from "../infrastructure/runtime/index-timings.ts";
import { installIndexInterrupt } from "../infrastructure/runtime/index-interrupt.ts";

const require = createRequire(import.meta.url);
const manifest = require("../../package.json") as { version?: unknown };
const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
const indexLifecycle = createSqliteIndexLifecycle();
const maintenance = createSqliteIndexMaintenance();
const indexTimingsEnabled = process.env.SESSIONS_INDEX_TIMINGS === "1";
let codexSource: ReturnType<typeof createCodexSource> | undefined;
let cursorSource: ReturnType<typeof createCursorSource> | undefined;
const resolveCodexSource = () => (codexSource ??= createCodexSource());
const resolveCursorSource = () => (cursorSource ??= createCursorSource());
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
const resolvePaths = () =>
  resolveIndexPaths({
    platform: process.platform,
    env: process.env,
    homeDirectory: homedir(),
  });

const executeIndex = async (
  source: string | undefined,
  signal: AbortSignal,
  progress: IndexProgressObserver | undefined,
) => {
  const collector = indexTimingsEnabled ? createIndexTimingCollector() : undefined;
  try {
    const execute = async () => {
      const paths = resolvePaths();
      const sources = collector
        ? await timeIndexOperation(collector.recorder, "sourceResolution", () =>
            resolveIndexSources(source),
          )
        : await resolveIndexSources(source);
      return runIndex({
        paths,
        sources,
        sourceSelection: source === undefined ? "optional" : "required",
        lifecycle: indexLifecycle,
        clock: { now: () => new Date() },
        signal,
        ...(progress === undefined ? {} : { progress }),
        ...(collector === undefined ? {} : { timing: collector.recorder }),
      });
    };
    return collector === undefined
      ? await execute()
      : await timeIndexOperation(collector.recorder, "total", execute);
  } finally {
    if (collector !== undefined) {
      try {
        process.stderr.write(encodeIndexTimingDiagnostic(collector.snapshot()));
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
  const interrupt = installIndexInterrupt();
  try {
    return await executeIndex(source, interrupt.signal, options.progress);
  } catch (error) {
    if (isIndexInterruptedError(error) && interrupt.interruption !== undefined) {
      throw new CliSignalExit(interrupt.interruption.exitCode);
    }
    throw error;
  } finally {
    interrupt.dispose();
  }
};

const exitCode = await runCli(process.argv.slice(2), {
  version,
  output: {
    stderrIsInteractive: process.stderr.isTTY === true && process.env.TERM !== "dumb",
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  },
  doctor: async () => {
    const sources = await resolveAllSources();
    return runDoctor([
      createNodeDiagnostic(),
      createSqliteDiagnostic(),
      createIndexStateDiagnostic(resolvePaths, indexLifecycle),
      ...sources.map(createSourceDiagnostic),
    ]);
  },
  paths: async () => getPaths(resolvePaths(), indexLifecycle, await resolveAllSources()),
  indexSources: registeredSources.map(({ kind }) => kind),
  index: indexSessions,
  list: ({ filter, limit, cursor }) =>
    listSessions({
      paths: resolvePaths(),
      lifecycle: indexLifecycle,
      ...(filter === undefined ? {} : { filter }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  entries: ({ filter, selection, limit, cursor }) =>
    listSessionEntries({
      paths: resolvePaths(),
      lifecycle: indexLifecycle,
      ...(filter === undefined ? {} : { filter }),
      ...(selection === undefined ? {} : { selection }),
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  search: ({ text, termMode, filter, limit, context, cursor }) =>
    searchSessions({
      paths: resolvePaths(),
      lifecycle: indexLifecycle,
      text,
      ...(termMode === undefined ? {} : { termMode }),
      ...(filter === undefined ? {} : { filter }),
      ...(limit === undefined ? {} : { limit }),
      ...(context === undefined ? {} : { context }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  show: ({ identity, entry, context, fromEntry, toEntry }) =>
    showSession({
      paths: resolvePaths(),
      lifecycle: indexLifecycle,
      identity,
      ...(entry === undefined ? {} : { entry }),
      ...(context === undefined ? {} : { context }),
      ...(fromEntry === undefined ? {} : { fromEntry }),
      ...(toEntry === undefined ? {} : { toEntry }),
    }),
  export: ({ identity, full, fromEntry, toEntry }) =>
    exportSession({
      paths: resolvePaths(),
      lifecycle: indexLifecycle,
      identity,
      ...(full === undefined ? {} : { full }),
      ...(fromEntry === undefined ? {} : { fromEntry }),
      ...(toEntry === undefined ? {} : { toEntry }),
    }),
  forget: (identity) => forgetSession(resolvePaths(), maintenance, identity),
  clearData: () => clearData(resolvePaths(), maintenance),
  compactData: () => compactIndex(resolvePaths(), maintenance),
  repairOrphanedData: () => repairOrphanedContent(resolvePaths(), maintenance),
});

process.exitCode = exitCode;
