import type { SessionRootResolution } from "../domain/session-lineage.ts";

/** Copy query-derived lineage before it crosses the application boundary. */
export function selectSessionRoot(root: SessionRootResolution): SessionRootResolution {
  if (root.kind === "unknown") return Object.freeze({ kind: "unknown" });
  if (root.kind !== "known") throw new TypeError("Session root resolution is invalid");
  return Object.freeze({
    kind: "known",
    root: Object.freeze({
      source: Object.freeze({ ...root.root.source }),
      nativeId: root.root.nativeId,
    }),
  });
}
