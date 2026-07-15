import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { RolloutFileStat } from "../../../src/adapters/codex/paths.ts";
import {
  CodexRolloutError,
  MAX_CODEX_ROLLOUT_RECORD_BYTES,
  readCodexRollout,
} from "../../../src/adapters/codex/rollout.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("Codex rollout reader", () => {
  test("streams chunked CRLF, blank, and no-newline records in source order", async () => {
    const file = await temporaryFile(
      `${JSON.stringify({ id: 1, text: "x".repeat(70_000) })}\r\n\r\n${JSON.stringify({ id: 2 })}`,
    );
    const records: { value: unknown; ordinal: number }[] = [];
    const onBlankRecord = vi.fn<() => void>();

    await readCodexRollout({
      file,
      representation: "plain",
      onRecord(value, ordinal) {
        records.push({ value, ordinal });
      },
      onBlankRecord,
    });

    expect(records).toEqual([
      { value: { id: 1, text: "x".repeat(70_000) }, ordinal: 0 },
      { value: { id: 2 }, ordinal: 1 },
    ]);
    expect(onBlankRecord).toHaveBeenCalledTimes(1);
  });

  test("streams Zstandard records through the same callbacks", async () => {
    const root = await temporaryRoot();
    const file = join(root, "rollout.jsonl.zst");
    await writeFile(file, zstdCompressSync(`{"kind":"compressed"}\n`));
    const values: unknown[] = [];

    await readCodexRollout({
      file,
      representation: "zstd",
      onRecord(value) {
        values.push(value);
      },
    });

    expect(values).toEqual([{ kind: "compressed" }]);
  });

  test("yields to the event loop while consuming a large buffered rollout", async () => {
    const file = await temporaryFile(
      `${Array.from({ length: 129 }, (_, index) => JSON.stringify({ index })).join("\n")}\n`,
    );
    let eventLoopAdvanced = false;
    let eventLoopAdvancedBeforeRecord65 = false;
    let resolveEventLoopTurn!: () => void;
    const eventLoopTurn = new Promise<void>((resolve) => {
      resolveEventLoopTurn = resolve;
    });

    await readCodexRollout({
      file,
      representation: "plain",
      onRecord(_value, ordinal) {
        if (ordinal === 0) {
          setImmediate(() => {
            eventLoopAdvanced = true;
            resolveEventLoopTurn();
          });
        }
        if (ordinal === 64) eventLoopAdvancedBeforeRecord65 = eventLoopAdvanced;
      },
    });
    await eventLoopTurn;

    expect(eventLoopAdvancedBeforeRecord65).toBe(true);
  });

  test.each([
    { name: "invalid UTF-8", bytes: Buffer.from([0xff, 0x0a]), representation: "plain" as const },
    { name: "invalid JSON", bytes: Buffer.from("{\n"), representation: "plain" as const },
    { name: "invalid Zstandard", bytes: Buffer.from("not-zstd"), representation: "zstd" as const },
  ])("returns a sanitized malformed error for $name", async ({ bytes, representation }) => {
    const file = await temporaryFile(bytes);

    await expect(readCodexRollout({ file, representation, onRecord() {} })).rejects.toMatchObject({
      name: "CodexRolloutError",
      kind: "malformed",
      message: "Codex rollout could not be read",
    });
  });

  test("admits the exact record cap and rejects cap plus one before parsing", async () => {
    const exact = Buffer.alloc(MAX_CODEX_ROLLOUT_RECORD_BYTES + 1, 0x61);
    exact[0] = 0x22;
    exact[MAX_CODEX_ROLLOUT_RECORD_BYTES - 1] = 0x22;
    exact[MAX_CODEX_ROLLOUT_RECORD_BYTES] = 0x0a;
    const exactFile = await temporaryFile(exact);
    let recordCount = 0;
    await readCodexRollout({
      file: exactFile,
      representation: "plain",
      onRecord() {
        recordCount += 1;
      },
    });
    expect(recordCount).toBe(1);

    const oversized = Buffer.alloc(MAX_CODEX_ROLLOUT_RECORD_BYTES + 2, 0x61);
    oversized[0] = 0x22;
    oversized[MAX_CODEX_ROLLOUT_RECORD_BYTES] = 0x22;
    oversized[MAX_CODEX_ROLLOUT_RECORD_BYTES + 1] = 0x0a;
    const oversizedFile = await temporaryFile(oversized);
    await expect(
      readCodexRollout({ file: oversizedFile, representation: "plain", onRecord() {} }),
    ).rejects.toMatchObject({ kind: "unsupported-format" });
  });

  test("detects a descriptor change before streaming", async () => {
    const file = await temporaryFile(`{"id":1}\n`);
    const expectedStat = await fileStat(file);
    await appendFile(file, " ");

    await expect(
      readCodexRollout({
        file,
        representation: "plain",
        expectedStat,
        onRecord() {},
      }),
    ).rejects.toMatchObject({ kind: "source-changed" });
  });

  test("preserves a typed consumer failure and closes the file handle", async () => {
    const file = await temporaryFile(`{"id":1}\n`);

    await expect(
      readCodexRollout({
        file,
        representation: "plain",
        onRecord() {
          throw new CodexRolloutError("unsupported-format");
        },
      }),
    ).rejects.toMatchObject({ kind: "unsupported-format" });
    await expect(rm(file)).resolves.toBeUndefined();
  });
});

async function temporaryFile(content: string | Uint8Array): Promise<string> {
  const root = await temporaryRoot();
  const file = join(root, "rollout.jsonl");
  await writeFile(file, content);
  return file;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sessions-codex-rollout-"));
  roots.push(root);
  return root;
}

async function fileStat(file: string): Promise<RolloutFileStat> {
  const value = await stat(file, { bigint: true });
  return {
    dev: value.dev.toString(10),
    ino: value.ino.toString(10),
    mode: value.mode.toString(10),
    size: value.size.toString(10),
    mtimeNs: value.mtimeNs.toString(10),
    ctimeNs: value.ctimeNs.toString(10),
    birthtimeNs: value.birthtimeNs.toString(10),
  };
}
