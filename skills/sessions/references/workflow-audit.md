# Workflow audit

Shared rules: [evidence protocol](evidence-protocol.md).

## Outcome

Audit whether a skill or workflow should have applied, what use evidence exists,
whether its required process was visible, and what outcome was later observed.
Do not collapse these questions into one effectiveness score.

## Establish the rubric

Record rubric provenance before selecting cases:

1. Exact historical skill/workflow content and hash, when retained.
2. A labeled reconstruction of the historical version, when exact content is
   unavailable.
3. The current version labeled as a retrospective rubric.

Keep session-specific user expectations separate. Cover only observable
criteria for trigger, process, output, safety, and verification.

## Select cases independently

Select candidate tasks from direct-human intent, not from the skill name. Grade
eligibility `should-use`, `should-not-use`, or `ambiguous` before inspecting use
signals.

Record every applicable signal; signals can coexist:

- `confirmed`: structured load or invocation evidence;
- `probable`: strong procedural evidence without a structural invocation;
- `requested`: the human asked for it;
- `declared`: the agent said it was using it;
- `mention-only`: the name appears without use evidence.

Use `absent` only when retained coverage is sufficient to rule out use. Use
`unknown` when omissions, missing version evidence, or incomplete coverage could
hide it.

## Build case traces

For each case, record canonical ID and ordinals for:

- direct-human task intent and eligibility;
- strongest invocation/load evidence;
- linked calls/results;
- required rubric steps and outputs;
- contemporaneous artifacts or verification;
- corrections and review findings;
- completion claims;
- known child or continuation sessions.

Grade each rubric criterion `met`, `violated`, or `unknown`, with evidence. Keep
process adherence separate from observed outcome: followed process can have a
poor outcome, and unfollowed process can have a good one. Recorded tool output is
historical evidence, not independently rerun proof.

## Synthesize

Group related sessions only by known root and report unknown lineage separately.
Include appropriate use, missed use, unnecessary use, correct non-use, and a
no-finding control when the corpus supports them. Base recommendations on a
recurring failure mode across independent roots; never claim causation from an
observational audit.

Before/after comparisons require exact skill-version attribution, comparable
task contexts, and enough independent known roots for a bounded conclusion.

## Report

Give rubric provenance, case-selection denominator, one evidence table per case,
separate process/outcome summaries, unknowns, and only supported changes to
trigger wording, negative triggers, workflow clarity, criteria, verification, or
observability. Emit sanitized regression/forward-test candidates; do not edit the
audited skill.

**Done when:** eligibility, use signals, rubric grades, outcomes, lineage, and
unknowns are independently traceable and the report makes no composite or causal
claim.
