#!/usr/bin/env node

import { createRequire } from "node:module";
import { homedir } from "node:os";

import { getPaths } from "../application/get-paths.ts";
import { runDoctor } from "../application/run-doctor.ts";
import { runCli } from "../cli/run.ts";
import { createNodeDiagnostic } from "../infrastructure/runtime/node-diagnostic.ts";
import { createIndexStateDiagnostic } from "../infrastructure/state/index-state-diagnostic.ts";
import { resolveIndexPaths } from "../infrastructure/state/paths.ts";
import { createSqliteIndexLifecycle } from "../infrastructure/sqlite/database.ts";
import { createSqliteDiagnostic } from "../infrastructure/sqlite/sqlite-diagnostic.ts";

const require = createRequire(import.meta.url);
const manifest = require("../../package.json") as { version?: unknown };
const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";
const indexLifecycle = createSqliteIndexLifecycle();
const resolvePaths = () =>
  resolveIndexPaths({
    platform: process.platform,
    env: process.env,
    homeDirectory: homedir(),
  });

const exitCode = await runCli(process.argv.slice(2), {
  version,
  output: {
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  },
  doctor: () =>
    runDoctor([
      createNodeDiagnostic(),
      createSqliteDiagnostic(),
      createIndexStateDiagnostic(resolvePaths, indexLifecycle),
    ]),
  paths: () => getPaths(resolvePaths(), indexLifecycle),
});

process.exitCode = exitCode;
