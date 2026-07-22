import { DatabaseSync } from "node:sqlite";

import { describe } from "vitest";

import type { SessionIndexWriter } from "../../src/application/ports/session-index.ts";
import type { SessionDocument } from "../../src/domain/session.ts";
import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import { createSqliteSessionQuery } from "../../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import { minimalDocument, replacement } from "../contracts/session-index.contract.ts";
import {
  runSessionQueryContract,
  type SessionQueryContractFixture,
} from "../contracts/session-query.contract.ts";
import {
  SESSION_QUERY_CONTRACT_TIMES,
  sessionQueryContractCorpus,
} from "../fixtures/session-query-corpus.ts";

describe("SQLite session query contract", () => {
  runSessionQueryContract(createFixture);
});

async function createFixture(): Promise<SessionQueryContractFixture> {
  const databases: DatabaseSync[] = [];
  const createSeededQuery = async () => {
    const database = migratedDatabase();
    databases.push(database);
    await seedContractCorpus(database);
    return createSqliteSessionQuery(database);
  };
  const query = await createSeededQuery();
  const queryDatabase = databases[0]!;
  const largeDatabase = migratedDatabase();
  databases.push(largeDatabase);
  await seedLargeManifestCorpus(largeDatabase);
  return {
    query,
    largeManifestQuery: createSqliteSessionQuery(largeDatabase),
    markManifestStale(identity) {
      queryDatabase
        .prepare(
          `UPDATE sessions_session_tracking
           SET latest_fingerprint_digest = ?,
               latest_outcome = 'failed',
               latest_failure_code = 'unreadable'
           WHERE session_id = (
             SELECT tracking.session_id
             FROM sessions_session_tracking AS tracking
             JOIN sessions_source_instances AS source
               ON source.source_instance_id = tracking.source_instance_id
             WHERE source.kind = ?
               AND source.instance_id = ?
               AND tracking.native_id = ?
           )`,
        )
        .run("f".repeat(64), identity.source.kind, identity.source.instanceId, identity.nativeId);
    },
    removeManifestMetrics(identity) {
      queryDatabase
        .prepare(
          `DELETE FROM sessions_canonical_document_metrics
           WHERE session_id = (
             SELECT tracking.session_id
             FROM sessions_session_tracking AS tracking
             JOIN sessions_source_instances AS source
               ON source.source_instance_id = tracking.source_instance_id
             WHERE source.kind = ?
               AND source.instance_id = ?
               AND tracking.native_id = ?
           )`,
        )
        .run(identity.source.kind, identity.source.instanceId, identity.nativeId);
    },
    recreateQuery: createSeededQuery,
    async close() {
      for (const database of databases) database.close();
    },
  };
}

async function seedLargeManifestCorpus(database: DatabaseSync): Promise<void> {
  const source = { kind: "synthetic-manifest", instanceId: "large" } as const;
  const documents = Array.from({ length: 201 }, (_, ordinal) =>
    minimalDocument({
      source,
      nativeId: `manifest-${String(ordinal).padStart(3, "0")}`,
    }),
  );
  const lease = acquireWriterLease(database, "index", {
    now: () => new Date("2026-07-14T15:00:00.000Z"),
    token: () => "large-manifest-contract-writer",
  });
  const index = createCoordinatedSqliteSessionIndex(database, {
    lease,
    now: () => new Date("2026-07-14T15:00:00.000Z"),
  });
  try {
    await replaceCompleted(index, documents, "2026-07-14T15:00:00.000Z");
  } finally {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: () => new Date("2026-07-14T15:01:00.000Z"),
    });
  }
}

async function seedContractCorpus(database: DatabaseSync): Promise<void> {
  const corpus = sessionQueryContractCorpus();
  const lease = acquireWriterLease(database, "index", {
    now: () => new Date("2026-07-14T08:00:00.000Z"),
    token: () => "query-contract-writer",
  });
  const index = createCoordinatedSqliteSessionIndex(database, {
    lease,
    now: () => new Date("2026-07-14T08:00:00.000Z"),
  });
  try {
    await replaceCompleted(index, [corpus.present], SESSION_QUERY_CONTRACT_TIMES.present);

    await replaceCompleted(index, [corpus.missing], "2026-07-14T10:30:00.000Z");
    const missingRun = await index.startRun({
      source: corpus.missing.identity.source,
      startedAt: SESSION_QUERY_CONTRACT_TIMES.missing,
    });
    await index.recordMissingBatch(missingRun, [corpus.missing.identity]);
    await index.finishRun(missingRun, {
      status: "completed",
      finishedAt: "2026-07-14T11:01:00.000Z",
    });

    await replaceCompleted(index, [corpus.unknown], SESSION_QUERY_CONTRACT_TIMES.present);
    const unknownRun = await index.startRun({
      source: corpus.unknown.identity.source,
      startedAt: SESSION_QUERY_CONTRACT_TIMES.unknown,
    });
    await index.finishRun(unknownRun, {
      status: "incomplete",
      failure: "discovery-failed",
      finishedAt: "2026-07-14T12:01:00.000Z",
    });

    await replaceCompleted(index, [corpus.literalAny], "2026-07-14T13:15:00.000Z");
    await replaceCompleted(index, corpus.pageable, SESSION_QUERY_CONTRACT_TIMES.pageable);
    for (const documents of groupBySource([
      ...corpus.inventory.documents,
      ...corpus.ranking.documents,
    ])) {
      await replaceCompleted(index, documents, "2026-07-14T13:30:00.000Z");
    }
  } finally {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: () => new Date("2026-07-14T14:00:00.000Z"),
    });
  }
}

async function replaceCompleted(
  index: SessionIndexWriter,
  documents: readonly SessionDocument[],
  startedAt: string,
): Promise<void> {
  const source = documents[0]?.identity.source;
  if (source === undefined) throw new Error("Query contract source must have documents");
  const run = await index.startRun({ source, startedAt });
  for (const [ordinal, document] of documents.entries()) {
    await index.replaceSession(
      run,
      replacement(document.identity, `query-contract-${startedAt}-${String(ordinal)}`, document),
    );
  }
  await index.finishRun(run, {
    status: "completed",
    finishedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
  });
}

function groupBySource(documents: readonly SessionDocument[]): readonly SessionDocument[][] {
  const groups = new Map<string, SessionDocument[]>();
  for (const document of documents) {
    const source = document.identity.source;
    const sourceKey = JSON.stringify([source.kind, source.instanceId]);
    const group = groups.get(sourceKey) ?? [];
    group.push(document);
    groups.set(sourceKey, group);
  }
  return [...groups.values()];
}

function migratedDatabase(): DatabaseSync {
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
