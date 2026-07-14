import { describe, expect, test } from "vitest";

import { readSessionDocument } from "../../src/application/read-session-document.ts";
import {
  isSourceFailureError,
  type SourceFailureError,
} from "../../src/application/source-failure.ts";
import { verifySourceInputFingerprint } from "../../src/application/source-input-fingerprint.ts";
import type {
  DiscoveredSession,
  SessionSource,
  SourceDiscoveryWorkspace,
  SourceInputDescriptor,
} from "../../src/application/ports/session-source.ts";
import { formatSessionIdentity, sameSessionIdentity } from "../../src/domain/session-identity.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../../src/domain/session.ts";

export type SessionSourceContractScenario =
  | "ready"
  | "unavailable"
  | "unreadable"
  | "malformed"
  | "unsupported-format";

export type SourceInputOwnership = "live" | "snapshot-owned";

export interface ExpectedSourceInput {
  readonly identity: SessionIdentity;
  readonly inputIndex: number;
  readonly descriptor: Pick<SourceInputDescriptor, "role" | "locator">;
  readonly ownership: SourceInputOwnership;
}

export interface SessionSourceContractFixture {
  readonly source: SessionSource;
  readonly discoveryWorkspace: SourceDiscoveryWorkspace;
  readonly sourceInstance: SourceInstance;
  readonly identities: readonly SessionIdentity[];
  readonly primaryIdentity: SessionIdentity;
  readonly missingMetadataIdentity: SessionIdentity;
  readonly repeatedText: string;
  readonly repeatedTextProvenance: Readonly<{
    origin: SessionDocument["entries"][number]["content"][number]["origin"];
    originConfidence: SessionDocument["entries"][number]["content"][number]["originConfidence"];
  }>;
  readonly expectedInputs: readonly ExpectedSourceInput[];
  readonly sensitiveValues: readonly string[];
  readonly failureSensitiveValues?: readonly string[];
  snapshotSource(): string;
  contentReadCount(): number;
  mutateInput(identity: SessionIdentity, inputIndex: number): void | Promise<void>;
  mutateDuringNextRead(identity: SessionIdentity, inputIndex: number): void | Promise<void>;
  reverseDiscoveryOrder(): void;
  dispose(): Promise<void>;
}

export type SessionSourceContractFactory = (
  scenario?: SessionSourceContractScenario,
) => SessionSourceContractFixture | Promise<SessionSourceContractFixture>;

export function registerSessionSourceContract(
  name: string,
  createFixture: SessionSourceContractFactory,
): void {
  describe(`${name} SessionSource contract`, () => {
    test.each(["ready", "unavailable", "unreadable"] as const)(
      "probes %s source roots without reading content or mutating state",
      async (scenario) => {
        await withFixture(createFixture, scenario, async (fixture) => {
          const before = fixture.snapshotSource();

          const probe = await fixture.source.probe();

          expect(probe).toMatchObject({ source: fixture.sourceInstance, status: scenario });
          expect(probe.locations).not.toHaveLength(0);
          expect(probe.locations.every((location) => location.role.length > 0)).toBe(true);
          expectNoSensitiveValues(probe, fixture.sensitiveValues);
          expect(fixture.contentReadCount()).toBe(0);
          expect(fixture.snapshotSource()).toBe(before);
        });
      },
    );

    test.each(["unavailable", "unreadable"] as const)(
      "reports and types a %s source",
      async (scenario) => {
        await withFixture(createFixture, scenario, async (fixture) => {
          const error = await captureSourceFailure(() => discover(fixture));

          expect(error.failure.kind).toBe(scenario);
          expectSafeFailureForFixture(error, fixture);
        });
      },
    );

    test("discovers deterministic candidates with complete aggregate fingerprints", async () => {
      await withFixture(createFixture, "ready", async (fixture) => {
        const before = fixture.snapshotSource();
        const first = await discover(fixture);
        fixture.reverseDiscoveryOrder();
        const second = await discover(fixture);

        expect(candidateMap(second)).toEqual(candidateMap(first));
        expect(first).toHaveLength(fixture.identities.length);
        for (const candidate of first) {
          const expectedInputs = expectedInputsFor(candidate.identity, fixture.expectedInputs);
          expect(candidate.identity.source.kind).toBe(fixture.source.kind);
          expect(expectedInputs.map(({ inputIndex }) => inputIndex)).toEqual(
            candidate.inputs.map((_, inputIndex) => inputIndex),
          );
          expect(candidate.inputs.map(({ role, locator }) => ({ role, locator }))).toEqual(
            expectedInputs.map(({ descriptor }) => descriptor),
          );
          expect(candidate.adapterVersion.length).toBeGreaterThan(0);
          expect(verifySourceInputFingerprint(candidate)).toBe(true);
        }
        expect(fixture.snapshotSource()).toBe(before);
      });
    });

    test("invalidates the aggregate when any complete input changes", async () => {
      const expectedInputKeys = await loadExpectedInputKeys(createFixture);

      for (const key of expectedInputKeys) {
        await withFixture(createFixture, "ready", async (fixture) => {
          const expectedInput = requireExpectedInput(fixture.expectedInputs, key);
          const before = requireCandidate(await discover(fixture), expectedInput.identity);
          await fixture.mutateInput(expectedInput.identity, expectedInput.inputIndex);
          const after = requireCandidate(await discover(fixture), expectedInput.identity);

          expect(after.aggregateFingerprint).not.toEqual(before.aggregateFingerprint);
          expect(after.inputs[expectedInput.inputIndex]?.fingerprint).not.toBe(
            before.inputs[expectedInput.inputIndex]?.fingerprint,
          );
          for (const [index, input] of after.inputs.entries()) {
            if (index === expectedInput.inputIndex) continue;
            expect(input).toEqual(before.inputs[index]);
          }
        });
      }
    });

    test("reads deterministic canonical documents independent of candidate order", async () => {
      await withFixture(createFixture, "ready", async (fixture) => {
        const before = fixture.snapshotSource();
        const candidates = await discover(fixture);
        const first = await readAll(fixture.source, candidates);
        const second = await readAll(fixture.source, [...candidates].reverse());

        expect(documentMap(second)).toEqual(documentMap(first));
        expect(fixture.snapshotSource()).toBe(before);
      });
    });

    test("applies each input's ownership when it changes before read", async () => {
      expect.hasAssertions();
      const expectedInputKeys = await loadExpectedInputKeys(createFixture);

      for (const key of expectedInputKeys) {
        await withFixture(createFixture, "ready", async (fixture) => {
          const expectedInput = requireExpectedInput(fixture.expectedInputs, key);
          const candidate = requireCandidate(await discover(fixture), expectedInput.identity);
          const frozenDocument = await readSessionDocument(fixture.source, candidate);
          await fixture.mutateInput(expectedInput.identity, expectedInput.inputIndex);
          await ownershipAssertions[expectedInput.ownership](
            fixture,
            expectedInput,
            candidate,
            frozenDocument,
          );
        });
      }
    });

    test("applies each input's ownership when it changes during read", async () => {
      expect.hasAssertions();
      const expectedInputKeys = await loadExpectedInputKeys(createFixture);

      for (const key of expectedInputKeys) {
        await withFixture(createFixture, "ready", async (fixture) => {
          const expectedInput = requireExpectedInput(fixture.expectedInputs, key);
          const candidate = requireCandidate(await discover(fixture), expectedInput.identity);
          const frozenDocument = await readSessionDocument(fixture.source, candidate);
          await fixture.mutateDuringNextRead(expectedInput.identity, expectedInput.inputIndex);
          await ownershipAssertions[expectedInput.ownership](
            fixture,
            expectedInput,
            candidate,
            frozenDocument,
          );
        });
      }
    });

    test("preserves missing metadata and unknown provenance without recurrence inference", async () => {
      await withFixture(createFixture, "ready", async (fixture) => {
        const documents = await readAll(fixture.source, await discover(fixture));
        const missing = requireDocument(documents, fixture.missingMetadataIdentity);
        const repeatedSegments = documents.flatMap((document) =>
          document.entries.flatMap((entry) =>
            entry.content.filter(
              (segment) => segment.kind === "text" && segment.text === fixture.repeatedText,
            ),
          ),
        );
        const unknownProvenanceSegments = documents.flatMap((document) =>
          document.entries.flatMap((entry) =>
            entry.content.filter(
              ({ origin, originConfidence }) =>
                origin === "unknown" && originConfidence === "unknown",
            ),
          ),
        );

        expect(missing).not.toHaveProperty("title");
        expect(missing).not.toHaveProperty("workspace");
        expect(missing).not.toHaveProperty("createdAt");
        expect(missing).not.toHaveProperty("updatedAt");
        expect(repeatedSegments).toHaveLength(2);
        expect(
          repeatedSegments.map(({ origin, originConfidence }) => ({ origin, originConfidence })),
        ).toEqual([fixture.repeatedTextProvenance, fixture.repeatedTextProvenance]);
        expect(unknownProvenanceSegments.length).toBeGreaterThan(0);
      });
    });

    test.each(["malformed", "unsupported-format"] as const)(
      "returns a safe typed %s read failure",
      async (scenario) => {
        await withFixture(createFixture, scenario, async (fixture) => {
          const candidate = requireCandidate(await discover(fixture), fixture.primaryIdentity);
          const error = await captureSourceFailure(() =>
            readSessionDocument(fixture.source, candidate),
          );

          expect(error.failure.kind).toBe(scenario);
          expectSafeFailureForFixture(error, fixture);
        });
      },
    );
  });
}

async function withFixture(
  createFixture: SessionSourceContractFactory,
  scenario: SessionSourceContractScenario,
  run: (fixture: SessionSourceContractFixture) => Promise<void>,
): Promise<void> {
  const fixture = await createFixture(scenario);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function discover(
  fixture: SessionSourceContractFixture,
): Promise<readonly DiscoveredSession[]> {
  const candidates: DiscoveredSession[] = [];
  for await (const candidate of fixture.source.discover(fixture.discoveryWorkspace)) {
    candidates.push(candidate);
  }
  return candidates;
}

interface ExpectedSourceInputKey {
  readonly nativeId: string;
  readonly inputIndex: number;
}

async function loadExpectedInputKeys(
  createFixture: SessionSourceContractFactory,
): Promise<readonly ExpectedSourceInputKey[]> {
  const fixture = await createFixture("ready");
  try {
    return fixture.expectedInputs.map((input) => ({
      nativeId: input.identity.nativeId,
      inputIndex: input.inputIndex,
    }));
  } finally {
    await fixture.dispose();
  }
}

function requireExpectedInput(
  inputs: readonly ExpectedSourceInput[],
  key: ExpectedSourceInputKey,
): ExpectedSourceInput {
  const input = inputs.find(
    (candidate) =>
      candidate.identity.nativeId === key.nativeId && candidate.inputIndex === key.inputIndex,
  );
  if (input === undefined) throw new Error("Expected contract input");
  return input;
}

async function readAll(
  source: SessionSource,
  candidates: readonly DiscoveredSession[],
): Promise<readonly SessionDocument[]> {
  const documents: SessionDocument[] = [];
  for (const candidate of candidates) {
    documents.push(await readSessionDocument(source, candidate));
  }
  return documents;
}

function candidateMap(candidates: readonly DiscoveredSession[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    [...candidates]
      .sort((left, right) =>
        formatSessionIdentity(left.identity).localeCompare(formatSessionIdentity(right.identity)),
      )
      .map((candidate) => [formatSessionIdentity(candidate.identity), candidate]),
  );
}

function documentMap(documents: readonly SessionDocument[]): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    [...documents]
      .sort((left, right) =>
        formatSessionIdentity(left.identity).localeCompare(formatSessionIdentity(right.identity)),
      )
      .map((document) => [formatSessionIdentity(document.identity), document]),
  );
}

function requireCandidate(
  candidates: readonly DiscoveredSession[],
  identity: SessionIdentity,
): DiscoveredSession {
  const candidate = candidates.find((item) => sameSessionIdentity(item.identity, identity));
  if (candidate === undefined) throw new Error("Expected contract candidate");
  return candidate;
}

function requireDocument(
  documents: readonly SessionDocument[],
  identity: SessionIdentity,
): SessionDocument {
  const document = documents.find((item) => sameSessionIdentity(item.identity, identity));
  if (document === undefined) throw new Error("Expected contract document");
  return document;
}

function expectedInputsFor(
  identity: SessionIdentity,
  inputs: readonly ExpectedSourceInput[],
): readonly ExpectedSourceInput[] {
  return inputs
    .filter((input) => sameSessionIdentity(input.identity, identity))
    .sort((left, right) => left.inputIndex - right.inputIndex);
}

function expectNoSensitiveValues(value: unknown, sensitiveValues: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const sensitiveValue of sensitiveValues) {
    expect(serialized).not.toContain(sensitiveValue);
  }
}

function expectSafeFailure(error: SourceFailureError, sensitiveValues: readonly string[]): void {
  for (const sensitiveValue of sensitiveValues) {
    expect(error.message).not.toContain(sensitiveValue);
    expect(JSON.stringify(error.failure)).not.toContain(sensitiveValue);
  }
}

function expectSafeFailureForFixture(
  error: SourceFailureError,
  fixture: SessionSourceContractFixture,
): void {
  expectSafeFailure(error, [...fixture.sensitiveValues, ...(fixture.failureSensitiveValues ?? [])]);
}

type OwnershipAssertion = (
  fixture: SessionSourceContractFixture,
  expectedInput: ExpectedSourceInput,
  candidate: DiscoveredSession,
  frozenDocument: SessionDocument,
) => Promise<void>;

const ownershipAssertions: Readonly<Record<SourceInputOwnership, OwnershipAssertion>> = {
  live: expectLiveInputChange,
  "snapshot-owned": expectSnapshotOwnedInputChange,
};

async function expectLiveInputChange(
  fixture: SessionSourceContractFixture,
  _expectedInput: ExpectedSourceInput,
  candidate: DiscoveredSession,
): Promise<void> {
  const error = await captureSourceFailure(() => readSessionDocument(fixture.source, candidate));
  expect(error.failure.kind).toBe("source-changed");
  expectSafeFailureForFixture(error, fixture);
}

async function expectSnapshotOwnedInputChange(
  fixture: SessionSourceContractFixture,
  expectedInput: ExpectedSourceInput,
  candidate: DiscoveredSession,
  frozenDocument: SessionDocument,
): Promise<void> {
  await expect(readSessionDocument(fixture.source, candidate)).resolves.toEqual(frozenDocument);
  await expectSnapshotChangeOnNextDiscovery(fixture, expectedInput, candidate);
}

async function expectSnapshotChangeOnNextDiscovery(
  fixture: SessionSourceContractFixture,
  expectedInput: ExpectedSourceInput,
  staleCandidate: DiscoveredSession,
): Promise<void> {
  const refreshed = requireCandidate(await discover(fixture), expectedInput.identity);

  expect(refreshed.inputs[expectedInput.inputIndex]?.fingerprint).not.toBe(
    staleCandidate.inputs[expectedInput.inputIndex]?.fingerprint,
  );
  const error = await captureSourceFailure(() =>
    readSessionDocument(fixture.source, staleCandidate),
  );
  expect(error.failure.kind).toBe("source-changed");
  expectSafeFailureForFixture(error, fixture);
}

async function captureSourceFailure(action: () => Promise<unknown>): Promise<SourceFailureError> {
  try {
    await action();
  } catch (error) {
    if (!isSourceFailureError(error)) throw error;
    return error;
  }
  throw new Error("Expected source failure");
}
