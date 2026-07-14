import { CommanderError } from "commander";

import { createProgram, OperationalExit, type ProgramOptions } from "./program.ts";

export type CliOptions = ProgramOptions;

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
