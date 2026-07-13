# 0005 — Keep one-way ownership with Harness

- Status: Accepted
- Date: 2026-07-13

## Context

The original Sessions tool remains useful inside Harness during standalone development. Maintaining two editable implementations would cause drift and ambiguous bug ownership.

## Decision

Leave the Harness implementation untouched until standalone parity. After parity, this repository becomes the sole implementation upstream. Harness keeps a thin wrapper around an exact released package or an immutable vendored release snapshot with version/checksum. Updates and fixes flow one way from Sessions into Harness.

## Consequences

Bootstrap has no risky cutover, while long-term ownership stays clear. Avoid submodules, bidirectional synchronization, and manual dual fixes. Harness-specific workflow guidance may remain in Harness without entering the general engine.
