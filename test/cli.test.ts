import { Buffer } from "node:buffer";

import { describe, expect, test, vi } from "vitest";

import type { DataClearReport } from "../src/application/clear-index.ts";
import type { DataCompactReport } from "../src/application/compact-index.ts";
import type { DataRepairOrphansReport } from "../src/application/repair-orphaned-content.ts";
import type { ForgetSessionReport } from "../src/application/forget-session.ts";
import type { PathsReport } from "../src/application/get-paths.ts";
import type { IndexReport } from "../src/application/index-report.ts";
import type { ShowSessionResult } from "../src/application/show-session.ts";
import type { DoctorReport } from "../src/application/run-doctor.ts";
import { SessionLibraryError } from "../src/application/library-error.ts";
import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../src/application/session-query-error.ts";
import type { ProgramOptions } from "../src/cli/program.ts";
import { runCli } from "../src/cli/run.ts";
import { StructuredOutputTooLargeError } from "../src/cli/structured-output-encoding.ts";

describe("sessions CLI", () => {
  test("shows the current command surface", async () => {
    const invocation = await invoke([]);

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stdout).toContain("Usage: sessions");
    for (const command of [
      "index",
      "list",
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

  test("rejects an unregistered source before calling the index handler", async () => {
    const index = vi.fn<ProgramOptions["index"]>();

    const invocation = await invoke(["index", "--source", "cursor"], { index });

    expect(invocation.exitCode).toBe(2);
    expect(index).not.toHaveBeenCalled();
  });

  test("renders the exact empty-list result", async () => {
    const invocation = await invoke(["list"]);

    expect(invocation).toEqual({ exitCode: 0, stdout: "No sessions found.\n", stderr: "" });
  });

  test("renders the exact empty-search result", async () => {
    const invocation = await invoke(["search", "missing"]);

    expect(invocation).toEqual({ exitCode: 0, stdout: "No matches found.\n", stderr: "" });
  });

  test("renders explicit empty JSON and JSONL query pages", async () => {
    const listJson = await invoke(["list", "--format", "json"]);
    const listJsonl = await invoke(["list", "--format", "jsonl"]);
    const searchJson = await invoke(["search", "missing", "--format", "json"]);
    const searchJsonl = await invoke(["search", "missing", "--format", "jsonl"]);

    expect(JSON.parse(listJson.stdout)).toEqual({
      schemaVersion: 1,
      command: "list",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: null,
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
      },
    ]);
    expect(JSON.parse(searchJson.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "search",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: null,
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
        support: emptySearch().support,
      },
    ]);
    expect(
      [listJson, listJsonl, searchJson, searchJsonl].every(({ exitCode }) => exitCode === 0),
    ).toBe(true);
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
    expect(show).toHaveBeenCalledTimes(2);
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

  test("keeps query cursors reusable across human, JSON, and JSONL", async () => {
    const list = vi.fn<ProgramOptions["list"]>(async () => ({ sessions: [] }));

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

    expect(invalidDoctor.exitCode).toBe(2);
    expect(invalidList.exitCode).toBe(2);
    expect(overflow).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "sessions: structured-output-too-large: narrow list/search or use export --full\n",
    });
  });

  test("requires the option delimiter for leading-dash search text", async () => {
    const search = vi.fn<ProgramOptions["search"]>(async () => emptySearch());

    const delimited = await invoke(["search", "--", "---"], { search });

    expect(delimited).toEqual({ exitCode: 0, stdout: "No matches found.\n", stderr: "" });
    expect(search).toHaveBeenCalledExactlyOnceWith({ text: "---" });

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
        "--source-state",
        "missing",
        "--workspace",
        "/repo",
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
      filter: {
        source: "codex",
        instance: "local",
        sourceState: "missing",
        workspace: "/repo",
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

  test("rejects invalid query dependencies and bounds before handlers", async () => {
    const list = vi.fn<ProgramOptions["list"]>();
    const search = vi.fn<ProgramOptions["search"]>();

    const missingSource = await invoke(["list", "--instance", "local"], { list });
    const emptyInstance = await invoke(["list", "--source", "codex", "--instance", ""], {
      list,
    });
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

    expect([
      missingSource.exitCode,
      emptyInstance.exitCode,
      equalBounds.exitCode,
      blank.exitCode,
      unicodeBlank.exitCode,
    ]).toEqual([2, 2, 2, 2, 2]);
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const defaults: Omit<ProgramOptions, "output" | "version"> = {
    doctor: async () => passingDoctor(),
    paths: async () => pathsReport(),
    indexSources: ["codex"],
    index: async () => indexReport(false),
    list: async () => ({ sessions: [] }),
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
      writeOut: (text) => {
        stdout += text;
      },
      writeErr: (text) => {
        stderr += text;
      },
    },
  });
  return { exitCode, stdout, stderr };
}

function emptySearch() {
  return {
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
