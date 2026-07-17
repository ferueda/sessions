import { Buffer } from "node:buffer";

import { malformedCursorFormat, unsupportedCursorFormat } from "./format-error.ts";

const MAX_TAG = 0xffff_ffffn;
const MAX_SAFE_LENGTH = BigInt(Number.MAX_SAFE_INTEGER);
const LENGTH_DELIMITED_FIELDS = new Set([1, 3, 4, 5, 7, 8, 9, 15, 16, 18, 21, 22, 27]);
const VARINT_FIELDS = new Set([10, 26]);

export function parseCursorRootBlobIds(bytes: Uint8Array): readonly string[] {
  if (!(bytes instanceof Uint8Array)) malformedCursorFormat();

  const blobIds: string[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    if (tag.value === 0n || tag.value > MAX_TAG) malformedCursorFormat();

    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (field === 0) malformedCursorFormat();
    if (LENGTH_DELIMITED_FIELDS.has(field) && wire === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      if (length.value > MAX_SAFE_LENGTH) malformedCursorFormat();
      const size = Number(length.value);
      const end = offset + size;
      if (!Number.isSafeInteger(end) || end > bytes.byteLength) malformedCursorFormat();
      if (field === 1) {
        if (size !== 32) malformedCursorFormat();
        blobIds.push(Buffer.from(bytes.subarray(offset, end)).toString("hex"));
      }
      offset = end;
      continue;
    }

    if (VARINT_FIELDS.has(field) && wire === 0) {
      offset = readVarint(bytes, offset).offset;
      continue;
    }

    unsupportedCursorFormat();
  }

  return Object.freeze(blobIds);
}

function readVarint(
  bytes: Uint8Array,
  start: number,
): { readonly value: bigint; readonly offset: number } {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    const offset = start + index;
    const byte = bytes[offset];
    if (byte === undefined) malformedCursorFormat();
    if (index === 9 && byte > 1) malformedCursorFormat();
    value |= BigInt(byte & 0x7f) << BigInt(index * 7);
    if ((byte & 0x80) === 0) return { value, offset: offset + 1 };
  }
  malformedCursorFormat();
}
