import type { UnknownRecord } from "../../domain/data-snapshot.ts";
import { CodexRolloutError } from "./rollout.ts";

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function plainRecord(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throwMalformed();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throwMalformed();
  } catch (error) {
    if (error instanceof CodexRolloutError) throw error;
    throwMalformed();
  }
  return value as UnknownRecord;
}

export function requiredRecord(record: UnknownRecord, key: string): UnknownRecord {
  const value = own(record, key);
  if (!value.present) throwMalformed();
  return plainRecord(value.value);
}

export function optionalRecord(record: UnknownRecord, key: string): UnknownRecord | undefined {
  const value = own(record, key);
  if (!value.present || value.value === null) return undefined;
  return plainRecord(value.value);
}

export function requiredArray(record: UnknownRecord, key: string): readonly unknown[] {
  const value = own(record, key);
  if (!value.present) throwMalformed();
  return arrayValue(value.value);
}

export function optionalArray(record: UnknownRecord, key: string): readonly unknown[] | undefined {
  const value = own(record, key);
  if (!value.present || value.value === null) return undefined;
  return arrayValue(value.value);
}

export function arrayValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throwMalformed();
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      throwMalformed();
    }
    const items: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throwMalformed();
      items.push(descriptor.value);
    }
    return items;
  } catch (error) {
    if (error instanceof CodexRolloutError) throw error;
    throwMalformed();
  }
}

export function discriminator(record: UnknownRecord, key: string): string {
  const value = own(record, key);
  if (!value.present || typeof value.value !== "string" || value.value.length === 0) {
    throwMalformed();
  }
  return value.value;
}

export function requiredText(record: UnknownRecord, key: string, nonEmpty = false): string {
  const value = own(record, key);
  if (!value.present || typeof value.value !== "string") throwMalformed();
  const result = wellFormed(value.value);
  if (nonEmpty && result.length === 0) throwMalformed();
  return result;
}

export function optionalText(
  record: UnknownRecord,
  key: string,
  nonEmpty = false,
): string | undefined {
  const value = own(record, key);
  if (!value.present || value.value === null) return undefined;
  if (typeof value.value !== "string") throwMalformed();
  const result = wellFormed(value.value);
  if (nonEmpty && result.length === 0) throwMalformed();
  return result;
}

export function requiredRawString(record: UnknownRecord, key: string): string {
  const value = own(record, key);
  if (!value.present || typeof value.value !== "string") throwMalformed();
  return value.value;
}

export function optionalRawString(record: UnknownRecord, key: string): string | undefined {
  const value = own(record, key);
  if (!value.present || value.value === null) return undefined;
  if (typeof value.value !== "string") throwMalformed();
  return value.value;
}

export function requiredNumber(record: UnknownRecord, key: string): number {
  const value = own(record, key);
  if (!value.present || typeof value.value !== "number" || !Number.isFinite(value.value)) {
    throwMalformed();
  }
  return value.value;
}

export function optionalNullableStringArray(record: UnknownRecord, key: string): readonly string[] {
  const value = own(record, key);
  if (!value.present || value.value === null) return [];
  return rawStringArray(value.value);
}

export function optionalNonNullStringArray(record: UnknownRecord, key: string): readonly string[] {
  const value = own(record, key);
  if (!value.present) return [];
  return rawStringArray(value.value);
}

export function timestampField(record: UnknownRecord): string | undefined {
  const value = own(record, "timestamp");
  if (!value.present || value.value === null) return undefined;
  if (typeof value.value !== "string") throwMalformed();
  const match = RFC3339.exec(value.value);
  if (match === null || !validDateParts(match)) throwMalformed();
  const milliseconds = Date.parse(value.value);
  if (!Number.isFinite(milliseconds)) throwMalformed();
  const canonical = new Date(milliseconds).toISOString();
  if (!CANONICAL_TIMESTAMP.test(canonical)) throwMalformed();
  return canonical;
}

export function own(
  record: UnknownRecord,
  key: string,
): { readonly present: false } | { readonly present: true; readonly value: unknown } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) return { present: false };
    if (!("value" in descriptor)) throwMalformed();
    return { present: true, value: descriptor.value };
  } catch (error) {
    if (error instanceof CodexRolloutError) throw error;
    throwMalformed();
  }
}

export function wellFormed(value: string): string {
  if (!value.isWellFormed()) throwMalformed();
  return value;
}

export function throwMalformed(): never {
  throw new CodexRolloutError("malformed");
}

function rawStringArray(value: unknown): readonly string[] {
  return arrayValue(value).map((item) => {
    if (typeof item !== "string") throwMalformed();
    return item;
  });
}

function validDateParts(match: RegExpExecArray): boolean {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return false;
  }
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
