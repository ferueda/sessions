import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("Release Please configuration", () => {
  test("has one root Node package with aligned release metadata and tag policy", async () => {
    const [configText, manifestText, packageText, changelog, formatterText] = await Promise.all([
      readFile(path.join(root, "release-please-config.json"), "utf8"),
      readFile(path.join(root, ".release-please-manifest.json"), "utf8"),
      readFile(path.join(root, "package.json"), "utf8"),
      readFile(path.join(root, "CHANGELOG.md"), "utf8"),
      readFile(path.join(root, ".oxfmtrc.json"), "utf8"),
    ]);
    const config = JSON.parse(configText) as Record<string, unknown>;
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const packageManifest = JSON.parse(packageText) as Record<string, unknown>;
    const formatter = JSON.parse(formatterText) as Record<string, unknown>;
    const packages = asRecord(config.packages);
    const rootPackage = asRecord(packages["."]);
    const version = manifest["."];

    expect(Object.keys(packages)).toEqual(["."]);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(packageManifest.version).toBe(version);
    expect(config["bootstrap-sha"]).toBe("601f92462ba24b9529cb90fda342344a22508a90");
    expect(rootPackage["release-type"]).toBe("node");
    expect(rootPackage["initial-version"]).toBe("0.1.0");
    expect(rootPackage["package-name"]).toBe("@ferueda/sessions");
    expect(rootPackage["changelog-path"]).toBe("CHANGELOG.md");
    expect(rootPackage["include-v-in-tag"]).toBe(true);
    expect(rootPackage["include-component-in-tag"]).toBe(false);
    expect(changelog).toContain("unsupported npm bootstrap seed");
    expect(changelog).not.toMatch(/^## (?:\[)?0\.0\.0(?:\]|\s)/mu);
    expect(formatter.ignorePatterns).toEqual(expect.arrayContaining(["CHANGELOG.md"]));
  });

  test("keeps every public release marker aligned with the manifest", async () => {
    const [configText, manifestText] = await Promise.all([
      readFile(path.join(root, "release-please-config.json"), "utf8"),
      readFile(path.join(root, ".release-please-manifest.json"), "utf8"),
    ]);
    const config = JSON.parse(configText) as Record<string, unknown>;
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const packages = asRecord(config.packages);
    const extraFiles = asRecord(packages["."])["extra-files"];
    const expectedPaths = [
      "README.md",
      "SECURITY.md",
      "docs/agent-setup.md",
      "docs/getting-started.md",
      "docs/reference/agent-skill.md",
    ];
    expect(extraFiles).toEqual(expectedPaths.map((file) => ({ type: "generic", path: file })));

    const documents = await Promise.all(
      expectedPaths.map(async (file) => readFile(path.join(root, file), "utf8")),
    );
    for (const document of documents) {
      const markers = [
        ...document.matchAll(
          /(?:Current supported release: |export SESSIONS_VERSION=')(\d+\.\d+\.\d+)(?:' #| <!--) x-release-please-version/gu,
        ),
      ];
      expect(markers).toHaveLength(1);
      expect(markers[0]?.[1]).toBe(manifest["."]);
    }
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
