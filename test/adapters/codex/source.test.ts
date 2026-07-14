import { appendFile, mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { isSourceFailureError } from "../../../src/application/source-failure.ts";
import { verifySourceInputFingerprint } from "../../../src/application/source-input-fingerprint.ts";
import type {
  DiscoveredSession,
  SessionSource,
  SourceDiscoveryWorkspace,
} from "../../../src/application/ports/session-source.ts";
import { CODEX_ADAPTER_VERSION, createCodexSource } from "../../../src/adapters/codex/source.ts";
import {
  codexRolloutRecords,
  createCodexSourceFixture,
  type CodexSourceFixture,
} from "../../fixtures/codex/source.ts";

const fixtures: CodexSourceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe("Codex session source", () => {
  test("probes canonical roots and distinguishes unavailable from unreadable", async () => {
    const fixture = await createFixture();
    const selected = await createCodexSource(fixture.environment);

    await expect(selected.adapter.probe()).resolves.toMatchObject({
      source: selected.instance,
      status: "unavailable",
      locations: [
        { role: "codex-home", locator: { uri: expect.stringMatching(/^file:/u) } },
        { role: "sqlite-home", locator: { uri: expect.stringMatching(/^file:/u) } },
      ],
      summary: "Codex source is unavailable",
    });

    await mkdir(fixture.stateDatabase);
    await expect(selected.adapter.probe()).resolves.toMatchObject({
      status: "unreadable",
      summary: "Codex source is unreadable",
    });
  });

  test("discovers deterministic frozen candidates without reading rollout content", async () => {
    const fixture = await createFixture();
    fixture.writeState([
      thread("thread-b", "sessions/rollout-2026-thread-b.jsonl"),
      thread("thread-a", "sessions/rollout-2026-thread-a.jsonl"),
    ]);
    await fixture.writeRollout("sessions/rollout-2026-thread-a.jsonl", "not-json\n");
    await fixture.writeRollout(
      "sessions/rollout-2026-thread-b.jsonl",
      codexRolloutRecords("thread-b", "Second"),
    );
    const selected = await createCodexSource(fixture.environment);

    const candidates = await discover(selected.adapter, fixture.workspace);

    expect(candidates.map(({ identity }) => identity.nativeId)).toEqual(["thread-a", "thread-b"]);
    for (const candidate of candidates) {
      expect(candidate.inputs.map(({ role }) => role)).toEqual([
        "thread-row",
        "parent-edge",
        "rollout",
      ]);
      expect(candidate.adapterVersion).toBe(CODEX_ADAPTER_VERSION);
      expect(verifySourceInputFingerprint(candidate)).toBe(true);
      expect(Object.isFrozen(candidate)).toBe(true);
    }
    await expect(selected.adapter.read(candidates[0]!)).rejects.toMatchObject({
      failure: { kind: "malformed", source: selected.instance },
      message: "Session source data is malformed",
    });
  });

  test("normalizes a ready rollout with private logical locators and state lineage", async () => {
    const fixture = await createFixture();
    const rolloutPath = "sessions/rollout-2026-child-thread.jsonl";
    fixture.writeState(
      [
        {
          ...thread("child-thread", rolloutPath),
          title: "Synthetic title",
          workspace: "/synthetic/workspace",
          createdAtMs: 1_000,
          updatedAtMs: 2_000,
        },
      ],
      [{ parentId: "parent-thread", childId: "child-thread", status: "ready" }],
    );
    await fixture.writeRollout(
      rolloutPath,
      codexRolloutRecords("child-thread", "Synthetic message", "parent-thread"),
    );
    const selected = await createCodexSource(fixture.environment);
    const [candidate] = await discover(selected.adapter, fixture.workspace);

    const document = await selected.adapter.read(candidate!);

    expect(document).toMatchObject({
      identity: candidate!.identity,
      title: "Synthetic title",
      workspace: "/synthetic/workspace",
      createdAt: "1970-01-01T00:00:01.000Z",
      updatedAt: "1970-01-01T00:00:02.000Z",
      relations: [
        {
          kind: "parent",
          target: { source: selected.instance, nativeId: "parent-thread" },
          confidence: "high",
        },
      ],
    });
    expect(document.entries).toHaveLength(1);
    expect(document.entries[0]?.sourceLocator).toEqual({
      uri: "codex://rollout/rollout-2026-child-thread.jsonl",
      recordId: "1",
    });
    expect(JSON.stringify(document.entries)).not.toContain(fixture.codexHome);
  });

  test("keeps one frozen state generation until the next discovery", async () => {
    const fixture = await createFixture();
    const rolloutPath = "sessions/rollout-2026-thread-one.jsonl";
    fixture.writeState([{ ...thread("thread-one", rolloutPath), title: "First title" }]);
    await fixture.writeRollout(rolloutPath, codexRolloutRecords("thread-one"));
    const selected = await createCodexSource(fixture.environment);
    const [firstCandidate] = await discover(selected.adapter, fixture.workspace);
    fixture.writeState([{ ...thread("thread-one", rolloutPath), title: "Second title" }]);

    await expect(selected.adapter.read(firstCandidate!)).resolves.toMatchObject({
      title: "First title",
    });

    const [secondCandidate] = await discover(selected.adapter, fixture.workspace);
    expect(secondCandidate?.inputs[0]?.fingerprint).not.toBe(
      firstCandidate?.inputs[0]?.fingerprint,
    );
    await expect(selected.adapter.read(secondCandidate!)).resolves.toMatchObject({
      title: "Second title",
    });
    await expect(selected.adapter.read(firstCandidate!)).rejects.toMatchObject({
      failure: { kind: "source-changed" },
    });
  });

  test("returns typed stable failures for missing and invalid rollout descriptors", async () => {
    const fixture = await createFixture();
    fixture.writeState([
      thread("missing-thread", "sessions/rollout-2026-missing-thread.jsonl"),
      thread("invalid-thread", "outside/invalid.txt"),
    ]);
    const selected = await createCodexSource(fixture.environment);
    const candidates = await discover(selected.adapter, fixture.workspace);

    const missing = candidates.find(({ identity }) => identity.nativeId === "missing-thread")!;
    const invalid = candidates.find(({ identity }) => identity.nativeId === "invalid-thread")!;
    await expect(selected.adapter.read(missing)).rejects.toMatchObject({
      failure: { kind: "unavailable" },
    });
    await expect(selected.adapter.read(invalid)).rejects.toMatchObject({
      failure: { kind: "malformed" },
    });
  });

  test("rejects rollout byte and representation changes before returning a document", async () => {
    const fixture = await createFixture();
    const plainPath = "sessions/rollout-2026-plain-thread.jsonl";
    const compressedPath = "sessions/rollout-2026-zstd-thread.jsonl";
    fixture.writeState([thread("plain-thread", plainPath), thread("zstd-thread", compressedPath)]);
    const plainFile = await fixture.writeRollout(plainPath, codexRolloutRecords("plain-thread"));
    await fixture.writeRollout(compressedPath, codexRolloutRecords("zstd-thread"), "zstd");
    const selected = await createCodexSource(fixture.environment);
    const candidates = await discover(selected.adapter, fixture.workspace);
    await appendFile(plainFile, " ");
    await fixture.writeRollout(compressedPath, codexRolloutRecords("zstd-thread"), "plain");

    for (const candidate of candidates) {
      const error = await captureFailure(() => selected.adapter.read(candidate));
      expect(error.failure.kind).toBe("source-changed");
      expect(error.message).not.toContain(fixture.codexHome);
      expect(JSON.stringify(error.failure)).not.toContain(fixture.codexHome);
    }
  });

  test("maps incompatible state schema to a sanitized discovery failure", async () => {
    const fixture = await createFixture();
    const database = new DatabaseSync(fixture.stateDatabase);
    database.exec(`CREATE TABLE unsupported (value TEXT)`);
    database.close();
    const selected = await createCodexSource(fixture.environment);

    const error = await captureFailure(() => discover(selected.adapter, fixture.workspace));

    expect(error).toMatchObject({
      failure: { kind: "unsupported-format", source: selected.instance },
      message: "Session source format is unsupported",
    });
    expect(error.message).not.toContain(fixture.stateDatabase);
  });
});

async function createFixture(): Promise<CodexSourceFixture> {
  const fixture = await createCodexSourceFixture();
  fixtures.push(fixture);
  return fixture;
}

function thread(id: string, rolloutPath: string) {
  return { id, rolloutPath };
}

async function discover(
  source: SessionSource,
  workspace: SourceDiscoveryWorkspace,
): Promise<readonly DiscoveredSession[]> {
  const candidates: DiscoveredSession[] = [];
  for await (const candidate of source.discover(workspace)) candidates.push(candidate);
  return candidates;
}

async function captureFailure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (isSourceFailureError(error)) return error;
    throw error;
  }
  throw new Error("Expected source failure");
}
