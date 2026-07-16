import { describe, expect, test } from "vitest";

import {
  createSessionEntryQuery,
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
      nativeId: "Provider-Session-A",
      workspace: "/Users/Example/Workspace",
      session: identity,
    };

    const filter = createSessionFilter(input);
    identity.nativeId = "changed";

    expect(filter).toEqual({
      source: "synthetic",
      instance: "Profile-A",
      nativeId: "Provider-Session-A",
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

  test("requires an exact non-empty well-formed native ID", () => {
    expect(createSessionFilter({ nativeId: "Provider-Session-A" })).toEqual({
      nativeId: "Provider-Session-A",
    });
    expect(() => createSessionFilter({ nativeId: "" })).toThrow("Native ID must not be empty");
    expect(() => createSessionFilter({ nativeId: "bad\ud800id" })).toThrow(
      "Native ID must be a well-formed string",
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
    const nativeScoped = createSessionListQuery({
      filter: { source: "synthetic", nativeId: "Provider-Session-A" },
      limit: 50,
    });

    expect(sessionQueryFingerprintMaterial(first)).toBe(sessionQueryFingerprintMaterial(second));
    expect(sessionQueryFingerprintMaterial(first)).not.toBe(
      sessionQueryFingerprintMaterial(changed),
    );
    expect(sessionQueryFingerprintMaterial(first)).not.toBe(
      sessionQueryFingerprintMaterial(nativeScoped),
    );
  });

  test.each(["", "bad\ud800cursor", "x".repeat(2_049)])(
    "rejects malformed or unbounded cursor values",
    (value) => {
      expect(() => createSessionQueryCursor(value)).toThrow("Session query cursor is invalid");
    },
  );

  test("creates immutable entry queries with shared filters and all as the default selection", () => {
    const query = createSessionEntryQuery({
      filter: {
        source: "synthetic",
        instance: "Profile-A",
        entryAfter: "2026-07-14T10:00:00.000Z",
        entryBefore: "2026-07-14T11:00:00.000Z",
        actor: "model",
        origin: "injected",
        entryKind: "tool-call",
        toolName: "read_file",
        toolNamespace: "filesystem",
      },
      limit: 50,
    });

    expect(query).toEqual({
      filter: {
        source: "synthetic",
        instance: "Profile-A",
        entryAfter: "2026-07-14T10:00:00.000Z",
        entryBefore: "2026-07-14T11:00:00.000Z",
        actor: "model",
        origin: "injected",
        entryKind: "tool-call",
        toolName: "read_file",
        toolNamespace: "filesystem",
      },
      selection: "all",
      limit: 50,
    });
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query.filter)).toBe(true);
  });

  test.each([
    { selection: "middle", limit: 50 },
    { selection: "all", limit: 0 },
    { selection: "first", limit: 201 },
    { selection: "last", limit: 1.5 },
  ])("rejects invalid entry query bounds $selection/$limit", ({ selection, limit }) => {
    expect(() =>
      createSessionEntryQuery({
        selection: selection as "all",
        limit,
      }),
    ).toThrow(TypeError);
  });

  test("binds entry cursors to selection, limit, and every entry filter", () => {
    const first = createSessionEntryQuery({
      filter: { source: "synthetic", origin: "human", toolName: "read_file" },
      selection: "first",
      limit: 25,
      cursor: "page-one",
    });
    const continued = createSessionEntryQuery({
      filter: { source: "synthetic", origin: "human", toolName: "read_file" },
      selection: "first",
      limit: 25,
      cursor: "page-two",
    });
    const changedSelection = createSessionEntryQuery({
      filter: { source: "synthetic", origin: "human", toolName: "read_file" },
      selection: "last",
      limit: 25,
    });
    const changedFilter = createSessionEntryQuery({
      filter: { source: "synthetic", origin: "model", toolName: "read_file" },
      selection: "first",
      limit: 25,
    });

    expect(sessionQueryFingerprintMaterial(first)).toBe(sessionQueryFingerprintMaterial(continued));
    expect(sessionQueryFingerprintMaterial(first)).not.toBe(
      sessionQueryFingerprintMaterial(changedSelection),
    );
    expect(sessionQueryFingerprintMaterial(first)).not.toBe(
      sessionQueryFingerprintMaterial(changedFilter),
    );
  });
});
