# Retrospective

Shared rules: [evidence protocol](evidence-protocol.md).

## Outcome

Explain what happened across an implementation or investigation: original
intent, divergence, correction, recovery, completion state, and unresolved work.

## Build the trace

1. Identify the target session and any directly recorded parent, fork, child, or
   continuation. Use query-provided root attribution to group only known roots.
2. Locate the first direct-human request, scope constraints, and declared success
   bar with `entries`, literal `search`, and bounded `show`.
3. Trace observed actions: agent decisions, linked tool calls/results, plan or
   scope changes, user corrections, rollbacks, review findings, verification,
   completion claims, and later contradiction.
4. Preserve order by canonical entry ordinal. A later correction qualifies the
   earlier claim; it does not erase it.
5. Separate:
   - **process:** whether required steps were visibly followed;
   - **outcome:** what the retained exchange says happened afterward;
   - **possible cause:** a labeled hypothesis supported by the trace.

## Report

- Original intent and success bar.
- Timeline with canonical IDs and ordinals.
- First divergence or failure evidence.
- Corrections and reversals.
- Recovery and recorded verification.
- Completion claims versus later evidence.
- Unresolved work, unknown lineage, and evidence gaps.
- A narrow prevention or diagnostic recommendation.

**Done when:** the material sequence is reproducible and every causal statement
is either directly evidenced or labeled as a hypothesis.
