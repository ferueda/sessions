import type { SourceCaptureWorkspace } from "../../src/application/ports/session-source.ts";

export const syntheticCaptureWorkspace: SourceCaptureWorkspace = Object.freeze({
  withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    return operation("/synthetic/private-attempt");
  },
});
