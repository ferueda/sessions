# 0004 — Publish a compiled Node.js CLI

- Status: Accepted
- Date: 2026-07-13
- Narrowly superseded by:
  [ADR 0009](0009-establish-the-supported-release-baseline.md) for the sole
  unsupported `0.0.0` bootstrap seed.

## Context

A source-checkout installer and symlinked TypeScript entrypoint make global use and upgrades contributor-specific. Users need an ordinary package with a tested executable boundary.

## Decision

Develop in TypeScript ESM and publish compiled JavaScript for Node.js 24.16 or newer. Node 24.16 is the minimum because it fixes embedded-NUL truncation in `node:sqlite` TEXT reads. The intended package is `@ferueda/sessions`; the binary is `sessions`. An allowlisted tarball and isolated packed-install smoke test are release gates. pnpm remains a contributor tool, not a runtime requirement.

## Consequences

Development and build configs stay separate, relative `.ts` imports are
rewritten, and release CI must test the generated package on supported operating
systems. npm scope ownership and trusted publishing are required for every
supported release. ADR 0009 permits only the qualified, unsupported `0.0.0`
package seed needed to configure that trust.
