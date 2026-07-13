import { describe, expect, test } from "vitest";

import {
  isSourceFailureError,
  SourceFailureError,
  type SourceFailure,
} from "../../src/application/source-failure.ts";

const source = { kind: "synthetic", instanceId: "default" } as const;

describe("SourceFailureError", () => {
  test.each<[SourceFailure, string]>([
    [{ kind: "unavailable", source }, "Session source is unavailable"],
    [{ kind: "unreadable", source }, "Session source is unreadable"],
    [{ kind: "malformed", source }, "Session source data is malformed"],
    [{ kind: "source-changed", source }, "Session source changed while it was read"],
    [{ kind: "unsupported-format", source }, "Session source format is unsupported"],
  ])("creates a safe central message for $kind", (failure, message) => {
    const error = new SourceFailureError(failure);

    expect(error).toMatchObject({ name: "SourceFailureError", message, failure });
    expect(isSourceFailureError(error)).toBe(true);
  });

  test("retains a raw cause without copying it into the safe message or failure", () => {
    const cause = new Error("private transcript content at /private/history.jsonl");
    const error = new SourceFailureError({ kind: "unreadable", source }, { cause });

    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain(cause.message);
    expect(JSON.stringify(error.failure)).not.toContain(cause.message);
    expect(isSourceFailureError(cause)).toBe(false);
  });
});
