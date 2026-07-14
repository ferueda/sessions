import { describe, expect, test } from "vitest";

import { resolveIndexPaths, StatePathError } from "../../src/infrastructure/state/paths.ts";

describe("resolveIndexPaths", () => {
  test("uses the absolute XDG data root on Linux", () => {
    expect(
      resolveIndexPaths({
        platform: "linux",
        env: { XDG_DATA_HOME: "/var/lib/alice" },
        homeDirectory: "/home/alice",
      }),
    ).toEqual({
      directory: "/var/lib/alice/sessions",
      scratch: "/var/lib/alice/sessions/.scratch",
      database: "/var/lib/alice/sessions/sessions.sqlite3",
      wal: "/var/lib/alice/sessions/sessions.sqlite3-wal",
      shm: "/var/lib/alice/sessions/sessions.sqlite3-shm",
    });
  });

  test.each([{ XDG_DATA_HOME: undefined }, { XDG_DATA_HOME: "relative/data" }])(
    "falls back to the home data directory on Linux for $XDG_DATA_HOME",
    (env) => {
      expect(
        resolveIndexPaths({
          platform: "linux",
          env,
          homeDirectory: "/home/alice",
        }).directory,
      ).toBe("/home/alice/.local/share/sessions");
    },
  );

  test("uses Library/Application Support on macOS regardless of XDG configuration", () => {
    expect(
      resolveIndexPaths({
        platform: "darwin",
        env: { XDG_DATA_HOME: "/ignored" },
        homeDirectory: "/Users/alice",
      }).directory,
    ).toBe("/Users/alice/Library/Application Support/sessions");
  });

  test("uses LOCALAPPDATA and Windows separators on Windows", () => {
    expect(
      resolveIndexPaths({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
        homeDirectory: "C:\\Users\\alice",
      }),
    ).toEqual({
      directory: "C:\\Users\\alice\\AppData\\Local\\sessions",
      scratch: "C:\\Users\\alice\\AppData\\Local\\sessions\\.scratch",
      database: "C:\\Users\\alice\\AppData\\Local\\sessions\\sessions.sqlite3",
      wal: "C:\\Users\\alice\\AppData\\Local\\sessions\\sessions.sqlite3-wal",
      shm: "C:\\Users\\alice\\AppData\\Local\\sessions\\sessions.sqlite3-shm",
    });
  });

  test.each([
    {
      env: {},
      code: "missing-local-app-data",
      message: "LOCALAPPDATA is required to resolve Sessions state paths on Windows",
    },
    {
      env: { LOCALAPPDATA: "relative\\local" },
      code: "invalid-local-app-data",
      message: "LOCALAPPDATA must be an absolute path",
    },
    {
      env: { LOCALAPPDATA: "\\root-relative" },
      code: "invalid-local-app-data",
      message: "LOCALAPPDATA must be an absolute path",
    },
    {
      env: { LOCALAPPDATA: "/root-relative" },
      code: "invalid-local-app-data",
      message: "LOCALAPPDATA must be an absolute path",
    },
  ] as const)("rejects unsafe Windows state roots: $code", ({ env, code, message }) => {
    expect(() =>
      resolveIndexPaths({
        platform: "win32",
        env,
        homeDirectory: "C:\\Users\\alice",
      }),
    ).toThrowError(expect.objectContaining({ name: "StatePathError", code, message }));
  });

  test.each([
    {
      platform: "linux",
      override: "/mnt/private/sessions",
      database: "/mnt/private/sessions/sessions.sqlite3",
    },
    {
      platform: "darwin",
      override: "/Volumes/private/sessions",
      database: "/Volumes/private/sessions/sessions.sqlite3",
    },
    {
      platform: "win32",
      override: "D:\\private\\sessions",
      database: "D:\\private\\sessions\\sessions.sqlite3",
    },
  ] as const)(
    "uses the override as the exact owned directory on $platform",
    ({ platform, override, database }) => {
      const paths = resolveIndexPaths({
        platform,
        env: { SESSIONS_DATA_DIR: override },
        homeDirectory: "ignored",
      });

      expect(paths.directory).toBe(override);
      expect(paths.database).toBe(database);
    },
  );

  test.each([
    { platform: "linux", override: "relative/cache" },
    { platform: "darwin", override: "relative/cache" },
    { platform: "win32", override: "relative\\cache" },
  ] as const)("rejects a relative override on $platform", ({ platform, override }) => {
    expect(() =>
      resolveIndexPaths({
        platform,
        env: { SESSIONS_DATA_DIR: override },
        homeDirectory: "/unused",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "StatePathError",
        code: "invalid-data-override",
        message: "SESSIONS_DATA_DIR must be an absolute path",
      }),
    );
  });

  test.each(["\\root-relative", "/root-relative"])(
    "rejects a Windows current-drive-relative override: %s",
    (override) => {
      expect(() =>
        resolveIndexPaths({
          platform: "win32",
          env: { SESSIONS_DATA_DIR: override },
          homeDirectory: "C:\\Users\\alice",
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "StatePathError",
          code: "invalid-data-override",
        }),
      );
    },
  );

  test("accepts a fully qualified Windows UNC override", () => {
    expect(
      resolveIndexPaths({
        platform: "win32",
        env: { SESSIONS_DATA_DIR: "\\\\server\\private\\sessions" },
        homeDirectory: "C:\\Users\\alice",
      }).directory,
    ).toBe("\\\\server\\private\\sessions");
  });

  test.each(["linux", "darwin"] as const)(
    "rejects a non-absolute home directory on $platform",
    (platform) => {
      expect(() =>
        resolveIndexPaths({ platform, env: {}, homeDirectory: "relative-home" }),
      ).toThrowError(
        expect.objectContaining({
          name: "StatePathError",
          code: "invalid-home-directory",
        }),
      );
    },
  );

  test("rejects an unsupported platform before interpreting an override", () => {
    expect(() =>
      resolveIndexPaths({
        platform: "freebsd",
        env: { SESSIONS_DATA_DIR: "/private/sessions" },
        homeDirectory: "/home/alice",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "StatePathError",
        code: "unsupported-platform",
        message: "Sessions does not support state paths on platform freebsd",
      }),
    );
  });

  test("exposes operational failures as StatePathError instances", () => {
    expect(() =>
      resolveIndexPaths({
        platform: "win32",
        env: {},
        homeDirectory: "C:\\Users\\alice",
      }),
    ).toThrow(StatePathError);
  });

  test("does not reuse the pre-M5 cache override", () => {
    expect(
      resolveIndexPaths({
        platform: "linux",
        env: { SESSIONS_CACHE_DIR: "/legacy/cache" },
        homeDirectory: "/home/alice",
      }).directory,
    ).toBe("/home/alice/.local/share/sessions");
  });
});
