import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { SourceCaptureWorkspaceError } from "../../src/application/ports/session-source.ts";
import {
  assertCanonicalScratchPath,
  openSourceCaptureWorkspace,
} from "../../src/infrastructure/state/source-capture-workspace.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("source capture workspace", () => {
  test("sweeps stale state, creates private attempts, and removes all scratch on close", async () => {
    const paths = await fixturePaths();
    await mkdir(paths.scratch, { mode: 0o700 });
    await writeFile(path.join(paths.scratch, "stale"), "private");
    let leaseAssertions = 0;
    const lifecycle = await openSourceCaptureWorkspace(paths, {
      assertLease() {
        leaseAssertions += 1;
      },
    });

    expect(await readdir(paths.scratch)).toEqual([]);
    const returned = await lifecycle.workspace.withPrivateDirectory(async (directory) => {
      expect(path.dirname(directory)).toBe(paths.scratch);
      const stats = await lstat(directory);
      expect(stats.isDirectory()).toBe(true);
      await writeFile(path.join(directory, "snapshot.sqlite"), "private");
      return "captured";
    });

    expect(returned).toBe("captured");
    expect(await readdir(paths.scratch)).toEqual([]);
    await lifecycle.close();
    await expect(lstat(paths.scratch)).rejects.toMatchObject({ code: "ENOENT" });
    expect(leaseAssertions).toBeGreaterThanOrEqual(7);
  });

  test.skipIf(process.platform === "win32")(
    "creates private attempts with private POSIX permissions",
    async () => {
      const paths = await fixturePaths();
      const lifecycle = await openSourceCaptureWorkspace(paths, { assertLease() {} });
      try {
        await lifecycle.workspace.withPrivateDirectory(async (directory) => {
          expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        });
      } finally {
        await lifecycle.close();
      }
    },
  );

  test("removes symlink children without touching their targets", async () => {
    const paths = await fixturePaths();
    const target = path.join(path.dirname(paths.directory), "outside.txt");
    await writeFile(target, "keep");
    const lifecycle = await openSourceCaptureWorkspace(paths, { assertLease() {} });

    await lifecycle.workspace.withPrivateDirectory(async (directory) => {
      await symlink(target, path.join(directory, "link"));
    });
    await lifecycle.close();

    await expect(readFile(target, "utf8")).resolves.toBe("keep");
  });

  test("refuses an unsafe scratch root without traversing it", async () => {
    const paths = await fixturePaths();
    const target = path.join(path.dirname(paths.directory), "outside");
    await mkdir(target);
    await writeFile(path.join(target, "keep"), "private");
    await symlink(target, paths.scratch, "dir");

    await expect(openSourceCaptureWorkspace(paths, { assertLease() {} })).rejects.toMatchObject({
      code: "unsafe-scratch-root",
    });
    await expect(readFile(path.join(target, "keep"), "utf8")).resolves.toBe("private");
  });

  test("aggregates operation, cleanup, and final lease failures", async () => {
    const paths = await fixturePaths();
    let leaseValid = true;
    const lifecycle = await openSourceCaptureWorkspace(paths, {
      assertLease() {
        if (!leaseValid) throw new Error("lease lost");
      },
    });
    const operationError = new Error("operation failed");

    const error = await lifecycle.workspace
      .withPrivateDirectory(async (directory) => {
        await rm(path.dirname(directory), { recursive: true });
        await writeFile(path.dirname(directory), "replacement");
        leaseValid = false;
        throw operationError;
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(error).toBeInstanceOf(SourceCaptureWorkspaceError);
    const aggregate = (error as SourceCaptureWorkspaceError).cause;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect((aggregate as AggregateError).errors).toHaveLength(3);
    expect((aggregate as AggregateError).errors[0]).toBe(operationError);
    expect((aggregate as AggregateError).errors[1]).toMatchObject({
      code: "unsafe-scratch-root",
    });
    expect((aggregate as AggregateError).errors[2]).toBeInstanceOf(SourceCaptureWorkspaceError);
    expect(((aggregate as AggregateError).errors[2] as SourceCaptureWorkspaceError).cause).toEqual(
      new Error("lease lost"),
    );
  });

  test("returns callback-only failures unchanged", async () => {
    const paths = await fixturePaths();
    const lifecycle = await openSourceCaptureWorkspace(paths, { assertLease() {} });
    const operationError = new Error("source callback failed");

    await expect(
      lifecycle.workspace.withPrivateDirectory(async () => {
        throw operationError;
      }),
    ).rejects.toBe(operationError);
    await lifecycle.close();
  });

  test("marks lease failures and retains their cause", async () => {
    const paths = await fixturePaths();
    const leaseError = new Error("lease lost");
    let leaseValid = true;
    const lifecycle = await openSourceCaptureWorkspace(paths, {
      assertLease() {
        if (!leaseValid) throw leaseError;
      },
    });
    let called = false;
    leaseValid = false;

    const error = await lifecycle.workspace
      .withPrivateDirectory(async () => {
        called = true;
      })
      .then(
        () => undefined,
        (failure: unknown) => failure,
      );

    expect(called).toBe(false);
    expect(error).toBeInstanceOf(SourceCaptureWorkspaceError);
    expect((error as SourceCaptureWorkspaceError).cause).toBe(leaseError);
    leaseValid = true;
    await lifecycle.close();
  });

  test("refuses close while an operation is awaiting setup", async () => {
    const paths = await fixturePaths();
    let setupStarted!: () => void;
    let releaseSetup!: () => void;
    const started = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let blockSetup = false;
    const lifecycle = await openSourceCaptureWorkspace(paths, {
      async assertLease() {
        if (!blockSetup) return;
        setupStarted();
        await release;
      },
    });
    blockSetup = true;

    const operation = lifecycle.workspace.withPrivateDirectory(async () => "complete");
    await started;
    await expect(lifecycle.close()).rejects.toMatchObject({ code: "workspace-busy" });
    releaseSetup();
    await expect(operation).resolves.toBe("complete");
    await expect(lifecycle.close()).resolves.toBeUndefined();
  });

  test("rejects non-canonical roots and closes idempotently", async () => {
    const paths = await fixturePaths();
    expect(() =>
      assertCanonicalScratchPath({ ...paths, scratch: path.join(paths.directory, "other") }),
    ).toThrow(expect.objectContaining({ code: "invalid-scratch-path" }));

    const lifecycle = await openSourceCaptureWorkspace(paths, { assertLease() {} });
    await lifecycle.close();
    await expect(lifecycle.close()).resolves.toBeUndefined();
    await expect(
      lifecycle.workspace.withPrivateDirectory(async () => undefined),
    ).rejects.toMatchObject({ code: "workspace-closed" });
  });

  test("refuses an existing scratch root with public permissions", async () => {
    if (process.platform === "win32") return;
    const paths = await fixturePaths();
    await mkdir(paths.scratch, { mode: 0o700 });
    await chmod(paths.scratch, 0o755);

    await expect(openSourceCaptureWorkspace(paths, { assertLease() {} })).rejects.toMatchObject({
      code: "unsafe-scratch-root",
    });
  });
});

async function fixturePaths() {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-workspace-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "library");
  await mkdir(directory, { mode: 0o700 });
  return { directory, scratch: path.join(directory, ".scratch") };
}
