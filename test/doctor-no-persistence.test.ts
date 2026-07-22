import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("doctor persistence boundary", () => {
  test.each([undefined, "1"])(
    "creates no state beneath isolated paths with timing=%s",
    async (timing) => {
      const sandbox = await mkdtemp(path.join(tmpdir(), "sessions-doctor-sandbox-"));
      temporaryDirectories.push(sandbox);
      const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));
      const result = spawnSync(process.execPath, [binary, "doctor", "--format", "json"], {
        cwd: sandbox,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_HOME: path.join(sandbox, "codex"),
          CODEX_SQLITE_HOME: undefined,
          SESSIONS_DATA_DIR: path.join(sandbox, "sessions-data"),
          HOME: path.join(sandbox, "home"),
          USERPROFILE: path.join(sandbox, "home"),
          XDG_CACHE_HOME: path.join(sandbox, "cache"),
          XDG_DATA_HOME: path.join(sandbox, "data"),
          LOCALAPPDATA: path.join(sandbox, "local-app-data"),
          APPDATA: path.join(sandbox, "app-data"),
          TMPDIR: path.join(sandbox, "temp"),
          TEMP: path.join(sandbox, "temp"),
          TMP: path.join(sandbox, "temp"),
          SESSIONS_DOCTOR_TIMINGS: timing,
        },
      });

      expect(result.status).toBe(0);
      expect(summarizeDoctorTimingDiagnostic(result.stderr)).toEqual({
        present: timing !== undefined,
        diagnostic: timing === undefined ? undefined : "doctor-timings",
        hasSourceResolution: timing !== undefined,
        hasLibraryState: timing !== undefined,
        hasTotal: timing !== undefined,
      });
      expect(result.stderr).not.toContain("sessions-doctor-sandbox-");
      const report = JSON.parse(result.stdout) as {
        readonly checks?: readonly {
          readonly id?: unknown;
          readonly ok?: unknown;
          readonly summary?: unknown;
          readonly details?: unknown;
        }[];
      };
      expect(report).toMatchObject({
        schemaVersion: 1,
        command: "doctor",
        ok: true,
      });
      expect(report.checks?.map((check) => check.id)).toEqual([
        "node-runtime",
        "sqlite-fts5",
        "library-state",
        "source-codex",
        "source-cursor",
      ]);
      expect(report.checks?.at(-2)).toEqual({
        id: "source-codex",
        label: "codex source",
        ok: true,
        summary: "Source is unavailable (optional)",
        details: { probeStatus: "unavailable" },
      });
      expect(report.checks?.at(-1)).toEqual({
        id: "source-cursor",
        label: "cursor source",
        ok: true,
        summary: "Source is unavailable (optional)",
        details: { probeStatus: "unavailable" },
      });
      await expect(readdir(sandbox, { recursive: true })).resolves.toEqual([]);
    },
  );

  test("emits aggregate timings without replacing a failed doctor report", async () => {
    const sandbox = await mkdtemp(path.join(tmpdir(), "sessions-doctor-timing-failure-"));
    temporaryDirectories.push(sandbox);
    const binary = fileURLToPath(new URL("../src/bin/sessions.ts", import.meta.url));

    const result = spawnSync(process.execPath, [binary, "doctor", "--format", "json"], {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: path.join(sandbox, "codex"),
        CODEX_SQLITE_HOME: undefined,
        HOME: path.join(sandbox, "home"),
        USERPROFILE: path.join(sandbox, "home"),
        SESSIONS_DATA_DIR: "relative-data-directory",
        SESSIONS_DOCTOR_TIMINGS: "1",
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "doctor",
      ok: false,
    });
    expect(summarizeDoctorTimingDiagnostic(result.stderr)).toEqual({
      present: true,
      diagnostic: "doctor-timings",
      hasSourceResolution: true,
      hasLibraryState: true,
      hasTotal: true,
    });
  });
});

function summarizeDoctorTimingDiagnostic(stderr: string): {
  readonly present: boolean;
  readonly diagnostic: unknown;
  readonly hasSourceResolution: boolean;
  readonly hasLibraryState: boolean;
  readonly hasTotal: boolean;
} {
  if (stderr === "") {
    return {
      present: false,
      diagnostic: undefined,
      hasSourceResolution: false,
      hasLibraryState: false,
      hasTotal: false,
    };
  }
  const prefix = "sessions:doctor-timings ";
  if (!stderr.startsWith(prefix)) throw new Error("Doctor timing prefix is missing");
  const parsed = JSON.parse(stderr.slice(prefix.length)) as {
    readonly diagnostic?: unknown;
    readonly phases?: Readonly<Record<string, unknown>>;
  };
  return {
    present: true,
    diagnostic: parsed.diagnostic,
    hasSourceResolution: parsed.phases?.sourceResolution !== undefined,
    hasLibraryState: parsed.phases?.libraryState !== undefined,
    hasTotal: parsed.phases?.total !== undefined,
  };
}
