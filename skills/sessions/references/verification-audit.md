# Verification audit

Shared rules: [evidence protocol](evidence-protocol.md).

## Outcome

Test whether recorded completion claims were supported at the time and how later
results, reviews, or corrections changed their status.

## Pair claims with evidence

1. Find explicit completion, success, test, check, review, merge, or approval
   claims with literal search and direct-human/model filters.
2. Inspect nearby and linked entries for the exact command, tool call, result,
   exit state, reviewer finding, user acceptance, or failure that accompanied
   each claim.
3. Record whether evidence is contemporaneous, earlier, later, indirect, or
   absent. A command mention is not a result, and a completion marker is not task
   success.
4. Follow later corrections, reruns, reviews, and user reports. Qualify earlier
   claims instead of rewriting the historical sequence.
5. Treat retained tool output as historical transcript evidence. Do not describe
   it as an independently rerun check or use current filesystem state as proof of
   the historical result.

## Report

For each claim, provide canonical ID/ordinal, claimed state, paired evidence,
evidence timing, later qualifying evidence, and a status of `supported`,
`contradicted`, or `unknown`. Keep process evidence separate from the observed
outcome and name the smallest missing proof.

**Done when:** every audited claim is paired with exact retained evidence or an
explicit evidence gap, with no upgrade from recorded output to current proof.
