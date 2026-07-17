import { admitSourceProbe } from "./admit-source-probe.ts";
import type { RuntimeDiagnostic } from "./ports/runtime-diagnostic.ts";
import type { SelectedSessionSource } from "./ports/session-source.ts";

export function createSourceDiagnostic(selected: SelectedSessionSource): RuntimeDiagnostic {
  return {
    id: `source-${selected.instance.kind}`,
    label: `${selected.instance.kind} source`,
    async run() {
      let value: unknown;
      try {
        value = await selected.adapter.probe();
      } catch {
        return {
          ok: false,
          summary: "Source probe failed",
          details: { probeStatus: "failed", failure: "probe-error" },
        };
      }
      const probe = admitSourceProbe(value);
      if (
        probe === undefined ||
        probe.source.kind !== selected.instance.kind ||
        probe.source.instanceId !== selected.instance.instanceId
      ) {
        return {
          ok: false,
          summary: "Source probe returned invalid data",
          details: { probeStatus: "failed", failure: "invalid-probe" },
        };
      }
      const ok = probe.status !== "unreadable";
      return {
        ok,
        summary:
          probe.status === "unavailable"
            ? "Source is unavailable (optional)"
            : probe.status === "ready"
              ? "Source is ready"
              : "Source is unreadable",
        details: { probeStatus: probe.status },
      };
    },
  };
}
