export const INDEX_GENERATION_RECEIPT_TABLE = "sessions_index_generation_receipt";

export const INDEX_GENERATION_RECEIPT_TABLE_SQL = `CREATE TABLE sessions_index_generation_receipt (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  receipt_version INTEGER NOT NULL CHECK (receipt_version = 1),
  writer_generation INTEGER NOT NULL
    CHECK (writer_generation BETWEEN 1 AND 9007199254740991),
  schema_version INTEGER NOT NULL
    CHECK (schema_version BETWEEN 1 AND 9007199254740991),
  schema_cookie INTEGER NOT NULL
    CHECK (schema_cookie BETWEEN 0 AND 9007199254740991),
  operation_sequence INTEGER NOT NULL
    CHECK (operation_sequence BETWEEN 0 AND 9007199254740991)
) STRICT`;

export const indexGenerationReceiptMigration = {
  version: 3,
  name: "index-generation-receipt",
  sql: `${INDEX_GENERATION_RECEIPT_TABLE_SQL};`,
} as const;
