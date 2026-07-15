import { CodexRolloutError } from "./rollout.ts";

import type { LineageCoverage, SessionIdentity, SessionRelation } from "../../domain/session.ts";

export interface CodexMetadataLineage {
  readonly parentThreadId?: string;
  readonly forkedFromId?: string;
}

export interface CodexLineageEvidence {
  readonly lineageCoverage: LineageCoverage;
  readonly relations: readonly SessionRelation[];
}

export class CodexLineageTracker {
  readonly #identity: SessionIdentity;
  readonly #spawnEdgeCoverage: LineageCoverage;
  readonly #stateParentNativeId: string | undefined;
  #metadataRelation: { readonly kind: "parent" | "fork"; readonly nativeId: string } | undefined;
  #sawCurrentMetadata = false;

  constructor(
    identity: SessionIdentity,
    spawnEdgeCoverage: LineageCoverage,
    stateParentNativeId?: string,
  ) {
    if (
      (spawnEdgeCoverage !== "complete" && spawnEdgeCoverage !== "unknown") ||
      (stateParentNativeId !== undefined && spawnEdgeCoverage !== "complete")
    ) {
      throwMalformed();
    }
    if (
      stateParentNativeId !== undefined &&
      (stateParentNativeId.length === 0 ||
        !stateParentNativeId.isWellFormed() ||
        stateParentNativeId === identity.nativeId)
    ) {
      throwMalformed();
    }
    this.#identity = identity;
    this.#spawnEdgeCoverage = spawnEdgeCoverage;
    this.#stateParentNativeId = stateParentNativeId;
  }

  observeCurrentMetadata(metadata: CodexMetadataLineage): void {
    this.#sawCurrentMetadata = true;
    const { parentThreadId, forkedFromId } = metadata;

    if (
      parentThreadId !== undefined &&
      forkedFromId !== undefined &&
      parentThreadId !== forkedFromId
    ) {
      throwMalformed();
    }

    if (this.#stateParentNativeId !== undefined) {
      if (
        (parentThreadId !== undefined && parentThreadId !== this.#stateParentNativeId) ||
        (forkedFromId !== undefined && forkedFromId !== this.#stateParentNativeId)
      ) {
        throwMalformed();
      }
      return;
    }

    const relation =
      parentThreadId !== undefined
        ? { kind: "parent" as const, nativeId: parentThreadId }
        : forkedFromId !== undefined
          ? { kind: "fork" as const, nativeId: forkedFromId }
          : undefined;
    if (relation === undefined) return;
    if (relation.nativeId === this.#identity.nativeId) throwMalformed();
    if (
      this.#metadataRelation !== undefined &&
      (this.#metadataRelation.kind !== relation.kind ||
        this.#metadataRelation.nativeId !== relation.nativeId)
    ) {
      throwMalformed();
    }
    this.#metadataRelation = relation;
  }

  finish(): CodexLineageEvidence {
    if (!this.#sawCurrentMetadata) throwMalformed();

    const relation =
      this.#stateParentNativeId === undefined
        ? this.#metadataRelation
        : { kind: "parent" as const, nativeId: this.#stateParentNativeId };
    if (relation === undefined) {
      return { lineageCoverage: this.#spawnEdgeCoverage, relations: [] };
    }

    return {
      lineageCoverage: this.#spawnEdgeCoverage,
      relations: [
        {
          kind: relation.kind,
          target: {
            source: this.#identity.source,
            nativeId: relation.nativeId,
          },
          confidence: "high",
        },
      ],
    };
  }
}

function throwMalformed(): never {
  throw new CodexRolloutError("malformed");
}
