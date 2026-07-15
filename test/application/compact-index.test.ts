import { describe, expect, test, vi } from "vitest";

import { compactIndex } from "../../src/application/compact-index.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import {
  IndexMaintenanceError,
  type CompactIndexResult,
  type IndexMaintenance,
} from "../../src/application/ports/index-maintenance.ts";

const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};

describe("compactIndex", () => {
  test.each([
    {
      outcome: "absent",
      databaseBytesBefore: 0,
      databaseBytesAfter: 0,
      reclaimedDatabaseBytes: 0,
    },
    {
      outcome: "unchanged",
      databaseBytesBefore: 1024,
      databaseBytesAfter: 1024,
      reclaimedDatabaseBytes: 0,
    },
    {
      outcome: "compacted",
      databaseBytesBefore: 4096,
      databaseBytesAfter: 1024,
      reclaimedDatabaseBytes: 3072,
    },
  ] satisfies readonly CompactIndexResult[])(
    "returns the exact $outcome report",
    async (result) => {
      const maintenance = fixtureMaintenance(result);

      await expect(compactIndex(paths, maintenance)).resolves.toEqual({
        schemaVersion: 1,
        command: "data-compact",
        ...result,
      });
      expect(maintenance.compact).toHaveBeenCalledWith(paths);
    },
  );

  test("maps writer contention to the public library-busy failure", async () => {
    const busy = new IndexMaintenanceError("library-busy");
    const maintenance = fixtureMaintenance(undefined, busy);

    await expect(compactIndex(paths, maintenance)).rejects.toMatchObject({
      code: "library-busy",
      message: "Session library is busy",
      cause: busy,
    });
  });

  test("preserves an ordinary maintenance failure", async () => {
    const failure = new IndexMaintenanceError("compact-failed");
    const maintenance = fixtureMaintenance(undefined, failure);

    await expect(compactIndex(paths, maintenance)).rejects.toBe(failure);
  });

  test("projects only the exact aggregate report fields", async () => {
    const maintenance = fixtureMaintenance({
      outcome: "unchanged",
      databaseBytesBefore: 1024,
      databaseBytesAfter: 1024,
      reclaimedDatabaseBytes: 0,
      schemaVersion: 999,
      command: "private-command",
      privatePath: "/private/library",
    } as CompactIndexResult);

    await expect(compactIndex(paths, maintenance)).resolves.toEqual({
      schemaVersion: 1,
      command: "data-compact",
      outcome: "unchanged",
      databaseBytesBefore: 1024,
      databaseBytesAfter: 1024,
      reclaimedDatabaseBytes: 0,
    });
  });

  test.each([
    {
      outcome: "unknown",
      databaseBytesBefore: 0,
      databaseBytesAfter: 0,
      reclaimedDatabaseBytes: 0,
    },
    {
      outcome: "absent",
      databaseBytesBefore: 1,
      databaseBytesAfter: 1,
      reclaimedDatabaseBytes: 0,
    },
    {
      outcome: "unchanged",
      databaseBytesBefore: 2,
      databaseBytesAfter: 1,
      reclaimedDatabaseBytes: 1,
    },
    {
      outcome: "compacted",
      databaseBytesBefore: 1,
      databaseBytesAfter: 1,
      reclaimedDatabaseBytes: 0,
    },
    {
      outcome: "compacted",
      databaseBytesBefore: -1,
      databaseBytesAfter: 0,
      reclaimedDatabaseBytes: -1,
    },
    {
      outcome: "compacted",
      databaseBytesBefore: Number.MAX_SAFE_INTEGER + 1,
      databaseBytesAfter: 0,
      reclaimedDatabaseBytes: Number.MAX_SAFE_INTEGER + 1,
    },
  ])("fails closed on a malformed maintenance result", async (result) => {
    const maintenance = fixtureMaintenance(result as CompactIndexResult);

    await expect(compactIndex(paths, maintenance)).rejects.toThrow("Invalid compact result");
  });
});

function fixtureMaintenance(result?: CompactIndexResult, failure?: unknown): IndexMaintenance {
  const compact =
    failure === undefined
      ? vi.fn<IndexMaintenance["compact"]>().mockResolvedValue(result!)
      : vi.fn<IndexMaintenance["compact"]>().mockRejectedValue(failure);
  return {
    clear: vi.fn<IndexMaintenance["clear"]>(),
    compact,
    forget: vi.fn<IndexMaintenance["forget"]>(),
    repairOrphans: vi.fn<IndexMaintenance["repairOrphans"]>(),
  };
}
