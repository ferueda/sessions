# Handoff continuity

Shared rules: [evidence protocol](evidence-protocol.md).

## Outcome

Compare two or more retained sessions to show which goals, constraints,
decisions, risks, and unresolved work transferred across a parent, child, fork,
or continuation.

## Compare exact sessions

1. Resolve each session to its canonical ID. Use relation evidence from `show`
   and query-provided root attribution; do not infer a relation from similar
   text.
2. Inspect the source session's final relevant range and the destination
   session's opening range.
3. Build a transfer checklist from direct-human constraints, accepted decisions,
   verification state, blockers, open work, and explicit handoff text.
4. Mark each item `transferred`, `changed`, `omitted`, or `unknown`, citing both
   sides when available.
5. Inspect a known direct child or continuation when required. Do not recursively
   traverse or invent hidden lineage; report incomplete or unknown coverage.

## Report

Give the full source and destination canonical IDs rather than aliases, the exact
relation and root evidence, a source-to-destination checklist with canonical
ordinals, material omissions or changes, consequences observed later, and
unknowns caused by truncation, omissions, or missing sessions.

**Done when:** every continuity claim compares exact retained evidence on both
sides or is explicitly marked unknown, without inferred lineage.
