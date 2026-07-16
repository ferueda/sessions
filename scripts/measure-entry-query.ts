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
import {
  createSessionEntryQuery,
  type SessionEntryPage,
  type SessionEntryQuery,
} from "../src/domain/session-query.ts";
import type {
  ContentOrigin,
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SourceInstance,
} from "../src/domain/session.ts";
import { applyMigrations } from "../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../src/infrastructure/sqlite/sqlite-session-index.ts";
import { createSqliteSessionQuery } from "../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../src/infrastructure/sqlite/writer-lease.ts";

const CORPUS_SESSIONS = 2_000;
const ENTRIES_PER_SESSION = 5;
const SOURCE: SourceInstance = Object.freeze({
  kind: "synthetic-measurement",
  instanceId: "entry-query",
});
const CAPTURED_AT = "2026-07-15T12:00:00.000Z";
const RELEASED_AT = "2026-07-15T12:02:00.000Z";

const database = openDatabase();
try {
  await seedCorpus(database);
  const repository = createSqliteSessionQuery(database);
  const measurements = {
    all: await measure(repository.entries, createSessionEntryQuery({ limit: 7 }), assertAllPage),
    first: await measure(
      repository.entries,
      createSessionEntryQuery({ filter: { actor: "human" }, selection: "first", limit: 5 }),
      (page) => assertSelectedPage(page, 1),
    ),
    last: await measure(
      repository.entries,
      createSessionEntryQuery({ filter: { actor: "human" }, selection: "last", limit: 5 }),
      (page) => assertSelectedPage(page, 4),
    ),
    tool: await measure(
      repository.entries,
      createSessionEntryQuery({
        filter: { toolName: "exec_command", toolNamespace: "functions" },
        limit: 5,
      }),
      (page) => assertSelectedPage(page, 2),
    ),
  };

  process.stdout.write(
    `${JSON.stringify({
      corpusSessions: CORPUS_SESSIONS,
      entriesPerSession: ENTRIES_PER_SESSION,
      corpusEntries: CORPUS_SESSIONS * ENTRIES_PER_SESSION,
      elapsedMs: measurements,
    })}\n`,
  );
} finally {
  database.close();
}

async function measure(
  run: (query: SessionEntryQuery) => Promise<SessionEntryPage>,
  query: SessionEntryQuery,
  assertPage: (page: SessionEntryPage) => void,
): Promise<number> {
  const warm = await run(query);
  assertPage(warm);

  const startedAt = performance.now();
  const repeated = await run(query);
  const elapsedMilliseconds = performance.now() - startedAt;
  assertPage(repeated);
  assert.deepStrictEqual(repeated, warm, "repeated entry query changed its result");
  return roundMilliseconds(elapsedMilliseconds);
}

async function seedCorpus(database: DatabaseSync): Promise<void> {
  const now = () => new Date(CAPTURED_AT);
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "entry-measurement-writer",
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
        locator: { uri: `memory://entry-measurement/${nativeIdAt(ordinal)}` },
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
  return {
    identity,
    title: `Entry measurement ${nativeIdAt(ordinal)}`,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    lineageCoverage: "complete",
    relations: [],
    entries: [
      textEntry(0, "system", "injected", `Injected context ${nativeIdAt(ordinal)}`),
      textEntry(1, "human", "human", `Initial request ${nativeIdAt(ordinal)}`),
      {
        ...textEntry(2, "model", "model", `Observed tool call ${nativeIdAt(ordinal)}`),
        kind: "tool-call",
        toolCallId: `call-${ordinal}`,
        toolName: "exec_command",
        toolNamespace: "functions",
      },
      {
        ordinal: 3,
        kind: "tool-result",
        actor: "tool",
        timestamp: timestampAt(3),
        relatedEntryOrdinal: 2,
        toolCallId: `call-${ordinal}`,
        sourceLocator: { uri: `memory://entry-measurement/${nativeIdAt(ordinal)}/entry/3` },
        content: [
          {
            kind: "omitted",
            ordinal: 0,
            contentClass: "structured",
            sourceType: "tool-result",
            origin: "tool",
            originConfidence: "high",
            sourceMetadata: {},
          },
        ],
      },
      textEntry(4, "human", "human", `Final correction ${nativeIdAt(ordinal)}`),
    ],
  };
}

function textEntry(
  ordinal: number,
  actor: SessionEntry["actor"],
  origin: ContentOrigin,
  text: string,
): SessionEntry {
  return {
    ordinal,
    kind: "message",
    actor,
    timestamp: timestampAt(ordinal),
    sourceLocator: {
      uri: `memory://entry-measurement/entry/${String(ordinal)}`,
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

function assertAllPage(page: SessionEntryPage): void {
  assert.deepStrictEqual(
    page.entries.map(({ session, entry }) => [session.identity.nativeId, entry.ordinal]),
    [
      [nativeIdAt(0), 0],
      [nativeIdAt(0), 1],
      [nativeIdAt(0), 2],
      [nativeIdAt(0), 3],
      [nativeIdAt(0), 4],
      [nativeIdAt(1), 0],
      [nativeIdAt(1), 1],
    ],
  );
  assert(page.nextCursor !== undefined, "broad entry page must have a continuation cursor");
  page.entries.forEach(assertEntryFacts);
}

function assertSelectedPage(page: SessionEntryPage, expectedEntryOrdinal: number): void {
  assert.deepStrictEqual(
    page.entries.map(({ session, entry }) => [session.identity.nativeId, entry.ordinal]),
    Array.from({ length: 5 }, (_, ordinal) => [nativeIdAt(ordinal), expectedEntryOrdinal]),
  );
  assert(page.nextCursor !== undefined, "selected entry page must have a continuation cursor");
  page.entries.forEach(assertEntryFacts);
}

function assertEntryFacts(item: SessionEntryPage["entries"][number]): void {
  assert.deepStrictEqual(item.root, { kind: "known", root: item.session.identity });
  if (item.entry.ordinal === 3) {
    assert.deepStrictEqual(item.content, {
      textSegmentCount: 0,
      omittedSegmentCount: 1,
      unpreviewedTextSegmentCount: 0,
    });
    return;
  }
  const text = expectedText(item.session.identity.nativeId, item.entry.ordinal);
  assert.deepStrictEqual(item.content, {
    textSegmentCount: 1,
    omittedSegmentCount: 0,
    unpreviewedTextSegmentCount: 0,
    preview: {
      segmentOrdinal: 0,
      origin: expectedOrigin(item.entry.ordinal),
      originConfidence: "high",
      contentHash: hashContent(text),
      text,
      truncated: false,
    },
  });
}

function expectedText(nativeId: string, entryOrdinal: number): string {
  if (entryOrdinal === 0) return `Injected context ${nativeId}`;
  if (entryOrdinal === 1) return `Initial request ${nativeId}`;
  if (entryOrdinal === 2) return `Observed tool call ${nativeId}`;
  if (entryOrdinal === 4) return `Final correction ${nativeId}`;
  throw new Error("unexpected text entry ordinal");
}

function expectedOrigin(entryOrdinal: number): ContentOrigin {
  if (entryOrdinal === 0) return "injected";
  if (entryOrdinal === 1 || entryOrdinal === 4) return "human";
  if (entryOrdinal === 2) return "model";
  throw new Error("unexpected text entry ordinal");
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

function timestampAt(ordinal: number): string {
  return `2026-07-15T12:00:0${String(ordinal)}.000Z`;
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}
