import { constants, type BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";

import { yieldToEventLoop } from "../../application/yield-to-event-loop.ts";
import type { RolloutFileStat } from "./paths.ts";

export const MAX_CODEX_ROLLOUT_RECORD_BYTES = 32 * 1024 * 1024;
const COOPERATIVE_YIELD_RECORD_INTERVAL = 64;
const UNREADABLE_FILE_SYSTEM_CODES = new Set([
  "EACCES",
  "EBADF",
  "EIO",
  "EMFILE",
  "ENFILE",
  "EPERM",
]);

export class CodexRolloutError extends Error {
  readonly kind: "malformed" | "source-changed" | "unreadable" | "unsupported-format";

  constructor(
    kind: "malformed" | "source-changed" | "unreadable" | "unsupported-format",
    options?: { readonly cause?: unknown },
  ) {
    super("Codex rollout could not be read", options);
    this.name = "CodexRolloutError";
    this.kind = kind;
  }
}

export interface ReadCodexRolloutOptions {
  readonly file: string;
  readonly representation: "plain" | "zstd";
  readonly expectedStat?: RolloutFileStat;
  readonly onRecord: (value: unknown, recordOrdinal: number) => void | Promise<void>;
  readonly onBlankRecord?: () => void | Promise<void>;
}

export async function readCodexRollout(options: ReadCodexRolloutOptions): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let operationError: unknown;
  try {
    try {
      handle = await open(options.file, readOnlyNoFollowFlags());
    } catch (error) {
      throw new CodexRolloutError(openFailureKind(error, options.expectedStat), { cause: error });
    }
    await assertExpectedStat(handle, options.expectedStat);

    let pipelineError: unknown;
    try {
      await consumeRollout(handle, options);
    } catch (error) {
      pipelineError = normalizePipelineError(error);
    }

    let stabilityError: unknown;
    try {
      await assertExpectedStat(handle, options.expectedStat);
    } catch (error) {
      stabilityError = error;
    }
    if (stabilityError !== undefined) {
      const stabilityFailure = normalizePipelineError(stabilityError);
      throw new CodexRolloutError(stabilityFailure.kind, {
        cause:
          pipelineError === undefined
            ? stabilityFailure
            : new AggregateError(
                [pipelineError, stabilityFailure],
                "Codex rollout processing and stability verification failed",
                { cause: pipelineError },
              ),
      });
    }
    if (pipelineError !== undefined) throw pipelineError;
  } catch (error) {
    operationError = normalizePipelineError(error);
  }

  let closeError: unknown;
  if (handle !== undefined) {
    try {
      await handle.close();
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    const primary = normalizePipelineError(operationError);
    throw new CodexRolloutError(primary.kind, {
      cause: new AggregateError(
        [operationError, closeError],
        "Codex rollout read and close both failed",
        { cause: operationError },
      ),
    });
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw new CodexRolloutError("unreadable", { cause: closeError });
}

async function consumeRollout(
  handle: Awaited<ReturnType<typeof open>>,
  options: ReadCodexRolloutOptions,
): Promise<void> {
  const source = handle.createReadStream({ autoClose: false });
  const consume = async (records: AsyncIterable<Buffer>): Promise<void> => {
    let ordinal = 0;
    let recordsSinceYield = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const record of records) {
      if (record.byteLength === 0) {
        await options.onBlankRecord?.();
      } else {
        let value: unknown;
        try {
          value = JSON.parse(decoder.decode(record));
        } catch (error) {
          throw new CodexRolloutError("malformed", { cause: error });
        }
        await options.onRecord(value, ordinal);
        ordinal += 1;
      }

      recordsSinceYield += 1;
      if (recordsSinceYield === COOPERATIVE_YIELD_RECORD_INTERVAL) {
        // Large rollouts can otherwise starve activity and writer-lease timers.
        await yieldToEventLoop();
        recordsSinceYield = 0;
      }
    }
  };
  if (options.representation === "zstd") {
    await pipeline(source, createZstdDecompress(), splitJsonLines, consume);
  } else {
    await pipeline(source, splitJsonLines, consume);
  }
}

function readOnlyNoFollowFlags(): number {
  return process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
}

async function assertExpectedStat(
  handle: Awaited<ReturnType<typeof open>>,
  expected: RolloutFileStat | undefined,
): Promise<void> {
  if (expected === undefined) return;
  let actual: BigIntStats;
  try {
    actual = await handle.stat({ bigint: true });
  } catch (error) {
    throw new CodexRolloutError("unreadable", { cause: error });
  }
  if (!actual.isFile() || !sameStat(actual, expected)) {
    throw new CodexRolloutError("source-changed");
  }
}

function sameStat(actual: BigIntStats, expected: RolloutFileStat): boolean {
  return (
    actual.dev.toString(10) === expected.dev &&
    actual.ino.toString(10) === expected.ino &&
    actual.mode.toString(10) === expected.mode &&
    actual.size.toString(10) === expected.size &&
    actual.mtimeNs.toString(10) === expected.mtimeNs &&
    actual.ctimeNs.toString(10) === expected.ctimeNs &&
    actual.birthtimeNs.toString(10) === expected.birthtimeNs
  );
}

function normalizePipelineError(error: unknown): CodexRolloutError {
  if (error instanceof CodexRolloutError) return error;
  return new CodexRolloutError(isUnreadableFileSystemError(error) ? "unreadable" : "malformed", {
    cause: error,
  });
}

function openFailureKind(
  error: unknown,
  expected: RolloutFileStat | undefined,
): CodexRolloutError["kind"] {
  if (
    expected !== undefined &&
    isFileSystemError(error) &&
    (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
  ) {
    return "source-changed";
  }
  return "unreadable";
}

function isUnreadableFileSystemError(error: unknown): boolean {
  return isFileSystemError(error) && UNREADABLE_FILE_SYSTEM_CODES.has(error.code);
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

async function* splitJsonLines(source: AsyncIterable<Buffer | Uint8Array>): AsyncIterable<Buffer> {
  let chunks: Buffer[] = [];
  let size = 0;

  const append = (value: Buffer): void => {
    if (value.byteLength === 0) return;
    size += value.byteLength;
    if (size > MAX_CODEX_ROLLOUT_RECORD_BYTES) {
      throw new CodexRolloutError("unsupported-format");
    }
    chunks.push(value);
  };

  const take = (): Buffer => {
    let line = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
    chunks = [];
    size = 0;
    if (line.at(-1) === 0x0d) line = line.subarray(0, line.byteLength - 1);
    return line;
  };

  for await (const raw of source) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    let start = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      append(chunk.subarray(start, index));
      const line = take();
      if (line.byteLength > 0) yield line;
      else yield EMPTY_RECORD_BOUNDARY;
      start = index + 1;
    }
    append(chunk.subarray(start));
  }

  if (size > 0) {
    const line = take();
    if (line.byteLength > 0) yield line;
  }
}

const EMPTY_RECORD_BOUNDARY = Buffer.alloc(0);
