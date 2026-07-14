import { describe, expect, test } from "vitest";

import type { PathsReport } from "../src/application/get-paths.ts";
import type { DoctorReport } from "../src/application/run-doctor.ts";
import { runCli } from "../src/cli/run.ts";

describe("sessions CLI", () => {
  test("shows help for the bare command", async () => {
    const invocation = await invoke([]);

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stdout).toContain("Usage: sessions");
    expect(invocation.stdout).toContain("paths");
    expect(invocation.stdout).not.toContain("index [");
    expect(invocation.stderr).toBe("");
  });

  test("prints the package version", async () => {
    const invocation = await invoke(["--version"]);

    expect(invocation).toEqual({ exitCode: 0, stdout: "1.2.3\n", stderr: "" });
  });

  test("maps invalid usage to exit 2 and stderr", async () => {
    const invocation = await invoke(["--unknown"]);

    expect(invocation.exitCode).toBe(2);
    expect(invocation.stdout).toBe("");
    expect(invocation.stderr).toContain("unknown option '--unknown'");
  });

  test("writes a versioned JSON doctor report on success", async () => {
    const invocation = await invoke(["doctor", "--format", "json"]);

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stderr).toBe("");
    expect(JSON.parse(invocation.stdout)).toEqual(passingReport());
  });

  test("writes the complete failed report to stdout and exits 1", async () => {
    const report: DoctorReport = {
      ...passingReport(),
      ok: false,
      checks: [
        {
          id: "failed",
          label: "Failed check",
          ok: false,
          summary: "not available",
          details: {},
        },
      ],
    };
    const invocation = await invoke(["doctor", "--format", "json"], async () => report);

    expect(invocation.exitCode).toBe(1);
    expect(invocation.stderr).toBe("");
    expect(JSON.parse(invocation.stdout)).toEqual(report);
  });

  test("maps an unexpected outer failure to stderr and exit 1", async () => {
    const invocation = await invoke(["doctor"], async () => {
      throw new Error("composition failed");
    });

    expect(invocation).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "sessions: composition failed\n",
    });
  });

  test("rejects unsupported output formats as usage errors", async () => {
    const invocation = await invoke(["doctor", "--format", "yaml"]);

    expect(invocation.exitCode).toBe(2);
    expect(invocation.stdout).toBe("");
    expect(invocation.stderr).toContain("Allowed choices are human, json");
  });

  test("writes a versioned JSON paths report", async () => {
    const invocation = await invoke(["paths", "--format", "json"]);

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stderr).toBe("");
    expect(JSON.parse(invocation.stdout)).toEqual(pathsReport());
  });

  test("renders all owned state paths for humans", async () => {
    const invocation = await invoke(["paths"]);

    expect(invocation.exitCode).toBe(0);
    expect(invocation.stderr).toBe("");
    expect(invocation.stdout).toBe(
      [
        "Index directory: /cache/sessions",
        "Index database: /cache/sessions/index.sqlite3",
        "Index WAL: /cache/sessions/index.sqlite3-wal",
        "Index shared memory: /cache/sessions/index.sqlite3-shm",
        "Initialized: no",
        "State: uninitialized",
        "Schema: not available (supported: 1)",
        "",
      ].join("\n"),
    );
  });

  test("reports incompatible paths state without treating it as command failure", async () => {
    const report: PathsReport = {
      ...pathsReport(),
      index: {
        ...pathsReport().index,
        initialized: true,
        state: "newer-schema",
        schemaVersion: 2,
      },
    };
    const invocation = await invoke(
      ["paths", "--format", "json"],
      async () => passingReport(),
      async () => report,
    );

    expect(invocation.exitCode).toBe(0);
    expect(JSON.parse(invocation.stdout)).toEqual(report);
  });

  test("maps paths inspection failures to stderr and exit 1", async () => {
    const invocation = await invoke(
      ["paths"],
      async () => passingReport(),
      async () => {
        throw new Error("state path is unavailable");
      },
    );

    expect(invocation).toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "sessions: state path is unavailable\n",
    });
  });

  test("rejects unsupported paths output formats as usage errors", async () => {
    const invocation = await invoke(["paths", "--format", "yaml"]);

    expect(invocation.exitCode).toBe(2);
    expect(invocation.stdout).toBe("");
    expect(invocation.stderr).toContain("Allowed choices are human, json");
  });
});

async function invoke(
  argv: readonly string[],
  doctor: () => Promise<DoctorReport> = async () => passingReport(),
  paths: () => Promise<PathsReport> = async () => pathsReport(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(argv, {
    version: "1.2.3",
    doctor,
    paths,
    output: {
      writeOut(text) {
        stdout += text;
      },
      writeErr(text) {
        stderr += text;
      },
    },
  });
  return { exitCode, stdout, stderr };
}

function pathsReport(): PathsReport {
  return {
    schemaVersion: 1,
    command: "paths",
    index: {
      directory: "/cache/sessions",
      database: "/cache/sessions/index.sqlite3",
      wal: "/cache/sessions/index.sqlite3-wal",
      shm: "/cache/sessions/index.sqlite3-shm",
      initialized: false,
      state: "uninitialized",
      schemaVersion: null,
      supportedSchemaVersion: 1,
    },
  };
}

function passingReport(): DoctorReport {
  return {
    schemaVersion: 1,
    command: "doctor",
    ok: true,
    checks: [
      {
        id: "pass",
        label: "Passing check",
        ok: true,
        summary: "available",
        details: { version: "1" },
      },
    ],
  };
}
