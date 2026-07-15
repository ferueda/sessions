import { describe, expect, test, vi } from "vitest";

import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import {
  IndexMaintenanceError,
  type IndexMaintenance,
  type RepairOrphansResult,
} from "../../src/application/ports/index-maintenance.ts";
import { repairOrphanedContent } from "../../src/application/repair-orphaned-content.ts";

const paths: IndexPaths = {
  directory: "/data/sessions",
  scratch: "/data/sessions/.scratch",
  database: "/data/sessions/sessions.sqlite3",
  wal: "/data/sessions/sessions.sqlite3-wal",
  shm: "/data/sessions/sessions.sqlite3-shm",
};

describe("repairOrphanedContent", () => {
  test.each([
    { outcome: "unchanged", deletedContentRows: "0", deletedContentBytes: "0" },
    {
      outcome: "repaired",
      deletedContentRows: "9007199254740993",
      deletedContentBytes: "9223372036854775807",
    },
  ] satisfies readonly RepairOrphansResult[])(
    "returns the exact $outcome report",
    async (result) => {
      const maintenance = fixtureMaintenance(result);

      await expect(repairOrphanedContent(paths, maintenance)).resolves.toEqual({
        schemaVersion: 1,
        command: "data-repair-orphans",
        ...result,
      });
      expect(maintenance.repairOrphans).toHaveBeenCalledWith(paths);
    },
  );

  test("allows repaired empty text without fabricating deleted bytes", async () => {
    const maintenance = fixtureMaintenance({
      outcome: "repaired",
      deletedContentRows: "1",
      deletedContentBytes: "0",
    });

    await expect(repairOrphanedContent(paths, maintenance)).resolves.toMatchObject({
      outcome: "repaired",
      deletedContentRows: "1",
      deletedContentBytes: "0",
    });
  });

  test("maps writer contention to the public library-busy failure", async () => {
    const busy = new IndexMaintenanceError("library-busy");
    const maintenance = fixtureMaintenance(undefined, busy);

    await expect(repairOrphanedContent(paths, maintenance)).rejects.toMatchObject({
      code: "library-busy",
      message: "Session library is busy",
      cause: busy,
    });
  });

  test("preserves an ordinary maintenance failure", async () => {
    const failure = new IndexMaintenanceError("repair-failed");
    const maintenance = fixtureMaintenance(undefined, failure);

    await expect(repairOrphanedContent(paths, maintenance)).rejects.toBe(failure);
  });

  test("projects only the exact aggregate report fields", async () => {
    const maintenance = fixtureMaintenance({
      outcome: "repaired",
      deletedContentRows: "2",
      deletedContentBytes: "64",
      schemaVersion: 999,
      command: "private-command",
      privatePath: "/private/library",
    } as RepairOrphansResult);

    await expect(repairOrphanedContent(paths, maintenance)).resolves.toEqual({
      schemaVersion: 1,
      command: "data-repair-orphans",
      outcome: "repaired",
      deletedContentRows: "2",
      deletedContentBytes: "64",
    });
  });

  test.each([
    { outcome: "unknown", deletedContentRows: "0", deletedContentBytes: "0" },
    { outcome: "unchanged", deletedContentRows: "1", deletedContentBytes: "0" },
    { outcome: "unchanged", deletedContentRows: "0", deletedContentBytes: "1" },
    { outcome: "repaired", deletedContentRows: "0", deletedContentBytes: "0" },
    { outcome: "repaired", deletedContentRows: "01", deletedContentBytes: "1" },
    { outcome: "repaired", deletedContentRows: "1", deletedContentBytes: "-1" },
    { outcome: "repaired", deletedContentRows: 1, deletedContentBytes: "1" },
  ])("fails closed on a malformed maintenance result", async (result) => {
    const maintenance = fixtureMaintenance(result as RepairOrphansResult);

    await expect(repairOrphanedContent(paths, maintenance)).rejects.toThrow(
      "Invalid orphan repair result",
    );
  });
});

function fixtureMaintenance(result?: RepairOrphansResult, failure?: unknown): IndexMaintenance {
  const repairOrphans =
    failure === undefined
      ? vi.fn<IndexMaintenance["repairOrphans"]>().mockResolvedValue(result!)
      : vi.fn<IndexMaintenance["repairOrphans"]>().mockRejectedValue(failure);
  return {
    clear: vi.fn<IndexMaintenance["clear"]>(),
    compact: vi.fn<IndexMaintenance["compact"]>(),
    forget: vi.fn<IndexMaintenance["forget"]>(),
    repairOrphans,
  };
}
