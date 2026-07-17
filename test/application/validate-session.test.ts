import { describe, expect, test } from "vitest";

import {
  admitDiscoveredSession,
  admitSessionObservation,
  admitSessionReplacement,
  selectSessionSource,
} from "../../src/application/validate-session.ts";
import { createDiscoveredSession } from "../../src/application/source-input-fingerprint.ts";
import {
  digestPublicSessionDocument,
  projectPublicSessionDocument,
} from "../../src/domain/public-session-document.ts";
import { createTestDocument, createTestIdentity } from "../fixtures/session.ts";

describe("session admission", () => {
  test("deeply snapshots and freezes the complete discovered candidate", () => {
    const candidate = mutableCandidate();

    const result = admitDiscoveredSession(candidate);

    if (!result.ok) throw new Error("expected admitted candidate");
    candidate.inputs[0] = {
      role: "mutated",
      locator: { uri: "memory://mutated" },
      fingerprint: "mutated",
    };
    expect(result.admitted.candidate.inputs).toEqual([
      {
        role: "transcript",
        locator: { uri: "memory://synthetic/session" },
        fingerprint: "version:1",
      },
    ]);
    expect(Object.isFrozen(result.admitted.candidate)).toBe(true);
    expect(Object.isFrozen(result.admitted.candidate.inputs)).toBe(true);
    expect(Object.isFrozen(result.admitted.candidate.inputs[0]?.locator)).toBe(true);
  });

  test("binds a validated source instance to a matching adapter kind", () => {
    const adapter = {
      kind: "synthetic",
      probe: async () => ({
        source: { kind: "synthetic", instanceId: "one" },
        status: "ready" as const,
        locations: [{ role: "root", locator: { uri: "memory://root" } }],
        summary: "ready",
      }),
      async *discover() {},
      async read() {
        return createTestDocument();
      },
    };

    const selected = selectSessionSource({ kind: "synthetic", instanceId: "one" }, adapter);

    expect(selected).toEqual({
      instance: { kind: "synthetic", instanceId: "one" },
      adapter,
    });
    expect(Object.isFrozen(selected.instance)).toBe(true);
    expect(() => selectSessionSource({ kind: "other", instanceId: "one" }, adapter)).toThrow(
      "Selected source adapter does not match",
    );
    expect(() =>
      selectSessionSource({ kind: "synthetic", instanceId: "one" }, {
        ...adapter,
        canReplace: "invalid",
      } as never),
    ).toThrow("Selected source adapter does not match");
  });

  test("deeply snapshots and brands an admitted observation", () => {
    const candidate = mutableCandidate();

    const result = admitSessionObservation(candidate);

    expect(result).toMatchObject({
      ok: true,
      observation: {
        identity: candidate.identity,
        revision: {
          aggregateFingerprint: candidate.aggregateFingerprint,
          adapterVersion: "adapter-v1",
        },
      },
    });
    if (!result.ok) throw new Error("expected admitted observation");

    candidate.identity.source.instanceId = "mutated-profile";
    candidate.identity.nativeId = "mutated-session";
    candidate.aggregateFingerprint.digest = "0".repeat(64);
    candidate.adapterVersion = "adapter-v2";

    expect(result.observation).toMatchObject({
      identity: createTestIdentity(),
      revision: {
        adapterVersion: "adapter-v1",
      },
    });
    expect(result.observation.revision.aggregateFingerprint.digest).not.toBe("0".repeat(64));
    expect(Object.isFrozen(result.observation)).toBe(true);
    expect(Object.isFrozen(result.observation.identity.source)).toBe(true);
    expect(Object.isFrozen(result.observation.revision.aggregateFingerprint)).toBe(true);
  });

  test("deeply snapshots a validated replacement independently of adapter data", () => {
    const observation = admittedObservation();
    const originalSegment = createTestDocument().entries[0]!.content[0]!;
    if (originalSegment.kind !== "text") throw new Error("expected fixture text segment");
    const entry = {
      ...createTestDocument().entries[0]!,
      sourceLocator: { ...createTestDocument().entries[0]!.sourceLocator },
      content: [
        {
          ...originalSegment,
          contentHash: { ...originalSegment.contentHash },
          sourceMetadata: { fixture: "synthetic" },
        },
      ],
    };
    const document = {
      ...createTestDocument(),
      identity: {
        source: { ...createTestIdentity().source },
        nativeId: createTestIdentity().nativeId,
      },
      relations: [],
      entries: [entry],
    };

    const result = admitSessionReplacement(observation, document);

    expect(result).toMatchObject({ ok: true, replacement: { document } });
    if (!result.ok) throw new Error("expected admitted replacement");
    document.title = "mutated title";
    document.identity.nativeId = "mutated-session";
    entry.kind = "mutated-kind";
    entry.sourceLocator.uri = "memory://mutated";
    entry.content[0]!.sourceMetadata.fixture = "mutated";

    expect(result.replacement.document).toEqual(createTestDocument());
    expect(result.replacement.documentDigest).toEqual(
      digestPublicSessionDocument(projectPublicSessionDocument(result.replacement.document)),
    );
    expect(Object.isFrozen(result.replacement)).toBe(true);
    expect(Object.isFrozen(result.replacement.documentDigest)).toBe(true);
    expect(
      Object.isFrozen(result.replacement.document.entries[0]?.content[0]?.sourceMetadata),
    ).toBe(true);
  });

  test("rejects an adapter-supplied document digest instead of accepting an override", () => {
    const result = admitSessionReplacement(admittedObservation(), {
      ...createTestDocument(),
      documentDigest: {
        scheme: "sha256-sessions-document-jcs-v1",
        digest: "0".repeat(64),
      },
    });

    expect(result).toEqual({
      ok: false,
      issues: [{ code: "unexpected-property", path: "/" }],
      truncated: false,
    });
  });

  test("keeps document identity independent from adapter observation metadata", () => {
    const firstObservation = admittedObservation();
    const nextCandidate = mutableCandidate();
    nextCandidate.adapterVersion = "adapter-v2";
    const nextObservation = admitSessionObservation(nextCandidate);
    if (!nextObservation.ok) throw new Error("expected admitted next observation");

    const first = admitSessionReplacement(firstObservation, createTestDocument());
    const next = admitSessionReplacement(nextObservation.observation, createTestDocument());

    if (!first.ok || !next.ok) throw new Error("expected admitted replacements");
    expect(next.replacement.documentDigest).toEqual(first.replacement.documentDigest);
  });

  test("rejects accessor candidates without invoking or reporting their values", () => {
    const candidate = { ...mutableCandidate() };
    let getterCalls = 0;
    Object.defineProperty(candidate, "adapterVersion", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("private candidate value");
      },
    });

    const result = admitSessionObservation(candidate);

    expect(result).toEqual({
      ok: false,
      issues: [{ code: "invalid-candidate", path: "/" }],
      truncated: false,
    });
    expect(getterCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private candidate value");
  });

  test("bounds malformed candidate input diagnostics to safe indexed paths", () => {
    const candidate = mutableCandidate();
    candidate.inputs = Array.from({ length: 40 }, () => ({}));

    const result = admitSessionObservation(candidate);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejected observation");
    expect(result.issues).toHaveLength(32);
    expect(result.truncated).toBe(true);
    expect(result.issues.every(({ code }) => code === "invalid-input")).toBe(true);
    expect(result.issues.map(({ path }) => path)).toEqual(
      Array.from({ length: 32 }, (_, index) => `/inputs/${index}`),
    );
  });

  test("rejects ill-formed candidate identity and adapter version without values", () => {
    const candidate = mutableCandidate();
    candidate.identity.nativeId = "private\ud800value";
    candidate.adapterVersion = "private\ud800version";

    const result = admitSessionObservation(candidate);

    expect(result).toEqual({
      ok: false,
      issues: [
        { code: "invalid-identity", path: "/identity" },
        { code: "invalid-adapter-version", path: "/adapterVersion" },
      ],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});

function admittedObservation() {
  const result = admitSessionObservation(mutableCandidate());
  if (!result.ok) throw new Error("expected admitted observation");
  return result.observation;
}

function mutableCandidate() {
  const candidate = createDiscoveredSession({
    identity: createTestIdentity(),
    inputs: [
      {
        role: "transcript",
        locator: { uri: "memory://synthetic/session" },
        fingerprint: "version:1",
      },
    ],
    adapterVersion: "adapter-v1",
  });

  return {
    identity: {
      source: { ...candidate.identity.source },
      nativeId: candidate.identity.nativeId,
    },
    inputs: candidate.inputs.map((input) => ({
      role: input.role,
      locator: { ...input.locator },
      fingerprint: input.fingerprint,
    })) as unknown[],
    aggregateFingerprint: { ...candidate.aggregateFingerprint },
    adapterVersion: candidate.adapterVersion,
  };
}
