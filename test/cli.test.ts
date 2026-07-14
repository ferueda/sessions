import { describe, expect, test, vi } from "vitest";

import type { DataClearReport } from "../src/application/clear-index.ts";
import type { ForgetSessionReport } from "../src/application/forget-session.ts";
import type { PathsReport } from "../src/application/get-paths.ts";
import type { IndexReport } from "../src/application/index-report.ts";
import type { DoctorReport } from "../src/application/run-doctor.ts";
import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../src/application/session-query-error.ts";
import type { ProgramOptions } from "../src/cli/program.ts";
import { runCli } from "../src/cli/run.ts";

describe("sessions CLI", () => {
  test("shows the M6 command surface", async () => {
    const invocation = await invoke([]);

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stdout).toContain("Usage: sessions");
    for (const command of [
      "index",
      "list",
      "search",
      "show",
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
    forget: async () => forgetReport(),
    clearData: async () => clearReport(),
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
