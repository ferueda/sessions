import type { DatabaseSync } from "node:sqlite";

export type SqliteContentId = bigint;

export function readSessionContentCandidates(
  database: DatabaseSync,
  sessionId: number | bigint,
): readonly SqliteContentId[] {
  const statement = database.prepare(
    `SELECT DISTINCT content_id
     FROM sessions_content_occurrences
     WHERE session_id = ? AND content_id IS NOT NULL
     ORDER BY content_id`,
  );
  statement.setReadBigInts(true);
  const rows = statement.all(sessionId) as unknown as readonly {
    readonly content_id?: unknown;
  }[];
  return rows.map((row) => contentId(row.content_id));
}

export function deleteUnreferencedContentCandidates(
  database: DatabaseSync,
  candidates: readonly SqliteContentId[],
): number {
  if (candidates.length === 0) return 0;
  const statement = database.prepare(
    `DELETE FROM sessions_content_values
     WHERE content_id = ?
       AND NOT EXISTS (
         SELECT 1
         FROM sessions_content_occurrences AS occurrence
         WHERE occurrence.content_id = sessions_content_values.content_id
       )`,
  );
  let deleted = 0;
  for (const candidate of candidates) {
    deleted += changeCount(statement.run(candidate).changes);
  }
  return deleted;
}

function changeCount(value: number | bigint): number {
  if (value === 0 || value === 0n) return 0;
  if (value === 1 || value === 1n) return 1;
  throw new TypeError("Invalid canonical content deletion count");
}

function contentId(value: unknown): SqliteContentId {
  if (typeof value !== "bigint") throw new TypeError("Invalid SQLite content ID");
  return value;
}
