import { describe, expect, test, vi } from "vitest";

import type {
  IndexLifecycle,
  IndexPaths,
  IndexStateInspector,
} from "../../src/application/ports/index-lifecycle.ts";
import { getPaths } from "../../src/application/get-paths.ts";
import type { IndexState } from "../../src/domain/index-state.ts";

const paths: IndexPaths = {
  directory: "/cache/sessions",
  database: "/cache/sessions/index.sqlite3",
  wal: "/cache/sessions/index.sqlite3-wal",
  shm: "/cache/sessions/index.sqlite3-shm",
};

describe("getPaths", () => {
  test.each([
    {
      state: {
        status: "uninitialized",
        initialized: false,
        schemaVersion: null,
        supportedSchemaVersion: 1,
      },
    },
    {
      state: {
        status: "ready",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 1,
      },
    },
    {
      state: {
        status: "migration-required",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 2,
      },
    },
    {
      state: {
        status: "newer-schema",
        initialized: true,
        schemaVersion: 3,
        supportedSchemaVersion: 2,
      },
    },
    {
      state: {
        status: "incompatible",
        initialized: true,
        schemaVersion: 1,
        supportedSchemaVersion: 1,
        reason: "migration-checksum-mismatch",
      },
    },
    {
      state: {
        status: "recovery-required",
        initialized: true,
        schemaVersion: null,
        supportedSchemaVersion: 1,
      },
    },
    {
      state: {
        status: "unsafe",
        initialized: false,
        schemaVersion: null,
        supportedSchemaVersion: 1,
        target: "directory",
        reason: "permissions",
      },
    },
  ] satisfies readonly { readonly state: IndexState }[])(
    "reports $state.status without provider-specific fields",
    async ({ state }) => {
      const inspect = vi.fn<IndexStateInspector["inspect"]>().mockResolvedValue(state);
      const inspector: IndexStateInspector = { inspect };

      const report = await getPaths(paths, inspector);

      expect(inspector.inspect).toHaveBeenCalledOnce();
      expect(inspector.inspect).toHaveBeenCalledWith(paths);
      expect(report).toEqual({
        schemaVersion: 1,
        command: "paths",
        index: {
          ...paths,
          initialized: state.initialized,
          state: state.status,
          schemaVersion: state.schemaVersion,
          supportedSchemaVersion: state.supportedSchemaVersion,
        },
      });
      expect(Object.keys(report)).toEqual(["schemaVersion", "command", "index"]);
      expect(Object.keys(report.index)).toEqual([
        "directory",
        "database",
        "wal",
        "shm",
        "initialized",
        "state",
        "schemaVersion",
        "supportedSchemaVersion",
      ]);
    },
  );

  test("uses only the inspector capability and never opens a writer", async () => {
    const lifecycle: IndexLifecycle = {
      inspect: vi.fn<IndexLifecycle["inspect"]>().mockResolvedValue({
        status: "uninitialized",
        initialized: false,
        schemaVersion: null,
        supportedSchemaVersion: 1,
      }),
      openWriter: vi
        .fn<IndexLifecycle["openWriter"]>()
        .mockRejectedValue(new Error("writer must remain unavailable")),
    };

    await expect(getPaths(paths, lifecycle)).resolves.toMatchObject({
      index: { initialized: false, state: "uninitialized" },
    });
    expect(lifecycle.openWriter).not.toHaveBeenCalled();
  });
});
