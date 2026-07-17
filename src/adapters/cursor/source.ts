import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type {
  DiscoveredSession,
  SelectedSessionSource,
  SessionSource,
  SourceCaptureWorkspace,
  SourceInputDescriptor,
  SourceProbe,
} from "../../application/ports/session-source.ts";
import { SourceCaptureWorkspaceError } from "../../application/ports/session-source.ts";
import { createDiscoveredSession } from "../../application/source-input-fingerprint.ts";
import { SourceFailureError, type SourceFailure } from "../../application/source-failure.ts";
import type { SessionDocument, SourceInstance } from "../../domain/session.ts";
import { createMaterializedCursorCatalog, CursorCatalogError } from "./catalog.ts";
import {
  discoverCursorStructure,
  type CursorCandidateSeed,
  type CursorDiscoveryMapping,
} from "./discovery.ts";
import {
  cursorPath,
  describeCursorEntry,
  sameCursorDescriptor,
  CursorInventoryChangedError,
} from "./filesystem.ts";
import { CursorFormatError } from "./format-error.ts";
import { type CursorSqliteInventory } from "./inventory.ts";
import { normalizeCursorSession } from "./normalize.ts";
import { type CursorEnvironment, type ResolvedCursorPaths, resolveCursorPaths } from "./paths.ts";
import { createCursorSourceInstance } from "./source-instance.ts";
import { materializeCursorStore } from "./store.ts";
import {
  materializeSqliteSourceSnapshot,
  SqliteSourceSnapshotError,
} from "../shared/sqlite-source-snapshot.ts";

export const CURSOR_ADAPTER_VERSION = "cursor-v1";

interface FrozenCursorSession {
  readonly seed: CursorCandidateSeed;
  readonly logicalLocator: string;
  readonly candidate: DiscoveredSession;
}

/** Resolve the default local Cursor instance and its passive source adapter. */
export async function createCursorSource(
  environment?: CursorEnvironment,
): Promise<SelectedSessionSource> {
  const paths = await resolveCursorPaths(environment);
  const instance = Object.freeze(createCursorSourceInstance(paths.cursorHome));
  let currentGeneration: ReadonlyMap<string, FrozenCursorSession> | undefined;
  let discoverySequence = 0;

  const adapter: SessionSource = Object.freeze({
    kind: "cursor",
    async probe(): Promise<SourceProbe> {
      return probeCursorSource(paths, instance);
    },
    async *discover(workspace: SourceCaptureWorkspace): AsyncIterable<DiscoveredSession> {
      const sequence = ++discoverySequence;
      const probe = await probeCursorSource(paths, instance);
      if (probe.status !== "ready") throw sourceFailure(probe.status, instance);

      let mapping: CursorDiscoveryMapping;
      try {
        mapping = await discoverCursorStructure(
          paths,
          workspace,
          async (catalog, captureWorkspace) =>
            materializeSqliteSourceSnapshot({
              databasePath: cursorPath(paths.cursorHome, catalog.catalog.main.components),
              workspace: captureWorkspace,
              materialize: (database) => createMaterializedCursorCatalog(catalog, database),
            }),
        );
      } catch (error) {
        if (error instanceof SourceCaptureWorkspaceError) throw error;
        throw mapCursorError(error, instance, "unreadable");
      }

      if (mapping.outcome === "unsupported-format") {
        throw sourceFailure("unsupported-format", instance);
      }
      if (mapping.outcome === "incomplete") {
        throw sourceFailure("malformed", instance);
      }

      const sessions = mapping.candidates.map((seed) => freezeCursorSession(instance, seed));
      if (sequence !== discoverySequence) throw sourceFailure("source-changed", instance);
      currentGeneration = new Map(sessions.map((session) => [session.seed.nativeId, session]));
      for (const session of sessions) yield session.candidate;
    },
    async read(
      candidate: DiscoveredSession,
      workspace: SourceCaptureWorkspace,
    ): Promise<SessionDocument> {
      const frozen = currentGeneration?.get(candidate.identity.nativeId);
      if (frozen === undefined || !sameCandidate(frozen.candidate, candidate)) {
        throw sourceFailure("source-changed", instance);
      }

      try {
        await assertCurrentStore(paths, frozen.seed.store);
      } catch (error) {
        throw mapCursorError(error, instance, "source-changed");
      }

      let store: ReturnType<typeof materializeCursorStore> | undefined;
      let operationError: unknown;
      try {
        store = await materializeSqliteSourceSnapshot({
          databasePath: cursorPath(paths.cursorHome, frozen.seed.store.main.components),
          workspace,
          materialize: (database) =>
            materializeCursorStore(
              database,
              frozen.seed.family === "chat-store-v1"
                ? {
                    family: "chat-store-v1",
                    nativeId: frozen.seed.nativeId,
                  }
                : {
                    family: "agent-checkpoint-store-v1",
                    nativeId: frozen.seed.nativeId,
                    rootBlobId: requireCheckpointRoot(frozen.seed),
                  },
            ),
        });
      } catch (error) {
        operationError = error;
      }

      let verificationError: unknown;
      try {
        await assertCurrentStore(paths, frozen.seed.store);
      } catch (error) {
        verificationError = error;
      }

      if (operationError instanceof SourceCaptureWorkspaceError) throw operationError;
      if (
        adapterFailureKind(operationError) === "source-changed" ||
        verificationError !== undefined
      ) {
        throw sourceFailure(
          "source-changed",
          instance,
          combineErrors(operationError, verificationError),
        );
      }
      if (operationError !== undefined) {
        throw mapCursorError(operationError, instance, "malformed");
      }
      if (store === undefined) throw sourceFailure("malformed", instance);

      try {
        return normalizeCursorStore(frozen, store);
      } catch (error) {
        throw mapCursorError(error, instance, "malformed");
      }
    },
  });

  return Object.freeze({ instance, adapter });
}

function normalizeCursorStore(
  frozen: FrozenCursorSession,
  store: ReturnType<typeof materializeCursorStore>,
): SessionDocument {
  const shared = {
    identity: frozen.candidate.identity,
    logicalLocator: frozen.logicalLocator,
    messages: store.messages,
  } as const;
  if (frozen.seed.family === "chat-store-v1") {
    return normalizeCursorSession({
      ...shared,
      createdAt: frozen.seed.metadata.createdAt,
      updatedAt: frozen.seed.metadata.updatedAt,
      title: frozen.seed.metadata.title ?? store.metadata.name,
      ...(frozen.seed.metadata.workspace === undefined
        ? {}
        : { workspace: frozen.seed.metadata.workspace }),
    });
  }
  return normalizeCursorSession({
    ...shared,
    createdAt: frozen.seed.agent.createdAt,
    updatedAt: frozen.seed.agent.updatedAt,
    ...(frozen.seed.agent.title === undefined ? {} : { title: frozen.seed.agent.title }),
  });
}

async function probeCursorSource(
  paths: ResolvedCursorPaths,
  source: SourceInstance,
): Promise<SourceProbe> {
  let status: SourceProbe["status"] = "ready";
  try {
    const stats = await lstat(paths.cursorHome);
    if (!stats.isDirectory()) throw new Error("Cursor source root is not a directory");
    await access(paths.cursorHome, constants.R_OK | constants.X_OK);
  } catch (error) {
    status = isMissing(error) ? "unavailable" : "unreadable";
  }
  return Object.freeze({
    source,
    status,
    locations: Object.freeze([
      Object.freeze({
        role: "cursor-home",
        locator: { uri: pathToFileURL(paths.cursorHome).href },
      }),
    ]),
    summary: `Cursor source is ${status}`,
  });
}

function freezeCursorSession(
  source: SourceInstance,
  seed: CursorCandidateSeed,
): FrozenCursorSession {
  const identity = Object.freeze({ source, nativeId: seed.nativeId });
  const logicalLocator = cursorSessionLocator(seed);
  const inputs: readonly SourceInputDescriptor[] = seed.inputs.map((input) =>
    Object.freeze({
      role: input.role,
      locator: Object.freeze({ uri: cursorInputLocator(seed, input.role) }),
      fingerprint: input.fingerprint,
    }),
  );
  const candidate = freezeCandidate(
    createDiscoveredSession({
      identity,
      inputs,
      adapterVersion: CURSOR_ADAPTER_VERSION,
    }),
  );
  return Object.freeze({ seed, logicalLocator, candidate });
}

function cursorSessionLocator(seed: CursorCandidateSeed): string {
  return `cursor://session/${seed.family}/${encodeURIComponent(seed.nativeId)}`;
}

function cursorInputLocator(
  seed: CursorCandidateSeed,
  role: CursorCandidateSeed["inputs"][number]["role"],
): string {
  return `${cursorSessionLocator(seed)}/${role}`;
}

async function assertCurrentStore(
  paths: ResolvedCursorPaths,
  expected: CursorSqliteInventory,
): Promise<void> {
  const [main, wal] = await Promise.all([
    describeCursorEntry(paths.cursorHome, expected.main.components),
    describeCursorEntry(paths.cursorHome, expected.wal.components),
  ]);
  if (!sameCursorDescriptor(expected.main, main) || !sameCursorDescriptor(expected.wal, wal)) {
    throw new CursorInventoryChangedError();
  }
}

function requireCheckpointRoot(
  seed: Extract<CursorCandidateSeed, { readonly family: "agent-checkpoint-store-v1" }>,
): string {
  if (seed.agent.checkpoint === null) throw new CursorFormatError("malformed");
  return seed.agent.checkpoint.blobId;
}

function freezeCandidate(candidate: DiscoveredSession): DiscoveredSession {
  return Object.freeze({
    identity: Object.freeze({
      source: Object.freeze({ ...candidate.identity.source }),
      nativeId: candidate.identity.nativeId,
    }),
    inputs: Object.freeze(
      candidate.inputs.map((input) =>
        Object.freeze({
          role: input.role,
          locator: Object.freeze({ ...input.locator }),
          fingerprint: input.fingerprint,
        }),
      ),
    ),
    aggregateFingerprint: Object.freeze({ ...candidate.aggregateFingerprint }),
    adapterVersion: candidate.adapterVersion,
  });
}

function sameCandidate(expected: DiscoveredSession, actual: DiscoveredSession): boolean {
  if (
    expected.identity.source.kind !== actual.identity.source.kind ||
    expected.identity.source.instanceId !== actual.identity.source.instanceId ||
    expected.identity.nativeId !== actual.identity.nativeId ||
    expected.adapterVersion !== actual.adapterVersion ||
    expected.aggregateFingerprint.scheme !== actual.aggregateFingerprint.scheme ||
    expected.aggregateFingerprint.digest !== actual.aggregateFingerprint.digest ||
    expected.inputs.length !== actual.inputs.length
  ) {
    return false;
  }
  return expected.inputs.every((input, index) => {
    const other = actual.inputs[index];
    return (
      other !== undefined &&
      input.role === other.role &&
      input.locator.uri === other.locator.uri &&
      input.locator.recordId === other.locator.recordId &&
      input.fingerprint === other.fingerprint
    );
  });
}

function mapCursorError(
  error: unknown,
  source: SourceInstance,
  fallback: SourceFailure["kind"],
): SourceFailureError {
  if (error instanceof SourceFailureError) return error;
  return sourceFailure(adapterFailureKind(error) ?? fallback, source, error);
}

function adapterFailureKind(error: unknown): SourceFailure["kind"] | undefined {
  if (error instanceof SourceFailureError) return error.failure.kind;
  if (error instanceof CursorCatalogError || error instanceof CursorFormatError) return error.kind;
  if (error instanceof CursorInventoryChangedError) return "source-changed";
  if (error instanceof SqliteSourceSnapshotError) {
    return error.kind === "staging-failed" ? "unreadable" : error.kind;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return adapterFailureKind(error.cause);
  }
  return undefined;
}

function sourceFailure(
  kind: SourceFailure["kind"],
  source: SourceInstance,
  cause?: unknown,
): SourceFailureError {
  return new SourceFailureError({ kind, source }, cause === undefined ? undefined : { cause });
}

function combineErrors(left: unknown, right: unknown): unknown {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return new AggregateError([left, right], "Cursor capture and verification failed", {
    cause: left,
  });
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
