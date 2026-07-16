import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { createDiscoveredSession } from "../src/application/source-input-fingerprint.ts";
import {
  admitSessionObservation,
  admitSessionReplacement,
  type ValidatedSessionReplacement,
} from "../src/application/validate-session.ts";
import { hashContent } from "../src/domain/content-hash.ts";
import { createSessionSearchQuery, type SessionSearchPage } from "../src/domain/session-query.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../src/domain/session.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../src/infrastructure/sqlite/sqlite-session-index.ts";
import { createSqliteSessionQuery } from "../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../src/infrastructure/sqlite/writer-lease.ts";

const CORPUS_SESSIONS = 2_000;
const PAGE_LIMIT = 5;
const SEARCH_TERM = "searchmeasurement";
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
  const query = createSessionSearchQuery({
    text: SEARCH_TERM,
    limit: PAGE_LIMIT,
    context: 0,
  });

  const warm = await repository.search(query);
  assertExpectedPage(warm);

  const startedAt = performance.now();
  const repeated = await repository.search(query);
  const elapsedMilliseconds = performance.now() - startedAt;

  assert.deepStrictEqual(repeated, warm, "repeated broad search changed its result");

  process.stdout.write(
    `${JSON.stringify({
      corpusSessions: CORPUS_SESSIONS,
      elapsedMs: roundMilliseconds(elapsedMilliseconds),
    })}\n`,
  );
} finally {
  database.close();
}

async function seedCorpus(database: DatabaseSync): Promise<void> {
  const now = () => new Date(CAPTURED_AT);
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "search-measurement-writer",
  });
  try {
    const index = createCoordinatedSqliteSessionIndex(database, { lease, now });
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
    ],
  };
}

function assertExpectedPage(page: SessionSearchPage): void {
  const expectedNativeIds = Array.from({ length: PAGE_LIMIT }, (_, ordinal) => nativeIdAt(ordinal));
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
    assert.deepStrictEqual(hit.snippet, {
      segmentOrdinal: 0,
      origin: "human",
      originConfidence: "high",
      contentHash: hashContent(text),
      text,
      truncated: false,
      additionalMatchingSegments: 0,
    });
    assert.deepStrictEqual(hit.context, []);
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
  return `${SEARCH_TERM} generic evidence ${nativeIdAt(ordinal)}`;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}
