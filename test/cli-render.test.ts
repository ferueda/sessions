import { describe, expect, test } from "vitest";

import type { ShowSessionResult } from "../src/application/show-session.ts";
import {
  renderDataCompact,
  renderDataRepairOrphans,
  renderList,
  renderPaths,
  renderSearch,
  renderShow,
} from "../src/cli/render.ts";

const identity = {
  source: { kind: "synthetic", instanceId: "one" },
  nativeId: "session",
} as const;

describe("human CLI rendering", () => {
  test.each([
    ["absent", 0, 0, 0],
    ["unchanged", 4096, 4096, 0],
    ["compacted", 8192, 4096, 4096],
  ] as const)(
    "renders exact aggregate bytes for %s compaction",
    (outcome, before, after, reclaimed) => {
      const report = {
        schemaVersion: 1,
        command: "data-compact",
        outcome,
        databaseBytesBefore: before,
        databaseBytesAfter: after,
        reclaimedDatabaseBytes: reclaimed,
      } as const;

      expect(renderDataCompact(report, "human")).toBe(
        `Compaction outcome: ${outcome}. Database bytes before: ${String(before)}; after: ${String(after)}; reclaimed: ${String(reclaimed)}.\n`,
      );
      expect(renderDataCompact(report, "json")).toBe(`${JSON.stringify(report, null, 2)}\n`);
    },
  );

  test.each([
    ["unchanged", "0", "0"],
    ["repaired", "9007199254740993", "9223372036854775807"],
  ] as const)(
    "renders exact aggregate logical deletion for %s orphan repair",
    (outcome, rows, bytes) => {
      const report = {
        schemaVersion: 1,
        command: "data-repair-orphans",
        outcome,
        deletedContentRows: rows,
        deletedContentBytes: bytes,
      } as const;

      expect(renderDataRepairOrphans(report, "human")).toBe(
        `Orphan repair outcome: ${outcome}. Deleted canonical content rows: ${rows}; deleted logical UTF-8 bytes: ${bytes}.\n`,
      );
      expect(renderDataRepairOrphans(report, "json")).toBe(`${JSON.stringify(report, null, 2)}\n`);
    },
  );

  test("escapes controls in reported local paths", () => {
    const output = renderPaths(
      {
        schemaVersion: 1,
        command: "paths",
        library: {
          directory: "/data/\u001b[31m",
          scratch: "/data/.scratch",
          database: "/data/sessions.sqlite3",
          wal: "/data/sessions.sqlite3-wal",
          shm: "/data/sessions.sqlite3-shm",
          initialized: false,
          state: "uninitialized",
          schemaVersion: null,
          supportedSchemaVersion: 1,
        },
        sources: [],
      },
      "human",
    );

    expect(output).toContain("/data/\\u{1b}[31m");
    expect(output).not.toContain("\u001b");
  });

  test("shows capture and source state while escaping untrusted scalars", () => {
    const result: ShowSessionResult = {
      summary: {
        identity,
        title: "title\u001b[31m",
        freshness: "current",
        sourceState: "missing",
        capturedAt: "2026-07-14T00:00:00.000Z",
      },
      entries: [
        {
          ordinal: 0,
          actor: "tool",
          kind: "tool-call",
          toolName: "run\u001b",
          toolNamespace: "local",
          toolCallId: "call\u0007",
          relatedEntryOrdinal: 1,
          sourceLocator: { uri: "synthetic://hidden" },
          content: [
            {
              ordinal: 0,
              kind: "text",
              text: "payload\u001b[2J",
              contentHash: { scheme: "sha256-utf8-v1", digest: "0".repeat(64) },
              origin: "tool",
              originConfidence: "high",
              sourceMetadata: { hidden: "value" },
            },
            {
              ordinal: 1,
              kind: "omitted",
              contentClass: "image",
              sourceType: "input-image",
              origin: "tool",
              originConfidence: "high",
              sourceMetadata: { hidden: "value" },
            },
          ],
        },
      ],
      firstEntry: 0,
      lastEntry: 0,
      totalEntries: 1,
    };

    const output = renderShow(result);

    expect(output).toContain("[current; missing; 2026-07-14T00:00:00.000Z]");
    expect(output).toContain("tool=local/run\\u{1b}");
    expect(output).toContain("call=call\\u{07} related=#1");
    expect(output).toContain("payload\\u{1b}[2J");
    expect(output).toContain("<omitted image input-image>");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("synthetic://hidden");
    expect(output).not.toContain("sourceMetadata");
  });

  test("bounds untrusted list and transcript scalars by UTF-8 bytes", () => {
    const oversized = "é".repeat(10_000);
    const list = renderList({
      sessions: [
        {
          identity,
          title: oversized,
          freshness: "current",
          sourceState: "present",
        },
      ],
    });
    const show = renderShow({
      summary: { identity, freshness: "current", sourceState: "present" },
      entries: [
        {
          ordinal: 0,
          actor: "human",
          kind: "message",
          sourceLocator: { uri: "synthetic://hidden" },
          content: [
            {
              ordinal: 0,
              kind: "text",
              text: oversized,
              contentHash: { scheme: "sha256-utf8-v1", digest: "0".repeat(64) },
              origin: "human",
              originConfidence: "high",
              sourceMetadata: {},
            },
          ],
        },
      ],
      firstEntry: 0,
      lastEntry: 0,
      totalEntries: 1,
    });

    expect(list).toContain("… [truncated]");
    expect(show).toContain("… [truncated]");
    expect(Buffer.byteLength(list, "utf8")).toBeLessThan(9_000);
    expect(Buffer.byteLength(show, "utf8")).toBeLessThan(9_000);
  });

  test("renders bounded search evidence, linked context, support, and continuation", () => {
    const output = renderSearch({
      hits: [
        {
          session: {
            identity,
            title: "match\u001b[31m",
            freshness: "current",
            sourceState: "present",
            capturedAt: "2026-07-14T12:00:00.000Z",
          },
          entry: {
            ordinal: 4,
            kind: "tool-call",
            actor: "tool",
            toolName: "exec\u001b",
            toolNamespace: "shell",
            relatedEntryOrdinal: 9,
          },
          snippet: {
            segmentOrdinal: 1,
            origin: "tool",
            originConfidence: "high",
            text: `${"é".repeat(400)}\u001b[2J`,
            truncated: true,
            additionalMatchingSegments: 2,
          },
          context: [
            {
              ordinal: 9,
              kind: "tool-result",
              actor: "tool",
              relatedEntryOrdinal: 4,
              body: "result\u0007",
              bodyTruncated: false,
              adjacent: false,
              linked: true,
            },
          ],
          linkedContextTruncated: true,
        },
      ],
      support: {
        occurrences: 3,
        uniqueContent: 2,
        uniqueKnownRoots: 1,
        unknownLineageSessions: 0,
      },
      nextCursor: "cursor-token" as never,
    });

    expect(output).toContain("synthetic@one:session");
    expect(output).toContain("match\\u{1b}[31m");
    expect(output).toContain("[current; present; 2026-07-14T12:00:00.000Z]");
    expect(output).toContain("tool=shell/exec\\u{1b}");
    expect(output).toContain("Context (linked) #9 tool tool-result related=#4");
    expect(output).toContain("result\\u{07}");
    expect(output).toContain("Linked context: truncated at 20 entries");
    expect(output).toContain("Support: 3 occurrence(s); 2 unique content value(s)");
    expect(output).toContain("Next cursor: cursor-token");
    expect(output).not.toContain("\u001b");
    expect(Buffer.byteLength(output.split("\n")[2]!, "utf8")).toBeLessThanOrEqual(512);
  });
});
