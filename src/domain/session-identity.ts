import type { SessionIdentity } from "./session.ts";

declare const printableSessionIdBrand: unique symbol;

export type PrintableSessionId = string & {
  readonly [printableSessionIdBrand]: "PrintableSessionId";
};

export type SessionIdentityParseErrorCode =
  | "invalid-format"
  | "invalid-kind"
  | "invalid-instance-id"
  | "invalid-native-id"
  | "invalid-encoding"
  | "non-canonical";

export type ParseSessionIdentityResult =
  | {
      readonly ok: true;
      readonly identity: SessionIdentity;
    }
  | {
      readonly ok: false;
      readonly code: SessionIdentityParseErrorCode;
    };

const KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RFC_3986_RESERVED_COMPONENT_CHARACTERS = /[!'()*]/g;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidKind(value: unknown): value is string {
  return typeof value === "string" && KIND_PATTERN.test(value);
}

function isValidOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.isWellFormed();
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(
    RFC_3986_RESERVED_COMPONENT_CHARACTERS,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function decodeComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function isSessionIdentity(value: unknown): value is SessionIdentity {
  if (!isRecord(value) || !isRecord(value.source)) {
    return false;
  }

  return (
    isValidKind(value.source.kind) &&
    isValidOpaqueId(value.source.instanceId) &&
    isValidOpaqueId(value.nativeId)
  );
}

export function formatSessionIdentity(identity: SessionIdentity): PrintableSessionId {
  if (!isSessionIdentity(identity)) {
    throw new TypeError("Invalid session identity");
  }

  return `${identity.source.kind}@${encodeComponent(identity.source.instanceId)}:${encodeComponent(identity.nativeId)}` as PrintableSessionId;
}

export function parseSessionIdentity(value: string): ParseSessionIdentityResult {
  if (typeof value !== "string" || !value.isWellFormed()) {
    return { ok: false, code: "invalid-format" };
  }

  const atIndex = value.indexOf("@");
  const colonIndex = value.indexOf(":", atIndex + 1);
  if (atIndex <= 0 || colonIndex <= atIndex + 1 || colonIndex === value.length - 1) {
    return { ok: false, code: "invalid-format" };
  }

  const kind = value.slice(0, atIndex);
  if (!isValidKind(kind)) {
    return { ok: false, code: "invalid-kind" };
  }

  const instanceId = decodeComponent(value.slice(atIndex + 1, colonIndex));
  const nativeId = decodeComponent(value.slice(colonIndex + 1));
  if (instanceId === undefined || nativeId === undefined) {
    return { ok: false, code: "invalid-encoding" };
  }
  if (!isValidOpaqueId(instanceId)) {
    return { ok: false, code: "invalid-instance-id" };
  }
  if (!isValidOpaqueId(nativeId)) {
    return { ok: false, code: "invalid-native-id" };
  }

  const identity: SessionIdentity = {
    source: { kind, instanceId },
    nativeId,
  };
  if (formatSessionIdentity(identity) !== value) {
    return { ok: false, code: "non-canonical" };
  }

  return { ok: true, identity };
}

export function sameSessionIdentity(left: SessionIdentity, right: SessionIdentity): boolean {
  return (
    left.source.kind === right.source.kind &&
    left.source.instanceId === right.source.instanceId &&
    left.nativeId === right.nativeId
  );
}
