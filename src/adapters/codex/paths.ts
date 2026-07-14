import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import { readConfiguredSqliteHome } from "./config.ts";

const STATE_FILE = "state_5.sqlite";
const PLAIN_ROLLOUT = /^rollout-.*\.jsonl$/u;

export interface CodexEnvironment {
  readonly cwd: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedCodexPaths {
  readonly codexHome: string;
  readonly sqliteHome: string;
  readonly stateDatabase: string;
  readonly sessionsRoot: string;
  readonly archivedSessionsRoot: string;
  readonly sqliteHomeSelection: "config" | "environment" | "default";
}

export interface RolloutDescriptor {
  readonly status: "ready" | "missing" | "invalid";
  readonly logicalName: string;
  readonly representation: "plain" | "zstd" | "missing" | "invalid";
  readonly root: "sessions" | "archived-sessions" | "none";
  readonly file?: string;
  readonly stat?: RolloutFileStat;
}

export interface RolloutFileStat {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly birthtimeNs: string;
}

export async function resolveCodexPaths(
  environment: CodexEnvironment = captureCodexEnvironment(),
): Promise<ResolvedCodexPaths> {
  const codexHomeInput = nonBlank(environment.env.CODEX_HOME);
  const codexHome = await canonicalRoot(
    codexHomeInput === undefined
      ? resolve(environment.home, ".codex")
      : resolve(environment.cwd, codexHomeInput),
  );
  const configured = await readConfiguredSqliteHome(join(codexHome, "config.toml"));
  const environmentSqlite = nonBlank(environment.env.CODEX_SQLITE_HOME);
  const sqliteHomeSelection =
    configured !== undefined
      ? "config"
      : environmentSqlite !== undefined
        ? "environment"
        : "default";
  const sqliteInput =
    configured !== undefined
      ? resolveConfigPath(configured, codexHome, environment.home)
      : environmentSqlite !== undefined
        ? resolve(environment.cwd, environmentSqlite)
        : codexHome;
  const sqliteHome = await canonicalRoot(sqliteInput);
  const rootState = join(sqliteHome, STATE_FILE);
  const legacyState = join(codexHome, "sqlite", STATE_FILE);
  const stateDatabase =
    sqliteHomeSelection === "default" &&
    !(await pathExists(rootState)) &&
    (await pathExists(legacyState))
      ? legacyState
      : rootState;

  return Object.freeze({
    codexHome,
    sqliteHome,
    stateDatabase,
    sessionsRoot: join(codexHome, "sessions"),
    archivedSessionsRoot: join(codexHome, "archived_sessions"),
    sqliteHomeSelection,
  });
}

export function captureCodexEnvironment(): CodexEnvironment {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home === undefined || home.length === 0) {
    throw new TypeError("A user home is required to resolve Codex paths");
  }
  return { cwd: process.cwd(), home, env: process.env };
}

export async function describeRollout(
  paths: ResolvedCodexPaths,
  rolloutPath: string,
  nativeId: string,
): Promise<RolloutDescriptor> {
  if (!rolloutPath.isWellFormed() || !nativeId.isWellFormed() || nativeId.length === 0) {
    return invalidRollout();
  }
  const requested = isAbsolute(rolloutPath)
    ? normalize(rolloutPath)
    : resolve(paths.codexHome, rolloutPath);
  const requestedName = basename(requested);
  const logicalFile = requestedName.endsWith(".zst") ? requested.slice(0, -4) : requested;
  const logicalName = basename(logicalFile);
  if (!PLAIN_ROLLOUT.test(logicalName) || !logicalName.endsWith(`${nativeId}.jsonl`)) {
    return invalidRollout(logicalName);
  }

  const plain = logicalFile;
  const zstd = `${logicalFile}.zst`;
  const plainFile = await inspectRolloutFile(plain);
  if (plainFile.kind === "invalid") return invalidRollout(logicalName);
  const zstdFile = plainFile.kind === "missing" ? await inspectRolloutFile(zstd) : undefined;
  if (zstdFile?.kind === "invalid") return invalidRollout(logicalName);
  const selected =
    plainFile.kind === "ready" ? plainFile : zstdFile?.kind === "ready" ? zstdFile : undefined;
  if (selected === undefined) {
    const containment = await classifyContainedParent(paths, dirname(logicalFile));
    return containment === "none"
      ? invalidRollout(logicalName)
      : Object.freeze({
          status: "missing",
          logicalName,
          representation: "missing",
          root: containment,
        });
  }

  const root = await classifyContainedPath(paths, selected.file);
  if (root === "none") return invalidRollout(logicalName);
  return Object.freeze({
    status: "ready",
    logicalName,
    representation: selected.file.endsWith(".zst") ? "zstd" : "plain",
    root,
    file: selected.file,
    stat: selected.stat,
  });
}

export function rolloutDescriptorTuple(descriptor: RolloutDescriptor): readonly unknown[] {
  return Object.freeze([
    "codex-rollout-v1",
    descriptor.logicalName,
    descriptor.status,
    descriptor.representation,
    descriptor.root,
    descriptor.stat === undefined
      ? null
      : [
          descriptor.stat.dev,
          descriptor.stat.ino,
          descriptor.stat.mode,
          descriptor.stat.size,
          descriptor.stat.mtimeNs,
          descriptor.stat.ctimeNs,
          descriptor.stat.birthtimeNs,
        ],
  ]);
}

async function canonicalRoot(value: string): Promise<string> {
  const absolute = normalize(value);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (isMissing(error)) return absolute;
    throw error;
  }
}

function resolveConfigPath(value: string, codexHome: string, home: string): string {
  if (value === "~") return normalize(home);
  if (value.startsWith(`~${sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return resolve(home, value.slice(2));
  }
  return isAbsolute(value) ? normalize(value) : resolve(codexHome, value);
}

type InspectedRolloutFile =
  | { readonly kind: "missing" | "invalid" }
  | { readonly kind: "ready"; readonly file: string; readonly stat: RolloutFileStat };

async function inspectRolloutFile(file: string): Promise<InspectedRolloutFile> {
  let original: Awaited<ReturnType<typeof lstat>>;
  try {
    original = await lstat(file, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    throw error;
  }
  if (!original.isFile()) return { kind: "invalid" };

  const canonical = await realpath(file);
  const canonicalStats = await lstat(canonical, { bigint: true });
  if (
    !canonicalStats.isFile() ||
    original.dev !== canonicalStats.dev ||
    original.ino !== canonicalStats.ino
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "ready",
    file: canonical,
    stat: Object.freeze({
      dev: canonicalStats.dev.toString(10),
      ino: canonicalStats.ino.toString(10),
      mode: canonicalStats.mode.toString(10),
      size: canonicalStats.size.toString(10),
      mtimeNs: canonicalStats.mtimeNs.toString(10),
      ctimeNs: canonicalStats.ctimeNs.toString(10),
      birthtimeNs: canonicalStats.birthtimeNs.toString(10),
    }),
  };
}

async function classifyContainedPath(
  paths: ResolvedCodexPaths,
  candidate: string,
): Promise<RolloutDescriptor["root"]> {
  const roots = [
    ["sessions", paths.sessionsRoot],
    ["archived-sessions", paths.archivedSessionsRoot],
  ] as const;
  for (const [kind, root] of roots) {
    try {
      const canonicalRoot = await realpath(root);
      if (isWithin(canonicalRoot, candidate)) return kind;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return "none";
}

async function classifyContainedParent(
  paths: ResolvedCodexPaths,
  parent: string,
): Promise<RolloutDescriptor["root"]> {
  const canonicalParent = await canonicalizePotentialPath(parent);
  const sessionsRoot = await canonicalizePotentialPath(paths.sessionsRoot);
  if (isWithin(sessionsRoot, canonicalParent)) return "sessions";
  const archivedRoot = await canonicalizePotentialPath(paths.archivedSessionsRoot);
  if (isWithin(archivedRoot, canonicalParent)) return "archived-sessions";
  return "none";
}

/** Resolve the deepest existing ancestor so missing files cannot hide a symlink escape. */
async function canonicalizePotentialPath(value: string): Promise<string> {
  const missingSegments: string[] = [];
  let cursor = normalize(value);
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return normalize(value);
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function invalidRollout(logicalName = "invalid-rollout"): RolloutDescriptor {
  return Object.freeze({
    status: "invalid",
    logicalName,
    representation: "invalid",
    root: "none",
  });
}

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
