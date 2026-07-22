import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import type { DataClearReport } from "../application/clear-index.ts";
import type { DataCompactReport } from "../application/compact-index.ts";
import type { DataRepairOrphansReport } from "../application/repair-orphaned-content.ts";
import type {
  DoctorProgressEvent,
  DoctorProgressObserver,
} from "../application/doctor-progress.ts";
import type { ExportSessionResult } from "../application/export-session.ts";
import type { ForgetSessionReport } from "../application/forget-session.ts";
import type { PathsReport } from "../application/get-paths.ts";
import type { IndexReport } from "../application/index-report.ts";
import type { IndexProgressEvent, IndexProgressObserver } from "../application/index-progress.ts";
import type { ListSessionsResult } from "../application/list-sessions.ts";
import {
  MAX_ENTRY_LIST_LIMIT,
  type ListSessionEntriesResult,
} from "../application/list-session-entries.ts";
import type { SearchSessionsResult } from "../application/search-sessions.ts";
import type { DoctorReport } from "../application/run-doctor.ts";
import { MAX_SESSION_ENTRY_RANGE_COUNT } from "../application/session-entry-range.ts";
import type { ShowSessionResult } from "../application/show-session.ts";
import { MAX_LIST_LIMIT } from "../application/list-sessions.ts";
import { MAX_SEARCH_CONTEXT, MAX_SEARCH_LIMIT } from "../application/search-sessions.ts";
import { MAX_SHOW_CONTEXT } from "../application/show-session.ts";
import { isCanonicalTimestamp } from "../domain/canonical-timestamp.ts";
import {
  isSessionDocumentDigest,
  SESSION_DOCUMENT_DIGEST_SCHEME,
  type SessionDocumentDigest,
} from "../domain/public-session-document.ts";
import type {
  SessionManifestFilterInput,
  SessionManifestResult,
} from "../domain/session-manifest.ts";
import { parseSessionIdentity } from "../domain/session-identity.ts";
import { canonicalizeSessionSearchText } from "../domain/session-query.ts";
import type {
  SessionFilterInput,
  SessionEntryFilterInput,
  SessionEntrySelection,
  SessionSearchFilterInput,
  SessionSearchTermMode,
  SessionSourceState,
} from "../domain/session-query.ts";
import type { Actor, ContentOrigin, SessionIdentity } from "../domain/session.ts";
import { encodeStructuredJson } from "./encode-json-output.ts";
import { encodeStructuredJsonl } from "./encode-jsonl-output.ts";
import {
  buildListJsonV1,
  buildListJsonlV1,
  buildEntriesJsonV1,
  buildEntriesJsonlV1,
  buildManifestJsonV1,
  buildManifestJsonlV1,
  buildSearchJsonV1,
  buildSearchJsonlV1,
  buildSnapshotJsonV1,
  buildSnapshotJsonlV1,
} from "./structured-output.ts";
import {
  renderDataClear,
  renderDataCompact,
  renderDataRepairOrphans,
  renderDoctor,
  renderForget,
  renderIndex,
  renderList,
  renderEntries,
  renderPaths,
  renderSearch,
  renderShow,
  type ExportOutputFormat,
  type OperationalOutputFormat,
  type RetainedQueryOutputFormat,
} from "./render.ts";

export interface CliOutput {
  readonly stderrIsInteractive?: boolean;
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface ProgramOptions {
  readonly version: string;
  readonly output: CliOutput;
  readonly doctor: (options?: {
    readonly progress?: DoctorProgressObserver;
  }) => Promise<DoctorReport>;
  readonly paths: () => Promise<PathsReport>;
  readonly indexSources: readonly string[];
  readonly index: (
    source?: string,
    options?: { readonly progress?: IndexProgressObserver },
  ) => Promise<IndexReport>;
  readonly list: (input: {
    readonly filter?: SessionFilterInput;
    readonly limit?: number;
    readonly cursor?: string;
  }) => Promise<ListSessionsResult>;
  readonly manifest: (input: {
    readonly filter?: SessionManifestFilterInput;
  }) => Promise<SessionManifestResult>;
  readonly entries: (input: {
    readonly filter?: SessionEntryFilterInput;
    readonly selection?: SessionEntrySelection;
    readonly limit?: number;
    readonly cursor?: string;
  }) => Promise<ListSessionEntriesResult>;
  readonly search: (input: {
    readonly text: string;
    readonly termMode?: SessionSearchTermMode;
    readonly filter?: SessionSearchFilterInput;
    readonly limit?: number;
    readonly context?: number;
    readonly cursor?: string;
  }) => Promise<SearchSessionsResult>;
  readonly show: (input: {
    readonly identity: SessionIdentity;
    readonly expectedDocumentDigest?: SessionDocumentDigest;
    readonly entry?: number;
    readonly context?: number;
    readonly fromEntry?: number;
    readonly toEntry?: number;
  }) => Promise<ShowSessionResult>;
  readonly export: (input: {
    readonly identity: SessionIdentity;
    readonly expectedDocumentDigest?: SessionDocumentDigest;
    readonly full?: boolean;
    readonly fromEntry?: number;
    readonly toEntry?: number;
  }) => Promise<ExportSessionResult>;
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

const operationalFormatOption = () =>
  new Option("--format <format>", "output format").choices(["human", "json"]).default("human");

const retainedQueryFormatOption = () =>
  new Option("--format <format>", "output format")
    .choices(["human", "json", "jsonl"])
    .default("human");

const machineFormatOption = () =>
  new Option("--format <format>", "output format").choices(["json", "jsonl"]).makeOptionMandatory();

const writeLongOperationNotice = (output: CliOutput, message: string): void => {
  if (output.stderrIsInteractive !== true) return;
  try {
    output.writeErr(`${message}\n`);
  } catch {
    // Terminal feedback is best-effort and must not change command behavior.
  }
};

function createIndexProgressObserver(output: CliOutput): IndexProgressObserver | undefined {
  if (output.stderrIsInteractive !== true) return undefined;
  return (event) => writeLongOperationNotice(output, renderIndexProgress(event));
}

function createDoctorProgressObserver(output: CliOutput): DoctorProgressObserver | undefined {
  if (output.stderrIsInteractive !== true) return undefined;
  return (event) => writeLongOperationNotice(output, renderDoctorProgress(event));
}

function renderDoctorProgress(event: DoctorProgressEvent): string {
  switch (event.phase) {
    case "library-state":
      return "Inspecting Sessions library state.";
    case "canonical":
      return "Checking retained session documents.";
    case "capture-scope":
      return "Checking retained evidence coverage.";
    case "foreign-keys":
      return "Checking retained session relationships.";
    case "content-reachability":
      return "Checking retained content reachability.";
    case "fts-structure":
      return "Checking search index structure.";
    case "fts-content":
      return "Checking search index coverage.";
    case "fts-semantic":
      return "Checking search index terms and positions.";
    case "fts-security":
      return "Checking search index deletion support.";
    case "page-reclamation":
      return "Checking library space-reclamation settings.";
    case "run-records":
      return "Checking index run records.";
    case "writer-lease":
      return "Checking current library ownership.";
  }
}

function renderIndexProgress(event: IndexProgressEvent): string {
  if (event.kind === "writer-open-mode") {
    switch (event.mode) {
      case "fast":
        return "Using the clean Sessions library fast path.";
      case "certified-recovery":
        return "Using bounded checks for the prior certified Sessions writer generation.";
      case "bootstrap":
        return "Preparing a new Sessions library.";
      case "full-validation":
        return "Verifying the full Sessions library; large libraries may take longer.";
    }
  }
  switch (event.phase) {
    case "canonical":
      return "Checking retained session documents.";
    case "foreign-keys":
      return "Checking retained session relationships.";
    case "fts-structure":
      return "Checking search index structure.";
    case "fts-content":
      return "Checking search index coverage.";
    case "fts-semantic":
      return "Checking search index terms and positions.";
    case "fts-rebuild":
      return "Rebuilding the search index from retained content.";
  }
}

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
    .addOption(operationalFormatOption())
    .action(async ({ format }: { format: OperationalOutputFormat }) => {
      writeLongOperationNotice(
        options.output,
        "Checking Sessions health; large retained libraries may take several minutes.",
      );
      const progress = createDoctorProgressObserver(options.output);
      const report =
        progress === undefined ? await options.doctor() : await options.doctor({ progress });
      options.output.writeOut(renderDoctor(report, format));
      if (!report.ok) throw new OperationalExit("doctor reported failed checks");
    });

  program
    .command("paths")
    .description("Show Sessions-owned paths and source status without creating state")
    .addOption(operationalFormatOption())
    .action(async ({ format }: { format: OperationalOutputFormat }) => {
      options.output.writeOut(renderPaths(await options.paths(), format));
    });

  program
    .command("index")
    .description("Capture current local sessions into the durable library")
    .addOption(
      new Option("--source <source>", "source to index").choices([...options.indexSources]),
    )
    .addOption(operationalFormatOption())
    .action(async ({ source, format }: { source?: string; format: OperationalOutputFormat }) => {
      writeLongOperationNotice(
        options.output,
        "Indexing sessions; this may take a couple of minutes.",
      );
      const progress = createIndexProgressObserver(options.output);
      const report =
        progress === undefined
          ? await options.index(source)
          : await options.index(source, { progress });
      options.output.writeOut(renderIndex(report, format));
      if (report.incompleteSources > 0) throw new OperationalExit();
    });

  const list = program.command("list").description("List retained sessions");
  addSessionFilterOptions(list)
    .addOption(retainedQueryFormatOption())
    .addOption(
      new Option("--limit <number>", "maximum sessions").argParser((value) =>
        parseInteger(value, { minimum: 1, maximum: MAX_LIST_LIMIT }),
      ),
    )
    .option("--cursor <cursor>", "continue a previous list query")
    .action(async (values: ListOptionValues) => {
      const filter = sessionFilter(values);
      const result = await options.list({
        ...(filter === undefined ? {} : { filter }),
        ...(values.limit === undefined ? {} : { limit: values.limit }),
        ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      });
      options.output.writeOut(renderListOutput(result, values.format));
    });

  const manifest = program
    .command("manifest")
    .description("Inventory retained session revisions from one library snapshot");
  addManifestFilterOptions(manifest)
    .addOption(machineFormatOption())
    .action(async (values: ManifestOptionValues) => {
      const filter = manifestFilter(values);
      const result = await options.manifest(filter === undefined ? {} : { filter });
      options.output.writeOut(renderManifestOutput(result, values.format));
    });

  const search = program.command("search <text>").description("Search retained session evidence");
  addEntryFilterOptions(addSessionFilterOptions(search).addOption(retainedQueryFormatOption()))
    .addOption(
      new Option("--match <mode>", "literal search term match mode")
        .choices(["all", "any"])
        .default("all"),
    )
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
      const searchText = parseSearchText(text);
      const filter = searchFilter(values);
      const result = await options.search({
        text: searchText,
        termMode: values.match,
        ...(filter === undefined ? {} : { filter }),
        ...(values.limit === undefined ? {} : { limit: values.limit }),
        ...(values.context === undefined ? {} : { context: values.context }),
        ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      });
      options.output.writeOut(renderSearchOutput(result, values.format));
    });

  const entries = program
    .command("entries")
    .description("List retained session entries without transcript search");
  addEntryFilterOptions(addSessionFilterOptions(entries).addOption(retainedQueryFormatOption()))
    .addOption(
      new Option("--select <selection>", "entries selected per session")
        .choices(["all", "first", "last"])
        .default("all"),
    )
    .addOption(
      new Option("--limit <number>", "maximum entries").argParser((value) =>
        parseInteger(value, { minimum: 1, maximum: MAX_ENTRY_LIST_LIMIT }),
      ),
    )
    .option("--cursor <cursor>", "continue a previous entries query")
    .action(async (values: EntriesOptionValues) => {
      const filter = entryFilter(values);
      const result = await options.entries({
        ...(filter === undefined ? {} : { filter }),
        selection: values.select,
        ...(values.limit === undefined ? {} : { limit: values.limit }),
        ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      });
      options.output.writeOut(renderEntriesOutput(result, values.format));
    });

  const show = program
    .command("show <canonical-id>")
    .description("Show a retained session transcript")
    .addOption(retainedQueryFormatOption())
    .addOption(expectedDocumentDigestOption())
    .addOption(
      new Option("--entry <number>", "focus entry ordinal").argParser((value) =>
        parseInteger(value, { minimum: 0 }),
      ),
    )
    .addOption(
      new Option("--context <number>", "entries of context").argParser((value) =>
        parseInteger(value, { minimum: 0, maximum: MAX_SHOW_CONTEXT }),
      ),
    );
  addEntryRangeOptions(show).action(async (canonicalId: string, values: ShowOptionValues) => {
    const range = entryRangeInput(values);
    if (range !== undefined && (values.entry !== undefined || values.context !== undefined)) {
      usage("--from-entry/--to-entry cannot be combined with --entry or --context");
    }
    if (values.context !== undefined && values.entry === undefined)
      usage("--context requires --entry");
    const identity = parseIdentity(canonicalId);
    const result = await options.show({
      identity,
      ...(values.expectedDocumentDigest === undefined
        ? {}
        : { expectedDocumentDigest: values.expectedDocumentDigest }),
      ...(values.entry === undefined ? {} : { entry: values.entry }),
      ...(values.context === undefined ? {} : { context: values.context }),
      ...range,
    });
    options.output.writeOut(renderSnapshotOutput("show", result, values.format, false));
  });

  const exportCommand = program
    .command("export <canonical-id>")
    .description("Export one retained session as portable structured context")
    .addOption(machineFormatOption())
    .addOption(expectedDocumentDigestOption())
    .option("--full", "include every export-eligible field without presentation bounds");
  addEntryRangeOptions(exportCommand).action(
    async (canonicalId: string, values: ExportOptionValues) => {
      const range = entryRangeInput(values);
      if (range !== undefined && values.full === true) {
        usage("--from-entry/--to-entry cannot be combined with --full");
      }
      const identity = parseIdentity(canonicalId);
      const result = await options.export({
        identity,
        ...(values.expectedDocumentDigest === undefined
          ? {}
          : { expectedDocumentDigest: values.expectedDocumentDigest }),
        ...(values.full === true ? { full: true } : {}),
        ...range,
      });
      options.output.writeOut(
        renderSnapshotOutput("export", result, values.format, values.full === true),
      );
    },
  );

  program
    .command("forget <canonical-id>")
    .description("Delete one retained Sessions-owned copy")
    .addOption(operationalFormatOption())
    .action(async (canonicalId: string, { format }: { format: OperationalOutputFormat }) => {
      const identity = parseIdentity(canonicalId);
      options.output.writeOut(renderForget(await options.forget(identity), format));
    });

  const data = program.command("data").description("Manage Sessions-owned local data");
  data
    .command("repair-orphans")
    .description("Delete unreachable canonical content from Sessions-owned local data")
    .addOption(operationalFormatOption())
    .action(async ({ format }: { format: OperationalOutputFormat }) => {
      writeLongOperationNotice(
        options.output,
        "Repairing orphaned content; this may take a couple of minutes.",
      );
      const report = await options.repairOrphanedData();
      options.output.writeOut(renderDataRepairOrphans(report, format));
    });
  data
    .command("compact")
    .description("Reclaim reusable whole pages from Sessions-owned local data")
    .addOption(operationalFormatOption())
    .action(async ({ format }: { format: OperationalOutputFormat }) => {
      writeLongOperationNotice(
        options.output,
        "Compacting Sessions data; this may take a couple of minutes.",
      );
      const report = await options.compactData();
      options.output.writeOut(renderDataCompact(report, format));
    });
  data
    .command("clear")
    .description("Delete all Sessions-owned local data")
    .requiredOption("--yes", "confirm destructive deletion")
    .addOption(operationalFormatOption())
    .action(async ({ format }: { format: OperationalOutputFormat; yes: true }) => {
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
  readonly nativeId?: string;
  readonly sourceState?: SessionSourceState;
  readonly workspace?: string;
  readonly capturedAfter?: string;
  readonly capturedBefore?: string;
  readonly observedAfter?: string;
  readonly observedBefore?: string;
  readonly activityAfter?: string;
  readonly activityBefore?: string;
  readonly session?: SessionIdentity;
}

interface ListOptionValues extends SessionOptionValues {
  readonly format: RetainedQueryOutputFormat;
  readonly limit?: number;
  readonly cursor?: string;
}

interface ManifestOptionValues extends Omit<SessionOptionValues, "workspace"> {
  readonly format: ExportOutputFormat;
}

interface SearchOptionValues extends SessionOptionValues {
  readonly format: RetainedQueryOutputFormat;
  readonly match: SessionSearchTermMode;
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

interface EntriesOptionValues extends SessionOptionValues {
  readonly format: RetainedQueryOutputFormat;
  readonly entryAfter?: string;
  readonly entryBefore?: string;
  readonly actor?: Actor;
  readonly origin?: ContentOrigin;
  readonly kind?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
  readonly select: SessionEntrySelection;
  readonly limit?: number;
  readonly cursor?: string;
}

interface ShowOptionValues {
  readonly format: RetainedQueryOutputFormat;
  readonly expectedDocumentDigest?: SessionDocumentDigest;
  readonly entry?: number;
  readonly context?: number;
  readonly fromEntry?: number;
  readonly toEntry?: number;
}

interface ExportOptionValues {
  readonly format: ExportOutputFormat;
  readonly expectedDocumentDigest?: SessionDocumentDigest;
  readonly full?: boolean;
  readonly fromEntry?: number;
  readonly toEntry?: number;
}

interface EntryRangeOptionValues {
  readonly fromEntry?: number;
  readonly toEntry?: number;
}

function renderListOutput(result: ListSessionsResult, format: RetainedQueryOutputFormat): string {
  switch (format) {
    case "human":
      return renderList(result);
    case "json":
      return encodeStructuredJson(buildListJsonV1(result));
    case "jsonl":
      return encodeStructuredJsonl(buildListJsonlV1(result));
  }
}

function renderSearchOutput(
  result: SearchSessionsResult,
  format: RetainedQueryOutputFormat,
): string {
  switch (format) {
    case "human":
      return renderSearch(result);
    case "json":
      return encodeStructuredJson(buildSearchJsonV1(result));
    case "jsonl":
      return encodeStructuredJsonl(buildSearchJsonlV1(result));
  }
}

function renderEntriesOutput(
  result: ListSessionEntriesResult,
  format: RetainedQueryOutputFormat,
): string {
  switch (format) {
    case "human":
      return renderEntries(result);
    case "json":
      return encodeStructuredJson(buildEntriesJsonV1(result));
    case "jsonl":
      return encodeStructuredJsonl(buildEntriesJsonlV1(result));
  }
}

function renderManifestOutput(result: SessionManifestResult, format: ExportOutputFormat): string {
  return format === "json"
    ? encodeStructuredJson(buildManifestJsonV1(result))
    : encodeStructuredJsonl(buildManifestJsonlV1(result));
}

function renderSnapshotOutput(
  command: "show" | "export",
  result: ShowSessionResult | ExportSessionResult,
  format: RetainedQueryOutputFormat,
  full: boolean,
): string {
  if (format === "human") {
    if (command !== "show") throw new TypeError("Export requires a machine output format");
    return renderShow(result);
  }

  const encoding = full ? { exemptFromLimit: true } : {};
  if (format === "json") {
    return encodeStructuredJson(
      command === "show"
        ? buildSnapshotJsonV1("show", result)
        : buildSnapshotJsonV1("export", result),
      encoding,
    );
  }
  return encodeStructuredJsonl(
    command === "show"
      ? buildSnapshotJsonlV1("show", result)
      : buildSnapshotJsonlV1("export", result),
    encoding,
  );
}

function addSessionFilterOptions(command: Command): Command {
  return addSessionFilterOptionsInternal(command, true);
}

function addManifestFilterOptions(command: Command): Command {
  return addSessionFilterOptionsInternal(command, false);
}

function addSessionFilterOptionsInternal(command: Command, includeWorkspace: boolean): Command {
  let configured = command
    .option("--source <source>", "exact source kind", parseSource)
    .option("--instance <instance>", "exact source instance", parseNonEmptyValue)
    .option("--native-id <native-id>", "exact provider-native session ID", parseNonEmptyValue)
    .addOption(
      new Option("--source-state <state>", "effective source state").choices(SOURCE_STATES),
    );
  if (includeWorkspace) {
    configured = configured.option("--workspace <workspace>", "exact retained workspace");
  }
  return configured
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
    .option(
      "--activity-after <timestamp>",
      "exclude session activity at or before this time",
      parseTimestamp,
    )
    .option(
      "--activity-before <timestamp>",
      "exclude session activity at or after this time",
      parseTimestamp,
    )
    .option("--session <canonical-id>", "exact canonical session", parseIdentity);
}

function manifestFilter(values: ManifestOptionValues): SessionManifestFilterInput | undefined {
  validateSessionFilterValues(values);
  const filter: SessionManifestFilterInput = {
    ...(values.source === undefined ? {} : { source: values.source }),
    ...(values.instance === undefined ? {} : { instance: values.instance }),
    ...(values.nativeId === undefined ? {} : { nativeId: values.nativeId }),
    ...(values.sourceState === undefined ? {} : { sourceState: values.sourceState }),
    ...(values.capturedAfter === undefined ? {} : { capturedAfter: values.capturedAfter }),
    ...(values.capturedBefore === undefined ? {} : { capturedBefore: values.capturedBefore }),
    ...(values.observedAfter === undefined ? {} : { observedAfter: values.observedAfter }),
    ...(values.observedBefore === undefined ? {} : { observedBefore: values.observedBefore }),
    ...(values.activityAfter === undefined ? {} : { activityAfter: values.activityAfter }),
    ...(values.activityBefore === undefined ? {} : { activityBefore: values.activityBefore }),
    ...(values.session === undefined ? {} : { session: values.session }),
  };
  return Object.keys(filter).length === 0 ? undefined : filter;
}

function addEntryFilterOptions(command: Command): Command {
  return command
    .option("--entry-after <timestamp>", "exclude entries at or before this time", parseTimestamp)
    .option("--entry-before <timestamp>", "exclude entries at or after this time", parseTimestamp)
    .addOption(new Option("--actor <actor>", "exact entry actor").choices(ACTORS))
    .addOption(new Option("--origin <origin>", "exact content origin").choices(ORIGINS))
    .option("--kind <kind>", "exact entry kind")
    .option("--tool-name <name>", "exact observed tool name")
    .option("--tool-namespace <namespace>", "exact observed tool namespace");
}

function addEntryRangeOptions(command: Command): Command {
  return command
    .addOption(
      new Option("--from-entry <number>", "first entry ordinal, inclusive").argParser((value) =>
        parseInteger(value, { minimum: 0 }),
      ),
    )
    .addOption(
      new Option("--to-entry <number>", "last entry ordinal, inclusive").argParser((value) =>
        parseInteger(value, { minimum: 0 }),
      ),
    );
}

function expectedDocumentDigestOption(): Option {
  return new Option(
    "--expected-document-digest <digest>",
    "require the retained document digest",
  ).argParser(parseExpectedDocumentDigest);
}

function entryRangeInput(
  values: EntryRangeOptionValues,
): { readonly fromEntry: number; readonly toEntry: number } | undefined {
  if (values.fromEntry === undefined && values.toEntry === undefined) return undefined;
  if (values.fromEntry === undefined || values.toEntry === undefined) {
    usage("--from-entry and --to-entry must be used together");
  }
  if (values.fromEntry > values.toEntry) {
    usage("entry range must not be reversed");
  }
  if (values.toEntry - values.fromEntry >= MAX_SESSION_ENTRY_RANGE_COUNT) {
    usage(`entry range may contain at most ${String(MAX_SESSION_ENTRY_RANGE_COUNT)} entries`);
  }
  return { fromEntry: values.fromEntry, toEntry: values.toEntry };
}

function sessionFilter(values: SessionOptionValues): SessionFilterInput | undefined {
  validateSessionFilterValues(values);
  const filter: SessionFilterInput = {
    ...(values.source === undefined ? {} : { source: values.source }),
    ...(values.instance === undefined ? {} : { instance: values.instance }),
    ...(values.nativeId === undefined ? {} : { nativeId: values.nativeId }),
    ...(values.sourceState === undefined ? {} : { sourceState: values.sourceState }),
    ...(values.workspace === undefined ? {} : { workspace: values.workspace }),
    ...(values.capturedAfter === undefined ? {} : { capturedAfter: values.capturedAfter }),
    ...(values.capturedBefore === undefined ? {} : { capturedBefore: values.capturedBefore }),
    ...(values.observedAfter === undefined ? {} : { observedAfter: values.observedAfter }),
    ...(values.observedBefore === undefined ? {} : { observedBefore: values.observedBefore }),
    ...(values.activityAfter === undefined ? {} : { activityAfter: values.activityAfter }),
    ...(values.activityBefore === undefined ? {} : { activityBefore: values.activityBefore }),
    ...(values.session === undefined ? {} : { session: values.session }),
  };
  return Object.keys(filter).length === 0 ? undefined : filter;
}

function validateSessionFilterValues(values: Omit<SessionOptionValues, "workspace">): void {
  if (values.instance !== undefined && values.source === undefined) {
    usage("--instance requires --source");
  }
  validateBounds(values.capturedAfter, values.capturedBefore, "capture");
  validateBounds(values.observedAfter, values.observedBefore, "observation");
  validateBounds(values.activityAfter, values.activityBefore, "activity");
}

function searchFilter(values: SearchOptionValues): SessionSearchFilterInput | undefined {
  return entryFilter(values);
}

function entryFilter(
  values: SearchOptionValues | EntriesOptionValues,
): SessionEntryFilterInput | undefined {
  validateBounds(values.entryAfter, values.entryBefore, "entry");
  const common = sessionFilter(values);
  const filter: SessionEntryFilterInput = {
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

function parseExpectedDocumentDigest(value: string): SessionDocumentDigest {
  const candidate = {
    scheme: SESSION_DOCUMENT_DIGEST_SCHEME,
    digest: value,
  };
  if (!isSessionDocumentDigest(candidate)) {
    throw new InvalidArgumentError("expected a 64-character lowercase hexadecimal document digest");
  }
  return Object.freeze(candidate);
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

function parseSearchText(value: string): string {
  try {
    return canonicalizeSessionSearchText(value);
  } catch (error) {
    if (error instanceof TypeError) usage(error.message);
    throw error;
  }
}
