# 0009 — Establish the supported release baseline

- Status: Accepted
- Date: 2026-07-17
- Narrowly supersedes:
  - the trusted-publisher-before-first-release consequence of
    [ADR 0004](0004-publish-a-compiled-node-cli.md) for the sole bootstrap seed;
  - the first-publication compatibility consequences of
    [ADR 0007](0007-retain-a-durable-canonical-library.md) and
    [ADR 0008](0008-explicit-orphan-content-repair.md).

## Context

npm trusted publishing can be configured only after the package exists. Sessions
also needs an exact point where its pre-launch reset policy ends and its
data-preserving compatibility promise begins.

## Decision

Publish one qualified `0.0.0` tarball interactively with maintainer 2FA, public
access, and the non-default `bootstrap` tag. It is an unsupported package seed:
it has no Git tag, provenance, support policy, or data-preserving migration
promise. npm's registry may still assign its required `latest` field to the sole
published version. The first supported release accepts that state only when both
`bootstrap` and `latest` point to the exact `0.0.0` seed, then advances `latest`
to `0.1.0`.

After that seed exists, bind the exact GitHub repository, workflow, protected
environment, and `npm publish` operation as the npm trusted publisher. Publish
`0.1.0` as the first supported `latest` release through GitHub OIDC with verified
provenance. Every later supported release follows that path.

`0.1.0` begins compatibility for retained Sessions data, CLI behavior, and
schema-1 structured output. Later changes must preserve those contracts or use
the documented migration/versioning process.

## Consequences

- The bootstrap exception ends as soon as the package exists.
- Release tests qualify one exact tarball across supported operating systems
  before publication.
- npm/GitHub account, App, environment, and trusted-publisher changes remain
  explicit maintainer operations outside repository tests.
- Existing delivery, durable-retention, explicit-deletion, privacy, and
  provider-read-only decisions remain unchanged.
