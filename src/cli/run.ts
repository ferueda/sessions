import { CommanderError } from "commander";

import type { PathsReport } from "../application/get-paths.ts";
import type { DoctorReport } from "../application/run-doctor.ts";
import { createProgram, OperationalExit, type CliOutput } from "./program.ts";

export interface CliOptions {
  readonly version: string;
  readonly output: CliOutput;
  readonly doctor: () => Promise<DoctorReport>;
  readonly paths: () => Promise<PathsReport>;
}

export async function runCli(argv: readonly string[], options: CliOptions): Promise<number> {
  const program = createProgram(options);

  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof OperationalExit) return 1;
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;

    options.output.writeErr(`sessions: ${describeError(error)}\n`);
    return 1;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "unexpected operational failure";
}
