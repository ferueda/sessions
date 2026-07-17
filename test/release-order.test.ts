import { describe, expect, test } from "vitest";

import {
  classifyReleaseRoute,
  compareVersions,
  computeArtifactIntegrity,
  computeArtifactSha256,
  decideReleaseOrder,
  validateArtifactReport,
} from "../scripts/release-order.ts";

const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;

describe("release event routing", () => {
  test("qualifies bootstrap dispatch without making it a release target", () => {
    expect(
      classifyReleaseRoute({
        eventName: "workflow_dispatch",
        ref: "refs/heads/main",
        bootstrapRequested: true,
        previousManifestVersion: null,
        currentManifestVersion: "0.0.0",
        packageVersion: "0.0.0",
        changelog: "# Changelog\n",
      }),
    ).toEqual({
      qualify: true,
      releaseTarget: false,
      mode: "bootstrap",
      version: "0.0.0",
      parentVersion: "",
      reason: "bootstrap-qualification",
    });
  });

  test("never treats the initial manifest seed as a release target", () => {
    expect(
      classifyReleaseRoute({
        eventName: "push",
        ref: "refs/heads/main",
        bootstrapRequested: false,
        previousManifestVersion: null,
        currentManifestVersion: "0.0.0",
        packageVersion: "0.0.0",
        changelog: "# Changelog\n",
      }),
    ).toMatchObject({
      qualify: false,
      releaseTarget: false,
      reason: "manifest-seed",
    });
  });

  test("routes only an aligned supported manifest change", () => {
    expect(
      classifyReleaseRoute({
        eventName: "push",
        ref: "refs/heads/main",
        bootstrapRequested: false,
        previousManifestVersion: "0.0.0",
        currentManifestVersion: "0.1.0",
        packageVersion: "0.1.0",
        changelog: "# Changelog\n\n## [0.1.0](https://example.invalid) (2026-07-17)\n",
      }),
    ).toEqual({
      qualify: true,
      releaseTarget: true,
      mode: "supported",
      version: "0.1.0",
      parentVersion: "0.0.0",
      reason: "release-target",
    });
  });

  test("rejects manual, version, and changelog drift", () => {
    expect(() =>
      classifyReleaseRoute({
        eventName: "workflow_dispatch",
        ref: "refs/heads/feature",
        bootstrapRequested: true,
        previousManifestVersion: null,
        currentManifestVersion: "0.0.0",
        packageVersion: "0.0.0",
        changelog: "# Changelog\n",
      }),
    ).toThrow("main branch");
    expect(() =>
      classifyReleaseRoute({
        eventName: "push",
        ref: "refs/heads/main",
        bootstrapRequested: false,
        previousManifestVersion: "0.0.0",
        currentManifestVersion: "0.1.0",
        packageVersion: "0.1.1",
        changelog: "# Changelog\n\n## 0.1.0\n",
      }),
    ).toThrow("versions do not match");
    expect(() =>
      classifyReleaseRoute({
        eventName: "push",
        ref: "refs/heads/main",
        bootstrapRequested: false,
        previousManifestVersion: "0.0.0",
        currentManifestVersion: "0.1.0",
        packageVersion: "0.1.0",
        changelog: "# Changelog\n",
      }),
    ).toThrow("missing from CHANGELOG");
  });
});

describe("npm release ordering", () => {
  test("accepts the one bootstrap-to-supported transition", () => {
    expect(
      decideReleaseOrder({
        parentVersion: "0.0.0",
        targetVersion: "0.1.0",
        latestVersion: null,
        bootstrapVersion: "0.0.0",
        targetIntegrity: null,
        qualifiedIntegrity: integrity,
      }),
    ).toEqual({ action: "publish" });
  });

  test("publishes only after the registry parent", () => {
    expect(
      decideReleaseOrder({
        parentVersion: "0.2.0",
        targetVersion: "0.3.0",
        latestVersion: "0.2.0",
        bootstrapVersion: "0.0.0",
        targetIntegrity: null,
        qualifiedIntegrity: integrity,
      }),
    ).toEqual({ action: "publish" });

    expect(() =>
      decideReleaseOrder({
        parentVersion: "0.2.0",
        targetVersion: "0.3.0",
        latestVersion: "0.1.0",
        bootstrapVersion: "0.0.0",
        targetIntegrity: null,
        qualifiedIntegrity: integrity,
      }),
    ).toThrow("does not match the release parent");
  });

  test("makes an exact publication retry a no-op", () => {
    expect(
      decideReleaseOrder({
        parentVersion: "0.2.0",
        targetVersion: "0.3.0",
        latestVersion: "0.3.0",
        bootstrapVersion: "0.0.0",
        targetIntegrity: integrity,
        qualifiedIntegrity: integrity,
      }),
    ).toEqual({ action: "verify" });
  });

  test("verifies a stale retry without moving latest backward", () => {
    expect(
      decideReleaseOrder({
        parentVersion: "0.2.0",
        targetVersion: "0.3.0",
        latestVersion: "0.4.0",
        bootstrapVersion: "0.0.0",
        targetIntegrity: integrity,
        qualifiedIntegrity: integrity,
      }),
    ).toEqual({ action: "stale-verify", latestVersion: "0.4.0" });
  });

  test("rejects absent out-of-order targets and integrity conflicts", () => {
    expect(() =>
      decideReleaseOrder({
        parentVersion: "0.2.0",
        targetVersion: "0.3.0",
        latestVersion: "0.4.0",
        bootstrapVersion: "0.0.0",
        targetIntegrity: null,
        qualifiedIntegrity: integrity,
      }),
    ).toThrow("target is absent");

    expect(() =>
      decideReleaseOrder({
        parentVersion: "0.2.0",
        targetVersion: "0.3.0",
        latestVersion: "0.3.0",
        bootstrapVersion: "0.0.0",
        targetIntegrity: `sha512-${Buffer.alloc(64, 2).toString("base64")}`,
        qualifiedIntegrity: integrity,
      }),
    ).toThrow("integrity conflicts");
  });

  test("uses SemVer ordering and npm-compatible artifact integrity", () => {
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(computeArtifactIntegrity(Buffer.from("sessions"))).toMatch(/^sha512-/u);
    expect(computeArtifactSha256(Buffer.from("sessions"))).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("release artifact workflow output", () => {
  test("accepts bootstrap without inventing a supported tag", () => {
    expect(
      validateArtifactReport({
        schemaVersion: 1,
        mode: "bootstrap",
        version: "0.0.0",
        tagName: null,
        filename: "ferueda-sessions-0.0.0.tgz",
        tarballPath: "/tmp/ferueda-sessions-0.0.0.tgz",
        sha256: "a".repeat(64),
      }),
    ).toEqual({
      version: "0.0.0",
      tagName: "",
      filename: "ferueda-sessions-0.0.0.tgz",
      sha256: "a".repeat(64),
    });
  });

  test("requires the exact supported tag", () => {
    expect(
      validateArtifactReport({
        schemaVersion: 1,
        mode: "supported",
        version: "0.1.0",
        tagName: "v0.1.0",
        filename: "ferueda-sessions-0.1.0.tgz",
        tarballPath: "/tmp/ferueda-sessions-0.1.0.tgz",
        sha256: "b".repeat(64),
      }),
    ).toMatchObject({ tagName: "v0.1.0" });
    expect(() =>
      validateArtifactReport({
        schemaVersion: 1,
        mode: "supported",
        version: "0.1.0",
        tagName: null,
        filename: "ferueda-sessions-0.1.0.tgz",
        tarballPath: "/tmp/ferueda-sessions-0.1.0.tgz",
        sha256: "b".repeat(64),
      }),
    ).toThrow("invalid");
  });
});
