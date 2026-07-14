export const writerCoordinationMigration = {
  version: 3,
  name: "writer_coordination",
  sql: `CREATE TABLE sessions_writer_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  purpose TEXT CHECK (purpose IN ('index', 'clear')),
  owner_token TEXT CHECK (owner_token <> ''),
  acquired_at TEXT,
  heartbeat_at TEXT,
  expires_at TEXT,
  CHECK (
    (
      purpose IS NULL
      AND owner_token IS NULL
      AND acquired_at IS NULL
      AND heartbeat_at IS NULL
      AND expires_at IS NULL
    )
    OR
    (
      purpose IS NOT NULL
      AND owner_token IS NOT NULL
      AND acquired_at IS NOT NULL
      AND heartbeat_at IS NOT NULL
      AND expires_at IS NOT NULL
    )
  )
) STRICT;

INSERT INTO sessions_writer_lease (singleton, generation)
VALUES (1, 0);
`,
} as const;
