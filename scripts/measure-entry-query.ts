import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { createDiscoveredSession } from "../src/application/source-input-fingerprint.ts";
import {
  admitSessionObservation,
  admitSessionReplacement,
  type ValidatedSessionReplacement,
} from "../src/application/validate-session.ts";
import { hashContent } from "../src/domain/content-hash.ts";
import {
  createSessionEntryQuery,
  type SessionEntryPage,
  type SessionEntryQuery,
} from "../src/domain/session-query.ts";
import type {
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SourceInstance,
} from "../src/domain/session.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
} from "../src/infrastructure/sqlite/migrations.ts";
import {
  buildSqliteEntryCoordinateStatement,
  listSqliteSessionEntries,
  type SqliteEntryCoordinatePosition,
  type SqliteEntryQueryWork,
} from "../src/infrastructure/sqlite/sqlite-session-entry-query.ts";
import { createCoordinatedSqliteSessionIndex } from "../src/infrastructure/sqlite/sqlite-session-index.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../src/infrastructure/sqlite/writer-lease.ts";
import { initializeWriterRecoveryReceipt } from "../src/infrastructure/sqlite/writer-recovery-receipt.ts";

const REGULAR_SESSIONS = 2_000;
const REGULAR_ENTRIES = 96;
const DENSE_SESSION_ENTRIES = 20_000;
const CORPUS_SESSIONS = REGULAR_SESSIONS + 1;
const CORPUS_ENTRIES = REGULAR_SESSIONS * REGULAR_ENTRIES + DENSE_SESSION_ENTRIES;
const SHARED_TEXT = "bounded shared injected evidence";
const SOURCE: SourceInstance = Object.freeze({
  kind: "synthetic-measurement",
  instanceId: "entry-query",
});
const CAPTURED_AT = "2026-07-15T12:00:00.000Z";
const RELEASED_AT = "2026-07-15T12:02:00.000Z";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "sessions-entry-measure-"));
const databasePath = join(temporaryDirectory, "library.sqlite");
const database = openDatabase(databasePath);
try {
  const seedStartedAt = performance.now();
  await seedCorpus(database);
  const seedingMilliseconds = roundMilliseconds(performance.now() - seedStartedAt);
  const databaseBytes = (await stat(databasePath)).size;

  const broadDeep = cursorAtOffset(database, createSessionEntryQuery({ limit: 200 }), 10_000);
  const profiles = {
    broadEarly: measureProfile(database, createSessionEntryQuery({ limit: 50 }), 0, (page) =>
      assertDenseRange(page, 0, 50),
    ),
    broadDeep: measureProfile(database, broadDeep, 10_000, (page) =>
      assertDenseRange(page, 10_000, 200),
    ),
    filteredAll: measureProfile(
      database,
      createSessionEntryQuery({
        filter: { nativeId: nativeIdAt(0) },
        limit: 50,
      }),
      0,
      (page) => assertDenseRange(page, 0, 50),
    ),
    first: measureProfile(
      database,
      createSessionEntryQuery({
        filter: { actor: "human" },
        selection: "first",
        limit: 50,
      }),
      0,
      (page) => assertSelectedPage(page, "first"),
    ),
    last: measureProfile(
      database,
      createSessionEntryQuery({
        filter: { actor: "human" },
        selection: "last",
        limit: 50,
      }),
      0,
      (page) => assertSelectedPage(page, "last"),
    ),
    origin: measureProfile(
      database,
      createSessionEntryQuery({
        filter: { origin: "injected" },
        limit: 50,
      }),
      0,
      (page) => assertOrdinalPage(page, 0),
    ),
    tool: measureProfile(
      database,
      createSessionEntryQuery({
        filter: { toolName: "exec_command", toolNamespace: "functions" },
        limit: 50,
      }),
      0,
      (page) => assertOrdinalPage(page, 2),
    ),
    activity: measureProfile(
      database,
      createSessionEntryQuery({
        filter: {
          activityAfter: "2026-07-15T11:59:59.999Z",
          activityBefore: "2026-07-15T12:00:00.001Z",
        },
        limit: 50,
      }),
      0,
      (page) => assertDenseRange(page, 0, 50),
    ),
  };

  process.stdout.write(
    `${JSON.stringify({
      corpus: {
        sessions: CORPUS_SESSIONS,
        entries: CORPUS_ENTRIES,
        regularSessionEntries: REGULAR_ENTRIES,
        denseSessionEntries: DENSE_SESSION_ENTRIES,
        retainedTextOccurrences: CORPUS_SESSIONS,
        uniqueRetainedTexts: 1,
        databaseBytes,
      },
      seedingMilliseconds,
      profiles,
    })}\n`,
  );
} finally {
  database.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function measureProfile(
  database: DatabaseSync,
  query: SessionEntryQuery,
  offset: number,
  assertPage: (page: SessionEntryPage) => void,
): Measurement {
  const warmWork: SqliteEntryQueryWork[] = [];
  const warm = listSqliteSessionEntries(database, query, {
    observeWork: (work) => warmWork.push(work),
  });
  assertPage(warm);
  assertWorkShape(warmWork);

  const repeatedWork: SqliteEntryQueryWork[] = [];
  const startedAt = performance.now();
  const repeated = listSqliteSessionEntries(database, query, {
    observeWork: (work) => repeatedWork.push(work),
  });
  const totalMilliseconds = performance.now() - startedAt;
  assertPage(repeated);
  assertWorkShape(repeatedWork);
  assert.deepStrictEqual(repeated, warm, "repeated entry query changed its result");

  return {
    totalMilliseconds: roundMilliseconds(totalMilliseconds),
    coordinateSelection: workResult(repeatedWork, "coordinate-selection"),
    hydration: workResult(repeatedWork, "hydration"),
    selectedEntries: repeated.entries.length,
    hasContinuation: repeated.nextCursor !== undefined,
    repeatedResultEqual: true,
    plan: readPlanFacts(database, query, offset),
  };
}

function cursorAtOffset(
  database: DatabaseSync,
  initialQuery: SessionEntryQuery,
  targetOffset: number,
): SessionEntryQuery {
  assert.equal(targetOffset % initialQuery.limit, 0, "deep offset must align to page size");
  let query = initialQuery;
  for (let offset = 0; offset < targetOffset; offset += initialQuery.limit) {
    const page = listSqliteSessionEntries(database, query);
    assert(page.nextCursor !== undefined, "deep measurement offset exceeds the corpus");
    query = createSessionEntryQuery({
      filter: initialQuery.filter,
      selection: initialQuery.selection,
      limit: initialQuery.limit,
      cursor: page.nextCursor,
    });
  }
  return query;
}

function readPlanFacts(
  database: DatabaseSync,
  query: SessionEntryQuery,
  offset: number,
): PlanFacts {
  const statement = buildSqliteEntryCoordinateStatement(
    query,
    measurementPosition(database, offset),
  );
  const rows = database
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...statement.parameters) as unknown as readonly QueryPlanRow[];
  const accesses = rows.flatMap(({ detail }) => {
    const match = /^(SCAN|SEARCH) ([A-Za-z0-9_]+)/u.exec(detail);
    return match === null
      ? []
      : [{ operation: match[1]?.toLowerCase(), relation: match[2] } as PlanAccess];
  });
  const indexes = new Set<string>();
  for (const { detail } of rows) {
    const named = /USING (?:COVERING )?INDEX ([^ ]+)/u.exec(detail);
    if (named?.[1] !== undefined) indexes.add(named[1]);
    if (detail.includes("USING INTEGER PRIMARY KEY")) indexes.add("integer-primary-key");
  }
  return {
    outerAccess: accesses[0] ?? { operation: "unknown", relation: "unknown" },
    indexes: [...indexes].sort(),
    usesOffset: statement.sql.includes("OFFSET"),
    usesKeyset: statement.sql.includes("entry.ordinal > CASE"),
    usesEntryOrdinalRange: rows.some(
      ({ detail }) => detail.startsWith("SEARCH entry ") && detail.includes("ordinal>?"),
    ),
    usesTemporaryOrderBy: rows.some(({ detail }) =>
      detail.includes("USE TEMP B-TREE FOR ORDER BY"),
    ),
  };
}

function measurementPosition(
  database: DatabaseSync,
  offset: number,
): SqliteEntryCoordinatePosition {
  if (offset === 0) return { kind: "first" };
  const row = database
    .prepare(
      `SELECT canonical.session_id
       FROM sessions_canonical_sessions AS canonical
       JOIN sessions_session_tracking AS tracking
         ON tracking.session_id = canonical.session_id
       JOIN sessions_source_instances AS source
         ON source.source_instance_id = tracking.source_instance_id
       WHERE source.kind = ?
         AND source.instance_id = ?
         AND tracking.native_id = ?`,
    )
    .get(SOURCE.kind, SOURCE.instanceId, nativeIdAt(0)) as
    | { readonly session_id?: unknown }
    | undefined;
  const sessionId = row?.session_id;
  assert(
    typeof sessionId === "number" && Number.isSafeInteger(sessionId),
    "dense measurement session is missing",
  );
  return {
    kind: "keyset",
    anchor: {
      sessionId,
      entryOrdinal: offset - 1,
      sourceKind: SOURCE.kind,
      instanceId: SOURCE.instanceId,
      nativeId: nativeIdAt(0),
    },
  };
}

function workResult(
  work: readonly SqliteEntryQueryWork[],
  phase: SqliteEntryQueryWork["phase"],
): WorkResult {
  const selected = work.find((candidate) => candidate.phase === phase);
  assert(selected !== undefined, `missing ${phase} measurement`);
  return {
    milliseconds: roundMilliseconds(selected.elapsedMilliseconds),
    rows: selected.rowCount,
  };
}

function assertWorkShape(work: readonly SqliteEntryQueryWork[]): void {
  assert.deepStrictEqual(
    work.map(({ phase }) => phase),
    ["coordinate-selection", "hydration"],
    "entry query emitted an unexpected work phase",
  );
}

async function seedCorpus(database: DatabaseSync): Promise<void> {
  const now = () => new Date(CAPTURED_AT);
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "entry-measurement-writer",
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
    await index.replaceSession(run, replacement(0, DENSE_SESSION_ENTRIES));
    for (let ordinal = 1; ordinal <= REGULAR_SESSIONS; ordinal += 1) {
      await index.replaceSession(run, replacement(ordinal, REGULAR_ENTRIES));
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

function replacement(ordinal: number, entryCount: number): ValidatedSessionReplacement {
  const identity = identityAt(ordinal);
  const candidate = createDiscoveredSession({
    identity,
    inputs: [
      {
        role: "transcript",
        locator: { uri: `memory://entry-measurement/${nativeIdAt(ordinal)}` },
        fingerprint: `revision-${nativeIdAt(ordinal)}`,
      },
    ],
    adapterVersion: "synthetic-v1",
  });
  const observation = admitSessionObservation(candidate);
  assert(observation.ok, "measurement observation was rejected");
  const admitted = admitSessionReplacement(
    observation.observation,
    documentAt(ordinal, entryCount),
  );
  assert(admitted.ok, "measurement document was rejected");
  return admitted.replacement;
}

function documentAt(ordinal: number, entryCount: number): SessionDocument {
  const identity = identityAt(ordinal);
  return {
    identity,
    title: `Entry measurement ${nativeIdAt(ordinal)}`,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    lineageCoverage: "complete",
    relations: [],
    entries: Array.from({ length: entryCount }, (_, entryOrdinal) =>
      entryAt(ordinal, entryOrdinal),
    ),
  };
}

function entryAt(sessionOrdinal: number, entryOrdinal: number): SessionEntry {
  const sourceLocator = {
    uri: `memory://entry-measurement/${nativeIdAt(sessionOrdinal)}/${String(entryOrdinal)}`,
  };
  if (entryOrdinal === 0) {
    return {
      ordinal: entryOrdinal,
      kind: "message",
      actor: "system",
      timestamp: CAPTURED_AT,
      sourceLocator,
      content: [
        {
          kind: "text",
          ordinal: 0,
          text: SHARED_TEXT,
          contentHash: hashContent(SHARED_TEXT),
          origin: "injected",
          originConfidence: "high",
          sourceMetadata: {},
        },
      ],
    };
  }
  if (entryOrdinal === 2) {
    return {
      ordinal: entryOrdinal,
      kind: "tool-call",
      actor: "model",
      timestamp: CAPTURED_AT,
      toolCallId: `call-${String(sessionOrdinal)}`,
      toolName: "exec_command",
      toolNamespace: "functions",
      sourceLocator,
      content: [],
    };
  }
  if (entryOrdinal === 3) {
    return {
      ordinal: entryOrdinal,
      kind: "tool-result",
      actor: "tool",
      timestamp: CAPTURED_AT,
      relatedEntryOrdinal: 2,
      toolCallId: `call-${String(sessionOrdinal)}`,
      sourceLocator,
      content: [],
    };
  }
  return {
    ordinal: entryOrdinal,
    kind: "message",
    actor: entryOrdinal % 2 === 1 ? "human" : "model",
    timestamp: CAPTURED_AT,
    sourceLocator,
    content: [],
  };
}

function assertDenseRange(page: SessionEntryPage, start: number, count: number): void {
  assert.deepStrictEqual(
    page.entries.map(({ session, entry }) => [session.identity.nativeId, entry.ordinal]),
    Array.from({ length: count }, (_, index) => [nativeIdAt(0), start + index]),
  );
  assert(page.nextCursor !== undefined, "dense page must have a continuation");
  page.entries.forEach(assertEntryFacts);
}

function assertSelectedPage(page: SessionEntryPage, selection: "first" | "last"): void {
  assert.deepStrictEqual(
    page.entries.map(({ session, entry }) => [
      session.identity.nativeId,
      entry.ordinal,
      entry.actor,
    ]),
    Array.from({ length: 50 }, (_, index) => [
      nativeIdAt(index),
      selection === "first" ? 1 : index === 0 ? DENSE_SESSION_ENTRIES - 1 : REGULAR_ENTRIES - 1,
      "human",
    ]),
  );
  assert(page.nextCursor !== undefined, "selected page must have a continuation");
  page.entries.forEach(assertEntryFacts);
}

function assertOrdinalPage(page: SessionEntryPage, expectedEntryOrdinal: number): void {
  assert.deepStrictEqual(
    page.entries.map(({ session, entry }) => [session.identity.nativeId, entry.ordinal]),
    Array.from({ length: 50 }, (_, index) => [nativeIdAt(index), expectedEntryOrdinal]),
  );
  assert(page.nextCursor !== undefined, "filtered page must have a continuation");
  page.entries.forEach(assertEntryFacts);
}

function assertEntryFacts(item: SessionEntryPage["entries"][number]): void {
  assert.deepStrictEqual(item.root, { kind: "known", root: item.session.identity });
  if (item.entry.ordinal === 0) {
    assert.deepStrictEqual(item.content, {
      textSegmentCount: 1,
      omittedSegmentCount: 0,
      unpreviewedTextSegmentCount: 0,
      preview: {
        segmentOrdinal: 0,
        origin: "injected",
        originConfidence: "high",
        contentHash: hashContent(SHARED_TEXT),
        text: SHARED_TEXT,
        truncated: false,
      },
    });
    return;
  }
  assert.deepStrictEqual(item.content, {
    textSegmentCount: 0,
    omittedSegmentCount: 0,
    unpreviewedTextSegmentCount: 0,
  });
}

function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  applyMigrations(database);
  return database;
}

function identityAt(ordinal: number): SessionIdentity {
  return { source: SOURCE, nativeId: nativeIdAt(ordinal) };
}

function nativeIdAt(ordinal: number): string {
  return `session-${String(ordinal).padStart(4, "0")}`;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

interface WorkResult {
  readonly milliseconds: number;
  readonly rows: number;
}

interface PlanAccess {
  readonly operation: string;
  readonly relation: string;
}

interface PlanFacts {
  readonly outerAccess: PlanAccess;
  readonly indexes: readonly string[];
  readonly usesOffset: boolean;
  readonly usesKeyset: boolean;
  readonly usesEntryOrdinalRange: boolean;
  readonly usesTemporaryOrderBy: boolean;
}

interface Measurement {
  readonly totalMilliseconds: number;
  readonly coordinateSelection: WorkResult;
  readonly hydration: WorkResult;
  readonly selectedEntries: number;
  readonly hasContinuation: boolean;
  readonly repeatedResultEqual: true;
  readonly plan: PlanFacts;
}

interface QueryPlanRow {
  readonly detail: string;
}
