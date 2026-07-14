import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface CiChangeScopeOptions {
  readonly cwd: string;
  readonly eventName: string;
  readonly baseSha: string;
  readonly headSha: string;
}

export function classifyDocumentationOnlyChanges(options: CiChangeScopeOptions): boolean {
  try {
    if (
      options.baseSha.length === 0 ||
      options.headSha.length === 0 ||
      runGit(options.cwd, ["cat-file", "-e", `${options.baseSha}^{commit}`]) === undefined ||
      runGit(options.cwd, ["cat-file", "-e", `${options.headSha}^{commit}`]) === undefined
    ) {
      return false;
    }

    const range =
      options.eventName === "pull_request"
        ? `${options.baseSha}...${options.headSha}`
        : `${options.baseSha}..${options.headSha}`;
    const output = runGit(options.cwd, ["diff", "--no-renames", "--name-only", "-z", range]);
    if (output === undefined) return false;

    const files = output.toString("utf8").split("\0").filter(Boolean);
    return files.length > 0 && files.every((file) => file.endsWith(".md"));
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: readonly string[]): Buffer | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.error === undefined ? result.stdout : undefined;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const output = process.env.GITHUB_OUTPUT;
  if (output === undefined) throw new Error("GITHUB_OUTPUT is required");

  const docsOnly = classifyDocumentationOnlyChanges({
    cwd: process.cwd(),
    eventName: process.env.EVENT_NAME ?? "",
    baseSha: process.env.BASE_SHA ?? "",
    headSha: process.env.HEAD_SHA ?? "",
  });
  appendFileSync(output, `docs_only=${String(docsOnly)}\n`, "utf8");
}
