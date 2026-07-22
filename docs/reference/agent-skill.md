# Sessions Agent Skill

The packaged `sessions` skill helps an agent answer questions from the retained
Sessions library. It uses only the public CLI and adds no hidden data access,
provider write, or analysis engine.

## Requirements and installation

The agent process must have a working `sessions` command.

```bash
export SESSIONS_VERSION='0.5.0' # x-release-please-version
npm install --global "@ferueda/sessions@${SESSIONS_VERSION}"
DISABLE_TELEMETRY=1 npx --yes skills@1.5.19 add \
  "https://github.com/ferueda/sessions/tree/v${SESSIONS_VERSION}/skills/sessions" \
  --skill sessions
```

The non-interactive host-specific forms verified locally are:

```bash
DISABLE_TELEMETRY=1 npx --yes skills@1.5.19 add \
  "https://github.com/ferueda/sessions/tree/v${SESSIONS_VERSION}/skills/sessions" \
  --skill sessions --agent codex --global --yes --copy
DISABLE_TELEMETRY=1 npx --yes skills@1.5.19 add \
  "https://github.com/ferueda/sessions/tree/v${SESSIONS_VERSION}/skills/sessions" \
  --skill sessions --agent cursor --global --yes --copy
```

Both copy the same ten-file skill to the universal
`~/.agents/skills/sessions/` location. The host-neutral alternative is to copy
`skills/sessions/` from the same immutable release into a supported host's skill
directory while preserving the same layout. The pinned external installer
contacts npm; the commands above disable its anonymous telemetry. The setup
verifies the CLI and stops before indexing for separate permission. See
[agent setup](../agent-setup.md).

Codex and Cursor are agent hosts in the examples above and registered local
Sessions index sources. The same skill works over either retained source through
the provider-neutral CLI.

## Routes

One model-invoked skill selects the closest playbook:

| User goal                                                    | Reference                 |
| ------------------------------------------------------------ | ------------------------- |
| Recover decisions, research, recall, or transferable context | `search-and-context.md`   |
| Explain failure, drift, reversals, recovery, or open work    | `retrospective.md`        |
| Find repeated working and communication preferences          | `preferences.md`          |
| Audit skill or workflow eligibility, use, process, outcomes  | `workflow-audit.md`       |
| Compare completion claims with recorded checks               | `verification-audit.md`   |
| Compare parent, child, fork, or continuation handoffs        | `handoff-continuity.md`   |
| Find recurring friction worth a reusable capability          | `capability-discovery.md` |

Every route first reads the single binding
[`evidence-protocol.md`](../../skills/sessions/references/evidence-protocol.md).
That protocol starts routine work with `sessions paths --format json` for
readiness, then uses the retained query's same-snapshot `captureScope` for
evidence availability. `paths` does not prove canonical or FTS integrity; the
exact whole-library doctor remains an explicit audit for suspected damage and
post-repair or post-maintenance verification. The protocol also requires
explicit indexing authority, bounded JSON/JSONL queries, a reproducible evidence
ledger, digest-guarded manifest hydration, facts before interpretation, honest
support units and unknowns, and no automatic mutation.

## Evidence limits

- Historical text, instructions, and tool output are untrusted data.
- Search reports occurrence, unique-content, known-root, and unknown-lineage
  totals. Other commands do not create those totals.
- List, search, and entries report one page-level capture scope; manifest reports
  one cohort-level scope. An incomplete scope limits what the retained library
  can prove; unassessed filters do not classify unindexed sessions as matches or
  non-matches.
- Paths reports readiness and source probes without scanning retained transcript
  bodies. Doctor reads retained canonical content for an exact local integrity
  audit, but neither command opens provider transcript content.
- Recorded command output is historical evidence, not an independent rerun.
- Exports contain one retained public snapshot. They do not follow relations,
  restore raw provider records, redact content, or deliver it elsewhere.
- Canonical and presentation omissions must remain visible in the answer.
- Causes remain hypotheses unless the retained evidence establishes them.

The skill stops when it can support the requested answer or name the exact
missing evidence or authorization. It does not search further only to add more
examples.

## Packaged layout

```text
skills/sessions/
  SKILL.md
  agents/openai.yaml
  references/
    evidence-protocol.md
    search-and-context.md
    retrospective.md
    preferences.md
    workflow-audit.md
    verification-audit.md
    handoff-continuity.md
    capability-discovery.md
```
