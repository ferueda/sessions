import { expect, test } from "vitest";

import type {
  IndexRunCounts,
  IndexRunResult,
  SessionIndexRun,
  SessionIndexWriter,
} from "../../src/application/ports/session-index.ts";
import { createDiscoveredSession } from "../../src/application/source-input-fingerprint.ts";
import {
  admitSessionObservation,
  admitSessionReplacement,
  type SessionObservation,
  type ValidatedSessionReplacement,
} from "../../src/application/validate-session.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import type {
  SessionDocument,
  SessionEntry,
  SessionIdentity,
  SourceInstance,
} from "../../src/domain/session.ts";

export interface SessionIndexContractFixture {
  readonly index: SessionIndexWriter;
  close(): Promise<void>;
}

export function runSessionIndexContract(
  createFixture: () => Promise<SessionIndexContractFixture> | SessionIndexContractFixture,
): void {
  test("round-trips complete and minimal documents while isolating source instances", async () => {
    const fixture = await createFixture();
    try {
      const firstIdentity = identity("profile-one", "same-native-id");
      const secondIdentity = identity("profile-two", "same-native-id");
      const first = replacement(firstIdentity, "revision-a", completeDocument(firstIdentity));
      const second = replacement(secondIdentity, "revision-a", minimalDocument(secondIdentity));
      const firstRun = await fixture.index.startRun(runInput(firstIdentity.source));
      const secondRun = await fixture.index.startRun(runInput(secondIdentity.source));

      await fixture.index.replaceSession(firstRun, first);
      await fixture.index.replaceSession(secondRun, second);

      await expect(fixture.index.getDocument(firstIdentity)).resolves.toEqual(first.document);
      await expect(fixture.index.getDocument(secondIdentity)).resolves.toEqual(second.document);
      await expect(fixture.index.getSummary(firstIdentity)).resolves.toEqual({
        identity: firstIdentity,
        title: "Adversarial ' title",
        workspace: "/workspace/one",
        createdAt: "2026-07-13T12:00:00.000Z",
        updatedAt: "2026-07-13T12:01:00.000Z",
        freshness: "current",
      });
      await expect(fixture.index.getSummary(secondIdentity)).resolves.toEqual({
        identity: secondIdentity,
        freshness: "current",
      });

      await finishCompleted(fixture.index, firstRun, counts({ discovered: 1, updated: 1 }));
      await finishCompleted(fixture.index, secondRun, counts({ discovered: 1, updated: 1 }));
    } finally {
      await fixture.close();
    }
  });

  test("preserves last-good content across failures and returns to current when unchanged", async () => {
    const fixture = await createFixture();
    try {
      const sessionIdentity = identity("profile-one", "freshness-session");
      const firstObservation = observation(sessionIdentity, "revision-a");
      const changedObservation = observation(sessionIdentity, "revision-b");
      const baseline = admittedReplacement(firstObservation, completeDocument(sessionIdentity));
      const initialRun = await fixture.index.startRun(runInput(sessionIdentity.source));
      await fixture.index.replaceSession(initialRun, baseline);
      await finishCompleted(fixture.index, initialRun, counts({ discovered: 1, updated: 1 }));

      const failedRun = await fixture.index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T13:00:00.000Z",
      });
      await fixture.index.recordFailure(failedRun, changedObservation, "source-changed");

      await expect(fixture.index.getFreshness(sessionIdentity)).resolves.toEqual({
        status: "stale",
        identity: sessionIdentity,
        lastGood: firstObservation.revision,
        latest: {
          outcome: "failed",
          revision: changedObservation.revision,
          failure: "source-changed",
        },
      });
      await expect(fixture.index.getDocument(sessionIdentity)).resolves.toEqual(baseline.document);
      await finishCompleted(
        fixture.index,
        failedRun,
        counts({ discovered: 1, failed: 1, stale: 1 }),
      );

      const unchangedRun = await fixture.index.startRun({
        source: sessionIdentity.source,
        startedAt: "2026-07-13T14:00:00.000Z",
      });
      await expect(
        fixture.index.recordUnchanged(unchangedRun, changedObservation),
      ).rejects.toMatchObject({ code: "invalid-state" });
      await fixture.index.recordUnchanged(unchangedRun, firstObservation);
      await expect(fixture.index.getFreshness(sessionIdentity)).resolves.toEqual({
        status: "current",
        identity: sessionIdentity,
        lastGood: firstObservation.revision,
        latest: { outcome: "unchanged", revision: firstObservation.revision },
      });
      await finishCompleted(fixture.index, unchangedRun, counts({ discovered: 1, unchanged: 1 }));
    } finally {
      await fixture.close();
    }
  });

  test("tracks failed first observations and removes canonical content without losing identity", async () => {
    const fixture = await createFixture();
    try {
      const failedIdentity = identity("profile-one", "never-indexed");
      const failedObservation = observation(failedIdentity, "revision-a");
      const failedRun = await fixture.index.startRun(runInput(failedIdentity.source));
      await fixture.index.recordFailure(failedRun, failedObservation, "malformed");
      await expect(fixture.index.getFreshness(failedIdentity)).resolves.toEqual({
        status: "unindexed",
        identity: failedIdentity,
        latest: {
          outcome: "failed",
          revision: failedObservation.revision,
          failure: "malformed",
        },
      });
      await expect(fixture.index.getDocument(failedIdentity)).resolves.toBeUndefined();
      await finishCompleted(fixture.index, failedRun, counts({ discovered: 1, failed: 1 }));

      const indexedIdentity = identity("profile-one", "removed-session");
      const indexed = replacement(indexedIdentity, "revision-a", minimalDocument(indexedIdentity));
      const indexRun = await fixture.index.startRun({
        source: indexedIdentity.source,
        startedAt: "2026-07-13T13:00:00.000Z",
      });
      await fixture.index.replaceSession(indexRun, indexed);
      await fixture.index.removeSession(indexRun, indexedIdentity);
      await expect(fixture.index.getFreshness(indexedIdentity)).resolves.toEqual({
        status: "removed",
        identity: indexedIdentity,
        latest: { outcome: "removed" },
      });
      await expect(fixture.index.getDocument(indexedIdentity)).resolves.toBeUndefined();
      await expect(fixture.index.getSummary(indexedIdentity)).resolves.toBeUndefined();
      await fixture.index.replaceSession(indexRun, indexed);
      await expect(fixture.index.getFreshness(indexedIdentity)).resolves.toEqual({
        status: "current",
        identity: indexedIdentity,
        lastGood: indexed.observation.revision,
        latest: { outcome: "indexed", revision: indexed.observation.revision },
      });
      await expect(fixture.index.getDocument(indexedIdentity)).resolves.toEqual(indexed.document);
      const result = await finishCompleted(
        fixture.index,
        indexRun,
        counts({ discovered: 2, updated: 2, removed: 1 }),
      );
      expect(result.items).toEqual([{ identity: indexedIdentity, outcome: "removed" }]);
    } finally {
      await fixture.close();
    }
  });
}

export function identity(instanceId: string, nativeId: string): SessionIdentity {
  return { source: { kind: "synthetic", instanceId }, nativeId };
}

export function observation(
  sessionIdentity: SessionIdentity,
  revisionSeed: string,
): SessionObservation {
  const candidate = createDiscoveredSession({
    identity: sessionIdentity,
    inputs: [
      {
        role: "transcript",
        locator: { uri: `memory://${sessionIdentity.nativeId}` },
        fingerprint: revisionSeed,
      },
    ],
    adapterVersion: "synthetic-v1",
  });
  const result = admitSessionObservation(candidate);
  if (!result.ok) throw new Error("Synthetic observation must be admitted");
  return result.observation;
}

export function replacement(
  sessionIdentity: SessionIdentity,
  revisionSeed: string,
  document: SessionDocument,
): ValidatedSessionReplacement {
  return admittedReplacement(observation(sessionIdentity, revisionSeed), document);
}

export function admittedReplacement(
  admittedObservation: SessionObservation,
  document: SessionDocument,
): ValidatedSessionReplacement {
  const result = admitSessionReplacement(admittedObservation, document);
  if (!result.ok) throw new Error("Synthetic replacement must be admitted");
  return result.replacement;
}

export function minimalDocument(sessionIdentity: SessionIdentity): SessionDocument {
  return { identity: sessionIdentity, relations: [], entries: [] };
}

export function completeDocument(sessionIdentity: SessionIdentity): SessionDocument {
  const firstText = "old searchable token; quote='; delimiter=@:\nNUL:\0";
  const secondText = "second ordered segment";
  return {
    identity: sessionIdentity,
    title: "Adversarial ' title",
    workspace: "/workspace/one",
    createdAt: "2026-07-13T12:00:00.000Z",
    updatedAt: "2026-07-13T12:01:00.000Z",
    relations: [
      {
        kind: "parent",
        target: identity("unindexed-parent", "parent"),
        confidence: "high",
      },
      {
        kind: "fork",
        target: identity("unindexed-parent", "fork"),
        confidence: "low",
      },
    ],
    entries: [
      entry(0, firstText, { relatedEntryOrdinal: 1, metadata: { "10": "ten", "2": "two" } }),
      entry(1, secondText, {
        relatedEntryOrdinal: 0,
        metadata: { quote: "'\"" },
        includeOptionals: false,
      }),
    ],
  };
}

export function entry(
  ordinal: number,
  text: string,
  options: {
    readonly relatedEntryOrdinal?: number;
    readonly metadata?: Readonly<Record<string, string>>;
    readonly includeOptionals?: boolean;
  } = {},
): SessionEntry {
  const includeOptionals = options.includeOptionals ?? true;
  return {
    ordinal,
    kind: "message",
    actor: ordinal === 0 ? "human" : "model",
    ...(includeOptionals ? { timestamp: `2026-07-13T12:00:0${ordinal}.000Z` } : {}),
    ...(options.relatedEntryOrdinal === undefined
      ? {}
      : { relatedEntryOrdinal: options.relatedEntryOrdinal }),
    ...(includeOptionals ? { toolCallId: `tool:${ordinal}` } : {}),
    sourceLocator: {
      uri: `memory://entry/${ordinal}`,
      ...(includeOptionals ? { recordId: `row:${ordinal}` } : {}),
    },
    content: [
      {
        ordinal: 0,
        text,
        contentHash: hashContent(text),
        origin: ordinal === 0 ? "human" : "model",
        originConfidence: "high",
        sourceMetadata: options.metadata ?? {},
      },
    ],
  };
}

export function counts(overrides: Partial<IndexRunCounts> = {}): IndexRunCounts {
  return {
    discovered: 0,
    unchanged: 0,
    updated: 0,
    failed: 0,
    removed: 0,
    stale: 0,
    ...overrides,
  };
}

export async function finishCompleted(
  index: SessionIndexWriter,
  run: SessionIndexRun,
  expectedCounts: IndexRunCounts,
): Promise<IndexRunResult> {
  const result = await index.finishRun(run, {
    status: "completed",
    finishedAt: "2026-07-13T15:00:00.000Z",
  });
  expect(result.status).toBe("completed");
  expect(result.counts).toEqual(expectedCounts);
  return result;
}

function runInput(source: SourceInstance): {
  readonly source: SourceInstance;
  readonly startedAt: string;
} {
  return { source, startedAt: "2026-07-13T12:00:00.000Z" };
}
