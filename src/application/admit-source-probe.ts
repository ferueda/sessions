import type { SourceProbe } from "./ports/session-source.ts";
import { snapshotArray, snapshotPlainRecord } from "../domain/data-snapshot.ts";
import { isSessionIdentity } from "../domain/session-identity.ts";

export function admitSourceProbe(value: unknown): SourceProbe | undefined {
  const root = snapshotPlainRecord(value);
  if (!root.ok || !hasExactKeys(root.record, ["source", "status", "locations", "summary"])) {
    return undefined;
  }
  const source = snapshotPlainRecord(root.record.source);
  if (
    !source.ok ||
    !hasExactKeys(source.record, ["kind", "instanceId"]) ||
    !isSessionIdentity({ source: source.record, nativeId: "probe" })
  ) {
    return undefined;
  }
  const status = root.record.status;
  if (status !== "ready" && status !== "unavailable" && status !== "unreadable") return undefined;
  if (!isNonEmptyWellFormedString(root.record.summary)) return undefined;

  const locations = snapshotArray(root.record.locations);
  if (!locations.ok || locations.values.length === 0) return undefined;
  const admittedLocations = [];
  for (const value of locations.values) {
    const location = snapshotPlainRecord(value);
    if (!location.ok || !hasExactKeys(location.record, ["role", "locator"])) return undefined;
    const locator = snapshotPlainRecord(location.record.locator);
    if (
      !locator.ok ||
      !hasAllowedKeys(locator.record, ["uri", "recordId"], ["uri"]) ||
      !isNonEmptyWellFormedString(location.record.role) ||
      !isNonEmptyWellFormedString(locator.record.uri) ||
      (Object.hasOwn(locator.record, "recordId") &&
        !isNonEmptyWellFormedString(locator.record.recordId))
    ) {
      return undefined;
    }
    admittedLocations.push({
      role: location.record.role,
      locator: {
        uri: locator.record.uri,
        ...(Object.hasOwn(locator.record, "recordId")
          ? { recordId: locator.record.recordId as string }
          : {}),
      },
    });
  }
  return {
    source: { kind: source.record.kind, instanceId: source.record.instanceId },
    status,
    locations: admittedLocations,
    summary: root.record.summary,
  } as SourceProbe;
}

function hasExactKeys(
  record: Readonly<Record<PropertyKey, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(record);
  return keys.length === expected.length && keys.every((key) => expected.includes(String(key)));
}

function hasAllowedKeys(
  record: Readonly<Record<PropertyKey, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(record);
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    keys.every((key) => typeof key === "string" && allowed.includes(key))
  );
}

function isNonEmptyWellFormedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed();
}
