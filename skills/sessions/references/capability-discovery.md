# Capability discovery

Shared rules: [evidence protocol](evidence-protocol.md).

## Outcome

Find recurring user work or tool friction that may deserve a reusable skill,
workflow, command, or guide, then produce a testable candidate rather than an
automatic implementation.

## Find recurring work

1. Start from direct-human task requests with `entries --actor human --origin
human --select first --format jsonl` and narrow activity or workspace bounds.
2. Use literal all/any search for repeated task language, corrections, manual
   workarounds, tool failures, missing commands, repeated file/command patterns,
   or recurring review feedback.
3. Inspect linked tool calls/results and nearby context to distinguish the user's
   goal from the agent's chosen mechanism.
4. Use search support totals and known roots to test recurrence. Keep copied text,
   same-root repetition, and unknown lineage separate.
5. Look for counterexamples: tasks where the behavior was unnecessary, already
   easy, or successfully handled another way.

## Shape a candidate

Describe the repeated user outcome, trigger and negative trigger, evidence across
independent roots, current friction, smallest reusable intervention, safety and
permission boundary, and a sanitized evaluation corpus. Prefer a guide or prompt
change when no new tool is needed. Do not claim semantic clustering or complete
portfolio coverage from literal queries.

## Report

Rank candidates by evidence strength, not novelty. For each, give canonical
cases/ordinals, support totals when available, counterexamples, unknowns, proposed
owner (skill, workflow, CLI, adapter observability, or docs), and a forward-test
prompt with pass/fail criteria.

**Done when:** each candidate is grounded in recurring independent evidence and
has a sanitized evaluation path, or the report says no reusable capability is
yet justified.
