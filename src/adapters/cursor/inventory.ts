import { createHash } from "node:crypto";

import type { ResolvedCursorPaths } from "./paths.ts";
import {
  captureCursorFile,
  type CapturedCursorFile,
  type CursorEntryDescriptor,
  CursorInventoryChangedError,
  cursorDescriptorTuple,
  describeCursorEntry,
  listCursorDirectory,
} from "./filesystem.ts";

const STORE_SHM_NAMES = new Set(["store.db-shm"]);
const CATALOG_SHM_NAMES = new Set(["index.db-shm"]);

export interface CursorSqliteInventory {
  readonly main: CursorEntryDescriptor;
  readonly wal: CursorEntryDescriptor;
}

export interface CursorChatInventory {
  readonly scope: string;
  readonly nativeId: string;
  readonly metadata?: CapturedCursorFile;
  readonly store: CursorSqliteInventory;
}

export interface CursorAgentStoreInventory {
  readonly directoryName: string;
  readonly directory: CursorEntryDescriptor;
  readonly store: CursorSqliteInventory;
}

export interface CursorCatalogInventory {
  readonly scope: string;
  readonly catalog: CursorSqliteInventory;
  readonly stores: readonly CursorAgentStoreInventory[];
}

export interface CursorStructuralInventory {
  readonly chats: readonly CursorChatInventory[];
  readonly catalogs: readonly CursorCatalogInventory[];
  readonly deferredAgentTranscripts: readonly CursorEntryDescriptor[];
  readonly fingerprint: string;
}

export async function inventoryCursorSource(
  paths: ResolvedCursorPaths,
): Promise<CursorStructuralInventory> {
  const entries: CursorEntryDescriptor[] = [];
  const chats: CursorChatInventory[] = [];
  const catalogs: CursorCatalogInventory[] = [];
  const deferredAgentTranscripts: CursorEntryDescriptor[] = [];

  await inventoryChats(paths, entries, chats);
  await inventoryProjects(paths, entries, catalogs, deferredAgentTranscripts);

  const fingerprint = createHash("sha256")
    .update(JSON.stringify(entries.map(cursorDescriptorTuple)), "utf8")
    .digest("hex");
  return Object.freeze({
    chats: Object.freeze(chats),
    catalogs: Object.freeze(catalogs),
    deferredAgentTranscripts: Object.freeze(deferredAgentTranscripts),
    fingerprint: `sha256:${fingerprint}`,
  });
}

export async function captureStableCursorInventory<T>(
  paths: ResolvedCursorPaths,
  operation: (inventory: CursorStructuralInventory) => Promise<T>,
): Promise<T> {
  const first = await inventoryCursorSource(paths);
  const value = await operation(first);
  const second = await inventoryCursorSource(paths);
  if (first.fingerprint !== second.fingerprint) throw new CursorInventoryChangedError();
  return value;
}

async function inventoryChats(
  paths: ResolvedCursorPaths,
  entries: CursorEntryDescriptor[],
  chats: CursorChatInventory[],
): Promise<void> {
  const root = await describeCursorEntry(paths.cursorHome, ["chats"]);
  entries.push(root);
  for (const scopeEntry of await children(paths, ["chats"])) {
    entries.push(scopeEntry);
    if (scopeEntry.kind !== "directory") continue;
    const scope = lastComponent(scopeEntry);
    for (const chatEntry of await children(paths, ["chats", scope])) {
      entries.push(chatEntry);
      if (chatEntry.kind !== "directory") continue;
      const nativeId = lastComponent(chatEntry);
      const chatComponents = ["chats", scope, nativeId] as const;
      const childrenByName = await childMap(paths, chatComponents, entries, STORE_SHM_NAMES);
      const metadataEntry =
        childrenByName.get("meta.json") ??
        (await describeCursorEntry(paths.cursorHome, [...chatComponents, "meta.json"]));
      let metadata: CapturedCursorFile | undefined;
      if (metadataEntry.kind === "regular-file") {
        metadata = await captureCursorFile(
          paths.cursorHome,
          metadataEntry.components,
          metadataEntry,
        );
        replaceEntry(entries, metadataEntry, metadata.descriptor);
      }
      const main =
        childrenByName.get("store.db") ??
        (await describeCursorEntry(paths.cursorHome, [...chatComponents, "store.db"]));
      const wal =
        childrenByName.get("store.db-wal") ??
        (await describeCursorEntry(paths.cursorHome, [...chatComponents, "store.db-wal"]));
      chats.push(
        Object.freeze({
          scope,
          nativeId,
          ...(metadata === undefined ? {} : { metadata }),
          store: Object.freeze({ main, wal }),
        }),
      );
    }
  }
}

async function inventoryProjects(
  paths: ResolvedCursorPaths,
  entries: CursorEntryDescriptor[],
  catalogs: CursorCatalogInventory[],
  deferred: CursorEntryDescriptor[],
): Promise<void> {
  const root = await describeCursorEntry(paths.cursorHome, ["projects"]);
  entries.push(root);
  for (const projectEntry of await children(paths, ["projects"])) {
    entries.push(projectEntry);
    if (projectEntry.kind !== "directory") continue;
    const project = lastComponent(projectEntry);
    const projectChildren = await childMap(paths, ["projects", project], entries);
    const transcripts = projectChildren.get("agent-transcripts");
    if (transcripts?.kind === "directory") deferred.push(transcripts);

    const sdkRoot = projectChildren.get("sdk-agent-store");
    if (sdkRoot?.kind !== "directory") continue;
    for (const scopeEntry of await children(paths, sdkRoot.components)) {
      entries.push(scopeEntry);
      if (scopeEntry.kind !== "directory") continue;
      const scope = lastComponent(scopeEntry);
      const scopeChildren = await childMap(
        paths,
        scopeEntry.components,
        entries,
        CATALOG_SHM_NAMES,
      );
      const catalogMain =
        scopeChildren.get("index.db") ??
        (await describeCursorEntry(paths.cursorHome, [...scopeEntry.components, "index.db"]));
      const catalogWal =
        scopeChildren.get("index.db-wal") ??
        (await describeCursorEntry(paths.cursorHome, [...scopeEntry.components, "index.db-wal"]));
      const agentsDirectory =
        scopeChildren.get("agents") ??
        (await describeCursorEntry(paths.cursorHome, [...scopeEntry.components, "agents"]));
      const stores: CursorAgentStoreInventory[] = [];
      if (agentsDirectory.kind === "directory") {
        for (const storeDirectory of await children(paths, agentsDirectory.components)) {
          entries.push(storeDirectory);
          if (storeDirectory.kind !== "directory") continue;
          const storeChildren = await childMap(
            paths,
            storeDirectory.components,
            entries,
            STORE_SHM_NAMES,
          );
          const main =
            storeChildren.get("store.db") ??
            (await describeCursorEntry(paths.cursorHome, [
              ...storeDirectory.components,
              "store.db",
            ]));
          const wal =
            storeChildren.get("store.db-wal") ??
            (await describeCursorEntry(paths.cursorHome, [
              ...storeDirectory.components,
              "store.db-wal",
            ]));
          stores.push(
            Object.freeze({
              directoryName: lastComponent(storeDirectory),
              directory: storeDirectory,
              store: Object.freeze({ main, wal }),
            }),
          );
        }
      }
      catalogs.push(
        Object.freeze({
          scope,
          catalog: Object.freeze({ main: catalogMain, wal: catalogWal }),
          stores: Object.freeze(stores),
        }),
      );
    }
  }
}

async function children(
  paths: ResolvedCursorPaths,
  components: readonly string[],
  excludedNames?: ReadonlySet<string>,
): Promise<readonly CursorEntryDescriptor[]> {
  return listCursorDirectory(
    paths.cursorHome,
    components,
    excludedNames === undefined ? {} : { excludedNames },
  );
}

async function childMap(
  paths: ResolvedCursorPaths,
  components: readonly string[],
  entries: CursorEntryDescriptor[],
  excludedNames?: ReadonlySet<string>,
): Promise<ReadonlyMap<string, CursorEntryDescriptor>> {
  const childEntries = await children(paths, components, excludedNames);
  entries.push(...childEntries);
  return new Map(childEntries.map((entry) => [lastComponent(entry), entry]));
}

function replaceEntry(
  entries: CursorEntryDescriptor[],
  before: CursorEntryDescriptor,
  after: CursorEntryDescriptor,
): void {
  const index = entries.indexOf(before);
  if (index === -1) entries.push(after);
  else entries[index] = after;
}

function lastComponent(entry: CursorEntryDescriptor): string {
  const value = entry.components.at(-1);
  if (value === undefined) throw new TypeError("Cursor inventory entry has no component");
  return value;
}
