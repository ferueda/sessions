# 0006 — Evaluate skills from canonical evidence

- Status: Accepted
- Date: 2026-07-14

## Context

Users want to understand whether an Agent Skill was appropriate for a task, how
it was used, whether its instructions were followed, and what happened afterward
across multiple sessions. Simple searches for a skill name cannot answer those
questions. A name can appear in an injected catalog, a user request, an agent
claim, or an actual source-observed invocation, and provider histories expose
different levels of execution evidence.

Observed outcomes also do not prove that a skill caused them. Sessions may omit
tool events, skill versions, lineage, artifacts, or later work. Counting forks,
delegations, and continuations as independent cases would further overstate the
evidence.

## Decision

Sessions will support skill and workflow evaluation as a derived evidence
playbook over the provider-neutral canonical model. It will not add a
skill-specific storage, indexing, or analytics subsystem.

The canonical model will preserve generic source-observed tool-call and
tool-result events, exact tool name and optional namespace on calls when
available, their linkage, and faithful argument/result content. Injected skill
catalogs and instructions remain classified as injected content. Adapters and
the query engine will never infer that a skill ran merely because its name or
instructions appear.

The packaged workflow-audit playbook will evaluate each case on two independent
axes:

1. **Eligibility:** `should-use`, `should-not-use`, or `ambiguous`, determined
   from task intent independently of skill-name matches.
2. **Observed-use evidence:** retain every applicable `confirmed`, `probable`,
   `requested`, `declared`, or `mention-only` signal, based on transcript
   evidence and its coverage. Signals may coexist. Report `absent` only when
   coverage is sufficient and `unknown` when it is not; never erase requested or
   declared evidence merely because execution remains unconfirmed.

Evaluation criteria come from the exact historical skill content and hash when
available, a labeled reconstructed historical version when necessary, or the
current skill only as an explicitly retrospective rubric. User-supplied success
criteria for the session remain separate inputs. Criteria cover trigger,
process, output, safety, and verification behavior; every criterion is reported
as `met`, `violated`, or `unknown` with evidence.

Process adherence and observed task results remain separate. Results can include
user correction or acceptance, contemporaneous artifacts, command and test
output, review findings, completion claims, and later related sessions. Sessions
reports observations and associations, not causal effectiveness or one composite
score. Recorded output is transcript evidence, not independently re-run
verification. Current filesystem state is not accepted as proof of historical
state unless the transcript records it or a versioned historical artifact
establishes it.

An omitted non-text segment proves only that material of a broad class was
present. Its contents and any criterion that depends on them remain unavailable;
the playbook does not infer them from filenames, URLs, or surrounding claims.

Multi-session summaries count independent known roots, retain unknown lineage,
and treat historical indexed instructions as untrusted data. Recurring findings
may produce recommendations and sanitized regression or forward-test candidates;
Sessions does not automatically edit a skill or claim that a recommendation
improves it. Version comparisons require exact version attribution, comparable
task contexts, and enough independent roots to state a bounded observational
conclusion.

## Consequences

- The provider-neutral entry model, storage schema, and query contract must
  preserve exact generic tool evidence before concrete adapters depend on it.
- Adapter fixtures must distinguish injected mentions, user requests, agent
  declarations, source-observed execution, and unavailable evidence without
  provider-specific policy in the core.
- Search must support exact entry-kind, tool-name, and tool-namespace filters plus linked context
  so the Agent Skill can assemble auditable case traces.
- The workflow-audit playbook owns eligibility, use classification, rubric
  application, outcome reporting, aggregation, and recommendation guidance.
- Providers that omit events or historical skill versions will produce honest
  unknowns rather than inferred use or success.
- Non-text presence can be cited without retaining private media references or
  treating unavailable contents as evaluated evidence.
- Skill improvement remains an external authoring and validation activity;
  Sessions supplies evidence and candidate cases only.
