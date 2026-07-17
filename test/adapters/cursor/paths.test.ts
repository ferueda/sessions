import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { resolveCursorPaths } from "../../../src/adapters/cursor/paths.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Cursor path resolution", () => {
  test("resolves the default root without requiring it to exist", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");

    await expect(resolveCursorPaths({ home })).resolves.toEqual({
      cursorHome: join(resolve(home), ".cursor"),
    });
  });

  test("accepts an injected root and canonicalizes an existing alias", async () => {
    const root = await temporaryRoot();
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual);
    await symlink(actual, alias, "dir");

    const paths = await resolveCursorPaths({ home: join(root, "home"), cursorHome: alias });

    expect(paths.cursorHome).toBe(await realpath(actual));
  });

  test.each(["", "\ud800"])("rejects an invalid injected root %j", async (cursorHome) => {
    await expect(resolveCursorPaths({ home: "/home/alice", cursorHome })).rejects.toThrow(
      TypeError,
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sessions-cursor-paths-"));
  roots.push(root);
  return root;
}
