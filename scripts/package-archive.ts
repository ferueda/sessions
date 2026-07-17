import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

export const PACKAGED_SKILL_FILES = Object.freeze(
  [
    "skills/sessions/SKILL.md",
    "skills/sessions/agents/openai.yaml",
    "skills/sessions/references/evidence-protocol.md",
    "skills/sessions/references/search-and-context.md",
    "skills/sessions/references/retrospective.md",
    "skills/sessions/references/preferences.md",
    "skills/sessions/references/workflow-audit.md",
    "skills/sessions/references/verification-audit.md",
    "skills/sessions/references/handoff-continuity.md",
    "skills/sessions/references/capability-discovery.md",
  ].sort(),
);

export interface PackageArchive {
  readonly sha256: string;
  readonly files: readonly string[];
  readonly entries: ReadonlyMap<string, Buffer>;
  readText(relativePath: string): string;
}

export async function readPackageArchive(tarball: string): Promise<PackageArchive> {
  const archive = await readFile(tarball);
  const entries = readTarEntries(archive);
  return Object.freeze({
    sha256: createHash("sha256").update(archive).digest("hex"),
    files: Object.freeze([...entries.keys()].sort()),
    entries,
    readText(relativePath: string): string {
      return readRequiredArchiveEntry(entries, relativePath).toString("utf8");
    },
  });
}

export function assertPackagedSkillEntries(entries: ReadonlyMap<string, Buffer>): void {
  const skill = readRequiredArchiveEntry(entries, "skills/sessions/SKILL.md").toString("utf8");
  const metadata = readRequiredArchiveEntry(entries, "skills/sessions/agents/openai.yaml").toString(
    "utf8",
  );
  if (!/^---\n[\s\S]*?^name: sessions$[\s\S]*?^description: .+$[\s\S]*?^---$/mu.test(skill)) {
    throw new Error("packaged Sessions skill has invalid frontmatter");
  }
  if (!metadata.startsWith("interface:\n") || !/default_prompt: ".*\$sessions.*"/u.test(metadata)) {
    throw new Error("packaged Sessions skill has invalid interface metadata");
  }
  for (const match of skill.matchAll(/\[[^\]]+\]\((references\/[^)]+)\)/gu)) {
    const target = match[1];
    if (target === undefined || !entries.has(`skills/sessions/${target}`)) {
      throw new Error(`packaged Sessions skill has an unresolved reference: ${String(target)}`);
    }
  }
}

export function normalizePackagePath(file: string): string {
  const normalized = file.replaceAll("\\", "/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`tarball contains an unsafe path: ${file}`);
  }
  return normalized;
}

function readTarEntries(archive: Buffer): ReadonlyMap<string, Buffer> {
  const tar = gunzipSync(archive);
  const entries = new Map<string, Buffer>();
  let offset = 0;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const archivePath = prefix === "" ? name : `${prefix}/${name}`;
    const sizeText = readTarString(header, 124, 12).trim();
    if (!/^[0-7]+$/u.test(sizeText)) throw new Error("tarball contains an invalid entry size");
    const size = Number.parseInt(sizeText, 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("tarball contains a truncated entry");

    if (type === "\0" || type === "0") {
      const relativePath = normalizePackagePath(stripPackagePrefix(archivePath));
      if (entries.has(relativePath)) throw new Error(`tarball repeats ${relativePath}`);
      entries.set(relativePath, Buffer.from(tar.subarray(dataStart, dataEnd)));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const nul = buffer.indexOf(0, start);
  const end = nul >= start && nul < start + length ? nul : start + length;
  return buffer.toString("utf8", start, end);
}

function stripPackagePrefix(file: string): string {
  if (!file.startsWith("package/")) throw new Error("tarball entry is outside package/");
  return file.slice("package/".length);
}

function readRequiredArchiveEntry(
  entries: ReadonlyMap<string, Buffer>,
  relativePath: string,
): Buffer {
  const bytes = entries.get(relativePath);
  if (bytes === undefined) throw new Error(`tarball is missing ${relativePath}`);
  return bytes;
}
