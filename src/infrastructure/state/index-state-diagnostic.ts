import type {
  IndexHealthInspector,
  ReadyIndexHealth,
} from "../../application/ports/index-health.ts";
import type { IndexPaths, IndexStateInspector } from "../../application/ports/index-lifecycle.ts";
import type { RuntimeDiagnostic } from "../../application/ports/runtime-diagnostic.ts";
import type { IndexState } from "../../domain/index-state.ts";

export function createIndexStateDiagnostic(
  resolvePaths: () => IndexPaths,
  inspector: IndexStateInspector & IndexHealthInspector,
): RuntimeDiagnostic {
  return {
    id: "library-state",
    label: "Sessions library",
    async run() {
      const paths = resolvePaths();
      const state = await inspector.inspect(paths);
      if (state.status === "ready") {
        try {
          const health = await inspector.inspectHealth(paths);
          return {
            ok: health.ok,
            summary: health.ok
              ? `Index schema ${String(state.schemaVersion)} is ready`
              : `Index schema ${String(state.schemaVersion)} failed health checks`,
            details: { ...detailsFor(state), ...healthDetails(health) },
          };
        } catch {
          return {
            ok: false,
            summary: `Index schema ${String(state.schemaVersion)} health inspection failed`,
            details: { ...detailsFor(state), health: "inspection-failed" },
          };
        }
      }
      return {
        ok: state.status === "uninitialized",
        summary: summarize(state),
        details: detailsFor(state),
      };
    },
  };
}

function healthDetails(health: ReadyIndexHealth): Readonly<Record<string, string>> {
  return {
    canonicalIntegrity: health.canonicalIntegrity,
    foreignKeys: health.foreignKeys,
    contentReachability: health.contentReachability,
    orphanContentRows: health.orphanContentRows,
    orphanContentBytes: health.orphanContentBytes,
    ftsStructure: health.ftsStructure,
    ftsContent: health.ftsContent,
    ftsSecureDelete: health.ftsSecureDelete,
    ftsRemediation: health.ftsRemediation,
    pageReclamation: health.pageReclamation,
    runRecords: health.runRecords,
    writerLease: health.writerLease,
    activeRuns: String(health.activeRuns),
    interruptedRuns: String(health.interruptedRuns),
  };
}

function summarize(state: IndexState): string {
  switch (state.status) {
    case "uninitialized":
      return "Index is not initialized; explicit indexing will create it";
    case "ready":
      return `Index schema ${String(state.schemaVersion)} is ready`;
    case "migration-required":
      return `Index schema ${String(state.schemaVersion)} requires migration to ${String(state.supportedSchemaVersion)}`;
    case "newer-schema":
      return `Index schema ${String(state.schemaVersion)} is newer than supported schema ${String(state.supportedSchemaVersion)}`;
    case "incompatible":
      return `Index is incompatible (${state.reason})`;
    case "recovery-required":
      return "Index has active or recovery sidecar files";
    case "unsafe":
      return `Index ${state.target} is unsafe (${state.reason})`;
  }
  return assertNever(state);
}

function detailsFor(state: IndexState): Readonly<Record<string, string>> {
  return {
    state: state.status,
    initialized: String(state.initialized),
    schemaVersion: state.schemaVersion === null ? "unknown" : String(state.schemaVersion),
    supportedSchemaVersion: String(state.supportedSchemaVersion),
    ...(state.status === "incompatible" ? { reason: state.reason } : {}),
    ...(state.status === "unsafe" ? { target: state.target, reason: state.reason } : {}),
  };
}

function assertNever(value: never): never {
  throw new Error("Unhandled index state", { cause: value });
}
