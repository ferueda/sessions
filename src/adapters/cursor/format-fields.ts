import { TextDecoder } from "node:util";

import {
  snapshotArray,
  snapshotPlainRecord,
  type UnknownRecord,
} from "../../domain/data-snapshot.ts";
import { writeCanonicalJson } from "../../domain/json-canonicalization.ts";
import {
  CursorFormatError,
  malformedCursorFormat,
  unsupportedCursorFormat,
} from "./format-error.ts";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function exactRecord(
  value: unknown,
  requiredKeys: ReadonlySet<string>,
  optionalKeys: ReadonlySet<string> = EMPTY_KEYS,
): UnknownRecord {
  const snapshot = snapshotPlainRecord(value);
  if (!snapshot.ok) malformedCursorFormat();
  for (const key of snapshot.keys) {
    if (typeof key !== "string") unsupportedCursorFormat();
    if (!requiredKeys.has(key) && !optionalKeys.has(key)) unsupportedCursorFormat();
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(snapshot.record, key)) malformedCursorFormat();
  }
  return snapshot.record;
}

export function plainJsonRecord(value: unknown): UnknownRecord {
  const snapshot = snapshotPlainRecord(value);
  if (!snapshot.ok) malformedCursorFormat();
  validateJson(value);
  return snapshot.record;
}

export function denseArray(value: unknown): readonly unknown[] {
  const snapshot = snapshotArray(value);
  if (!snapshot.ok) malformedCursorFormat();
  return snapshot.values;
}

export function requiredString(record: UnknownRecord, key: string, nonEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string" || !value.isWellFormed() || (nonEmpty && value.length === 0)) {
    malformedCursorFormat();
  }
  return value;
}

export function optionalString(record: UnknownRecord, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return requiredString(record, key);
}

export function requiredBoolean(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") malformedCursorFormat();
  return value;
}

export function requiredNonnegativeSafeInteger(record: UnknownRecord, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    malformedCursorFormat();
  }
  return value;
}

export function requiredPlainJsonRecord(record: UnknownRecord, key: string): UnknownRecord {
  return plainJsonRecord(record[key]);
}

export function optionalPlainJsonRecord(record: UnknownRecord, key: string): void {
  if (Object.hasOwn(record, key)) plainJsonRecord(record[key]);
}

export function parseJsonText(value: string): unknown {
  if (!value.isWellFormed()) malformedCursorFormat();
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    malformedCursorFormat(error);
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    malformedCursorFormat(error);
  }
}

export function canonicalJson(value: unknown): string {
  const fragments: string[] = [];
  try {
    writeCanonicalJson(value, (fragment) => fragments.push(fragment));
  } catch (error) {
    if (error instanceof CursorFormatError) throw error;
    malformedCursorFormat(error);
  }
  return fragments.join("");
}

export function validateJson(value: unknown): void {
  try {
    writeCanonicalJson(value, () => undefined);
  } catch (error) {
    if (error instanceof CursorFormatError) throw error;
    malformedCursorFormat(error);
  }
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
