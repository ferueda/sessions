import type { SourceDiscoveryWorkspace } from "../../src/application/ports/session-source.ts";

export const syntheticDiscoveryWorkspace: SourceDiscoveryWorkspace = Object.freeze({
  withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
    return operation("/synthetic/private-attempt");
  },
});
