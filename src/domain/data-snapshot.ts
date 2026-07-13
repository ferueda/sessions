export type UnknownRecord = Record<PropertyKey, unknown>;

export type PlainRecordSnapshot =
  | {
      readonly ok: true;
      readonly record: UnknownRecord;
      readonly keys: readonly PropertyKey[];
    }
  | {
      readonly ok: false;
      readonly code: "expected-object" | "invalid-object";
    };

export type ArraySnapshot =
  | {
      readonly ok: true;
      readonly values: readonly unknown[];
    }
  | {
      readonly ok: false;
      readonly code: "expected-array" | "invalid-object";
    };

export function snapshotArray(value: unknown): ArraySnapshot {
  try {
    if (!Array.isArray(value)) return { ok: false, code: "expected-array" };

    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      return { ok: false, code: "invalid-object" };
    }

    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) return { ok: false, code: "invalid-object" };

    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        return { ok: false, code: "invalid-object" };
      }
      values.push(descriptor.value);
    }
    return { ok: true, values };
  } catch {
    return { ok: false, code: "invalid-object" };
  }
}

export function snapshotPlainRecord(value: unknown): PlainRecordSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, code: "expected-object" };
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, code: "expected-object" };
    }

    const keys = Reflect.ownKeys(value);
    const record = Object.create(null) as UnknownRecord;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        return { ok: false, code: "invalid-object" };
      }
      // Snapshot data descriptors without executing adapter-controlled getters.
      Object.defineProperty(record, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return { ok: true, record, keys };
  } catch {
    return { ok: false, code: "invalid-object" };
  }
}
