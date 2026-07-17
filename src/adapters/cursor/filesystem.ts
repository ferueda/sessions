import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type CursorEntryKind = "missing" | "directory" | "regular-file" | "symbolic-link" | "other";

export interface CursorFileStat {
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly birthtimeNs: string;
}

export interface CursorEntryDescriptor {
  readonly components: readonly string[];
  readonly kind: CursorEntryKind;
  readonly stat?: CursorFileStat;
  readonly contentDigest?: string;
}

export interface CapturedCursorFile {
  readonly descriptor: CursorEntryDescriptor;
  readonly bytes: Uint8Array;
}

export interface CursorFilesystemHooks {
  /** Test seam for a race after a directory was admitted but before it is read. */
  readonly beforeDirectoryRead?: (components: readonly string[]) => void | Promise<void>;
  /** Test seam for a race after directory names were read but before child stats. */
  readonly afterDirectoryRead?: (components: readonly string[]) => void | Promise<void>;
  /** Test seam for a race after a regular file was admitted but before it is opened. */
  readonly beforeFileOpen?: (components: readonly string[]) => void | Promise<void>;
}

export interface CursorDirectoryOptions extends CursorFilesystemHooks {
  /** Exact names excluded only at the grammar-owned directory passed by the caller. */
  readonly excludedNames?: ReadonlySet<string>;
}

export class CursorInventoryChangedError extends Error {
  constructor() {
    super("Cursor source changed during discovery");
    this.name = "CursorInventoryChangedError";
  }
}

export function compareCursorComponents(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function cursorPath(root: string, components: readonly string[]): string {
  assertComponents(components);
  return join(root, ...components);
}

export async function describeCursorEntry(
  root: string,
  components: readonly string[],
): Promise<CursorEntryDescriptor> {
  assertComponents(components);
  try {
    const stats = await lstat(cursorPath(root, components), { bigint: true });
    return freezeDescriptor({
      components,
      kind: entryKind(stats),
      stat: fileStat(stats),
    });
  } catch (error) {
    if (!isMissing(error)) throw error;
    return freezeDescriptor({ components, kind: "missing" });
  }
}

export async function listCursorDirectory(
  root: string,
  components: readonly string[],
  options: CursorDirectoryOptions = {},
): Promise<readonly CursorEntryDescriptor[]> {
  const directory = await describeCursorEntry(root, components);
  if (directory.kind !== "directory") return Object.freeze([]);

  await options.beforeDirectoryRead?.(components);
  let names: string[];
  try {
    names = (await readdir(cursorPath(root, components))).toSorted(compareCursorComponents);
  } catch (error) {
    if (isRaceError(error)) throw new CursorInventoryChangedError();
    throw error;
  }
  await options.afterDirectoryRead?.(components);
  const afterRead = await describeCursorEntry(root, components);
  if (!sameCursorDescriptor(directory, afterRead)) throw new CursorInventoryChangedError();
  const descriptors: CursorEntryDescriptor[] = [];
  for (const name of names) {
    if (options.excludedNames?.has(name) === true) continue;
    const descriptor = await describeCursorEntry(root, [...components, name]);
    if (descriptor.kind === "missing") throw new CursorInventoryChangedError();
    descriptors.push(descriptor);
  }
  return Object.freeze(descriptors);
}

export async function captureCursorFile(
  root: string,
  components: readonly string[],
  expected?: CursorEntryDescriptor,
  hooks: CursorFilesystemHooks = {},
): Promise<CapturedCursorFile> {
  const before = await describeCursorEntry(root, components);
  if (expected !== undefined && !sameCursorDescriptor(expected, before)) {
    throw new CursorInventoryChangedError();
  }
  if (before.kind !== "regular-file") {
    throw new TypeError("Cursor capture input must be a regular file");
  }

  await hooks.beforeFileOpen?.(components);
  let handle: FileHandle;
  try {
    handle = await openReadOnlyNoFollow(cursorPath(root, components));
  } catch (error) {
    if (isRaceError(error)) throw new CursorInventoryChangedError();
    throw error;
  }
  try {
    const openedBefore = fileStat(await handle.stat({ bigint: true }));
    if (!sameStat(before.stat, openedBefore)) throw new CursorInventoryChangedError();
    const bytes = await handle.readFile();
    const openedAfter = fileStat(await handle.stat({ bigint: true }));
    const after = await describeCursorEntry(root, components);
    if (
      after.kind !== "regular-file" ||
      !sameStat(openedBefore, openedAfter) ||
      !sameStat(openedAfter, after.stat)
    ) {
      throw new CursorInventoryChangedError();
    }

    return Object.freeze({
      descriptor: freezeDescriptor({
        ...after,
        contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      }),
      bytes: Uint8Array.from(bytes),
    });
  } finally {
    await handle.close();
  }
}

export function cursorDescriptorFingerprint(descriptor: CursorEntryDescriptor): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(cursorDescriptorTuple(descriptor)), "utf8")
    .digest("hex")}`;
}

export function cursorDescriptorTuple(descriptor: CursorEntryDescriptor): readonly unknown[] {
  return [
    "cursor-entry-v1",
    descriptor.components,
    descriptor.kind,
    descriptor.stat === undefined ? null : statTuple(descriptor.stat),
    descriptor.contentDigest ?? null,
  ];
}

export function sameCursorDescriptor(
  left: CursorEntryDescriptor,
  right: CursorEntryDescriptor,
): boolean {
  return (
    JSON.stringify(cursorDescriptorTuple(left)) === JSON.stringify(cursorDescriptorTuple(right))
  );
}

function entryKind(stats: BigIntStats): CursorEntryKind {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "regular-file";
  if (stats.isSymbolicLink()) return "symbolic-link";
  return "other";
}

function fileStat(stats: BigIntStats): CursorFileStat {
  return Object.freeze({
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mode: stats.mode.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
  });
}

function statTuple(stat: CursorFileStat): readonly string[] {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs];
}

async function openReadOnlyNoFollow(path: string): Promise<FileHandle> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  try {
    return await open(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (noFollow === 0 || !noFollowUnsupported(error)) throw error;
    return open(path, constants.O_RDONLY);
  }
}

function noFollowUnsupported(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EINVAL" || error.code === "ENOTSUP")
  );
}

function sameStat(left: CursorFileStat | undefined, right: CursorFileStat | undefined): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    JSON.stringify(statTuple(left)) === JSON.stringify(statTuple(right))
  );
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isRaceError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ENOTDIR" ||
      error.code === "ELOOP" ||
      error.code === "ESTALE")
  );
}

function assertComponents(components: readonly string[]): void {
  for (const component of components) {
    if (
      component.length === 0 ||
      component === "." ||
      component === ".." ||
      component.includes("/") ||
      component.includes("\0") ||
      (process.platform === "win32" && component.includes("\\")) ||
      !component.isWellFormed()
    ) {
      throw new TypeError("Cursor path components must be opaque regular names");
    }
  }
}

function freezeDescriptor(descriptor: CursorEntryDescriptor): CursorEntryDescriptor {
  return Object.freeze({
    components: Object.freeze([...descriptor.components]),
    kind: descriptor.kind,
    ...(descriptor.stat === undefined ? {} : { stat: descriptor.stat }),
    ...(descriptor.contentDigest === undefined ? {} : { contentDigest: descriptor.contentDigest }),
  });
}
