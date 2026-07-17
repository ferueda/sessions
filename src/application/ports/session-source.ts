import type {
  SessionDocument,
  SessionIdentity,
  SourceInstance,
  SourceLocator,
} from "../../domain/session.ts";

export type SourceProbeStatus = "ready" | "unavailable" | "unreadable";

export interface SourceProbeLocation {
  readonly role: string;
  readonly locator: SourceLocator;
}

export interface SourceProbe {
  readonly source: SourceInstance;
  readonly status: SourceProbeStatus;
  readonly locations: readonly SourceProbeLocation[];
  readonly summary: string;
}

export interface SourceInputDescriptor {
  readonly role: string;
  readonly locator: SourceLocator;
  readonly fingerprint: string;
}

export interface SourceInputAggregateFingerprint {
  readonly scheme: "sha256-json-v1";
  readonly digest: string;
}

export interface DiscoveredSession {
  readonly identity: SessionIdentity;
  readonly inputs: readonly SourceInputDescriptor[];
  readonly aggregateFingerprint: SourceInputAggregateFingerprint;
  readonly adapterVersion: string;
}

/** Opaque, lease-scoped staging supplied while a source captures stable input. */
export interface SourceCaptureWorkspace {
  withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T>;
}

/** Marks a failure owned by the capture workspace rather than provider input. */
export class SourceCaptureWorkspaceError extends Error {
  constructor(cause: unknown) {
    super("Source capture workspace failed", { cause });
    this.name = "SourceCaptureWorkspaceError";
  }
}

export interface SessionSource {
  readonly kind: string;
  canReplace?(previousAdapterVersion: string, nextAdapterVersion: string): boolean;
  probe(): Promise<SourceProbe>;
  discover(workspace: SourceCaptureWorkspace): AsyncIterable<DiscoveredSession>;
  read(candidate: DiscoveredSession, workspace: SourceCaptureWorkspace): Promise<SessionDocument>;
}

/** One explicit provider-neutral source selected for an indexing invocation. */
export interface SelectedSessionSource {
  readonly instance: SourceInstance;
  readonly adapter: SessionSource;
}
