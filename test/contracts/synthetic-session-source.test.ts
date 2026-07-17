import { expect, test } from "vitest";

import type { SourceCaptureWorkspace } from "../../src/application/ports/session-source.ts";
import { registerSessionSourceContract } from "./session-source.contract.ts";
import { createSyntheticSourceFixture } from "../fixtures/synthetic-source.ts";

registerSessionSourceContract("synthetic", createSyntheticSourceFixture);

test("synthetic source stages candidate reads through the supplied capture workspace", async () => {
  const fixture = createSyntheticSourceFixture();
  try {
    const candidates = [];
    for await (const candidate of fixture.source.discover(fixture.captureWorkspace)) {
      candidates.push(candidate);
    }
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("Expected synthetic candidate");

    const privateDirectories: string[] = [];
    const workspace: SourceCaptureWorkspace = {
      withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
        const directory = "/synthetic/read-stage";
        privateDirectories.push(directory);
        return operation(directory);
      },
    };

    const document = await fixture.source.read(candidate, workspace);

    expect(document.identity).toEqual(candidate.identity);
    expect(privateDirectories).toEqual(["/synthetic/read-stage"]);
  } finally {
    await fixture.dispose();
  }
});
