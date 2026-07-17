import { describe, expect, test } from "vitest";

import type { CursorFormatError } from "../../../src/adapters/cursor/format-error.ts";
import { createCursorJsonlNormalizer } from "../../../src/adapters/cursor/normalize-jsonl.ts";
import { validateSessionDocument } from "../../../src/domain/session-validation.ts";
import type { SessionDocument } from "../../../src/domain/session.ts";

const OPTIONS = {
  identity: {
    source: { kind: "cursor", instanceId: "local-sha256-v1:instance" },
    nativeId: "00000000-0000-4000-8000-000000000001",
  },
  logicalLocator: "cursor://session/agent-transcript-jsonl-v1/generic",
} as const;

describe("Cursor agent-transcript JSONL normalizer", () => {
  test("preserves message, content, tool, and lifecycle order without inferred evidence", () => {
    const document = normalize([
      {
        role: "user",
        message: {
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      },
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "answer" },
            { type: "tool_use", name: "object_tool", input: { z: 1, a: ["two"] } },
            { type: "tool_use", name: "raw_tool", input: '{"kept":"exact"}' },
          ],
        },
      },
      { type: "turn_ended", status: "success" },
      { type: "turn_ended", status: "error", error: "exact error" },
      { type: "turn_ended", status: "aborted", error: "exact abort" },
      {
        role: "assistant",
        message: { content: [{ type: "text", text: "after lifecycle" }] },
      },
    ]);

    expect(document.entries.map(({ ordinal, kind, actor }) => ({ ordinal, kind, actor }))).toEqual([
      { ordinal: 0, kind: "message", actor: "human" },
      { ordinal: 1, kind: "message", actor: "human" },
      { ordinal: 2, kind: "message", actor: "model" },
      { ordinal: 3, kind: "tool-call", actor: "model" },
      { ordinal: 4, kind: "tool-call", actor: "model" },
      { ordinal: 5, kind: "turn-completed", actor: "system" },
      { ordinal: 6, kind: "turn-error", actor: "system" },
      { ordinal: 7, kind: "turn-aborted", actor: "system" },
      { ordinal: 8, kind: "message", actor: "model" },
    ]);
    expect(document.entries.map(({ sourceLocator }) => sourceLocator.recordId)).toEqual([
      "0:0",
      "0:1",
      "1:0",
      "1:1",
      "1:2",
      "2:0",
      "3:0",
      "4:0",
      "5:0",
    ]);
    expect(document.entries[3]).toMatchObject({
      toolName: "object_tool",
      content: [{ text: '{"a":["two"],"z":1}', origin: "model", originConfidence: "high" }],
    });
    expect(document.entries[4]).toMatchObject({
      toolName: "raw_tool",
      content: [{ text: '{"kept":"exact"}' }],
    });
    expect(document.entries[5]?.content).toEqual([]);
    expect(document.entries[6]?.content).toMatchObject([{ text: "exact error", origin: "system" }]);
    expect(document.entries[7]?.content).toMatchObject([{ text: "exact abort", origin: "system" }]);

    expect(document).not.toHaveProperty("title");
    expect(document).not.toHaveProperty("workspace");
    expect(document).not.toHaveProperty("createdAt");
    expect(document).not.toHaveProperty("updatedAt");
    expect(document.lineageCoverage).toBe("unknown");
    expect(document.relations).toEqual([]);
    expect(
      document.entries.every(
        (entry) =>
          entry.timestamp === undefined &&
          entry.toolCallId === undefined &&
          entry.toolNamespace === undefined &&
          entry.relatedEntryOrdinal === undefined,
      ),
    ).toBe(true);
    expect(validateSessionDocument(document)).toMatchObject({ ok: true });
  });

  test("admits lifecycle-only files, repeated terminals, and empty content arrays", () => {
    const document = normalize([
      { role: "user", message: { content: [] } },
      { type: "turn_ended", status: "success" },
      { type: "turn_ended", status: "success" },
    ]);

    expect(document.entries).toHaveLength(2);
    expect(document.entries.map(({ kind }) => kind)).toEqual(["turn-completed", "turn-completed"]);
  });

  test.each([
    ["unknown outer record", { future: true }],
    ["unknown outer key", { role: "user", message: { content: [] }, future: true }],
    ["unknown role", { role: "system", message: { content: [] } }],
    [
      "unknown user content",
      { role: "user", message: { content: [{ type: "future", text: "value" }] } },
    ],
    [
      "unknown assistant content",
      { role: "assistant", message: { content: [{ type: "future", text: "value" }] } },
    ],
    [
      "unknown tool key",
      {
        role: "assistant",
        message: {
          content: [{ type: "tool_use", name: "tool", input: {}, future: true }],
        },
      },
    ],
    [
      "array tool input",
      {
        role: "assistant",
        message: { content: [{ type: "tool_use", name: "tool", input: [] }] },
      },
    ],
    ["unknown lifecycle type", { type: "turn_started", status: "success" }],
    ["unknown lifecycle status", { type: "turn_ended", status: "future" }],
    ["success error field", { type: "turn_ended", status: "success", error: "unexpected" }],
  ])("classifies %s as unsupported format", (_name, record) => {
    expect.hasAssertions();
    expectFailure([record], "unsupported-format");
  });

  test.each([
    ["primitive record", "record"],
    ["missing message", { role: "user" }],
    ["non-string role", { role: 1, message: { content: [] } }],
    ["missing content", { role: "user", message: {} }],
    ["non-array content", { role: "user", message: { content: "text" } }],
    ["non-string text", { role: "user", message: { content: [{ type: "text", text: 1 }] } }],
    [
      "missing tool input",
      {
        role: "assistant",
        message: { content: [{ type: "tool_use", name: "tool" }] },
      },
    ],
    ["missing lifecycle status", { type: "turn_ended" }],
    ["missing lifecycle error", { type: "turn_ended", status: "error" }],
    ["non-string lifecycle error", { type: "turn_ended", status: "aborted", error: 1 }],
  ])("classifies %s as malformed", (_name, record) => {
    expect.hasAssertions();
    expectFailure([record], "malformed");
  });

  test("requires contiguous source record ordinals and one finish", () => {
    const state = createCursorJsonlNormalizer(OPTIONS);
    expect(() => state.addRecord({ type: "turn_ended", status: "success" }, 1)).toThrowError(
      expect.objectContaining({ kind: "malformed" }) as CursorFormatError,
    );

    const complete = createCursorJsonlNormalizer(OPTIONS);
    complete.addRecord({ type: "turn_ended", status: "success" }, 0);
    expect(complete.finish()).toMatchObject({ entries: [{ ordinal: 0 }] });
    expect(() => complete.finish()).toThrowError(TypeError);
    expect(() => complete.addRecord({ type: "turn_ended", status: "success" }, 1)).toThrowError(
      TypeError,
    );
  });

  test("fails closed on invalid options and canonical object input", () => {
    expect(() => createCursorJsonlNormalizer({ ...OPTIONS, logicalLocator: "" })).toThrowError(
      expect.objectContaining({ kind: "malformed" }) as CursorFormatError,
    );

    expectFailure(
      [
        {
          role: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "tool",
                input: { unsafe: Number.MAX_SAFE_INTEGER + 1 },
              },
            ],
          },
        },
      ],
      "malformed",
    );
  });
});

function normalize(records: readonly unknown[]): SessionDocument {
  const state = createCursorJsonlNormalizer(OPTIONS);
  for (const [recordOrdinal, record] of records.entries()) {
    state.addRecord(record, recordOrdinal);
  }
  return state.finish();
}

function expectFailure(records: readonly unknown[], kind: string): void {
  expect(() => normalize(records)).toThrowError(
    expect.objectContaining({ kind }) as CursorFormatError,
  );
}
