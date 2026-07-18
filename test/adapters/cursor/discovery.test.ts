import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  captureCursorFile,
  compareCursorComponents,
  consumeStableCursorFile,
  CursorInventoryChangedError,
  describeCursorEntry,
  listCursorDirectory,
} from "../../../src/adapters/cursor/filesystem.ts";
import {
  cursorAgentStoreDirectory,
  discoverCursorStructure,
  mapCursorDiscovery,
  type MaterializedCursorAgent,
  type MaterializedCursorCatalog,
} from "../../../src/adapters/cursor/discovery.ts";
import {
  captureStableCursorInventory,
  inventoryCursorSource,
} from "../../../src/adapters/cursor/inventory.ts";
import { resolveCursorPaths } from "../../../src/adapters/cursor/paths.ts";
import { syntheticCaptureWorkspace } from "../../fixtures/capture-workspace.ts";

const roots: string[] = [];
const CREATED_MS = Date.parse("2026-07-16T10:00:00.000Z");
const UPDATED_MS = Date.parse("2026-07-16T10:05:00.000Z");
const RICH_JSONL_ID = "agent-11111111-1111-4111-8111-111111111111";
const NONCANDIDATE_JSONL_ID = "agent-22222222-2222-4222-8222-222222222222";
const UNIQUE_JSONL_ID = "agent-33333333-3333-4333-8333-333333333333";
const CHILD_JSONL_ID = "44444444-4444-4444-8444-444444444444";
const DUPLICATE_JSONL_ID = "agent-55555555-5555-4555-8555-555555555555";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Cursor filesystem inventory", () => {
  test("uses binary component order, rejects traversal, and never follows symlinks", async () => {
    const root = await temporaryCursorRoot();
    await Promise.all([
      mkdir(join(root, "names", "z"), { recursive: true }),
      mkdir(join(root, "names", "a"), { recursive: true }),
      mkdir(join(root, "names", "ä"), { recursive: true }),
    ]);
    await symlink(join(root, "names", "a"), join(root, "names", "alias"), "dir");

    const entries = await listCursorDirectory(root, ["names"]);

    expect(entries.map(({ components }) => components.at(-1))).toEqual(["a", "alias", "z", "ä"]);
    expect(entries.find(({ components }) => components.at(-1) === "alias")?.kind).toBe(
      "symbolic-link",
    );
    expect(["a", "z", "ä"].toSorted(compareCursorComponents)).toEqual(["a", "z", "ä"]);
    await expect(describeCursorEntry(root, ["..", "escape"])).rejects.toThrow(TypeError);
  });

  test("captures file bytes with a digest and detects a later inventory mutation", async () => {
    const root = await temporaryCursorRoot();
    await mkdir(join(root, "chats", "scope", "chat-one"), { recursive: true });
    await writeFile(join(root, "chats", "scope", "chat-one", "meta.json"), "{}");
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });

    const captured = await captureCursorFile(root, ["chats", "scope", "chat-one", "meta.json"]);
    expect(captured.descriptor.contentDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(Buffer.from(captured.bytes).toString("utf8")).toBe("{}");

    await expect(
      captureStableCursorInventory(paths, async () => {
        await mkdir(join(root, "projects", "added"), { recursive: true });
      }),
    ).rejects.toBeInstanceOf(CursorInventoryChangedError);
  });

  test("excludes SQLite sidecar names only when the grammar-owned caller requests it", async () => {
    const root = await temporaryCursorRoot();
    await Promise.all([
      mkdir(join(root, "names", "store.db-shm"), { recursive: true }),
      mkdir(join(root, "names", "index.db-shm"), { recursive: true }),
    ]);

    const opaque = await listCursorDirectory(root, ["names"]);
    const storeDirectory = await listCursorDirectory(root, ["names"], {
      excludedNames: new Set(["store.db-shm"]),
    });

    expect(opaque.map(({ components }) => components.at(-1))).toEqual([
      "index.db-shm",
      "store.db-shm",
    ]);
    expect(storeDirectory.map(({ components }) => components.at(-1))).toEqual(["index.db-shm"]);
  });

  test("classifies directory removal during traversal as source change", async () => {
    const root = await temporaryCursorRoot();
    await mkdir(join(root, "names", "one"), { recursive: true });

    await expect(
      listCursorDirectory(root, ["names"], {
        beforeDirectoryRead: async () => {
          await rm(join(root, "names"), { recursive: true });
        },
      }),
    ).rejects.toBeInstanceOf(CursorInventoryChangedError);
  });

  test("classifies metadata removal and replacement before open as source change", async () => {
    const root = await temporaryCursorRoot();
    const components = ["chats", "scope", "chat-one", "meta.json"] as const;
    const metadata = join(root, ...components);
    await mkdir(join(root, "chats", "scope", "chat-one"), { recursive: true });
    await writeFile(metadata, "{}");
    const expected = await describeCursorEntry(root, components);

    await expect(
      captureCursorFile(root, components, expected, {
        beforeFileOpen: async () => {
          await rm(metadata);
        },
      }),
    ).rejects.toBeInstanceOf(CursorInventoryChangedError);

    await writeFile(metadata, "{}");
    const replacementExpected = await describeCursorEntry(root, components);
    await expect(
      captureCursorFile(root, components, replacementExpected, {
        beforeFileOpen: async () => {
          const replacement = join(root, "replacement");
          await writeFile(replacement, "{}");
          await rename(replacement, metadata);
        },
      }),
    ).rejects.toBeInstanceOf(CursorInventoryChangedError);
  });

  test("lets post-read descriptor verification win over a parser failure", async () => {
    const root = await temporaryCursorRoot();
    const components = ["transcript.jsonl"] as const;
    const file = join(root, ...components);
    await writeFile(file, '{"record":1}\n');
    const expected = await describeCursorEntry(root, components);

    await expect(
      consumeStableCursorFile(root, components, expected, async (source) => {
        for await (const _chunk of source) {
          await writeFile(file, '{"record":22}\n');
          throw new Error("synthetic parser failure");
        }
      }),
    ).rejects.toBeInstanceOf(CursorInventoryChangedError);
  });

  test("detects same-size chat metadata replacement between inventories", async () => {
    const root = await temporaryCursorRoot();
    await writeChat(root, "scope", "chat-one", { title: "one" });
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });

    await expect(
      captureStableCursorInventory(paths, async () => {
        await writeChat(root, "scope", "chat-one", { title: "two" });
      }),
    ).rejects.toBeInstanceOf(CursorInventoryChangedError);
  });

  test("includes exact JSONL descendants in stable inventory fingerprints", async () => {
    const root = await temporaryCursorRoot();
    const transcript = await writeAgentTranscript(root, "project", UNIQUE_JSONL_ID);
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });
    const first = await inventoryCursorSource(paths);

    await writeFile(transcript, '{"role":"user"}');
    const second = await inventoryCursorSource(paths);

    expect(first.agentTranscripts).toHaveLength(1);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});

describe("Cursor structural discovery", () => {
  test("traverses only the exact grammar and preserves binary candidate order", async () => {
    const root = await temporaryCursorRoot();
    await Promise.all([
      writeChat(root, "z", "chat-z"),
      writeChat(root, "a", "chat-a"),
      writeChat(root, "ä", "chat-umlaut"),
    ]);
    await mkdir(join(root, "chats", "a", "nested"), { recursive: true });
    await writeChat(root, "a", "nested/chat-too-deep");
    const outside = join(root, "outside");
    await mkdir(outside);
    await symlink(outside, join(root, "chats", "a", "linked"), "dir");
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });

    const inventory = await inventoryCursorSource(paths);
    const mapping = mapCursorDiscovery(inventory, []);

    expect(mapping.outcome).toBe("supported");
    expect(mapping.candidates.map(({ nativeId }) => nativeId)).toEqual([
      "chat-a",
      "chat-z",
      "chat-umlaut",
    ]);
    expect(inventory.chats.some(({ nativeId }) => nativeId === "chat-too-deep")).toBe(false);
  });

  test("admits sidecar-like opaque directory names while ignoring actual SHM files", async () => {
    const root = await temporaryCursorRoot();
    await writeChat(root, "store.db-shm", "index.db-shm");
    const chatShm = join(root, "chats", "store.db-shm", "index.db-shm", "store.db-shm");
    await writeFile(chatShm, "chat-shm-one");

    await writeCatalog(root, "index.db-shm", "store.db-shm", "agent-one");
    const catalogScope = join(root, "projects", "index.db-shm", "sdk-agent-store", "store.db-shm");
    const catalogShm = join(catalogScope, "index.db-shm");
    const agentShm = join(
      catalogScope,
      "agents",
      cursorAgentStoreDirectory("agent-one"),
      "store.db-shm",
    );
    await Promise.all([
      writeFile(catalogShm, "catalog-shm-one"),
      writeFile(agentShm, "agent-shm-one"),
    ]);
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });

    const first = await inventoryCursorSource(paths);
    const catalog = first.catalogs.find(({ scope }) => scope === "store.db-shm");
    expect(catalog).toBeDefined();
    const mapping = mapCursorDiscovery(first, [
      materializedCatalog(catalog!, [agent("agent-one")]),
    ]);

    expect(mapping.outcome).toBe("supported");
    expect(mapping.candidates.map(({ nativeId }) => nativeId)).toEqual([
      "index.db-shm",
      "agent-one",
    ]);

    await Promise.all([
      writeFile(chatShm, "chat-shm-two"),
      writeFile(catalogShm, "catalog-shm-two"),
      writeFile(agentShm, "agent-shm-two"),
    ]);
    expect((await inventoryCursorSource(paths)).fingerprint).toBe(first.fingerprint);
  });

  test("maps one catalog only to its exact sibling agent store", async () => {
    const root = await temporaryCursorRoot();
    await writeCatalog(root, "project", "scope-one");
    await writeCatalog(root, "project", "scope-two", "agent-one");
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });
    const inventory = await inventoryCursorSource(paths);
    const first = inventory.catalogs.find(({ scope }) => scope === "scope-one");
    expect(first).toBeDefined();

    const mapping = mapCursorDiscovery(inventory, [
      materializedCatalog(first!, [agent("agent-one")]),
    ]);

    expect(mapping.outcome).toBe("incomplete");
    expect(mapping.issues).toContainEqual({ kind: "missing-agent-store" });
  });

  test("reports missing, duplicate, claimed, and unknown mappings without fallback joins", async () => {
    const root = await temporaryCursorRoot();
    await Promise.all([
      writeChat(root, "scope-one", "same-id"),
      writeChat(root, "scope-two", "same-id"),
    ]);
    await writeCatalog(root, "project", "scope", "agent-one");
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });
    const inventory = await inventoryCursorSource(paths);
    const catalog = inventory.catalogs[0]!;

    const mapping = mapCursorDiscovery(inventory, [
      materializedCatalog(catalog, [agent("agent-one"), agent("agent-one")]),
      {
        catalogComponents: ["projects", "other", "sdk-agent-store", "scope", "index.db"],
        agents: [],
      },
    ]);

    expect(mapping.outcome).toBe("incomplete");
    expect(mapping.issues).toEqual(
      expect.arrayContaining([
        { kind: "duplicate-native-id" },
        { kind: "claimed-agent-store" },
        { kind: "unknown-catalog" },
      ]),
    );
  });

  test("applies deferred-layout precedence without walking transcript descendants", async () => {
    const deferredRoot = await temporaryCursorRoot();
    await mkdir(join(deferredRoot, "projects", "project", "agent-transcripts", "private"), {
      recursive: true,
    });
    await writeFile(
      join(deferredRoot, "projects", "project", "agent-transcripts", "private", "ignored.jsonl"),
      "not-json",
    );
    const deferredPaths = await resolveCursorPaths({
      home: deferredRoot,
      cursorHome: deferredRoot,
    });
    const deferred = mapCursorDiscovery(await inventoryCursorSource(deferredPaths), []);
    expect(deferred).toMatchObject({
      outcome: "incomplete",
      candidates: [],
      issues: [{ kind: "invalid-agent-transcript" }],
    });

    const supportedRoot = await temporaryCursorRoot();
    await writeChat(supportedRoot, "scope", "chat-one");
    await mkdir(join(supportedRoot, "projects", "project", "agent-transcripts"), {
      recursive: true,
    });
    const supportedPaths = await resolveCursorPaths({
      home: supportedRoot,
      cursorHome: supportedRoot,
    });
    expect(mapCursorDiscovery(await inventoryCursorSource(supportedPaths), []).outcome).toBe(
      "supported",
    );

    const emptyRoot = await temporaryCursorRoot();
    await writeChat(emptyRoot, "scope", "chat-one", { hasConversation: false }, false);
    const emptyPaths = await resolveCursorPaths({ home: emptyRoot, cursorHome: emptyRoot });
    expect(mapCursorDiscovery(await inventoryCursorSource(emptyPaths), [])).toMatchObject({
      outcome: "complete-empty",
      candidates: [],
    });
  });

  test("applies rich and explicit noncandidate ownership before JSONL fallback grouping", async () => {
    const root = await temporaryCursorRoot();
    await Promise.all([
      writeChat(root, "rich", RICH_JSONL_ID),
      writeChat(root, "noncandidate", NONCANDIDATE_JSONL_ID, { hasConversation: false }, false),
      writeAgentTranscript(root, "a", RICH_JSONL_ID),
      writeAgentTranscript(root, "a", NONCANDIDATE_JSONL_ID),
      writeAgentTranscript(root, "a", UNIQUE_JSONL_ID),
      writeAgentTranscript(root, "a", CHILD_JSONL_ID, UNIQUE_JSONL_ID),
      writeAgentTranscript(root, "a", DUPLICATE_JSONL_ID),
      writeAgentTranscript(root, "z", DUPLICATE_JSONL_ID),
    ]);
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });

    const mapping = mapCursorDiscovery(await inventoryCursorSource(paths), []);
    const byId = new Map(mapping.candidates.map((candidate) => [candidate.nativeId, candidate]));

    expect(mapping.outcome).toBe("supported");
    expect(byId.get(RICH_JSONL_ID)).toMatchObject({
      family: "chat-store-v1",
      inputs: expect.not.arrayContaining([expect.objectContaining({ role: "transcript" })]),
    });
    expect(byId.has(NONCANDIDATE_JSONL_ID)).toBe(false);
    expect(byId.get(UNIQUE_JSONL_ID)).toMatchObject({
      family: "agent-transcript-jsonl-v1",
      inputs: [{ role: "transcript" }],
    });
    expect(byId.get(CHILD_JSONL_ID)).toMatchObject({
      family: "agent-transcript-jsonl-v1",
    });
    expect(byId.get(DUPLICATE_JSONL_ID)).toMatchObject({
      family: "agent-transcript-conflict-v1",
      inputs: [{ role: "transcript" }, { role: "transcript" }],
    });
  });

  test("lets null-checkpoint catalog ownership suppress unique and duplicate JSONL fallback", async () => {
    const root = await temporaryCursorRoot();
    await Promise.all([
      writeCatalog(root, "project", "scope"),
      writeAgentTranscript(root, "a", UNIQUE_JSONL_ID),
      writeAgentTranscript(root, "a", DUPLICATE_JSONL_ID),
      writeAgentTranscript(root, "z", DUPLICATE_JSONL_ID),
    ]);
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });
    const inventory = await inventoryCursorSource(paths);
    const catalog = inventory.catalogs[0]!;

    const mapping = mapCursorDiscovery(inventory, [
      materializedCatalog(catalog, [
        { ...agent(UNIQUE_JSONL_ID), checkpoint: null },
        { ...agent(DUPLICATE_JSONL_ID), checkpoint: null },
      ]),
    ]);

    expect(mapping).toMatchObject({
      outcome: "complete-empty",
      candidates: [],
      issues: [],
    });
  });

  test("marks unknown and wrong-type transcript grammar entries incomplete", async () => {
    const root = await temporaryCursorRoot();
    await writeAgentTranscript(root, "project", UNIQUE_JSONL_ID);
    const transcripts = join(root, "projects", "project", "agent-transcripts");
    await Promise.all([
      mkdir(join(transcripts, "unknown-layout"), { recursive: true }),
      mkdir(join(transcripts, CHILD_JSONL_ID, `${CHILD_JSONL_ID}.jsonl`), {
        recursive: true,
      }),
    ]);
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });

    const mapping = mapCursorDiscovery(await inventoryCursorSource(paths), []);

    expect(mapping.outcome).toBe("incomplete");
    expect(mapping.issues).toEqual([
      { kind: "invalid-agent-transcript" },
      { kind: "invalid-agent-transcript" },
    ]);
  });

  test.each([
    ["an added metadata field", { extra: true }],
    ["a changed metadata schema version", { schemaVersion: 2 }],
  ])("classifies %s as unsupported format drift", async (_name, metadataOverride) => {
    const root = await temporaryCursorRoot();
    await writeChat(root, "scope", "chat-one", metadataOverride);
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });

    const mapping = mapCursorDiscovery(await inventoryCursorSource(paths), []);

    expect(mapping).toMatchObject({
      outcome: "unsupported-format",
      issues: [{ kind: "unsupported-chat-metadata" }],
    });
  });

  test("rejects invalid UTF-8 chat metadata as malformed", async () => {
    const root = await temporaryCursorRoot();
    const directory = join(root, "chats", "scope", "chat-one");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "meta.json"), new Uint8Array([0x7b, 0x80, 0x7d]));
    await writeFile(join(directory, "store.db"), "store");
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });

    const mapping = mapCursorDiscovery(await inventoryCursorSource(paths), []);

    expect(mapping).toMatchObject({
      outcome: "incomplete",
      issues: [{ kind: "malformed-chat-metadata" }],
    });
  });

  test("composes stable inventory with the injected catalog materializer", async () => {
    const root = await temporaryCursorRoot();
    await writeCatalog(root, "project", "scope", "agent-one");
    const paths = await resolveCursorPaths({ home: root, cursorHome: root });
    const seen: string[][] = [];

    const result = await discoverCursorStructure(
      paths,
      syntheticCaptureWorkspace,
      async (catalog) => {
        seen.push([...catalog.catalog.main.components]);
        return materializedCatalog(catalog, [agent("agent-one")]);
      },
    );

    expect(result.outcome).toBe("supported");
    expect(result.candidates).toHaveLength(1);
    expect(seen).toEqual([["projects", "project", "sdk-agent-store", "scope", "index.db"]]);
  });
});

async function temporaryCursorRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sessions-cursor-discovery-"));
  roots.push(root);
  return root;
}

async function writeChat(
  root: string,
  scope: string,
  nativeId: string,
  overrides: {
    readonly schemaVersion?: number;
    readonly hasConversation?: boolean;
    readonly title?: string;
    readonly extra?: boolean;
  } = {},
  withStore = true,
): Promise<void> {
  const directory = join(root, "chats", scope, nativeId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "meta.json"),
    JSON.stringify({
      schemaVersion: overrides.schemaVersion ?? 1,
      createdAtMs: CREATED_MS,
      updatedAtMs: UPDATED_MS,
      hasConversation: overrides.hasConversation ?? true,
      ...(overrides.title === undefined ? {} : { title: overrides.title }),
      ...(overrides.extra === undefined ? {} : { extra: overrides.extra }),
    }),
  );
  if (withStore) await writeFile(join(directory, "store.db"), "store");
}

async function writeCatalog(
  root: string,
  project: string,
  scope: string,
  storedAgentId?: string,
): Promise<void> {
  const directory = join(root, "projects", project, "sdk-agent-store", scope);
  await mkdir(join(directory, "agents"), { recursive: true });
  await writeFile(join(directory, "index.db"), "catalog");
  if (storedAgentId !== undefined) {
    const store = join(directory, "agents", cursorAgentStoreDirectory(storedAgentId));
    await mkdir(store);
    await writeFile(join(store, "store.db"), "store");
  }
}

async function writeAgentTranscript(
  root: string,
  project: string,
  nativeId: string,
  parentId?: string,
): Promise<string> {
  const transcriptRoot = join(root, "projects", project, "agent-transcripts");
  const file =
    parentId === undefined
      ? join(transcriptRoot, nativeId, `${nativeId}.jsonl`)
      : join(transcriptRoot, parentId, "subagents", `${nativeId}.jsonl`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{"type":"turn_ended","status":"success"}');
  return file;
}

function materializedCatalog(
  catalog: {
    readonly catalog: { readonly main: { readonly components: readonly string[] } };
  },
  agents: readonly MaterializedCursorAgent[],
): MaterializedCursorCatalog {
  return { catalogComponents: catalog.catalog.main.components, agents };
}

function agent(agentId: string): MaterializedCursorAgent {
  return {
    agentId,
    checkpoint: { blobId: "a".repeat(64), storeKind: "local-agent-store" },
    rowFingerprint: `sha256:${"b".repeat(64)}`,
    createdAt: "2026-07-16T10:00:00.000Z",
    updatedAt: "2026-07-16T10:05:00.000Z",
  };
}
