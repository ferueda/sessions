import { describe, expect, test } from "vitest";

import type { SourceInputDescriptor } from "../../src/application/ports/session-source.ts";
import {
  createDiscoveredSession,
  fingerprintSourceInputs,
  verifySourceInputFingerprint,
} from "../../src/application/source-input-fingerprint.ts";

const identity = {
  source: { kind: "synthetic", instanceId: "default" },
  nativeId: "session-1",
} as const;

describe("source input fingerprints", () => {
  test("hashes ordered canonical tuples for every input", () => {
    const inputs = sourceInputs();

    const fingerprint = fingerprintSourceInputs(inputs);

    expect(fingerprint).toEqual({
      scheme: "sha256-json-v1",
      digest: "5d09328cb1244800e2129f5d7e990bf3e34e6336c1cc592ed2aff32326ecb37c",
    });
  });

  test.each([
    ["order", (inputs: SourceInputDescriptor[]) => inputs.reverse()],
    ["role", (inputs: SourceInputDescriptor[]) => replaceInput(inputs, 0, { role: "events" })],
    [
      "locator URI",
      (inputs: SourceInputDescriptor[]) =>
        replaceInput(inputs, 0, { locator: { uri: "file:///other.jsonl" } }),
    ],
    [
      "record ID",
      (inputs: SourceInputDescriptor[]) =>
        replaceInput(inputs, 1, {
          locator: { uri: "sqlite:///metadata.db", recordId: "row-2" },
        }),
    ],
    [
      "input fingerprint",
      (inputs: SourceInputDescriptor[]) => replaceInput(inputs, 0, { fingerprint: "sha256:b" }),
    ],
  ])("invalidates when %s changes", (_label, mutate) => {
    const original = fingerprintSourceInputs(sourceInputs());
    const changedInputs = sourceInputs();

    mutate(changedInputs);

    expect(fingerprintSourceInputs(changedInputs)).not.toEqual(original);
  });

  test("keeps adapter version separate from the input aggregate", () => {
    const first = createDiscoveredSession({
      identity,
      inputs: sourceInputs(),
      adapterVersion: "1",
    });
    const second = createDiscoveredSession({
      identity,
      inputs: sourceInputs(),
      adapterVersion: "2",
    });

    expect(second.aggregateFingerprint).toEqual(first.aggregateFingerprint);
    expect(second.adapterVersion).not.toBe(first.adapterVersion);
  });

  test("uses tuple serialization without delimiter ambiguity", () => {
    const first = fingerprintSourceInputs([
      { role: "a", locator: { uri: "bc" }, fingerprint: "d" },
    ]);
    const second = fingerprintSourceInputs([
      { role: "ab", locator: { uri: "c" }, fingerprint: "d" },
    ]);

    expect(first).not.toEqual(second);
  });

  test("copies inputs and verifies the stored aggregate", () => {
    const inputs = sourceInputs();
    const candidate = createDiscoveredSession({ identity, inputs, adapterVersion: "1" });

    inputs[0] = { ...inputs[0]!, fingerprint: "changed-after-construction" };

    expect(candidate.inputs[0]?.fingerprint).toBe("sha256:a");
    expect(verifySourceInputFingerprint(candidate)).toBe(true);
    expect(
      verifySourceInputFingerprint({
        ...candidate,
        inputs: [
          { ...candidate.inputs[0]!, fingerprint: "tampered" },
          ...candidate.inputs.slice(1),
        ],
      }),
    ).toBe(false);
  });

  test("rejects empty or ill-formed descriptors", () => {
    expect(() => createDiscoveredSession({ identity, inputs: [], adapterVersion: "1" })).toThrow(
      TypeError,
    );
    expect(() =>
      createDiscoveredSession({
        identity,
        inputs: [{ role: "transcript", locator: { uri: "file:///ok" }, fingerprint: "\ud800" }],
        adapterVersion: "1",
      }),
    ).toThrow(TypeError);
  });
});

function sourceInputs(): SourceInputDescriptor[] {
  return [
    {
      role: "transcript",
      locator: { uri: "file:///session.jsonl" },
      fingerprint: "sha256:a",
    },
    {
      role: "metadata",
      locator: { uri: "sqlite:///metadata.db", recordId: "row-1" },
      fingerprint: "row-version:1",
    },
  ];
}

function replaceInput(
  inputs: SourceInputDescriptor[],
  index: number,
  replacement: Partial<SourceInputDescriptor>,
): void {
  inputs[index] = { ...inputs[index]!, ...replacement };
}
