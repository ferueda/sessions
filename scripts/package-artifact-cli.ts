export type PackageArtifactInvocation =
  | {
      readonly command: "build";
      readonly mode: "bootstrap" | "supported";
      readonly releaseSha: string;
      readonly tagPhase: "before" | "after";
      readonly outputDirectory: string;
    }
  | {
      readonly command: "verify-tag";
      readonly version: string;
      readonly releaseSha: string;
      readonly tagPhase: "before" | "after";
    };

export function admitPackageArtifactInvocation(argv: readonly string[]): PackageArtifactInvocation {
  const command = argv[0];
  if (command !== "build" && command !== "verify-tag") {
    throw new TypeError("expected package-artifact command build or verify-tag");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === undefined || value === undefined || !option.startsWith("--")) {
      throw new TypeError("package-artifact options require --name value pairs");
    }
    if (values.has(option)) throw new TypeError(`duplicate option ${option}`);
    values.set(option, value);
  }
  const releaseSha = requireValue(values, "--release-sha");
  const tagPhase = requireValue(values, "--tag-phase");
  if (tagPhase !== "before" && tagPhase !== "after") {
    throw new TypeError("--tag-phase must be before or after");
  }
  if (command === "verify-tag") {
    assertOnlyOptions(values, ["--version", "--release-sha", "--tag-phase"]);
    return {
      command,
      version: requireValue(values, "--version"),
      releaseSha,
      tagPhase,
    };
  }
  assertOnlyOptions(values, ["--mode", "--release-sha", "--tag-phase", "--output-directory"]);
  const mode = requireValue(values, "--mode");
  if (mode !== "bootstrap" && mode !== "supported") {
    throw new TypeError("--mode must be bootstrap or supported");
  }
  return {
    command,
    mode,
    releaseSha,
    tagPhase,
    outputDirectory: requireValue(values, "--output-directory"),
  };
}

function requireValue(values: ReadonlyMap<string, string>, option: string): string {
  const value = values.get(option);
  if (value === undefined || value === "") throw new TypeError(`missing ${option}`);
  return value;
}

function assertOnlyOptions(values: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  const unexpected = [...values.keys()].filter((option) => !allowed.includes(option));
  if (unexpected.length > 0) throw new TypeError(`unknown option ${unexpected[0]}`);
}
