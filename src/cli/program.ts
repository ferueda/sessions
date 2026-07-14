import { Command, Option } from "commander";

import type { PathsReport } from "../application/get-paths.ts";
import type { DoctorReport } from "../application/run-doctor.ts";

export interface CliOutput {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface ProgramOptions {
  readonly version: string;
  readonly output: CliOutput;
  readonly doctor: () => Promise<DoctorReport>;
  readonly paths: () => Promise<PathsReport>;
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

  program
    .command("paths")
    .description("Show Sessions-owned local state paths without creating them")
    .addOption(
      new Option("--format <format>", "output format").choices(["human", "json"]).default("human"),
    )
    .action(async (commandOptions: { format: "human" | "json" }) => {
      const report = await options.paths();
      options.output.writeOut(renderPaths(report, commandOptions.format));
    });

  return program;
}

function renderPaths(report: PathsReport, format: "human" | "json"): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;

  const schema =
    report.index.schemaVersion === null ? "not available" : String(report.index.schemaVersion);
  return `${[
    `Index directory: ${report.index.directory}`,
    `Index database: ${report.index.database}`,
    `Index WAL: ${report.index.wal}`,
    `Index shared memory: ${report.index.shm}`,
    `Initialized: ${report.index.initialized ? "yes" : "no"}`,
    `State: ${report.index.state}`,
    `Schema: ${schema} (supported: ${String(report.index.supportedSchemaVersion)})`,
  ].join("\n")}\n`;
}

function renderDoctor(report: DoctorReport, format: "human" | "json"): string {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;

  const lines = report.checks.map(
    (check) => `[${check.ok ? "pass" : "fail"}] ${check.label}: ${check.summary}`,
  );
  lines.push("", `Overall: ${report.ok ? "pass" : "fail"}`);
  return `${lines.join("\n")}\n`;
}
