import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("Release Please configuration", () => {
  test("has one root Node package with the pre-release seed and tag policy", async () => {
    const [configText, manifestText, changelog] = await Promise.all([
      readFile(path.join(root, "release-please-config.json"), "utf8"),
      readFile(path.join(root, ".release-please-manifest.json"), "utf8"),
      readFile(path.join(root, "CHANGELOG.md"), "utf8"),
    ]);
    const config = JSON.parse(configText) as Record<string, unknown>;
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const packages = asRecord(config.packages);
    const rootPackage = asRecord(packages["."]);

    expect(Object.keys(packages)).toEqual(["."]);
    expect(manifest).toEqual({ ".": "0.0.0" });
    expect(config["bootstrap-sha"]).toBe("601f92462ba24b9529cb90fda342344a22508a90");
    expect(rootPackage["release-type"]).toBe("node");
    expect(rootPackage["package-name"]).toBe("@ferueda/sessions");
    expect(rootPackage["changelog-path"]).toBe("CHANGELOG.md");
    expect(rootPackage["include-v-in-tag"]).toBe(true);
    expect(rootPackage["include-component-in-tag"]).toBe(false);
    expect(changelog).toContain("unsupported npm bootstrap seed");
    expect(changelog).not.toMatch(/^## (?:\[)?0\.0\.0(?:\]|\s)/mu);
  });

  test("gives Release Please exactly one agent-setup version marker", async () => {
    const [configText, manifestText, guide] = await Promise.all([
      readFile(path.join(root, "release-please-config.json"), "utf8"),
      readFile(path.join(root, ".release-please-manifest.json"), "utf8"),
      readFile(path.join(root, "docs/agent-setup.md"), "utf8"),
    ]);
    const config = JSON.parse(configText) as Record<string, unknown>;
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const packages = asRecord(config.packages);
    const extraFiles = asRecord(packages["."])["extra-files"];

    expect(extraFiles).toEqual([{ type: "generic", path: "docs/agent-setup.md" }]);
    const markers = [
      ...guide.matchAll(
        /Supported CLI\/skill release: (\d+\.\d+\.\d+) <!-- x-release-please-version -->/gu,
      ),
    ];
    expect(markers).toHaveLength(1);
    expect(markers[0]?.[1]).toBe(manifest["."]);
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
