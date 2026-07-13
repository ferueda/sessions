import { describe, expect, test } from "vitest";

import { createNodeDiagnostic } from "../../src/infrastructure/runtime/node-diagnostic.ts";

describe("createNodeDiagnostic", () => {
  test("accepts the minimum supported version", async () => {
    expect(await createNodeDiagnostic("24.15.0").run()).toMatchObject({ ok: true });
  });

  test("rejects an older runtime", async () => {
    expect(await createNodeDiagnostic("24.14.9").run()).toMatchObject({ ok: false });
  });
});
