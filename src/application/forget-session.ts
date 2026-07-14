import type { IndexPaths } from "./ports/index-lifecycle.ts";
import type { IndexMaintenance } from "./ports/index-maintenance.ts";
import { mapLibraryBusyError } from "./library-error.ts";
import { formatSessionIdentity } from "../domain/session-identity.ts";
import type { SessionIdentity } from "../domain/session.ts";

export interface ForgetSessionReport {
  readonly schemaVersion: 1;
  readonly command: "forget";
  readonly identity: {
    readonly canonicalId: string;
    readonly source: SessionIdentity["source"];
    readonly nativeId: string;
  };
  readonly outcome: "forgotten" | "absent";
}

export async function forgetSession(
  paths: IndexPaths,
  maintenance: IndexMaintenance,
  identity: SessionIdentity,
): Promise<ForgetSessionReport> {
  const canonicalId = formatSessionIdentity(identity);
  let outcome: "forgotten" | "absent";
  try {
    outcome = await maintenance.forget(paths, identity);
  } catch (error) {
    throw mapLibraryBusyError(error);
  }
  return Object.freeze({
    schemaVersion: 1,
    command: "forget",
    identity: Object.freeze({
      canonicalId,
      source: Object.freeze({ ...identity.source }),
      nativeId: identity.nativeId,
    }),
    outcome,
  });
}
