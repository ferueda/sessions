import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TextDecoder } from "node:util";

import type {
  CursorCheckpoint,
  MaterializedCursorAgent,
  MaterializedCursorCatalog,
} from "./discovery.ts";
import type { CursorCatalogInventory } from "./inventory.ts";

const CHECKPOINT_KEYS = new Set(["blobId", "storeKind"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

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
           typeof(agent_id) AS agent_id_type,
           CAST(agent_id AS BLOB) AS agent_id_bytes,
           typeof(workspace_ref) AS workspace_ref_type,
           CAST(workspace_ref AS BLOB) AS workspace_ref_bytes,
           typeof(status) AS status_type,
           CAST(status AS BLOB) AS status_bytes,
           typeof(active_run_id) AS active_run_id_type,
           CAST(active_run_id AS BLOB) AS active_run_id_bytes,
           typeof(latest_checkpoint_ref_json) AS latest_checkpoint_ref_json_type,
           CAST(latest_checkpoint_ref_json AS BLOB) AS latest_checkpoint_ref_json_bytes,
           typeof(name) AS name_type,
           CAST(name AS BLOB) AS name_bytes,
           typeof(metadata_json) AS metadata_json_type,
           CAST(metadata_json AS BLOB) AS metadata_json_bytes,
           typeof(created_at) AS created_at_type,
           CAST(created_at AS BLOB) AS created_at_bytes,
           typeof(updated_at) AS updated_at_type,
           CAST(updated_at AS BLOB) AS updated_at_bytes
         FROM agents
         ORDER BY CAST(agent_id AS BLOB)`,
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
  const agentId = requiredNonemptyString(readText(row, "agent_id"));
  const workspaceRef = readText(row, "workspace_ref");
  const status = readText(row, "status");
  const activeRunId = readOptionalText(row, "active_run_id");
  const checkpoint = parseCheckpoint(readOptionalText(row, "latest_checkpoint_ref_json") ?? null);
  const title = readOptionalText(row, "name");
  const metadataJson = readText(row, "metadata_json");
  parseMetadata(metadataJson);
  const createdAt = canonicalTimestamp(readText(row, "created_at"));
  const updatedAt = canonicalTimestamp(readText(row, "updated_at"));
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
  if (!isRecord(parsed)) {
    throw new CursorCatalogError("malformed");
  }
  if (!Object.hasOwn(parsed, "blobId") || !Object.hasOwn(parsed, "storeKind")) {
    throw new CursorCatalogError("malformed");
  }
  if (
    typeof parsed.blobId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(parsed.blobId) ||
    typeof parsed.storeKind !== "string"
  ) {
    throw new CursorCatalogError("malformed");
  }
  if (
    Object.keys(parsed).length !== CHECKPOINT_KEYS.size ||
    Object.keys(parsed).some((key) => !CHECKPOINT_KEYS.has(key)) ||
    parsed.storeKind !== "local-agent-store"
  ) {
    throw new CursorCatalogError("unsupported-format");
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

function canonicalTimestamp(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== timestamp) {
    throw new CursorCatalogError("malformed");
  }
  return timestamp;
}

function requiredNonemptyString(value: string): string {
  if (value.length === 0) throw new CursorCatalogError("malformed");
  return value;
}

function readText(row: Record<string, unknown>, field: string): string {
  if (row[`${field}_type`] !== "text") {
    throw new CursorCatalogError("malformed");
  }
  const bytes = row[`${field}_bytes`];
  if (!(bytes instanceof Uint8Array)) throw new CursorCatalogError("malformed");
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new CursorCatalogError("malformed");
  }
}

function readOptionalText(row: Record<string, unknown>, field: string): string | undefined {
  const type = row[`${field}_type`];
  const bytes = row[`${field}_bytes`];
  if (type === "null" && bytes === null) return undefined;
  if (type !== "text" || !(bytes instanceof Uint8Array)) {
    throw new CursorCatalogError("malformed");
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new CursorCatalogError("malformed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
