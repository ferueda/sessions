import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import type { CursorFormatError } from "../../../src/adapters/cursor/format-error.ts";
import {
  MAX_CURSOR_JSONL_RECORD_BYTES,
  parseCursorJsonl,
} from "../../../src/adapters/cursor/jsonl.ts";

describe("Cursor agent-transcript JSONL parser", () => {
  test("streams chunked CRLF, blank, and unterminated records in source order", async () => {
    const records: { value: unknown; ordinal: number }[] = [];
    const first = JSON.stringify({ role: "user", message: { content: [] } });
    const second = JSON.stringify({ type: "turn_ended", status: "success" });
    const bytes = Buffer.from(`${first}\r\n\r\n${second}`);

    await parseCursorJsonl(
      Readable.from([bytes.subarray(0, 7), bytes.subarray(7, 29), bytes.subarray(29)]),
      (value, ordinal) => {
        records.push({ value, ordinal });
      },
    );

    expect(records).toEqual([
      { value: { role: "user", message: { content: [] } }, ordinal: 0 },
      { value: { type: "turn_ended", status: "success" }, ordinal: 1 },
    ]);
  });

  test.each([
    ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
    ["invalid JSON", Buffer.from("{\n")],
    ["null", Buffer.from("null\n")],
    ["array", Buffer.from("[]\n")],
    ["string", Buffer.from('"record"\n')],
    ["number", Buffer.from("1\n")],
  ])("classifies %s as malformed", async (_name, bytes) => {
    await expect(parseCursorJsonl(Readable.from([bytes]), () => undefined)).rejects.toMatchObject({
      name: "CursorFormatError",
      kind: "malformed",
      message: "Cursor session data does not match the supported local format",
    });
  });

  test("admits the exact record cap and rejects cap plus one before parsing", async () => {
    const exact = jsonObjectAtSize(MAX_CURSOR_JSONL_RECORD_BYTES);
    let seenBytes = 0;

    await parseCursorJsonl(Readable.from([exact, Buffer.from("\n")]), (value) => {
      const record = value as { value: string };
      seenBytes = Buffer.byteLength(JSON.stringify(record));
    });
    expect(seenBytes).toBe(MAX_CURSOR_JSONL_RECORD_BYTES);

    const oversized = jsonObjectAtSize(MAX_CURSOR_JSONL_RECORD_BYTES + 1);
    await expect(
      parseCursorJsonl(Readable.from([oversized, Buffer.from("\n")]), () => undefined),
    ).rejects.toMatchObject({ kind: "unsupported-format" });
  });

  test("preserves a typed consumer failure", async () => {
    const expected = {
      role: "user",
      message: { content: [{ type: "text", text: "generic" }] },
    };
    const failure = Object.assign(new Error("typed failure"), {
      kind: "unsupported-format" as const,
    });

    await expect(
      parseCursorJsonl(Readable.from([`${JSON.stringify(expected)}\n`]), () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("does not expose malformed record content in its public error shape", async () => {
    const privateMarker = "private-jsonl-marker";

    let failure: CursorFormatError | undefined;
    try {
      await parseCursorJsonl(Readable.from([`{"record":"${privateMarker}"\n`]), () => undefined);
    } catch (error) {
      failure = error as CursorFormatError;
    }

    expect(failure).toMatchObject({
      kind: "malformed",
      message: "Cursor session data does not match the supported local format",
    });
    expect(JSON.stringify(failure)).not.toContain(privateMarker);
  });
});

function jsonObjectAtSize(size: number): Buffer {
  const overhead = Buffer.byteLength('{"value":""}');
  const result = Buffer.from(JSON.stringify({ value: "x".repeat(size - overhead) }));
  expect(result.byteLength).toBe(size);
  return result;
}
