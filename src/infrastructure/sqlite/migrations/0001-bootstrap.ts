export const bootstrapMigration = {
  version: 1,
  name: "bootstrap",
  sql: `CREATE TABLE sessions_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;
`,
} as const;
