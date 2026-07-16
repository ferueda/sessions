import { describe, expect, test } from "vitest";

import {
  createSessionRootResolver,
  type SessionLineageEvidence,
} from "../../src/domain/session-lineage.ts";
import type {
  OriginConfidence,
  SessionIdentity,
  SessionRelation,
} from "../../src/domain/session.ts";

describe("resolveSessionRoot", () => {
  test("treats a complete session without rootward edges as its own root", () => {
    const session = evidence("session", [], "complete");

    const resolution = resolveSessionRoot(session.identity, [session]);

    expect(resolution).toEqual({
      kind: "known",
      root: session.identity,
    });
    expect(Object.isFrozen(resolution)).toBe(true);
    const frozenRoot = resolution.kind === "known" ? resolution.root : undefined;
    expect(frozenRoot).toBeDefined();
    expect(Object.isFrozen(frozenRoot)).toBe(true);
    expect(Object.isFrozen(frozenRoot?.source)).toBe(true);
  });

  test.each(["parent", "fork", "continuation"] as const)(
    "follows high-confidence %s relations rootward",
    (kind) => {
      const root = evidence("root");
      const session = evidence("session", [relation(kind, root.identity)]);

      expect(resolveSessionRoot(session.identity, [session, root])).toEqual({
        kind: "known",
        root: root.identity,
      });
    },
  );

  test("ignores outward child relations and never infers their inverse", () => {
    const child = evidence("child");
    const session = evidence("session", [relation("child", child.identity, "low")]);

    expect(resolveSessionRoot(session.identity, [session, child])).toEqual({
      kind: "known",
      root: session.identity,
    });
  });

  test.each([
    {
      label: "unknown coverage",
      sessions: [evidence("session", [], "unknown")],
    },
    {
      label: "unknown relation kind",
      sessions: [evidence("session", [relation("unknown", identity("other"))])],
    },
    {
      label: "non-high rootward confidence",
      sessions: [evidence("session", [relation("parent", identity("root"), "medium")])],
    },
    {
      label: "missing retained target",
      sessions: [evidence("session", [relation("parent", identity("missing"))])],
    },
  ])("returns unknown for $label", ({ sessions }) => {
    expect(resolveSessionRoot(identity("session"), sessions)).toEqual({ kind: "unknown" });
  });

  test("returns one known root when multiple ancestry paths converge", () => {
    const root = evidence("root");
    const left = evidence("left", [relation("parent", root.identity)]);
    const right = evidence("right", [relation("continuation", root.identity)]);
    const session = evidence("session", [
      relation("parent", left.identity),
      relation("fork", right.identity),
    ]);

    expect(resolveSessionRoot(session.identity, [session, left, right, root])).toEqual({
      kind: "known",
      root: root.identity,
    });
  });

  test("returns unknown when multiple ancestry paths diverge", () => {
    const left = evidence("left");
    const right = evidence("right");
    const session = evidence("session", [
      relation("parent", left.identity),
      relation("fork", right.identity),
    ]);

    expect(resolveSessionRoot(session.identity, [session, left, right])).toEqual({
      kind: "unknown",
    });
  });

  test("terminates with unknown for direct and indirect cycles", () => {
    const self = evidence("self", [relation("parent", identity("self"))]);
    const left = evidence("left", [relation("parent", identity("right"))]);
    const right = evidence("right", [relation("parent", identity("left"))]);

    expect(resolveSessionRoot(self.identity, [self])).toEqual({ kind: "unknown" });
    expect(resolveSessionRoot(left.identity, [left, right])).toEqual({ kind: "unknown" });
  });

  test("resolves deep ancestry iteratively", () => {
    const sessions = Array.from({ length: 5_000 }, (_, index) =>
      evidence(
        `session-${index}`,
        index === 4_999 ? [] : [relation("parent", identity(`session-${index + 1}`))],
      ),
    );

    expect(resolveSessionRoot(sessions[0]!.identity, sessions)).toEqual({
      kind: "known",
      root: sessions.at(-1)!.identity,
    });
  });

  test("returns unknown for an absent or ambiguously duplicated start", () => {
    const first = evidence("session");
    const duplicate = evidence("session");

    expect(resolveSessionRoot(identity("missing"), [first])).toEqual({ kind: "unknown" });
    expect(resolveSessionRoot(first.identity, [first, duplicate])).toEqual({ kind: "unknown" });
  });

  test("indexes retained evidence once and reuses finalized shared ancestry", () => {
    let retainedIterations = 0;
    let rootRelationIterations = 0;
    const root = evidence(
      "root",
      countedArray([], () => (rootRelationIterations += 1)),
    );
    const left = evidence("left", [relation("parent", root.identity)]);
    const right = evidence("right", [relation("continuation", root.identity)]);
    const retained = countedArray([left, right, root], () => (retainedIterations += 1));

    const resolveRoot = createSessionRootResolver(retained);
    expect(retainedIterations).toBe(1);

    const leftResolution = resolveRoot(left.identity);
    expect(leftResolution).toEqual({ kind: "known", root: root.identity });
    expect(resolveRoot(right.identity)).toEqual({ kind: "known", root: root.identity });
    expect(resolveRoot(root.identity)).toEqual({ kind: "known", root: root.identity });
    expect(resolveRoot(left.identity)).toBe(leftResolution);
    expect(retainedIterations).toBe(1);
    expect(rootRelationIterations).toBe(1);
  });

  test("keeps shared memo results independent of resolution order", () => {
    const root = evidence("root");
    const convergentLeft = evidence("convergent-left", [relation("parent", root.identity)]);
    const convergentRight = evidence("convergent-right", [relation("continuation", root.identity)]);
    const convergent = evidence("convergent", [
      relation("parent", convergentLeft.identity),
      relation("fork", convergentRight.identity),
    ]);
    const divergent = evidence("divergent", [
      relation("parent", root.identity),
      relation("fork", identity("other-root")),
    ]);
    const otherRoot = evidence("other-root");
    const cycleLeft = evidence("cycle-left", [relation("parent", identity("cycle-right"))]);
    const cycleRight = evidence("cycle-right", [relation("parent", cycleLeft.identity)]);
    const sessions = [
      root,
      convergentLeft,
      convergentRight,
      convergent,
      divergent,
      otherRoot,
      cycleLeft,
      cycleRight,
    ];

    const forward = resolutionsByNativeId(sessions, sessions);
    const reverse = resolutionsByNativeId([...sessions].reverse(), sessions);

    expect(reverse).toEqual(forward);
    expect(forward.get("convergent")).toEqual({ kind: "known", root: root.identity });
    expect(forward.get("divergent")).toEqual({ kind: "unknown" });
    expect(forward.get("cycle-left")).toEqual({ kind: "unknown" });
    expect(forward.get("cycle-right")).toEqual({ kind: "unknown" });
  });
});

function resolveSessionRoot(start: SessionIdentity, sessions: readonly SessionLineageEvidence[]) {
  return createSessionRootResolver(sessions)(start);
}

function resolutionsByNativeId(
  order: readonly SessionLineageEvidence[],
  retained: readonly SessionLineageEvidence[],
) {
  const resolveRoot = createSessionRootResolver(retained);
  return new Map(order.map(({ identity: session }) => [session.nativeId, resolveRoot(session)]));
}

function countedArray<T>(values: readonly T[], onIterate: () => void): readonly T[] {
  const result = [...values];
  const iterator = result[Symbol.iterator].bind(result);
  Object.defineProperty(result, Symbol.iterator, {
    value: () => {
      onIterate();
      return iterator();
    },
  });
  return result;
}

function evidence(
  nativeId: string,
  relations: readonly SessionRelation[] = [],
  lineageCoverage: SessionLineageEvidence["lineageCoverage"] = "complete",
): SessionLineageEvidence {
  return { identity: identity(nativeId), lineageCoverage, relations };
}

function identity(nativeId: string): SessionIdentity {
  return { source: { kind: "synthetic", instanceId: "local" }, nativeId };
}

function relation(
  kind: SessionRelation["kind"],
  target: SessionIdentity,
  confidence: OriginConfidence = "high",
): SessionRelation {
  return { kind, target, confidence };
}
