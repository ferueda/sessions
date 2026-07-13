import { describe, expect, test } from "vitest";

import type { RuntimeDiagnostic } from "../../src/application/ports/runtime-diagnostic.ts";
import { runDoctor } from "../../src/application/run-doctor.ts";

describe("runDoctor", () => {
  test("runs every diagnostic in declared order", async () => {
    const order: string[] = [];
    const diagnostics: RuntimeDiagnostic[] = [
      diagnostic("first", true, order),
      diagnostic("second", false, order),
      diagnostic("third", true, order),
    ];

    const report = await runDoctor(diagnostics);

    expect(order).toEqual(["first", "second", "third"]);
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.id)).toEqual(order);
  });

  test("turns a thrown probe into a sanitized failed check", async () => {
    const report = await runDoctor([
      {
        id: "broken",
        label: "Broken probe",
        run() {
          throw new Error("sensitive path must not escape");
        },
      },
      {
        id: "later",
        label: "Later probe",
        run: () => ({ ok: true, summary: "still ran" }),
      },
    ]);

    expect(report).toEqual({
      schemaVersion: 1,
      command: "doctor",
      ok: false,
      checks: [
        {
          id: "broken",
          label: "Broken probe",
          ok: false,
          summary: "Broken probe failed unexpectedly",
          details: { error: "unexpected-probe-error" },
        },
        {
          id: "later",
          label: "Later probe",
          ok: true,
          summary: "still ran",
          details: {},
        },
      ],
    });
  });
});

function diagnostic(id: string, ok: boolean, order: string[]): RuntimeDiagnostic {
  return {
    id,
    label: id,
    run() {
      order.push(id);
      return { ok, summary: ok ? "pass" : "fail" };
    },
  };
}
