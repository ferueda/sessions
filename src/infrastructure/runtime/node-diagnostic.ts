import type { RuntimeDiagnostic } from "../../application/ports/runtime-diagnostic.ts";

export const MINIMUM_NODE_VERSION = "24.15.0";

export function createNodeDiagnostic(
  version = process.versions.node,
  minimumVersion = MINIMUM_NODE_VERSION,
): RuntimeDiagnostic {
  return {
    id: "node-runtime",
    label: "Node.js runtime",
    run() {
      const ok = compareVersions(version, minimumVersion) >= 0;

      return {
        ok,
        summary: ok
          ? `Node.js ${version} satisfies >=${minimumVersion}`
          : `Node.js ${version} does not satisfy >=${minimumVersion}`,
        details: { version, minimumVersion },
      };
    },
  };
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }

  return 0;
}

function parseVersion(version: string): readonly number[] {
  return version.split(".", 3).map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? -1 : parsed;
  });
}
