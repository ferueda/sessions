export interface DiagnosticOutcome {
  readonly ok: boolean;
  readonly summary: string;
  readonly details?: Readonly<Record<string, string>>;
}

export interface RuntimeDiagnostic {
  readonly id: string;
  readonly label: string;
  run(): DiagnosticOutcome | Promise<DiagnosticOutcome>;
}

export interface DiagnosticResult {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly details: Readonly<Record<string, string>>;
}
