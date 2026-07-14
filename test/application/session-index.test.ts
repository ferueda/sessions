import { describe, expect, test } from "vitest";

import { createSessionIndexRunId } from "../../src/application/ports/session-index.ts";

describe("session index values", () => {
  test("admits opaque well-formed run IDs without changing them", () => {
    expect(createSessionIndexRunId("run:synthetic/01")).toBe("run:synthetic/01");
  });

  test.each([undefined, 1, "", "run\ud800id"])("rejects invalid run ID %j", (value) => {
    expect(() => createSessionIndexRunId(value)).toThrow(
      "Session index run ID must be a non-empty well-formed string",
    );
  });
});
