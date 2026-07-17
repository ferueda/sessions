# M11b Cursor adapter parity

## Goal

Add one passive `cursor` source that captures the two proven current local store
families through the existing provider-neutral engine:

- `chat-store-v1`;
- `agent-checkpoint-store-v1`.

Cursor must then work through the current index, capture-scope, query, show,
export, deletion, doctor, and paths contracts without adding provider policy to
domain, storage, queries, rendering, or the Agent Skill. JSONL-only, legacy
Composer/App Support, cloud-only history, and inferred lineage remain explicit
coverage gaps.

[Cursor local format v1 evidence](../../docs/research/cursor-format-v1.md) is the
binding first-release field, authority, ordering, normalization, and failure
matrix. Implement it exactly. Stop if fixtures or live structural proof
contradict it; do not fill gaps from private text or product semantics.

## Changes

1. **Resolve and identify one local Cursor source.**
   Add `src/adapters/cursor/paths.ts`, `source-instance.ts`, `fingerprint.ts`, and
   `source.ts`. Resolve only the default `$HOME/.cursor` or
   `%USERPROFILE%\.cursor` root; accept an injected environment/path seam for
   tests without adding a public `CURSOR_HOME` option. Canonicalize an existing
   root and derive:

   ```text
   local-sha256-v1:<sha256(
     ["sessions-cursor-source-instance-v1",["cursor-home","<canonical-root>"]]
   )>
   ```

   Probe the root without transcript reads: missing is `unavailable`; a present
   non-directory or unreadable root is `unreadable`. Publish only sanitized
   probe roles and the existing path locator contract.

2. **Discover exact store-backed candidates without reading every transcript.**
   Add focused chat/catalog discovery modules under `src/adapters/cursor/`.
   Traverse only the binding root-relative grammar in binary component order:

   ```text
   chats/<scope>/<native-id>/{meta.json,store.db}
   projects/<project>/sdk-agent-store/<scope>/index.db
   projects/<project>/sdk-agent-store/<scope>/agents/
     agent-<sha256(agent_id)>/store.db
   ```

   Each placeholder is one opaque regular directory component. Chat metadata
   maps only to its sibling store; a catalog maps only to the sibling `agents`
   directory under the same project and SDK-agent scope. These containers never
   become identity or workspace, and discovery never recurses beyond the
   grammar or joins across scopes. Use the lease-scoped capture workspace once
   per WAL-backed catalog, then enumerate exact normalized agent rows from the
   private SQLite snapshot. Do not copy or parse per-session blob stores during
   stable discovery.

   - A chat candidate requires schema-1 `meta.json`, `hasConversation: true`, a
     non-empty raw directory ID, and a sibling regular `store.db`. Its candidate
     inputs are the exact admitted metadata value plus main/WAL descriptors.
   - An agent candidate requires catalog `agents.agent_id`, a parsed
     `latest_checkpoint_ref_json` with `storeKind: "local-agent-store"` and
     non-empty `blobId`, and the derived
     `sdk-agent-store/<scope>/agents/agent-<sha256(agent_id)>/store.db`. Its
     candidate inputs are the exact normalized catalog row plus main/WAL
     descriptors. Do not fingerprint the whole catalog, JSONL, or run events.
   - Freeze one `cursor-v1` candidate generation with logical `cursor://`
     locators. Descriptor tuples cover existence, file identity, size, mode, and
     nanosecond times. Raw provider paths stay private.
   - Native identity is the exact raw chat directory ID or catalog `agent_id`.
     Duplicate native IDs across scopes/families make discovery incomplete;
     never choose by order, timestamp, title, workspace, filename, digest, or
     transcript similarity.
   - A valid conversation metadata record or nonnull valid checkpoint whose
     exact derived store is missing, nonregular, or already claimed by another
     candidate makes discovery incomplete; never skip it or borrow another
     scope. Store schema, root, or `agentId` conflicts found during changed reads
     are candidate failures, so last-good evidence becomes stale or first
     capture unindexed.

   Freeze one generation only after two matching adapter-owned structural
   inventories around catalog capture and candidate construction. Record binary
   ordered relevant directory entries, entry types and identity/stat
   descriptors, selected main/WAL descriptors, and chat metadata captured
   read-only/no-follow where supported with matching pre/post descriptors and a
   bytes digest. Any relevant addition, removal, replacement, type/descriptor
   change, or metadata-bytes change is `source-changed`, making discovery
   incomplete so retained sessions remain unknown rather than missing.

   Discovery completeness is defined over the documented two-family matrix.
   Inspect one deferred signature only:
   `projects/<project>/agent-transcripts` as an immediate non-symlink directory.
   Never walk or read its JSONL descendants, and do not inspect out-of-root
   legacy/App Support or cloud state. Precedence is exact:

   - supported candidates present: return the complete supported generation;
   - only recognized `hasConversation: false` or null-checkpoint records: return
     a complete empty generation;
   - no candidates plus a deferred signature: throw `unsupported-format`, making
     discovery incomplete;
   - no supported, noncandidate, or deferred evidence: return a complete empty
     generation.

   If runtime mixed-cohort counts become required, stop: that needs a separate
   provider-neutral source-coverage contract.

3. **Share the proven SQLite main/WAL capture mechanism inside the adapter
   layer.**
   Extract the provider-neutral file-copy/hash/verify mechanics from
   `src/adapters/codex/state-snapshot.ts` into
   `src/adapters/shared/sqlite-source-snapshot.ts`. Keep thin Codex and Cursor
   wrappers that map failures to their existing sanitized source errors.
   Preserve Codex behavior. The shared module owns only read-only/no-follow
   main-plus-optional-WAL copy, hash, verify, retry, and private-snapshot
   mechanics. Provider schema, authority, discovery, and error classification
   remain in the thin provider wrappers.

   A changed Cursor read opens provider main/WAL files read-only with no-follow
   where supported, hashes and copies only those files into
   `SourceCaptureWorkspace`, verifies the same file identities and bytes around
   the copy, and opens SQLite only on the private copy. Provider SHM is never
   opened or copied; SQLite may create SHM only in the private directory. Main,
   WAL, or presence changes become `source-changed`; unsafe schema or content is
   `malformed` or `unsupported-format`; workspace failures remain workspace
   errors. Cleanup stays owned by the existing workspace.

4. **Implement the frozen format matrix with two readers and one normalizer.**
   Add store/root/message readers and `normalize.ts` under
   `src/adapters/cursor/`. Validate the exact `blobs(id,data)` and
   `meta(key,value)` schema, selected metadata root, and store `agentId`.
   `chat-store-v1` must match the chat native ID.
   `agent-checkpoint-store-v1` must match the catalog native ID and use the
   catalog checkpoint root.

   Treat the research format page as a tested parser contract. Decode the
   authoritative root with a dependency-free version-1 wire reader: validate
   the full stream against its exact allowed field/wire pairs, collect repeated
   32-byte field `1` values in wire order, and load each selected lowercase-hex
   blob. Preserve duplicates. A root with no field `1` values is a valid empty
   session. Skip only the documented opaque root fields; do not recurse or infer
   meaning.

   Use field-by-field authority:

   - chat metadata owns created/updated time, workspace, and explicit title;
     store metadata supplies only a title fallback; the selected store root owns
     transcript content;
   - agent catalog rows own identity, title/name, times, and selected root; the
     derived store owns transcript content. Catalog workspace, status, run, and
     metadata fields are structural/fingerprint evidence only and never become
     canonical session fields.

   Manually validate the exact message/content shapes; do not add Zod or a
   generic Cursor schema interpreter. Map `system`, `user`, `assistant`, and
   `tool` to system, human, model, and tool actors with high confidence. No
   per-message timestamp or tool namespace is present. Tag-like user text stays
   human; Cursor v1 has no proven injected-content discriminator.

   Expand text, reasoning, tool calls, and tool results in root/message/item
   order with contiguous ordinals. Use the existing RFC 8785 writer for call
   arguments and structured result values. Keep distinct provider-rendered
   result text, suppress only exact redundant string-result text, and turn only
   the documented redacted-reasoning and image records into ordered typed
   omissions without persisting their private payloads. Unknown keys, roles,
   discriminators, and structures are unsupported rather than generic
   omissions. Link results only to one exact prior call ID with a matching tool
   name. Side chats and subagents are independent sessions only when a supported
   reader admits them; relations stay empty and lineage coverage stays unknown.

5. **Prove the adapter at stable seams.**
   Add generated fixtures under `test/fixtures/cursor/`, adapter tests under
   `test/adapters/cursor/`, and
   `test/application/cursor-vertical-slice.sqlite.test.ts`.

   - Make the shared `SessionSource` fixture contract provider-neutral before
     registering Cursor. Replace its hard-coded “all four metadata fields
     absent” case with a fixture-declared identity and exact optional fields
     expected absent. Replace its hard-coded unknown/unknown provenance search
     with a fixture-declared supported provenance pair. Keep the existing Codex
     and synthetic fixtures asserting all four fields absent and
     unknown/unknown; let Cursor declare only format-valid optional absence and
     known actor provenance. Keep required Cursor timestamps and exact role
     provenance in Cursor-specific tests. This changes tests only, not the
     domain or source port.
   - Invoke the adjusted shared conformance suite for Cursor, with an independent
     required-input inventory and sensitive-value checks.
   - Lock root/source-instance vectors, POSIX and Windows path parsing, binary
     traversal order, the exact chat/catalog/store containment mapping, exact
     native identity, candidate-specific catalog invalidation, duplicate-ID and
     missing/conflicting-store incompleteness, cross-scope nonassociation, and
     no transcript/store capture for unchanged discovery.
   - Race relevant directory addition, removal, replacement, and type changes
     plus same-size chat metadata mutation across discovery. Prove they yield
     incomplete discovery and do not reconcile retained sessions as missing.
     Cover empty, noncandidate-only, supported-plus-deferred, and deferred-only
     roots without reading deferred JSONL.
   - Move the exhaustive main/WAL capture matrix to one shared snapshot test:
     main-only and WAL-only committed state, zero-byte main files, replacement,
     append, truncation, checkpoint, disappearance, provider SHM non-use, private
     SHM cleanup, and provider-tree immutability. Keep thin Codex compatibility
     and Cursor wrapper/error-mapping cases instead of duplicating the matrix.
   - Cover the complete binding format matrix: both authority branches, every
     allowed root field/wire pair, empty and repeated blob references, malformed
     wire, missing/duplicate blobs, malformed JSON, wrong schema/root/agent ID,
     unsupported-only layouts, exact role mapping, tag-like user text remaining
     human, structured and rendered tool results, image/redaction omissions,
     exact call/result linkage, multi-part expansion, and conservative lineage.
   - Through real Sessions SQLite, prove initial/stable indexing,
     adapter-version invalidation, last-good preservation, bounded fresh
     rediscovery, complete disappearance, incomplete discovery, reappearance,
     capture scope, provider-native ID filtering, forget, clear, and
     provider-free list/search/entries/show/export behavior.
   - Keep Codex snapshot/conformance/vertical tests green after the shared
     capture extraction.

6. **Register Cursor and update shipped proof.**
   Lazily register `cursor` beside `codex` only in `src/bin/sessions.ts`.
   Existing no-source indexing treats either unavailable provider as optional;
   `index --source cursor` remains strict. No CLI grammar, JSON/JSONL schema,
   query, or renderer branch is added.

   Extend the existing process/CLI tests and shared dist/package smoke with a
   synthetic ready Cursor root under an isolated HOME. Prove implicit
   mixed-provider registration, explicit Cursor selection, one linked query,
   provider-native ID lookup, show/export, provider-tree immutability, and no
   scratch residue. Keep lifecycle/failure matrices in the vertical slice, keep
   the current Codex journey, and avoid a second full command matrix.

7. **Document the exact support boundary without duplicating it.**
   Add `docs/reference/cursor-format-support.md` as the single current format
   matrix. Update only statements made false by Cursor registration in
   `README.md`, `docs/getting-started.md`, `docs/reference/agent-skill.md`,
   `docs/reference/codex-format-support.md`, `docs/contributing/setup.md`, the
   contributor index and adapter contract, and the CLI, architecture, privacy,
   testing, troubleshooting, and commands docs. Link to the Cursor format page
   rather than duplicating its storage authority and deferred coverage.

   Update the packaged skill's evidence protocol and search example to select
   the user-authorized registered source rather than hard-code Codex. Do not add
   a Cursor-specific route, analysis rule, or direct provider access. Update the
   V1 roadmap and remove this plan after implementation.

8. **Run one authorized live handoff check without adding a permanent command.**
   After deterministic proof and `pnpm check`, use the built production CLI and
   a temporary mode-0700 Sessions directory against the local macOS Cursor
   source. A temporary, uncommitted wrapper must keep JSON in memory, run seed
   and stable `index --source cursor`, select one retained Cursor session, and
   validate structured list/show/export shapes without printing their values.

   Require both supported families when the local source exposes them, no
   malformed/unsupported seed failure, a fully unchanged stable run, a healthy
   temporary library, unchanged selected provider main/WAL/SHM observations,
   and complete Sessions/scratch cleanup. Concurrent source change fails the
   check safely. Print aggregate counts and pass/fail booleans only—never paths,
   IDs, titles, content, fingerprints, blob IDs, or SQLite values. Delete the
   wrapper and temporary data in `finally`. This is one implementation handoff
   check, not a shipped script, package command, CI test, or compatibility claim.

## Verify

- `pnpm test test/adapters/cursor test/adapters/codex/state-snapshot.test.ts test/adapters/codex/source.test.ts test/application/cursor-vertical-slice.sqlite.test.ts test/application/codex-vertical-slice.sqlite.test.ts test/doctor-no-persistence.test.ts test/paths-no-persistence.test.ts test/index-optional-sources-no-persistence.test.ts test/cli.test.ts test/skill-contracts.test.ts`
- `pnpm check`
- With explicit local provider-read authority, run the one-off live handoff check
  from change 8 and inspect only its aggregate result.

## Boundaries

- No domain, application-port, indexing, repository, schema, query, output,
  renderer, or public Agent Skill route change.
- No JSONL-only, legacy Composer/App Support, cloud/shared-link/remote-only
  capture, Cursor API, hook installation, network access, or raw-provider backup.
- No identity, title, workspace, lineage, tool, or authority inference from
  filenames, directory order, timestamps, private text, UI semantics, or opaque
  undocumented fields.
- No provider SQLite open in place, provider SHM access, adapter cache, durable
  scratch, complete-account claim, or native Windows/Linux format-parity claim.
- Stop if either supported family requires a provider-specific core change, if
  fixed root traversal cannot account for its complete transcript, if exact
  identity/authority/fingerprints cannot be proven, or if safe WAL capture
  cannot preserve provider-owned state.
