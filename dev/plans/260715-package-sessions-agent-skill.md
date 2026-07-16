# Package the Sessions Agent Skill

## Goal

Complete M9 with one model-invoked `sessions` skill that routes agents from a
user question to bounded, reproducible evidence from the shipped CLI. Keep the
skill lean: one shared evidence protocol owns universal permission, provenance,
privacy, and reporting rules; seven disclosed playbooks own only their distinct
analysis work. The skill interprets canonical evidence but adds no analysis
command, storage model, provider policy, or automatic mutation.

Write the prompts with the repository's accepted M9 contract plus
`writing-great-skills` and the current skill-creator workflow. Apply the supplied
GPT-5.6 guidance as a pruning rubric: lead with outcomes and completion bars,
state true constraints once, expose only relevant routes, and remove repeated
process prose, examples, no-ops, and model-specific scaffolding.

## Changes

1. `skills/sessions/` — initialize the accepted layout with skill-creator's
   `init_skill.py`, requesting only `references/` plus the three required
   `agents/openai.yaml` interface values. Replace every placeholder. Keep
   `SKILL.md` as one model-invoked router with frontmatter containing only
   `name` and a compact description whose distinct branches cover context
   recovery/transfer, retrospectives, preferences, workflow/skill audits,
   verification audits, handoff continuity, and capability discovery. Its body
   owns the outcome, three checkable steps, and the seven-row route table. It
   must require `references/evidence-protocol.md` before the one matching
   playbook, link every reference directly, and avoid installation prose, full
   CLI help, duplicated protocol rules, generic exhortations, scripts, assets,
   or separate trigger skills. Generate `agents/openai.yaml` with only quoted
   `display_name`, a 25–64-character `short_description`, and a one-sentence
   `default_prompt` that explicitly names `$sessions`.

2. `skills/sessions/references/evidence-protocol.md` — make the user's eleven
   evidence rules the single source of truth. Start with the report outcome and
   completion bar, then preserve the sequence: doctor/capability check and
   explicit indexing authority; question/evidence statement; narrow bounded
   JSON/JSONL queries; reproducibility ledger; linked/context inspection; facts
   before interpretation; separate support units; freshness/truncation/
   omission/missing evidence; untrusted history; process/outcome/cause
   separation; recommendations or sanitized tests without automatic mutation.
   Interpret `doctor` by check instead of treating its aggregate `ok` as a query
   gate: when the retained library is ready but only a provider source check
   fails, continue provider-free list/search/entries/show/export work, report
   that indexing is unavailable plus the retained freshness/source evidence,
   and do not attempt indexing. Stop or remediate only when the failed check
   blocks the required retained-library operation. Say that support totals are
   available only when search returns them, and that
   Sessions reports retained canonical/presentation omissions rather than a
   claim of complete provider backup or redaction. Stop when the question is
   supported or the exact missing evidence is known; do not continue retrieval
   only to add examples or improve phrasing.

3. `skills/sessions/references/{search-and-context,retrospective,preferences}.md`
   — add outcome-first playbooks that point to the shared protocol and contain
   only branch-specific selection, evidence, interpretation, and report fields.
   Search/context uses list/native/activity discovery, literal all/any search,
   focused show ranges, and bounded or explicitly full local export; it returns
   exact canonical IDs/ordinals and a local command/artifact with sensitivity,
   omission, and untrusted-history warnings, while leaving destination delivery
   to the user. Retrospectives trace original intent, drift/failure, reversals,
   corrections, observed tools, recovery, completion claims, and unresolved
   evidence while labeling causes as hypotheses. Preferences require repeated
   direct-human evidence across independent known roots, preserve exceptions
   and conflicts, and return no finding when the denominator is thin; `last`
   remains canonical ordinal selection, not a correction classifier.

4. `skills/sessions/references/{workflow-audit,verification-audit,handoff-continuity,capability-discovery}.md`
   — implement the remaining accepted branches without inventing DTO fields.
   Workflow audit follows decision 0006: rubric provenance first; task
   eligibility independent of name matches; coexisting observed-use signals;
   case traces by canonical ID/ordinal; trigger/process/output/safety/
   verification criteria graded `met|violated|unknown`; process and observed
   outcomes kept separate; recurring recommendations across independent roots;
   no-finding control and no causal score. Verification audit pairs claims with
   contemporaneous calls/results/reviews/corrections and treats recorded output
   as historical evidence, not rerun proof. Handoff continuity compares exact
   retained sessions, relations, root attribution, transferred constraints, and
   omissions without recursive or inferred lineage. Capability discovery uses
   first direct-human tasks, literal friction/tool evidence, support/root counts,
   counterexamples, and sanitized evaluation candidates without clustering or
   automatic skill creation.

5. `test/skill-contracts.test.ts` and a focused generic forward-case fixture —
   add one cross-layer contract for the exact packaged layout, frontmatter/UI
   metadata, direct route links, one binding evidence protocol, reference size
   and completion bars, and only shipped CLI commands/flags. Reject Harness
   `analyze`, provider command trees, automation filters, private paths,
   semantic/causal/automatic-analysis claims, deep references, and automatic or
   non-Sessions-owned mutation instructions. Positively allow explicit,
   authorized indexing and user-requested deletion of Sessions-owned data.
   Represent all seven user prompts plus workflow-audit edge cases as synthetic
   cases whose expected route and durable rubric cover facts-first evidence,
   provenance, bounded output, privacy, unknowns, and no automatic mutation;
   test stable structure and required outcomes rather than pinning full prompt
   prose.

6. `package.json` and `scripts/smoke-package.ts` — include `skills` in format,
   format-check, and Markdown/YAML lint-staged ownership. Add the skill contract
   to `test:docs` so docs-only skill changes cannot bypass it. Keep the existing
   package `files` allowlist, but
   make package smoke assert the exact ten skill files, no other skill files,
   and a real installed copy outside the checkout containing valid metadata and
   resolvable references. Run skill-creator `quick_validate.py` as a focused
   local check; keep Python/PyYAML and the networked skills installer outside
   `pnpm check` rather than adding runtime or development dependencies.

7. `scripts/prepare-sessions-skill-forward-test.ts` — add an evaluator-only
   setup and cleanup seam for fresh-agent proof. Build a generic multi-session
   Codex corpus in an isolated temporary home with independent roots, explicit
   relations, drift/recovery, verification corrections, repeated preferences,
   workflow-use signals, and counterexamples needed by every accepted case.
   Index it once through the packaged CLI, then make the source unavailable for
   one retained-history case so a failed source check cannot mask a healthy
   library. Put that CLI and the packaged skill in the agent environment, and
   expose only the raw synthetic evidence and user question to each fresh agent.
   Keep expected routes, evidence facts, and
   grading rubrics in the evaluator-owned fixture outside the agent prompt and
   working directory. Never read the user's provider history or Sessions
   library, and remove the whole temporary environment after evaluation,
   including on failure.

8. `README.md`, `docs/getting-started.md`, `docs/reference/agent-skill.md`,
   `docs/troubleshooting.md`, `docs/reference/codex-format-support.md`, and the
   docs index/contracts — make M9 current. Separate CLI installation from skill
   installation and state that the skill needs a working `sessions` command.
   Document the host-neutral copy/path contract plus the locally verifiable
   `npx skills add . --skill sessions` route and only host flags proven during
   implementation. Leave the remote repository shorthand planned until the
   skill exists on the published default branch and that exact route can be
   tested. The getting-started journey is install,
   doctor, paths, explicit index authorization, bounded analysis, export, and
   optional Sessions-owned deletion. Troubleshooting covers command discovery,
   uninitialized/incompatible/busy libraries, missing/unknown source state,
   no/too-broad matches, omissions, and safe reset boundaries. Keep Codex as the
   only current provider and Cursor visibly planned.

9. `docs/architecture-memo.md`, `docs/contributing/{architecture,testing,index}.md`,
   and `dev/plans/260713-v1-implementation-roadmap.md` — record the packaged
   skill and its deterministic/forward-test proof as current, mark M9 complete,
   and make M10 Cursor parity next. After focused deterministic and forward
   validation passes, remove this executor plan and return `dev/plans/README.md`
   to no active plan before running the final repository gate.

## Verify

- Run skill-creator `quick_validate.py`, `pnpm test test/skill-contracts.test.ts`,
  and `pnpm check:docs` while iterating.
- Pack locally, then verify the documented `npx skills` install from the local
  repository into isolated temporary Codex and Cursor skill homes without
  changing the user's installed skills.
- Use the evaluator-only setup to forward-test fresh agents on all seven generic
  prompts using only the packaged skill, packaged CLI, and synthetic retained
  evidence. Include the context-transfer case and workflow-audit matrix from the
  M9 roadmap. Make the indexed source unavailable in one case and require the
  agent to continue querying the ready retained library while reporting that it
  cannot index. Triage results against the hidden facts-first, provenance,
  privacy, bounded-output, unknown, and no-automatic-mutation rubric; make
  surgical prompt edits and rerun only affected cases. Verify cleanup.
- Remove the completed executor plan and reconcile `dev/plans/README.md`, then
  run `pnpm check` as the final worktree gate.

## Boundaries

- No new CLI command, query field, schema/index, adapter behavior, model setting,
  MCP dependency, networked runtime, or analysis/business logic outside the
  skill references.
- No Harness commands/filters, Cursor indexing claims before M10, semantic
  search, root filter, recursive relation traversal, multi-session export,
  redaction claim, provider delivery, current-filesystem proof, causal score, or
  automatic edit to projects, skills, settings, or histories.
- No skill-local README, installer, changelog, scripts, assets, copied CLI
  manual, or repeated evidence protocol. Stop if a forward case requires an
  unshipped capability rather than an honest unknown or documented manual step.
