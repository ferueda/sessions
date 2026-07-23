import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { constants, DatabaseSync } from "node:sqlite";

import { createDiscoveredSession } from "../src/application/source-input-fingerprint.ts";
import {
  admitSessionObservation,
  admitSessionReplacement,
  type ValidatedSessionReplacement,
} from "../src/application/validate-session.ts";
import { hashContent } from "../src/domain/content-hash.ts";
import { createSessionSearchQuery, type SessionSearchPage } from "../src/domain/session-query.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../src/domain/session.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
} from "../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../src/infrastructure/sqlite/sqlite-session-index.ts";
import { SQLITE_SEARCH_CONTEXT_COORDINATE_CHUNK_SIZE } from "../src/infrastructure/sqlite/sqlite-query-context.ts";
import { createSqliteSessionQuery } from "../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../src/infrastructure/sqlite/writer-lease.ts";
import { initializeWriterRecoveryReceipt } from "../src/infrastructure/sqlite/writer-recovery-receipt.ts";

const CORPUS_SESSIONS = 2_000;
const SMALL_PAGE_LIMIT = 5;
const LARGE_PAGE_LIMIT = 200;
const CONTEXT_LIMIT = 2;
const SEARCH_TERM = "searchmeasurement";
const ANY_TERMS = ["alternateeven", "alternateodd"] as const;
const SOURCE: SourceInstance = Object.freeze({
  kind: "synthetic-measurement",
  instanceId: "search-query",
});
const CAPTURED_AT = "2026-07-15T12:00:00.000Z";
const RELEASED_AT = "2026-07-15T12:02:00.000Z";

const database = openDatabase();
try {
  await seedCorpus(database);
  const repository = createSqliteSessionQuery(database);
  const elapsedMilliseconds = {
    all: await measureProfiles(database, repository.search, "all"),
    any: await measureProfiles(database, repository.search, "any"),
  };

  process.stdout.write(
    `${JSON.stringify({
      corpusSessions: CORPUS_SESSIONS,
      profiles: {
        small: { limit: SMALL_PAGE_LIMIT, context: 0 },
        large: { limit: LARGE_PAGE_LIMIT, context: 0 },
        largeContext: { limit: LARGE_PAGE_LIMIT, context: CONTEXT_LIMIT },
      },
      elapsedMs: elapsedMilliseconds,
    })}\n`,
  );
} finally {
  database.close();
}

async function measureProfiles(
  database: DatabaseSync,
  run: (query: ReturnType<typeof createSessionSearchQuery>) => Promise<SessionSearchPage>,
  mode: "all" | "any",
): Promise<{
  readonly small: ProfileMeasurement;
  readonly large: ProfileMeasurement;
  readonly largeContext: ProfileMeasurement;
}> {
  const text = mode === "all" ? SEARCH_TERM : ANY_TERMS.join(" ");
  const profile = async (limit: number, context: number): Promise<ProfileMeasurement> => {
    const query = createSessionSearchQuery({
      text,
      ...(mode === "all" ? {} : { termMode: "any" }),
      limit,
      context,
    });
    return measure(database, run, query, (page) => assertExpectedPage(page, mode, limit, context));
  };
  return {
    small: await profile(SMALL_PAGE_LIMIT, 0),
    large: await profile(LARGE_PAGE_LIMIT, 0),
    largeContext: await profile(LARGE_PAGE_LIMIT, CONTEXT_LIMIT),
  };
}

async function measure(
  database: DatabaseSync,
  run: (query: ReturnType<typeof createSessionSearchQuery>) => Promise<SessionSearchPage>,
  query: ReturnType<typeof createSessionSearchQuery>,
  assertPage: (page: SessionSearchPage) => void,
): Promise<ProfileMeasurement> {
  const warm = await run(query);
  assertPage(warm);
  const startedAt = performance.now();
  const repeated = await run(query);
  const elapsedMilliseconds = performance.now() - startedAt;
  assertPage(repeated);
  assert.deepStrictEqual(repeated, warm, "repeated broad search changed its result");
  let selectAuthorizations = 0;
  database.setAuthorizer((actionCode) => {
    if (actionCode === constants.SQLITE_SELECT) selectAuthorizations += 1;
    return constants.SQLITE_OK;
  });
  let observed: SessionSearchPage;
  try {
    observed = await run(query);
  } finally {
    database.setAuthorizer(null);
  }
  assert.deepStrictEqual(observed, warm, "observed broad search changed its result");
  const selectedContent = new Set(
    observed.hits.map(
      ({ snippet }) => `${snippet.contentHash.scheme}:${snippet.contentHash.digest}`,
    ),
  ).size;
  const distinctSessions = new Set(observed.hits.map(({ session }) => session.identity.nativeId))
    .size;
  const contextCoordinates = new Set(
    observed.hits.flatMap((hit) =>
      hit.context.map(({ ordinal }) => `${hit.session.identity.nativeId}:${String(ordinal)}`),
    ),
  ).size;
  return {
    elapsedMilliseconds: roundMilliseconds(elapsedMilliseconds),
    work: {
      selectedContent,
      distinctSessions,
      selectedContextCoordinates: contextCoordinates,
      contextHydrationChunks: Math.ceil(
        contextCoordinates / SQLITE_SEARCH_CONTEXT_COORDINATE_CHUNK_SIZE,
      ),
      selectAuthorizations,
    },
  };
}

interface ProfileMeasurement {
  readonly elapsedMilliseconds: number;
  readonly work: {
    readonly selectedContent: number;
    readonly distinctSessions: number;
    readonly selectedContextCoordinates: number;
    readonly contextHydrationChunks: number;
    readonly selectAuthorizations: number;
  };
}

async function seedCorpus(database: DatabaseSync): Promise<void> {
  const now = () => new Date(CAPTURED_AT);
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "search-measurement-writer",
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
  const candidate = createDiscoveredSession({
    identity,
    inputs: [
      {
        role: "transcript",
        locator: { uri: `memory://search-measurement/${nativeIdAt(ordinal)}` },
        fingerprint: `revision-${nativeIdAt(ordinal)}`,
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

function documentAt(ordinal: number): SessionDocument {
  const identity = identityAt(ordinal);
  const text = textAt(ordinal);
  return {
    identity,
    title: `Search measurement ${nativeIdAt(ordinal)}`,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    lineageCoverage: "complete",
    relations: [],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        timestamp: CAPTURED_AT,
        sourceLocator: { uri: `memory://search-measurement/${nativeIdAt(ordinal)}/entry/0` },
        content: [
          {
            kind: "text",
            ordinal: 0,
            text,
            contentHash: hashContent(text),
            origin: "human",
            originConfidence: "high",
            sourceMetadata: {},
          },
        ],
      },
      contextEntryAt(ordinal, 1),
      contextEntryAt(ordinal, 2),
    ],
  };
}

function contextEntryAt(
  sessionOrdinal: number,
  entryOrdinal: number,
): SessionDocument["entries"][number] {
  const text = contextTextAt(sessionOrdinal, entryOrdinal);
  return {
    ordinal: entryOrdinal,
    kind: "message",
    actor: "model",
    timestamp: CAPTURED_AT,
    sourceLocator: {
      uri: `memory://search-measurement/${nativeIdAt(sessionOrdinal)}/entry/${String(entryOrdinal)}`,
    },
    content: [
      {
        kind: "text",
        ordinal: 0,
        text,
        contentHash: hashContent(text),
        origin: "model",
        originConfidence: "high",
        sourceMetadata: {},
      },
    ],
  };
}

function assertExpectedPage(
  page: SessionSearchPage,
  mode: "all" | "any",
  pageLimit: number,
  contextLimit: number,
): void {
  const expectedNativeIds = Array.from({ length: pageLimit }, (_, ordinal) => nativeIdAt(ordinal));
  assert.deepStrictEqual(
    page.hits.map(({ session }) => session.identity.nativeId),
    expectedNativeIds,
    "broad search order changed",
  );
  assert.deepStrictEqual(page.support, {
    occurrences: CORPUS_SESSIONS,
    uniqueContent: CORPUS_SESSIONS,
    uniqueKnownRoots: CORPUS_SESSIONS,
    unknownLineageSessions: 0,
  });
  assert(page.nextCursor !== undefined, "broad first page must have a continuation cursor");

  for (const [ordinal, hit] of page.hits.entries()) {
    const text = textAt(ordinal);
    assert.deepStrictEqual(hit.root, { kind: "known", root: hit.session.identity });
    assert.deepStrictEqual(
      hit.matchedTerms,
      mode === "all" ? [SEARCH_TERM] : [ANY_TERMS[ordinal % ANY_TERMS.length]!],
    );
    assert.deepStrictEqual(hit.snippet, {
      segmentOrdinal: 0,
      origin: "human",
      originConfidence: "high",
      contentHash: hashContent(text),
      text,
      truncated: false,
      additionalMatchingSegments: 0,
    });
    assert.deepStrictEqual(
      hit.context,
      contextLimit === 0
        ? []
        : [1, 2].map((entryOrdinal) => ({
            ordinal: entryOrdinal,
            kind: "message",
            actor: "model",
            timestamp: CAPTURED_AT,
            body: contextTextAt(ordinal, entryOrdinal),
            bodyTruncated: false,
            adjacent: true,
            linked: false,
          })),
    );
    assert.equal(hit.linkedContextTruncated, false);
  }
}

function openDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:", {
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

function textAt(ordinal: number): string {
  return `${SEARCH_TERM} ${ANY_TERMS[ordinal % ANY_TERMS.length]} generic evidence ${nativeIdAt(ordinal)}`;
}

function contextTextAt(sessionOrdinal: number, entryOrdinal: number): string {
  return `context ${nativeIdAt(sessionOrdinal)} entry ${String(entryOrdinal)}`;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}
