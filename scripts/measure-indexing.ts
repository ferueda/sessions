import assert from "node:assert/strict";
import { copyFile, chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { timeIndexOperation } from "../src/application/index-timing.ts";
import type { IndexPaths } from "../src/application/ports/index-lifecycle.ts";
import type {
  DiscoveredSession,
  SelectedSessionSource,
  SessionSource,
} from "../src/application/ports/session-source.ts";
import { runIndex } from "../src/application/run-index.ts";
import { createDiscoveredSession } from "../src/application/source-input-fingerprint.ts";
import { selectSessionSource } from "../src/application/validate-session.ts";
import { hashContent } from "../src/domain/content-hash.ts";
import {
  createSessionEntryQuery,
  createSessionListQuery,
  createSessionSearchQuery,
  type SessionEntryPage,
  type SessionListPage,
  type SessionSearchPage,
} from "../src/domain/session-query.ts";
import type {
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SourceInstance,
} from "../src/domain/session.ts";
import {
  createIndexTimingCollector,
  type IndexTimingSnapshot,
} from "../src/infrastructure/runtime/index-timings.ts";
import { resolveIndexPaths } from "../src/infrastructure/state/paths.ts";
import {
  createSqliteIndexLifecycle,
  type SqliteIndexLifecycle,
} from "../src/infrastructure/sqlite/database.ts";

const CORPUS_SESSIONS = 2_000;
const ENTRIES_PER_SESSION = 2;
const PAGE_LIMIT = 7;
const SHARED_SEARCH_TEXT = "routine indexing shared evidence";
const SOURCE: SourceInstance = Object.freeze({
  kind: "synthetic-measurement",
  instanceId: "stable-indexing",
});
const SEED_AT = "2026-07-16T12:00:00.000Z";
const STABLE_AT = "2026-07-16T13:00:00.000Z";
const WRITER_TOKEN = "index-measurement-writer";

type SqliteRow = Readonly<Record<string, unknown>>;

interface Corpus {
  readonly candidates: readonly DiscoveredSession[];
  readonly documents: ReadonlyMap<string, SessionDocument>;
}

interface MeasurementSource {
  readonly selected: SelectedSessionSource;
  readonly readCount: () => number;
}

interface SemanticState {
  readonly staticRows: readonly SqliteRow[];
  readonly writerLeaseRows: readonly SqliteRow[];
  readonly sourceRows: readonly SqliteRow[];
  readonly trackingRows: readonly SqliteRow[];
  readonly canonicalRows: readonly SqliteRow[];
  readonly relationRows: readonly SqliteRow[];
  readonly entryRows: readonly SqliteRow[];
  readonly contentRows: readonly SqliteRow[];
  readonly occurrenceRows: readonly SqliteRow[];
  readonly runRows: readonly SqliteRow[];
  readonly runItemRows: readonly SqliteRow[];
}

interface RepresentativeQueries {
  readonly list: readonly SessionListPage[];
  readonly search: readonly SessionSearchPage[];
  readonly entries: readonly SessionEntryPage[];
}

interface StableResult {
  readonly report: Awaited<ReturnType<typeof runIndex>>;
  readonly sourceReads: number;
  readonly state: SemanticState;
  readonly health: Awaited<ReturnType<SqliteIndexLifecycle["inspectHealth"]>>;
  readonly queries: RepresentativeQueries;
}

async function main(): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-index-measurement-"));
  let report: ReturnType<typeof createOutput> | undefined;
  let failure: unknown;
  let cleanupFailed = false;

  try {
    const corpus = createCorpus();
    const seedPaths = pathsAt(path.join(temporaryRoot, "seed"));
    const controlPaths = pathsAt(path.join(temporaryRoot, "control"));
    const timedPaths = pathsAt(path.join(temporaryRoot, "timed"));
    const seedLifecycle = lifecycleAt(SEED_AT);
    const seedSource = createMeasurementSource(corpus, true);
    const seedCollector = createIndexTimingCollector();

    const seedReport = await timeIndexOperation(seedCollector.recorder, "total", () =>
      runIndex({
        paths: seedPaths,
        sources: [seedSource.selected],
        lifecycle: seedLifecycle,
        clock: fixedClock(SEED_AT),
        timing: seedCollector.recorder,
      }),
    );
    const seedTiming = seedCollector.snapshot();
    assertStableCounts(seedReport, 0, CORPUS_SESSIONS);
    assert.equal(seedSource.readCount(), CORPUS_SESSIONS, "seed run did not read each session");
    assertSeedTimingOwnership(seedTiming);
    await assertCleanDatabase(seedPaths);

    await cloneDatabase(seedPaths, controlPaths);
    await cloneDatabase(seedPaths, timedPaths);
    await prepareCleanStableLibrary(controlPaths);
    await prepareCleanStableLibrary(timedPaths);
    const controlSeededState = readSemanticState(controlPaths);
    const timedSeededState = readSemanticState(timedPaths);
    assert.deepStrictEqual(
      timedSeededState,
      controlSeededState,
      "timed and control libraries differ before the stable run",
    );

    const control = await runStable(controlPaths, corpus);
    const collector = createIndexTimingCollector();
    const timed = await runStable(timedPaths, corpus, collector);
    const timing = collector.snapshot();

    assertStableCounts(control.report, CORPUS_SESSIONS, 0);
    assertStableCounts(timed.report, CORPUS_SESSIONS, 0);
    assert.equal(control.sourceReads, 0, "control stable run unexpectedly read a source document");
    assert.equal(timed.sourceReads, 0, "timed stable run unexpectedly read a source document");
    assert.deepStrictEqual(timed.report, control.report, "timing changed the index report");
    assert.deepStrictEqual(timed.state, control.state, "timing changed retained SQLite state");
    assert.deepStrictEqual(timed.health, control.health, "timing changed index health");
    assert.deepStrictEqual(timed.queries, control.queries, "timing changed query results");
    assert.equal(control.health.ok, true, "control library health is not ready");
    assertStableTransition(controlSeededState, control.state);
    assertStableTransition(timedSeededState, timed.state);
    assertRepresentativeQueries(control.queries);
    assertTimingOwnership(timing);

    report = createOutput(seedTiming, timing);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await rm(temporaryRoot, { force: true, recursive: true });
    } catch {
      cleanupFailed = true;
    }
  }

  if (failure !== undefined) {
    const suffix = cleanupFailed ? "; temporary measurement cleanup also failed" : "";
    throw new Error(`index measurement failed${suffix}`, { cause: failure });
  }
  if (cleanupFailed) throw new Error("temporary index measurement cleanup failed");
  assert(report !== undefined, "index measurement report was not produced");
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
}

async function runStable(
  paths: IndexPaths,
  corpus: Corpus,
  collector?: ReturnType<typeof createIndexTimingCollector>,
): Promise<StableResult> {
  const source = createMeasurementSource(corpus, false);
  const lifecycle = lifecycleAt(STABLE_AT);
  const run = () =>
    runIndex({
      paths,
      sources: [source.selected],
      lifecycle,
      clock: fixedClock(STABLE_AT),
      ...(collector === undefined ? {} : { timing: collector.recorder }),
    });
  const report =
    collector === undefined
      ? await run()
      : await timeIndexOperation(collector.recorder, "total", run);
  await assertCleanDatabase(paths);
  return {
    report,
    sourceReads: source.readCount(),
    state: readSemanticState(paths),
    health: await lifecycle.inspectHealth(paths),
    queries: await readRepresentativeQueries(lifecycle, paths),
  };
}

function createCorpus(): Corpus {
  const candidates: DiscoveredSession[] = [];
  const documents = new Map<string, SessionDocument>();
  for (let ordinal = 0; ordinal < CORPUS_SESSIONS; ordinal += 1) {
    const identity = identityAt(ordinal);
    const candidate = createDiscoveredSession({
      identity,
      inputs: [
        {
          role: "transcript",
          locator: { uri: `memory://index-measurement/${nativeIdAt(ordinal)}` },
          fingerprint: `revision-${nativeIdAt(ordinal)}`,
        },
      ],
      adapterVersion: "synthetic-v1",
    });
    candidates.push(candidate);
    documents.set(identity.nativeId, documentAt(ordinal));
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    documents,
  });
}

function createMeasurementSource(corpus: Corpus, allowReads: boolean): MeasurementSource {
  let reads = 0;
  const adapter: SessionSource = {
    kind: SOURCE.kind,
    async probe() {
      return {
        source: SOURCE,
        status: "ready",
        locations: [{ role: "root", locator: { uri: "memory://index-measurement" } }],
        summary: "Synthetic indexing measurement source is ready",
      };
    },
    async *discover() {
      for (const candidate of corpus.candidates) yield candidate;
    },
    async read(candidate) {
      reads += 1;
      if (!allowReads) throw new Error("stable measurement attempted a source read");
      const document = corpus.documents.get(candidate.identity.nativeId);
      if (document === undefined) throw new Error("measurement document is absent");
      return document;
    },
  };
  return {
    selected: selectSessionSource(SOURCE, adapter),
    readCount: () => reads,
  };
}

function documentAt(ordinal: number): SessionDocument {
  const identity = identityAt(ordinal);
  return {
    identity,
    title: `Index measurement ${nativeIdAt(ordinal)}`,
    workspace: "/workspace/index-measurement",
    createdAt: SEED_AT,
    updatedAt: SEED_AT,
    lineageCoverage: "complete",
    relations:
      ordinal === 0
        ? []
        : [
            {
              kind: "parent",
              target: identityAt(0),
              confidence: "high",
            },
          ],
    entries: [
      textEntry(ordinal, 0, "human", SHARED_SEARCH_TEXT),
      textEntry(ordinal, 1, "model", `Stable response ${nativeIdAt(ordinal)}`),
    ],
  };
}

function textEntry(
  sessionOrdinal: number,
  entryOrdinal: number,
  actor: SessionEntry["actor"],
  text: string,
): SessionEntry {
  return {
    ordinal: entryOrdinal,
    kind: "message",
    actor,
    timestamp: SEED_AT,
    sourceLocator: {
      uri: `memory://index-measurement/${nativeIdAt(sessionOrdinal)}/entry/${String(entryOrdinal)}`,
    },
    content: [
      {
        kind: "text",
        ordinal: 0,
        text,
        contentHash: hashContent(text),
        origin: actor === "human" ? "human" : "model",
        originConfidence: "high",
        sourceMetadata: {},
      },
    ],
  };
}

async function readRepresentativeQueries(
  lifecycle: SqliteIndexLifecycle,
  paths: IndexPaths,
): Promise<RepresentativeQueries> {
  const reader = await lifecycle.openReader(paths);
  try {
    const listFirst = await reader.query.list(createSessionListQuery({ limit: PAGE_LIMIT }));
    const listSecond = await reader.query.list(
      createSessionListQuery({ limit: PAGE_LIMIT, cursor: requireCursor(listFirst.nextCursor) }),
    );
    const searchFirst = await reader.query.search(
      createSessionSearchQuery({ text: SHARED_SEARCH_TEXT, limit: PAGE_LIMIT, context: 1 }),
    );
    const searchSecond = await reader.query.search(
      createSessionSearchQuery({
        text: SHARED_SEARCH_TEXT,
        limit: PAGE_LIMIT,
        context: 1,
        cursor: requireCursor(searchFirst.nextCursor),
      }),
    );
    const entriesFirst = await reader.query.entries(
      createSessionEntryQuery({
        filter: { actor: "human" },
        selection: "first",
        limit: PAGE_LIMIT,
      }),
    );
    const entriesSecond = await reader.query.entries(
      createSessionEntryQuery({
        filter: { actor: "human" },
        selection: "first",
        limit: PAGE_LIMIT,
        cursor: requireCursor(entriesFirst.nextCursor),
      }),
    );
    return {
      list: [listFirst, listSecond],
      search: [searchFirst, searchSecond],
      entries: [entriesFirst, entriesSecond],
    };
  } finally {
    await reader.close();
  }
}

function assertRepresentativeQueries(queries: RepresentativeQueries): void {
  assert.equal(queries.list.length, 2);
  assert.equal(queries.search.length, 2);
  assert.equal(queries.entries.length, 2);
  for (const page of queries.list) {
    assert.equal(page.sessions.length, PAGE_LIMIT, "list measurement page is incomplete");
    assert(
      page.sessions.every(({ root }) => root.kind === "known"),
      "list lineage is unknown",
    );
  }
  for (const page of queries.search) {
    assert.equal(page.hits.length, PAGE_LIMIT, "search measurement page is incomplete");
    assert.deepStrictEqual(page.support, {
      occurrences: CORPUS_SESSIONS,
      uniqueContent: 1,
      uniqueKnownRoots: 1,
      unknownLineageSessions: 0,
    });
    assert(
      page.hits.every(({ root }) => root.kind === "known"),
      "search lineage is unknown",
    );
  }
  for (const page of queries.entries) {
    assert.equal(page.entries.length, PAGE_LIMIT, "entry measurement page is incomplete");
    assert(
      page.entries.every(({ root }) => root.kind === "known"),
      "entry lineage is unknown",
    );
  }
}

function assertStableCounts(
  report: Awaited<ReturnType<typeof runIndex>>,
  unchanged: number,
  updated: number,
): void {
  assert.deepStrictEqual(report.counts, {
    discovered: CORPUS_SESSIONS,
    unchanged,
    updated,
    failed: 0,
    missing: 0,
    stale: 0,
  });
  assert.equal(report.incompleteSources, 0);
  assert(
    report.sources.every(
      ({ status, coverage }) => status === "completed" && coverage.status === "complete",
    ),
    "index report coverage is incomplete",
  );
}

function assertStableTransition(before: SemanticState, after: SemanticState): void {
  assert.deepStrictEqual(after.staticRows, before.staticRows, "static library state changed");
  assert.deepStrictEqual(after.canonicalRows, before.canonicalRows, "canonical sessions changed");
  assert.deepStrictEqual(after.relationRows, before.relationRows, "canonical lineage changed");
  assert.deepStrictEqual(after.entryRows, before.entryRows, "canonical entries changed");
  assert.deepStrictEqual(after.contentRows, before.contentRows, "canonical content changed");
  assert.deepStrictEqual(
    after.occurrenceRows,
    before.occurrenceRows,
    "canonical occurrences changed",
  );
  assert.equal(after.sourceRows.length, before.sourceRows.length, "source row count changed");
  for (const [index, source] of after.sourceRows.entries()) {
    const seeded = before.sourceRows[index];
    assert(seeded !== undefined, "seeded source row is absent");
    assert.deepStrictEqual(
      withoutKeys(source, ["coverage_observed_at"]),
      withoutKeys(seeded, ["coverage_observed_at"]),
      "source state changed outside its observation time",
    );
    assert.equal(seeded.coverage_observed_at, SEED_AT);
    assert.equal(source.coverage_observed_at, STABLE_AT);
  }

  assert.equal(after.trackingRows.length, before.trackingRows.length, "tracking row count changed");
  for (const [index, tracking] of after.trackingRows.entries()) {
    const seeded = before.trackingRows[index];
    assert(seeded !== undefined, "seeded tracking row is absent");
    assert.deepStrictEqual(
      withoutKeys(tracking, ["latest_outcome", "presence_observed_at", "last_seen_at"]),
      withoutKeys(seeded, ["latest_outcome", "presence_observed_at", "last_seen_at"]),
      "tracking changed outside the stable observation transition",
    );
    assert.equal(seeded.latest_outcome, "indexed");
    assert.equal(tracking.latest_outcome, "unchanged");
    assert.equal(seeded.presence_observed_at, SEED_AT);
    assert.equal(seeded.last_seen_at, SEED_AT);
    assert.equal(tracking.presence_observed_at, STABLE_AT);
    assert.equal(tracking.last_seen_at, STABLE_AT);
    assert.equal(tracking.captured_at, SEED_AT);
  }

  assert.deepStrictEqual(
    after.runRows.slice(0, before.runRows.length),
    before.runRows,
    "seed index run changed",
  );
  assert.equal(after.runRows.length, before.runRows.length + 1, "stable run was not appended once");
  const stableRun = after.runRows.at(-1);
  assert(stableRun !== undefined, "stable run row is absent");
  assert.deepStrictEqual(
    {
      status: stableRun.status,
      started_at: stableRun.started_at,
      finished_at: stableRun.finished_at,
      failure_code: stableRun.failure_code,
      discovered_count: stableRun.discovered_count,
      unchanged_count: stableRun.unchanged_count,
      indexed_count: stableRun.indexed_count,
      failed_count: stableRun.failed_count,
      missing_count: stableRun.missing_count,
      stale_count: stableRun.stale_count,
      omitted_item_count: stableRun.omitted_item_count,
    },
    {
      status: "completed",
      started_at: STABLE_AT,
      finished_at: STABLE_AT,
      failure_code: null,
      discovered_count: CORPUS_SESSIONS,
      unchanged_count: CORPUS_SESSIONS,
      indexed_count: 0,
      failed_count: 0,
      missing_count: 0,
      stale_count: 0,
      omitted_item_count: 0,
    },
    "stable run bookkeeping is incorrect",
  );
  assert.deepStrictEqual(after.runItemRows, before.runItemRows, "stable run added failure items");

  const priorLease = singleRow(before.writerLeaseRows, "prior writer lease");
  const stableLease = singleRow(after.writerLeaseRows, "stable writer lease");
  assert.equal(stableLease.generation, Number(priorLease.generation) + 1);
  assert.equal(stableLease.clean_generation, stableLease.generation);
  assert.equal(stableLease.clean_schema_cookie, priorLease.clean_schema_cookie);
  assert.deepStrictEqual(
    withoutKeys(stableLease, ["generation", "clean_generation"]),
    withoutKeys(priorLease, ["generation", "clean_generation"]),
    "stable run changed writer integrity state outside its clean generation",
  );
}

function assertTimingOwnership(snapshot: IndexTimingSnapshot): void {
  const calls = Object.fromEntries(
    Object.entries(snapshot.phases).map(([phase, aggregate]) => [phase, aggregate.calls]),
  );
  assert.deepStrictEqual(calls, {
    sourceResolution: 0,
    writerOpen: 1,
    sourceProbe: 1,
    sourceDiscovery: 1,
    freshnessRead: CORPUS_SESSIONS,
    unchangedWrite: CORPUS_SESSIONS,
    changedReadAndNormalize: 0,
    replacement: 0,
    reconciliation: 1,
    runBookkeeping: 2,
    writerClose: 1,
    total: 1,
  });
  assert(snapshot.phases.total.elapsedMs > 0, "total timing did not advance");
}

function assertSeedTimingOwnership(snapshot: IndexTimingSnapshot): void {
  const calls = Object.fromEntries(
    Object.entries(snapshot.phases).map(([phase, aggregate]) => [phase, aggregate.calls]),
  );
  assert.deepStrictEqual(calls, {
    sourceResolution: 0,
    writerOpen: 1,
    sourceProbe: 1,
    sourceDiscovery: 1,
    freshnessRead: CORPUS_SESSIONS,
    unchangedWrite: 0,
    changedReadAndNormalize: CORPUS_SESSIONS,
    replacement: CORPUS_SESSIONS,
    reconciliation: 1,
    runBookkeeping: 2,
    writerClose: 1,
    total: 1,
  });
  assert(snapshot.phases.total.elapsedMs > 0, "seed total timing did not advance");
}

function readSemanticState(paths: IndexPaths): SemanticState {
  const database = openImmutableDatabase(paths.database);
  try {
    return {
      staticRows: [
        ...rows(database, "SELECT * FROM sessions_schema_migrations ORDER BY version"),
        ...rows(database, "SELECT * FROM sessions_library ORDER BY singleton"),
      ],
      writerLeaseRows: rows(database, "SELECT * FROM sessions_writer_lease ORDER BY singleton"),
      sourceRows: rows(
        database,
        "SELECT * FROM sessions_source_instances ORDER BY source_instance_id",
      ),
      trackingRows: rows(database, "SELECT * FROM sessions_session_tracking ORDER BY session_id"),
      canonicalRows: rows(
        database,
        "SELECT * FROM sessions_canonical_sessions ORDER BY session_id",
      ),
      relationRows: rows(database, "SELECT * FROM sessions_relations ORDER BY session_id, ordinal"),
      entryRows: rows(database, "SELECT * FROM sessions_entries ORDER BY session_id, ordinal"),
      contentRows: rows(database, "SELECT * FROM sessions_content_values ORDER BY content_id"),
      occurrenceRows: rows(
        database,
        `SELECT * FROM sessions_content_occurrences
         ORDER BY session_id, entry_ordinal, segment_ordinal`,
      ),
      runRows: rows(database, "SELECT * FROM sessions_index_runs ORDER BY run_id"),
      runItemRows: rows(
        database,
        "SELECT * FROM sessions_index_run_items ORDER BY run_id, ordinal",
      ),
    };
  } finally {
    database.close();
  }
}

function rows(database: DatabaseSync, sql: string): readonly SqliteRow[] {
  return database.prepare(sql).all() as readonly SqliteRow[];
}

function openImmutableDatabase(databasePath: string): DatabaseSync {
  const url = pathToFileURL(databasePath);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  return new DatabaseSync(url.href, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
  });
}

async function cloneDatabase(source: IndexPaths, target: IndexPaths): Promise<void> {
  await mkdir(target.directory, { mode: 0o700 });
  await copyFile(source.database, target.database);
  await chmod(target.database, 0o600);
}

async function prepareCleanStableLibrary(paths: IndexPaths): Promise<void> {
  const writer = await lifecycleAt(SEED_AT).openWriter(paths);
  await writer.close();
  await assertCleanDatabase(paths);
}

async function assertCleanDatabase(paths: IndexPaths): Promise<void> {
  const sidecars = await Promise.all([exists(paths.wal), exists(paths.shm), exists(paths.scratch)]);
  assert.deepStrictEqual(sidecars, [false, false, false], "measurement library retained sidecars");
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function pathsAt(directory: string): IndexPaths {
  return resolveIndexPaths({
    platform: process.platform,
    env: { SESSIONS_DATA_DIR: directory },
    homeDirectory: temporaryHome(),
  });
}

function lifecycleAt(timestamp: string): SqliteIndexLifecycle {
  return createSqliteIndexLifecycle({
    now: () => new Date(timestamp),
    writerToken: () => WRITER_TOKEN,
  });
}

function fixedClock(timestamp: string): { readonly now: () => Date } {
  return { now: () => new Date(timestamp) };
}

function identityAt(ordinal: number): SessionIdentity {
  return { source: SOURCE, nativeId: nativeIdAt(ordinal) };
}

function nativeIdAt(ordinal: number): string {
  return `session-${String(ordinal).padStart(4, "0")}`;
}

function requireCursor(cursor: string | undefined): string {
  assert(cursor !== undefined, "measurement first page has no continuation cursor");
  return cursor;
}

function withoutKeys(row: SqliteRow, keys: readonly string[]): SqliteRow {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(row).filter(([key]) => !omitted.has(key)));
}

function singleRow(rows: readonly SqliteRow[], label: string): SqliteRow {
  assert.equal(rows.length, 1, `${label} is not singular`);
  return rows[0]!;
}

function temporaryHome(): string {
  return process.platform === "win32" ? "C:\\sessions-measurement" : "/sessions-measurement";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function createOutput(seedTiming: IndexTimingSnapshot, timing: IndexTimingSnapshot) {
  return {
    corpus: {
      sessions: CORPUS_SESSIONS,
      entriesPerSession: ENTRIES_PER_SESSION,
      entries: CORPUS_SESSIONS * ENTRIES_PER_SESSION,
      relations: CORPUS_SESSIONS - 1,
    },
    equality: {
      reports: true,
      canonicalState: true,
      trackingAndRuns: true,
      writerIntegrityState: true,
      health: true,
      pagedListSearchEntries: true,
      supportAndLineage: true,
      stableTransition: true,
      zeroStableSourceReads: true,
    },
    seedTimings: seedTiming.phases,
    timings: timing.phases,
  };
}

await main();
