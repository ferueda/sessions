import { CommanderError } from "commander";

import { SessionQueryUsageError } from "../application/session-query-error.ts";
import { createProgram, OperationalExit, type ProgramOptions } from "./program.ts";

export type CliOptions = ProgramOptions;

export class CliSignalExit extends Error {
  readonly exitCode: 130 | 143;

  constructor(exitCode: 130 | 143) {
    super("command interrupted by a process signal");
    this.name = "CliSignalExit";
    this.exitCode = exitCode;
  }
}

export async function runCli(argv: readonly string[], options: CliOptions): Promise<number> {
  const program = createProgram(options);

  try {
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CliSignalExit) return error.exitCode;
    if (error instanceof OperationalExit) return 1;
    if (error instanceof CommanderError) {
      if (error.code === "sessions.invalid-argument") {
        options.output.writeErr(`${error.message}\n`);
      }
      return error.exitCode === 0 ? 0 : 2;
    }
    if (error instanceof SessionQueryUsageError) {
      options.output.writeErr(`sessions: ${error.message}\n`);
      return 2;
    }

    options.output.writeErr(`sessions: ${describeError(error)}\n`);
    return 1;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "unexpected operational failure";
}
