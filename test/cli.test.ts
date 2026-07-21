import { Buffer } from "node:buffer";

import { describe, expect, test, vi } from "vitest";

import type { DataClearReport } from "../src/application/clear-index.ts";
import type { DataCompactReport } from "../src/application/compact-index.ts";
import type { DataRepairOrphansReport } from "../src/application/repair-orphaned-content.ts";
import type { ForgetSessionReport } from "../src/application/forget-session.ts";
import type { PathsReport } from "../src/application/get-paths.ts";
import type { IndexReport } from "../src/application/index-report.ts";
import type { ListSessionEntriesResult } from "../src/application/list-session-entries.ts";
import type { ListSessionsResult } from "../src/application/list-sessions.ts";
import type { SearchSessionsResult } from "../src/application/search-sessions.ts";
import type { ShowSessionResult } from "../src/application/show-session.ts";
import type { DoctorReport } from "../src/application/run-doctor.ts";
import { SessionLibraryError } from "../src/application/library-error.ts";
import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../src/application/session-query-error.ts";
import type { ProgramOptions } from "../src/cli/program.ts";
import { CliSignalExit, runCli } from "../src/cli/run.ts";
import { StructuredOutputTooLargeError } from "../src/cli/structured-output-encoding.ts";
import {
  completeCaptureScope,
  uninitializedCaptureScope,
} from "./fixtures/session-capture-scope.ts";

describe("sessions CLI", () => {
  test.each([
    {
      argv: ["index"],
      message: "Indexing sessions; this may take a couple of minutes.",
    },
    {
      argv: ["data", "compact"],
      message: "Compacting Sessions data; this may take a couple of minutes.",
    },
    {
      argv: ["data", "repair-orphans"],
      message: "Repairing orphaned content; this may take a couple of minutes.",
    },
  ])("shows a startup notice for $argv on interactive stderr", async ({ argv, message }) => {
    const events: string[] = [];
    const invocation = await invoke(argv, {}, { interactive: true, events });

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stderr).toBe(`${message}\n`);
    expect(events[0]).toBe(`stderr:${message}\n`);
    expect(events.at(-1)).toMatch(/^stdout:/u);
  });

  test("does not show a notice for commands outside the three-command scope", async () => {
    const events: string[] = [];
    const invocation = await invoke(["data", "clear", "--yes"], {}, { interactive: true, events });

    expect(invocation.exitCode).toBe(0);
    expect(events.every((event) => !event.startsWith("stderr:"))).toBe(true);
  });

  test("reports an operational error after the startup notice", async () => {
    const events: string[] = [];
    const failure = new Error("index failed");
    const invocation = await invoke(
      ["index"],
      {
        index: async () => {
          throw failure;
        },
      },
      { interactive: true, events },
    );

    expect(invocation).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `Indexing sessions; this may take a couple of minutes.\nsessions: ${failure.message}\n`,
    });
    expect(events).toEqual([
      "stderr:Indexing sessions; this may take a couple of minutes.\n",
      `stderr:sessions: ${failure.message}\n`,
    ]);
  });

  test("reports bounded writer progress only on interactive stderr", async () => {
    const index = vi.fn<ProgramOptions["index"]>(async (_source, options) => {
      options?.progress?.({ kind: "writer-open-mode", mode: "full-validation" });
      options?.progress?.({ kind: "writer-validation", phase: "fts-semantic" });
      return indexReport(false);
    });

    const interactive = await invoke(
      ["index", "--format", "json"],
      { index },
      {
        interactive: true,
      },
    );
    const redirected = await invoke(["index", "--format", "json"], { index });

    expect(interactive.exitCode).toBe(0);
    expect(interactive.stderr).toBe(
      "Indexing sessions; this may take a couple of minutes.\n" +
        "Verifying the full Sessions library; large libraries may take longer.\n" +
        "Checking search index terms and positions.\n",
    );
    expect(JSON.parse(interactive.stdout)).toEqual(indexReport(false));
    expect(redirected.stderr).toBe("");
    expect(JSON.parse(redirected.stdout)).toEqual(indexReport(false));
    expect(index.mock.calls[0]?.[1]?.progress).toEqual(expect.any(Function));
    expect(index.mock.calls[1]).toEqual([undefined]);
  });

  test.each([130, 143] as const)("returns signal exit %s without stderr", async (exitCode) => {
    const invocation = await invoke(["index"], {
      index: async () => {
        throw new CliSignalExit(exitCode);
      },
    });

    expect(invocation).toEqual({ exitCode, stdout: "", stderr: "" });
  });

  test("shows the current command surface", async () => {
    const invocation = await invoke([]);

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stdout).toContain("Usage: sessions");
    for (const command of [
      "index",
      "list",
      "manifest",
      "entries",
      "search",
      "show",
      "export",
      "forget",
      "data",
      "paths",
      "doctor",
    ]) {
      expect(invocation.stdout).toContain(command);
    }
    expect(invocation.stderr).toBe("");
  });

  test("prints version and maps invalid usage to exit 2", async () => {
    await expect(invoke(["--version"])).resolves.toEqual({
      exitCode: 0,
      stdout: "1.2.3\n",
      stderr: "",
    });
    const invalid = await invoke(["--unknown"]);
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout).toBe("");
    expect(invalid.stderr).toContain("unknown option");
  });

  test("renders doctor and paths JSON reports", async () => {
    const doctor = await invoke(["doctor", "--format", "json"]);
    const paths = await invoke(["paths", "--format", "json"]);

    expect(JSON.parse(doctor.stdout)).toEqual(passingDoctor());
    expect(JSON.parse(paths.stdout)).toEqual(pathsReport());
    expect(doctor.exitCode).toBe(0);
    expect(paths.exitCode).toBe(0);
  });

  test("renders an incomplete index report before exit 1", async () => {
    const report = indexReport(true);
    const invocation = await invoke(["index", "--source", "codex", "--format", "json"], {
      index: vi.fn<ProgramOptions["index"]>(async () => report),
    });

    expect(invocation.exitCode).toBe(1);
    expect(invocation.stderr).toBe("");
    expect(JSON.parse(invocation.stdout)).toEqual(report);
  });

  test("renders an unavailable skipped source without failing implicit indexing", async () => {
    const report = skippedIndexReport();
    const index = vi.fn<ProgramOptions["index"]>(async () => report);

    const json = await invoke(["index", "--format", "json"], { index });
    const human = await invoke(["index"], { index });

    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(report);
    expect(human).toEqual({
      exitCode: 0,
      stdout:
        "codex: skipped; source unavailable\nTotal: 0 discovered; 0 incomplete source(s); 1 skipped source(s)\n",
      stderr: "",
    });
    expect(index).toHaveBeenNthCalledWith(1, undefined);
    expect(index).toHaveBeenNthCalledWith(2, undefined);
  });

  test("rejects an unregistered source before calling the index handler", async () => {
    const index = vi.fn<ProgramOptions["index"]>();

    const invocation = await invoke(["index", "--source", "cursor"], { index });

    expect(invocation.exitCode).toBe(2);
    expect(index).not.toHaveBeenCalled();
  });

  test("renders the exact empty-list result", async () => {
    const invocation = await invoke(["list"]);

    expect(invocation).toEqual({
      exitCode: 0,
      stdout:
        "No sessions found.\n\nWarning: retained evidence may be incomplete (capture scope is uninitialized).\n",
      stderr: "",
    });
  });

  test("renders the exact empty-search result", async () => {
    const invocation = await invoke(["search", "missing"]);

    expect(invocation).toEqual({
      exitCode: 0,
      stdout:
        "No matches found.\n\nWarning: retained evidence may be incomplete (capture scope is uninitialized).\n",
      stderr: "",
    });
  });

  test("renders the exact empty-entries result", async () => {
    const invocation = await invoke(["entries"]);

    expect(invocation).toEqual({
      exitCode: 0,
      stdout:
        "No entries found.\n\nWarning: retained evidence may be incomplete (capture scope is uninitialized).\n",
      stderr: "",
    });
  });

  test("renders explicit empty JSON and JSONL query pages", async () => {
    const listJson = await invoke(["list", "--format", "json"]);
    const listJsonl = await invoke(["list", "--format", "jsonl"]);
    const searchJson = await invoke(["search", "missing", "--format", "json"]);
    const searchJsonl = await invoke(["search", "missing", "--format", "jsonl"]);
    const entriesJson = await invoke(["entries", "--format", "json"]);
    const entriesJsonl = await invoke(["entries", "--format", "jsonl"]);

    expect(JSON.parse(listJson.stdout)).toEqual({
      schemaVersion: 1,
      command: "list",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: null,
      captureScope: uninitializedCaptureScope,
      sessions: [],
    });
    expect(
      listJsonl.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        schemaVersion: 1,
        command: "list",
        type: "page",
        disposition: "untrusted-history",
        sessionCount: 0,
        nextCursor: null,
        captureScope: uninitializedCaptureScope,
      },
    ]);
    expect(JSON.parse(searchJson.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "search",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: null,
      captureScope: uninitializedCaptureScope,
      hits: [],
    });
    expect(
      searchJsonl.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        schemaVersion: 1,
        command: "search",
        type: "page",
        disposition: "untrusted-history",
        hitCount: 0,
        nextCursor: null,
        captureScope: uninitializedCaptureScope,
        support: emptySearch().support,
      },
    ]);
    expect(JSON.parse(entriesJson.stdout)).toEqual({
      schemaVersion: 1,
      command: "entries",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: null,
      captureScope: uninitializedCaptureScope,
      entries: [],
    });
    expect(
      entriesJsonl.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        schemaVersion: 1,
        command: "entries",
        type: "page",
        disposition: "untrusted-history",
        entryCount: 0,
        nextCursor: null,
        captureScope: uninitializedCaptureScope,
      },
    ]);
    expect(
      [listJson, listJsonl, searchJson, searchJsonl, entriesJson, entriesJsonl].every(
        ({ exitCode }) => exitCode === 0,
      ),
    ).toBe(true);
  });

  test("requires a machine format and excludes unsafe or truncating manifest options", async () => {
    const manifest = vi.fn<ProgramOptions["manifest"]>(async () => emptyManifest());

    const missingFormat = await invoke(["manifest"], { manifest });
    const human = await invoke(["manifest", "--format", "human"], { manifest });
    const workspace = await invoke(
      ["manifest", "--format", "json", "--workspace", "/private/repo"],
      { manifest },
    );
    const limit = await invoke(["manifest", "--format", "json", "--limit", "1"], {
      manifest,
    });
    const cursor = await invoke(["manifest", "--format", "json", "--cursor", "opaque"], {
      manifest,
    });

    expect(
      [missingFormat, human, workspace, limit, cursor].map(({ exitCode }) => exitCode),
    ).toEqual([2, 2, 2, 2, 2]);
    expect(manifest).not.toHaveBeenCalled();

    const help = await invoke(["manifest", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--format <format>");
    expect(help.stdout).not.toContain("--workspace");
    expect(help.stdout).not.toContain("--limit");
    expect(help.stdout).not.toContain("--cursor");
  });

  test("forwards every safe manifest filter without pagination controls", async () => {
    const manifest = vi.fn<ProgramOptions["manifest"]>(async () => emptyManifest());
    const invocation = await invoke(
      [
        "manifest",
        "--format",
        "json",
        "--source",
        "synthetic",
        "--instance",
        "local",
        "--native-id",
        "provider-thread",
        "--source-state",
        "missing",
        "--activity-after",
        "2026-07-13T23:00:00.000Z",
        "--activity-before",
        "2026-07-15T01:00:00.000Z",
        "--captured-after",
        "2026-07-14T00:00:00.000Z",
        "--captured-before",
        "2026-07-15T00:00:00.000Z",
        "--observed-after",
        "2026-07-14T01:00:00.000Z",
        "--observed-before",
        "2026-07-14T23:00:00.000Z",
        "--session",
        "synthetic@one:session",
      ],
      { manifest },
    );

    expect(invocation.exitCode).toBe(0);
    expect(manifest).toHaveBeenCalledExactlyOnceWith({
      filter: {
        source: "synthetic",
        instance: "local",
        nativeId: "provider-thread",
        sourceState: "missing",
        activityAfter: "2026-07-13T23:00:00.000Z",
        activityBefore: "2026-07-15T01:00:00.000Z",
        capturedAfter: "2026-07-14T00:00:00.000Z",
        capturedBefore: "2026-07-15T00:00:00.000Z",
        observedAfter: "2026-07-14T01:00:00.000Z",
        observedBefore: "2026-07-14T23:00:00.000Z",
        session: {
          source: { kind: "synthetic", instanceId: "one" },
          nativeId: "session",
        },
      },
    });
  });

  test("renders exact empty and equivalent nonempty manifest JSON and JSONL", async () => {
    const emptyJson = await invoke(["manifest", "--format", "json"]);
    const emptyJsonl = await invoke(["manifest", "--format", "jsonl"]);
    const result = attributedManifest();
    const manifest = vi.fn<ProgramOptions["manifest"]>(async () => result);
    const json = await invoke(["manifest", "--format", "json"], { manifest });
    const jsonl = await invoke(["manifest", "--format", "jsonl"], { manifest });

    const emptyBundle = JSON.parse(emptyJson.stdout);
    const emptyRecords = emptyJsonl.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(emptyBundle).toEqual({
      schemaVersion: 1,
      command: "manifest",
      type: "manifest",
      disposition: "untrusted-history",
      revisionCount: 0,
      selection: emptyManifest().selection,
      captureScope: uninitializedCaptureScope,
      revisions: [],
    });
    expect(emptyRecords).toEqual([
      {
        schemaVersion: 1,
        command: "manifest",
        type: "manifest",
        disposition: "untrusted-history",
        revisionCount: 0,
        selection: emptyBundle.selection,
        captureScope: emptyBundle.captureScope,
      },
    ]);

    const bundle = JSON.parse(json.stdout);
    const records = jsonl.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect([json.exitCode, jsonl.exitCode]).toEqual([0, 0]);
    expect(bundle.revisionCount).toBe(1);
    expect(records.map(({ type }) => type)).toEqual(["manifest", "revision"]);
    expect(records[0]).toEqual({
      schemaVersion: 1,
      command: "manifest",
      type: "manifest",
      disposition: "untrusted-history",
      revisionCount: 1,
      selection: bundle.selection,
      captureScope: bundle.captureScope,
    });
    expect(records[1].revision).toEqual(bundle.revisions[0]);
    expect(bundle.revisions[0]).not.toHaveProperty("title");
    expect(bundle.revisions[0]).not.toHaveProperty("workspace");
  });

  test("renders equivalent show JSON and attributable JSONL", async () => {
    const result = selectedSnapshot();
    const show = vi.fn<ProgramOptions["show"]>(async () => result);

    const json = await invoke(["show", "synthetic@one:session", "--format", "json"], {
      show,
    });
    const jsonl = await invoke(["show", "synthetic@one:session", "--format", "jsonl"], {
      show,
    });
    const bundle = JSON.parse(json.stdout);
    const records = jsonl.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(json.exitCode).toBe(0);
    expect(jsonl.exitCode).toBe(0);
    expect(bundle).toMatchObject({ command: "show", type: "snapshot" });
    expect(records.map(({ type }) => type)).toEqual(["session", "relation", "entry"]);
    expect(records[0].snapshot).toEqual(bundle.snapshot);
    expect(records[1]).toMatchObject({
      session: bundle.snapshot.session,
      documentDigest: bundle.snapshot.documentDigest,
      relation: bundle.relations[0],
    });
    expect(records[2]).toMatchObject({
      session: bundle.snapshot.session,
      documentDigest: bundle.snapshot.documentDigest,
      entry: bundle.entries[0],
    });
    expect(show.mock.calls.map(([input]) => input)).toEqual([
      {
        identity: {
          source: { kind: "synthetic", instanceId: "one" },
          nativeId: "session",
        },
      },
      {
        identity: {
          source: { kind: "synthetic", instanceId: "one" },
          nativeId: "session",
        },
      },
    ]);
  });

  test("requires an export format and forwards the explicit full request", async () => {
    const result = selectedSnapshot("full");
    const exportSession = vi.fn<ProgramOptions["export"]>(async () => result);

    const omitted = await invoke(["export", "synthetic@one:session"], {
      export: exportSession,
    });
    const human = await invoke(["export", "synthetic@one:session", "--format", "human"], {
      export: exportSession,
    });
    const markdown = await invoke(["export", "synthetic@one:session", "--format", "md"], {
      export: exportSession,
    });
    const full = await invoke(["export", "synthetic@one:session", "--format", "json", "--full"], {
      export: exportSession,
    });

    expect([omitted.exitCode, human.exitCode, markdown.exitCode]).toEqual([2, 2, 2]);
    expect(JSON.parse(full.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "export",
      type: "snapshot",
      snapshot: { selection: { mode: "full" } },
    });
    expect(exportSession).toHaveBeenCalledExactlyOnceWith({
      identity: {
        source: { kind: "synthetic", instanceId: "one" },
        nativeId: "session",
      },
      full: true,
    });
  });

  test("forwards exact bounded entry ranges to show and export", async () => {
    const show = vi.fn<ProgramOptions["show"]>(async () => selectedSnapshot());
    const exportSession = vi.fn<ProgramOptions["export"]>(async () => selectedSnapshot());

    const shown = await invoke(
      [
        "show",
        "synthetic@one:session",
        "--from-entry",
        "0",
        "--to-entry",
        "199",
        "--format",
        "json",
      ],
      { show },
    );
    const exported = await invoke(
      [
        "export",
        "synthetic@one:session",
        "--from-entry",
        "7",
        "--to-entry",
        "7",
        "--format",
        "jsonl",
      ],
      { export: exportSession },
    );

    expect([shown.exitCode, exported.exitCode]).toEqual([0, 0]);
    expect(show).toHaveBeenCalledExactlyOnceWith({
      identity: {
        source: { kind: "synthetic", instanceId: "one" },
        nativeId: "session",
      },
      fromEntry: 0,
      toEntry: 199,
    });
    expect(exportSession).toHaveBeenCalledExactlyOnceWith({
      identity: {
        source: { kind: "synthetic", instanceId: "one" },
        nativeId: "session",
      },
      fromEntry: 7,
      toEntry: 7,
    });
  });

  test("keeps query cursors reusable across human, JSON, and JSONL", async () => {
    const list = vi.fn<ProgramOptions["list"]>(async () => ({
      sessions: [],
      captureScope: completeCaptureScope,
    }));

    for (const format of ["human", "json", "jsonl"] as const) {
      const invocation = await invoke(["list", "--cursor", "opaque", "--format", format], {
        list,
      });
      expect(invocation.exitCode).toBe(0);
    }
    expect(list.mock.calls.map(([input]) => input)).toEqual([
      { cursor: "opaque" },
      { cursor: "opaque" },
      { cursor: "opaque" },
    ]);
  });

  test("keeps operational formats narrow and reports structured overflow before stdout", async () => {
    const invalidDoctor = await invoke(["doctor", "--format", "jsonl"]);
    const invalidList = await invoke(["list", "--format", "yaml"]);
    const overflow = await invoke(["list", "--format", "jsonl"], {
      list: async () => {
        throw new StructuredOutputTooLargeError();
      },
    });
    const entriesOverflow = await invoke(["entries", "--format", "json"], {
      entries: async () => {
        throw new StructuredOutputTooLargeError();
      },
    });
    const manifestOverflow = await invoke(["manifest", "--format", "json"], {
      manifest: async () => {
        throw new StructuredOutputTooLargeError();
      },
    });

    expect(invalidDoctor.exitCode).toBe(2);
    expect(invalidList.exitCode).toBe(2);
    expect(overflow).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "sessions: structured-output-too-large: narrow list/search/entries/manifest or use export --full\n",
    });
    expect(entriesOverflow).toEqual(overflow);
    expect(manifestOverflow).toEqual(overflow);
  });

  test("requires the option delimiter for leading-dash search text", async () => {
    const search = vi.fn<ProgramOptions["search"]>(async () => emptySearch());

    const delimited = await invoke(["search", "--", "---"], { search });

    expect(delimited).toEqual({
      exitCode: 0,
      stdout:
        "No matches found.\n\nWarning: retained evidence may be incomplete (capture scope is uninitialized).\n",
      stderr: "",
    });
    expect(search).toHaveBeenCalledExactlyOnceWith({ text: "---", termMode: "all" });

    search.mockClear();
    const unknownOption = await invoke(["search", "---"], { search });

    expect(unknownOption.exitCode).toBe(2);
    expect(unknownOption.stdout).toBe("");
    expect(unknownOption.stderr).toContain("unknown option '---'");
    expect(search).not.toHaveBeenCalled();
  });

  test("maps shared and search-only filters into provider-neutral input", async () => {
    const search = vi.fn<ProgramOptions["search"]>(async () => emptySearch());

    const invocation = await invoke(
      [
        "search",
        "needle",
        "--source",
        "codex",
        "--instance",
        "local",
        "--native-id",
        "provider-thread",
        "--source-state",
        "missing",
        "--workspace",
        "/repo",
        "--activity-after",
        "2026-07-13T23:00:00.000Z",
        "--activity-before",
        "2026-07-15T01:00:00.000Z",
        "--captured-after",
        "2026-07-14T00:00:00.000Z",
        "--captured-before",
        "2026-07-15T00:00:00.000Z",
        "--observed-after",
        "2026-07-14T01:00:00.000Z",
        "--observed-before",
        "2026-07-14T23:00:00.000Z",
        "--session",
        "synthetic@one:session",
        "--entry-after",
        "2026-07-14T02:00:00.000Z",
        "--entry-before",
        "2026-07-14T22:00:00.000Z",
        "--actor",
        "tool",
        "--origin",
        "tool",
        "--kind",
        "tool-call",
        "--tool-name",
        "exec",
        "--tool-namespace",
        "shell",
        "--match",
        "any",
        "--limit",
        "7",
        "--context",
        "2",
        "--cursor",
        "opaque",
      ],
      { search },
    );

    expect(invocation.exitCode).toBe(0);
    expect(search).toHaveBeenCalledWith({
      text: "needle",
      termMode: "any",
      filter: {
        source: "codex",
        instance: "local",
        nativeId: "provider-thread",
        sourceState: "missing",
        workspace: "/repo",
        activityAfter: "2026-07-13T23:00:00.000Z",
        activityBefore: "2026-07-15T01:00:00.000Z",
        capturedAfter: "2026-07-14T00:00:00.000Z",
        capturedBefore: "2026-07-15T00:00:00.000Z",
        observedAfter: "2026-07-14T01:00:00.000Z",
        observedBefore: "2026-07-14T23:00:00.000Z",
        session: {
          source: { kind: "synthetic", instanceId: "one" },
          nativeId: "session",
        },
        entryAfter: "2026-07-14T02:00:00.000Z",
        entryBefore: "2026-07-14T22:00:00.000Z",
        actor: "tool",
        origin: "tool",
        entryKind: "tool-call",
        toolName: "exec",
        toolNamespace: "shell",
      },
      limit: 7,
      context: 2,
      cursor: "opaque",
    });
  });

  test("maps shared and entry filters with selection into provider-neutral input", async () => {
    const entries = vi.fn<ProgramOptions["entries"]>(async () => ({
      entries: [],
      captureScope: completeCaptureScope,
    }));

    const invocation = await invoke(
      [
        "entries",
        "--source",
        "codex",
        "--instance",
        "local",
        "--native-id",
        "provider-thread",
        "--source-state",
        "missing",
        "--workspace",
        "/repo",
        "--activity-after",
        "2026-07-13T23:00:00.000Z",
        "--activity-before",
        "2026-07-15T01:00:00.000Z",
        "--captured-after",
        "2026-07-14T00:00:00.000Z",
        "--captured-before",
        "2026-07-15T00:00:00.000Z",
        "--observed-after",
        "2026-07-14T01:00:00.000Z",
        "--observed-before",
        "2026-07-14T23:00:00.000Z",
        "--session",
        "synthetic@one:session",
        "--entry-after",
        "2026-07-14T02:00:00.000Z",
        "--entry-before",
        "2026-07-14T22:00:00.000Z",
        "--actor",
        "tool",
        "--origin",
        "tool",
        "--kind",
        "tool-call",
        "--tool-name",
        "exec",
        "--tool-namespace",
        "shell",
        "--select",
        "last",
        "--limit",
        "7",
        "--cursor",
        "opaque",
      ],
      { entries },
    );

    expect(invocation.exitCode).toBe(0);
    expect(entries).toHaveBeenCalledExactlyOnceWith({
      filter: {
        source: "codex",
        instance: "local",
        nativeId: "provider-thread",
        sourceState: "missing",
        workspace: "/repo",
        activityAfter: "2026-07-13T23:00:00.000Z",
        activityBefore: "2026-07-15T01:00:00.000Z",
        capturedAfter: "2026-07-14T00:00:00.000Z",
        capturedBefore: "2026-07-15T00:00:00.000Z",
        observedAfter: "2026-07-14T01:00:00.000Z",
        observedBefore: "2026-07-14T23:00:00.000Z",
        session: {
          source: { kind: "synthetic", instanceId: "one" },
          nativeId: "session",
        },
        entryAfter: "2026-07-14T02:00:00.000Z",
        entryBefore: "2026-07-14T22:00:00.000Z",
        actor: "tool",
        origin: "tool",
        entryKind: "tool-call",
        toolName: "exec",
        toolNamespace: "shell",
      },
      selection: "last",
      limit: 7,
      cursor: "opaque",
    });
  });

  test("uses the default all entry selection and rejects invalid entry inventory options", async () => {
    const entries = vi.fn<ProgramOptions["entries"]>(async () => ({
      entries: [],
      captureScope: completeCaptureScope,
    }));

    const success = await invoke(["entries"], { entries });
    const invalidSelection = await invoke(["entries", "--select", "middle"], { entries });
    const invalidLimit = await invoke(["entries", "--limit", "201"], { entries });
    const invalidBounds = await invoke(
      [
        "entries",
        "--entry-after",
        "2026-07-14T00:00:00.000Z",
        "--entry-before",
        "2026-07-14T00:00:00.000Z",
      ],
      { entries },
    );

    expect(success.exitCode).toBe(0);
    expect(entries).toHaveBeenCalledExactlyOnceWith({ selection: "all" });
    expect([invalidSelection, invalidLimit, invalidBounds].map(({ exitCode }) => exitCode)).toEqual(
      [2, 2, 2],
    );
  });

  test("forwards shared activity bounds to list", async () => {
    const list = vi.fn<ProgramOptions["list"]>(async () => ({
      sessions: [],
      captureScope: completeCaptureScope,
    }));

    const invocation = await invoke(
      [
        "list",
        "--activity-after",
        "2026-07-14T00:00:00.000Z",
        "--activity-before",
        "2026-07-15T00:00:00.000Z",
      ],
      { list },
    );

    expect(invocation.exitCode).toBe(0);
    expect(list).toHaveBeenCalledExactlyOnceWith({
      filter: {
        activityAfter: "2026-07-14T00:00:00.000Z",
        activityBefore: "2026-07-15T00:00:00.000Z",
      },
    });
  });

  test("renders equivalent attributable entries JSON and JSONL", async () => {
    const result = entryInventoryResult();
    const entries = vi.fn<ProgramOptions["entries"]>(async () => result);

    const json = await invoke(["entries", "--format", "json"], { entries });
    const jsonl = await invoke(["entries", "--format", "jsonl"], { entries });
    const page = JSON.parse(json.stdout);
    const records = jsonl.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect([json.exitCode, jsonl.exitCode]).toEqual([0, 0]);
    expect(records.map(({ type }) => type)).toEqual(["page", "entry"]);
    expect(records[0]).toMatchObject({
      entryCount: 1,
      nextCursor: "next-entry-page",
      captureScope: completeCaptureScope,
    });
    expect(page.captureScope).toEqual(completeCaptureScope);
    expect(records[1]).not.toHaveProperty("captureScope");
    expect(records[1].entry).toEqual(page.entries[0]);
  });

  test("renders equivalent list/search roots and matched terms in JSON and JSONL", async () => {
    const listResult = attributedListResult();
    const searchResult = attributedSearchResult();
    const list = vi.fn<ProgramOptions["list"]>(async () => listResult);
    const search = vi.fn<ProgramOptions["search"]>(async () => searchResult);

    const listJson = await invoke(["list", "--format", "json"], { list });
    const listJsonl = await invoke(["list", "--format", "jsonl"], { list });
    const searchJson = await invoke(
      ["search", "first second", "--match", "any", "--format", "json"],
      {
        search,
      },
    );
    const searchJsonl = await invoke(
      ["search", "first second", "--match", "any", "--format", "jsonl"],
      { search },
    );

    const listPage = JSON.parse(listJson.stdout);
    const listRecords = listJsonl.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const searchPage = JSON.parse(searchJson.stdout);
    const searchRecords = searchJsonl.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect([listJson, listJsonl, searchJson, searchJsonl].map(({ exitCode }) => exitCode)).toEqual([
      0, 0, 0, 0,
    ]);
    expect(listPage.captureScope).toEqual(completeCaptureScope);
    expect(listRecords[0].captureScope).toEqual(completeCaptureScope);
    expect(listRecords[1]).not.toHaveProperty("captureScope");
    expect(listPage.sessions[0].root).toEqual({ kind: "unknown" });
    expect(listRecords[1].summary).toEqual(listPage.sessions[0]);
    expect(searchPage.hits[0]).toMatchObject({
      root: { kind: "unknown" },
      match: { matchedTerms: ["first", "second"] },
    });
    expect(searchPage.captureScope).toEqual(completeCaptureScope);
    expect(searchRecords[0].captureScope).toEqual(completeCaptureScope);
    expect(searchRecords[1]).not.toHaveProperty("captureScope");
    expect(searchRecords[1].hit).toEqual(searchPage.hits[0]);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.every(([input]) => input.termMode === "any")).toBe(true);
  });

  test("rejects invalid query dependencies and bounds before handlers", async () => {
    const list = vi.fn<ProgramOptions["list"]>();
    const search = vi.fn<ProgramOptions["search"]>();

    const missingSource = await invoke(["list", "--instance", "local"], { list });
    const emptyInstance = await invoke(["list", "--source", "codex", "--instance", ""], {
      list,
    });
    const emptyNativeId = await invoke(["list", "--native-id", ""], { list });
    const equalBounds = await invoke(
      [
        "search",
        "needle",
        "--entry-after",
        "2026-07-14T00:00:00.000Z",
        "--entry-before",
        "2026-07-14T00:00:00.000Z",
      ],
      { search },
    );
    const blank = await invoke(["search", "   "], { search });
    const unicodeBlank = await invoke(["search", "\u0085"], { search });
    const tooManyTerms = await invoke(
      ["search", Array.from({ length: 33 }, (_, index) => `term-${String(index)}`).join(" ")],
      { search },
    );
    const tooManyBytes = await invoke(["search", "é".repeat(2_049)], { search });
    const equalActivityBounds = await invoke(
      [
        "list",
        "--activity-after",
        "2026-07-14T00:00:00.000Z",
        "--activity-before",
        "2026-07-14T00:00:00.000Z",
      ],
      { list },
    );
    const invalidMatch = await invoke(["search", "needle", "--match", "some"], { search });

    expect([
      missingSource.exitCode,
      emptyInstance.exitCode,
      emptyNativeId.exitCode,
      equalBounds.exitCode,
      blank.exitCode,
      unicodeBlank.exitCode,
      tooManyTerms.exitCode,
      tooManyBytes.exitCode,
      equalActivityBounds.exitCode,
      invalidMatch.exitCode,
    ]).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(tooManyTerms.stderr).toContain("at most 32 terms");
    expect(tooManyBytes.stderr).toContain("at most 4096 UTF-8 bytes");
    expect(list).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  test("maps query cursor usage failures to exit 2", async () => {
    const invocation = await invoke(["list", "--cursor", "bad"], {
      list: async () => {
        throw new SessionQueryUsageError("invalid-cursor");
      },
    });

    expect(invocation).toEqual({
      exitCode: 2,
      stdout: "",
      stderr: "sessions: Session query cursor is invalid\n",
    });
  });

  test("maps a stale query cursor to sanitized operational exit 1", async () => {
    const invocation = await invoke(["list", "--cursor", "stale"], {
      list: async () => {
        throw new SessionQueryOperationalError("stale-cursor");
      },
    });

    expect(invocation).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "sessions: Session query cursor is stale\n",
    });
  });

  test("emits no partial manifest when the complete cohort is too large", async () => {
    const invocation = await invoke(["manifest", "--format", "json"], {
      manifest: async () => {
        throw new SessionQueryOperationalError("manifest-too-large");
      },
    });

    expect(invocation).toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "sessions: Session manifest matches more than 10,000 revisions; narrow the selection\n",
    });
  });

  test("validates identity and show context before calling handlers", async () => {
    const show = vi.fn<ProgramOptions["show"]>();
    const invalidIdentity = await invoke(["show", "not-an-id"], { show });
    const invalidContext = await invoke(["show", "synthetic@one:session", "--context", "2"], {
      show,
    });

    expect(invalidIdentity.exitCode).toBe(2);
    expect(invalidContext.exitCode).toBe(2);
    expect(show).not.toHaveBeenCalled();
  });

  test("rejects invalid or conflicting entry ranges before calling handlers", async () => {
    const show = vi.fn<ProgramOptions["show"]>();
    const exportSession = vi.fn<ProgramOptions["export"]>();
    const showCases = [
      ["show", "synthetic@one:session", "--from-entry", "1"],
      ["show", "synthetic@one:session", "--to-entry", "1"],
      ["show", "synthetic@one:session", "--from-entry", "2", "--to-entry", "1"],
      ["show", "synthetic@one:session", "--from-entry", "0", "--to-entry", "200"],
      ["show", "synthetic@one:session", "--from-entry", "0", "--to-entry", "1", "--entry", "0"],
      ["show", "synthetic@one:session", "--from-entry", "0", "--to-entry", "1", "--context", "1"],
      ["show", "synthetic@one:session", "--from-entry", "-1", "--to-entry", "1"],
    ];
    const exportCases = [
      ["export", "synthetic@one:session", "--format", "json", "--from-entry", "1"],
      [
        "export",
        "synthetic@one:session",
        "--format",
        "json",
        "--from-entry",
        "2",
        "--to-entry",
        "1",
      ],
      [
        "export",
        "synthetic@one:session",
        "--format",
        "json",
        "--from-entry",
        "0",
        "--to-entry",
        "200",
      ],
      [
        "export",
        "synthetic@one:session",
        "--format",
        "json",
        "--from-entry",
        "0",
        "--to-entry",
        "1",
        "--full",
      ],
      [
        "export",
        "synthetic@one:session",
        "--format",
        "json",
        "--from-entry",
        "9007199254740992",
        "--to-entry",
        "9007199254740992",
      ],
    ];

    const results = [
      ...(await Promise.all(showCases.map((argv) => invoke(argv, { show })))),
      ...(await Promise.all(exportCases.map((argv) => invoke(argv, { export: exportSession })))),
    ];

    expect(results.every(({ exitCode }) => exitCode === 2)).toBe(true);
    expect(show).not.toHaveBeenCalled();
    expect(exportSession).not.toHaveBeenCalled();
  });

  test("rejects numeric values outside command bounds before calling handlers", async () => {
    const list = vi.fn<ProgramOptions["list"]>();
    const show = vi.fn<ProgramOptions["show"]>();

    const zeroLimit = await invoke(["list", "--limit", "0"], { list });
    const largeLimit = await invoke(["list", "--limit", "201"], { list });
    const negativeEntry = await invoke(["show", "synthetic@one:session", "--entry", "-1"], {
      show,
    });
    const largeContext = await invoke(
      ["show", "synthetic@one:session", "--entry", "0", "--context", "101"],
      { show },
    );

    expect(
      [zeroLimit, largeLimit, negativeEntry, largeContext].map(({ exitCode }) => exitCode),
    ).toEqual([2, 2, 2, 2]);
    expect(list).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  test("forgets by canonical identity and emits JSON", async () => {
    const invocation = await invoke(["forget", "synthetic@one:session", "--format", "json"]);

    expect(invocation.exitCode).toBe(0);
    expect(JSON.parse(invocation.stdout)).toEqual(forgetReport());
  });

  test("requires confirmation before data clear", async () => {
    const clearData = vi.fn<ProgramOptions["clearData"]>(async () => clearReport());
    const denied = await invoke(["data", "clear"], { clearData });
    const confirmed = await invoke(["data", "clear", "--yes", "--format", "json"], {
      clearData,
    });

    expect(denied.exitCode).toBe(2);
    expect(clearData).toHaveBeenCalledOnce();
    expect(JSON.parse(confirmed.stdout)).toEqual(clearReport());
  });

  test("lists orphan repair and compact beside clear in data help", async () => {
    const invocation = await invoke(["data", "--help"]);

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stdout).toContain("repair-orphans");
    expect(invocation.stdout).toContain("compact");
    expect(invocation.stdout).toContain("clear");
    expect(invocation.stderr).toBe("");
  });

  test("compacts without confirmation and emits the exact JSON report", async () => {
    const report: DataCompactReport = {
      schemaVersion: 1,
      command: "data-compact",
      outcome: "compacted",
      databaseBytesBefore: 8192,
      databaseBytesAfter: 4096,
      reclaimedDatabaseBytes: 4096,
    };
    const compactData = vi.fn<ProgramOptions["compactData"]>(async () => report);

    const invocation = await invoke(["data", "compact", "--format", "json"], {
      compactData,
    });

    expect(invocation).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(report, null, 2)}\n`,
      stderr: "",
    });
    expect(compactData).toHaveBeenCalledOnce();
  });

  test("rejects unsupported compact options before calling the handler", async () => {
    const compactData = vi.fn<ProgramOptions["compactData"]>();

    const confirmation = await invoke(["data", "compact", "--yes"], { compactData });
    const invalidFormat = await invoke(["data", "compact", "--format", "yaml"], {
      compactData,
    });

    expect(confirmation.exitCode).toBe(2);
    expect(invalidFormat.exitCode).toBe(2);
    expect(compactData).not.toHaveBeenCalled();
  });

  test.each([
    new SessionLibraryError("library-busy"),
    new Error("Session library maintenance failed: compact-failed"),
  ])("reports compact operational failures on stderr only", async (failure) => {
    const invocation = await invoke(["data", "compact"], {
      compactData: async () => {
        throw failure;
      },
    });

    expect(invocation).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `sessions: ${failure.message}\n`,
    });
  });

  test("repairs orphans without confirmation and emits the exact JSON report", async () => {
    const report: DataRepairOrphansReport = {
      schemaVersion: 1,
      command: "data-repair-orphans",
      outcome: "repaired",
      deletedContentRows: "9007199254740993",
      deletedContentBytes: "9223372036854775807",
    };
    const repairOrphanedData = vi.fn<ProgramOptions["repairOrphanedData"]>(async () => report);

    const invocation = await invoke(["data", "repair-orphans", "--format", "json"], {
      repairOrphanedData,
    });

    expect(invocation).toEqual({
      exitCode: 0,
      stdout: `${JSON.stringify(report, null, 2)}\n`,
      stderr: "",
    });
    expect(repairOrphanedData).toHaveBeenCalledOnce();
  });

  test("rejects every unsupported orphan-repair option before calling the handler", async () => {
    const repairOrphanedData = vi.fn<ProgramOptions["repairOrphanedData"]>();

    const confirmation = await invoke(["data", "repair-orphans", "--yes"], {
      repairOrphanedData,
    });
    const limit = await invoke(["data", "repair-orphans", "--limit", "1"], {
      repairOrphanedData,
    });
    const cursor = await invoke(["data", "repair-orphans", "--cursor", "opaque"], {
      repairOrphanedData,
    });
    const invalidFormat = await invoke(["data", "repair-orphans", "--format", "yaml"], {
      repairOrphanedData,
    });

    expect([confirmation, limit, cursor, invalidFormat].map(({ exitCode }) => exitCode)).toEqual([
      2, 2, 2, 2,
    ]);
    expect(repairOrphanedData).not.toHaveBeenCalled();
  });

  test.each([
    new SessionLibraryError("library-busy"),
    new Error("Session library maintenance failed: repair-failed"),
  ])("reports orphan-repair operational failures on stderr only", async (failure) => {
    const invocation = await invoke(["data", "repair-orphans"], {
      repairOrphanedData: async () => {
        throw failure;
      },
    });

    expect(invocation).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: `sessions: ${failure.message}\n`,
    });
  });

  test("maps unexpected operational failures to stderr", async () => {
    const invocation = await invoke(["doctor"], {
      doctor: async () => {
        throw new Error("composition failed");
      },
    });

    expect(invocation).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "sessions: composition failed\n",
    });
  });
});

async function invoke(
  argv: readonly string[],
  overrides: Partial<Omit<ProgramOptions, "output" | "version">> = {},
  terminal: { readonly interactive?: boolean; readonly events?: string[] } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const defaults: Omit<ProgramOptions, "output" | "version"> = {
    doctor: async () => passingDoctor(),
    paths: async () => pathsReport(),
    indexSources: ["codex"],
    index: async () => indexReport(false),
    list: async () => ({ sessions: [], captureScope: uninitializedCaptureScope }),
    manifest: async () => emptyManifest(),
    entries: async () => ({ entries: [], captureScope: uninitializedCaptureScope }),
    search: async () => emptySearch(),
    show: async () => {
      throw new Error("show fixture was not configured");
    },
    export: async () => {
      throw new Error("export fixture was not configured");
    },
    forget: async () => forgetReport(),
    clearData: async () => clearReport(),
    compactData: async () => compactReport(),
    repairOrphanedData: async () => repairOrphansReport(),
  };
  const exitCode = await runCli(argv, {
    version: "1.2.3",
    ...defaults,
    ...overrides,
    output: {
      ...(terminal.interactive === true
        ? {
            stderrIsInteractive: true,
          }
        : {}),
      writeOut: (text) => {
        stdout += text;
        terminal.events?.push(`stdout:${text}`);
      },
      writeErr: (text) => {
        stderr += text;
        terminal.events?.push(`stderr:${text}`);
      },
    },
  });
  return { exitCode, stdout, stderr };
}

function entryInventoryResult(): ListSessionEntriesResult {
  return {
    captureScope: completeCaptureScope,
    entries: [
      {
        session: selectedSnapshot().snapshot,
        entry: {
          ordinal: 4,
          kind: "tool-call",
          actor: "tool",
          toolName: "exec",
          toolNamespace: "shell",
          toolCallId: "call-1",
          relatedEntryOrdinal: 5,
        },
        root: {
          kind: "known",
          root: {
            source: { kind: "synthetic", instanceId: "root" },
            nativeId: "root-session",
          },
        },
        content: {
          textSegmentCount: 2,
          omittedSegmentCount: 1,
          unpreviewedTextSegmentCount: 1,
          preview: {
            segmentOrdinal: 0,
            origin: "tool",
            originConfidence: "high",
            text: "synthetic preview",
            truncated: false,
            contentHash: { scheme: "sha256-utf8-v1", digest: "c".repeat(64) },
          },
        },
      },
    ],
    nextCursor: "next-entry-page" as never,
  };
}

function attributedListResult(): ListSessionsResult {
  const snapshot = selectedSnapshot().snapshot;
  const { title, createdAt, updatedAt } = snapshot;
  if (title === undefined || createdAt === undefined || updatedAt === undefined) {
    throw new TypeError("Attributed list fixture requires title and activity timestamps");
  }
  return {
    captureScope: completeCaptureScope,
    sessions: [
      {
        identity: snapshot.identity,
        documentDigest: snapshot.documentDigest,
        title,
        createdAt,
        updatedAt,
        capturedAt: snapshot.capturedAt,
        sourceState: snapshot.sourceState,
        sourceObservedAt: snapshot.sourceObservedAt,
        adapterVersion: snapshot.adapterVersion,
        freshness: snapshot.freshness,
        root: { kind: "unknown" },
      },
    ],
  };
}

function emptyManifest(): Awaited<ReturnType<ProgramOptions["manifest"]>> {
  return {
    selection: {
      order: "canonical-identity-v1",
      maximumRevisions: 10_000,
      filters: {},
    },
    captureScope: uninitializedCaptureScope,
    revisions: [],
  };
}

function attributedManifest(): Awaited<ReturnType<ProgramOptions["manifest"]>> {
  const snapshot = selectedSnapshot().snapshot;
  return {
    selection: {
      order: "canonical-identity-v1",
      maximumRevisions: 10_000,
      filters: { source: "synthetic" },
    },
    captureScope: completeCaptureScope,
    revisions: [
      {
        session: snapshot.identity,
        documentDigest: snapshot.documentDigest,
        ...(snapshot.createdAt === undefined ? {} : { createdAt: snapshot.createdAt }),
        ...(snapshot.updatedAt === undefined ? {} : { updatedAt: snapshot.updatedAt }),
        capturedAt: snapshot.capturedAt,
        sourceObservedAt: snapshot.sourceObservedAt,
        sourceState: snapshot.sourceState,
        freshness: snapshot.freshness,
        adapterVersion: snapshot.adapterVersion,
        lineageCoverage: snapshot.lineageCoverage,
        root: { kind: "unknown" },
        counts: {
          relations: 1,
          entries: 1,
          segments: 1,
          omittedSegments: 0,
          textUtf8Bytes: Buffer.byteLength("Synthetic body", "utf8"),
        },
      },
    ],
  };
}

function attributedSearchResult(): SearchSessionsResult {
  const listed = attributedListResult().sessions[0]!;
  return {
    captureScope: completeCaptureScope,
    hits: [
      {
        session: listed,
        root: listed.root,
        entry: { ordinal: 0, kind: "message", actor: "human" },
        matchedTerms: ["first", "second"],
        snippet: {
          segmentOrdinal: 0,
          origin: "human",
          originConfidence: "high",
          contentHash: { scheme: "sha256-utf8-v1", digest: "d".repeat(64) },
          text: "first second",
          truncated: false,
          additionalMatchingSegments: 0,
        },
        context: [],
        linkedContextTruncated: false,
      },
    ],
    support: {
      occurrences: 1,
      uniqueContent: 1,
      uniqueKnownRoots: 0,
      unknownLineageSessions: 1,
    },
  };
}

function emptySearch() {
  return {
    captureScope: uninitializedCaptureScope,
    hits: [],
    support: {
      occurrences: 0,
      uniqueContent: 0,
      uniqueKnownRoots: 0,
      unknownLineageSessions: 0,
    },
  } as const;
}

function selectedSnapshot(mode: "bounded" | "full" = "bounded"): ShowSessionResult {
  const title = "Synthetic title";
  const body = "Synthetic body";
  const titleBytes = Buffer.byteLength(title, "utf8");
  const bodyBytes = Buffer.byteLength(body, "utf8");

  return {
    snapshot: {
      identity: {
        source: { kind: "synthetic", instanceId: "one" },
        nativeId: "session",
      },
      documentDigest: {
        scheme: "sha256-sessions-document-jcs-v1",
        digest: "a".repeat(64),
      },
      title: {
        text: title,
        truncated: false,
        originalUtf8Bytes: titleBytes,
        emittedUtf8Bytes: titleBytes,
      },
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:01:00.000Z",
      capturedAt: "2026-07-14T00:02:00.000Z",
      sourceState: "present",
      sourceObservedAt: "2026-07-14T00:02:00.000Z",
      adapterVersion: "synthetic-v1",
      freshness: "current",
      lineageCoverage: "complete",
      selection: {
        mode,
        relations: { selected: 1, total: 1, truncated: false },
        entries: {
          selected: 1,
          total: 1,
          truncated: false,
          firstOrdinal: 0,
          lastOrdinal: 0,
        },
        segments: { selected: 1, total: 1, truncated: false },
        segmentText: {
          emittedUtf8Bytes: bodyBytes,
          originalUtf8Bytes: bodyBytes,
          truncated: false,
        },
        canonicalOmittedSegments: 0,
        truncatedTextSegments: 0,
      },
    },
    relations: [
      {
        ordinal: 0,
        kind: "parent",
        target: {
          source: { kind: "synthetic", instanceId: "parent" },
          nativeId: "parent",
        },
        confidence: "high",
      },
    ],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        content: [
          {
            ordinal: 0,
            kind: "text",
            origin: "human",
            originConfidence: "high",
            text: {
              text: body,
              truncated: false,
              originalUtf8Bytes: bodyBytes,
              emittedUtf8Bytes: bodyBytes,
            },
            contentHash: { scheme: "sha256-utf8-v1", digest: "b".repeat(64) },
          },
        ],
        omittedSegmentCount: 0,
      },
    ],
  };
}

function passingDoctor(): DoctorReport {
  return {
    schemaVersion: 1,
    command: "doctor",
    ok: true,
    checks: [{ id: "pass", label: "Passing check", ok: true, summary: "available", details: {} }],
  };
}

function pathsReport(): PathsReport {
  return {
    schemaVersion: 1,
    command: "paths",
    library: {
      directory: "/data/sessions",
      scratch: "/data/sessions/.scratch",
      database: "/data/sessions/sessions.sqlite3",
      wal: "/data/sessions/sessions.sqlite3-wal",
      shm: "/data/sessions/sessions.sqlite3-shm",
      initialized: false,
      state: "uninitialized",
      schemaVersion: null,
      supportedSchemaVersion: 1,
    },
    sources: [],
  };
}

function indexReport(incomplete: boolean): IndexReport {
  return {
    schemaVersion: 1,
    command: "index",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:01.000Z",
    counts: { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0 },
    sources: [],
    incompleteSources: incomplete ? 1 : 0,
    skippedSources: 0,
    omittedItemCount: 0,
  };
}

function skippedIndexReport(): IndexReport {
  return {
    schemaVersion: 1,
    command: "index",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:01.000Z",
    counts: { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0 },
    sources: [
      {
        schemaVersion: 1,
        source: { kind: "codex", instanceId: "local" },
        status: "skipped",
        reason: "source-unavailable",
        startedAt: "2026-07-14T00:00:00.000Z",
        finishedAt: "2026-07-14T00:00:01.000Z",
        counts: { discovered: 0, unchanged: 0, updated: 0, failed: 0, missing: 0, stale: 0 },
        coverage: { status: "not-attempted" },
        items: [],
        omittedItemCount: 0,
      },
    ],
    incompleteSources: 0,
    skippedSources: 1,
    omittedItemCount: 0,
  };
}

function forgetReport(): ForgetSessionReport {
  return {
    schemaVersion: 1,
    command: "forget",
    identity: {
      canonicalId: "synthetic@one:session",
      source: { kind: "synthetic", instanceId: "one" },
      nativeId: "session",
    },
    outcome: "forgotten",
  };
}

function clearReport(): DataClearReport {
  return {
    schemaVersion: 1,
    command: "data-clear",
    outcome: "absent",
    scratchRemoved: false,
    databaseRemoved: false,
    walRemoved: false,
    shmRemoved: false,
  };
}

function compactReport(): DataCompactReport {
  return {
    schemaVersion: 1,
    command: "data-compact",
    outcome: "absent",
    databaseBytesBefore: 0,
    databaseBytesAfter: 0,
    reclaimedDatabaseBytes: 0,
  };
}

function repairOrphansReport(): DataRepairOrphansReport {
  return {
    schemaVersion: 1,
    command: "data-repair-orphans",
    outcome: "unchanged",
    deletedContentRows: "0",
    deletedContentBytes: "0",
  };
}
