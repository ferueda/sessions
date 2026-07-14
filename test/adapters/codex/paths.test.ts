import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  describeRollout,
  resolveCodexPaths,
  rolloutDescriptorTuple,
  type CodexEnvironment,
} from "../../../src/adapters/codex/paths.ts";
import { createCodexSourceFixture } from "../../fixtures/codex/source.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Codex path resolution", () => {
  test("resolves blank defaults, literal CODEX_HOME tildes, and existing aliases", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "cwd");
    const home = join(root, "home");
    await Promise.all([mkdir(cwd), mkdir(join(home, ".codex"), { recursive: true })]);

    const blank = await resolveCodexPaths(environment(cwd, home, { CODEX_HOME: "  " }));
    expect(blank.codexHome).toBe(await realpath(join(home, ".codex")));

    const literal = await resolveCodexPaths(environment(cwd, home, { CODEX_HOME: "~" }));
    expect(literal.codexHome).toBe(join(cwd, "~"));

    const real = join(root, "real-codex");
    const alias = join(root, "alias-codex");
    await mkdir(real);
    await symlink(real, alias, "dir");
    const aliased = await resolveCodexPaths(environment(cwd, home, { CODEX_HOME: alias }));
    expect(aliased.codexHome).toBe(await realpath(real));
  });

  test("applies config, environment, and default SQLite precedence with exact bases", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "cwd");
    const home = join(root, "home");
    const codexHome = join(root, "codex");
    await Promise.all([mkdir(cwd), mkdir(home), mkdir(codexHome)]);
    await writeFile(join(codexHome, "config.toml"), `sqlite_home = "state/config"\n`);

    const configured = await resolveCodexPaths(
      environment(cwd, home, {
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: "state/environment",
      }),
    );
    expect(configured).toMatchObject({
      sqliteHome: join(await realpath(codexHome), "state/config"),
      sqliteHomeSelection: "config",
    });

    await rm(join(codexHome, "config.toml"));
    const fromEnvironment = await resolveCodexPaths(
      environment(cwd, home, { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "state/environment" }),
    );
    expect(fromEnvironment).toMatchObject({
      sqliteHome: join(cwd, "state/environment"),
      sqliteHomeSelection: "environment",
    });

    const fromDefault = await resolveCodexPaths(environment(cwd, home, { CODEX_HOME: codexHome }));
    expect(fromDefault).toMatchObject({
      sqliteHome: await realpath(codexHome),
      sqliteHomeSelection: "default",
    });
  });

  test("expands config ~/ paths without expanding environment tildes", async () => {
    const root = await temporaryRoot();
    const cwd = join(root, "cwd");
    const home = join(root, "home");
    const codexHome = join(root, "codex");
    await Promise.all([mkdir(cwd), mkdir(home), mkdir(codexHome)]);
    await writeFile(join(codexHome, "config.toml"), `sqlite_home = "~/configured"\n`);
    const configured = await resolveCodexPaths(
      environment(cwd, home, { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "~/ignored" }),
    );
    expect(configured.sqliteHome).toBe(join(home, "configured"));

    await rm(join(codexHome, "config.toml"));
    const fromEnvironment = await resolveCodexPaths(
      environment(cwd, home, { CODEX_HOME: codexHome, CODEX_SQLITE_HOME: "~" }),
    );
    expect(fromEnvironment.sqliteHome).toBe(join(cwd, "~"));
  });

  test("uses the legacy state only for an unconfigured missing root state", async () => {
    const root = await temporaryRoot();
    const codexHome = join(root, "codex");
    const legacy = join(codexHome, "sqlite", "state_5.sqlite");
    const primary = join(codexHome, "state_5.sqlite");
    await mkdir(join(codexHome, "sqlite"), { recursive: true });
    await writeFile(legacy, "legacy");
    const env = environment(root, join(root, "home"), { CODEX_HOME: codexHome });

    const canonicalCodexHome = await realpath(codexHome);
    expect((await resolveCodexPaths(env)).stateDatabase).toBe(
      join(canonicalCodexHome, "sqlite", "state_5.sqlite"),
    );
    await writeFile(primary, "primary");
    expect((await resolveCodexPaths(env)).stateDatabase).toBe(
      join(canonicalCodexHome, "state_5.sqlite"),
    );

    await rm(primary);
    const explicit = await resolveCodexPaths(
      environment(root, join(root, "home"), {
        CODEX_HOME: codexHome,
        CODEX_SQLITE_HOME: join(root, "missing-explicit"),
      }),
    );
    expect(explicit.stateDatabase).toBe(join(root, "missing-explicit", "state_5.sqlite"));
  });
});

describe("Codex rollout selection", () => {
  test("prefers plain content and normalizes plain and Zstandard descriptors", async () => {
    const fixture = await createCodexSourceFixture();
    roots.push(fixture.root);
    const relative = "sessions/2026/rollout-2026-thread-one.jsonl";
    await fixture.writeRollout(relative, "{}\n", "zstd");
    await fixture.writeRollout(relative, "{}\n", "plain");
    const paths = await resolveCodexPaths(fixture.environment);

    const descriptor = await describeRollout(paths, relative, "thread-one");

    expect(descriptor).toMatchObject({
      status: "ready",
      logicalName: "rollout-2026-thread-one.jsonl",
      representation: "plain",
      root: "sessions",
    });
    expect(rolloutDescriptorTuple(descriptor)).toEqual([
      "codex-rollout-v1",
      "rollout-2026-thread-one.jsonl",
      "ready",
      "plain",
      "sessions",
      expect.any(Array),
    ]);
  });

  test("describes contained missing content without scanning", async () => {
    const fixture = await createCodexSourceFixture();
    roots.push(fixture.root);
    const paths = await resolveCodexPaths(fixture.environment);

    await expect(
      describeRollout(paths, "sessions/missing/rollout-2026-thread-one.jsonl", "thread-one"),
    ).resolves.toEqual({
      status: "missing",
      logicalName: "rollout-2026-thread-one.jsonl",
      representation: "missing",
      root: "sessions",
    });
  });

  test("rejects ID mismatch, traversal, special files, and symlink escape", async () => {
    const fixture = await createCodexSourceFixture();
    roots.push(fixture.root);
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    const outsideFile = join(outside, "rollout-2026-thread-one.jsonl");
    await writeFile(outsideFile, "{}\n");
    const symlinked = join(fixture.sessionsRoot, "rollout-2026-thread-one.jsonl");
    await symlink(outsideFile, symlinked, "file");
    const directory = join(fixture.sessionsRoot, "rollout-2026-thread-two.jsonl");
    await mkdir(directory);
    const paths = await resolveCodexPaths(fixture.environment);

    const descriptors = await Promise.all([
      describeRollout(paths, "sessions/rollout-2026-thread-one.jsonl", "different-id"),
      describeRollout(paths, outsideFile, "thread-one"),
      describeRollout(paths, "sessions/rollout-2026-thread-one.jsonl", "thread-one"),
      describeRollout(paths, "sessions/rollout-2026-thread-two.jsonl", "thread-two"),
    ]);

    expect(descriptors.every(({ status }) => status === "invalid")).toBe(true);
  });

  test("rejects a missing rollout whose deepest existing parent escapes by symlink", async () => {
    const fixture = await createCodexSourceFixture();
    roots.push(fixture.root);
    const outside = join(fixture.root, "outside");
    await mkdir(outside);
    await symlink(outside, join(fixture.sessionsRoot, "escaped"), "dir");
    const paths = await resolveCodexPaths(fixture.environment);

    const descriptor = await describeRollout(
      paths,
      "sessions/escaped/missing/rollout-2026-thread-one.jsonl",
      "thread-one",
    );

    expect(descriptor.status).toBe("invalid");
  });

  test("admits archived rollouts", async () => {
    const fixture = await createCodexSourceFixture();
    roots.push(fixture.root);
    const relative = "archived_sessions/rollout-2026-thread-one.jsonl";
    await fixture.writeRollout(relative, "{}\n");
    const paths = await resolveCodexPaths(fixture.environment);

    await expect(describeRollout(paths, relative, "thread-one")).resolves.toMatchObject({
      status: "ready",
      root: "archived-sessions",
    });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sessions-codex-paths-"));
  roots.push(root);
  return root;
}

function environment(
  cwd: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
): CodexEnvironment {
  return { cwd: resolve(cwd), home: resolve(home), env };
}
