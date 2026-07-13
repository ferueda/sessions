# 0002 — Isolate provider adapters

- Status: Accepted
- Date: 2026-07-13

## Context

The Harness implementation lets provider objects own indexing, cache access, querying, and transcript reads. That makes new providers change business logic and storage behavior.

## Decision

Each source implements an internal open `SessionSource` port with `probe`, `discover`, and `read`. Adapters normalize into canonical documents and import only application/domain contracts. Indexing, reconciliation, storage, query semantics, and presentation contain no provider branches. Only the binary composition root knows concrete implementations.

## Consequences

A third adapter can be added without modifying the engine. Adapters need complete fingerprints, explicit format versions, deterministic reads, typed failures, and shared conformance tests. V1 does not promise a public plugin ABI.
