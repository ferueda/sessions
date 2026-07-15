import { describe, expect, test } from "vitest";

import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../../src/application/session-query-error.ts";

describe("session query errors", () => {
  test("preserves causes behind sanitized usage messages", () => {
    const cause = new Error("SELECT transcript FROM /private/library");
    const error = new SessionQueryUsageError("cursor-query-mismatch", { cause });

    expect(error).toMatchObject({
      name: "SessionQueryUsageError",
      code: "cursor-query-mismatch",
      message: "Session query cursor does not match this query",
      cause,
    });
    expect(error.message).not.toContain("SELECT");
  });

  test("keeps stale cursors operational without exposing their payload", () => {
    const payload = "private-cursor-payload";
    const error = new SessionQueryOperationalError("stale-cursor", {
      cause: new Error(payload),
    });

    expect(error).toMatchObject({
      name: "SessionQueryOperationalError",
      code: "stale-cursor",
      message: "Session query cursor is stale",
    });
    expect(error.message).not.toContain(payload);
  });
});
