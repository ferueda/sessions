export const canonicalLibraryEvidenceMigration = {
  version: 4,
  name: "canonical_library_evidence",
  sql: `ALTER TABLE sessions_source_instances
ADD COLUMN coverage_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (coverage_status IN ('complete', 'unknown'));

ALTER TABLE sessions_source_instances
ADD COLUMN coverage_observed_at TEXT;

ALTER TABLE sessions_session_tracking
ADD COLUMN presence_status TEXT NOT NULL DEFAULT 'present'
  CHECK (presence_status IN ('present', 'missing'));

ALTER TABLE sessions_session_tracking
ADD COLUMN presence_observed_at TEXT;

ALTER TABLE sessions_session_tracking
ADD COLUMN captured_at TEXT;

ALTER TABLE sessions_session_tracking
ADD COLUMN last_seen_at TEXT;

UPDATE sessions_session_tracking
SET presence_status = 'missing'
WHERE latest_outcome = 'removed';

ALTER TABLE sessions_entries
ADD COLUMN tool_name TEXT
  CHECK (tool_name IS NULL OR kind = 'tool-call');

ALTER TABLE sessions_entries
ADD COLUMN tool_namespace TEXT
  CHECK (
    tool_namespace IS NULL
    OR (
      kind = 'tool-call'
      AND tool_name IS NOT NULL
    )
  );

ALTER TABLE sessions_content_occurrences
RENAME TO sessions_content_occurrences_v3;

CREATE TABLE sessions_content_occurrences (
  session_id INTEGER NOT NULL,
  entry_ordinal INTEGER NOT NULL,
  segment_ordinal INTEGER NOT NULL CHECK (segment_ordinal >= 0),
  content_id INTEGER
    REFERENCES sessions_content_values(content_id) ON DELETE RESTRICT,
  content_class TEXT
    CHECK (content_class IN ('image', 'resource', 'structured', 'unknown')),
  source_type TEXT COLLATE BINARY,
  origin TEXT NOT NULL
    CHECK (
      origin IN (
        'human',
        'injected',
        'delegated',
        'replayed-copied',
        'model',
        'tool',
        'system',
        'unknown'
      )
    ),
  confidence TEXT NOT NULL
    CHECK (confidence IN ('high', 'medium', 'low', 'unknown')),
  source_metadata_json TEXT NOT NULL
    CHECK (json_valid(source_metadata_json) AND json_type(source_metadata_json) = 'object'),
  PRIMARY KEY (session_id, entry_ordinal, segment_ordinal),
  FOREIGN KEY (session_id, entry_ordinal)
    REFERENCES sessions_entries(session_id, ordinal) ON DELETE CASCADE,
  CHECK (
    (
      content_id IS NOT NULL
      AND content_class IS NULL
      AND source_type IS NULL
    )
    OR
    (
      content_id IS NULL
      AND content_class IS NOT NULL
      AND source_type IS NOT NULL
      AND length(CAST(source_type AS BLOB)) BETWEEN 1 AND 64
      AND instr(source_type, char(0)) = 0
      AND source_type NOT GLOB '*[^a-z0-9-]*'
      AND substr(source_type, 1, 1) <> '-'
      AND substr(source_type, -1, 1) <> '-'
      AND source_type NOT GLOB '*--*'
    )
  )
) STRICT;

INSERT INTO sessions_content_occurrences (
  session_id,
  entry_ordinal,
  segment_ordinal,
  content_id,
  content_class,
  source_type,
  origin,
  confidence,
  source_metadata_json
)
SELECT
  session_id,
  entry_ordinal,
  segment_ordinal,
  content_id,
  NULL,
  NULL,
  origin,
  confidence,
  source_metadata_json
FROM sessions_content_occurrences_v3;

DROP TABLE sessions_content_occurrences_v3;

CREATE INDEX sessions_content_occurrences_content_idx
  ON sessions_content_occurrences(content_id, session_id, entry_ordinal, segment_ordinal)
  WHERE content_id IS NOT NULL;

ALTER TABLE sessions_index_runs
ADD COLUMN missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0);

ALTER TABLE sessions_index_run_items
RENAME TO sessions_index_run_items_v3;

CREATE TABLE sessions_index_run_items (
  run_id INTEGER NOT NULL
    REFERENCES sessions_index_runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
  session_id INTEGER NOT NULL
    REFERENCES sessions_session_tracking(session_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('failed', 'missing', 'removed')),
  failure_code TEXT,
  PRIMARY KEY (run_id, ordinal),
  CHECK (
    (outcome = 'failed' AND failure_code IS NOT NULL)
    OR (outcome <> 'failed' AND failure_code IS NULL)
  )
) STRICT;

INSERT INTO sessions_index_run_items (
  run_id,
  ordinal,
  session_id,
  outcome,
  failure_code
)
SELECT run_id, ordinal, session_id, outcome, failure_code
FROM sessions_index_run_items_v3;

DROP TABLE sessions_index_run_items_v3;

ALTER TABLE sessions_writer_lease
RENAME TO sessions_writer_lease_v3;

CREATE TABLE sessions_writer_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  purpose TEXT CHECK (purpose IN ('index', 'forget', 'clear')),
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

INSERT INTO sessions_writer_lease (
  singleton,
  generation,
  purpose,
  owner_token,
  acquired_at,
  heartbeat_at,
  expires_at
)
SELECT
  singleton,
  generation,
  purpose,
  owner_token,
  acquired_at,
  heartbeat_at,
  expires_at
FROM sessions_writer_lease_v3;

DROP TABLE sessions_writer_lease_v3;
`,
} as const;
