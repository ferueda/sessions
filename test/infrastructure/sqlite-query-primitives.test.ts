import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { literalFtsQuery } from "../../src/infrastructure/sqlite/literal-fts-query.ts";
import { truncateUtf8Around } from "../../src/infrastructure/sqlite/sqlite-query-context.ts";
import { applyMigrations } from "../../src/infrastructure/sqlite/migrations.ts";
import {
  decodeQueryCursor,
  encodeQueryCursor,
  fingerprintQuery,
  readQueryRevision,
} from "../../src/infrastructure/sqlite/query-cursor.ts";
import { acquireWriterLease } from "../../src/infrastructure/sqlite/writer-lease.ts";

describe("SQLite query primitives", () => {
  test("quotes every public search term as literal FTS data", () => {
    expect(literalFtsQuery('alpha OR /tmp/a.ts "quoted"')).toBe(
      '"alpha" AND "OR" AND "/tmp/a.ts" AND """quoted"""',
    );
    expect(literalFtsQuery(" \t\n ")).toBeUndefined();
    expect(literalFtsQuery("\u0085")).toBeUndefined();
    expect(literalFtsQuery("alpha\u0085beta")).toBe('"alpha" AND "beta"');
    expect(literalFtsQuery('alpha OR /tmp/a.ts "quoted"', "any")).toBe(
      '"alpha" OR "OR" OR "/tmp/a.ts" OR """quoted"""',
    );
    expect(literalFtsQuery("---")).toBe('"---"');
  });

  test("binds cursors to command, query, library, and writer generation", () => {
    const first = migratedDatabase();
    const second = migratedDatabase();
    try {
      const revision = readQueryRevision(first);
      const fingerprint = fingerprintQuery('{"limit":20}');
      const cursor = encodeQueryCursor({
        command: "search",
        fingerprint,
        revision,
        offset: 20,
      });
      const entriesCursor = encodeQueryCursor({
        command: "entries",
        fingerprint,
        revision,
        offset: 40,
      });

      expect(decodeQueryCursor(cursor, { command: "search", fingerprint, revision })).toEqual({
        ok: true,
        offset: 20,
      });
      expect(
        decodeQueryCursor(cursor, {
          command: "list",
          fingerprint,
          revision,
        }),
      ).toEqual({ ok: false, reason: "mismatch" });
      expect(
        decodeQueryCursor(entriesCursor, { command: "entries", fingerprint, revision }),
      ).toEqual({ ok: true, offset: 40 });
      expect(
        decodeQueryCursor(entriesCursor, { command: "search", fingerprint, revision }),
      ).toEqual({ ok: false, reason: "mismatch" });
      expect(
        decodeQueryCursor(cursor, {
          command: "search",
          fingerprint: fingerprintQuery('{"limit":21}'),
          revision,
        }),
      ).toEqual({ ok: false, reason: "mismatch" });
      expect(
        decodeQueryCursor(cursor, {
          command: "search",
          fingerprint,
          revision: readQueryRevision(second),
        }),
      ).toEqual({ ok: false, reason: "stale" });

      acquireWriterLease(first, "index", {
        now: () => new Date("2026-07-14T12:00:00.000Z"),
        token: () => "query-test-owner",
      });
      expect(
        decodeQueryCursor(cursor, {
          command: "search",
          fingerprint,
          revision: readQueryRevision(first),
        }),
      ).toEqual({ ok: false, reason: "stale" });
    } finally {
      first.close();
      second.close();
    }
  });

  test("rejects malformed and non-canonical cursor payloads", () => {
    const database = migratedDatabase();
    try {
      const expected = {
        command: "list" as const,
        fingerprint: fingerprintQuery("{}"),
        revision: readQueryRevision(database),
      };
      expect(decodeQueryCursor("not+base64", expected)).toEqual({
        ok: false,
        reason: "invalid",
      });
      expect(decodeQueryCursor(Buffer.from("{}", "utf8").toString("base64url"), expected)).toEqual({
        ok: false,
        reason: "invalid",
      });
    } finally {
      database.close();
    }
  });

  test("bounds centered UTF-8 excerpts without splitting surrogate pairs", () => {
    const value = `${"a".repeat(511)}😀${"b".repeat(511)}`;
    const result = truncateUtf8Around(value, 512);

    expect(result.truncated).toBe(true);
    expect(result.text.isWellFormed()).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(512);
  });
});

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:", {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA trusted_schema = OFF");
  applyMigrations(database);
  return database;
}
