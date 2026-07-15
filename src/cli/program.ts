import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import type { DataClearReport } from "../application/clear-index.ts";
import type { DataCompactReport } from "../application/compact-index.ts";
import type { DataRepairOrphansReport } from "../application/repair-orphaned-content.ts";
import type { ForgetSessionReport } from "../application/forget-session.ts";
import type { PathsReport } from "../application/get-paths.ts";
import type { IndexReport } from "../application/index-report.ts";
import type { ListSessionsResult } from "../application/list-sessions.ts";
import type { SearchSessionsResult } from "../application/search-sessions.ts";
import type { DoctorReport } from "../application/run-doctor.ts";
import type { ShowSessionResult } from "../application/show-session.ts";
import { MAX_LIST_LIMIT } from "../application/list-sessions.ts";
import { MAX_SEARCH_CONTEXT, MAX_SEARCH_LIMIT } from "../application/search-sessions.ts";
import { MAX_SHOW_CONTEXT } from "../application/show-session.ts";
import { isCanonicalTimestamp } from "../domain/canonical-timestamp.ts";
import { parseSessionIdentity } from "../domain/session-identity.ts";
import type {
  SessionFilterInput,
  SessionSearchFilterInput,
  SessionSourceState,
} from "../domain/session-query.ts";
import type { Actor, ContentOrigin, SessionIdentity } from "../domain/session.ts";
import { splitUnicodeWhitespaceTerms } from "../domain/unicode-whitespace.ts";
import {
  renderDataClear,
  renderDataCompact,
  renderDataRepairOrphans,
  renderDoctor,
  renderForget,
  renderIndex,
  renderList,
  renderPaths,
  renderSearch,
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
  readonly list: (input: {
    readonly filter?: SessionFilterInput;
    readonly limit?: number;
    readonly cursor?: string;
  }) => Promise<ListSessionsResult>;
  readonly search: (input: {
    readonly text: string;
    readonly filter?: SessionSearchFilterInput;
    readonly limit?: number;
    readonly context?: number;
    readonly cursor?: string;
  }) => Promise<SearchSessionsResult>;
  readonly show: (input: {
    readonly identity: SessionIdentity;
    readonly entry?: number;
    readonly context?: number;
  }) => Promise<ShowSessionResult>;
  readonly forget: (identity: SessionIdentity) => Promise<ForgetSessionReport>;
  readonly clearData: () => Promise<DataClearReport>;
  readonly compactData: () => Promise<DataCompactReport>;
  readonly repairOrphanedData: () => Promise<DataRepairOrphansReport>;
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

  const list = program.command("list").description("List retained sessions");
  addSessionFilterOptions(list)
    .addOption(
      new Option("--limit <number>", "maximum sessions").argParser((value) =>
        parseInteger(value, { minimum: 1, maximum: MAX_LIST_LIMIT }),
      ),
    )
    .option("--cursor <cursor>", "continue a previous list query")
    .action(async (values: SessionOptionValues & { limit?: number; cursor?: string }) => {
      const filter = sessionFilter(values);
      options.output.writeOut(
        renderList(
          await options.list({
            ...(filter === undefined ? {} : { filter }),
            ...(values.limit === undefined ? {} : { limit: values.limit }),
            ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
          }),
        ),
      );
    });

  const search = program.command("search <text>").description("Search retained session evidence");
  addSessionFilterOptions(search)
    .option("--entry-after <timestamp>", "exclude entries at or before this time", parseTimestamp)
    .option("--entry-before <timestamp>", "exclude entries at or after this time", parseTimestamp)
    .addOption(new Option("--actor <actor>", "exact entry actor").choices(ACTORS))
    .addOption(new Option("--origin <origin>", "exact content origin").choices(ORIGINS))
    .option("--kind <kind>", "exact entry kind")
    .option("--tool-name <name>", "exact observed tool name")
    .option("--tool-namespace <namespace>", "exact observed tool namespace")
    .addOption(
      new Option("--limit <number>", "maximum search hits").argParser((value) =>
        parseInteger(value, { minimum: 1, maximum: MAX_SEARCH_LIMIT }),
      ),
    )
    .addOption(
      new Option("--context <number>", "adjacent entries on each side").argParser((value) =>
        parseInteger(value, { minimum: 0, maximum: MAX_SEARCH_CONTEXT }),
      ),
    )
    .option("--cursor <cursor>", "continue a previous search query")
    .action(async (text: string, values: SearchOptionValues) => {
      if (splitUnicodeWhitespaceTerms(text).length === 0) {
        usage("search text must not be blank");
      }
      const filter = searchFilter(values);
      options.output.writeOut(
        renderSearch(
          await options.search({
            text,
            ...(filter === undefined ? {} : { filter }),
            ...(values.limit === undefined ? {} : { limit: values.limit }),
            ...(values.context === undefined ? {} : { context: values.context }),
            ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
          }),
        ),
      );
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
    .command("repair-orphans")
    .description("Delete unreachable canonical content from Sessions-owned local data")
    .addOption(formatOption())
    .action(async ({ format }: { format: OutputFormat }) => {
      options.output.writeOut(renderDataRepairOrphans(await options.repairOrphanedData(), format));
    });
  data
    .command("compact")
    .description("Reclaim reusable whole pages from Sessions-owned local data")
    .addOption(formatOption())
    .action(async ({ format }: { format: OutputFormat }) => {
      options.output.writeOut(renderDataCompact(await options.compactData(), format));
    });
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

const ACTORS: readonly Actor[] = ["human", "model", "tool", "system", "unknown"];
const ORIGINS: readonly ContentOrigin[] = [
  "human",
  "injected",
  "delegated",
  "replayed-copied",
  "model",
  "tool",
  "system",
  "unknown",
];
const SOURCE_STATES: readonly SessionSourceState[] = ["present", "missing", "unknown"];

interface SessionOptionValues {
  readonly source?: string;
  readonly instance?: string;
  readonly sourceState?: SessionSourceState;
  readonly workspace?: string;
  readonly capturedAfter?: string;
  readonly capturedBefore?: string;
  readonly observedAfter?: string;
  readonly observedBefore?: string;
  readonly session?: SessionIdentity;
}

interface SearchOptionValues extends SessionOptionValues {
  readonly entryAfter?: string;
  readonly entryBefore?: string;
  readonly actor?: Actor;
  readonly origin?: ContentOrigin;
  readonly kind?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
  readonly limit?: number;
  readonly context?: number;
  readonly cursor?: string;
}

function addSessionFilterOptions(command: Command): Command {
  return command
    .option("--source <source>", "exact source kind", parseSource)
    .option("--instance <instance>", "exact source instance", parseNonEmptyValue)
    .addOption(
      new Option("--source-state <state>", "effective source state").choices(SOURCE_STATES),
    )
    .option("--workspace <workspace>", "exact retained workspace")
    .option(
      "--captured-after <timestamp>",
      "exclude captures at or before this time",
      parseTimestamp,
    )
    .option(
      "--captured-before <timestamp>",
      "exclude captures at or after this time",
      parseTimestamp,
    )
    .option(
      "--observed-after <timestamp>",
      "exclude source observations at or before this time",
      parseTimestamp,
    )
    .option(
      "--observed-before <timestamp>",
      "exclude source observations at or after this time",
      parseTimestamp,
    )
    .option("--session <canonical-id>", "exact canonical session", parseIdentity);
}

function sessionFilter(values: SessionOptionValues): SessionFilterInput | undefined {
  if (values.instance !== undefined && values.source === undefined) {
    usage("--instance requires --source");
  }
  validateBounds(values.capturedAfter, values.capturedBefore, "capture");
  validateBounds(values.observedAfter, values.observedBefore, "observation");
  const filter: SessionFilterInput = {
    ...(values.source === undefined ? {} : { source: values.source }),
    ...(values.instance === undefined ? {} : { instance: values.instance }),
    ...(values.sourceState === undefined ? {} : { sourceState: values.sourceState }),
    ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
    ...(values.capturedAfter === undefined ? {} : { capturedAfter: values.capturedAfter }),
    ...(values.capturedBefore === undefined ? {} : { capturedBefore: values.capturedBefore }),
    ...(values.observedAfter === undefined ? {} : { observedAfter: values.observedAfter }),
    ...(values.observedBefore === undefined ? {} : { observedBefore: values.observedBefore }),
    ...(values.session === undefined ? {} : { session: values.session }),
  };
  return Object.keys(filter).length === 0 ? undefined : filter;
}

function searchFilter(values: SearchOptionValues): SessionSearchFilterInput | undefined {
  validateBounds(values.entryAfter, values.entryBefore, "entry");
  const common = sessionFilter(values);
  const filter: SessionSearchFilterInput = {
    ...common,
    ...(values.entryAfter === undefined ? {} : { entryAfter: values.entryAfter }),
    ...(values.entryBefore === undefined ? {} : { entryBefore: values.entryBefore }),
    ...(values.actor === undefined ? {} : { actor: values.actor }),
    ...(values.origin === undefined ? {} : { origin: values.origin }),
    ...(values.kind === undefined ? {} : { entryKind: values.kind }),
    ...(values.toolName === undefined ? {} : { toolName: values.toolName }),
    ...(values.toolNamespace === undefined ? {} : { toolNamespace: values.toolNamespace }),
  };
  return Object.keys(filter).length === 0 ? undefined : filter;
}

function validateBounds(
  after: string | undefined,
  before: string | undefined,
  label: string,
): void {
  if (after !== undefined && before !== undefined && after >= before) {
    usage(`${label} bounds must be increasing and exclusive`);
  }
}

function parseSource(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    throw new InvalidArgumentError("expected a lowercase source kind");
  }
  return value;
}

function parseTimestamp(value: string): string {
  if (!isCanonicalTimestamp(value)) {
    throw new InvalidArgumentError("expected a canonical UTC timestamp");
  }
  return value;
}

function parseNonEmptyValue(value: string): string {
  if (value.length === 0 || !value.isWellFormed()) {
    throw new InvalidArgumentError("expected a non-empty value");
  }
  return value;
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
