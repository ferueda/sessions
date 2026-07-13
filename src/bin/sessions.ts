#!/usr/bin/env node

import { createRequire } from "node:module";

import { runDoctor } from "../application/run-doctor.ts";
import { runCli } from "../cli/run.ts";
import { createNodeDiagnostic } from "../infrastructure/runtime/node-diagnostic.ts";
import { createSqliteDiagnostic } from "../infrastructure/sqlite/sqlite-diagnostic.ts";

const require = createRequire(import.meta.url);
const manifest = require("../../package.json") as { version?: unknown };
const version = typeof manifest.version === "string" ? manifest.version : "0.0.0";

const exitCode = await runCli(process.argv.slice(2), {
  version,
  output: {
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
  },
  doctor: () => runDoctor([createNodeDiagnostic(), createSqliteDiagnostic()]),
});

process.exitCode = exitCode;
