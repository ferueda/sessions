import { describe, expect, test } from "vitest";

import {
  createSessionFilter,
  createSessionListQuery,
  createSessionQueryCursor,
  createSessionSearchQuery,
  sessionQueryFingerprintMaterial,
} from "../../src/domain/session-query.ts";

describe("session query values", () => {
  test("snapshots and freezes exact case-sensitive session filters", () => {
    const identity = {
      source: { kind: "synthetic", instanceId: "Profile-A" },
      nativeId: "Session-A",
    };
    const input = {
      source: "synthetic",
      instance: "Profile-A",
      workspace: "/Users/Example/Workspace",
      session: identity,
    };

    const filter = createSessionFilter(input);
    identity.nativeId = "changed";

    expect(filter).toEqual({
      source: "synthetic",
      instance: "Profile-A",
      workspace: "/Users/Example/Workspace",
      session: {
        source: { kind: "synthetic", instanceId: "Profile-A" },
        nativeId: "Session-A",
      },
    });
    expect(Object.isFrozen(filter)).toBe(true);
    expect(Object.isFrozen(filter.session)).toBe(true);
    expect(Object.isFrozen(filter.session?.source)).toBe(true);
  });

  test("requires source whenever an instance filter is present", () => {
    expect(() => createSessionFilter({ instance: "profile" })).toThrow(
      "Source instance requires a source",
    );
    expect(() => createSessionFilter({ source: "synthetic", instance: "" })).toThrow(
      "Source instance must not be empty",
    );
  });

  test("admits canonical exclusive bounds and rejects equal or invalid timestamps", () => {
    expect(
      createSessionFilter({
        capturedAfter: "2026-07-14T10:00:00.000Z",
        capturedBefore: "2026-07-14T11:00:00.000Z",
      }),
    ).toMatchObject({
      capturedAfter: "2026-07-14T10:00:00.000Z",
      capturedBefore: "2026-07-14T11:00:00.000Z",
    });
    expect(() =>
      createSessionFilter({
        observedAfter: "2026-07-14T10:00:00.000Z",
        observedBefore: "2026-07-14T10:00:00.000Z",
      }),
    ).toThrow("Observation bounds must be increasing and exclusive");
    expect(() => createSessionFilter({ capturedAfter: "2026-02-30T10:00:00.000Z" })).toThrow(
      "Captured-after must be a canonical UTC timestamp",
    );
  });

  test("normalizes Unicode whitespace without interpreting punctuation as syntax", () => {
    const query = createSessionSearchQuery({
      text: '  alpha\u0085beta\u2003"OR"\t/path/to/file.ts  ',
      limit: 20,
      context: 0,
    });

    expect(query.text).toBe('alpha beta "OR" /path/to/file.ts');
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.filter)).toBe(true);
  });

  test.each([
    { limit: 0, context: 0 },
    { limit: 201, context: 0 },
    { limit: 20, context: -1 },
    { limit: 20, context: 11 },
    { limit: 1.5, context: 0 },
  ])("rejects search bounds $limit/$context", ({ limit, context }) => {
    expect(() => createSessionSearchQuery({ text: "needle", limit, context })).toThrow(TypeError);
  });

  test.each(["", " \n\t\u2003 ", "\u0085"])("rejects blank search text %j", (text) => {
    expect(() => createSessionSearchQuery({ text, limit: 20, context: 0 })).toThrow(
      "Search text must not be blank",
    );
  });

  test("binds fingerprint material to semantics but not continuation payload", () => {
    const first = createSessionListQuery({
      filter: { source: "synthetic" },
      limit: 50,
      cursor: createSessionQueryCursor("page-one"),
    });
    const second = createSessionListQuery({
      filter: { source: "synthetic" },
      limit: 50,
      cursor: createSessionQueryCursor("page-two"),
    });
    const changed = createSessionListQuery({
      filter: { source: "synthetic" },
      limit: 25,
    });

    expect(sessionQueryFingerprintMaterial(first)).toBe(sessionQueryFingerprintMaterial(second));
    expect(sessionQueryFingerprintMaterial(first)).not.toBe(
      sessionQueryFingerprintMaterial(changed),
    );
  });

  test.each(["", "bad\ud800cursor", "x".repeat(2_049)])(
    "rejects malformed or unbounded cursor values",
    (value) => {
      expect(() => createSessionQueryCursor(value)).toThrow("Session query cursor is invalid");
    },
  );
});
