import { describe, expect, test } from "vitest";

import { discoverSessions } from "../../src/application/discover-sessions.ts";
import type {
  DiscoveredSession,
  SessionSource,
} from "../../src/application/ports/session-source.ts";
import { createDiscoveredSession } from "../../src/application/source-input-fingerprint.ts";
import { selectSessionSource } from "../../src/application/validate-session.ts";
import type { SessionDocument, SourceInstance } from "../../src/domain/session.ts";
import { syntheticDiscoveryWorkspace } from "../fixtures/discovery-workspace.ts";

const sourceInstance = { kind: "synthetic", instanceId: "one" } as const;

describe("discoverSessions", () => {
  test("deeply snapshots candidates, collapses exact duplicates, and sorts by binary native ID", async () => {
    const later = candidate("zeta");
    const earlier = candidate("Alpha");
    const mutable = mutableCandidate("middle");
    const adapter = source([mutable, later, earlier, candidate("zeta")], () => {
      mutable.inputs[0]!.fingerprint = "mutated-after-yield";
    });

    const result = await discoverSessions(
      selectSessionSource(sourceInstance, adapter),
      syntheticDiscoveryWorkspace,
    );

    expect(result.complete).toBe(true);
    if (!result.complete) throw new Error("expected complete discovery");
    expect(result.candidates.map(({ observation }) => observation.identity.nativeId)).toEqual([
      "Alpha",
      "middle",
      "zeta",
    ]);
    expect(result.candidates[1]?.candidate.inputs[0]?.fingerprint).toBe("revision-one");
  });

  test("uses UTF-8 binary order rather than locale or UTF-16 order", async () => {
    const supplementary = candidate("\u{10000}");
    const privateUse = candidate("\u{E000}");

    const result = await discoverSessions(
      selectSessionSource(sourceInstance, source([supplementary, privateUse])),
      syntheticDiscoveryWorkspace,
    );

    if (!result.complete) throw new Error("expected complete discovery");
    expect(result.candidates.map(({ observation }) => observation.identity.nativeId)).toEqual([
      "\u{E000}",
      "\u{10000}",
    ]);
  });

  test.each([
    ["wrong source", [candidate("one", { kind: "synthetic", instanceId: "other" })]],
    ["malformed candidate", [{} as DiscoveredSession]],
    ["conflicting duplicate", [candidate("one"), candidate("one", sourceInstance, "two")]],
  ])("marks %s incomplete and returns no candidates", async (_label, candidates) => {
    const result = await discoverSessions(
      selectSessionSource(sourceInstance, source(candidates)),
      syntheticDiscoveryWorkspace,
    );

    expect(result).toEqual({ complete: false, candidates: [] });
  });

  test("marks an iterator failure incomplete after exhausting prior values", async () => {
    const adapter: SessionSource = {
      kind: sourceInstance.kind,
      async probe() {
        return readyProbe();
      },
      async *discover() {
        yield candidate("one");
        throw new Error("private iterator payload");
      },
      async read(value) {
        return document(value);
      },
    };

    await expect(
      discoverSessions(selectSessionSource(sourceInstance, adapter), syntheticDiscoveryWorkspace),
    ).resolves.toEqual({ complete: false, candidates: [] });
  });

  test("passes the writer-owned workspace only to discovery", async () => {
    let received: unknown;
    const adapter: SessionSource = {
      kind: sourceInstance.kind,
      async probe() {
        return readyProbe();
      },
      async *discover(workspace) {
        received = workspace;
        yield candidate("one");
      },
      async read(value) {
        return document(value);
      },
    };

    await discoverSessions(
      selectSessionSource(sourceInstance, adapter),
      syntheticDiscoveryWorkspace,
    );

    expect(received).toBe(syntheticDiscoveryWorkspace);
  });
});

function candidate(
  nativeId: string,
  source: SourceInstance = sourceInstance,
  revision = "one",
): DiscoveredSession {
  return createDiscoveredSession({
    identity: { source, nativeId },
    inputs: [
      {
        role: "transcript",
        locator: { uri: `memory://${nativeId}` },
        fingerprint: `revision-${revision}`,
      },
    ],
    adapterVersion: "synthetic-v1",
  });
}

function mutableCandidate(nativeId: string) {
  const value = candidate(nativeId);
  return {
    ...value,
    inputs: value.inputs.map((input) => ({
      ...input,
      locator: { ...input.locator },
    })),
  };
}

function source(candidates: readonly DiscoveredSession[], afterFirst?: () => void): SessionSource {
  return {
    kind: sourceInstance.kind,
    async probe() {
      return readyProbe();
    },
    async *discover() {
      for (const [index, value] of candidates.entries()) {
        yield value;
        if (index === 0) afterFirst?.();
      }
    },
    async read(value) {
      return document(value);
    },
  };
}

function readyProbe() {
  return {
    source: sourceInstance,
    status: "ready" as const,
    locations: [{ role: "root", locator: { uri: "memory://root" } }],
    summary: "ready",
  };
}

function document(value: DiscoveredSession): SessionDocument {
  return { identity: value.identity, lineageCoverage: "unknown", relations: [], entries: [] };
}
