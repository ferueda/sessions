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

export interface ExpectedSourceInput {
  readonly identity: SessionIdentity;
  readonly inputIndex: number;
  readonly descriptor: Pick<SourceInputDescriptor, "role" | "locator">;
}

export interface SessionSourceContractFixture {
  readonly source: SessionSource;
  readonly sourceInstance: SourceInstance;
  readonly identities: readonly SessionIdentity[];
  readonly primaryIdentity: SessionIdentity;
  readonly missingMetadataIdentity: SessionIdentity;
  readonly repeatedText: string;
  readonly expectedInputs: readonly ExpectedSourceInput[];
  readonly sensitiveValues: readonly string[];
  snapshotSource(): string;
  contentReadCount(): number;
  mutateInput(identity: SessionIdentity, inputIndex: number): void;
  mutateDuringNextRead(identity: SessionIdentity, inputIndex: number): void;
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
          const error = await captureSourceFailure(() => discover(fixture.source));

          expect(error.failure.kind).toBe(scenario);
          expectSafeFailure(error, fixture.sensitiveValues);
        });
      },
    );

    test("discovers deterministic candidates with complete aggregate fingerprints", async () => {
      await withFixture(createFixture, "ready", async (fixture) => {
        const before = fixture.snapshotSource();
        const first = await discover(fixture.source);
        fixture.reverseDiscoveryOrder();
        const second = await discover(fixture.source);

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
      const expectedInputs = await loadExpectedInputs(createFixture);

      for (const expectedInput of expectedInputs) {
        await withFixture(createFixture, "ready", async (fixture) => {
          const before = requireCandidate(await discover(fixture.source), expectedInput.identity);
          fixture.mutateInput(expectedInput.identity, expectedInput.inputIndex);
          const after = requireCandidate(await discover(fixture.source), expectedInput.identity);

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
        const candidates = await discover(fixture.source);
        const first = await readAll(fixture.source, candidates);
        const second = await readAll(fixture.source, [...candidates].reverse());

        expect(documentMap(second)).toEqual(documentMap(first));
        expect(fixture.snapshotSource()).toBe(before);
      });
    });

    test("rejects every input changed before read without returning a document", async () => {
      const expectedInputs = await loadExpectedInputs(createFixture);

      for (const expectedInput of expectedInputs) {
        await withFixture(createFixture, "ready", async (fixture) => {
          const candidate = requireCandidate(
            await discover(fixture.source),
            expectedInput.identity,
          );
          fixture.mutateInput(expectedInput.identity, expectedInput.inputIndex);
          const error = await captureSourceFailure(() =>
            readSessionDocument(fixture.source, candidate),
          );

          expect(error.failure.kind).toBe("source-changed");
          expectSafeFailure(error, fixture.sensitiveValues);
        });
      }
    });

    test("rejects every input changed after it was consumed", async () => {
      const expectedInputs = await loadExpectedInputs(createFixture);

      for (const expectedInput of expectedInputs) {
        await withFixture(createFixture, "ready", async (fixture) => {
          const candidate = requireCandidate(
            await discover(fixture.source),
            expectedInput.identity,
          );
          fixture.mutateDuringNextRead(expectedInput.identity, expectedInput.inputIndex);
          const error = await captureSourceFailure(() =>
            readSessionDocument(fixture.source, candidate),
          );

          expect(error.failure.kind).toBe("source-changed");
          expectSafeFailure(error, fixture.sensitiveValues);
        });
      }
    });

    test("preserves missing metadata and unknown provenance without recurrence inference", async () => {
      await withFixture(createFixture, "ready", async (fixture) => {
        const documents = await readAll(fixture.source, await discover(fixture.source));
        const missing = requireDocument(documents, fixture.missingMetadataIdentity);
        const repeatedSegments = documents.flatMap((document) =>
          document.entries.flatMap((entry) =>
            entry.content.filter((segment) => segment.text === fixture.repeatedText),
          ),
        );

        expect(missing).not.toHaveProperty("title");
        expect(missing).not.toHaveProperty("workspace");
        expect(missing).not.toHaveProperty("createdAt");
        expect(missing).not.toHaveProperty("updatedAt");
        expect(repeatedSegments).toHaveLength(2);
        expect(
          repeatedSegments.map(({ origin, originConfidence }) => ({ origin, originConfidence })),
        ).toEqual([
          { origin: "unknown", originConfidence: "unknown" },
          { origin: "unknown", originConfidence: "unknown" },
        ]);
      });
    });

    test.each(["malformed", "unsupported-format"] as const)(
      "returns a safe typed %s read failure",
      async (scenario) => {
        await withFixture(createFixture, scenario, async (fixture) => {
          const candidate = requireCandidate(
            await discover(fixture.source),
            fixture.primaryIdentity,
          );
          const error = await captureSourceFailure(() =>
            readSessionDocument(fixture.source, candidate),
          );

          expect(error.failure.kind).toBe(scenario);
          expectSafeFailure(error, fixture.sensitiveValues);
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

async function discover(source: SessionSource): Promise<readonly DiscoveredSession[]> {
  const candidates: DiscoveredSession[] = [];
  for await (const candidate of source.discover()) candidates.push(candidate);
  return candidates;
}

async function loadExpectedInputs(
  createFixture: SessionSourceContractFactory,
): Promise<readonly ExpectedSourceInput[]> {
  const fixture = await createFixture("ready");
  try {
    return fixture.expectedInputs.map((input) => ({
      identity: input.identity,
      inputIndex: input.inputIndex,
      descriptor: input.descriptor,
    }));
  } finally {
    await fixture.dispose();
  }
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

async function captureSourceFailure(action: () => Promise<unknown>): Promise<SourceFailureError> {
  try {
    await action();
  } catch (error) {
    if (!isSourceFailureError(error)) throw error;
    return error;
  }
  throw new Error("Expected source failure");
}
