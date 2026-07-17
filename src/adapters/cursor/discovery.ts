import { createHash } from "node:crypto";

import type { SourceCaptureWorkspace } from "../../application/ports/session-source.ts";
import { cursorDescriptorFingerprint } from "./filesystem.ts";
import {
  captureStableCursorInventory,
  type CursorCatalogInventory,
  type CursorChatInventory,
  type CursorSqliteInventory,
  type CursorStructuralInventory,
} from "./inventory.ts";
import type { ResolvedCursorPaths } from "./paths.ts";

export interface CursorCheckpoint {
  readonly blobId: string;
  readonly storeKind: "local-agent-store";
}

/** Narrow seam implemented by the catalog SQLite reader. */
export interface MaterializedCursorAgent {
  readonly agentId: string;
  readonly checkpoint: CursorCheckpoint | null;
  readonly rowFingerprint: string;
  readonly title?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `catalogComponents` must identify the exact inventory catalog that produced the rows. */
export interface MaterializedCursorCatalog {
  readonly catalogComponents: readonly string[];
  readonly agents: readonly MaterializedCursorAgent[];
}

export interface CursorChatMetadata {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hasConversation: boolean;
  readonly workspace?: string;
  readonly title?: string;
}

export type CursorCandidateSeed =
  | {
      readonly family: "chat-store-v1";
      readonly nativeId: string;
      readonly metadata: CursorChatMetadata;
      readonly store: CursorSqliteInventory;
      readonly inputs: readonly CursorCandidateInput[];
    }
  | {
      readonly family: "agent-checkpoint-store-v1";
      readonly nativeId: string;
      readonly agent: MaterializedCursorAgent;
      readonly store: CursorSqliteInventory;
      readonly inputs: readonly CursorCandidateInput[];
    };

export interface CursorCandidateInput {
  readonly role: "metadata" | "catalog-row" | "store-main" | "store-wal";
  readonly fingerprint: string;
}

export type CursorDiscoveryIssueKind =
  | "malformed-chat-metadata"
  | "missing-chat-store"
  | "unknown-catalog"
  | "missing-catalog-materialization"
  | "missing-agent-store"
  | "claimed-agent-store"
  | "duplicate-native-id";

export interface CursorDiscoveryIssue {
  readonly kind: CursorDiscoveryIssueKind;
}

export interface CursorDiscoveryMapping {
  readonly outcome: "supported" | "complete-empty" | "unsupported-format" | "incomplete";
  readonly candidates: readonly CursorCandidateSeed[];
  readonly issues: readonly CursorDiscoveryIssue[];
  readonly recognizedNonCandidates: number;
}

export interface CursorCatalogMaterializer {
  (
    catalog: CursorCatalogInventory,
    workspace: SourceCaptureWorkspace,
  ): Promise<MaterializedCursorCatalog>;
}

/**
 * Compose one stable provider-owned generation. SQLite capture stays behind the
 * injected catalog materializer so structural discovery never opens live state.
 */
export async function discoverCursorStructure(
  paths: ResolvedCursorPaths,
  workspace: SourceCaptureWorkspace,
  materializeCatalog: CursorCatalogMaterializer,
): Promise<CursorDiscoveryMapping> {
  const result = await captureStableCursorInventory(paths, async (inventory) => {
    const catalogs: MaterializedCursorCatalog[] = [];
    for (const catalog of inventory.catalogs) {
      if (catalog.catalog.main.kind !== "regular-file") continue;
      catalogs.push(await materializeCatalog(catalog, workspace));
    }
    return mapCursorDiscovery(inventory, catalogs);
  });
  return result.value;
}

export function mapCursorDiscovery(
  inventory: CursorStructuralInventory,
  materializedCatalogs: readonly MaterializedCursorCatalog[],
): CursorDiscoveryMapping {
  const candidates: CursorCandidateSeed[] = [];
  const issues: CursorDiscoveryIssue[] = [];
  let recognizedNonCandidates = 0;

  for (const chat of inventory.chats) {
    const mapped = mapChat(chat);
    if (mapped.kind === "candidate") candidates.push(mapped.candidate);
    else if (mapped.kind === "noncandidate") recognizedNonCandidates++;
    else if (mapped.kind === "issue") issues.push(Object.freeze({ kind: mapped.issue }));
  }

  const catalogsByKey = new Map(
    inventory.catalogs.map((catalog) => [componentKey(catalog.catalog.main.components), catalog]),
  );
  const materializedKeys = new Set<string>();
  const claimedStores = new Set<string>();
  for (const materialized of materializedCatalogs) {
    const key = componentKey(materialized.catalogComponents);
    const catalog = catalogsByKey.get(key);
    if (catalog === undefined || materializedKeys.has(key)) {
      issues.push(Object.freeze({ kind: "unknown-catalog" }));
      continue;
    }
    materializedKeys.add(key);
    for (const agent of materialized.agents) {
      if (agent.checkpoint === null) {
        recognizedNonCandidates++;
        continue;
      }
      const directoryName = cursorAgentStoreDirectory(agent.agentId);
      const store = catalog.stores.find((value) => value.directoryName === directoryName);
      if (
        store === undefined ||
        store.directory.kind !== "directory" ||
        store.store.main.kind !== "regular-file" ||
        (store.store.wal.kind !== "regular-file" && store.store.wal.kind !== "missing")
      ) {
        issues.push(Object.freeze({ kind: "missing-agent-store" }));
        continue;
      }
      const storeKey = componentKey(store.directory.components);
      if (claimedStores.has(storeKey)) {
        issues.push(Object.freeze({ kind: "claimed-agent-store" }));
        continue;
      }
      claimedStores.add(storeKey);
      candidates.push(
        Object.freeze({
          family: "agent-checkpoint-store-v1",
          nativeId: agent.agentId,
          agent,
          store: store.store,
          inputs: candidateInputs(agent.rowFingerprint, store.store, "catalog-row"),
        }),
      );
    }
  }

  for (const catalog of inventory.catalogs) {
    if (
      catalog.catalog.main.kind === "regular-file" &&
      !materializedKeys.has(componentKey(catalog.catalog.main.components))
    ) {
      issues.push(Object.freeze({ kind: "missing-catalog-materialization" }));
    }
  }

  const seenIds = new Set<string>();
  for (const candidate of candidates) {
    if (seenIds.has(candidate.nativeId)) {
      issues.push(Object.freeze({ kind: "duplicate-native-id" }));
    } else {
      seenIds.add(candidate.nativeId);
    }
  }

  const outcome =
    issues.length > 0
      ? "incomplete"
      : candidates.length > 0
        ? "supported"
        : inventory.deferredAgentTranscripts.length > 0
          ? "unsupported-format"
          : "complete-empty";
  return Object.freeze({
    outcome,
    candidates: Object.freeze(candidates),
    issues: Object.freeze(issues),
    recognizedNonCandidates,
  });
}

export function cursorAgentStoreDirectory(agentId: string): string {
  assertNonEmpty(agentId, "agentId");
  return `agent-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
}

type ChatMapping =
  | { readonly kind: "candidate"; readonly candidate: CursorCandidateSeed }
  | { readonly kind: "noncandidate" }
  | { readonly kind: "ignore" }
  | { readonly kind: "issue"; readonly issue: CursorDiscoveryIssueKind };

function mapChat(chat: CursorChatInventory): ChatMapping {
  if (chat.metadata === undefined) {
    return chat.store.main.kind === "regular-file"
      ? { kind: "issue", issue: "malformed-chat-metadata" }
      : { kind: "ignore" };
  }

  let metadata: CursorChatMetadata;
  try {
    metadata = parseChatMetadata(chat.metadata.bytes);
  } catch {
    return { kind: "issue", issue: "malformed-chat-metadata" };
  }
  if (!metadata.hasConversation) return { kind: "noncandidate" };
  if (
    chat.store.main.kind !== "regular-file" ||
    (chat.store.wal.kind !== "regular-file" && chat.store.wal.kind !== "missing")
  ) {
    return { kind: "issue", issue: "missing-chat-store" };
  }
  return {
    kind: "candidate",
    candidate: Object.freeze({
      family: "chat-store-v1",
      nativeId: chat.nativeId,
      metadata,
      store: chat.store,
      inputs: candidateInputs(
        chat.metadata.descriptor.contentDigest ??
          cursorDescriptorFingerprint(chat.metadata.descriptor),
        chat.store,
        "metadata",
      ),
    }),
  };
}

function parseChatMetadata(bytes: Uint8Array): CursorChatMetadata {
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!isRecord(parsed)) throw new TypeError("Cursor chat metadata must be an object");
  const allowed = new Set([
    "schemaVersion",
    "createdAtMs",
    "updatedAtMs",
    "hasConversation",
    "cwd",
    "title",
  ]);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) {
    throw new TypeError("Cursor chat metadata has unsupported fields");
  }
  if (
    parsed.schemaVersion !== 1 ||
    !isNonnegativeSafeInteger(parsed.createdAtMs) ||
    !isNonnegativeSafeInteger(parsed.updatedAtMs) ||
    parsed.updatedAtMs < parsed.createdAtMs ||
    typeof parsed.hasConversation !== "boolean"
  ) {
    throw new TypeError("Cursor chat metadata is malformed");
  }
  const workspace = optionalString(parsed.cwd);
  const title = optionalString(parsed.title);
  return Object.freeze({
    schemaVersion: 1,
    createdAt: new Date(parsed.createdAtMs).toISOString(),
    updatedAt: new Date(parsed.updatedAtMs).toISOString(),
    hasConversation: parsed.hasConversation,
    ...(workspace === undefined ? {} : { workspace }),
    ...(title === undefined ? {} : { title }),
  });
}

function candidateInputs(
  firstFingerprint: string,
  store: CursorSqliteInventory,
  firstRole: "metadata" | "catalog-row",
): readonly CursorCandidateInput[] {
  assertNonEmpty(firstFingerprint, "fingerprint");
  const inputs: CursorCandidateInput[] = [
    Object.freeze({ role: firstRole, fingerprint: firstFingerprint }),
    Object.freeze({ role: "store-main", fingerprint: cursorDescriptorFingerprint(store.main) }),
  ];
  if (store.wal.kind === "regular-file") {
    inputs.push(
      Object.freeze({ role: "store-wal", fingerprint: cursorDescriptorFingerprint(store.wal) }),
    );
  }
  return Object.freeze(inputs);
}

function componentKey(components: readonly string[]): string {
  return JSON.stringify(components);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.isWellFormed()) {
    throw new TypeError("Cursor optional metadata must be a well-formed string");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0 || !value.isWellFormed()) {
    throw new TypeError(`Cursor ${field} must be non-empty and well-formed`);
  }
}
