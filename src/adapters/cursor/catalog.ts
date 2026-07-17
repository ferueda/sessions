import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  CursorCheckpoint,
  MaterializedCursorAgent,
  MaterializedCursorCatalog,
} from "./discovery.ts";
import type { CursorCatalogInventory } from "./inventory.ts";

const CHECKPOINT_KEYS = new Set(["blobId", "storeKind"]);

export class CursorCatalogError extends Error {
  readonly kind: "malformed" | "unsupported-format";

  constructor(kind: CursorCatalogError["kind"]) {
    super(
      kind === "unsupported-format"
        ? "Cursor catalog format is unsupported"
        : "Cursor catalog is malformed",
    );
    this.name = "CursorCatalogError";
    this.kind = kind;
  }
}

export function materializeCursorCatalog(
  database: DatabaseSync,
): readonly MaterializedCursorAgent[] {
  validateAgentsSchema(database);
  let rows: readonly Record<string, unknown>[];
  try {
    rows = database
      .prepare(
        `SELECT
           agent_id,
           workspace_ref,
           status,
           active_run_id,
           latest_checkpoint_ref_json,
           name,
           metadata_json,
           created_at,
           updated_at
         FROM agents
         ORDER BY agent_id COLLATE BINARY`,
      )
      .all() as readonly Record<string, unknown>[];
  } catch {
    throw new CursorCatalogError("malformed");
  }
  return Object.freeze(rows.map(materializeAgent));
}

export function createMaterializedCursorCatalog(
  catalog: CursorCatalogInventory,
  database: DatabaseSync,
): MaterializedCursorCatalog {
  return Object.freeze({
    catalogComponents: catalog.catalog.main.components,
    agents: materializeCursorCatalog(database),
  });
}

function validateAgentsSchema(database: DatabaseSync): void {
  let columns: readonly Record<string, unknown>[];
  try {
    columns = database.prepare("PRAGMA table_info(agents)").all() as readonly Record<
      string,
      unknown
    >[];
  } catch {
    throw new CursorCatalogError("malformed");
  }
  const expected = [
    ["agent_id", "TEXT", 0, 1, null],
    ["workspace_ref", "TEXT", 1, 0, null],
    ["status", "TEXT", 1, 0, null],
    ["active_run_id", "TEXT", 0, 0, null],
    ["latest_checkpoint_ref_json", "TEXT", 0, 0, null],
    ["name", "TEXT", 0, 0, null],
    ["metadata_json", "TEXT", 1, 0, "'{}'"],
    ["created_at", "TEXT", 1, 0, null],
    ["updated_at", "TEXT", 1, 0, null],
  ] as const;
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (
    expected.some(([name, type, notnull, primaryKey, defaultValue]) => {
      const column = byName.get(name);
      return (
        column === undefined ||
        column.type !== type ||
        Number(column.notnull) !== notnull ||
        Number(column.pk) !== primaryKey ||
        (column.dflt_value ?? null) !== defaultValue
      );
    })
  ) {
    throw new CursorCatalogError("unsupported-format");
  }
}

function materializeAgent(row: Record<string, unknown>): MaterializedCursorAgent {
  const agentId = requiredNonemptyString(row.agent_id);
  const workspaceRef = requiredString(row.workspace_ref);
  const status = requiredString(row.status);
  const activeRunId = optionalString(row.active_run_id);
  const checkpoint = parseCheckpoint(row.latest_checkpoint_ref_json);
  const title = optionalString(row.name);
  const metadataJson = requiredString(row.metadata_json);
  parseMetadata(metadataJson);
  const createdAt = canonicalTimestamp(row.created_at);
  const updatedAt = canonicalTimestamp(row.updated_at);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new CursorCatalogError("malformed");

  const rowFingerprint = `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        "cursor-agent-row-v1",
        agentId,
        workspaceRef,
        status,
        activeRunId ?? null,
        checkpoint,
        title ?? null,
        metadataJson,
        createdAt,
        updatedAt,
      ]),
      "utf8",
    )
    .digest("hex")}`;
  return Object.freeze({
    agentId,
    checkpoint,
    rowFingerprint,
    ...(title === undefined ? {} : { title }),
    createdAt,
    updatedAt,
  });
}

function parseCheckpoint(value: unknown): CursorCheckpoint | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new CursorCatalogError("malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CursorCatalogError("malformed");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== CHECKPOINT_KEYS.size ||
    Object.keys(parsed).some((key) => !CHECKPOINT_KEYS.has(key)) ||
    parsed.storeKind !== "local-agent-store" ||
    typeof parsed.blobId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(parsed.blobId)
  ) {
    throw new CursorCatalogError("malformed");
  }
  return Object.freeze({ blobId: parsed.blobId, storeKind: "local-agent-store" });
}

function parseMetadata(value: string): void {
  try {
    JSON.parse(value);
  } catch {
    throw new CursorCatalogError("malformed");
  }
}

function canonicalTimestamp(value: unknown): string {
  const timestamp = requiredString(value);
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new CursorCatalogError("malformed");
  }
  return timestamp;
}

function requiredNonemptyString(value: unknown): string {
  const result = requiredString(value);
  if (result.length === 0) throw new CursorCatalogError("malformed");
  return result;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new CursorCatalogError("malformed");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null) return undefined;
  return requiredString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
