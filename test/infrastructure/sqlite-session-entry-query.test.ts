import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { hashContent } from "../../src/domain/content-hash.ts";
import { createSessionEntryQuery } from "../../src/domain/session-query.ts";
import type { SessionDocument, SessionIdentity } from "../../src/domain/session.ts";
import {
  applyMigrations,
  CURRENT_INDEX_SCHEMA_VERSION,
} from "../../src/infrastructure/sqlite/migrations.ts";
import { createCoordinatedSqliteSessionIndex } from "../../src/infrastructure/sqlite/sqlite-session-index.ts";
import { createSqliteSessionQuery } from "../../src/infrastructure/sqlite/sqlite-session-query.ts";
import {
  acquireWriterLease,
  interruptOwnedRunsAndReleaseWriterLease,
} from "../../src/infrastructure/sqlite/writer-lease.ts";
import { initializeWriterRecoveryReceipt } from "../../src/infrastructure/sqlite/writer-recovery-receipt.ts";
import { replacement } from "../contracts/session-index.contract.ts";

describe("SQLite session entry query", () => {
  test("hydrates only the selected page and excludes storage-only entry fields", async () => {
    const database = migratedDatabase();
    const safeText = "safe retained entry evidence";
    const corruptText = "later corrupt retained entry evidence";
    try {
      await seed(database, [document("a-safe", safeText), document("b-corrupt", corruptText)]);
      const repository = createSqliteSessionQuery(database);
      const first = await repository.entries(
        createSessionEntryQuery({
          filter: { source: SOURCE.kind, instance: SOURCE.instanceId },
          limit: 1,
        }),
      );

      expect(first.entries).toHaveLength(1);
      expect(first.entries[0]).toMatchObject({
        session: { identity: identity("a-safe") },
        entry: { ordinal: 0, kind: "message", actor: "human" },
        root: { kind: "known", root: identity("a-safe") },
        content: {
          textSegmentCount: 1,
          omittedSegmentCount: 0,
          unpreviewedTextSegmentCount: 0,
          preview: {
            segmentOrdinal: 0,
            contentHash: hashContent(safeText),
            text: safeText,
            truncated: false,
          },
        },
      });
      expect(first.nextCursor).toBeDefined();
      expect(first.entries[0]?.entry).not.toHaveProperty("sourceLocator");
      expect(first.entries[0]?.content.preview).not.toHaveProperty("sourceMetadata");
      expect(JSON.stringify(first)).not.toContain("locator-private-marker");
      expect(JSON.stringify(first)).not.toContain("metadata-private-marker");

      database.exec("DROP TRIGGER sessions_content_values_bu");
      database
        .prepare("UPDATE sessions_content_values SET digest = zeroblob(32) WHERE text = ?")
        .run(corruptText);

      await expect(
        repository.entries(
          createSessionEntryQuery({
            filter: { source: SOURCE.kind, instance: SOURCE.instanceId },
            limit: 1,
          }),
        ),
      ).resolves.toEqual(first);
      if (first.nextCursor === undefined) throw new Error("Expected entry continuation");
      await expect(
        repository.entries(
          createSessionEntryQuery({
            filter: { source: SOURCE.kind, instance: SOURCE.instanceId },
            limit: 1,
            cursor: first.nextCursor,
          }),
        ),
      ).rejects.toMatchObject({ code: "corrupt-data" });
    } finally {
      database.close();
    }
  });
});

const SOURCE = { kind: "synthetic-entry-focus", instanceId: "local" } as const;

function identity(nativeId: string): SessionIdentity {
  return { source: SOURCE, nativeId };
}

function document(nativeId: string, text: string): SessionDocument {
  return {
    identity: identity(nativeId),
    title: `Focused entry ${nativeId}`,
    workspace: "/workspace/internal-filter-only",
    lineageCoverage: "complete",
    relations: [],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        timestamp: "2026-07-15T12:00:00.000Z",
        sourceLocator: {
          uri: "memory://locator-private-marker",
          recordId: "private-record",
        },
        content: [
          {
            kind: "text",
            ordinal: 0,
            text,
            contentHash: hashContent(text),
            origin: "human",
            originConfidence: "high",
            sourceMetadata: { marker: "metadata-private-marker" },
          },
        ],
      },
    ],
  };
}

async function seed(database: DatabaseSync, documents: readonly SessionDocument[]): Promise<void> {
  const now = () => new Date("2026-07-15T12:00:00.000Z");
  const lease = acquireWriterLease(database, "index", {
    now,
    token: () => "entry-query-focused-writer",
  });
  initializeWriterRecoveryReceipt(database, lease, {
    now,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
  });
  const index = createCoordinatedSqliteSessionIndex(database, {
    lease,
    now,
    schemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
  });
  try {
    const run = await index.startRun({ source: SOURCE, startedAt: now().toISOString() });
    for (const [ordinal, candidate] of documents.entries()) {
      await index.replaceSession(
        run,
        replacement(candidate.identity, `entry-focused-${String(ordinal)}`, candidate),
      );
    }
    await index.finishRun(run, {
      status: "completed",
      finishedAt: "2026-07-15T12:01:00.000Z",
    });
  } finally {
    interruptOwnedRunsAndReleaseWriterLease(database, lease, {
      now: () => new Date("2026-07-15T12:02:00.000Z"),
    });
  }
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
