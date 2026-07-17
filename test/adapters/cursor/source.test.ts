import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  DiscoveredSession,
  SessionSource,
} from "../../../src/application/ports/session-source.ts";
import {
  isSourceFailureError,
  type SourceFailureError,
} from "../../../src/application/source-failure.ts";
import { createCursorSource, CURSOR_ADAPTER_VERSION } from "../../../src/adapters/cursor/source.ts";
import type { SessionDocument } from "../../../src/domain/session.ts";
import {
  createCursorSourceFixture,
  CURSOR_AGENT_NATIVE_ID,
  CURSOR_AGENT_TITLE,
  CURSOR_CHAT_NATIVE_ID,
  CURSOR_CHAT_TITLE,
  snapshotCursorProviderTree,
  type CursorSourceFixture,
} from "../../fixtures/cursor/source.ts";

const fixtures: CursorSourceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("Cursor source adapter", () => {
  test("discovers and reads both supported families without mutating provider state", async () => {
    const fixture = await createFixture();
    const before = snapshotCursorProviderTree(fixture.cursorHome);
    const selected = await createCursorSource(fixture.environment);

    const candidates = await discover(selected.adapter, fixture);
    const documents = await Promise.all(
      candidates.map((candidate) => selected.adapter.read(candidate, fixture.workspace)),
    );

    expect(candidates.map(({ identity }) => identity.nativeId)).toEqual([
      CURSOR_CHAT_NATIVE_ID,
      CURSOR_AGENT_NATIVE_ID,
    ]);
    expect(
      candidates.every(({ adapterVersion }) => adapterVersion === CURSOR_ADAPTER_VERSION),
    ).toBe(true);
    expect(document(documents, CURSOR_CHAT_NATIVE_ID)).toMatchObject({
      title: CURSOR_CHAT_TITLE,
      workspace: "/synthetic/cursor-workspace",
      createdAt: "2026-07-16T10:00:00.000Z",
      updatedAt: "2026-07-16T10:05:00.000Z",
      lineageCoverage: "unknown",
      relations: [],
      entries: [
        { ordinal: 0, actor: "human", kind: "message" },
        { ordinal: 1, actor: "model", kind: "message" },
        { ordinal: 2, actor: "model", kind: "tool-call" },
        { ordinal: 3, actor: "tool", kind: "tool-result", relatedEntryOrdinal: 2 },
      ],
    });
    expect(document(documents, CURSOR_AGENT_NATIVE_ID)).toMatchObject({
      title: CURSOR_AGENT_TITLE,
      createdAt: "2026-07-16T10:00:00.000Z",
      updatedAt: "2026-07-16T10:05:00.000Z",
      lineageCoverage: "unknown",
      relations: [],
    });
    expect(document(documents, CURSOR_AGENT_NATIVE_ID)).not.toHaveProperty("workspace");
    expect(JSON.stringify(documents)).not.toContain(fixture.cursorHome);
    expect(snapshotCursorProviderTree(fixture.cursorHome)).toBe(before);
  });

  test("keeps snapshot-owned metadata frozen until the next discovery", async () => {
    const fixture = await createFixture();
    const selected = await createCursorSource(fixture.environment);
    const first = candidate(await discover(selected.adapter, fixture), CURSOR_CHAT_NATIVE_ID);
    fixture.mutateChatMetadata();

    await expect(selected.adapter.read(first, fixture.workspace)).resolves.toMatchObject({
      title: CURSOR_CHAT_TITLE,
    });

    const second = candidate(await discover(selected.adapter, fixture), CURSOR_CHAT_NATIVE_ID);
    expect(second.aggregateFingerprint).not.toEqual(first.aggregateFingerprint);
    await expect(selected.adapter.read(second, fixture.workspace)).resolves.toMatchObject({
      title: `${CURSOR_CHAT_TITLE} 1`,
    });
    await expect(selected.adapter.read(first, fixture.workspace)).rejects.toMatchObject({
      failure: { kind: "source-changed" },
    });
  });

  test("maps deferred-only state and conflicting store identity to safe typed failures", async () => {
    const deferredFixture = await createFixture({ ready: false });
    await mkdir(
      join(deferredFixture.cursorHome, "projects", "generic-project", "agent-transcripts"),
      { recursive: true },
    );
    const deferred = await createCursorSource(deferredFixture.environment);
    const unsupported = await captureFailure(() => discover(deferred.adapter, deferredFixture));
    expect(unsupported.failure.kind).toBe("unsupported-format");
    expectSafe(unsupported, deferredFixture);

    const conflictFixture = await createFixture();
    conflictFixture.writeChatStore({ nativeId: "conflicting-private-identity" });
    const conflict = await createCursorSource(conflictFixture.environment);
    const chat = candidate(
      await discover(conflict.adapter, conflictFixture),
      CURSOR_CHAT_NATIVE_ID,
    );
    const malformed = await captureFailure(() =>
      conflict.adapter.read(chat, conflictFixture.workspace),
    );
    expect(malformed.failure.kind).toBe("malformed");
    expectSafe(malformed, conflictFixture);
    expect(malformed.message).not.toContain("conflicting-private-identity");
  });

  test.each([
    [
      "chat metadata drift",
      async (fixture: CursorSourceFixture) => {
        await writeFile(
          fixture.chatMetadata,
          JSON.stringify({
            schemaVersion: 2,
            createdAtMs: Date.parse("2026-07-16T10:00:00.000Z"),
            updatedAtMs: Date.parse("2026-07-16T10:05:00.000Z"),
            hasConversation: true,
          }),
        );
      },
    ],
    [
      "catalog checkpoint drift",
      async (fixture: CursorSourceFixture) => {
        fixture.writeAgentCatalog({
          checkpoint: {
            blobId: "20".repeat(32),
            storeKind: "future-agent-store",
          },
        });
      },
    ],
  ])("maps %s to a typed unsupported-format source failure", async (_name, mutate) => {
    const fixture = await createFixture();
    await mutate(fixture);
    const selected = await createCursorSource(fixture.environment);

    const unsupported = await captureFailure(() => discover(selected.adapter, fixture));

    expect(unsupported.failure.kind).toBe("unsupported-format");
    expectSafe(unsupported, fixture);
  });
});

async function createFixture(options?: { readonly ready?: boolean }): Promise<CursorSourceFixture> {
  const fixture = await createCursorSourceFixture(options);
  fixtures.push(fixture);
  return fixture;
}

async function discover(
  source: SessionSource,
  fixture: CursorSourceFixture,
): Promise<readonly DiscoveredSession[]> {
  const candidates: DiscoveredSession[] = [];
  for await (const candidate of source.discover(fixture.workspace)) {
    candidates.push(candidate);
  }
  return candidates;
}

function candidate(candidates: readonly DiscoveredSession[], nativeId: string): DiscoveredSession {
  const value = candidates.find(({ identity }) => identity.nativeId === nativeId);
  if (value === undefined) throw new Error("Expected Cursor candidate");
  return value;
}

function document(documents: readonly SessionDocument[], nativeId: string): SessionDocument {
  const value = documents.find(({ identity }) => identity.nativeId === nativeId);
  if (value === undefined) throw new Error("Expected Cursor document");
  return value;
}

async function captureFailure(action: () => Promise<unknown>): Promise<SourceFailureError> {
  try {
    await action();
  } catch (error) {
    if (isSourceFailureError(error)) return error;
    throw error;
  }
  throw new Error("Expected Cursor source failure");
}

function expectSafe(error: SourceFailureError, fixture: CursorSourceFixture): void {
  expect(error.message).not.toContain(fixture.cursorHome);
  expect(JSON.stringify(error.failure)).not.toContain(fixture.cursorHome);
}
