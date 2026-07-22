import type { DatabaseSync } from "node:sqlite";

import type { LineageCoverage } from "../../domain/session.ts";

export class CodexStateSchemaError extends Error {
  readonly kind: "malformed" | "unsupported-format";

  constructor(kind: "malformed" | "unsupported-format") {
    super("Codex state database is not supported");
    this.name = "CodexStateSchemaError";
    this.kind = kind;
  }
}

export interface CodexThreadState {
  readonly id: string;
  readonly rolloutPath: string;
  readonly title?: string;
  readonly workspace?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly rowTuple: readonly unknown[];
  readonly parentId?: string;
  readonly spawnEdgeCoverage: LineageCoverage;
  readonly edgeTuple: readonly unknown[];
}

export interface CodexStateGeneration {
  readonly threads: readonly CodexThreadState[];
}

type RawEdgeRow = Readonly<Record<string, unknown>>;
type RawEdgeGroups = ReadonlyMap<unknown, readonly RawEdgeRow[]>;

const THREAD_OPTIONAL_COLUMNS = [
  "title",
  "cwd",
  "created_at_ms",
  "created_at",
  "updated_at_ms",
  "updated_at",
] as const;

export function materializeCodexState(database: DatabaseSync): CodexStateGeneration {
  const threadColumns = tableColumns(database, "threads", true);
  if (!threadColumns.has("id") || !threadColumns.has("rollout_path")) {
    throw new CodexStateSchemaError("unsupported-format");
  }
  const selected = THREAD_OPTIONAL_COLUMNS.filter((column) => threadColumns.has(column));
  const query = `SELECT id, rollout_path${selected.map((column) => `, "${column}"`).join("")}
                 FROM threads
                 ORDER BY id COLLATE BINARY`;
  const statement = database.prepare(query);
  statement.setReadBigInts(true);
  const rows = statement.all() as readonly Record<string, unknown>[];

  const edgeColumns = tableColumns(database, "thread_spawn_edges", false);
  if (
    edgeColumns !== undefined &&
    (!edgeColumns.has("parent_thread_id") || !edgeColumns.has("child_thread_id"))
  ) {
    throw new CodexStateSchemaError("unsupported-format");
  }
  const statusCapability = edgeColumns?.has("status") ?? false;
  const edgeGroups =
    edgeColumns === undefined ? undefined : readEdgeGroups(database, statusCapability);

  const admittedIds = new Set<string>();
  const threads = rows.map((row) => {
    const thread = readThread(row, threadColumns, edgeGroups, statusCapability);
    if (admittedIds.has(thread.id)) throw new CodexStateSchemaError("malformed");
    admittedIds.add(thread.id);
    return thread;
  });
  return Object.freeze({ threads: Object.freeze(threads) });
}

function readThread(
  row: Readonly<Record<string, unknown>>,
  columns: ReadonlySet<string>,
  edgeGroups: RawEdgeGroups | undefined,
  statusCapability: boolean,
): CodexThreadState {
  const id = requiredText(row.id);
  const rolloutPath = requiredText(row.rollout_path);
  const title = optionalText(row.title, columns.has("title"));
  const workspace = optionalText(row.cwd, columns.has("cwd"));
  const created = timestampValue(row, columns, "created_at_ms", "created_at");
  const updated = timestampValue(row, columns, "updated_at_ms", "updated_at");
  const edge = readEdge(edgeGroups, id, statusCapability);
  return Object.freeze({
    id,
    rolloutPath,
    ...(title.value === undefined ? {} : { title: title.value }),
    ...(workspace.value === undefined ? {} : { workspace: workspace.value }),
    ...(created.iso === undefined ? {} : { createdAt: created.iso }),
    ...(updated.iso === undefined ? {} : { updatedAt: updated.iso }),
    rowTuple: Object.freeze([
      "codex-thread-row-v1",
      Object.freeze(["id", "text", id]),
      Object.freeze(["rollout_path", "text", rolloutPath]),
      Object.freeze(["title", title.tag, ...(title.tag === "text" ? [title.raw] : [])]),
      Object.freeze(["cwd", workspace.tag, ...(workspace.tag === "text" ? [workspace.raw] : [])]),
      Object.freeze(["created", created.source, created.raw, created.iso ?? null]),
      Object.freeze(["updated", updated.source, updated.raw, updated.iso ?? null]),
    ]),
    ...(edge.parentId === undefined ? {} : { parentId: edge.parentId }),
    spawnEdgeCoverage: edge.coverage,
    edgeTuple: edge.tuple,
  });
}

function readEdge(
  groups: RawEdgeGroups | undefined,
  childId: string,
  statusCapability: boolean,
): {
  readonly parentId?: string;
  readonly coverage: LineageCoverage;
  readonly tuple: readonly unknown[];
} {
  if (groups === undefined) {
    return {
      coverage: "unknown",
      tuple: Object.freeze(["codex-parent-edge-v1", "table-absent"]),
    };
  }
  const rows = groups.get(childId) ?? [];
  if (rows.length > 1) throw new CodexStateSchemaError("malformed");
  const capability = statusCapability ? "status-present" : "status-absent";
  const row = rows[0];
  if (row === undefined) {
    return {
      coverage: "complete",
      tuple: Object.freeze(["codex-parent-edge-v1", "row-absent", capability]),
    };
  }
  const parentId = requiredText(row.parent_thread_id);
  const admittedChild = requiredText(row.child_thread_id);
  if (admittedChild !== childId) throw new CodexStateSchemaError("malformed");
  const status = statusCapability ? nullableText(row.status) : null;
  return {
    parentId,
    coverage: "complete",
    tuple: Object.freeze([
      "codex-parent-edge-v1",
      "row",
      parentId,
      admittedChild,
      capability,
      status,
    ]),
  };
}

function readEdgeGroups(database: DatabaseSync, statusCapability: boolean): RawEdgeGroups {
  const statement = database.prepare(
    `SELECT admitted.admitted_child_id,
            edges.parent_thread_id,
            edges.child_thread_id${statusCapability ? ", edges.status" : ""}
     FROM (
       SELECT DISTINCT id COLLATE BINARY AS admitted_child_id
       FROM threads
     ) AS admitted
     JOIN thread_spawn_edges AS edges
       ON edges.child_thread_id = admitted.admitted_child_id
     ORDER BY admitted.admitted_child_id COLLATE BINARY,
              edges.parent_thread_id COLLATE BINARY`,
  );
  statement.setReadBigInts(true);
  const rows = statement.all() as readonly RawEdgeRow[];
  const groups = new Map<unknown, RawEdgeRow[]>();
  for (const row of rows) {
    const key = row.admitted_child_id;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }
  return groups;
}

function tableColumns(database: DatabaseSync, table: string, required: true): ReadonlySet<string>;
function tableColumns(
  database: DatabaseSync,
  table: string,
  required: false,
): ReadonlySet<string> | undefined;
function tableColumns(
  database: DatabaseSync,
  table: string,
  required: boolean,
): ReadonlySet<string> | undefined {
  const exists = database.prepare("SELECT type FROM sqlite_schema WHERE name = ?").get(table) as
    | { readonly type?: unknown }
    | undefined;
  if (exists === undefined) {
    if (required) throw new CodexStateSchemaError("unsupported-format");
    return undefined;
  }
  if (exists.type !== "table") throw new CodexStateSchemaError("unsupported-format");
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as readonly {
    readonly name?: unknown;
  }[];
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.name !== "string" || row.name.length === 0) {
      throw new CodexStateSchemaError("malformed");
    }
    names.add(row.name);
  }
  return names;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) {
    throw new CodexStateSchemaError("malformed");
  }
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new CodexStateSchemaError("malformed");
  }
  return value;
}

function optionalText(
  value: unknown,
  present: boolean,
): {
  readonly tag: "column-absent" | "null" | "text";
  readonly raw?: string;
  readonly value?: string;
} {
  if (!present) return { tag: "column-absent" };
  if (value === null) return { tag: "null" };
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new CodexStateSchemaError("malformed");
  }
  return value.length === 0 ? { tag: "text", raw: value } : { tag: "text", raw: value, value };
}

function timestampValue(
  row: Readonly<Record<string, unknown>>,
  columns: ReadonlySet<string>,
  millisecondsColumn: string,
  secondsColumn: string,
): { readonly source: "absent" | string; readonly raw: string | null; readonly iso?: string } {
  const hasMilliseconds = columns.has(millisecondsColumn);
  const hasSeconds = columns.has(secondsColumn);
  if (!hasMilliseconds && !hasSeconds) return { source: "absent", raw: null };
  if (hasMilliseconds && row[millisecondsColumn] !== null) {
    return admittedTimestamp(millisecondsColumn, row[millisecondsColumn], 1n);
  }
  if (hasSeconds) return admittedTimestamp(secondsColumn, row[secondsColumn], 1_000n);
  return { source: millisecondsColumn, raw: null };
}

function admittedTimestamp(
  source: string,
  value: unknown,
  multiplier: bigint,
): { readonly source: string; readonly raw: string | null; readonly iso?: string } {
  if (value === null) return { source, raw: null };
  const integer = integerValue(value);
  const milliseconds = integer * multiplier;
  if (milliseconds < -8_640_000_000_000_000n || milliseconds > 8_640_000_000_000_000n) {
    throw new CodexStateSchemaError("malformed");
  }
  const iso = new Date(Number(milliseconds)).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(iso)) throw new CodexStateSchemaError("malformed");
  return {
    source,
    raw: integer.toString(10),
    iso,
  };
}

function integerValue(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  throw new CodexStateSchemaError("malformed");
}
