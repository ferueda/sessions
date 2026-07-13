import { Command, Option } from "commander";

import type { DoctorReport } from "../application/run-doctor.ts";

export interface CliOutput {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface ProgramOptions {
  readonly version: string;
  readonly output: CliOutput;
  readonly doctor: () => Promise<DoctorReport>;
}

export class OperationalExit extends Error {
  constructor() {
    super("doctor reported failed checks");
    this.name = "OperationalExit";
  }
}

export function createProgram(options: ProgramOptions): Command {
  const program = new Command();

  program
    .name("sessions")
    .description("Search and analyze local AI coding-agent session history")
    .version(options.version, "-V, --version")
    .showSuggestionAfterError(false)
    .configureOutput({
      writeOut: options.output.writeOut,
      writeErr: options.output.writeErr,
      outputError: (text, write) => write(text),
    })
    .exitOverride()
    .action(() => program.outputHelp());

  program
    .command("doctor")
    .description("Check local runtime capabilities without indexing")
    .addOption(
      new Option("--format <format>", "output format").choices(["human", "json"]).default("human"),
    )
    .action(async (commandOptions: { format: "human" | "json" }) => {
      const report = await options.doctor();
      options.output.writeOut(renderDoctor(report, commandOptions.format));
      if (!report.ok) throw new OperationalExit();
    });

  return program;
}

function renderDoctor(report: DoctorReport, format: "human" | "json"): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;

  const lines = report.checks.map(
    (check) => `[${check.ok ? "pass" : "fail"}] ${check.label}: ${check.summary}`,
  );
  lines.push("", `Overall: ${report.ok ? "pass" : "fail"}`);
  return `${lines.join("\n")}\n`;
}
