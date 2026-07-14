import { describe, expect, test } from "vitest";

import { resolveIndexPaths, StatePathError } from "../../src/infrastructure/state/paths.ts";

describe("resolveIndexPaths", () => {
  test("uses the absolute XDG cache root on Linux", () => {
    expect(
      resolveIndexPaths({
        platform: "linux",
        env: { XDG_CACHE_HOME: "/var/cache/alice" },
        homeDirectory: "/home/alice",
      }),
    ).toEqual({
      directory: "/var/cache/alice/sessions",
      database: "/var/cache/alice/sessions/index.sqlite3",
      wal: "/var/cache/alice/sessions/index.sqlite3-wal",
      shm: "/var/cache/alice/sessions/index.sqlite3-shm",
    });
  });

  test.each([{ XDG_CACHE_HOME: undefined }, { XDG_CACHE_HOME: "relative/cache" }])(
    "falls back to the home cache on Linux for $XDG_CACHE_HOME",
    (env) => {
      expect(
        resolveIndexPaths({
          platform: "linux",
          env,
          homeDirectory: "/home/alice",
        }).directory,
      ).toBe("/home/alice/.cache/sessions");
    },
  );

  test("uses Library/Caches on macOS regardless of XDG configuration", () => {
    expect(
      resolveIndexPaths({
        platform: "darwin",
        env: { XDG_CACHE_HOME: "/ignored" },
        homeDirectory: "/Users/alice",
      }).directory,
    ).toBe("/Users/alice/Library/Caches/sessions");
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
      database: "C:\\Users\\alice\\AppData\\Local\\sessions\\index.sqlite3",
      wal: "C:\\Users\\alice\\AppData\\Local\\sessions\\index.sqlite3-wal",
      shm: "C:\\Users\\alice\\AppData\\Local\\sessions\\index.sqlite3-shm",
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
      database: "/mnt/private/sessions/index.sqlite3",
    },
    {
      platform: "darwin",
      override: "/Volumes/private/sessions",
      database: "/Volumes/private/sessions/index.sqlite3",
    },
    {
      platform: "win32",
      override: "D:\\private\\sessions",
      database: "D:\\private\\sessions\\index.sqlite3",
    },
  ] as const)(
    "uses the override as the exact owned directory on $platform",
    ({ platform, override, database }) => {
      const paths = resolveIndexPaths({
        platform,
        env: { SESSIONS_CACHE_DIR: override },
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
        env: { SESSIONS_CACHE_DIR: override },
        homeDirectory: "/unused",
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "StatePathError",
        code: "invalid-cache-override",
        message: "SESSIONS_CACHE_DIR must be an absolute path",
      }),
    );
  });

  test.each(["\\root-relative", "/root-relative"])(
    "rejects a Windows current-drive-relative override: %s",
    (override) => {
      expect(() =>
        resolveIndexPaths({
          platform: "win32",
          env: { SESSIONS_CACHE_DIR: override },
          homeDirectory: "C:\\Users\\alice",
        }),
      ).toThrowError(
        expect.objectContaining({
          name: "StatePathError",
          code: "invalid-cache-override",
        }),
      );
    },
  );

  test("accepts a fully qualified Windows UNC override", () => {
    expect(
      resolveIndexPaths({
        platform: "win32",
        env: { SESSIONS_CACHE_DIR: "\\\\server\\private\\sessions" },
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
        env: { SESSIONS_CACHE_DIR: "/private/sessions" },
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
});
