# Preferences

Shared rules: [evidence protocol](evidence-protocol.md).

## Outcome

Identify repeated, direct-human working preferences without turning one
correction, copied text, or a fork into a general rule.

## Find candidates

1. Search direct-human evidence with `--actor human --origin human`. Use literal
   terms for corrections, autonomy, testing, review, communication, scope, or a
   concrete behavior named by the user.
2. Inspect each candidate in context. Exclude injected, copied, model, tool, and
   delegated text from preference authorship.
3. Group support by query-provided known root. Keep unknown lineage separate.
   Repeated text within one root is recurrence, not independent confirmation.
4. Look for exceptions and counterexamples, including accepted work where the
   candidate rule did not apply.
5. Treat `entries --select last` only as the last matching canonical ordinal per
   session. It does not classify a correction or final preference.

## Decide

Call a preference recurring only when direct-human evidence supports the same
meaning across independent known roots and the relevant denominator is clear.
Report conflicts and context limits. If evidence is thin, copied, or lineage is
mostly unknown, return no finding rather than a broad rule.

## Report

For each supported preference, give a short statement, direct-human evidence by
canonical ID/ordinal, occurrence/unique-content/known-root/unknown-lineage totals
when search provides them, exceptions, confidence, and the scope where it
appears to apply.

**Done when:** every proposed preference has independent direct-human support and
visible exceptions, or the report says why no defensible preference exists.
