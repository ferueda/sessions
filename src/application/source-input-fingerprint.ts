import { createHash } from "node:crypto";

import type {
  DiscoveredSession,
  SourceInputAggregateFingerprint,
  SourceInputDescriptor,
} from "./ports/session-source.ts";
import { formatSessionIdentity } from "../domain/session-identity.ts";
import type { SessionIdentity } from "../domain/session.ts";

export const SOURCE_INPUT_FINGERPRINT_SCHEME = "sha256-json-v1" as const;

export interface CreateDiscoveredSessionOptions {
  readonly identity: SessionIdentity;
  readonly inputs: readonly SourceInputDescriptor[];
  readonly adapterVersion: string;
}

export function createDiscoveredSession(
  options: CreateDiscoveredSessionOptions,
): DiscoveredSession {
  // Formatting is the canonical runtime check for identities admitted to the app.
  formatSessionIdentity(options.identity);
  assertNonEmptyWellFormed(options.adapterVersion, "adapterVersion");
  assertInputs(options.inputs);

  const inputs = options.inputs.map(copyInput);
  return {
    identity: {
      source: { ...options.identity.source },
      nativeId: options.identity.nativeId,
    },
    inputs,
    aggregateFingerprint: fingerprintSourceInputs(inputs),
    adapterVersion: options.adapterVersion,
  };
}

export function fingerprintSourceInputs(
  inputs: readonly SourceInputDescriptor[],
): SourceInputAggregateFingerprint {
  assertInputs(inputs);

  const tuples = inputs.map(({ role, locator, fingerprint }) => [
    role,
    locator.uri,
    locator.recordId ?? null,
    fingerprint,
  ]);
  const digest = createHash("sha256").update(JSON.stringify(tuples), "utf8").digest("hex");

  return { scheme: SOURCE_INPUT_FINGERPRINT_SCHEME, digest };
}

export function verifySourceInputFingerprint(candidate: DiscoveredSession): boolean {
  try {
    if (
      candidate.aggregateFingerprint.scheme !== SOURCE_INPUT_FINGERPRINT_SCHEME ||
      !/^[a-f0-9]{64}$/u.test(candidate.aggregateFingerprint.digest)
    ) {
      return false;
    }

    const expected = fingerprintSourceInputs(candidate.inputs);
    return expected.digest === candidate.aggregateFingerprint.digest;
  } catch {
    return false;
  }
}

function assertInputs(inputs: readonly SourceInputDescriptor[]): void {
  if (inputs.length === 0) {
    throw new TypeError("Source inputs must contain at least one descriptor");
  }

  for (const [index, input] of inputs.entries()) {
    assertNonEmptyWellFormed(input.role, `inputs[${index}].role`);
    assertNonEmptyWellFormed(input.locator.uri, `inputs[${index}].locator.uri`);
    if (input.locator.recordId !== undefined) {
      assertNonEmptyWellFormed(input.locator.recordId, `inputs[${index}].locator.recordId`);
    }
    assertNonEmptyWellFormed(input.fingerprint, `inputs[${index}].fingerprint`);
  }
}

function assertNonEmptyWellFormed(value: string, field: string): void {
  if (value.length === 0 || !value.isWellFormed()) {
    throw new TypeError(`${field} must be a non-empty well-formed string`);
  }
}

function copyInput(input: SourceInputDescriptor): SourceInputDescriptor {
  const locator =
    input.locator.recordId === undefined
      ? { uri: input.locator.uri }
      : { uri: input.locator.uri, recordId: input.locator.recordId };

  return { role: input.role, locator, fingerprint: input.fingerprint };
}
