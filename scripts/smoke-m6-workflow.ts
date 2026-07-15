import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, readlink, rm } from "node:fs/promises";
import path from "node:path";

import { codexRolloutRecords, createCodexSourceFixture } from "../test/fixtures/codex/source.ts";

export interface SmokeCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface M6SmokeWorkflowOptions {
  readonly temporaryRoot: string;
  readonly run: (args: readonly string[], environment: NodeJS.ProcessEnv) => SmokeCommandResult;
}

const NATIVE_ID = "distribution-smoke-thread";
const TITLE = "Distribution smoke task";
const MESSAGE = "Synthetic distribution smoke message";
const TOOL_MARKER = "distribution-tool-proof";
const BARE_TOOL_NAME = "inspect_fixture";
const NAMESPACED_TOOL_NAME = "read_fixture";
const TOOL_NAMESPACE = "synthetic";
const TOOL_MENTION = `Ordinary text mentions ${TOOL_MARKER}, ${BARE_TOOL_NAME}, and ${TOOL_NAMESPACE}/${NAMESPACED_TOOL_NAME}.`;
const ROLLOUT_PATH = `sessions/2026/07/14/rollout-2026-07-14T00-00-00-${NATIVE_ID}.jsonl`;

/** Exercise the complete M6 journey through a spawned CLI, never through application imports. */
export async function runM6SmokeWorkflow(options: M6SmokeWorkflowOptions): Promise<void> {
  const fixture = await createCodexSourceFixture();
  const dataDirectory = path.join(options.temporaryRoot, "sessions-data");
  const oldCacheDirectory = path.join(options.temporaryRoot, "old-sessions-cache");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: fixture.codexHome,
    CODEX_SQLITE_HOME: "",
    SESSIONS_DATA_DIR: dataDirectory,
    SESSIONS_CACHE_DIR: oldCacheDirectory,
    HOME: fixture.environment.home,
    USERPROFILE: fixture.environment.home,
  };

  try {
    await fixture.writeRollout(ROLLOUT_PATH, [
      ...codexRolloutRecords(NATIVE_ID, MESSAGE),
      {
        timestamp: "2026-07-14T12:01:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "bare-tool-call",
          name: BARE_TOOL_NAME,
          arguments: JSON.stringify({ marker: TOOL_MARKER }),
        },
      },
      {
        timestamp: "2026-07-14T12:02:00.000Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "bare-tool-call",
          output: "Synthetic bare tool result",
        },
      },
      {
        timestamp: "2026-07-14T12:03:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "namespaced-tool-call",
          name: NAMESPACED_TOOL_NAME,
          namespace: TOOL_NAMESPACE,
          input: JSON.stringify({ marker: TOOL_MARKER }),
        },
      },
      {
        timestamp: "2026-07-14T12:04:00.000Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "namespaced-tool-call",
          output: "Synthetic namespaced tool result",
        },
      },
      {
        timestamp: "2026-07-14T12:05:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: `${MESSAGE} follow-up. ${TOOL_MENTION}` },
      },
    ]);
    fixture.writeState([
      {
        id: NATIVE_ID,
        rolloutPath: ROLLOUT_PATH,
        title: TITLE,
        workspace: "/private/synthetic-smoke-workspace",
        createdAtMs: 1_752_499_200_000,
        updatedAtMs: 1_752_502_800_000,
      },
    ]);

    assert.equal(existsSync(dataDirectory), false);
    const freshList = await stableProviderCommand(options, fixture.codexHome, environment, [
      "list",
    ]);
    assertCommand(freshList, 0, "fresh list");
    assert.equal(freshList.stdout, "No sessions found.\n");
    assert.equal(existsSync(dataDirectory), false, "fresh list created Sessions state");

    const doctor = await stableProviderCommand(options, fixture.codexHome, environment, [
      "doctor",
      "--format",
      "json",
    ]);
    assertCommand(doctor, 0, "doctor");
    const doctorReport = parseJson(doctor.stdout);
    assert.equal(doctorReport.schemaVersion, 1);
    assert.equal(doctorReport.command, "doctor");
    assert.equal(doctorReport.ok, true);
    assert.deepEqual(
      readArray(doctorReport, "checks").map((check) => readObject(check).id),
      ["node-runtime", "sqlite-fts5", "library-state", "source-codex"],
    );

    const paths = await stableProviderCommand(options, fixture.codexHome, environment, [
      "paths",
      "--format",
      "json",
    ]);
    assertCommand(paths, 0, "paths");
    const pathsReport = parseJson(paths.stdout);
    assert.equal(pathsReport.schemaVersion, 1);
    assert.equal(pathsReport.command, "paths");
    const library = readObject(pathsReport.library);
    assert.equal(library.directory, dataDirectory);
    assert.equal(library.initialized, false);
    assert.equal(library.state, "uninitialized");
    const source = readObject(readArray(pathsReport, "sources")[0]);
    assert.equal(readObject(source.source).kind, "codex");
    assert.equal(readObject(source.probe).status, "ready");
    assert.deepEqual(
      readArray(readObject(source.probe), "locations").map((location) => readObject(location).role),
      ["codex-home", "sqlite-home"],
    );
    assert.equal(existsSync(dataDirectory), false, "doctor or paths created Sessions state");

    const firstIndex = await stableProviderCommand(options, fixture.codexHome, environment, [
      "index",
      "--source",
      "codex",
      "--format",
      "json",
    ]);
    assertCompleteIndex(firstIndex, { updated: 1, unchanged: 0, missing: 0 });

    const bareToolSearch = await stableProviderCommand(options, fixture.codexHome, environment, [
      "search",
      TOOL_MARKER,
      "--tool-name",
      BARE_TOOL_NAME,
      "--context",
      "0",
    ]);
    assertObservedToolSearch(bareToolSearch, {
      callOrdinal: 1,
      resultOrdinal: 2,
      callTimestamp: "2026-07-14T12:01:00.000Z",
      resultTimestamp: "2026-07-14T12:02:00.000Z",
      callId: "bare-tool-call",
      tool: BARE_TOOL_NAME,
      excludedTool: `${TOOL_NAMESPACE}/${NAMESPACED_TOOL_NAME}`,
    });

    const namespacedToolSearch = await stableProviderCommand(
      options,
      fixture.codexHome,
      environment,
      [
        "search",
        TOOL_MARKER,
        "--tool-name",
        NAMESPACED_TOOL_NAME,
        "--tool-namespace",
        TOOL_NAMESPACE,
        "--context",
        "0",
      ],
    );
    assertObservedToolSearch(namespacedToolSearch, {
      callOrdinal: 3,
      resultOrdinal: 4,
      callTimestamp: "2026-07-14T12:03:00.000Z",
      resultTimestamp: "2026-07-14T12:04:00.000Z",
      callId: "namespaced-tool-call",
      tool: `${TOOL_NAMESPACE}/${NAMESPACED_TOOL_NAME}`,
      excludedTool: BARE_TOOL_NAME,
    });

    const leadingDashSearch = await stableProviderCommand(options, fixture.codexHome, environment, [
      "search",
      "--",
      "---",
    ]);
    assertCommand(leadingDashSearch, 0, "leading-dash search with delimiter");
    assert.equal(leadingDashSearch.stdout, "No matches found.\n");

    const leadingDashOption = await stableProviderCommand(options, fixture.codexHome, environment, [
      "search",
      "---",
    ]);
    assert.equal(leadingDashOption.status, 2);
    assert.equal(leadingDashOption.stdout, "");
    assert.match(leadingDashOption.stderr, /unknown option '---'/u);

    const firstSearch = await stableProviderCommand(options, fixture.codexHome, environment, [
      "search",
      "distribution smoke",
      "--limit",
      "1",
      "--context",
      "1",
    ]);
    assertCommand(firstSearch, 0, "first search page");
    assert.match(
      firstSearch.stdout,
      /Support: 2 occurrence\(s\); 2 unique content value\(s\); 1 known root\(s\); 0 unknown-lineage session\(s\)/u,
    );
    assert.doesNotMatch(firstSearch.stdout, /synthetic-smoke-workspace|sourceMetadata|rollout-/u);
    const cursor = nextCursor(firstSearch.stdout);
    const firstEntry = firstSearchEntry(firstSearch.stdout);

    const secondSearch = await stableProviderCommand(options, fixture.codexHome, environment, [
      "search",
      "distribution smoke",
      "--limit",
      "1",
      "--context",
      "1",
      "--cursor",
      cursor,
    ]);
    assertCommand(secondSearch, 0, "second search page");
    assert.notEqual(firstSearchEntry(secondSearch.stdout), firstEntry);
    assert.doesNotMatch(secondSearch.stdout, /^Next cursor:/mu);
    assert.match(secondSearch.stdout, /Support: 2 occurrence\(s\)/u);

    const presentList = await stableProviderCommand(options, fixture.codexHome, environment, [
      "list",
    ]);
    assertCommand(presentList, 0, "list after index");
    assert.match(presentList.stdout, /\[current; present; /u);
    assert.match(presentList.stdout, new RegExp(escapePattern(TITLE), "u"));
    const canonicalId = firstListedIdentity(presentList.stdout);

    const presentShow = await stableProviderCommand(options, fixture.codexHome, environment, [
      "show",
      canonicalId,
    ]);
    assertCommand(presentShow, 0, "show after index");
    assert.match(presentShow.stdout, new RegExp(escapePattern(MESSAGE), "u"));
    const retainedTranscript = transcriptBody(presentShow.stdout);

    // The fixture intentionally changes here; every CLI call remains surrounded by a stable tree.
    fixture.writeState([]);
    const missingIndex = await stableProviderCommand(options, fixture.codexHome, environment, [
      "index",
      "--format",
      "json",
    ]);
    assertCompleteIndex(missingIndex, { updated: 0, unchanged: 0, missing: 1 });
    const missingReport = parseJson(missingIndex.stdout);
    const missingSource = readObject(readArray(missingReport, "sources")[0]);
    const missingItem = readObject(readArray(missingSource, "items")[0]);
    assert.equal(missingItem.outcome, "missing");
    assert.equal(readObject(missingItem.identity).canonicalId, canonicalId);

    const missingList = await stableProviderCommand(options, fixture.codexHome, environment, [
      "list",
    ]);
    assertCommand(missingList, 0, "list after provider disappearance");
    assert.match(missingList.stdout, /\[current; missing; /u);
    const missingShow = await stableProviderCommand(options, fixture.codexHome, environment, [
      "show",
      canonicalId,
    ]);
    assertCommand(missingShow, 0, "show after provider disappearance");
    assert.equal(transcriptBody(missingShow.stdout), retainedTranscript);

    const repeatedMissing = await stableProviderCommand(options, fixture.codexHome, environment, [
      "index",
      "--format",
      "json",
    ]);
    assertCompleteIndex(repeatedMissing, { updated: 0, unchanged: 0, missing: 1 });

    await rm(fixture.stateDatabase);
    const incomplete = await stableProviderCommand(options, fixture.codexHome, environment, [
      "index",
      "--format",
      "json",
    ]);
    assertCommand(incomplete, 1, "index with unavailable source");
    const incompleteReport = parseJson(incomplete.stdout);
    assert.equal(incompleteReport.incompleteSources, 1);
    const incompleteSource = readObject(readArray(incompleteReport, "sources")[0]);
    assert.equal(incompleteSource.status, "incomplete");
    assert.equal(incompleteSource.failure, "source-unavailable");
    assert.equal(readObject(incompleteSource.coverage).status, "unknown");

    const unknownList = await stableProviderCommand(options, fixture.codexHome, environment, [
      "list",
    ]);
    assertCommand(unknownList, 0, "list after incomplete scan");
    assert.match(unknownList.stdout, /\[current; unknown; /u);
    const unknownShow = await stableProviderCommand(options, fixture.codexHome, environment, [
      "show",
      canonicalId,
    ]);
    assertCommand(unknownShow, 0, "show after incomplete scan");
    assert.equal(transcriptBody(unknownShow.stdout), retainedTranscript);

    fixture.writeState([
      {
        id: NATIVE_ID,
        rolloutPath: ROLLOUT_PATH,
        title: TITLE,
        workspace: "/private/synthetic-smoke-workspace",
        createdAtMs: 1_752_499_200_000,
        updatedAtMs: 1_752_502_800_000,
      },
    ]);
    const restoredIndex = await stableProviderCommand(options, fixture.codexHome, environment, [
      "index",
      "--format",
      "json",
    ]);
    assertCompleteIndex(restoredIndex, { updated: 0, unchanged: 1, missing: 0 });

    const forget = await stableProviderCommand(options, fixture.codexHome, environment, [
      "forget",
      canonicalId,
      "--format",
      "json",
    ]);
    assertCommand(forget, 0, "forget");
    assert.equal(parseJson(forget.stdout).outcome, "forgotten");
    const forgottenList = await stableProviderCommand(options, fixture.codexHome, environment, [
      "list",
    ]);
    assertCommand(forgottenList, 0, "list after forget");
    assert.equal(forgottenList.stdout, "No sessions found.\n");

    const repeatedForget = await stableProviderCommand(options, fixture.codexHome, environment, [
      "forget",
      canonicalId,
      "--format",
      "json",
    ]);
    assertCommand(repeatedForget, 0, "repeat forget");
    assert.equal(parseJson(repeatedForget.stdout).outcome, "absent");

    const recapture = await stableProviderCommand(options, fixture.codexHome, environment, [
      "index",
      "--format",
      "json",
    ]);
    assertCompleteIndex(recapture, { updated: 1, unchanged: 0, missing: 0 });
    const recapturedList = await stableProviderCommand(options, fixture.codexHome, environment, [
      "list",
    ]);
    assertCommand(recapturedList, 0, "list after recapture");
    assert.equal(firstListedIdentity(recapturedList.stdout), canonicalId);

    const clear = await stableProviderCommand(options, fixture.codexHome, environment, [
      "data",
      "clear",
      "--yes",
      "--format",
      "json",
    ]);
    assertCommand(clear, 0, "data clear");
    const clearReport = parseJson(clear.stdout);
    assert.equal(clearReport.schemaVersion, 1);
    assert.equal(clearReport.command, "data-clear");
    assert.equal(clearReport.outcome, "cleared");
    assert.equal(clearReport.databaseRemoved, true);
    for (const file of [
      "sessions.sqlite3",
      "sessions.sqlite3-wal",
      "sessions.sqlite3-shm",
      ".scratch",
    ]) {
      assert.equal(
        existsSync(path.join(dataDirectory, file)),
        false,
        `data clear retained ${file}`,
      );
    }

    const afterClear = await stableProviderCommand(options, fixture.codexHome, environment, [
      "list",
    ]);
    assertCommand(afterClear, 0, "list after data clear");
    assert.equal(afterClear.stdout, "No sessions found.\n");
    assert.equal(existsSync(oldCacheDirectory), false, "CLI read or wrote the old cache location");
  } finally {
    await fixture.dispose();
  }
}

async function stableProviderCommand(
  options: M6SmokeWorkflowOptions,
  providerRoot: string,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<SmokeCommandResult> {
  const before = await snapshotTree(providerRoot);
  const result = options.run(args, environment);
  const after = await snapshotTree(providerRoot);
  assert.deepEqual(after, before, `provider tree changed while running sessions ${args.join(" ")}`);
  return result;
}

function nextCursor(output: string): string {
  const cursor = /^Next cursor: ([A-Za-z0-9_-]+)$/mu.exec(output)?.[1];
  if (cursor === undefined) assert.fail(`search returned no continuation cursor: ${output}`);
  return cursor;
}

function firstSearchEntry(output: string): number {
  const ordinal = /^#(\d+)\s/mu.exec(output)?.[1];
  if (ordinal === undefined) assert.fail(`search returned no entry coordinate: ${output}`);
  return Number(ordinal);
}

function assertCommand(result: SmokeCommandResult, status: number, label: string): void {
  assert.equal(result.status, status, `${label} failed: ${result.stderr || result.stdout}`);
  assert.equal(result.stderr, "", `${label} wrote stderr`);
}

function assertCompleteIndex(
  result: SmokeCommandResult,
  counts: { readonly updated: number; readonly unchanged: number; readonly missing: number },
): void {
  assertCommand(result, 0, "complete index");
  const report = parseJson(result.stdout);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.command, "index");
  assert.equal(report.incompleteSources, 0);
  const reportCounts = readObject(report.counts);
  assert.equal(reportCounts.updated, counts.updated);
  assert.equal(reportCounts.unchanged, counts.unchanged);
  assert.equal(reportCounts.missing, counts.missing);
  const source = readObject(readArray(report, "sources")[0]);
  assert.equal(source.status, "completed");
  assert.equal(readObject(source.coverage).status, "complete");
}

function assertObservedToolSearch(
  result: SmokeCommandResult,
  expected: {
    readonly callOrdinal: number;
    readonly resultOrdinal: number;
    readonly callTimestamp: string;
    readonly resultTimestamp: string;
    readonly callId: string;
    readonly tool: string;
    readonly excludedTool: string;
  },
): void {
  assertCommand(result, 0, `observed tool search for ${expected.tool}`);
  const primaryHeadings = result.stdout.match(/^#\d+ .*$/gmu) ?? [];
  assert.deepEqual(primaryHeadings, [
    `#${String(expected.callOrdinal)} model tool-call ${expected.callTimestamp} tool=${expected.tool} call=${expected.callId}`,
  ]);
  const linkedHeadings = result.stdout.match(/^Context \(linked\) .*$/gmu) ?? [];
  assert.deepEqual(linkedHeadings, [
    `Context (linked) #${String(expected.resultOrdinal)} tool tool-result ${expected.resultTimestamp} call=${expected.callId} related=#${String(expected.callOrdinal)}`,
  ]);
  assert.match(result.stdout, /Support: 1 occurrence\(s\); 1 unique content value\(s\)/u);
  assert.doesNotMatch(result.stdout, new RegExp(escapePattern(expected.excludedTool), "u"));
  assert.doesNotMatch(result.stdout, new RegExp(escapePattern(TOOL_MENTION), "u"));
}

function firstListedIdentity(output: string): string {
  const identity = output.split("\n", 1)[0]?.split("  ", 1)[0];
  if (identity === undefined || !identity.startsWith("codex@")) {
    assert.fail(`list returned no canonical Codex ID: ${output}`);
  }
  return identity;
}

function transcriptBody(output: string): string {
  const separator = output.indexOf("\n\n");
  assert.notEqual(separator, -1, "show output has no transcript separator");
  return output.slice(separator + 2);
}

function parseJson(output: string): Record<string, unknown> {
  return readObject(JSON.parse(output));
}

function readObject(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function readArray(value: Record<string, unknown>, key: string): readonly unknown[] {
  const array = value[key];
  assert.ok(Array.isArray(array), `${key} is not an array`);
  return array;
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

interface TreeEntry {
  readonly path: string;
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly digest?: string;
  readonly target?: string;
}

async function snapshotTree(root: string): Promise<readonly TreeEntry[]> {
  const result: TreeEntry[] = [];
  await visit(root, ".", result);
  return result;
}

async function visit(root: string, relative: string, result: TreeEntry[]): Promise<void> {
  const file = relative === "." ? root : path.join(root, relative);
  const stats = await lstat(file, { bigint: true });
  const type = stats.isDirectory()
    ? "directory"
    : stats.isFile()
      ? "file"
      : stats.isSymbolicLink()
        ? "symlink"
        : "other";
  result.push({
    path: relative,
    type,
    dev: stats.dev.toString(10),
    ino: stats.ino.toString(10),
    mode: stats.mode.toString(10),
    size: stats.size.toString(10),
    mtimeNs: stats.mtimeNs.toString(10),
    ctimeNs: stats.ctimeNs.toString(10),
    ...(type === "file"
      ? {
          digest: createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        }
      : {}),
    ...(type === "symlink" ? { target: await readlink(file) } : {}),
  });
  if (type !== "directory") return;
  const children = await readdir(file);
  children.sort();
  for (const child of children) {
    const childRelative = relative === "." ? child : path.join(relative, child);
    await visit(root, childRelative, result);
  }
}
