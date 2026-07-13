import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const layers = ["domain", "application", "infrastructure", "adapters", "cli", "bin"] as const;
type Layer = (typeof layers)[number];

const allowedDependencies: Readonly<Record<Layer, readonly Layer[]>> = {
  domain: ["domain"],
  application: ["application", "domain"],
  infrastructure: ["infrastructure", "application", "domain"],
  adapters: ["adapters", "application", "domain"],
  cli: ["cli", "application", "domain"],
  bin: layers,
};

export interface DependencyCheckResult {
  readonly moduleCount: number;
  readonly internalDependencyCount: number;
  readonly violations: readonly string[];
}

export async function checkProductionDependencies(
  sourceRoot: string,
): Promise<DependencyCheckResult> {
  const files = await findTypeScriptFiles(sourceRoot);
  const violations: string[] = [];
  let internalDependencyCount = 0;

  for (const file of files) {
    const sourceLayer = layerFor(file, sourceRoot);
    const source = await readFile(file, "utf8");

    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (!isWithin(sourceRoot, target)) {
        violations.push(
          `${relativeDisplayPath(sourceRoot, file)} (${sourceLayer}) -> ${specifier} (outside src)`,
        );
        continue;
      }

      internalDependencyCount += 1;
      const targetLayer = layerFor(target, sourceRoot);
      if (!allowedDependencies[sourceLayer].includes(targetLayer)) {
        violations.push(
          `${relativeDisplayPath(sourceRoot, file)} (${sourceLayer}) -> ${specifier} (${targetLayer})`,
        );
      }
    }
  }

  if (files.length === 0) violations.push("no TypeScript production modules found");

  return { moduleCount: files.length, internalDependencyCount, violations };
}

function relativeDisplayPath(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function findTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findTypeScriptFiles(entryPath);
      return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
    }),
  );
  return nested.flat().sort();
}

function layerFor(file: string, sourceRoot: string): Layer {
  const [candidate] = path.relative(sourceRoot, file).split(path.sep);
  if (layers.includes(candidate as Layer)) return candidate as Layer;
  throw new Error(`production module has no recognized layer: ${file}`);
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gu;
  const dynamicImport = /\bimport\(\s*["']([^"']+)["']\s*\)/gu;

  for (const match of source.matchAll(staticImport)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of source.matchAll(dynamicImport)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
  const result = await checkProductionDependencies(sourceRoot);
  if (result.violations.length > 0) {
    process.stderr.write(`${result.violations.join("\n")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Dependency boundaries: ${String(result.moduleCount)} modules, ${String(result.internalDependencyCount)} internal imports\n`,
    );
  }
}
