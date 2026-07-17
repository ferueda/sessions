import { describe, expect, test } from "vitest";

import {
  createCursorSourceInstance,
  cursorSourceInstancePreimage,
} from "../../../src/adapters/cursor/source-instance.ts";

describe("Cursor source instance identity", () => {
  test("locks the canonical preimage and digest", () => {
    const cursorHome = "/home/alice/.cursor";

    expect(cursorSourceInstancePreimage(cursorHome)).toBe(
      '["sessions-cursor-source-instance-v1",["cursor-home","/home/alice/.cursor"]]',
    );
    expect(createCursorSourceInstance(cursorHome)).toEqual({
      kind: "cursor",
      instanceId:
        "local-sha256-v1:a7ab81cc0fc7b13f0eb434201186109073ced5b7ea0c114aa7d553c623e6e0d4",
    });
  });

  test("is stable while preserving Windows separators and JSON escaping", () => {
    const windows = String.raw`C:\Users\Alice\.cursor`;
    const repeated = createCursorSourceInstance(windows);

    expect(createCursorSourceInstance(windows)).toEqual(repeated);
    expect(createCursorSourceInstance(String.raw`C:\Users\Bob\.cursor`)).not.toEqual(repeated);
    expect(cursorSourceInstancePreimage(windows)).toContain(String.raw`C:\\Users\\Alice`);
  });

  test.each(["", "\ud800"])("rejects an invalid root %j", (root) => {
    expect(() => createCursorSourceInstance(root)).toThrow(TypeError);
  });
});
