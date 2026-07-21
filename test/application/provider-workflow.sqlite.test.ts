import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, readlink, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCodexSource } from "../../src/adapters/codex/source.ts";
import { createCursorSource } from "../../src/adapters/cursor/source.ts";
import type { SourceProbe } from "../../src/application/ports/session-source.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import type { SessionDocument, SessionIdentity, SourceInstance } from "../../src/domain/session.ts";
import {
  PROVIDER_WORKFLOW_SHARED_TEXT,
  registerProviderWorkflowContract,
  type ProviderWorkflowFixture,
} from "../contracts/provider-workflow.contract.ts";
import {
  codexRolloutRecords,
  createCodexSourceFixture,
  type CodexFixtureThread,
} from "../fixtures/codex/source.ts";
import {
  createCursorSourceFixture,
  snapshotCursorProviderTree,
} from "../fixtures/cursor/source.ts";
import { createFakeIndexingSource } from "../fixtures/indexing-source.ts";

const TARGET_ID = "acceptance-target";
const RELATED_ID = "acceptance-root";
const TARGET_ROLLOUT = `sessions/rollout-2026-${TARGET_ID}.jsonl`;
const RELATED_ROLLOUT = `sessions/rollout-2026-${RELATED_ID}.jsonl`;
const CHANGED_TEXT = "Changed provider acceptance evidence";
const RECOVERED_TEXT = "Recovered provider acceptance evidence";
const CURSOR_TARGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CURSOR_RELATED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

registerProviderWorkflowContract("Codex", createCodexWorkflowFixture);
registerProviderWorkflowContract("Cursor", createCursorWorkflowFixture);
registerProviderWorkflowContract("synthetic third adapter", createThirdWorkflowFixture);

async function createCodexWorkflowFixture(): Promise<ProviderWorkflowFixture> {
  const fixture = await createCodexSourceFixture();
  await Promise.all([
    fixture.writeRollout(
      TARGET_ROLLOUT,
      codexRolloutRecords(TARGET_ID, PROVIDER_WORKFLOW_SHARED_TEXT),
    ),
    fixture.writeRollout(
      RELATED_ROLLOUT,
      codexRolloutRecords(RELATED_ID, PROVIDER_WORKFLOW_SHARED_TEXT),
    ),
  ]);
  writeCodexState(fixture.writeState, codexThreads());
  const selected = await createCodexSource(fixture.environment);
  const unavailableState = `${fixture.stateDatabase}.unavailable`;

  return {
    root: fixture.root,
    selected,
    targetIdentity: identity(selected.instance, TARGET_ID),
    relatedIdentity: identity(selected.instance, RELATED_ID),
    expectedLineageCoverage: "complete",
    expectedDocumentDigests: {
      initial: "329fe761b18dcf51c642799cd81a47f086d6ae462148ecb1a6f288ca96dee4fc",
      changed: "351097d10f18d21f31b21fff52cf6a2fe4bf2e4824161cafba57228a2f2f6d55",
    },
    expectedSupport: {
      occurrences: 2,
      uniqueContent: 1,
      uniqueKnownRoots: 2,
      unknownLineageSessions: 0,
    },
    snapshotProvider: () => snapshotProviderTree(fixture.codexHome),
    async changeTarget(): Promise<void> {
      await fixture.writeRollout(TARGET_ROLLOUT, codexRolloutRecords(TARGET_ID, CHANGED_TEXT));
      writeCodexState(fixture.writeState, codexThreads(4_000));
    },
    omitTarget(): void {
      writeCodexState(fixture.writeState, codexThreads(4_000, false));
    },
    restoreTarget(): void {
      writeCodexState(fixture.writeState, codexThreads(4_000));
    },
    async makeUnavailable(): Promise<void> {
      await rename(fixture.stateDatabase, unavailableState);
    },
    async makeAvailable(): Promise<void> {
      await rename(unavailableState, fixture.stateDatabase);
    },
    async makeTargetMalformed(): Promise<void> {
      await fixture.writeRollout(TARGET_ROLLOUT, "not-json\n");
    },
    async recoverTarget(): Promise<void> {
      await fixture.writeRollout(TARGET_ROLLOUT, codexRolloutRecords(TARGET_ID, RECOVERED_TEXT));
    },
    dispose: () => fixture.dispose(),
  };
}

async function createCursorWorkflowFixture(): Promise<ProviderWorkflowFixture> {
  const fixture = await createCursorSourceFixture({ ready: false });
  const [targetTranscript] = await Promise.all([
    fixture.writeJsonlTranscript({ nativeId: CURSOR_TARGET_ID, bytes: cursorBytes() }),
    fixture.writeJsonlTranscript({ nativeId: CURSOR_RELATED_ID, bytes: cursorBytes() }),
  ]);
  const selected = await createCursorSource(fixture.environment);
  const unavailableHome = `${fixture.cursorHome}.unavailable`;
  const targetTranscriptDirectory = path.dirname(targetTranscript);
  const omittedTranscriptDirectory = path.join(fixture.root, "omitted-target");

  return {
    root: fixture.root,
    selected,
    targetIdentity: identity(selected.instance, CURSOR_TARGET_ID),
    relatedIdentity: identity(selected.instance, CURSOR_RELATED_ID),
    expectedLineageCoverage: "unknown",
    expectedDocumentDigests: {
      initial: "ec7753927c4079f95e677cda7a0c356ae23db15ffc1c085a3b2c0c654502f493",
      changed: "8950cef6f12c4ca83d618858d5fff42f02cbd4abb7963801112ec0b616c70ad2",
    },
    expectedSupport: {
      occurrences: 2,
      uniqueContent: 1,
      uniqueKnownRoots: 0,
      unknownLineageSessions: 2,
    },
    snapshotProvider: () => snapshotCursorProviderTree(fixture.cursorHome),
    async changeTarget(): Promise<void> {
      await fixture.writeJsonlTranscript({
        nativeId: CURSOR_TARGET_ID,
        bytes: cursorBytes(CHANGED_TEXT),
      });
    },
    async omitTarget(): Promise<void> {
      await rename(targetTranscriptDirectory, omittedTranscriptDirectory);
    },
    async restoreTarget(): Promise<void> {
      await rename(omittedTranscriptDirectory, targetTranscriptDirectory);
    },
    async makeUnavailable(): Promise<void> {
      await rename(fixture.cursorHome, unavailableHome);
    },
    async makeAvailable(): Promise<void> {
      await rename(unavailableHome, fixture.cursorHome);
    },
    async makeTargetMalformed(): Promise<void> {
      await fixture.writeJsonlTranscript({ nativeId: CURSOR_TARGET_ID, bytes: "not-json\n" });
    },
    async recoverTarget(): Promise<void> {
      await fixture.writeJsonlTranscript({
        nativeId: CURSOR_TARGET_ID,
        bytes: cursorBytes(RECOVERED_TEXT),
      });
    },
    dispose: () => fixture.dispose(),
  };
}

async function createThirdWorkflowFixture(): Promise<ProviderWorkflowFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-third-workflow-"));
  const instance: SourceInstance = { kind: "synthetic-third", instanceId: "acceptance" };
  const source = createFakeIndexingSource(instance);
  const targetIdentity = identity(instance, TARGET_ID);
  const relatedIdentity = identity(instance, RELATED_ID);
  let targetRevision = "target-v1";
  let targetText = PROVIDER_WORKFLOW_SHARED_TEXT;
  let targetPresent = true;
  let available = true;
  let malformed = false;

  const synchronize = (): void => {
    const target = source.candidate(TARGET_ID, targetRevision, "synthetic-third-v1");
    const related = source.candidate(RELATED_ID, "related-v1", "synthetic-third-v1");
    source.setDiscovery(targetPresent ? [target, related] : [related]);
    source.setDocument(TARGET_ID, syntheticDocument(targetIdentity, targetText));
    source.setDocument(
      RELATED_ID,
      syntheticDocument(relatedIdentity, PROVIDER_WORKFLOW_SHARED_TEXT),
    );
    source.setProbe(available ? readyProbe(instance) : unavailableProbe(instance));
    if (malformed) source.failRead(TARGET_ID, "malformed");
    else source.clearReadFailure(TARGET_ID);
  };
  const snapshot = (): string =>
    JSON.stringify({ targetRevision, targetText, targetPresent, available, malformed });
  synchronize();

  return {
    root,
    selected: source.selected,
    targetIdentity,
    relatedIdentity,
    expectedLineageCoverage: "unknown",
    expectedDocumentDigests: {
      initial: "ec7753927c4079f95e677cda7a0c356ae23db15ffc1c085a3b2c0c654502f493",
      changed: "8950cef6f12c4ca83d618858d5fff42f02cbd4abb7963801112ec0b616c70ad2",
    },
    expectedSupport: {
      occurrences: 2,
      uniqueContent: 1,
      uniqueKnownRoots: 0,
      unknownLineageSessions: 2,
    },
    snapshotProvider: snapshot,
    changeTarget(): void {
      targetRevision = "target-v2";
      targetText = CHANGED_TEXT;
      synchronize();
    },
    omitTarget(): void {
      targetPresent = false;
      synchronize();
    },
    restoreTarget(): void {
      targetPresent = true;
      synchronize();
    },
    makeUnavailable(): void {
      available = false;
      synchronize();
    },
    makeAvailable(): void {
      available = true;
      synchronize();
    },
    makeTargetMalformed(): void {
      targetRevision = "target-v3-malformed";
      malformed = true;
      synchronize();
    },
    recoverTarget(): void {
      targetRevision = "target-v4";
      targetText = RECOVERED_TEXT;
      malformed = false;
      synchronize();
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function codexThreads(
  targetUpdatedAtMs = 2_000,
  includeTarget = true,
): readonly CodexFixtureThread[] {
  const related: CodexFixtureThread = {
    id: RELATED_ID,
    rolloutPath: RELATED_ROLLOUT,
    title: "Acceptance root",
    workspace: "/synthetic/provider-workflow",
    createdAtMs: 1_000,
    updatedAtMs: 2_500,
  };
  const target: CodexFixtureThread = {
    id: TARGET_ID,
    rolloutPath: TARGET_ROLLOUT,
    title: "Acceptance target",
    workspace: "/synthetic/provider-workflow",
    createdAtMs: 1_500,
    updatedAtMs: targetUpdatedAtMs,
  };
  return includeTarget ? [target, related] : [related];
}

function writeCodexState(
  write: (threads: readonly CodexFixtureThread[]) => void,
  threads: readonly CodexFixtureThread[],
): void {
  write(threads);
}

function cursorBytes(text = PROVIDER_WORKFLOW_SHARED_TEXT): string {
  return `${JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } })}\n`;
}

function syntheticDocument(identityValue: SessionIdentity, text: string): SessionDocument {
  return {
    identity: identityValue,
    lineageCoverage: "unknown",
    relations: [],
    entries: [
      {
        ordinal: 0,
        kind: "message",
        actor: "human",
        sourceLocator: { uri: `memory://synthetic-third/${identityValue.nativeId}` },
        content: [
          {
            ordinal: 0,
            kind: "text",
            text,
            contentHash: hashContent(text),
            origin: "human",
            originConfidence: "high",
            sourceMetadata: { fixture: "provider-workflow" },
          },
        ],
      },
    ],
  };
}

function readyProbe(source: SourceInstance): SourceProbe {
  return {
    source,
    status: "ready",
    locations: [{ role: "root", locator: { uri: "memory://synthetic-third" } }],
    summary: "Synthetic third source is ready",
  };
}

function unavailableProbe(source: SourceInstance): SourceProbe {
  return {
    source,
    status: "unavailable",
    locations: [{ role: "root", locator: { uri: "memory://synthetic-third" } }],
    summary: "Synthetic third source is unavailable",
  };
}

function identity(source: SourceInstance, nativeId: string): SessionIdentity {
  return { source, nativeId };
}

interface ProviderNodeSnapshot {
  readonly type: "directory" | "file" | "symlink" | "other";
  readonly mode: string;
  readonly size: string;
  readonly sha256?: string;
  readonly target?: string;
}

async function snapshotProviderTree(
  root: string,
): Promise<Readonly<Record<string, ProviderNodeSnapshot>>> {
  const nodes: Record<string, ProviderNodeSnapshot> = {};
  await visitProviderNode(root, root, nodes);
  return nodes;
}

async function visitProviderNode(
  root: string,
  file: string,
  nodes: Record<string, ProviderNodeSnapshot>,
): Promise<void> {
  const stats = await lstat(file, { bigint: true });
  const relative = path.relative(root, file) || ".";
  const common = { mode: stats.mode.toString(10), size: stats.size.toString(10) };
  if (stats.isDirectory()) {
    nodes[relative] = { type: "directory", ...common };
    for (const entry of (await readdir(file)).sort()) {
      await visitProviderNode(root, path.join(file, entry), nodes);
    }
    return;
  }
  if (stats.isFile()) {
    nodes[relative] = {
      type: "file",
      ...common,
      sha256: createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    };
    return;
  }
  if (stats.isSymbolicLink()) {
    nodes[relative] = { type: "symlink", ...common, target: await readlink(file) };
    return;
  }
  nodes[relative] = { type: "other", ...common };
}
