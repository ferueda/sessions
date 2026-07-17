import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  materializeCursorCatalog,
  type CursorCatalogError,
} from "../../../src/adapters/cursor/catalog.ts";

const CREATED = "2026-07-16T10:00:00.000Z";
const UPDATED = "2026-07-16T10:05:00.000Z";

describe("Cursor agent catalog materialization", () => {
  test("normalizes exact rows in binary agent identity order", () => {
    const database = catalogDatabase();
    try {
      insertAgent(database, "agent-z", null);
      insertAgent(database, "agent-a", {
        blobId: "a".repeat(64),
        storeKind: "local-agent-store",
      });

      const agents = materializeCursorCatalog(database);

      expect(agents.map(({ agentId }) => agentId)).toEqual(["agent-a", "agent-z"]);
      expect(agents[0]).toMatchObject({
        agentId: "agent-a",
        checkpoint: { blobId: "a".repeat(64), storeKind: "local-agent-store" },
        createdAt: CREATED,
        updatedAt: UPDATED,
        rowFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
      expect(agents[1]?.checkpoint).toBeNull();
    } finally {
      database.close();
    }
  });

  test("allows unconsumed columns while preserving consumed column contracts", () => {
    const database = catalogDatabase("extra TEXT");
    try {
      insertAgent(database, "agent-one", null);

      expect(materializeCursorCatalog(database)).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test("rejects a changed consumed schema as unsupported", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(`
        CREATE TABLE agents (
          agent_id TEXT PRIMARY KEY,
          workspace_ref TEXT NOT NULL,
          status TEXT NOT NULL,
          active_run_id TEXT,
          latest_checkpoint_ref_json TEXT,
          name TEXT,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      expect(() => materializeCursorCatalog(database)).toThrowError(
        expect.objectContaining<Partial<CursorCatalogError>>({
          name: "CursorCatalogError",
          kind: "unsupported-format",
        }),
      );
    } finally {
      database.close();
    }
  });

  test.each([
    ["checkpoint", { checkpoint: '{"blobId":"bad","storeKind":"local-agent-store"}' }],
    ["metadata", { metadata: "{" }],
    ["timestamp", { createdAt: "2026-07-16T10:00:00Z" }],
    ["time order", { createdAt: UPDATED, updatedAt: CREATED }],
  ])("rejects malformed %s evidence", (_name, overrides) => {
    const database = catalogDatabase();
    try {
      insertAgent(database, "agent-one", null, overrides);

      expect(() => materializeCursorCatalog(database)).toThrowError(
        expect.objectContaining<Partial<CursorCatalogError>>({
          name: "CursorCatalogError",
          kind: "malformed",
        }),
      );
    } finally {
      database.close();
    }
  });
});

function catalogDatabase(extraColumn?: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      workspace_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      active_run_id TEXT,
      latest_checkpoint_ref_json TEXT,
      name TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      ${extraColumn === undefined ? "" : `, ${extraColumn}`}
    )
  `);
  return database;
}

function insertAgent(
  database: DatabaseSync,
  agentId: string,
  checkpoint: { readonly blobId: string; readonly storeKind: string } | null,
  overrides: {
    readonly checkpoint?: string;
    readonly metadata?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  } = {},
): void {
  database
    .prepare(
      `INSERT INTO agents (
         agent_id,
         workspace_ref,
         status,
         active_run_id,
         latest_checkpoint_ref_json,
         name,
         metadata_json,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      agentId,
      "opaque-workspace",
      "opaque-status",
      null,
      overrides.checkpoint ?? (checkpoint === null ? null : JSON.stringify(checkpoint)),
      null,
      overrides.metadata ?? "{}",
      overrides.createdAt ?? CREATED,
      overrides.updatedAt ?? UPDATED,
    );
}
