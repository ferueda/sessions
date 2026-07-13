import type {
  SessionDocument,
  SessionIdentity,
  SourceInstance,
  SourceLocator,
} from "../../domain/session.ts";

export interface SourceProbe {
  readonly source: SourceInstance;
  readonly available: boolean;
  readonly readable: boolean;
  readonly summary: string;
}

export interface DiscoveredSession {
  readonly identity: SessionIdentity;
  readonly locator: SourceLocator;
  readonly fingerprint: string;
  readonly adapterVersion: string;
}

export interface SessionSource {
  readonly kind: string;
  probe(): Promise<SourceProbe>;
  discover(): AsyncIterable<DiscoveredSession>;
  read(candidate: DiscoveredSession): Promise<SessionDocument>;
}
