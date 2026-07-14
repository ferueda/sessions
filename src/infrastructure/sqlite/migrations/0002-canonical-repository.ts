export const canonicalRepositoryMigration = {
  version: 2,
  name: "canonical_repository",
  sql: `CREATE TABLE sessions_source_instances (
  source_instance_id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL COLLATE BINARY CHECK (kind <> ''),
  instance_id TEXT NOT NULL COLLATE BINARY CHECK (instance_id <> ''),
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
  latest_fingerprint_scheme TEXT,
  latest_fingerprint_digest TEXT,
  latest_adapter_version TEXT,
  latest_outcome TEXT NOT NULL
    CHECK (latest_outcome IN ('indexed', 'unchanged', 'failed', 'removed')),
  latest_failure_code TEXT,
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
    (
      latest_fingerprint_scheme IS NULL
      AND latest_fingerprint_digest IS NULL
      AND latest_adapter_version IS NULL
    )
    OR
    (
      latest_fingerprint_scheme IS NOT NULL
      AND latest_fingerprint_digest IS NOT NULL
      AND latest_adapter_version IS NOT NULL
    )
  ),
  CHECK (
    (latest_outcome = 'removed' AND latest_fingerprint_scheme IS NULL)
    OR
    (latest_outcome <> 'removed' AND latest_fingerprint_scheme IS NOT NULL)
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
  hash_scheme TEXT NOT NULL CHECK (hash_scheme = 'sha256-utf8-v1'),
  digest TEXT NOT NULL
    CHECK (length(digest) = 64 AND digest NOT GLOB '*[^a-f0-9]*'),
  text TEXT NOT NULL COLLATE BINARY,
  UNIQUE (hash_scheme, digest, text)
) STRICT;

CREATE VIRTUAL TABLE sessions_content_fts USING fts5(
  text,
  content='sessions_content_values',
  content_rowid='content_id',
  tokenize='unicode61'
);

CREATE TRIGGER sessions_content_values_ai
AFTER INSERT ON sessions_content_values
BEGIN
  INSERT INTO sessions_content_fts(rowid, text)
  VALUES (new.content_id, new.text);
END;

CREATE TRIGGER sessions_content_values_bd
BEFORE DELETE ON sessions_content_values
BEGIN
  INSERT INTO sessions_content_fts(sessions_content_fts, rowid, text)
  VALUES ('delete', old.content_id, old.text);
END;

CREATE TRIGGER sessions_content_values_bu
BEFORE UPDATE ON sessions_content_values
BEGIN
  SELECT RAISE(ABORT, 'sessions content values are immutable');
END;

CREATE TABLE sessions_content_occurrences (
  session_id INTEGER NOT NULL,
  entry_ordinal INTEGER NOT NULL,
  segment_ordinal INTEGER NOT NULL CHECK (segment_ordinal >= 0),
  content_id INTEGER NOT NULL
    REFERENCES sessions_content_values(content_id) ON DELETE RESTRICT,
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
    REFERENCES sessions_entries(session_id, ordinal) ON DELETE CASCADE
) STRICT;

CREATE INDEX sessions_content_occurrences_content_idx
  ON sessions_content_occurrences(content_id, session_id, entry_ordinal, segment_ordinal);

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
  removed_count INTEGER NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
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
  outcome TEXT NOT NULL CHECK (outcome IN ('failed', 'removed')),
  failure_code TEXT,
  PRIMARY KEY (run_id, ordinal),
  CHECK (
    (outcome = 'failed' AND failure_code IS NOT NULL)
    OR (outcome <> 'failed' AND failure_code IS NULL)
  )
) STRICT;
`,
} as const;
