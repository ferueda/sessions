import { describe, expect, test } from "vitest";

import type { SelectedText, TranscriptSelection } from "../src/application/session-presentation.ts";
import type { ShowSessionResult } from "../src/application/show-session.ts";
import type { ListSessionEntriesResult } from "../src/application/list-session-entries.ts";
import {
  renderDataCompact,
  renderDataRepairOrphans,
  renderEntries,
  renderList,
  renderPaths,
  renderSearch,
  renderShow,
} from "../src/cli/render.ts";

const identity = {
  source: { kind: "synthetic", instanceId: "one" },
  nativeId: "session",
} as const;
const retainedAttribution = {
  capturedAt: "2026-07-14T00:00:00.000Z",
  sourceObservedAt: "2026-07-14T00:00:00.000Z",
  adapterVersion: "synthetic-v1",
  documentDigest: {
    scheme: "sha256-sessions-document-jcs-v1",
    digest: "0".repeat(64),
  },
} as const;

function selectedText(
  text: string,
  options: { readonly truncated?: boolean; readonly originalUtf8Bytes?: number } = {},
): SelectedText {
  const emittedUtf8Bytes = Buffer.byteLength(text, "utf8");
  return {
    text,
    truncated: options.truncated ?? false,
    originalUtf8Bytes: options.originalUtf8Bytes ?? emittedUtf8Bytes,
    emittedUtf8Bytes,
  };
}

function transcriptSelection(input: {
  readonly entries: number;
  readonly segments: number;
  readonly textBytes: number;
  readonly originalTextBytes?: number;
  readonly canonicalOmittedSegments?: number;
  readonly truncatedTextSegments?: number;
}): TranscriptSelection {
  return {
    mode: "bounded",
    relations: { selected: 0, total: 0, truncated: false },
    entries: {
      selected: input.entries,
      total: input.entries,
      truncated: false,
      firstOrdinal: input.entries === 0 ? null : 0,
      lastOrdinal: input.entries === 0 ? null : input.entries - 1,
    },
    segments: { selected: input.segments, total: input.segments, truncated: false },
    segmentText: {
      emittedUtf8Bytes: input.textBytes,
      originalUtf8Bytes: input.originalTextBytes ?? input.textBytes,
      truncated: (input.originalTextBytes ?? input.textBytes) > input.textBytes,
    },
    canonicalOmittedSegments: input.canonicalOmittedSegments ?? 0,
    truncatedTextSegments: input.truncatedTextSegments ?? 0,
  };
}

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
      snapshot: {
        identity,
        ...retainedAttribution,
        title: selectedText("title\u001b[31m"),
        freshness: "current",
        sourceState: "missing",
        lineageCoverage: "complete",
        selection: transcriptSelection({
          entries: 1,
          segments: 2,
          textBytes: Buffer.byteLength("payload\u001b[2J", "utf8"),
          canonicalOmittedSegments: 1,
        }),
      },
      relations: [],
      entries: [
        {
          ordinal: 0,
          actor: "tool",
          kind: "tool-call",
          toolName: "run\u001b",
          toolNamespace: "local",
          toolCallId: "call\u0007",
          relatedEntryOrdinal: 1,
          content: [
            {
              ordinal: 0,
              kind: "text",
              text: selectedText("payload\u001b[2J"),
              contentHash: { scheme: "sha256-utf8-v1", digest: "0".repeat(64) },
              origin: "tool",
              originConfidence: "high",
            },
            {
              ordinal: 1,
              kind: "omitted",
              contentClass: "image",
              sourceType: "input-image",
              origin: "tool",
              originConfidence: "high",
            },
          ],
          omittedSegmentCount: 0,
        },
      ],
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
    const bounded = selectedText("é".repeat(4_096), {
      truncated: true,
      originalUtf8Bytes: Buffer.byteLength(oversized, "utf8"),
    });
    const list = renderList({
      sessions: [
        {
          identity,
          ...retainedAttribution,
          title: bounded,
          freshness: "current",
          sourceState: "present",
        },
      ],
    });
    const show = renderShow({
      snapshot: {
        identity,
        ...retainedAttribution,
        freshness: "current",
        sourceState: "present",
        lineageCoverage: "complete",
        selection: transcriptSelection({
          entries: 1,
          segments: 1,
          textBytes: bounded.emittedUtf8Bytes,
          originalTextBytes: bounded.originalUtf8Bytes,
          truncatedTextSegments: 1,
        }),
      },
      relations: [],
      entries: [
        {
          ordinal: 0,
          actor: "human",
          kind: "message",
          content: [
            {
              ordinal: 0,
              kind: "text",
              text: bounded,
              contentHash: { scheme: "sha256-utf8-v1", digest: "0".repeat(64) },
              origin: "human",
              originConfidence: "high",
            },
          ],
          omittedSegmentCount: 0,
        },
      ],
    });

    expect(list).toContain("… [truncated]");
    expect(show).toContain("… [truncated]");
    expect(Buffer.byteLength(list, "utf8")).toBeLessThan(9_000);
    expect(Buffer.byteLength(show, "utf8")).toBeLessThan(9_000);
  });

  test("bounds terminal-escape expansion and displays presentation omissions", () => {
    const controls = "\u001b".repeat(8_192);
    const selected = selectedText(controls);
    const output = renderShow({
      snapshot: {
        identity,
        ...retainedAttribution,
        freshness: "current",
        sourceState: "present",
        lineageCoverage: "complete",
        selection: transcriptSelection({
          entries: 1,
          segments: 1,
          textBytes: selected.emittedUtf8Bytes,
          originalTextBytes: selected.emittedUtf8Bytes + 1,
        }),
      },
      relations: [],
      entries: [
        {
          ordinal: 0,
          actor: "human",
          kind: "message",
          content: [
            {
              ordinal: 0,
              kind: "text",
              text: selected,
              contentHash: { scheme: "sha256-utf8-v1", digest: "0".repeat(64) },
              origin: "human",
              originConfidence: "high",
            },
          ],
          omittedSegmentCount: 1,
        },
      ],
    });

    const body = output.split("\n")[5]!;
    expect(body).toContain("… [truncated]");
    expect(body).not.toContain("\u001b");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(8 * 1_024);
    expect(output).toContain("segment(s) omitted by output limits");
  });

  test("renders bounded search evidence, linked context, support, and continuation", () => {
    const output = renderSearch({
      hits: [
        {
          session: {
            identity,
            ...retainedAttribution,
            title: selectedText("match\u001b[31m"),
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
            contentHash: { scheme: "sha256-utf8-v1", digest: "0".repeat(64) },
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

  test("renders escaped entry inventory evidence, counts, root, and continuation", () => {
    const output = renderEntries(entryInventoryResult());

    expect(output).toContain("synthetic@one:session");
    expect(output).toContain("#4 tool tool-call tool=shell/exec\\u{1b}");
    expect(output).toContain("Root: synthetic@root:root-session");
    expect(output).toContain("preview\\u{07}");
    expect(output).toContain(
      "Content: 2 text segment(s); 1 omitted segment(s); 1 unpreviewed text segment(s)",
    );
    expect(output).toContain("Next cursor: next-entry-page");
    expect(output).not.toContain("\u001b");
  });

  test("renders empty and textless entry inventory states exactly", () => {
    expect(renderEntries({ entries: [] })).toBe("No entries found.\n");
    expect(
      renderEntries({
        entries: [
          {
            ...entryInventoryResult().entries[0]!,
            root: { kind: "unknown" },
            content: {
              textSegmentCount: 0,
              omittedSegmentCount: 1,
              unpreviewedTextSegmentCount: 0,
            },
          },
        ],
      }),
    ).toContain("Root: unknown\n(no text preview)\nContent: 0 text segment(s)");
  });
});

function entryInventoryResult(): ListSessionEntriesResult {
  return {
    entries: [
      {
        session: {
          identity,
          ...retainedAttribution,
          title: selectedText("title\u001b"),
          freshness: "current",
          sourceState: "present",
        },
        entry: {
          ordinal: 4,
          kind: "tool-call",
          actor: "tool",
          toolName: "exec\u001b",
          toolNamespace: "shell",
        },
        root: {
          kind: "known",
          root: {
            source: { kind: "synthetic", instanceId: "root" },
            nativeId: "root-session",
          },
        },
        content: {
          textSegmentCount: 2,
          omittedSegmentCount: 1,
          unpreviewedTextSegmentCount: 1,
          preview: {
            segmentOrdinal: 0,
            origin: "tool",
            originConfidence: "high",
            text: "preview\u0007",
            truncated: false,
            contentHash: { scheme: "sha256-utf8-v1", digest: "1".repeat(64) },
          },
        },
      },
    ],
    nextCursor: "next-entry-page" as never,
  };
}
