import { createHash } from "node:crypto";

import type { SourceCaptureWorkspace } from "../../application/ports/session-source.ts";
import { compareCursorComponents, cursorDescriptorFingerprint } from "./filesystem.ts";
import {
  captureStableCursorInventory,
  type CursorCatalogInventory,
  type CursorAgentTranscriptInventory,
  type CursorChatInventory,
  type CursorSqliteInventory,
  type CursorStructuralInventory,
} from "./inventory.ts";
import type { ResolvedCursorPaths } from "./paths.ts";
import {
  decodeUtf8,
  exactRecord,
  optionalString,
  parseJsonText,
  requiredBoolean,
  requiredNonnegativeSafeInteger,
} from "./format-fields.ts";
import {
  CursorFormatError,
  malformedCursorFormat,
  unsupportedCursorFormat,
} from "./format-error.ts";

const CHAT_METADATA_REQUIRED_KEYS = new Set([
  "schemaVersion",
  "createdAtMs",
  "updatedAtMs",
  "hasConversation",
]);
const CHAT_METADATA_OPTIONAL_KEYS = new Set(["cwd", "title"]);

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
    }
  | {
      readonly family: "agent-transcript-jsonl-v1";
      readonly nativeId: string;
      readonly transcript: CursorAgentTranscriptInventory;
      readonly inputs: readonly CursorCandidateInput[];
    }
  | {
      readonly family: "agent-transcript-conflict-v1";
      readonly nativeId: string;
      readonly transcripts: readonly CursorAgentTranscriptInventory[];
      readonly inputs: readonly CursorCandidateInput[];
    };

export interface CursorCandidateInput {
  readonly role: "metadata" | "catalog-row" | "store-main" | "store-wal" | "transcript";
  readonly fingerprint: string;
}

export type CursorDiscoveryIssueKind =
  | "malformed-chat-metadata"
  | "unsupported-chat-metadata"
  | "missing-chat-store"
  | "unknown-catalog"
  | "missing-catalog-materialization"
  | "missing-agent-store"
  | "claimed-agent-store"
  | "duplicate-native-id"
  | "invalid-agent-transcript";

export interface CursorDiscoveryIssue {
  readonly kind: CursorDiscoveryIssueKind;
}

export interface CursorDiscoveryMapping {
  readonly outcome: "supported" | "complete-empty" | "unsupported-format" | "incomplete";
  readonly candidates: readonly CursorCandidateSeed[];
  readonly issues: readonly CursorDiscoveryIssue[];
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
  return captureStableCursorInventory(paths, async (inventory) => {
    const catalogs: MaterializedCursorCatalog[] = [];
    for (const catalog of inventory.catalogs) {
      if (catalog.catalog.main.kind !== "regular-file") continue;
      catalogs.push(await materializeCatalog(catalog, workspace));
    }
    return mapCursorDiscovery(inventory, catalogs);
  });
}

export function mapCursorDiscovery(
  inventory: CursorStructuralInventory,
  materializedCatalogs: readonly MaterializedCursorCatalog[],
): CursorDiscoveryMapping {
  const candidates: CursorCandidateSeed[] = [];
  const issues: CursorDiscoveryIssue[] = [];
  const richOwners = new Set<string>();
  const noncandidateOwners = new Set<string>();

  for (const chat of inventory.chats) {
    const mapped = mapChat(chat);
    if (mapped.kind === "candidate") {
      candidates.push(mapped.candidate);
      richOwners.add(mapped.candidate.nativeId);
    } else if (mapped.kind === "noncandidate") {
      noncandidateOwners.add(mapped.nativeId);
    } else if (mapped.kind === "issue") issues.push(Object.freeze({ kind: mapped.issue }));
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
        noncandidateOwners.add(agent.agentId);
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
      richOwners.add(agent.agentId);
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

  if (inventory.invalidAgentTranscriptEntries.length > 0) {
    issues.push(Object.freeze({ kind: "invalid-agent-transcript" }));
  }
  const transcriptGroups = groupAgentTranscripts(inventory.agentTranscripts);
  for (const [nativeId, grouped] of transcriptGroups) {
    if (richOwners.has(nativeId) || noncandidateOwners.has(nativeId)) continue;
    if (grouped.some(({ file }) => file.kind !== "regular-file")) {
      issues.push(Object.freeze({ kind: "invalid-agent-transcript" }));
      continue;
    }
    if (grouped.length === 1) {
      const transcript = grouped[0]!;
      candidates.push(
        Object.freeze({
          family: "agent-transcript-jsonl-v1",
          nativeId,
          transcript,
          inputs: transcriptInputs(grouped),
        }),
      );
      continue;
    }
    candidates.push(
      Object.freeze({
        family: "agent-transcript-conflict-v1",
        nativeId,
        transcripts: Object.freeze(grouped),
        inputs: transcriptInputs(grouped),
      }),
    );
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
      ? issues.every(({ kind }) => kind === "unsupported-chat-metadata")
        ? "unsupported-format"
        : "incomplete"
      : candidates.length > 0
        ? "supported"
        : inventory.agentTranscriptRoots.length > 0 && transcriptGroups.size === 0
          ? "unsupported-format"
          : "complete-empty";
  return Object.freeze({
    outcome,
    candidates: Object.freeze(candidates),
    issues: Object.freeze(issues),
  });
}

export function cursorAgentStoreDirectory(agentId: string): string {
  assertNonEmpty(agentId, "agentId");
  return `agent-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
}

type ChatMapping =
  | { readonly kind: "candidate"; readonly candidate: CursorCandidateSeed }
  | { readonly kind: "noncandidate"; readonly nativeId: string }
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
  } catch (error) {
    if (error instanceof CursorFormatError && error.kind === "unsupported-format") {
      return { kind: "issue", issue: "unsupported-chat-metadata" };
    }
    return { kind: "issue", issue: "malformed-chat-metadata" };
  }
  if (!metadata.hasConversation) return { kind: "noncandidate", nativeId: chat.nativeId };
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

function groupAgentTranscripts(
  transcripts: readonly CursorAgentTranscriptInventory[],
): ReadonlyMap<string, readonly CursorAgentTranscriptInventory[]> {
  const grouped = new Map<string, CursorAgentTranscriptInventory[]>();
  for (const transcript of transcripts) {
    const values = grouped.get(transcript.nativeId) ?? [];
    values.push(transcript);
    grouped.set(transcript.nativeId, values);
  }
  return new Map(
    [...grouped].map(([nativeId, values]) => [
      nativeId,
      Object.freeze(
        values.toSorted((left, right) =>
          compareComponentArrays(left.file.components, right.file.components),
        ),
      ),
    ]),
  );
}

function transcriptInputs(
  transcripts: readonly CursorAgentTranscriptInventory[],
): readonly CursorCandidateInput[] {
  return Object.freeze(
    transcripts.map(({ file }) =>
      Object.freeze({
        role: "transcript" as const,
        fingerprint: cursorDescriptorFingerprint(file),
      }),
    ),
  );
}

function compareComponentArrays(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const compared = compareCursorComponents(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function parseChatMetadata(bytes: Uint8Array): CursorChatMetadata {
  const parsed = exactRecord(
    parseJsonText(decodeUtf8(bytes)),
    CHAT_METADATA_REQUIRED_KEYS,
    CHAT_METADATA_OPTIONAL_KEYS,
  );
  const schemaVersion = requiredNonnegativeSafeInteger(parsed, "schemaVersion");
  if (schemaVersion !== 1) unsupportedCursorFormat();
  const createdAtMs = requiredNonnegativeSafeInteger(parsed, "createdAtMs");
  const updatedAtMs = requiredNonnegativeSafeInteger(parsed, "updatedAtMs");
  if (updatedAtMs < createdAtMs) malformedCursorFormat();
  const hasConversation = requiredBoolean(parsed, "hasConversation");
  const workspace = optionalString(parsed, "cwd");
  const title = optionalString(parsed, "title");
  return Object.freeze({
    schemaVersion: 1,
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    hasConversation,
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

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0 || !value.isWellFormed()) {
    throw new TypeError(`Cursor ${field} must be non-empty and well-formed`);
  }
}
