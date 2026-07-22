import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";
import { describe, expect, test } from "vitest";

import { createProgram, type ProgramOptions } from "../src/cli/program.ts";
import {
  sessionsSkillForwardCases,
  workflowAuditCoverage,
} from "./fixtures/sessions-skill-forward.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillRoot = path.join(root, "skills", "sessions");
const referenceNames = [
  "evidence-protocol.md",
  "search-and-context.md",
  "retrospective.md",
  "preferences.md",
  "workflow-audit.md",
  "verification-audit.md",
  "handoff-continuity.md",
  "capability-discovery.md",
] as const;
const expectedFiles = [
  "SKILL.md",
  "agents/openai.yaml",
  ...referenceNames.map((name) => `references/${name}`),
].sort();

describe("Sessions Agent Skill contracts", () => {
  test("ships one exact, valid skill layout", async () => {
    expect(await relativeFiles(skillRoot)).toEqual(expectedFiles);

    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const frontmatter = /^---\n(?<body>[\s\S]*?)\n---\n/u.exec(skill)?.groups?.body;
    expect(frontmatter).toBeDefined();
    expect(frontmatter).toMatch(/^name: sessions$/mu);
    expect(frontmatter).toMatch(/^description: .{80,1024}$/mu);
    expect(skill.split("\n").length).toBeLessThanOrEqual(80);

    const metadata = await readFile(path.join(skillRoot, "agents", "openai.yaml"), "utf8");
    expect(metadata).toMatch(/^interface:\n/u);
    expect(metadata).toMatch(/^  display_name: "Sessions"$/mu);
    expect(metadata).toMatch(/^  short_description: ".{25,64}"$/mu);
    expect(metadata).toMatch(/^  default_prompt: ".*\$sessions.*"$/mu);
    expect(metadata).not.toMatch(
      /^(?!interface:|  (?:display_name|short_description|default_prompt):).+$/mu,
    );
  });

  test("routes directly to one shared protocol and every playbook", async () => {
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    for (const name of referenceNames) {
      expect(skill).toContain(`references/${name}`);
      await expect(stat(path.join(skillRoot, "references", name))).resolves.toMatchObject({});
    }

    for (const name of referenceNames.filter((name) => name !== "evidence-protocol.md")) {
      const playbook = await readFile(path.join(skillRoot, "references", name), "utf8");
      expect(playbook).toContain("(evidence-protocol.md)");
      expect(playbook).toMatch(/\*\*Done when:\*\*/u);
      expect(playbook.split("\n").length).toBeLessThanOrEqual(120);
      expect([...playbook.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)].map((match) => match[1])).toEqual([
        "evidence-protocol.md",
      ]);
    }

    const protocol = await readFile(
      path.join(skillRoot, "references", "evidence-protocol.md"),
      "utf8",
    );
    expect(protocol).toMatch(/sessions paths --format json/u);
    expect(protocol).toMatch(
      /paths` proves[\s\S]*readiness, not canonical or FTS[\s\S]*integrity/u,
    );
    expect(protocol).toMatch(/provider-free[\s\S]*source probe fails[\s\S]*Continue/u);
    expect(protocol).toMatch(
      /sessions doctor --format json[\s\S]*explicit full integrity[\s\S]*suspected library damage[\s\S]*post-repair/u,
    );
    expect(protocol).toMatch(/same-snapshot `captureScope`/u);
    expect(protocol).toMatch(
      /explicitly authorizes indexing[\s\S]*reading provider history[\s\S]*writing a durable Sessions-owned copy/u,
    );
    expect(protocol).toMatch(/request for analysis does not authorize indexing/u);
    expect(protocol).toMatch(
      /fixed multi-session cohort[\s\S]*sessions manifest --format json\|jsonl[\s\S]*do not use manifest merely to broaden/u,
    );
    expect(protocol).toMatch(
      /active analysis context or evidence\s+ledger by default[\s\S]*durable local manifest artifact only when the user\s+explicitly requests one/u,
    );
    expect(protocol).toMatch(
      /canonical identity[\s\S]*--expected-document-digest[\s\S]*retry\s+the manifest or explicitly re-key/u,
    );
    expect(protocol).toMatch(/manifest is not a lease or historical pin/u);
    expect(protocol).toMatch(/Do not omit the evidence ledger or\s+limits/u);
    expect(protocol).toMatch(/\*\*Done when:\*\*/u);

    const searchContext = await readFile(
      path.join(skillRoot, "references", "search-and-context.md"),
      "utf8",
    );
    expect(searchContext).toMatch(/sensitive unredacted[\s\S]*truncation or omissions/u);
    expect(searchContext).toMatch(/delivered it to no provider/u);

    const handoff = await readFile(
      path.join(skillRoot, "references", "handoff-continuity.md"),
      "utf8",
    );
    expect(handoff).toMatch(/full source and destination canonical IDs/u);
  });

  test("uses only shipped command paths and flags while preserving safety boundaries", async () => {
    const files = await Promise.all(
      expectedFiles.map((file) => readFile(path.join(skillRoot, file), "utf8")),
    );
    const contents = files.join("\n");

    const surface = shippedCliSurface();
    const examples = extractCommandExamples(contents);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(surface.has(example.path), `unshipped command: ${example.raw}`).toBe(true);
      const commandFlags = surface.get(example.path) ?? new Set<string>();
      expect(
        example.flags.filter((flag) => !commandFlags.has(flag)),
        `unshipped flag for ${example.path}: ${example.raw}`,
      ).toEqual([]);
    }

    const shippedFlags = new Set([...surface.values()].flatMap((flags) => [...flags]));
    const mentionedFlags = new Set(
      [...contents.matchAll(/--[a-z][a-z-]*/gu)].map(([flag]) => flag),
    );
    expect([...mentionedFlags].filter((flag) => !shippedFlags.has(flag))).toEqual([]);

    expect(contents).not.toMatch(/sessions (?:analyze|cursor|codex (?:list|show|reindex))/u);
    expect(contents).not.toMatch(/\/Users\/[^/]+|[A-Za-z]:\\Users\\/u);
    expect(contents).not.toMatch(
      /semantic search|Sessions automatically|automatically (?:creates?|sends?|uploads?)/iu,
    );
    expect(contents).toMatch(/sessions index --source <authorized-source>/u);
    expect(contents).toMatch(/explicitly authorizes indexing/u);
    expect(contents).not.toMatch(/authorized provider reading/u);
    expect(contents).toMatch(/user-requested deletion of Sessions-owned data/u);
    expect(contents).toMatch(/Do not automatically edit projects/u);
  });

  test("keeps all accepted forward routes and audit controls evaluator-owned", () => {
    expect(sessionsSkillForwardCases.map(({ route }) => route).sort()).toEqual(
      referenceNames.filter((name) => name !== "evidence-protocol.md").sort(),
    );
    expect(new Set(sessionsSkillForwardCases.map(({ id }) => id)).size).toBe(7);
    expect(workflowAuditCoverage).toEqual(
      expect.arrayContaining([
        "appropriate-use",
        "missed-use",
        "unnecessary-use",
        "correct-non-use",
        "historical-version-unavailable",
        "invocation-unknown",
        "unknown-lineage",
        "followed-process-poor-outcome",
        "unfollowed-process-good-outcome",
        "no-finding-control",
      ]),
    );
  });
});

async function relativeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return (await relativeFiles(entryPath)).map((file) => path.posix.join(entry.name, file));
      }
      return entry.isFile() ? [entry.name] : [];
    }),
  );
  return files.flat().sort();
}

function shippedCliSurface(): ReadonlyMap<string, ReadonlySet<string>> {
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error("command handlers are not used by this contract"));
  const options: ProgramOptions = {
    version: "0.0.0",
    output: { writeOut: () => undefined, writeErr: () => undefined },
    doctor: unavailable,
    paths: unavailable,
    indexSources: ["codex"],
    index: unavailable,
    list: unavailable,
    manifest: unavailable,
    entries: unavailable,
    search: unavailable,
    show: unavailable,
    export: unavailable,
    forget: unavailable,
    clearData: unavailable,
    compactData: unavailable,
    repairOrphanedData: unavailable,
  };
  const surface = new Map<string, ReadonlySet<string>>();
  visitCommands(createProgram(options), [], surface);
  return surface;
}

function visitCommands(
  parent: Command,
  parentPath: readonly string[],
  surface: Map<string, ReadonlySet<string>>,
): void {
  for (const command of parent.commands) {
    const pathParts = [...parentPath, command.name()];
    surface.set(
      pathParts.join(" "),
      new Set(
        command.options
          .map(({ long }) => long)
          .filter((flag): flag is string => flag !== undefined && flag.length > 0),
      ),
    );
    visitCommands(command, pathParts, surface);
  }
}

function extractCommandExamples(contents: string): readonly {
  readonly raw: string;
  readonly path: string;
  readonly flags: readonly string[];
}[] {
  return [...contents.matchAll(/`(?<command>sessions\s+[^`]+)`/gu)].map((match) => {
    const raw = match.groups?.command?.replace(/\s+/gu, " ").trim();
    if (raw === undefined) throw new Error("command example has no body");
    const tokens = raw.split(" ");
    const first = tokens[1];
    if (first === undefined) throw new Error(`command example has no path: ${raw}`);
    const second = tokens[2];
    const commandPath = first === "data" ? `${first} ${second ?? ""}`.trim() : first;
    return {
      raw,
      path: commandPath,
      flags: tokens.filter((token) => token !== "--" && token.startsWith("--")),
    };
  });
}
