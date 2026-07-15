import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { FTS_PROJECTION_TRIGGERS } from "../src/infrastructure/sqlite/fts-projection.ts";
import { bootstrapMigration } from "../src/infrastructure/sqlite/migrations/0001-bootstrap.ts";

const PAGE_BYTES = 4_096;
const HASH_SCHEME = "sha256-utf8-v1";
const TARGET_SIZE_LIMIT_PERCENT = 60;
const CONTENT_TABLE = "sessions_content_values";
const TARGET_DIGEST_INDEX = "sessions_content_values_digest_idx";
const TARGET_DUPLICATE_GUARD = "sessions_content_values_duplicate_guard";

const REALISTIC_UNIQUE_VALUES = 50_000;
const REALISTIC_OPERATIONS = 155_000;
const COLLISION_UNIQUE_VALUES = 10_000;
const COLLISION_OPERATIONS = 31_000;
const COLLISION_BUCKETS = 100;
const COLLISION_MEMBERS_PER_BUCKET = 100;

const realisticDistribution = [
  { textBytes: 256, uniqueValues: 30_000, percent: 60 },
  { textBytes: 2_048, uniqueValues: 12_500, percent: 25 },
  { textBytes: 8_192, uniqueValues: 5_000, percent: 10 },
  { textBytes: 16_384, uniqueValues: 2_500, percent: 5 },
] as const;

const legacySchemaSql = `CREATE TABLE ${CONTENT_TABLE} (
  content_id INTEGER PRIMARY KEY,
  hash_scheme TEXT NOT NULL CHECK (hash_scheme = '${HASH_SCHEME}'),
  digest TEXT NOT NULL
    CHECK (length(digest) = 64 AND digest NOT GLOB '*[^a-f0-9]*'),
  text TEXT NOT NULL COLLATE BINARY,
  UNIQUE (hash_scheme, digest, text)
) STRICT`;

type Layout = "legacy" | "target";
type CorpusName = "realistic" | "collision";

interface ContentValue {
  readonly digest: Uint8Array;
  readonly digestHex: string;
  readonly text: string;
}

interface Corpus {
  readonly name: CorpusName;
  readonly uniqueValues: number;
  readonly internOperations: number;
  readonly values: readonly ContentValue[];
}

interface SchemaObject {
  readonly name: string;
  readonly type: "table" | "index" | "trigger";
  readonly sql: string;
}

interface ObjectMeasurement {
  readonly name: string;
  readonly bytes: number;
}

interface LayoutMeasurement {
  readonly fileBytes: number;
  readonly objectBytes: readonly ObjectMeasurement[];
  readonly internElapsedMilliseconds: number;
}

interface CorpusMeasurements {
  readonly legacy: LayoutMeasurement;
  readonly target: LayoutMeasurement;
}

interface InternStatements {
  readonly insert: StatementSync;
  readonly find: StatementSync;
}

async function main(): Promise<void> {
  let temporaryRoot: string;
  try {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "sessions-content-storage-"));
  } catch {
    throw new Error("temporary measurement directory could not be created");
  }
  let report: ReturnType<typeof createReport> | undefined;
  let failure: unknown;
  let cleanupFailed = false;

  try {
    const targetSchema = readTargetContentSchema();
    const realistic = createRealisticCorpus();
    const collision = createCollisionCorpus();

    const realisticMeasurements = await measureCorpus(temporaryRoot, realistic, targetSchema);
    const collisionMeasurements = await measureCorpus(temporaryRoot, collision, targetSchema);

    assertTargetSize(realisticMeasurements);
    report = createReport(realisticMeasurements, collisionMeasurements);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await rm(temporaryRoot, { force: true, recursive: true });
    } catch {
      cleanupFailed = true;
    }
  }

  if (failure !== undefined) {
    const cleanupSuffix = cleanupFailed ? "; temporary measurement cleanup also failed" : "";
    throw new Error(`${sanitizeFailure(failure, temporaryRoot)}${cleanupSuffix}`);
  }
  if (cleanupFailed) throw new Error("temporary measurement cleanup failed");
  invariant(report !== undefined, "measurement report was not produced");
  process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
}

async function measureCorpus(
  temporaryRoot: string,
  corpus: Corpus,
  targetSchema: readonly SchemaObject[],
): Promise<CorpusMeasurements> {
  return {
    legacy: await measureLayout(temporaryRoot, corpus, "legacy", targetSchema),
    target: await measureLayout(temporaryRoot, corpus, "target", targetSchema),
  };
}

async function measureLayout(
  temporaryRoot: string,
  corpus: Corpus,
  layout: Layout,
  targetSchema: readonly SchemaObject[],
): Promise<LayoutMeasurement> {
  const databasePath = path.join(temporaryRoot, `${corpus.name}-${layout}.sqlite3`);
  const database = new DatabaseSync(databasePath);
  let objectBytes: readonly ObjectMeasurement[];
  let internElapsedMilliseconds: number;

  try {
    configureMeasurementDatabase(database);
    createContentSchema(database, layout, targetSchema);
    if (layout === "target") assertTargetSchema(database);

    const startedAt = performance.now();
    internCorpus(database, corpus, layout);
    internElapsedMilliseconds = roundMilliseconds(performance.now() - startedAt);
    objectBytes = readObjectBytes(database);
  } finally {
    database.close();
  }

  // Journal mode is OFF for both layouts, so close is the stable file-size boundary.
  return {
    fileBytes: (await stat(databasePath)).size,
    objectBytes,
    internElapsedMilliseconds,
  };
}

function configureMeasurementDatabase(database: DatabaseSync): void {
  database.exec(`PRAGMA page_size = ${String(PAGE_BYTES)};
PRAGMA auto_vacuum = NONE;
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -16384;`);

  invariant(readPragmaInteger(database, "page_size") === PAGE_BYTES, "page size is not fixed");
}

function createContentSchema(
  database: DatabaseSync,
  layout: Layout,
  targetSchema: readonly SchemaObject[],
): void {
  if (layout === "legacy") {
    database.exec(legacySchemaSql);
    return;
  }

  for (const object of targetSchema) database.exec(object.sql);
}

function readTargetContentSchema(): readonly SchemaObject[] {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(bootstrapMigration.sql);
    const projectionTriggers = new Set<string>(FTS_PROJECTION_TRIGGERS.map(({ name }) => name));
    const rows = database
      .prepare(
        `SELECT name, type, sql
         FROM sqlite_schema
         WHERE (
           (type = 'table' AND name = ?)
           OR (tbl_name = ? AND type IN ('index', 'trigger'))
         )
           AND sql IS NOT NULL
         ORDER BY CASE type
           WHEN 'table' THEN 0
           WHEN 'index' THEN 1
           ELSE 2
         END,
         name COLLATE BINARY`,
      )
      .all(CONTENT_TABLE, CONTENT_TABLE);

    const objects = rows
      .map(readSchemaObject)
      .filter((object) => !projectionTriggers.has(object.name));
    invariant(
      objects.some((object) => object.type === "table" && object.name === CONTENT_TABLE),
      "target content table is absent",
    );
    return objects;
  } finally {
    database.close();
  }
}

function readSchemaObject(row: Record<string, unknown>): SchemaObject {
  invariant(typeof row.name === "string", "target schema object name is invalid");
  invariant(
    row.type === "table" || row.type === "index" || row.type === "trigger",
    "target schema object type is invalid",
  );
  invariant(typeof row.sql === "string", "target schema object SQL is invalid");
  return { name: row.name, type: row.type, sql: row.sql };
}

function assertTargetSchema(database: DatabaseSync): void {
  const columns = database
    .prepare(`SELECT name, type FROM pragma_table_xinfo('${CONTENT_TABLE}') ORDER BY cid`)
    .all() as readonly Record<string, unknown>[];
  invariant(
    JSON.stringify(columns) ===
      JSON.stringify([
        { name: "content_id", type: "INTEGER" },
        { name: "digest", type: "BLOB" },
        { name: "text", type: "TEXT" },
      ]),
    "target content columns do not match the shipped compact schema",
  );

  const strict = database
    .prepare(`SELECT strict FROM pragma_table_list WHERE name = ?`)
    .get(CONTENT_TABLE) as Record<string, unknown> | undefined;
  invariant(strict?.strict === 1, "target content table is not STRICT");

  const indexes = database
    .prepare(
      `SELECT list.name AS index_name,
              list."unique" AS is_unique,
              info.name AS column_name
       FROM pragma_index_list('${CONTENT_TABLE}') AS list
       JOIN pragma_index_info(list.name) AS info
       ORDER BY list.seq, info.seqno`,
    )
    .all() as readonly Record<string, unknown>[];
  invariant(
    indexes.length === 1 &&
      indexes[0]?.index_name === TARGET_DIGEST_INDEX &&
      indexes[0]?.is_unique === 0 &&
      indexes[0]?.column_name === "digest",
    "target digest index does not match the shipped compact schema",
  );
  invariant(
    indexes.every((row) => row.column_name !== "text"),
    "target schema still indexes exact text",
  );

  const guard = database
    .prepare(
      `SELECT sql
       FROM sqlite_schema
       WHERE type = 'trigger' AND name = ? AND tbl_name = ?`,
    )
    .get(TARGET_DUPLICATE_GUARD, CONTENT_TABLE) as Record<string, unknown> | undefined;
  invariant(typeof guard?.sql === "string", "target canonical duplicate guard is absent");
}

function internCorpus(database: DatabaseSync, corpus: Corpus, layout: Layout): void {
  const statements = prepareInternStatements(database, layout);
  const contentIds = new Int32Array(corpus.uniqueValues);

  database.exec("BEGIN IMMEDIATE");
  try {
    for (let operation = 0; operation < corpus.internOperations; operation += 1) {
      const valueIndex = valueIndexForOperation(operation, corpus.uniqueValues);
      const value = corpus.values[valueIndex];
      invariant(value !== undefined, "deterministic operation selected no content value");
      const contentId =
        layout === "legacy" ? internLegacy(statements, value) : internTarget(statements, value);
      const priorContentId = contentIds[valueIndex];
      if (priorContentId === 0) contentIds[valueIndex] = contentId;
      else invariant(priorContentId === contentId, "equal content did not reuse its identity");
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const rowCount = readQueryInteger(database, `SELECT count(*) AS value FROM ${CONTENT_TABLE}`);
  invariant(rowCount === corpus.uniqueValues, "unique content row count is incorrect");
  if (corpus.name === "collision") assertCollisionBuckets(database);
}

function prepareInternStatements(database: DatabaseSync, layout: Layout): InternStatements {
  if (layout === "legacy") {
    return {
      insert: database.prepare(
        `INSERT INTO ${CONTENT_TABLE} (hash_scheme, digest, text)
         VALUES (?, ?, ?)
         ON CONFLICT (hash_scheme, digest, text) DO NOTHING`,
      ),
      find: database.prepare(
        `SELECT content_id
         FROM ${CONTENT_TABLE}
         WHERE hash_scheme = ? AND digest = ? AND text = ? COLLATE BINARY`,
      ),
    };
  }

  return {
    insert: database.prepare(
      `INSERT INTO ${CONTENT_TABLE} (digest, text)
       VALUES (?, ?)
       RETURNING content_id`,
    ),
    find: database.prepare(
      `SELECT content_id
       FROM ${CONTENT_TABLE}
       WHERE digest = ? AND text = ? COLLATE BINARY
       ORDER BY content_id
       LIMIT 2`,
    ),
  };
}

function internLegacy(statements: InternStatements, value: ContentValue): number {
  statements.insert.run(HASH_SCHEME, value.digestHex, value.text);
  const rows = statements.find.all(HASH_SCHEME, value.digestHex, value.text);
  invariant(rows.length === 1, "legacy exact lookup returned an invalid match count");
  return readContentId(rows[0]);
}

function internTarget(statements: InternStatements, value: ContentValue): number {
  const rows = statements.find.all(value.digest, value.text);
  invariant(rows.length <= 1, "target exact lookup returned duplicate canonical rows");
  if (rows[0] !== undefined) return readContentId(rows[0]);
  return readContentId(statements.insert.get(value.digest, value.text));
}

function readContentId(row: Record<string, unknown> | undefined): number {
  invariant(row !== undefined, "content identity row is absent");
  return readSafeInteger(row.content_id, "content identity is invalid");
}

function assertCollisionBuckets(database: DatabaseSync): void {
  const summary = database
    .prepare(
      `SELECT count(*) AS bucket_count,
              min(member_count) AS minimum_members,
              max(member_count) AS maximum_members
       FROM (
         SELECT count(*) AS member_count
         FROM ${CONTENT_TABLE}
         GROUP BY digest
       )`,
    )
    .get() as Record<string, unknown> | undefined;
  invariant(summary !== undefined, "collision bucket summary is absent");
  invariant(
    readSafeInteger(summary.bucket_count, "collision bucket count is invalid") ===
      COLLISION_BUCKETS &&
      readSafeInteger(summary.minimum_members, "collision minimum is invalid") ===
        COLLISION_MEMBERS_PER_BUCKET &&
      readSafeInteger(summary.maximum_members, "collision maximum is invalid") ===
        COLLISION_MEMBERS_PER_BUCKET,
    "unequal forced-collision content did not coexist",
  );
}

function readObjectBytes(database: DatabaseSync): readonly ObjectMeasurement[] {
  return database
    .prepare(
      `SELECT name, sum(pgsize) AS bytes
       FROM dbstat
       GROUP BY name
       ORDER BY name COLLATE BINARY`,
    )
    .all()
    .map((row) => {
      invariant(typeof row.name === "string", "measured SQLite object name is invalid");
      return {
        name: row.name,
        bytes: readSafeInteger(row.bytes, "measured SQLite object bytes are invalid"),
      };
    });
}

function createRealisticCorpus(): Corpus {
  const values: ContentValue[] = [];
  for (const group of realisticDistribution) {
    for (let offset = 0; offset < group.uniqueValues; offset += 1) {
      const index = values.length;
      const text = fixedAsciiText("realistic", index, group.textBytes);
      const digest = createHash("sha256").update(text, "utf8").digest();
      values.push({ digest, digestHex: digest.toString("hex"), text });
    }
  }
  invariant(values.length === REALISTIC_UNIQUE_VALUES, "realistic corpus size is invalid");
  return {
    name: "realistic",
    uniqueValues: REALISTIC_UNIQUE_VALUES,
    internOperations: REALISTIC_OPERATIONS,
    values,
  };
}

function createCollisionCorpus(): Corpus {
  const bucketDigests = Array.from({ length: COLLISION_BUCKETS }, (_, bucket) =>
    createHash("sha256")
      .update(`generic-forced-bucket-${String(bucket)}`, "utf8")
      .digest(),
  );
  const values = Array.from({ length: COLLISION_UNIQUE_VALUES }, (_, index) => {
    const digest = bucketDigests[index % COLLISION_BUCKETS];
    invariant(digest !== undefined, "collision digest bucket is absent");
    return {
      digest,
      digestHex: digest.toString("hex"),
      text: fixedAsciiText("collision", index, 128),
    };
  });
  return {
    name: "collision",
    uniqueValues: COLLISION_UNIQUE_VALUES,
    internOperations: COLLISION_OPERATIONS,
    values,
  };
}

function fixedAsciiText(corpus: CorpusName, index: number, byteLength: number): string {
  const prefix = `${corpus}-${String(index).padStart(5, "0")}:`;
  invariant(prefix.length <= byteLength, "fixed corpus prefix exceeds its text size");
  const fill = String.fromCharCode(97 + (index % 26));
  const text = prefix + fill.repeat(byteLength - prefix.length);
  invariant(Buffer.byteLength(text, "utf8") === byteLength, "fixed corpus text size drifted");
  return text;
}

function valueIndexForOperation(operation: number, uniqueValues: number): number {
  if (operation < uniqueValues) return operation;
  return ((((operation - uniqueValues) * 7_919 + 17) % uniqueValues) + uniqueValues) % uniqueValues;
}

function createReport(realistic: CorpusMeasurements, collision: CorpusMeasurements): object {
  return {
    pageBytes: PAGE_BYTES,
    corpora: {
      realistic: {
        uniqueValues: REALISTIC_UNIQUE_VALUES,
        internOperations: REALISTIC_OPERATIONS,
        averageTextBytes: 2_304,
        distribution: realisticDistribution,
      },
      collision: {
        uniqueValues: COLLISION_UNIQUE_VALUES,
        internOperations: COLLISION_OPERATIONS,
        textBytes: 128,
        forcedDigestBuckets: COLLISION_BUCKETS,
        membersPerBucket: COLLISION_MEMBERS_PER_BUCKET,
      },
    },
    measurements: { realistic, collision },
    checks: {
      equalContentIdReuse: true,
      unequalCollisionContentCoexists: true,
      targetTextIndexAbsent: true,
      targetRealisticMaximumPercentOfLegacy: TARGET_SIZE_LIMIT_PERCENT,
      targetRealisticPercentOfLegacy: roundPercent(
        (realistic.target.fileBytes / realistic.legacy.fileBytes) * 100,
      ),
    },
  };
}

function assertTargetSize(measurements: CorpusMeasurements): void {
  invariant(
    measurements.target.fileBytes * 100 <=
      measurements.legacy.fileBytes * TARGET_SIZE_LIMIT_PERCENT,
    "target realistic database exceeds 60 percent of legacy",
  );
}

function readPragmaInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  invariant(row !== undefined, "SQLite pragma returned no row");
  return readSafeInteger(row[pragma], "SQLite pragma returned an invalid integer");
}

function readQueryInteger(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get();
  invariant(row !== undefined, "SQLite aggregate returned no row");
  return readSafeInteger(row.value, "SQLite aggregate returned an invalid integer");
}

function readSafeInteger(value: unknown, message: string): number {
  if (typeof value === "bigint") {
    invariant(value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER), message);
    return Number(value);
  }
  invariant(Number.isSafeInteger(value) && (value as number) >= 0, message);
  return value as number;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function sanitizeFailure(error: unknown, temporaryRoot: string): string {
  const message = error instanceof Error ? error.message : "unknown measurement failure";
  return message.split(temporaryRoot).join("<temporary-directory>");
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`content storage measurement invariant failed: ${message}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown measurement failure";
  process.stderr.write(`Content storage measurement failed: ${message}\n`);
  process.exitCode = 1;
});
