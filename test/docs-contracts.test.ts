import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const requiredDocs = [
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/project-intent.md",
  "docs/architecture-memo.md",
  "docs/privacy.md",
  "docs/getting-started.md",
  "docs/agent-setup.md",
  "docs/troubleshooting.md",
  "docs/reference/agent-skill.md",
  "docs/reference/cli-contract.md",
  "docs/reference/structured-output.md",
  "docs/contributing/index.md",
  "docs/contributing/architecture.md",
  "docs/contributing/adapter-contract.md",
  "docs/contributing/testing.md",
  "docs/contributing/setup.md",
  "docs/contributing/commands.md",
  "docs/contributing/releasing.md",
  "docs/decisions/README.md",
  "docs/decisions/0009-establish-the-supported-release-baseline.md",
  "docs/decisions/0010-install-sessions-directly-into-local-agent-hosts.md",
];

describe("documentation contracts", () => {
  test("keeps the durable project map present", async () => {
    const results = await Promise.all(
      requiredDocs.map(async (file) => ({ file, info: await stat(path.join(root, file)) })),
    );

    expect(results.every(({ info }) => info.isFile())).toBe(true);
  });

  test("keeps contributor-machine paths out of durable docs", async () => {
    const markdownFiles = await findMarkdownFiles(root);
    const contents = await Promise.all(markdownFiles.map((file) => readFile(file, "utf8")));

    expect(contents.join("\n")).not.toMatch(/\/Users\/[^/]+|[A-Za-z]:\\Users\\/u);
  });

  test("keeps relative Markdown links resolvable", async () => {
    const markdownFiles = await findMarkdownFiles(root);
    const missing: string[] = [];

    for (const file of markdownFiles) {
      const contents = await readFile(file, "utf8");
      for (const match of contents.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        const target = match[1];
        if (!target || /^(?:https?:|mailto:|#)/u.test(target)) continue;
        const pathname = decodeURIComponent(target.split("#", 1)[0] ?? "");
        if (pathname.length === 0) continue;

        try {
          await stat(path.resolve(path.dirname(file), pathname));
        } catch {
          missing.push(`${path.relative(root, file)} -> ${target}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  test("keeps the root agent map concise", async () => {
    const agents = await readFile(path.join(root, "AGENTS.md"), "utf8");

    expect(agents.split("\n").length).toBeLessThanOrEqual(100);
  });

  test("keeps standalone installation as the active host boundary", async () => {
    const [architecture, decisions, superseded, replacement] = await Promise.all([
      readFile(path.join(root, "docs/architecture-memo.md"), "utf8"),
      readFile(path.join(root, "docs/decisions/README.md"), "utf8"),
      readFile(
        path.join(root, "docs/decisions/0005-keep-one-way-ownership-with-harness.md"),
        "utf8",
      ),
      readFile(
        path.join(root, "docs/decisions/0010-install-sessions-directly-into-local-agent-hosts.md"),
        "utf8",
      ),
    ]);

    expect(architecture).toContain(
      "No downstream repository owns a Sessions wrapper, package pin, vendored",
    );
    expect(architecture).not.toContain("Harness keeps a thin pinned integration");
    expect(superseded).toContain("- Status: Superseded");
    expect(superseded).toContain("0010-install-sessions-directly-into-local-agent-hosts.md");
    expect(replacement).toContain("- Status: Accepted");
    expect(replacement).toContain("Supersedes: [0005");
    expect(replacement).toContain("No downstream repository owns a Sessions wrapper");
    expect(decisions).toContain("0010-install-sessions-directly-into-local-agent-hosts.md");
  });

  test("keeps onboarding aligned with the release manifest", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, ".release-please-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    const version = manifest["."];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/u);
    if (typeof version !== "string") throw new Error("root release version must be a string");

    const [readme, gettingStarted, agentSetup, agentSkill, security] = await Promise.all([
      readFile(path.join(root, "README.md"), "utf8"),
      readFile(path.join(root, "docs/getting-started.md"), "utf8"),
      readFile(path.join(root, "docs/agent-setup.md"), "utf8"),
      readFile(path.join(root, "docs/reference/agent-skill.md"), "utf8"),
      readFile(path.join(root, "SECURITY.md"), "utf8"),
    ]);
    const assertOnboarding = isSupportedRelease(version)
      ? assertSupportedOnboarding
      : assertBootstrapOnboarding;
    assertOnboarding({ version, readme, gettingStarted, agentSetup, agentSkill, security });
  });
});

interface OnboardingDocuments {
  readonly version: string;
  readonly readme: string;
  readonly gettingStarted: string;
  readonly agentSetup: string;
  readonly agentSkill: string;
  readonly security: string;
}

function assertSupportedOnboarding(documents: OnboardingDocuments): void {
  const versionExport = `export SESSIONS_VERSION='${documents.version}'`;
  const install = 'npm install --global "@ferueda/sessions@${SESSIONS_VERSION}"';
  expect(documents.readme).toContain(versionExport);
  expect(documents.readme).toContain(install);
  expect(documents.gettingStarted).toContain(versionExport);
  expect(documents.gettingStarted).toContain(install);
  expect(documents.agentSetup).toContain("- Status: current");
  expect(documents.agentSetup).toContain(versionExport);
  expect(documents.agentSetup).toContain(install);
  expect(documents.agentSkill).toContain(versionExport);
  expect(documents.agentSkill).toContain(install);
  expect(documents.agentSetup).toContain(
    "https://github.com/ferueda/sessions/tree/v${SESSIONS_VERSION}/skills/sessions",
  );
  expect(`${documents.readme}\n${documents.gettingStarted}`).not.toContain(
    "npm installation remains planned",
  );
  expect(documents.readme).not.toContain("pnpm install --frozen-lockfile");
  expect(documents.readme).not.toContain("git clone https://github.com/ferueda/sessions.git");
  expect(documents.readme).not.toContain("Pre-alpha builds recognize");
  expect(documents.gettingStarted).not.toContain("pnpm install --frozen-lockfile");
  expect(documents.gettingStarted).not.toContain("install is from a source checkout");
  expect(documents.gettingStarted).not.toContain("npm package is not published yet");
  expect(documents.agentSkill).not.toContain("public release route is planned");
  expect(documents.agentSkill).not.toMatch(/From a Sessions source\s+checkout/u);
  expect(documents.security).toContain(
    "Security fixes target supported Sessions releases beginning with `0.1.0`",
  );
  expect(documents.security).toContain(`Current supported release: ${documents.version}`);
  expect(documents.security).not.toContain("target the current `main` branch");
}

function assertBootstrapOnboarding(documents: OnboardingDocuments): void {
  expect(documents.version).toBe("0.0.0");
  expect(documents.readme).toContain("npm installation remains planned");
  expect(documents.gettingStarted).toContain("current pre-alpha install is from a source checkout");
  expect(documents.readme).toContain("pnpm install --frozen-lockfile");
  expect(documents.readme).toContain("git clone https://github.com/ferueda/sessions.git");
  expect(documents.gettingStarted).toContain("pnpm install --frozen-lockfile");
  expect(documents.agentSetup).toContain("- Status: planned while the release manifest is `0.0.0`");
  expect(documents.agentSkill).toMatch(/public release route is planned until\s+`0\.1\.0`/u);
  expect(documents.agentSkill).toMatch(/From a Sessions source\s+checkout/u);
  expect(documents.security).toContain("target the current `main` branch");
  expect(documents.security).toContain("unsupported `0.0.0`");
}

function isSupportedRelease(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > 0 || minor > 0;
}

async function findMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      if ([".git", ".harness", "dist", "node_modules"].includes(entry.name)) return [];
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findMarkdownFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
    }),
  );
  return files.flat().sort();
}
