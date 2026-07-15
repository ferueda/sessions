export type JsonFragmentSink = (fragment: string) => void;

interface ObjectMember {
  readonly key: string;
  readonly value: unknown;
}

const CONTROL_ESCAPES: Readonly<Record<number, string>> = Object.freeze({
  8: "\\b",
  9: "\\t",
  10: "\\n",
  12: "\\f",
  13: "\\r",
});

/** Writes the RFC 8785 form without building one complete serialized string. */
export function writeCanonicalJson(value: unknown, sink: JsonFragmentSink): void {
  if (typeof sink !== "function") {
    throw new TypeError("Canonical JSON requires a fragment sink");
  }

  writeValue(value, sink, new Set<object>());
}

function writeValue(value: unknown, sink: JsonFragmentSink, active: Set<object>): void {
  if (value === null) {
    sink("null");
    return;
  }

  switch (typeof value) {
    case "boolean":
      sink(value ? "true" : "false");
      return;
    case "number":
      writeNumber(value, sink);
      return;
    case "string":
      writeString(value, sink);
      return;
    case "object":
      writeCompound(value, sink, active);
      return;
    default:
      throw new TypeError("Canonical JSON accepts only JSON values");
  }
}

function writeNumber(value: number, sink: JsonFragmentSink): void {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new TypeError("Canonical JSON requires finite numbers and safe integers");
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("Canonical JSON could not serialize a number");
  }
  sink(serialized);
}

function writeString(value: string, sink: JsonFragmentSink): void {
  if (!value.isWellFormed()) {
    throw new TypeError("Canonical JSON requires well-formed Unicode strings");
  }

  sink('"');
  let runStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      index += 1;
      continue;
    }

    const escape = escapeCodeUnit(codeUnit);
    if (escape === undefined) continue;

    if (runStart < index) sink(value.slice(runStart, index));
    sink(escape);
    runStart = index + 1;
  }
  if (runStart < value.length) sink(value.slice(runStart));
  sink('"');
}

function escapeCodeUnit(codeUnit: number): string | undefined {
  if (codeUnit === 0x22) return '\\"';
  if (codeUnit === 0x5c) return "\\\\";
  if (codeUnit > 0x1f) return undefined;

  const shortEscape = CONTROL_ESCAPES[codeUnit];
  return shortEscape ?? `\\u${codeUnit.toString(16).padStart(4, "0")}`;
}

function writeCompound(value: object, sink: JsonFragmentSink, active: Set<object>): void {
  if (active.has(value)) {
    throw new TypeError("Canonical JSON does not accept cyclic values");
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      writeArray(value, sink, active);
    } else {
      writeObject(value, sink, active);
    }
  } finally {
    active.delete(value);
  }
}

function writeArray(value: readonly unknown[], sink: JsonFragmentSink, active: Set<object>): void {
  const values = snapshotArray(value);
  sink("[");
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) sink(",");
    writeValue(values[index], sink, active);
  }
  sink("]");
}

function snapshotArray(value: readonly unknown[]): readonly unknown[] {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new TypeError("Canonical JSON requires ordinary dense arrays");
  }

  const length = lengthDescriptor.value as number;
  if (Reflect.ownKeys(value).length !== length + 1) {
    throw new TypeError("Canonical JSON requires ordinary dense arrays");
  }

  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Canonical JSON requires ordinary dense arrays");
    }
    values.push(descriptor.value);
  }
  return values;
}

function writeObject(value: object, sink: JsonFragmentSink, active: Set<object>): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Canonical JSON requires plain objects");
  }

  const members = snapshotObjectMembers(value);
  members.sort(compareUtf16Keys);

  sink("{");
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member === undefined) throw new TypeError("Canonical JSON member is missing");
    if (index > 0) sink(",");
    writeString(member.key, sink);
    sink(":");
    writeValue(member.value, sink, active);
  }
  sink("}");
}

function snapshotObjectMembers(value: object): ObjectMember[] {
  const members: ObjectMember[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !key.isWellFormed()) {
      throw new TypeError("Canonical JSON requires well-formed string object keys");
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Canonical JSON requires enumerable data properties");
    }
    members.push({ key, value: descriptor.value });
  }
  return members;
}

function compareUtf16Keys(left: ObjectMember, right: ObjectMember): number {
  if (left.key < right.key) return -1;
  if (left.key > right.key) return 1;
  return 0;
}
