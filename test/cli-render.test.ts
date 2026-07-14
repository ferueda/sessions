import { describe, expect, test } from "vitest";

import type { ShowSessionResult } from "../src/application/show-session.ts";
import { renderList, renderPaths, renderShow } from "../src/cli/render.ts";

const identity = {
  source: { kind: "synthetic", instanceId: "one" },
  nativeId: "session",
} as const;

describe("human CLI rendering", () => {
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
      truncated: false,
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
});
