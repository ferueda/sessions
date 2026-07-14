import path from "node:path";

interface PathOperations {
  readonly sep: string;
  isAbsolute(candidate: string): boolean;
  relative(from: string, to: string): string;
}

export function isPathWithin(
  root: string,
  candidate: string,
  paths: PathOperations = path,
): boolean {
  const relative = paths.relative(root, candidate);

  // Windows returns an absolute path when root and candidate are on different drives.
  if (paths.isAbsolute(relative)) return false;

  return relative === "" || (!relative.startsWith(`..${paths.sep}`) && relative !== "..");
}
