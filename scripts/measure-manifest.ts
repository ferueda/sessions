import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { constants, DatabaseSync } from "node:sqlite";

import { createDiscoveredSession } from "../src/application/source-input-fingerprint.ts";
import {
  admitSessionObservation,
  admitSessionReplacement,
  type ValidatedSessionReplacement,
} from "../src/application/validate-session.ts";
import { buildManifestJsonV1 } from "../src/cli/structured-output.ts";
import { encodeStructuredJson } from "../src/cli/encode-json-output.ts";
import { MAX_BOUNDED_STRUCTURED_OUTPUT_BYTES } from "../src/cli/structured-output-encoding.ts";
import { hashContent } from "../src/domain/content-hash.ts";
import {
  createSessionManifestQuery,
  type SessionManifestResult,
} from "../src/domain/session-manifest.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../src/domain/session.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
} from "../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../src/infrastructure/sqlite/sqlite-session-index.ts";
import { createSqliteSessionQuery } from "../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../src/infrastructure/sqlite/writer-lease.ts";
import { initializeWriterRecoveryReceipt } from "../src/infrastructure/sqlite/writer-recovery-receipt.ts";

const CORPUS_REVISIONS = 2_000;
const CAPTURED_AT = "2026-07-21T12:00:00.000Z";
const FINISHED_AT = "2026-07-21T12:01:00.000Z";
const RELEASED_AT = "2026-07-21T12:02:00.000Z";
const SOURCES: readonly SourceInstance[] = Object.freeze([
  Object.freeze({ kind: "zeta-measurement", instanceId: "profile-2" }),
  Object.freeze({ kind: "alpha-measurement", instanceId: "profile-10" }),
  Object.freeze({ kind: "alpha-measurement", instanceId: "profile-2" }),
]);
const TRANSCRIPT_TABLES: ReadonlySet<string> = new Set([
  "sessions_content_fts",
  "sessions_content_fts_config",
  "sessions_content_fts_data",
  "sessions_content_fts_docsize",
  "sessions_content_fts_idx",
  "sessions_content_occurrences",
  "sessions_content_values",
  "sessions_entries",
]);
const MAX_SELECT_AUTHORIZATIONS_PER_READ = 8;

const database = openDatabase();
try {
  const documents = Array.from({ length: CORPUS_REVISIONS }, (_, ordinal) => documentAt(ordinal));
  const seedStartedAt = performance.now();
  await seedCorpus(database, documents.toReversed());
  const seedElapsedMs = performance.now() - seedStartedAt;

  const audit = installManifestReadAudit(database);
  const repository = createSqliteSessionQuery(database);
  const query = createSessionManifestQuery();

  const firstStartedAt = performance.now();
  const first = await repository.manifest(query);
  const firstElapsedMs = performance.now() - firstStartedAt;
  const firstAudit = audit.snapshot();

  const repeatedStartedAt = performance.now();
  const repeated = await repository.manifest(query);
  const repeatedElapsedMs = performance.now() - repeatedStartedAt;
  const repeatedAudit = subtractAudit(audit.snapshot(), firstAudit);

  assertManifest(first, documents);
  assertManifest(repeated, documents);
  assert.deepStrictEqual(repeated, first, "repeated manifest read changed its result");
  assertReadAudit(firstAudit, "first");
  assertReadAudit(repeatedAudit, "repeated");
  assert.deepStrictEqual(
    repeatedAudit,
    firstAudit,
    "repeated manifest read changed its SQLite access shape",
  );

  const encoded = encodeStructuredJson(buildManifestJsonV1(first));
  const encodedBytes = Buffer.byteLength(encoded, "utf8");
  assert(
    encodedBytes <= MAX_BOUNDED_STRUCTURED_OUTPUT_BYTES,
    "deterministic manifest exceeded the structured-output byte limit",
  );

  const totals = documents.reduce(addDocumentCounts, emptyDocumentCounts());
  process.stdout.write(
    `${JSON.stringify({
      corpusRevisions: CORPUS_REVISIONS,
      sourceInstances: SOURCES.length,
      relations: totals.relations,
      entries: totals.entries,
      segments: totals.segments,
      omittedSegments: totals.omittedSegments,
      textUtf8Bytes: totals.textUtf8Bytes,
      encodedBytes,
      transcriptTableReads: firstAudit.transcriptTableReads + repeatedAudit.transcriptTableReads,
      selectAuthorizations: firstAudit.selectAuthorizations + repeatedAudit.selectAuthorizations,
      elapsedMs: {
        seed: roundMilliseconds(seedElapsedMs),
        firstManifest: roundMilliseconds(firstElapsedMs),
        repeatedManifest: roundMilliseconds(repeatedElapsedMs),
      },
    })}\n`,
  );
} finally {
  database.close();
}

async function seedCorpus(
  database: DatabaseSync,
  documents: readonly SessionDocument[],
): Promise<void> {
  const now = () => new Date(CAPTURED_AT);
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "manifest-measurement-writer",
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
    for (const source of SOURCES.toReversed()) {
      const selected = documents.filter((document) => sameSource(document.identity.source, source));
      const run = await index.startRun({ source, startedAt: CAPTURED_AT });
      for (const document of selected) {
        await index.replaceSession(run, replacement(document));
      }
      const result = await index.finishRun(run, {
        status: "completed",
        finishedAt: FINISHED_AT,
      });
      assert.deepStrictEqual(result.counts, {
        discovered: selected.length,
        unchanged: 0,
        updated: selected.length,
        failed: 0,
        missing: 0,
        stale: 0,
      });
    }
  } finally {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: () => new Date(RELEASED_AT),
    });
  }
}

function replacement(document: SessionDocument): ValidatedSessionReplacement {
  const candidate = createDiscoveredSession({
    identity: document.identity,
    inputs: [
      {
        role: "transcript",
        locator: {
          uri: `memory://manifest-measurement/${encodeURIComponent(document.identity.nativeId)}`,
        },
        fingerprint: `revision-${document.identity.nativeId}`,
      },
    ],
    adapterVersion: "synthetic-v1",
  });
  const observation = admitSessionObservation(candidate);
  assert(observation.ok, "measurement observation was rejected");
  const admitted = admitSessionReplacement(observation.observation, document);
  assert(admitted.ok, "measurement document was rejected");
  return admitted.replacement;
}

function documentAt(ordinal: number): SessionDocument {
  const identity = identityAt(ordinal);
  const text = `Repeated generic evidence ${identity.nativeId} naïve`;
  const contentHash = hashContent(text);
  return {
    identity,
    title: `Excluded title ${"x".repeat((ordinal % 5) + 1)}`,
    createdAt: CAPTURED_AT,
    updatedAt: CAPTURED_AT,
    lineageCoverage: "complete",
    relations: [
      {
        kind: "child",
        target: {
          source: { kind: "synthetic-child", instanceId: "external" },
          nativeId: `child-${String(ordinal)}`,
        },
        confidence: "high",
      },
    ],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        timestamp: CAPTURED_AT,
        sourceLocator: { uri: `memory://manifest-measurement/${String(ordinal)}/entry/0` },
        content: [
          {
            kind: "text",
            ordinal: 0,
            text,
            contentHash,
            origin: "human",
            originConfidence: "high",
            sourceMetadata: {},
          },
        ],
      },
      {
        ordinal: 1,
        kind: "message",
        actor: "model",
        timestamp: CAPTURED_AT,
        sourceLocator: { uri: `memory://manifest-measurement/${String(ordinal)}/entry/1` },
        content: [
          {
            kind: "text",
            ordinal: 0,
            text,
            contentHash,
            origin: "model",
            originConfidence: "high",
            sourceMetadata: {},
          },
          {
            kind: "omitted",
            ordinal: 1,
            contentClass: "structured",
            sourceType: "tool-result",
            origin: "tool",
            originConfidence: "high",
            sourceMetadata: {},
          },
        ],
      },
    ],
  };
}

function identityAt(ordinal: number): SessionIdentity {
  return {
    source: SOURCES[ordinal % SOURCES.length]!,
    nativeId: `revision-${String(CORPUS_REVISIONS - ordinal)}`,
  };
}

function assertManifest(
  manifest: SessionManifestResult,
  documents: readonly SessionDocument[],
): void {
  const expected = documents.toSorted((left, right) =>
    compareIdentity(left.identity, right.identity),
  );
  assert.deepStrictEqual(manifest.selection, {
    order: "canonical-identity-v1",
    maximumRevisions: 10_000,
    filters: {},
  });
  assert.deepStrictEqual(manifest.captureScope, {
    status: "complete",
    trackedSessions: CORPUS_REVISIONS,
    retainedSessions: { current: CORPUS_REVISIONS, stale: 0 },
    unindexedSessions: 0,
    sourceState: { present: CORPUS_REVISIONS, missing: 0, unknown: 0 },
    sourceCoverage: { complete: SOURCES.length, unknown: 0 },
    latestFailures: {
      unavailable: 0,
      unreadable: 0,
      malformed: 0,
      sourceChanged: 0,
      unsupportedFormat: 0,
      repositoryWrite: 0,
    },
    appliedFilters: [],
    unassessedFilters: [],
  });
  assert.equal(manifest.revisions.length, CORPUS_REVISIONS);
  assert.deepStrictEqual(
    manifest.revisions.map(({ session }) => session),
    expected.map(({ identity }) => identity),
    "manifest identities are not in canonical binary order",
  );

  for (const [index, revision] of manifest.revisions.entries()) {
    const document = expected[index]!;
    assert.deepStrictEqual(revision.counts, documentCounts(document));
    assert.deepStrictEqual(revision.root, { kind: "known", root: document.identity });
    assert.equal(revision.createdAt, CAPTURED_AT);
    assert.equal(revision.updatedAt, CAPTURED_AT);
    assert.equal(revision.capturedAt, CAPTURED_AT);
    assert.equal(revision.sourceObservedAt, CAPTURED_AT);
    assert.equal(revision.sourceState, "present");
    assert.equal(revision.freshness, "current");
    assert.equal(revision.adapterVersion, "synthetic-v1");
    assert.equal(revision.lineageCoverage, "complete");
  }
}

function installManifestReadAudit(database: DatabaseSync): ManifestReadAudit {
  let selectAuthorizations = 0;
  let transcriptTableReads = 0;
  let writeAuthorizations = 0;
  database.setAuthorizer((actionCode, table) => {
    if (actionCode === constants.SQLITE_SELECT) selectAuthorizations += 1;
    if (actionCode === constants.SQLITE_READ && table !== null && TRANSCRIPT_TABLES.has(table)) {
      transcriptTableReads += 1;
      return constants.SQLITE_DENY;
    }
    if (
      actionCode === constants.SQLITE_INSERT ||
      actionCode === constants.SQLITE_UPDATE ||
      actionCode === constants.SQLITE_DELETE
    ) {
      writeAuthorizations += 1;
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  return {
    snapshot: () => ({ selectAuthorizations, transcriptTableReads, writeAuthorizations }),
  };
}

function assertReadAudit(audit: ManifestReadAuditSnapshot, label: string): void {
  assert.equal(audit.transcriptTableReads, 0, `${label} manifest read touched transcript tables`);
  assert.equal(audit.writeAuthorizations, 0, `${label} manifest read attempted to write`);
  assert(
    audit.selectAuthorizations <= MAX_SELECT_AUTHORIZATIONS_PER_READ,
    `${label} manifest read exceeded the bounded set-based query shape`,
  );
}

function subtractAudit(
  total: ManifestReadAuditSnapshot,
  earlier: ManifestReadAuditSnapshot,
): ManifestReadAuditSnapshot {
  return {
    selectAuthorizations: total.selectAuthorizations - earlier.selectAuthorizations,
    transcriptTableReads: total.transcriptTableReads - earlier.transcriptTableReads,
    writeAuthorizations: total.writeAuthorizations - earlier.writeAuthorizations,
  };
}

function compareIdentity(left: SessionIdentity, right: SessionIdentity): number {
  return (
    compareBinary(left.source.kind, right.source.kind) ||
    compareBinary(left.source.instanceId, right.source.instanceId) ||
    compareBinary(left.nativeId, right.nativeId)
  );
}

function compareBinary(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameSource(left: SourceInstance, right: SourceInstance): boolean {
  return left.kind === right.kind && left.instanceId === right.instanceId;
}

interface DocumentCounts {
  readonly relations: number;
  readonly entries: number;
  readonly segments: number;
  readonly omittedSegments: number;
  readonly textUtf8Bytes: number;
}

function documentCounts(document: SessionDocument): DocumentCounts {
  let segments = 0;
  let omittedSegments = 0;
  let textUtf8Bytes = 0;
  for (const entry of document.entries) {
    segments += entry.content.length;
    for (const segment of entry.content) {
      if (segment.kind === "omitted") omittedSegments += 1;
      else textUtf8Bytes += Buffer.byteLength(segment.text, "utf8");
    }
  }
  return {
    relations: document.relations.length,
    entries: document.entries.length,
    segments,
    omittedSegments,
    textUtf8Bytes,
  };
}

function emptyDocumentCounts(): DocumentCounts {
  return { relations: 0, entries: 0, segments: 0, omittedSegments: 0, textUtf8Bytes: 0 };
}

function addDocumentCounts(total: DocumentCounts, document: SessionDocument): DocumentCounts {
  const counts = documentCounts(document);
  return {
    relations: total.relations + counts.relations,
    entries: total.entries + counts.entries,
    segments: total.segments + counts.segments,
    omittedSegments: total.omittedSegments + counts.omittedSegments,
    textUtf8Bytes: total.textUtf8Bytes + counts.textUtf8Bytes,
  };
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

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

interface ManifestReadAudit {
  readonly snapshot: () => ManifestReadAuditSnapshot;
}

interface ManifestReadAuditSnapshot {
  readonly selectAuthorizations: number;
  readonly transcriptTableReads: number;
  readonly writeAuthorizations: number;
}
