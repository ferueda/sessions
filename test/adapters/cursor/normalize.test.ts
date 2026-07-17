import { describe, expect, test } from "vitest";

import type { CursorFormatError } from "../../../src/adapters/cursor/format-error.ts";
import { normalizeCursorSession } from "../../../src/adapters/cursor/normalize.ts";
import { validateSessionDocument } from "../../../src/domain/session-validation.ts";
import type { SessionDocument } from "../../../src/domain/session.ts";

const BASE = {
  identity: {
    source: { kind: "cursor", instanceId: "local-sha256-v1:instance" },
    nativeId: "generic-session",
  },
  logicalLocator: "cursor://session/generic",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T01:00:00.000Z",
  title: "Generic session",
  workspace: "/generic/workspace",
} as const;

describe("Cursor v1 message normalizer", () => {
  test("preserves exact role, item, tool, omission, and source order", () => {
    const privateRedaction = "private-redaction";
    const privateImage = "private-image";
    const document = normalize([
      { role: "system", content: "system context" },
      { role: "user", content: "<system-reminder>ordinary user text</system-reminder>" },
      {
        role: "user",
        content: [
          { type: "text", text: "part one" },
          { type: "text", text: "part two" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          {
            type: "reasoning",
            text: "reasoning",
            signature: "ignored-signature",
            providerOptions: { cursor: { opaque: true } },
          },
          {
            type: "redacted-reasoning",
            data: privateRedaction,
            providerOptions: {},
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "generic_tool",
            args: { z: 1, a: ["two", 3] },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "generic_tool",
            result: "primary",
            experimental_content: [
              { type: "text", text: "primary" },
              { type: "text", text: "extra" },
              { type: "image", mimeType: "image/png", data: privateImage },
            ],
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "structured_tool",
            args: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "structured_tool",
            result: { z: true, a: 2 },
            experimental_content: [],
            providerOptions: { cursor: {} },
          },
        ],
      },
    ]);

    expect(document.entries.map(({ ordinal, kind, actor }) => ({ ordinal, kind, actor }))).toEqual([
      { ordinal: 0, kind: "message", actor: "system" },
      { ordinal: 1, kind: "message", actor: "human" },
      { ordinal: 2, kind: "message", actor: "human" },
      { ordinal: 3, kind: "message", actor: "human" },
      { ordinal: 4, kind: "message", actor: "model" },
      { ordinal: 5, kind: "reasoning", actor: "model" },
      { ordinal: 6, kind: "reasoning", actor: "model" },
      { ordinal: 7, kind: "tool-call", actor: "model" },
      { ordinal: 8, kind: "tool-result", actor: "tool" },
      { ordinal: 9, kind: "tool-call", actor: "model" },
      { ordinal: 10, kind: "tool-result", actor: "tool" },
    ]);
    expect(document.entries[1]).toMatchObject({
      actor: "human",
      content: [{ text: "<system-reminder>ordinary user text</system-reminder>" }],
    });
    expect(document.entries[7]).toMatchObject({
      toolCallId: "call-1",
      toolName: "generic_tool",
      content: [{ text: '{"a":["two",3],"z":1}' }],
    });
    expect(document.entries[8]).toMatchObject({
      relatedEntryOrdinal: 7,
      toolCallId: "call-1",
      content: [
        { ordinal: 0, kind: "text", text: "primary", origin: "tool" },
        { ordinal: 1, kind: "text", text: "extra", origin: "tool" },
        {
          ordinal: 2,
          kind: "omitted",
          contentClass: "image",
          sourceType: "image",
          origin: "tool",
        },
      ],
    });
    expect(document.entries[10]).toMatchObject({
      relatedEntryOrdinal: 9,
      content: [{ text: '{"a":2,"z":true}' }],
    });
    expect(document.entries[8]).not.toHaveProperty("toolName");
    expect(document.entries.every((entry) => entry.timestamp === undefined)).toBe(true);
    expect(document.lineageCoverage).toBe("unknown");
    expect(document.relations).toEqual([]);
    expect(validateSessionDocument(document)).toMatchObject({ ok: true });

    const serialized = JSON.stringify(document);
    expect(serialized).not.toContain(privateRedaction);
    expect(serialized).not.toContain(privateImage);
    expect(serialized).not.toContain("ignored-signature");
    expect(serialized).not.toContain("providerOptions");
    expect(serialized).not.toContain("image/png");
  });

  test("keeps structured-result text even when experimental text is equal", () => {
    const document = normalize([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call", toolName: "tool", args: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "tool",
            result: { value: 1 },
            experimental_content: [{ type: "text", text: '{"value":1}' }],
          },
        ],
      },
    ]);

    expect(document.entries[1]?.content).toMatchObject([
      { ordinal: 0, text: '{"value":1}' },
      { ordinal: 1, text: '{"value":1}' },
    ]);
  });

  test("accepts empty selected roots and content arrays", () => {
    expect(normalize([]).entries).toEqual([]);
    expect(
      normalize([
        { role: "user", content: [] },
        { role: "assistant", content: [] },
        { role: "tool", content: [] },
      ]).entries,
    ).toEqual([]);
  });

  test.each([
    ["unknown message key", { role: "user", content: "text", future: true }, "unsupported-format"],
    ["unknown role", { role: "future", content: "text" }, "unsupported-format"],
    ["unsupported role pairing", { role: "system", content: [] }, "unsupported-format"],
    [
      "unknown content type",
      { role: "assistant", content: [{ type: "future", value: "text" }] },
      "unsupported-format",
    ],
    [
      "invalid known content",
      { role: "assistant", content: [{ type: "text", text: 1 }] },
      "malformed",
    ],
    [
      "non-object provider options",
      { role: "user", content: "text", providerOptions: [] },
      "malformed",
    ],
  ])("rejects %s", (_name, message, kind) => {
    expect.hasAssertions();
    expectCursorFailure([message], kind);
  });

  test("rejects missing, duplicate, and inconsistent call/result linkage", () => {
    expect.hasAssertions();
    const call = {
      type: "tool-call",
      toolCallId: "call",
      toolName: "tool",
      args: {},
    };
    const result = {
      type: "tool-result",
      toolCallId: "call",
      toolName: "tool",
      result: "done",
      experimental_content: [],
    };

    expectCursorFailure([{ role: "tool", content: [result] }], "malformed");
    expectCursorFailure([{ role: "assistant", content: [call, call] }], "malformed");
    expectCursorFailure(
      [
        { role: "assistant", content: [call] },
        { role: "tool", content: [result, result] },
      ],
      "malformed",
    );
    expectCursorFailure(
      [
        { role: "assistant", content: [call] },
        { role: "tool", content: [{ ...result, toolName: "other" }] },
      ],
      "malformed",
    );
  });

  test("rejects a result type outside the frozen string, object, and number matrix", () => {
    expect.hasAssertions();
    expectCursorFailure(
      [
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId: "call", toolName: "tool", args: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "tool",
              result: true,
              experimental_content: [],
            },
          ],
        },
      ],
      "unsupported-format",
    );
  });

  test("rejects malformed image evidence and unsupported experimental records", () => {
    expect.hasAssertions();
    const prefix = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call", toolName: "tool", args: {} }],
      },
    ];
    const result = (experimental_content: readonly unknown[]) => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "tool",
          result: "done",
          experimental_content,
        },
      ],
    });

    expectCursorFailure(
      [...prefix, result([{ type: "image", mimeType: "text/plain", data: "bytes" }])],
      "malformed",
    );
    expectCursorFailure(
      [...prefix, result([{ type: "audio", data: "bytes" }])],
      "unsupported-format",
    );
  });
});

function normalize(messages: readonly unknown[]): SessionDocument {
  return normalizeCursorSession({
    ...BASE,
    messages: messages.map((value, rootOrdinal) => ({ rootOrdinal, value })),
  });
}

function expectCursorFailure(messages: readonly unknown[], kind: string): void {
  expect(() => normalize(messages)).toThrowError(
    expect.objectContaining({ kind }) as CursorFormatError,
  );
}
