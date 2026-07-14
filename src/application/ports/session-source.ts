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

/** Opaque, lease-scoped staging supplied only while source discovery runs. */
export interface SourceDiscoveryWorkspace {
  withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T>;
}

export interface SessionSource {
  readonly kind: string;
  probe(): Promise<SourceProbe>;
  discover(workspace: SourceDiscoveryWorkspace): AsyncIterable<DiscoveredSession>;
  read(candidate: DiscoveredSession): Promise<SessionDocument>;
}

/** One explicit provider-neutral source selected for an indexing invocation. */
export interface SelectedSessionSource {
  readonly instance: SourceInstance;
  readonly adapter: SessionSource;
}
