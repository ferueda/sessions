# Build the canonical export foundation

## Goal

Create the provider-neutral, privacy-safe foundation that every portable export
format will share: one closed public session-document projection, one stable
digest of the complete unbounded projection, and one retained-session attribution
contract read from the same immutable library snapshot. Persist and verify the
digest with each successful canonical replacement so later JSON, JSONL, and
Markdown renderers cannot disagree about document identity or accidentally expose
adapter-private fields.

This plan adds no command, renderer, adapter behavior, or provider access. It is
the required first half of M7; the independently reviewable JSON/JSONL delivery
plan consumes its types and storage contract.

## Locked decisions

- The public document projection is an exact allowlist. It includes title,
  provider timestamps, lineage coverage and ordered relations, ordered entries,
  safe tool/linkage fields, ordered segment provenance, exact text plus its
  canonical content hash, and admitted non-text omission class/source type.
- It excludes the root session identity, workspace, entry source locators,
  segment source metadata, provider/input locators, capture/source observations,
  freshness, adapter version, and the document digest itself. Relation target
  identities remain included because they are canonical lineage evidence.
- The document digest scheme is `sha256-sessions-document-jcs-v1`: SHA-256 over
  UTF-8 RFC 8785/JCS serialization of a version-tagged, complete, unbounded public
  document projection. Object member order and adapter insertion order cannot
  affect it; array order and exact well-formed Unicode text do. Unicode is never
  normalized.
- Identity and digest are independent public facts. Equal digests do not imply
  equal identity, lineage, authenticity, or safe instructions.
- Persist the fixed scheme and 32 digest bytes atomically on the canonical session
  row. A missing, malformed, unknown-scheme, or mismatching digest is canonical
  corruption. Do not recompute documents for list/search.
- This is another clean pre-launch schema-1 baseline checksum change. No migration
  or compatibility branch is added. An older development library fails closed and
  requires a fresh `SESSIONS_DATA_DIR` or manual removal of only the exact obsolete
  Sessions-owned directory before reindexing; current `data clear` must not be
  described as accepting an incompatible checksum.

The exact JCS input for `sha256-sessions-document-jcs-v1` is this structural
contract:

```ts
interface PublicSessionDocumentV1 {
  readonly documentSchema: "sessions-public-document-v1";
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lineageCoverage: "complete" | "unknown";
  readonly relations: readonly PublicSessionRelationV1[];
  readonly entries: readonly PublicSessionEntryV1[];
}

interface PublicSessionRelationV1 {
  readonly ordinal: number;
  readonly kind: "parent" | "child" | "fork" | "continuation" | "unknown";
  readonly target: {
    readonly source: { readonly kind: string; readonly instanceId: string };
    readonly nativeId: string;
  };
  readonly confidence: "high" | "medium" | "low" | "unknown";
}

interface PublicSessionEntryV1 {
  readonly ordinal: number;
  readonly kind: string;
  readonly actor: "human" | "model" | "tool" | "system" | "unknown";
  readonly timestamp?: string;
  readonly relatedEntryOrdinal?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolNamespace?: string;
  readonly content: readonly PublicContentSegmentV1[];
}

type PublicContentSegmentV1 =
  | {
      readonly ordinal: number;
      readonly kind: "text";
      readonly origin:
        | "human"
        | "injected"
        | "delegated"
        | "replayed-copied"
        | "model"
        | "tool"
        | "system"
        | "unknown";
      readonly originConfidence: "high" | "medium" | "low" | "unknown";
      readonly text: string;
      readonly contentHash: {
        readonly scheme: "sha256-utf8-v1";
        readonly digest: string;
      };
    }
  | {
      readonly ordinal: number;
      readonly kind: "omitted";
      readonly origin:
        | "human"
        | "injected"
        | "delegated"
        | "replayed-copied"
        | "model"
        | "tool"
        | "system"
        | "unknown";
      readonly originConfidence: "high" | "medium" | "low" | "unknown";
      readonly contentClass: "image" | "resource" | "structured" | "unknown";
      readonly sourceType: string;
    };
```

`documentSchema`, `lineageCoverage`, `relations`, `entries`, relation members,
entry `ordinal`/`kind`/`actor`/`content`, and every discriminant-specific segment
member are always present. `title`, `createdAt`, `updatedAt`, `timestamp`,
`relatedEntryOrdinal`, `toolCallId`, `toolName`, and `toolNamespace` are omitted
when absent; the digest shape never substitutes `null`. Relation and content
ordinals are their zero-based array positions, entries retain their admitted
canonical ordinals, and all three arrays preserve canonical order. This object—
with no identity, attribution, selection, output envelope, or digest member—is
the complete value serialized through JCS and hashed.

## Changes

1. `src/domain/public-session-document.ts` — define and construct the frozen
   `PublicSessionDocumentV1` allowlist and its relation, entry, text-segment, and
   omitted-segment values. Put an explicit document version inside the projected
   value. Construct every object field-by-field from an already validated
   `SessionDocument`; never spread canonical documents, entries, segments, source
   metadata, or adapter values. Preserve canonical array order and optional-field
   presence exactly. Export the digest value type, fixed scheme, strict lowercase
   64-hex shape guard, equality helper, and a projector usable by admission,
   storage verification, health, show, and export.

2. `src/domain/json-canonicalization.ts` and the digest owner in
   `src/domain/public-session-document.ts` — implement the narrow RFC 8785/JCS
   serializer required by the closed projection and feed its UTF-8 fragments
   directly into a Node SHA-256 hash rather than materializing a second complete
   transcript string. Sort object keys by UTF-16 code units, preserve array order,
   use ECMAScript JSON string/number serialization, reject lone surrogates,
   non-finite numbers, unsafe integers, unsupported values, and cyclic input, and
   perform no Unicode normalization. Keep this focused internal code instead of
   adding a runtime dependency. The public projection admits only well-formed
   strings, booleans, null-free optional fields, arrays, records, and safe integer
   ordinals, but the serializer must still fail closed when called incorrectly.

3. `src/application/validate-session.ts:admitSessionReplacement` and
   `ValidatedSessionReplacement` — after canonical validation and immutable
   snapshotting, construct the complete public projection once, compute its
   digest, and attach the frozen digest to the branded replacement. Digest work
   remains provider-neutral and happens only after validation; an adapter cannot
   supply or override it. Preserve current validation issues, last-good behavior,
   and atomic replacement/failure-recording semantics.

4. `src/infrastructure/sqlite/migrations/0001-bootstrap.ts`, a focused
   `sqlite-document-digest.ts` codec, and
   `sqlite-session-document.ts:replaceCanonicalDocument` — extend the one current
   baseline canonical-session row with the fixed scheme plus a STRICT 32-byte BLOB
   digest and checks that require both exact values. Encode only a valid domain
   digest and decode only an exact 32-byte `Uint8Array`; never rely on permissive
   hex decoding. Pass the admitted digest into replacement and write it with the
   document inside the existing leased `BEGIN IMMEDIATE` transaction. A failed
   document, digest, relation, entry, content, FTS, or tracking update rolls back
   the whole replacement and preserves the previous body and digest.

5. `src/domain/session-query.ts:SessionQuerySummary`,
   `src/application/ports/session-index.ts:IndexedSession`,
   `src/infrastructure/sqlite/sqlite-session-state.ts:readSessionSummary`, and
   `src/infrastructure/sqlite/sqlite-query-filters.ts` — add the retained public
   attribution needed by later output: required successful `capturedAt`, effective
   `sourceObservedAt`, last-good `adapterVersion`, and stored `documentDigest`, in
   addition to identity, source state, and freshness. Extract the effective source
   state/observation SQL expressions so filtering and returned attribution use the
   same definition: complete coverage uses the session presence observation;
   unknown coverage uses the source coverage observation. Read the last-good
   adapter version, never a newer failed revision. Treat missing or malformed
   attribution for a retained canonical document as corruption. Keep `workspace`
   internal for existing filters but never make it part of the public projection
   or digest.

6. `src/infrastructure/sqlite/sqlite-session-document.ts:readCanonicalDocument`,
   `src/infrastructure/sqlite/sqlite-session-index.ts`, and
   `src/infrastructure/sqlite/sqlite-index-health.ts` — decode the stored digest,
   reconstruct and validate the canonical document, recompute its complete public
   projection digest, and require an exact match on full-document reads and the
   existing semantic canonical-health walk. `getSession` must continue returning
   summary plus document under one immutable SQLite snapshot and prove both report
   the same stored digest. List/search summaries read the stored digest directly;
   do not introduce per-row document reconstruction or an N+1 query path. Digest
   corruption remains distinct from FTS projection damage and is never repaired by
   FTS rebuild or orphan maintenance.

7. Domain, application, SQLite contract, health, and schema tests — cover official
   JCS vectors relevant to the accepted value domain; object insertion-order
   invariance; array-order and every export-eligible-field sensitivity; exact
   Unicode preservation without normalization; root identity, workspace, source
   locator/metadata, source-state, capture, freshness, and adapter-observation
   invariance; relation-target sensitivity; equal documents under different root
   identities; immutable admission; strict scheme/hex/BLOB handling; and unknown
   values failing closed. Prove atomic digest/body replacement and rollback,
   stable digest across unchanged/missing/unknown observations, last-good adapter
   attribution after a latest failed revision, one-snapshot `getSession`, direct
   summary digest reads without document reconstruction, health/read failure on
   digest mismatch, and refusal of the prior schema checksum without mutation.
   Use only generic synthetic text/identities and assert private marker absence
   recursively.

8. `docs/contributing/architecture.md`, `docs/architecture-memo.md`,
   `docs/privacy.md`, `docs/contributing/testing.md`, and
   `dev/plans/260713-v1-implementation-roadmap.md` — describe the implemented
   projection/digest/storage boundary, same-snapshot attribution, corruption
   behavior, pre-launch reset consequence, and why the digest is neither an
   identity nor an authenticity/safety signal. Keep JSON/JSONL and Markdown
   delivery labeled planned until their renderers land. Record the accepted M7
   sequencing: foundation first, JSON/JSONL second, Markdown later before M9/V1.

## Verify

- Focused domain/application tests for public projection, JCS, digest admission,
  attribution, and last-good behavior.
- Focused SQLite schema/index/query/health tests for atomic persistence,
  one-snapshot reads, direct summary lookup, corruption, rollback, and prior
  checksum refusal.
- A deterministic generic large-document test confirms hashing consumes fragments
  without constructing one canonical transcript-sized string; elapsed time and
  memory are observations, not platform-sensitive release thresholds.
- `pnpm check`.

## Boundaries

- No `sessions export`, `--format`, JSON, JSONL, Markdown, public renderer, or
  generated-help change.
- No provider probe/read, adapter change, public adapter ABI, import/delivery,
  relation traversal, or transfer-lineage inference.
- No workspace, locator, source metadata, provider root, attachment/private media
  reference, hidden reasoning, or omitted provider payload enters the projection.
- No digest-only equality, identity replacement, signature/authentication claim,
  Unicode normalization, timestamp rewriting, Zod dependency, or externally
  supplied digest.
- No compatibility migration, silent reset, automatic deletion, FTS policy,
  orphan-repair, compaction, query ranking/filter/cursor, or retention change.
- Stop if implementation cannot preserve one closed projection for both hashing
  and later rendering, or if a required public field exists only in adapter-private
  metadata; reconcile the architecture instead of widening the privacy boundary.
