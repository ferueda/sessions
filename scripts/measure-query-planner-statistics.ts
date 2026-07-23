import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { createDiscoveredSession } from "../src/application/source-input-fingerprint.ts";
import type { SessionQueryRepository } from "../src/application/ports/session-query.ts";
import {
  admitSessionObservation,
  admitSessionReplacement,
  type ValidatedSessionReplacement,
} from "../src/application/validate-session.ts";
import { hashContent } from "../src/domain/content-hash.ts";
import { createSessionManifestQuery } from "../src/domain/session-manifest.ts";
import {
  createSessionEntryQuery,
  createSessionListQuery,
  createSessionSearchQuery,
} from "../src/domain/session-query.ts";
import type {
  ContentOrigin,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SourceInstance,
} from "../src/domain/session.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
} from "../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../src/infrastructure/sqlite/sqlite-session-index.ts";
import { buildSqliteEntryCoordinateStatement } from "../src/infrastructure/sqlite/sqlite-session-entry-query.ts";
import { createSqliteSessionQuery } from "../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../src/infrastructure/sqlite/writer-lease.ts";
import { initializeWriterRecoveryReceipt } from "../src/infrastructure/sqlite/writer-recovery-receipt.ts";

const CONTRACT_MODE = process.argv.includes("--contract");
const CORPUS_SESSIONS = CONTRACT_MODE ? 24 : 600;
const HEAVY_SESSION_ENTRIES = CONTRACT_MODE ? 50 : 2_000;
const REGULAR_SESSION_ENTRIES = 3;
const TIMING_ROUNDS = CONTRACT_MODE ? 2 : 5;
const PAGE_LIMIT = 10;
const SOURCE: SourceInstance = Object.freeze({
  kind: "synthetic-measurement",
  instanceId: "planner-statistics",
});
const CAPTURED_AT = "2026-07-15T12:00:00.000Z";
const RELEASED_AT = "2026-07-15T12:02:00.000Z";
const OLD_ACTIVITY = "2026-07-14T12:00:00.000Z";
const RECENT_ACTIVITY = "2026-07-15T12:00:00.000Z";
const VARIANT_NAMES = ["control", "analyze", "optimize"] as const;
const PLAN_CASES = createPlanCases();
const tempRoot = await mkdtemp(path.join(tmpdir(), "sessions-query-planner-statistics-"));
await chmod(tempRoot, 0o700);

let report: MeasurementReport | undefined;
try {
  report = await runMeasurement(tempRoot);
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}
await assertRemoved(tempRoot);
assert(report !== undefined, "planner-statistics measurement did not produce a report");
process.stdout.write(`${JSON.stringify({ ...report, temporaryCleanup: true })}\n`);

async function runMeasurement(root: string): Promise<MeasurementReport> {
  const basePath = path.join(root, "base.sqlite");
  await createBaseDatabase(basePath);
  await assertNoSidecars(basePath);

  const variantPaths = {
    control: path.join(root, "control.sqlite"),
    analyze: path.join(root, "analyze.sqlite"),
    optimize: path.join(root, "optimize.sqlite"),
  } as const;
  const baseDigest = await fileDigest(basePath);
  for (const variantPath of Object.values(variantPaths)) {
    await copyFile(basePath, variantPath);
    await chmod(variantPath, 0o600);
    assert.equal(await fileDigest(variantPath), baseDigest, "database clone was not exact");
  }

  const beforeBytes = await fileBytes(basePath);
  const mutationReports = {
    control: await inspectVariant(variantPaths.control, "none", 0, beforeBytes),
    analyze: await mutateAndInspect(
      variantPaths.analyze,
      "ANALYZE",
      (database) => database.exec("ANALYZE"),
      beforeBytes,
    ),
    optimize: await mutateAndInspect(
      variantPaths.optimize,
      "PRAGMA optimize = 0x10002",
      (database) => {
        database.prepare("PRAGMA optimize = 0x10002").all();
      },
      beforeBytes,
    ),
  } satisfies Record<VariantName, VariantReport>;

  const handles = Object.fromEntries(
    VARIANT_NAMES.map((name) => [name, openReadDatabase(variantPaths[name])]),
  ) as unknown as Record<VariantName, DatabaseSync>;
  try {
    const repositories = Object.fromEntries(
      VARIANT_NAMES.map((name) => [name, createSqliteSessionQuery(handles[name])]),
    ) as unknown as Record<VariantName, SessionQueryRepository>;
    const cases = await measureCases(handles, repositories);
    return {
      schemaVersion: 1,
      mode: CONTRACT_MODE ? "contract" : "full",
      corpus: {
        sessions: CORPUS_SESSIONS,
        entries: corpusEntryCount(),
        heavySessionEntries: HEAVY_SESSION_ENTRIES,
        regularSessionEntries: REGULAR_SESSION_ENTRIES,
      },
      clonesVerifiedExact: true,
      timingRounds: TIMING_ROUNDS,
      variants: mutationReports,
      cases,
      semanticEquality: Object.values(cases).every((measurement) => measurement.semanticEqual),
    };
  } finally {
    for (const database of Object.values(handles)) database.close();
  }
}

async function createBaseDatabase(file: string): Promise<void> {
  const database = openWriteDatabase(file);
  try {
    applyMigrations(database);
    await seedCorpus(database);
    database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    database.close();
  }
  await chmod(file, 0o600);
}

async function seedCorpus(database: DatabaseSync): Promise<void> {
  const now = () => new Date(CAPTURED_AT);
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "planner-statistics-writer",
  });
  initializeWriterRecoveryReceipt(database, lease, {
    now,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
  });
  try {
    const index = createCoordinatedSqliteSessionIndex(database, {
      lease,
      now,
      schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
    });
    const run = await index.startRun({ source: SOURCE, startedAt: CAPTURED_AT });
    for (let ordinal = 0; ordinal < CORPUS_SESSIONS; ordinal += 1) {
      await index.replaceSession(run, replacement(ordinal));
    }
    const result = await index.finishRun(run, {
      status: "completed",
      finishedAt: "2026-07-15T12:01:00.000Z",
    });
    assert.deepStrictEqual(result.counts, {
      discovered: CORPUS_SESSIONS,
      unchanged: 0,
      updated: CORPUS_SESSIONS,
      failed: 0,
      missing: 0,
      stale: 0,
    });
  } finally {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: () => new Date(RELEASED_AT),
    });
  }
}

function replacement(ordinal: number): ValidatedSessionReplacement {
  const identity = identityAt(ordinal);
  const nativeId = identity.nativeId;
  const candidate = createDiscoveredSession({
    identity,
    inputs: [
      {
        role: "transcript",
        locator: { uri: `memory://planner-statistics/${nativeId}` },
        fingerprint: `revision-${nativeId}`,
      },
    ],
    adapterVersion: "synthetic-v1",
  });
  const observation = admitSessionObservation(candidate);
  assert(observation.ok, "measurement observation was rejected");
  const admitted = admitSessionReplacement(observation.observation, documentAt(ordinal));
  assert(admitted.ok, "measurement document was rejected");
  return admitted.replacement;
}

function documentAt(sessionOrdinal: number): SessionDocument {
  const identity = identityAt(sessionOrdinal);
  const entryCount = sessionOrdinal === 0 ? HEAVY_SESSION_ENTRIES : REGULAR_SESSION_ENTRIES;
  return {
    identity,
    title: `Planner measurement ${identity.nativeId}`,
    workspace:
      sessionOrdinal % 10 === 0 ? "/generic/workspace/recent" : "/generic/workspace/common",
    createdAt: OLD_ACTIVITY,
    updatedAt: activityAt(sessionOrdinal),
    lineageCoverage: "complete",
    relations: [],
    entries: Array.from({ length: entryCount }, (_, entryOrdinal) =>
      entryAt(sessionOrdinal, entryOrdinal, entryCount),
    ),
  };
}

function entryAt(sessionOrdinal: number, entryOrdinal: number, entryCount: number): SessionEntry {
  const actor = actorAt(entryOrdinal);
  const origin = originAt(actor);
  const text = contentAt(sessionOrdinal, entryOrdinal, entryCount);
  return {
    ordinal: entryOrdinal,
    kind: "message",
    actor,
    timestamp: activityAt(sessionOrdinal),
    sourceLocator: {
      uri: `memory://planner-statistics/${nativeIdAt(sessionOrdinal)}/entry/${String(entryOrdinal)}`,
    },
    content: [
      {
        kind: "text",
        ordinal: 0,
        text,
        contentHash: hashContent(text),
        origin,
        originConfidence: "high",
        sourceMetadata: {},
      },
    ],
  };
}

function contentAt(sessionOrdinal: number, entryOrdinal: number, entryCount: number): string {
  const alternate = (sessionOrdinal + entryOrdinal) % 2 === 0 ? "alternateeven" : "alternateodd";
  const rare = sessionOrdinal === 0 && entryOrdinal === entryCount - 1 ? " rare marker" : "";
  return `common evidence ${alternate} generic session ${String(sessionOrdinal)} entry ${String(entryOrdinal)}${rare}`;
}

function actorAt(entryOrdinal: number): SessionEntry["actor"] {
  if (entryOrdinal % 3 === 0) return "human";
  if (entryOrdinal % 3 === 1) return "model";
  return "tool";
}

function originAt(actor: SessionEntry["actor"]): ContentOrigin {
  if (actor === "human" || actor === "model" || actor === "tool") return actor;
  return "unknown";
}

function activityAt(sessionOrdinal: number): string {
  return sessionOrdinal >= Math.floor(CORPUS_SESSIONS * 0.9) ? RECENT_ACTIVITY : OLD_ACTIVITY;
}

function identityAt(ordinal: number): SessionIdentity {
  return { source: SOURCE, nativeId: nativeIdAt(ordinal) };
}

function nativeIdAt(ordinal: number): string {
  return `session-${String(ordinal).padStart(5, "0")}`;
}

function corpusEntryCount(): number {
  return HEAVY_SESSION_ENTRIES + (CORPUS_SESSIONS - 1) * REGULAR_SESSION_ENTRIES;
}

async function mutateAndInspect(
  file: string,
  command: string,
  mutate: (database: DatabaseSync) => void,
  beforeBytes: number,
): Promise<VariantReport> {
  const database = openWriteDatabase(file);
  const startedAt = performance.now();
  try {
    mutate(database);
    database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    database.close();
  }
  const applyElapsedMs = roundMilliseconds(performance.now() - startedAt);
  await assertNoSidecars(file);
  return inspectVariant(file, command, applyElapsedMs, beforeBytes);
}

async function inspectVariant(
  file: string,
  command: string,
  applyElapsedMs: number,
  beforeBytes: number,
): Promise<VariantReport> {
  const database = openReadDatabase(file);
  try {
    const databaseBytes = await fileBytes(file);
    return {
      statisticsCommand: command,
      applyElapsedMs,
      databaseBytes,
      databaseByteGrowth: databaseBytes - beforeBytes,
      statistics: readStatistics(database),
    };
  } finally {
    database.close();
  }
}

function readStatistics(database: DatabaseSync): StatisticsReport {
  const tables = database
    .prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type = 'table' AND name GLOB 'sqlite_stat*'
       ORDER BY name`,
    )
    .all() as unknown as readonly { readonly name: unknown }[];
  return {
    tables: tables.map((row) => {
      if (typeof row.name !== "string") {
        throw new TypeError("statistics table name was not text");
      }
      const name = row.name;
      assert(/^sqlite_stat[1-9][0-9]*$/u.test(name), "unexpected statistics table name");
      const rows = database.prepare(`SELECT * FROM ${name}`).all() as unknown as readonly Record<
        string,
        unknown
      >[];
      return {
        name,
        rows: rows.length,
        payloadBytes: rows.reduce<number>(
          (total, statisticsRow) =>
            total +
            Object.values(statisticsRow).reduce<number>(
              (rowTotal, value) => rowTotal + sqliteValueBytes(value),
              0,
            ),
          0,
        ),
      };
    }),
  };
}

function sqliteValueBytes(value: unknown): number {
  if (value === null) return 0;
  if (typeof value === "string") return Buffer.byteLength(value);
  if (typeof value === "number" || typeof value === "bigint") {
    return Buffer.byteLength(String(value));
  }
  if (value instanceof Uint8Array) return value.byteLength;
  throw new TypeError("statistics table contained an unsupported SQLite value");
}

async function measureCases(
  databases: Record<VariantName, DatabaseSync>,
  repositories: Record<VariantName, SessionQueryRepository>,
): Promise<Record<string, CaseReport>> {
  const result: Record<string, CaseReport> = {};
  for (const measurementCase of createQueryCases()) {
    const expected = await measurementCase.run(repositories.control);
    const resultCount = countResult(expected);
    for (const name of VARIANT_NAMES) {
      const actual = await measurementCase.run(repositories[name]);
      assert.deepStrictEqual(
        actual,
        expected,
        `${measurementCase.name} changed under ${name} statistics`,
      );
    }

    const samples = Object.fromEntries(
      VARIANT_NAMES.map((name) => [name, [] as number[]]),
    ) as unknown as Record<VariantName, number[]>;
    for (let round = 0; round < TIMING_ROUNDS; round += 1) {
      for (const name of rotateVariants(round)) {
        const startedAt = performance.now();
        const actual = await measurementCase.run(repositories[name]);
        samples[name].push(roundMilliseconds(performance.now() - startedAt));
        assert.deepStrictEqual(
          actual,
          expected,
          `${measurementCase.name} changed during ${name} timing`,
        );
      }
    }

    const plans = Object.fromEntries(
      VARIANT_NAMES.map((name) => [
        name,
        normalizedPlan(databases[name], PLAN_CASES[measurementCase.name]),
      ]),
    ) as unknown as Record<VariantName, readonly string[]>;
    result[measurementCase.name] = {
      semanticEqual: true,
      resultCount,
      elapsedMs: Object.fromEntries(
        VARIANT_NAMES.map((name) => [name, summarize(samples[name])]),
      ) as unknown as Record<VariantName, ElapsedAggregate>,
      plans,
      planChanged: {
        analyze: !samePlan(plans.control, plans.analyze),
        optimize: !samePlan(plans.control, plans.optimize),
      },
    };
  }
  return result;
}

function createQueryCases(): readonly QueryCase[] {
  const heavySession = identityAt(0);
  return [
    {
      name: "entries-broad",
      run: (repository) =>
        repository.entries(createSessionEntryQuery({ selection: "all", limit: PAGE_LIMIT })),
    },
    {
      name: "entries-narrow",
      run: (repository) =>
        repository.entries(
          createSessionEntryQuery({
            filter: { session: heavySession, actor: "model" },
            selection: "all",
            limit: PAGE_LIMIT,
          }),
        ),
    },
    {
      name: "list-identity",
      run: (repository) =>
        repository.list(
          createSessionListQuery({ filter: { session: heavySession }, limit: PAGE_LIMIT }),
        ),
    },
    {
      name: "list-activity",
      run: (repository) =>
        repository.list(
          createSessionListQuery({
            filter: { activityAfter: "2026-07-14T23:59:59.999Z" },
            limit: PAGE_LIMIT,
          }),
        ),
    },
    {
      name: "search-broad-all",
      run: (repository) =>
        repository.search(
          createSessionSearchQuery({
            text: "common evidence",
            termMode: "all",
            limit: PAGE_LIMIT,
            context: 0,
          }),
        ),
    },
    {
      name: "search-selective-all",
      run: (repository) =>
        repository.search(
          createSessionSearchQuery({
            text: "rare marker",
            termMode: "all",
            limit: PAGE_LIMIT,
            context: 0,
          }),
        ),
    },
    {
      name: "search-broad-any",
      run: (repository) =>
        repository.search(
          createSessionSearchQuery({
            text: "alternateeven alternateodd",
            termMode: "any",
            limit: PAGE_LIMIT,
            context: 0,
          }),
        ),
    },
    {
      name: "search-selective-any",
      run: (repository) =>
        repository.search(
          createSessionSearchQuery({
            text: "rare unavailable",
            termMode: "any",
            limit: PAGE_LIMIT,
            context: 0,
          }),
        ),
    },
    {
      name: "manifest",
      run: (repository) => repository.manifest(createSessionManifestQuery()),
    },
  ];
}

function countResult(result: unknown): number {
  if (typeof result !== "object" || result === null) {
    throw new TypeError("query measurement result was not an object");
  }
  for (const key of ["entries", "sessions", "hits", "revisions"] as const) {
    if (key in result) {
      const value = (result as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value.length;
    }
  }
  throw new TypeError("query measurement result had no counted collection");
}

function createPlanCases(): Readonly<Record<string, PlanCase>> {
  const identityParameters = [SOURCE.kind, SOURCE.instanceId, nativeIdAt(0)] as const;
  const broadEntries = buildSqliteEntryCoordinateStatement(
    createSessionEntryQuery({ selection: "all", limit: PAGE_LIMIT }),
    { kind: "first" },
  );
  const narrowEntries = buildSqliteEntryCoordinateStatement(
    createSessionEntryQuery({
      filter: { session: identityAt(0), actor: "model" },
      selection: "all",
      limit: PAGE_LIMIT,
    }),
    { kind: "first" },
  );
  const listSql = `SELECT source.kind, source.instance_id, tracking.native_id
    FROM sessions_canonical_sessions AS canonical
    JOIN sessions_session_tracking AS tracking
      ON tracking.session_id = canonical.session_id
    JOIN sessions_source_instances AS source
      ON source.source_instance_id = tracking.source_instance_id
    WHERE 1 = 1%s
    ORDER BY CASE WHEN COALESCE(canonical.updated_at, canonical.created_at) IS NULL THEN 1 ELSE 0 END,
             COALESCE(canonical.updated_at, canonical.created_at) DESC,
             source.kind COLLATE BINARY,
             source.instance_id COLLATE BINARY,
             tracking.native_id COLLATE BINARY
    LIMIT ?`;
  const searchSql = `SELECT canonical.session_id, entry.ordinal
    FROM sessions_content_fts
    JOIN sessions_content_values AS content
      ON content.content_id = sessions_content_fts.rowid
    JOIN sessions_content_occurrences AS occurrence
      ON occurrence.content_id = content.content_id
    JOIN sessions_entries AS entry
      ON entry.session_id = occurrence.session_id
     AND entry.ordinal = occurrence.entry_ordinal
    JOIN sessions_canonical_sessions AS canonical
      ON canonical.session_id = entry.session_id
    JOIN sessions_session_tracking AS tracking
      ON tracking.session_id = canonical.session_id
    JOIN sessions_source_instances AS source
      ON source.source_instance_id = tracking.source_instance_id
    WHERE sessions_content_fts MATCH ?
    ORDER BY canonical.session_id, entry.ordinal
    LIMIT ?`;
  const manifestSql = `WITH cohort AS (
      SELECT canonical.session_id
      FROM sessions_canonical_sessions AS canonical
      JOIN sessions_session_tracking AS tracking
        ON tracking.session_id = canonical.session_id
      JOIN sessions_source_instances AS source
        ON source.source_instance_id = tracking.source_instance_id
      ORDER BY source.kind COLLATE BINARY,
               source.instance_id COLLATE BINARY,
               tracking.native_id COLLATE BINARY
      LIMIT ?
    )
    SELECT canonical.session_id
    FROM cohort
    JOIN sessions_canonical_sessions AS canonical
      ON canonical.session_id = cohort.session_id
    JOIN sessions_session_tracking AS tracking
      ON tracking.session_id = canonical.session_id
    LEFT JOIN sessions_canonical_document_metrics AS metrics
      ON metrics.session_id = canonical.session_id
    ORDER BY canonical.session_id`;

  return {
    "entries-broad": broadEntries,
    "entries-narrow": {
      sql: narrowEntries.sql,
      parameters: narrowEntries.parameters,
    },
    "list-identity": {
      sql: listSql.replace(
        "%s",
        " AND source.kind = ? AND source.instance_id = ? AND tracking.native_id = ?",
      ),
      parameters: [...identityParameters, PAGE_LIMIT],
    },
    "list-activity": {
      sql: listSql.replace("%s", " AND COALESCE(canonical.updated_at, canonical.created_at) > ?"),
      parameters: ["2026-07-14T23:59:59.999Z", PAGE_LIMIT],
    },
    "search-broad-all": {
      sql: searchSql,
      parameters: ['"common" "evidence"', PAGE_LIMIT],
    },
    "search-selective-all": {
      sql: searchSql,
      parameters: ['"rare" "marker"', PAGE_LIMIT],
    },
    "search-broad-any": {
      sql: searchSql,
      parameters: ['"alternateeven" OR "alternateodd"', PAGE_LIMIT],
    },
    "search-selective-any": {
      sql: searchSql,
      parameters: ['"rare" OR "unavailable"', PAGE_LIMIT],
    },
    manifest: {
      sql: manifestSql,
      parameters: [10_001],
    },
  };
}

function normalizedPlan(database: DatabaseSync, planCase: PlanCase | undefined): readonly string[] {
  assert(planCase !== undefined, "query case has no representative plan");
  const rows = database
    .prepare(`EXPLAIN QUERY PLAN ${planCase.sql}`)
    .all(...planCase.parameters) as unknown as readonly { readonly detail: unknown }[];
  return rows.map((row) => {
    if (typeof row.detail !== "string") throw new TypeError("query-plan detail was not text");
    return row.detail
      .replace(/\b[0-9]+\b/gu, "?")
      .replace(/\s+/gu, " ")
      .trim();
  });
}

function rotateVariants(round: number): readonly VariantName[] {
  const offset = round % VARIANT_NAMES.length;
  return [...VARIANT_NAMES.slice(offset), ...VARIANT_NAMES.slice(0, offset)];
}

function summarize(values: readonly number[]): ElapsedAggregate {
  assert(values.length > 0, "elapsed aggregate was empty");
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index]!;
}

function samePlan(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((detail, index) => detail === right[index]);
}

function openWriteDatabase(file: string): DatabaseSync {
  const database = new DatabaseSync(file, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 1_000,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  return database;
}

function openReadDatabase(file: string): DatabaseSync {
  const database = new DatabaseSync(file, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 1_000,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  return database;
}

async function assertNoSidecars(file: string): Promise<void> {
  for (const suffix of ["-wal", "-shm"] as const) {
    try {
      await lstat(`${file}${suffix}`);
      assert.fail(`closed measurement database retained a ${suffix} sidecar`);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
  }
}

async function assertRemoved(file: string): Promise<void> {
  try {
    await lstat(file);
    assert.fail("measurement temporary root was not removed");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

async function fileDigest(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function fileBytes(file: string): Promise<number> {
  return (await stat(file)).size;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

type VariantName = (typeof VARIANT_NAMES)[number];

interface VariantReport {
  readonly statisticsCommand: string;
  readonly applyElapsedMs: number;
  readonly databaseBytes: number;
  readonly databaseByteGrowth: number;
  readonly statistics: StatisticsReport;
}

interface StatisticsReport {
  readonly tables: readonly {
    readonly name: string;
    readonly rows: number;
    readonly payloadBytes: number;
  }[];
}

interface ElapsedAggregate {
  readonly samples: readonly number[];
  readonly median: number;
  readonly p95: number;
}

interface CaseReport {
  readonly semanticEqual: boolean;
  readonly resultCount: number;
  readonly elapsedMs: Record<VariantName, ElapsedAggregate>;
  readonly plans: Record<VariantName, readonly string[]>;
  readonly planChanged: {
    readonly analyze: boolean;
    readonly optimize: boolean;
  };
}

interface MeasurementReport {
  readonly schemaVersion: 1;
  readonly mode: "contract" | "full";
  readonly corpus: {
    readonly sessions: number;
    readonly entries: number;
    readonly heavySessionEntries: number;
    readonly regularSessionEntries: number;
  };
  readonly clonesVerifiedExact: boolean;
  readonly timingRounds: number;
  readonly variants: Record<VariantName, VariantReport>;
  readonly cases: Record<string, CaseReport>;
  readonly semanticEquality: boolean;
}

interface QueryCase {
  readonly name:
    | "entries-broad"
    | "entries-narrow"
    | "list-identity"
    | "list-activity"
    | "search-broad-all"
    | "search-selective-all"
    | "search-broad-any"
    | "search-selective-any"
    | "manifest";
  readonly run: (repository: SessionQueryRepository) => Promise<unknown>;
}

interface PlanCase {
  readonly sql: string;
  readonly parameters: readonly (string | number)[];
}
