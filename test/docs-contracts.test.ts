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
  "docs/reference/cli-contract.md",
  "docs/contributing/index.md",
  "docs/contributing/architecture.md",
  "docs/contributing/adapter-contract.md",
  "docs/contributing/testing.md",
  "docs/contributing/setup.md",
  "docs/contributing/commands.md",
  "docs/decisions/README.md",
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
});

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
