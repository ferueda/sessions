import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  assertArtifactDigest,
  assertCheckoutUnchanged,
  assertInstallOutputHasNoWarnings,
  assertNpmOutputHasNoCorrections,
  assertPackageInventory,
  assertReleaseMetadata,
  assertReleaseTag,
  assertSafePublishedManifest,
  inspectPackageArtifact,
  PACKAGED_SKILL_FILES,
  parsePackageManifest,
  runCommand,
} from "../scripts/package-artifact.ts";

const VERSION = "0.1.0";
const RELEASE_SHA = "a".repeat(40);
const EXACT_FILES = [
  "LICENSE",
  "README.md",
  "package.json",
  "dist/bin/sessions.js",
  ...PACKAGED_SKILL_FILES,
].sort();

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("package release artifact contract", () => {
  test("accepts only the normalized executable and no install lifecycle hooks", () => {
    const manifest = parsePackageManifest(
      JSON.stringify({
        name: "@ferueda/sessions",
        version: VERSION,
        bin: { sessions: "dist/bin/sessions.js" },
        scripts: { prepack: "pnpm build" },
      }),
    );

    expect(() => assertSafePublishedManifest(manifest, VERSION)).not.toThrow();
    expect(() =>
      assertSafePublishedManifest({ ...manifest, bin: { sessions: "./dist/bin/sessions.js" } }),
    ).toThrow(/executable mapping/u);
    expect(() =>
      assertSafePublishedManifest({ ...manifest, scripts: { prepare: "simple-git-hooks" } }),
    ).toThrow(/install lifecycle scripts: prepare/u);
  });

  test("keeps an exact compiled, public-root, and ten-file skill inventory", () => {
    expect(() => assertPackageInventory(EXACT_FILES)).not.toThrow();
    expect(() => assertPackageInventory([...EXACT_FILES, "src/bin/sessions.ts"])).toThrow(
      /unexpected file/u,
    );
    expect(() =>
      assertPackageInventory(
        EXACT_FILES.filter((file) => file !== "skills/sessions/references/verification-audit.md"),
      ),
    ).toThrow(/wrong skill files/u);
    expect(() =>
      assertPackageInventory(EXACT_FILES.filter((file) => file !== "dist/bin/sessions.js")),
    ).toThrow(/missing dist\/bin\/sessions\.js/u);
  });

  test("separates unsupported bootstrap metadata from supported releases", () => {
    expect(
      assertReleaseMetadata({
        mode: "bootstrap",
        packageVersion: "0.0.0",
        manifestVersion: "0.0.0",
        changelog: "# Changelog\n",
      }),
    ).toEqual({ version: "0.0.0", tagName: null });
    expect(() =>
      assertReleaseMetadata({
        mode: "bootstrap",
        packageVersion: "0.0.0",
        manifestVersion: "0.0.0",
        changelog: "# Changelog\n\n## [0.0.0] - 2026-07-17\n",
      }),
    ).toThrow(/rejects supported changelog/u);

    expect(
      assertReleaseMetadata({
        mode: "supported",
        packageVersion: VERSION,
        manifestVersion: VERSION,
        changelog: `# Changelog\n\n## [${VERSION}](https://example.invalid) - 2026-07-17\n`,
      }),
    ).toEqual({ version: VERSION, tagName: `v${VERSION}` });
    expect(() =>
      assertReleaseMetadata({
        mode: "supported",
        packageVersion: VERSION,
        manifestVersion: "0.2.0",
        changelog: `## [${VERSION}]\n`,
      }),
    ).toThrow(/versions differ/u);
    expect(() =>
      assertReleaseMetadata({
        mode: "supported",
        packageVersion: VERSION,
        manifestVersion: VERSION,
        changelog: "# Changelog\n",
      }),
    ).toThrow(/no release/u);
    expect(() =>
      assertReleaseMetadata({
        mode: "supported",
        packageVersion: "0.0.1",
        manifestVersion: "0.0.1",
        changelog: "## [0.0.1]\n",
      }),
    ).toThrow(/version 0\.1\.0 or newer/u);
  });

  test("accepts fresh and exact retry tags but rejects absence after release and conflicts", () => {
    const common = {
      mode: "supported" as const,
      releaseSha: RELEASE_SHA,
      tagName: `v${VERSION}`,
    };
    expect(() =>
      assertReleaseTag({ ...common, phase: "before", observation: { kind: "absent" } }),
    ).not.toThrow();
    expect(() =>
      assertReleaseTag({
        ...common,
        phase: "before",
        observation: { kind: "present", commit: RELEASE_SHA },
      }),
    ).not.toThrow();
    expect(() =>
      assertReleaseTag({
        ...common,
        phase: "after",
        observation: { kind: "present", commit: RELEASE_SHA },
      }),
    ).not.toThrow();
    expect(() =>
      assertReleaseTag({ ...common, phase: "after", observation: { kind: "absent" } }),
    ).toThrow(/absent after release creation/u);
    expect(() =>
      assertReleaseTag({
        ...common,
        phase: "before",
        observation: { kind: "present", commit: "b".repeat(40) },
      }),
    ).toThrow(/conflicting commit/u);
  });

  test("keeps bootstrap qualification tagless", () => {
    expect(() =>
      assertReleaseTag({
        mode: "bootstrap",
        phase: "before",
        releaseSha: RELEASE_SHA,
        tagName: null,
        observation: { kind: "absent" },
      }),
    ).not.toThrow();
    expect(() =>
      assertReleaseTag({
        mode: "bootstrap",
        phase: "after",
        releaseSha: RELEASE_SHA,
        tagName: null,
        observation: { kind: "absent" },
      }),
    ).toThrow(/cannot create or require/u);
    expect(() =>
      assertReleaseTag({
        mode: "bootstrap",
        phase: "before",
        releaseSha: RELEASE_SHA,
        tagName: null,
        observation: { kind: "present", commit: RELEASE_SHA },
      }),
    ).toThrow(/rejects a v0\.0\.0/u);
  });

  test("rejects digest drift, npm manifest corrections, warnings, and checkout changes", () => {
    const digest = "c".repeat(64);
    expect(() => assertArtifactDigest(digest, digest)).not.toThrow();
    expect(() => assertArtifactDigest(digest, "d".repeat(64))).toThrow(/does not match/u);
    expect(() => assertArtifactDigest(digest, "bad")).toThrow(/64 lowercase hex/u);

    expect(() =>
      assertNpmOutputHasNoCorrections(
        { status: 0, stdout: "{}", stderr: "npm warn publish auto-corrected errors" },
        "dry run",
      ),
    ).toThrow(/manifest correction/u);
    expect(() =>
      assertInstallOutputHasNoWarnings(
        { status: 0, stdout: "", stderr: "npm warn lifecycle script" },
        "install",
      ),
    ).toThrow(/npm or lifecycle warning/u);
    expect(() => assertCheckoutUnchanged(" M package.json\n", " M package.json\n")).not.toThrow();
    expect(() => assertCheckoutUnchanged("", "?? leaked.tgz\n")).toThrow(/changed/u);
  });

  test("keeps shim checks while preserving workflow arguments across platforms", async () => {
    const smoke = await readFile(
      path.resolve(import.meta.dirname, "../scripts/smoke-release-package.ts"),
      "utf8",
    );

    expect(smoke).toContain('runCommand(shim, ["--help"]');
    expect(smoke).toContain('runCommand(shim, ["--version"]');
    expect(smoke).toMatch(/runCommand\(\s*process\.execPath,\s*\[installedBinary, \.\.\.args\]/u);
    expect(smoke).not.toContain("runCommand(shim, args");
  });

  test("passes multi-word workflow arguments unchanged through Node", async () => {
    const temporaryRoot = await createTemporaryRoot();
    const capture = path.join(temporaryRoot, "capture-arguments.mjs");
    await writeFile(capture, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");

    const result = runCommand(
      process.execPath,
      [capture, "distribution smoke", "--limit", "1"],
      temporaryRoot,
    );

    expect(result).toEqual({
      status: 0,
      stdout: '["distribution smoke","--limit","1"]',
      stderr: "",
    });
  });

  test("reads and validates the normalized manifest and exact skill from a tarball", async () => {
    const temporaryRoot = await createTemporaryRoot();
    const tarball = path.join(temporaryRoot, "sessions.tgz");
    const entries = new Map<string, Buffer>();
    for (const file of EXACT_FILES) {
      entries.set(file, Buffer.from(fixtureFile(file)));
    }
    await writeFile(tarball, createTarball(entries));

    const artifact = await inspectPackageArtifact(tarball);

    expect(artifact.files).toEqual(EXACT_FILES);
    expect(artifact.manifest).toMatchObject({
      name: "@ferueda/sessions",
      version: VERSION,
      bin: { sessions: "dist/bin/sessions.js" },
    });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifact.readText("skills/sessions/SKILL.md")).toContain("name: sessions");
  });

  test("rejects a tarball with an unexpected repository-only file", async () => {
    const temporaryRoot = await createTemporaryRoot();
    const tarball = path.join(temporaryRoot, "sessions.tgz");
    const entries = new Map<string, Buffer>();
    for (const file of [...EXACT_FILES, "test/private-fixture.test.ts"]) {
      entries.set(file, Buffer.from(fixtureFile(file)));
    }
    await writeFile(tarball, createTarball(entries));

    await expect(inspectPackageArtifact(tarball)).rejects.toThrow(/unexpected file/u);
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "sessions-release-contract-"));
  temporaryRoots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function fixtureFile(file: string): string {
  if (file === "package.json") {
    return JSON.stringify({
      name: "@ferueda/sessions",
      version: VERSION,
      bin: { sessions: "dist/bin/sessions.js" },
      scripts: { prepack: "pnpm build" },
    });
  }
  if (file === "skills/sessions/SKILL.md") {
    return `---
name: sessions
description: Inspect sessions
---

[Evidence](references/evidence-protocol.md)
`;
  }
  if (file === "skills/sessions/agents/openai.yaml") {
    return 'interface:\n  default_prompt: "Use $sessions."\n';
  }
  return `fixture for ${file}\n`;
}

function createTarball(entries: ReadonlyMap<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [relativePath, bytes] of entries) {
    const header = Buffer.alloc(512);
    header.write(`package/${relativePath}`, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(" ", 148, 156);
    header[156] = "0".charCodeAt(0);
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
