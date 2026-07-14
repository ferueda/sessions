import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import type { DataClearReport } from "../application/clear-index.ts";
import type { ForgetSessionReport } from "../application/forget-session.ts";
import type { PathsReport } from "../application/get-paths.ts";
import type { IndexReport } from "../application/index-report.ts";
import type { ListSessionsResult } from "../application/list-sessions.ts";
import type { DoctorReport } from "../application/run-doctor.ts";
import type { ShowSessionResult } from "../application/show-session.ts";
import { MAX_LIST_LIMIT } from "../application/list-sessions.ts";
import { MAX_SHOW_CONTEXT } from "../application/show-session.ts";
import { parseSessionIdentity } from "../domain/session-identity.ts";
import type { SessionIdentity } from "../domain/session.ts";
import {
  renderDataClear,
  renderDoctor,
  renderForget,
  renderIndex,
  renderList,
  renderPaths,
  renderShow,
  type OutputFormat,
} from "./render.ts";

export interface CliOutput {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface ProgramOptions {
  readonly version: string;
  readonly output: CliOutput;
  readonly doctor: () => Promise<DoctorReport>;
  readonly paths: () => Promise<PathsReport>;
  readonly indexSources: readonly string[];
  readonly index: (source?: string) => Promise<IndexReport>;
  readonly list: (limit?: number) => Promise<ListSessionsResult>;
  readonly show: (input: {
    readonly identity: SessionIdentity;
    readonly entry?: number;
    readonly context?: number;
  }) => Promise<ShowSessionResult>;
  readonly forget: (identity: SessionIdentity) => Promise<ForgetSessionReport>;
  readonly clearData: () => Promise<DataClearReport>;
}

export class OperationalExit extends Error {
  constructor(message = "command completed with an incomplete result") {
    super(message);
    this.name = "OperationalExit";
  }
}

const formatOption = () =>
  new Option("--format <format>", "output format").choices(["human", "json"]).default("human");

export function createProgram(options: ProgramOptions): Command {
  const program = new Command();
  program
    .name("sessions")
    .description("Capture and inspect local AI coding-agent session history")
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
    .description("Check local runtime and source capabilities without indexing")
    .addOption(formatOption())
    .action(async ({ format }: { format: OutputFormat }) => {
      const report = await options.doctor();
      options.output.writeOut(renderDoctor(report, format));
      if (!report.ok) throw new OperationalExit("doctor reported failed checks");
    });

  program
    .command("paths")
    .description("Show Sessions-owned paths and source status without creating state")
    .addOption(formatOption())
    .action(async ({ format }: { format: OutputFormat }) => {
      options.output.writeOut(renderPaths(await options.paths(), format));
    });

  program
    .command("index")
    .description("Capture current local sessions into the durable library")
    .addOption(
      new Option("--source <source>", "source to index").choices([...options.indexSources]),
    )
    .addOption(formatOption())
    .action(async ({ source, format }: { source?: string; format: OutputFormat }) => {
      const report = await options.index(source);
      options.output.writeOut(renderIndex(report, format));
      if (report.incompleteSources > 0) throw new OperationalExit();
    });

  program
    .command("list")
    .description("List retained sessions")
    .addOption(
      new Option("--limit <number>", "maximum sessions").argParser((value) =>
        parseInteger(value, { minimum: 1, maximum: MAX_LIST_LIMIT }),
      ),
    )
    .action(async ({ limit }: { limit?: number }) => {
      options.output.writeOut(renderList(await options.list(limit)));
    });

  program
    .command("show <canonical-id>")
    .description("Show a retained session transcript")
    .addOption(
      new Option("--entry <number>", "focus entry ordinal").argParser((value) =>
        parseInteger(value, { minimum: 0 }),
      ),
    )
    .addOption(
      new Option("--context <number>", "entries of context").argParser((value) =>
        parseInteger(value, { minimum: 0, maximum: MAX_SHOW_CONTEXT }),
      ),
    )
    .action(async (canonicalId: string, values: { entry?: number; context?: number }) => {
      if (values.context !== undefined && values.entry === undefined)
        usage("--context requires --entry");
      const identity = parseIdentity(canonicalId);
      options.output.writeOut(renderShow(await options.show({ identity, ...values })));
    });

  program
    .command("forget <canonical-id>")
    .description("Delete one retained Sessions-owned copy")
    .addOption(formatOption())
    .action(async (canonicalId: string, { format }: { format: OutputFormat }) => {
      const identity = parseIdentity(canonicalId);
      options.output.writeOut(renderForget(await options.forget(identity), format));
    });

  const data = program.command("data").description("Manage Sessions-owned local data");
  data
    .command("clear")
    .description("Delete all Sessions-owned local data")
    .requiredOption("--yes", "confirm destructive deletion")
    .addOption(formatOption())
    .action(async ({ format }: { format: OutputFormat; yes: true }) => {
      options.output.writeOut(renderDataClear(await options.clearData(), format));
    });

  return program;
}

function parseInteger(
  value: string,
  bounds: { readonly minimum: number; readonly maximum?: number },
): number {
  if (!/^\d+$/u.test(value)) throw new InvalidArgumentError("expected an integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("integer is too large");
  if (parsed < bounds.minimum || (bounds.maximum !== undefined && parsed > bounds.maximum)) {
    const range =
      bounds.maximum === undefined
        ? `${String(bounds.minimum)} or greater`
        : `${String(bounds.minimum)} through ${String(bounds.maximum)}`;
    throw new InvalidArgumentError(`expected an integer from ${range}`);
  }
  return parsed;
}

function parseIdentity(value: string): SessionIdentity {
  const parsed = parseSessionIdentity(value);
  if (!parsed.ok) usage("canonical session ID is invalid");
  return parsed.identity;
}

function usage(message: string): never {
  throw new CommanderError(2, "sessions.invalid-argument", `error: ${message}`);
}
