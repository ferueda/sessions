# 0003 — Preserve provenance and deduplicated support

- Status: Accepted
- Date: 2026-07-13

## Context

Agent histories can represent injected instructions, delegated work, forks, and copied prompts as apparent user messages. Counting every row as independent intent produces false recurrence and misleading recommendations.

## Decision

Canonical content records origin and confidence, stable content hashes, occurrences, and available lineage. Reports distinguish occurrence count, unique-content count, and unique-root count. Unknown origin or lineage remains unknown. Facts and provenance precede interpretation.

## Consequences

The model and schema are richer than a flat message table, and adapters must preserve source evidence. Analyses can explain their support and avoid overstating patterns. Perfect provenance is not promised where provider formats omit evidence.
