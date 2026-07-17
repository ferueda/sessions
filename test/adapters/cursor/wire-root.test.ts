import { Buffer } from "node:buffer";

import { describe, expect, test } from "vitest";

import type { CursorFormatError } from "../../../src/adapters/cursor/format-error.ts";
import { parseCursorRootBlobIds } from "../../../src/adapters/cursor/wire-root.ts";
import { encodeRoot, type RootField } from "../../fixtures/cursor/store.ts";

describe("Cursor selected root wire reader", () => {
  test("accepts every frozen field/wire pair and preserves repeated blob order", () => {
    const first = Buffer.from("11".repeat(32), "hex");
    const second = Buffer.from("22".repeat(32), "hex");
    const fields: RootField[] = [
      { number: 3, wire: 2, value: Buffer.from("opaque") },
      { number: 1, wire: 2, value: first },
      { number: 4, wire: 2, value: new Uint8Array() },
      { number: 5, wire: 2, value: Buffer.from([1]) },
      { number: 7, wire: 2, value: Buffer.from([2]) },
      { number: 8, wire: 2, value: Buffer.from([3]) },
      { number: 9, wire: 2, value: Buffer.from([4]) },
      { number: 10, wire: 0, value: 1 },
      { number: 15, wire: 2, value: Buffer.from([5]) },
      { number: 16, wire: 2, value: Buffer.from([6]) },
      { number: 18, wire: 2, value: Buffer.from([7]) },
      { number: 21, wire: 2, value: Buffer.from([8]) },
      { number: 22, wire: 2, value: Buffer.from([9]) },
      { number: 26, wire: 0, value: 300 },
      { number: 27, wire: 2, value: Buffer.from([10]) },
      { number: 1, wire: 2, value: second },
      { number: 1, wire: 2, value: first },
    ];

    const ids = parseCursorRootBlobIds(encodeRoot(fields));

    expect(ids).toEqual(["11".repeat(32), "22".repeat(32), "11".repeat(32)]);
    expect(Object.isFrozen(ids)).toBe(true);
  });

  test("accepts an empty root and opaque-only root", () => {
    expect(parseCursorRootBlobIds(new Uint8Array())).toEqual([]);
    expect(
      parseCursorRootBlobIds(
        encodeRoot([
          { number: 3, wire: 2, value: Buffer.from("opaque") },
          { number: 10, wire: 0, value: 0 },
        ]),
      ),
    ).toEqual([]);
  });

  test.each([
    ["zero field", Buffer.from([0x02, 0x00])],
    ["truncated tag", Buffer.from([0x80])],
    ["truncated length", Buffer.from([0x0a, 0x20, 0x01])],
    ["wrong blob length", encodeRoot([{ number: 1, wire: 2, value: Buffer.alloc(31) }])],
    [
      "overwide varint",
      Buffer.from([0x50, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02]),
    ],
  ])("rejects malformed %s", (_name, bytes) => {
    expect(() => parseCursorRootBlobIds(bytes)).toThrowError(
      expect.objectContaining({ kind: "malformed" }) as CursorFormatError,
    );
  });

  test.each([
    ["unknown field", encodeRoot([{ number: 2, wire: 2, value: new Uint8Array() }])],
    ["wrong known wire", Buffer.from([0x0d, 0, 0, 0, 0])],
  ])("rejects unsupported %s", (_name, bytes) => {
    expect(() => parseCursorRootBlobIds(bytes)).toThrowError(
      expect.objectContaining({ kind: "unsupported-format" }) as CursorFormatError,
    );
  });
});
