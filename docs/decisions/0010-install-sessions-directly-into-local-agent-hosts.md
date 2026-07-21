# 0010 — Install Sessions directly into local agent hosts

- Status: Accepted
- Date: 2026-07-21
- Supersedes: [0005 — Keep one-way ownership with Harness](0005-keep-one-way-ownership-with-harness.md)

## Context

Standalone Sessions now ships one public npm CLI and a matching packaged Agent
Skill. The legacy Harness implementation was removed before standalone
acceptance completed, and a downstream repository wrapper would add another
version, update, and rollback surface without adding product behavior. Agent
hosts already support installing a copied skill directly into local user state
from an immutable repository tag.

## Decision

Sessions is the sole implementation and distribution boundary. Install the CLI
from an exact supported `@ferueda/sessions` version and install the Agent Skill
directly into each local agent host from the matching immutable Sessions release
tag. The external skill installer owns host discovery, copying, upgrades,
removal, and its user-local lock.

No downstream repository owns a Sessions wrapper, package pin, vendored
snapshot, cache, or rollback route. Indexing remains a separate explicit user
command after installation and authorization.

## Consequences

CLI and skill versions have one release owner and can be verified against the
same tag without cross-repository coordination. Host-local upgrades or rollbacks
reinstall an exact supported Sessions release; they do not restore the removed
Harness implementation or migrate its cache. The external installer remains a
networked setup dependency, while ordinary Sessions runtime operation stays
local and telemetry-free.
