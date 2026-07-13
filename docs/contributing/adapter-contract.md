# Source adapter contract

Status: accepted internal V1 contract; no concrete adapter exists yet.

Adapters translate provider histories into canonical documents. They do not define indexing, storage, queries, rendering, or analysis policy.

## Port

`SessionSource` exposes:

- `kind`: open adapter identifier; never a closed Cursor/Codex union.
- `probe()`: report source availability/readability without mutation.
- `discover()`: yield candidates with identity, locator, complete-input fingerprint, and adapter format version.
- `read(candidate)`: deterministically normalize one complete candidate into a canonical `SessionDocument`.

The port and values live under `src/application/ports/`; canonical transcript values live under `src/domain/`.

## Rules

- Provider sources remain read-only.
- A fingerprint covers every file/row that can change normalized output.
- Parser behavior changes increment the adapter format version.
- Discovery order does not change canonical results.
- Missing optional metadata maps to absent/unknown values.
- Origin or lineage is classified only when source evidence supports it.
- Malformed/changing inputs return typed failures; no partial document is committed.
- Adapters import application/domain only—never SQLite, query, CLI, another adapter, or the composition root.
- Adapter output contains canonical content and diagnostic source metadata, not complete raw payload copies.

## Conformance proof

Each adapter will run the same contract suite for probe safety, deterministic discovery/read, complete fingerprints, malformed input, missing metadata, ordering, provenance fallback, and read-only behavior. Provider-specific golden fixtures prove parser fidelity. Fixtures must be synthetic and contain no personal paths or transcripts.

The V1 contract is internal. A public plugin ABI is deferred until multiple independent adapters prove the boundary.
