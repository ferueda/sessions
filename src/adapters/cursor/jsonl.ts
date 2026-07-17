import { pipeline } from "node:stream/promises";

import { snapshotPlainRecord } from "../../domain/data-snapshot.ts";
import { decodeUtf8, parseJsonText } from "./format-fields.ts";
import { malformedCursorFormat, unsupportedCursorFormat } from "./format-error.ts";

export const MAX_CURSOR_JSONL_RECORD_BYTES = 32 * 1024 * 1024;

export type CursorJsonlRecordHandler = (
  value: unknown,
  recordOrdinal: number,
) => void | Promise<void>;

/**
 * Parses nonempty physical JSONL records without owning the underlying file.
 *
 * The source adapter remains responsible for no-follow opening, descriptor
 * checks, close errors, and mapping file-system failures.
 */
export async function parseCursorJsonl(
  source: AsyncIterable<Uint8Array>,
  onRecord: CursorJsonlRecordHandler,
): Promise<void> {
  await pipeline(source, splitJsonLines, async (records) => {
    let recordOrdinal = 0;
    for await (const record of records) {
      const snapshot = snapshotPlainRecord(parseJsonText(decodeUtf8(record)));
      if (!snapshot.ok) malformedCursorFormat();
      await onRecord(snapshot.record, recordOrdinal);
      recordOrdinal += 1;
    }
  });
}

async function* splitJsonLines(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let chunks: Buffer[] = [];
  let size = 0;

  const append = (value: Buffer): void => {
    if (value.byteLength === 0) return;
    size += value.byteLength;
    if (size > MAX_CURSOR_JSONL_RECORD_BYTES) unsupportedCursorFormat();
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
      start = index + 1;
    }
    append(chunk.subarray(start));
  }

  if (size > 0) {
    const line = take();
    if (line.byteLength > 0) yield line;
  }
}
