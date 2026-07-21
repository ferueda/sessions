export const sessionDocumentMetricsMigration = {
  version: 2,
  name: "session-document-metrics",
  sql: `CREATE TABLE sessions_canonical_document_metrics (
  session_id INTEGER PRIMARY KEY
    REFERENCES sessions_canonical_sessions(session_id) ON DELETE CASCADE,
  relation_count INTEGER NOT NULL
    CHECK (relation_count BETWEEN 0 AND 9007199254740991),
  entry_count INTEGER NOT NULL
    CHECK (entry_count BETWEEN 0 AND 9007199254740991),
  segment_count INTEGER NOT NULL
    CHECK (segment_count BETWEEN 0 AND 9007199254740991),
  omitted_segment_count INTEGER NOT NULL
    CHECK (omitted_segment_count BETWEEN 0 AND 9007199254740991),
  text_utf8_bytes INTEGER NOT NULL
    CHECK (text_utf8_bytes BETWEEN 0 AND 9007199254740991),
  CHECK (omitted_segment_count <= segment_count)
) STRICT;

WITH
relation_metrics AS (
  SELECT session_id, COUNT(*) AS relation_count
  FROM sessions_relations
  GROUP BY session_id
),
entry_metrics AS (
  SELECT session_id, COUNT(*) AS entry_count
  FROM sessions_entries
  GROUP BY session_id
),
segment_metrics AS (
  SELECT occurrence.session_id,
         COUNT(*) AS segment_count,
         COUNT(*) FILTER (WHERE occurrence.content_id IS NULL) AS omitted_segment_count,
         CASE
           WHEN COUNT(*) FILTER (
             WHERE occurrence.content_id IS NOT NULL AND content.content_id IS NULL
           ) > 0 THEN -1
           ELSE COALESCE(
             SUM(
               CASE
                 WHEN occurrence.content_id IS NULL THEN 0
                 ELSE length(CAST(content.text AS BLOB))
               END
             ),
             0
           )
         END AS text_utf8_bytes
  FROM sessions_content_occurrences AS occurrence
  LEFT JOIN sessions_content_values AS content
    ON content.content_id = occurrence.content_id
  GROUP BY occurrence.session_id
)
INSERT INTO sessions_canonical_document_metrics (
  session_id,
  relation_count,
  entry_count,
  segment_count,
  omitted_segment_count,
  text_utf8_bytes
)
SELECT canonical.session_id,
       COALESCE(relation_metrics.relation_count, 0),
       COALESCE(entry_metrics.entry_count, 0),
       COALESCE(segment_metrics.segment_count, 0),
       COALESCE(segment_metrics.omitted_segment_count, 0),
       COALESCE(segment_metrics.text_utf8_bytes, 0)
FROM sessions_canonical_sessions AS canonical
LEFT JOIN relation_metrics USING (session_id)
LEFT JOIN entry_metrics USING (session_id)
LEFT JOIN segment_metrics USING (session_id);
`,
} as const;
