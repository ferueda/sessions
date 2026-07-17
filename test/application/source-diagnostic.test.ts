import { describe, expect, test } from "vitest";

import { createSourceDiagnostic } from "../../src/application/source-diagnostic.ts";
import type { SourceProbe, SourceProbeStatus } from "../../src/application/ports/session-source.ts";
import { createFakeIndexingSource } from "../fixtures/indexing-source.ts";

describe("source diagnostic", () => {
  test.each([
    ["ready", true, "Source is ready"],
    ["unavailable", true, "Source is unavailable (optional)"],
    ["unreadable", false, "Source is unreadable"],
  ] as const)(
    "reports %s with its optional-provider health meaning",
    async (status, ok, summary) => {
      const source = createFakeIndexingSource();
      source.setProbe(probe(source.instance, status));

      await expect(createSourceDiagnostic(source.selected).run()).resolves.toEqual({
        ok,
        summary,
        details: { probeStatus: status },
      });
    },
  );

  test("fails invalid and throwing probes without exposing their values", async () => {
    const invalid = createFakeIndexingSource({ kind: "invalid", instanceId: "one" });
    invalid.setProbe({ private: "must not escape" } as unknown as SourceProbe);
    const throwing = createFakeIndexingSource({ kind: "throwing", instanceId: "one" });
    throwing.failProbe(new Error("private probe failure"));

    await expect(createSourceDiagnostic(invalid.selected).run()).resolves.toEqual({
      ok: false,
      summary: "Source probe returned invalid data",
      details: { probeStatus: "failed", failure: "invalid-probe" },
    });
    await expect(createSourceDiagnostic(throwing.selected).run()).resolves.toEqual({
      ok: false,
      summary: "Source probe failed",
      details: { probeStatus: "failed", failure: "probe-error" },
    });
  });
});

function probe(
  source: { readonly kind: string; readonly instanceId: string },
  status: SourceProbeStatus,
): SourceProbe {
  return {
    source,
    status,
    locations: [{ role: "root", locator: { uri: "memory://sessions" } }],
    summary: `Synthetic source is ${status}`,
  };
}
