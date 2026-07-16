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

import {
  clearWriterCleanProofFiles,
  consumeWriterCleanProof,
  publishWriterCleanProof,
  readWriterCleanProof,
  removeWriterCleanProofTemporaryFiles,
  snapshotWriterCleanProofDatabase,
  writerCleanProofMatchesClaim,
  writerCleanProofPaths,
  type WriterCleanProofClaim,
} from "../../src/infrastructure/sqlite/writer-clean-proof.ts";

const temporaryDirectories: string[] = [];
const firstClaim: WriterCleanProofClaim = {
  libraryInstanceId: "0123456789abcdef0123456789abcdef",
  writerGeneration: 7,
  schemaVersion: 1,
  schemaCookie: 31,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SQLite writer clean proof", () => {
  test("consumes a selected proof before returning its retained claim", async () => {
    const database = await fixtureDatabase();
    await publishWriterCleanProof(database, firstClaim);

    await expect(consumeWriterCleanProof(database)).resolves.toMatchObject(firstClaim);
    await expect(readWriterCleanProof(database)).resolves.toBeUndefined();
  });

  test("does not move an invalid proof into recognized temporary residue", async () => {
    const database = await fixtureDatabase();
    const paths = writerCleanProofPaths(database);
    await writeFile(paths.proof, "not a valid proof", { mode: 0o600 });

    await expect(consumeWriterCleanProof(database)).resolves.toBeUndefined();
    await expect(readFile(paths.proof, "utf8")).resolves.toBe("not a valid proof");
    expect(await readdir(path.dirname(database))).toEqual([
      path.basename(database),
      path.basename(paths.proof),
    ]);
  });

  test("publishes a bounded private proof and replaces it atomically", async () => {
    const database = await fixtureDatabase();
    const paths = writerCleanProofPaths(database);

    await publishWriterCleanProof(database, firstClaim, {
      token: () => "11111111111111111111111111111111",
    });
    const first = await readWriterCleanProof(database);
    if (first === undefined) throw new Error("Expected the published proof to be readable");
    expect(first).toMatchObject({ version: 1, ...firstClaim });
    expect(first.databaseStat).toEqual(await snapshotWriterCleanProofDatabase(database));
    expect(writerCleanProofMatchesClaim(first, firstClaim)).toBe(true);
    expect(writerCleanProofMatchesClaim(first, { ...firstClaim, writerGeneration: 8 })).toBe(false);

    const secondClaim = { ...firstClaim, writerGeneration: 8, schemaCookie: 32 };
    await publishWriterCleanProof(database, secondClaim, {
      token: () => "22222222222222222222222222222222",
    });
    expect(await readWriterCleanProof(database)).toMatchObject(secondClaim);
    expect(await readdir(path.dirname(database))).toEqual([
      path.basename(database),
      path.basename(paths.proof),
    ]);

    const serialized = await readFile(paths.proof, "utf8");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(4_096);
    expect(serialized).not.toContain(database);
    expect(serialized).not.toContain("22222222222222222222222222222222");
  });

  test.runIf(process.platform !== "win32")(
    "publishes its proof with private POSIX permissions",
    async () => {
      const database = await fixtureDatabase();
      const paths = writerCleanProofPaths(database);
      await publishWriterCleanProof(database, firstClaim, {
        token: () => "abababababababababababababababab",
      });

      expect((await lstat(paths.proof)).mode & 0o777).toBe(0o600);
    },
  );

  test("keeps the last complete proof when temporary publication cannot start", async () => {
    const database = await fixtureDatabase();
    const paths = writerCleanProofPaths(database);
    await publishWriterCleanProof(database, firstClaim, {
      token: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const occupiedTemporary = `${paths.temporaryPrefix}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`;
    await writeFile(occupiedTemporary, "prior temporary residue", { mode: 0o600 });

    await expect(
      publishWriterCleanProof(
        database,
        { ...firstClaim, writerGeneration: 8 },
        {
          token: () => "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ),
    ).rejects.toMatchObject({ code: "publication-failed" });

    expect(await readWriterCleanProof(database)).toMatchObject(firstClaim);
    await expect(readFile(occupiedTemporary, "utf8")).resolves.toBe("prior temporary residue");
  });

  test("treats malformed, unsafe, oversized, and stale proof as ineligible", async () => {
    const database = await fixtureDatabase();
    const paths = writerCleanProofPaths(database);
    await publishWriterCleanProof(database, firstClaim, {
      token: () => "33333333333333333333333333333333",
    });
    const validPayload = JSON.parse(await readFile(paths.proof, "utf8")) as Record<string, unknown>;

    await writeFile(paths.proof, JSON.stringify({ ...validPayload, unexpected: true }), {
      mode: 0o600,
    });
    await expect(readWriterCleanProof(database)).resolves.toBeUndefined();

    await writeFile(paths.proof, "x".repeat(4_097), { mode: 0o600 });
    await expect(readWriterCleanProof(database)).resolves.toBeUndefined();

    await publishWriterCleanProof(database, firstClaim, {
      token: () => "44444444444444444444444444444444",
    });
    await writeFile(database, "database changed after close", { mode: 0o600 });
    await expect(readWriterCleanProof(database)).resolves.toBeUndefined();
  });

  test.runIf(process.platform !== "win32")(
    "treats a proof with broad POSIX permissions as ineligible",
    async () => {
      const database = await fixtureDatabase();
      const paths = writerCleanProofPaths(database);
      await publishWriterCleanProof(database, firstClaim, {
        token: () => "55555555555555555555555555555555",
      });
      await chmod(paths.proof, 0o644);

      await expect(readWriterCleanProof(database)).resolves.toBeUndefined();
    },
  );

  test("removes only the fixed proof and strictly recognized temporary residue", async () => {
    const database = await fixtureDatabase();
    const paths = writerCleanProofPaths(database);
    await publishWriterCleanProof(database, firstClaim, {
      token: () => "66666666666666666666666666666666",
    });
    const temporaryOne = `${paths.temporaryPrefix}77777777777777777777777777777777`;
    const temporaryTwo = `${paths.temporaryPrefix}88888888888888888888888888888888`;
    const similarNeighbor = `${paths.temporaryPrefix}not-recognized`;
    const unrelated = path.join(path.dirname(database), "keep.txt");
    await Promise.all([
      writeFile(temporaryOne, "one", { mode: 0o600 }),
      writeFile(temporaryTwo, "two", { mode: 0o600 }),
      writeFile(similarNeighbor, "similar", { mode: 0o600 }),
      writeFile(unrelated, "unrelated", { mode: 0o600 }),
    ]);

    await expect(removeWriterCleanProofTemporaryFiles(database)).resolves.toBe(2);
    await expect(readFile(paths.proof, "utf8")).resolves.toContain('"version":1');
    await expect(clearWriterCleanProofFiles(database)).resolves.toBe(1);
    await expect(lstat(paths.proof)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(similarNeighbor, "utf8")).resolves.toBe("similar");
    await expect(readFile(unrelated, "utf8")).resolves.toBe("unrelated");
  });

  test.runIf(process.platform !== "win32")(
    "does not follow an unsafe recognized temporary symlink during cleanup",
    async () => {
      const database = await fixtureDatabase();
      const paths = writerCleanProofPaths(database);
      const outside = path.join(path.dirname(path.dirname(database)), "outside.txt");
      await writeFile(outside, "retain outside", { mode: 0o600 });
      const temporary = `${paths.temporaryPrefix}99999999999999999999999999999999`;
      await symlink(outside, temporary);

      await expect(removeWriterCleanProofTemporaryFiles(database)).rejects.toMatchObject({
        code: "cleanup-failed",
      });
      await expect(readFile(outside, "utf8")).resolves.toBe("retain outside");
    },
  );
});

async function fixtureDatabase(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-writer-proof-"));
  temporaryDirectories.push(root);
  const directory = path.join(root, "sessions");
  const database = path.join(directory, "sessions.sqlite3");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(database, "stable database bytes", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(database, 0o600);
  return database;
}
