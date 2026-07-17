import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createDiscoveredSession } from "../../application/source-input-fingerprint.ts";
import { SourceFailureError, type SourceFailure } from "../../application/source-failure.ts";
import {
  SourceCaptureWorkspaceError,
  type DiscoveredSession,
  type SelectedSessionSource,
  type SessionSource,
  type SourceCaptureWorkspace,
  type SourceInputDescriptor,
  type SourceProbe,
} from "../../application/ports/session-source.ts";
import type { SessionDocument, SourceInstance } from "../../domain/session.ts";
import { fingerprintCodexTuple } from "./fingerprint.ts";
import { createCodexRolloutNormalizer } from "./normalize.ts";
import {
  describeRollout,
  resolveCodexPaths,
  rolloutDescriptorTuple,
  type CodexEnvironment,
  type ResolvedCodexPaths,
  type RolloutDescriptor,
} from "./paths.ts";
import { CodexRolloutError, readCodexRollout } from "./rollout.ts";
import { createCodexSourceInstance } from "./source-instance.ts";
import { CodexStateSchemaError, materializeCodexState, type CodexThreadState } from "./state-db.ts";
import { CodexStateSnapshotError, materializeCodexStateSnapshot } from "./state-snapshot.ts";

export const CODEX_ADAPTER_VERSION = "codex-v3";

const STATE_THREAD_URI = "codex://state/thread";
const STATE_PARENT_EDGE_URI = "codex://state/parent-edge";

interface FrozenCodexSession {
  readonly thread: CodexThreadState;
  readonly rollout: RolloutDescriptor;
  readonly logicalRolloutLocator: string;
  readonly candidate: DiscoveredSession;
}

/** Resolve one global/default Codex instance and its standard source adapter. */
export async function createCodexSource(
  environment?: CodexEnvironment,
): Promise<SelectedSessionSource> {
  const paths = await resolveCodexPaths(environment);
  const instance = Object.freeze(createCodexSourceInstance(paths.codexHome, paths.sqliteHome));
  let currentGeneration: ReadonlyMap<string, FrozenCodexSession> | undefined;
  let discoverySequence = 0;

  const adapter: SessionSource = Object.freeze({
    kind: "codex",
    async probe(): Promise<SourceProbe> {
      return probeCodexSource(paths, instance);
    },
    async *discover(workspace: SourceCaptureWorkspace): AsyncIterable<DiscoveredSession> {
      const sequence = ++discoverySequence;
      const probe = await probeCodexSource(paths, instance);
      if (probe.status !== "ready") throw sourceFailure(probe.status, instance);

      let generation: ReadonlyMap<string, FrozenCodexSession>;
      try {
        const state = await materializeCodexStateSnapshot({
          databasePath: paths.stateDatabase,
          workspace,
          materialize: materializeCodexStateSafely,
        });
        const sessions: FrozenCodexSession[] = [];
        for (const thread of state.threads) {
          const rollout = await describeRollout(paths, thread.rolloutPath, thread.id);
          sessions.push(freezeCodexSession(instance, thread, rollout));
        }
        generation = new Map(sessions.map((session) => [session.thread.id, session]));
      } catch (error) {
        if (error instanceof SourceCaptureWorkspaceError) throw error;
        throw mapAdapterError(error, instance, "unreadable");
      }

      if (sequence !== discoverySequence) throw sourceFailure("source-changed", instance);
      currentGeneration = generation;
      for (const session of generation.values()) yield session.candidate;
    },
    async read(
      candidate: DiscoveredSession,
      _workspace: SourceCaptureWorkspace,
    ): Promise<SessionDocument> {
      const frozen = currentGeneration?.get(candidate.identity.nativeId);
      if (frozen === undefined || !sameCandidate(frozen.candidate, candidate)) {
        throw sourceFailure("source-changed", instance);
      }

      let before: RolloutDescriptor;
      try {
        before = await describeRollout(paths, frozen.thread.rolloutPath, frozen.thread.id);
      } catch (error) {
        throw sourceFailure("unreadable", instance, error);
      }
      if (!sameRolloutDescriptor(frozen.rollout, before)) {
        throw sourceFailure("source-changed", instance);
      }
      if (before.status === "missing") throw sourceFailure("unavailable", instance);
      if (before.status === "invalid") throw sourceFailure("malformed", instance);
      if (
        before.file === undefined ||
        before.stat === undefined ||
        (before.representation !== "plain" && before.representation !== "zstd")
      ) {
        throw sourceFailure("malformed", instance);
      }

      const normalizer = createCodexRolloutNormalizer({
        identity: frozen.candidate.identity,
        logicalLocator: frozen.logicalRolloutLocator,
        spawnEdgeCoverage: frozen.thread.spawnEdgeCoverage,
        ...(frozen.thread.parentId === undefined
          ? {}
          : { stateParentNativeId: frozen.thread.parentId }),
        ...(frozen.thread.title === undefined ? {} : { title: frozen.thread.title }),
        ...(frozen.thread.workspace === undefined ? {} : { workspace: frozen.thread.workspace }),
        ...(frozen.thread.createdAt === undefined ? {} : { createdAt: frozen.thread.createdAt }),
        ...(frozen.thread.updatedAt === undefined ? {} : { updatedAt: frozen.thread.updatedAt }),
      });

      let document: SessionDocument | undefined;
      let operationError: unknown;
      try {
        await readCodexRollout({
          file: before.file,
          representation: before.representation,
          expectedStat: before.stat,
          onRecord: normalizer.addRecord,
          onBlankRecord: normalizer.breakAdjacency,
        });
        document = normalizer.finish();
      } catch (error) {
        operationError = error;
      }

      let after: RolloutDescriptor | undefined;
      let verificationError: unknown;
      try {
        after = await describeRollout(paths, frozen.thread.rolloutPath, frozen.thread.id);
      } catch (error) {
        verificationError = error;
      }

      if (after !== undefined && !sameRolloutDescriptor(frozen.rollout, after)) {
        throw sourceFailure(
          "source-changed",
          instance,
          combineErrors(operationError, verificationError),
        );
      }
      if (verificationError !== undefined) {
        const operationKind = adapterFailureKind(operationError);
        throw sourceFailure(
          operationKind === "source-changed" ? "source-changed" : "unreadable",
          instance,
          combineErrors(operationError, verificationError),
        );
      }
      if (operationError !== undefined) {
        throw mapAdapterError(operationError, instance, "malformed");
      }
      if (document === undefined) throw sourceFailure("malformed", instance);
      return document;
    },
  });

  return Object.freeze({ instance, adapter });
}

function materializeCodexStateSafely(
  database: Parameters<typeof materializeCodexState>[0],
): ReturnType<typeof materializeCodexState> {
  try {
    return materializeCodexState(database);
  } catch (error) {
    if (error instanceof CodexStateSchemaError) throw error;
    throw new CodexStateSnapshotError("malformed");
  }
}

async function probeCodexSource(
  paths: ResolvedCodexPaths,
  source: SourceInstance,
): Promise<SourceProbe> {
  let status: SourceProbe["status"] = "ready";
  try {
    await requireDirectory(paths.codexHome);
    await requireDirectory(paths.sqliteHome);
    await requireRegularFile(paths.stateDatabase);
  } catch (error) {
    status = isMissing(error) ? "unavailable" : "unreadable";
  }

  return Object.freeze({
    source,
    status,
    locations: Object.freeze([
      Object.freeze({ role: "codex-home", locator: { uri: pathToFileURL(paths.codexHome).href } }),
      Object.freeze({
        role: "sqlite-home",
        locator: { uri: pathToFileURL(paths.sqliteHome).href },
      }),
    ]),
    summary: `Codex source is ${status}`,
  });
}

async function requireDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory()) throw new Error("Codex source root is not a directory");
  await access(path, constants.R_OK | constants.X_OK);
}

async function requireRegularFile(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error("Codex state is not a regular file");
  await access(path, constants.R_OK);
}

function freezeCodexSession(
  source: SourceInstance,
  thread: CodexThreadState,
  rollout: RolloutDescriptor,
): FrozenCodexSession {
  const identity = Object.freeze({ source, nativeId: thread.id });
  const logicalRolloutLocator = rolloutLocator(rollout.logicalName);
  const inputs: readonly SourceInputDescriptor[] = [
    {
      role: "thread-row",
      locator: { uri: STATE_THREAD_URI, recordId: thread.id },
      fingerprint: fingerprintCodexTuple(thread.rowTuple),
    },
    {
      role: "parent-edge",
      locator: { uri: STATE_PARENT_EDGE_URI, recordId: thread.id },
      fingerprint: fingerprintCodexTuple(thread.edgeTuple),
    },
    {
      role: "rollout",
      locator: { uri: logicalRolloutLocator },
      fingerprint: fingerprintCodexTuple(rolloutDescriptorTuple(rollout)),
    },
  ];
  const candidate = freezeCandidate(
    createDiscoveredSession({ identity, inputs, adapterVersion: CODEX_ADAPTER_VERSION }),
  );
  return Object.freeze({ thread, rollout, logicalRolloutLocator, candidate });
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

function rolloutLocator(logicalName: string): string {
  return `codex://rollout/${encodeURIComponent(logicalName)}`;
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

function sameRolloutDescriptor(left: RolloutDescriptor, right: RolloutDescriptor): boolean {
  return (
    fingerprintCodexTuple(rolloutDescriptorTuple(left)) ===
    fingerprintCodexTuple(rolloutDescriptorTuple(right))
  );
}

function mapAdapterError(
  error: unknown,
  source: SourceInstance,
  fallback: SourceFailure["kind"],
): SourceFailureError {
  return sourceFailure(adapterFailureKind(error) ?? fallback, source, error);
}

function adapterFailureKind(error: unknown): SourceFailure["kind"] | undefined {
  if (error instanceof SourceFailureError) return error.failure.kind;
  if (error instanceof CodexStateSchemaError || error instanceof CodexRolloutError) {
    return error.kind;
  }
  if (error instanceof CodexStateSnapshotError) {
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
  return new AggregateError([left, right], "Codex rollout operation and verification failed", {
    cause: left,
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
