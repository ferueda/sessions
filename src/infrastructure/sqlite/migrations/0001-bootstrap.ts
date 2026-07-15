import { FTS_PROJECTION_SCHEMA_SQL } from "../fts-projection.ts";

export const bootstrapMigration = {
  version: 1,
  name: "bootstrap",
  sql: `CREATE TABLE sessions_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions_library (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT NOT NULL COLLATE BINARY
    CHECK (
      length(instance_id) = 32
      AND instance_id NOT GLOB '*[^a-f0-9]*'
    )
) STRICT;

INSERT INTO sessions_library (singleton, instance_id)
VALUES (1, lower(hex(randomblob(16))));

CREATE TABLE sessions_source_instances (
  source_instance_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL COLLATE BINARY CHECK (kind <> ''),
  instance_id TEXT NOT NULL COLLATE BINARY CHECK (instance_id <> ''),
  coverage_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (coverage_status IN ('complete', 'unknown')),
  coverage_observed_at TEXT,
  UNIQUE (kind, instance_id)
) STRICT;

CREATE TABLE sessions_session_tracking (
  session_id INTEGER PRIMARY KEY,
  source_instance_id INTEGER NOT NULL
    REFERENCES sessions_source_instances(source_instance_id) ON DELETE CASCADE,
  native_id TEXT NOT NULL COLLATE BINARY CHECK (native_id <> ''),
  last_good_fingerprint_scheme TEXT,
  last_good_fingerprint_digest TEXT,
  last_good_adapter_version TEXT,
  latest_fingerprint_scheme TEXT NOT NULL,
  latest_fingerprint_digest TEXT NOT NULL,
  latest_adapter_version TEXT NOT NULL,
  latest_outcome TEXT NOT NULL
    CHECK (latest_outcome IN ('indexed', 'unchanged', 'failed')),
  latest_failure_code TEXT,
  presence_status TEXT NOT NULL DEFAULT 'present'
    CHECK (presence_status IN ('present', 'missing')),
  presence_observed_at TEXT,
  captured_at TEXT,
  last_seen_at TEXT,
  UNIQUE (source_instance_id, native_id),
  CHECK (
    (
      last_good_fingerprint_scheme IS NULL
      AND last_good_fingerprint_digest IS NULL
      AND last_good_adapter_version IS NULL
    )
    OR
    (
      last_good_fingerprint_scheme IS NOT NULL
      AND last_good_fingerprint_digest IS NOT NULL
      AND last_good_adapter_version IS NOT NULL
    )
  ),
  CHECK (
    (latest_outcome = 'failed' AND latest_failure_code IS NOT NULL)
    OR
    (latest_outcome <> 'failed' AND latest_failure_code IS NULL)
  )
) STRICT;

CREATE TABLE sessions_canonical_sessions (
  session_id INTEGER PRIMARY KEY
    REFERENCES sessions_session_tracking(session_id) ON DELETE CASCADE,
  lineage_coverage TEXT NOT NULL
    CHECK (lineage_coverage IN ('complete', 'unknown')),
  title TEXT,
  workspace TEXT,
  created_at TEXT,
  updated_at TEXT
) STRICT;

CREATE TABLE sessions_relations (
  session_id INTEGER NOT NULL
    REFERENCES sessions_canonical_sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL
    CHECK (kind IN ('parent', 'child', 'fork', 'continuation', 'unknown')),
  target_kind TEXT NOT NULL COLLATE BINARY CHECK (target_kind <> ''),
  target_instance_id TEXT NOT NULL COLLATE BINARY CHECK (target_instance_id <> ''),
  target_native_id TEXT NOT NULL COLLATE BINARY CHECK (target_native_id <> ''),
  confidence TEXT NOT NULL
    CHECK (confidence IN ('high', 'medium', 'low', 'unknown')),
  PRIMARY KEY (session_id, ordinal),
  UNIQUE (session_id, kind, target_kind, target_instance_id, target_native_id)
) STRICT;

CREATE INDEX sessions_relations_target_idx
  ON sessions_relations(target_kind, target_instance_id, target_native_id);

CREATE TABLE sessions_entries (
  session_id INTEGER NOT NULL
    REFERENCES sessions_canonical_sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  kind TEXT NOT NULL,
  actor TEXT NOT NULL
    CHECK (actor IN ('human', 'model', 'tool', 'system', 'unknown')),
  timestamp TEXT,
  related_entry_ordinal INTEGER,
  tool_call_id TEXT,
  tool_name TEXT
    CHECK (tool_name IS NULL OR kind = 'tool-call'),
  tool_namespace TEXT
    CHECK (
      tool_namespace IS NULL
      OR (
        kind = 'tool-call'
        AND tool_name IS NOT NULL
      )
    ),
  source_locator_uri TEXT NOT NULL,
  source_locator_record_id TEXT,
  PRIMARY KEY (session_id, ordinal),
  CHECK (
    related_entry_ordinal IS NULL
    OR (related_entry_ordinal >= 0 AND related_entry_ordinal <> ordinal)
  ),
  FOREIGN KEY (session_id, related_entry_ordinal)
    REFERENCES sessions_entries(session_id, ordinal)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE sessions_content_values (
  content_id INTEGER PRIMARY KEY,
  digest BLOB NOT NULL CHECK (length(digest) = 32),
  text TEXT NOT NULL COLLATE BINARY
) STRICT;

CREATE INDEX sessions_content_values_digest_idx
  ON sessions_content_values(digest);

CREATE TRIGGER sessions_content_values_duplicate_guard
BEFORE INSERT ON sessions_content_values
WHEN EXISTS (
  SELECT 1
  FROM sessions_content_values AS existing
  WHERE existing.digest = new.digest
    AND existing.text = new.text COLLATE BINARY
)
BEGIN
  SELECT RAISE(ABORT, 'duplicate sessions content value');
END;

${FTS_PROJECTION_SCHEMA_SQL}

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

CREATE INDEX sessions_content_occurrences_content_idx
  ON sessions_content_occurrences(content_id, session_id, entry_ordinal, segment_ordinal)
  WHERE content_id IS NOT NULL;

CREATE TABLE sessions_index_runs (
  run_id INTEGER PRIMARY KEY,
  source_instance_id INTEGER NOT NULL
    REFERENCES sessions_source_instances(source_instance_id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'completed', 'failed', 'interrupted')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  failure_code TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  indexed_count INTEGER NOT NULL DEFAULT 0 CHECK (indexed_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  stale_count INTEGER NOT NULL DEFAULT 0 CHECK (stale_count >= 0),
  omitted_item_count INTEGER NOT NULL DEFAULT 0 CHECK (omitted_item_count >= 0),
  CHECK (discovered_count = unchanged_count + indexed_count + failed_count),
  CHECK (stale_count <= failed_count),
  CHECK (
    (
      status = 'active'
      AND finished_at IS NULL
      AND failure_code IS NULL
    )
    OR
    (
      status = 'completed'
      AND finished_at IS NOT NULL
      AND failure_code IS NULL
    )
    OR
    (
      status IN ('failed', 'interrupted')
      AND finished_at IS NOT NULL
      AND failure_code IS NOT NULL
    )
  )
) STRICT;

CREATE INDEX sessions_index_runs_retention_idx
  ON sessions_index_runs(source_instance_id, finished_at DESC, run_id DESC)
  WHERE status <> 'active';

CREATE TABLE sessions_index_run_items (
  run_id INTEGER NOT NULL
    REFERENCES sessions_index_runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 100),
  session_id INTEGER NOT NULL
    REFERENCES sessions_session_tracking(session_id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('failed', 'missing')),
  failure_code TEXT,
  PRIMARY KEY (run_id, ordinal),
  CHECK (
    (outcome = 'failed' AND failure_code IS NOT NULL)
    OR (outcome = 'missing' AND failure_code IS NULL)
  )
) STRICT;

CREATE TABLE sessions_writer_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  purpose TEXT CHECK (purpose IN ('index', 'forget', 'clear', 'compact')),
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
