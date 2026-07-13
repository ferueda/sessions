import type { DiagnosticResult, RuntimeDiagnostic } from "./ports/runtime-diagnostic.ts";

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly command: "doctor";
  readonly ok: boolean;
  readonly checks: readonly DiagnosticResult[];
}

export async function runDoctor(diagnostics: readonly RuntimeDiagnostic[]): Promise<DoctorReport> {
  const checks: DiagnosticResult[] = [];

  for (const diagnostic of diagnostics) {
    try {
      const outcome = await diagnostic.run();
      checks.push({
        id: diagnostic.id,
        label: diagnostic.label,
        ok: outcome.ok,
        summary: outcome.summary,
        details: outcome.details ?? {},
      });
    } catch {
      // Probe failures are data: retain ordering and let remaining checks run.
      checks.push({
        id: diagnostic.id,
        label: diagnostic.label,
        ok: false,
        summary: `${diagnostic.label} failed unexpectedly`,
        details: { error: "unexpected-probe-error" },
      });
    }
  }

  return {
    schemaVersion: 1,
    command: "doctor",
    ok: checks.every((check) => check.ok),
    checks,
  };
}
