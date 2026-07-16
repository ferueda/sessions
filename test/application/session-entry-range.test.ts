import { describe, expect, test } from "vitest";

import type { SessionLibraryError } from "../../src/application/library-error.ts";
import {
  admitSessionEntryRange,
  MAX_SESSION_ENTRY_RANGE_COUNT,
  resolveSessionEntryWindow,
} from "../../src/application/session-entry-range.ts";

describe("session entry ranges", () => {
  test("admits a frozen inclusive range and resolves it to a half-open window", () => {
    const range = admitSessionEntryRange({ fromEntry: 4, toEntry: 7 });

    expect(range).toEqual({ fromEntry: 4, toEntry: 7 });
    expect(Object.isFrozen(range)).toBe(true);
    if (range === undefined) throw new Error("expected an admitted range");
    expect(resolveSessionEntryWindow(range, 8)).toEqual({ start: 4, end: 8 });
  });

  test("admits one entry and the 200-entry boundary", () => {
    expect(admitSessionEntryRange({ fromEntry: 9, toEntry: 9 })).toEqual({
      fromEntry: 9,
      toEntry: 9,
    });
    expect(
      admitSessionEntryRange({
        fromEntry: 1,
        toEntry: MAX_SESSION_ENTRY_RANGE_COUNT,
      }),
    ).toEqual({ fromEntry: 1, toEntry: 200 });
  });

  test("returns no range when both endpoints are absent", () => {
    expect(admitSessionEntryRange({})).toBeUndefined();
  });

  test.each([
    { fromEntry: 0 },
    { toEntry: 0 },
    { fromEntry: -1, toEntry: 0 },
    { fromEntry: 0, toEntry: -1 },
    { fromEntry: 0.5, toEntry: 1 },
    { fromEntry: 0, toEntry: 1.5 },
    { fromEntry: Number.MAX_SAFE_INTEGER + 1, toEntry: Number.MAX_SAFE_INTEGER + 1 },
    { fromEntry: 0, toEntry: Number.MAX_SAFE_INTEGER + 1 },
    { fromEntry: 2, toEntry: 1 },
    { fromEntry: 0, toEntry: MAX_SESSION_ENTRY_RANGE_COUNT },
  ])("rejects an invalid range before document access: %j", (input) => {
    expect(() => admitSessionEntryRange(input)).toThrow(TypeError);
  });

  test.each([
    { range: { fromEntry: 0, toEntry: 0 }, entryCount: 0 },
    { range: { fromEntry: 4, toEntry: 5 }, entryCount: 5 },
  ])("fails when either endpoint is outside the retained document: %j", ({ range, entryCount }) => {
    expect(() => resolveSessionEntryWindow(Object.freeze(range), entryCount)).toThrowError(
      expect.objectContaining<Partial<SessionLibraryError>>({ code: "entry-not-found" }),
    );
  });
});
