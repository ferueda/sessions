import { expect, test } from "vitest";

import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../../src/application/session-query-error.ts";
import { DEFAULT_SEARCH_LIMIT } from "../../src/application/search-sessions.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import { createSessionDocumentMetrics } from "../../src/domain/session-document-metrics.ts";
import { createSessionManifestQuery } from "../../src/domain/session-manifest.ts";
import {
  createSessionEntryQuery,
  createSessionListQuery,
  createSessionSearchQuery,
  type SessionEntryInventoryItem,
  type SessionEntryPage,
  type SessionQueryCursor,
} from "../../src/domain/session-query.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import {
  SESSION_QUERY_CONTRACT_TIMES,
  sessionQueryContractCorpus,
} from "../fixtures/session-query-corpus.ts";

export interface SessionQueryContractFixture {
  readonly query: SessionQueryRepository;
  /** A separate generated 201-session library for the non-paged manifest proof. */
  readonly largeManifestQuery: SessionQueryRepository;
  markManifestStale(identity: SessionIdentity): void;
  removeManifestMetrics(identity: SessionIdentity): void;
  /** Same corpus in a newly initialized library, for library-bound cursor checks. */
  recreateQuery(): Promise<SessionQueryRepository>;
  close(): Promise<void>;
}

export function runSessionQueryContract(
  createFixture: () => Promise<SessionQueryContractFixture> | SessionQueryContractFixture,
): void {
  test("returns one coherent transcript-free manifest with exact metrics and lineage", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    const document = corpus.inventory.continuation;
    try {
      const result = await fixture.query.manifest(
        createSessionManifestQuery({
          filter: {
            source: document.identity.source.kind,
            instance: document.identity.source.instanceId,
            nativeId: document.identity.nativeId,
            sourceState: "present",
            session: document.identity,
          },
        }),
      );

      expect(result.selection).toEqual({
        order: "canonical-identity-v1",
        maximumRevisions: 10_000,
        filters: {
          source: document.identity.source.kind,
          instance: document.identity.source.instanceId,
          nativeId: document.identity.nativeId,
          sourceState: "present",
          session: document.identity,
        },
      });
      expect(result.captureScope).toMatchObject({
        trackedSessions: 1,
        retainedSessions: { current: 1, stale: 0 },
        sourceState: { present: 1, missing: 0, unknown: 0 },
        appliedFilters: ["source", "instance", "nativeId", "sourceState", "session"],
        unassessedFilters: [],
      });
      expect(result.revisions).toHaveLength(1);
      expect(result.revisions[0]).toMatchObject({
        session: document.identity,
        documentDigest: {
          scheme: "sha256-sessions-document-jcs-v1",
          digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        sourceState: "present",
        freshness: "current",
        adapterVersion: "synthetic-v1",
        lineageCoverage: document.lineageCoverage,
        root: { kind: "known", root: corpus.inventory.root.identity },
        counts: manifestCounts(document),
      });
      expect(result.revisions[0]).not.toHaveProperty("title");
      expect(result.revisions[0]).not.toHaveProperty("workspace");
      expect(result.revisions[0]).not.toHaveProperty("entries");
      expect(Object.isFrozen(result.revisions[0]?.counts)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  test("applies exact activity, capture, observation, state, and identity filters", async () => {
    const fixture = await createFixture();
    const target = sessionQueryContractCorpus().present;
    try {
      const result = await fixture.query.manifest(
        createSessionManifestQuery({
          filter: {
            source: target.identity.source.kind,
            instance: target.identity.source.instanceId,
            nativeId: target.identity.nativeId,
            sourceState: "present",
            activityAfter: "2026-07-14T09:29:59.999Z",
            activityBefore: "2026-07-14T09:30:00.001Z",
            capturedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            capturedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
            observedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            observedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
            session: target.identity,
          },
        }),
      );

      expect(result.revisions.map(({ session }) => key(session))).toEqual([key(target.identity)]);
      expect(result.captureScope).toMatchObject({
        appliedFilters: ["source", "instance", "nativeId", "sourceState", "session"],
        unassessedFilters: [
          "activityAfter",
          "activityBefore",
          "capturedAfter",
          "capturedBefore",
          "observedAfter",
          "observedBefore",
        ],
      });
    } finally {
      await fixture.close();
    }
  });

  test("covers present, missing, and unknown retained source state", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      for (const [document, sourceState] of [
        [corpus.present, "present"],
        [corpus.missing, "missing"],
        [corpus.unknown, "unknown"],
      ] as const) {
        const result = await fixture.query.manifest(
          createSessionManifestQuery({
            filter: { session: document.identity, sourceState },
          }),
        );
        expect(result.revisions).toHaveLength(1);
        expect(result.revisions[0]).toMatchObject({
          session: document.identity,
          sourceState,
          counts: manifestCounts(document),
        });
      }
    } finally {
      await fixture.close();
    }
  });

  test("reports a retained failed revision as stale from its last good capture", async () => {
    const fixture = await createFixture();
    const target = sessionQueryContractCorpus().present.identity;
    try {
      fixture.markManifestStale(target);
      const result = await fixture.query.manifest(
        createSessionManifestQuery({ filter: { session: target } }),
      );
      expect(result.revisions).toHaveLength(1);
      expect(result.revisions[0]).toMatchObject({
        session: target,
        freshness: "stale",
        adapterVersion: "synthetic-v1",
      });
    } finally {
      await fixture.close();
    }
  });

  test("uses case-sensitive filters, contradiction-safe matching, and binary identity order", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const ordered = await fixture.query.manifest(
        createSessionManifestQuery({ filter: { source: "rank-b" } }),
      );
      expect(ordered.revisions.map(({ session }) => key(session))).toEqual(
        corpus.ranking.binaryOrder.slice(1).map(({ identity }) => key(identity)),
      );
      await expect(
        fixture.query.manifest(
          createSessionManifestQuery({ filter: { source: "rank-b", instance: "a" } }),
        ),
      ).resolves.toMatchObject({
        revisions: [{ session: { nativeId: "A" } }, { session: { nativeId: "a" } }],
      });
      await expect(
        fixture.query.manifest(
          createSessionManifestQuery({ filter: { source: "rank-b", instance: "A" } }),
        ),
      ).resolves.toMatchObject({ revisions: [{ session: { nativeId: "same" } }] });
      await expect(
        fixture.query.manifest(
          createSessionManifestQuery({
            filter: {
              nativeId: corpus.missing.identity.nativeId,
              session: corpus.present.identity,
            },
          }),
        ),
      ).resolves.toMatchObject({ revisions: [] });
      await expect(
        fixture.query.manifest(createSessionManifestQuery({ filter: { nativeId: "Same" } })),
      ).resolves.toMatchObject({ revisions: [] });
      await expect(
        fixture.query.manifest(createSessionManifestQuery({ filter: { source: "rank-b" } })),
      ).resolves.toEqual(ordered);
    } finally {
      await fixture.close();
    }
  });

  test("returns all 201 generated revisions without a page cursor", async () => {
    const fixture = await createFixture();
    try {
      const result = await fixture.largeManifestQuery.manifest(createSessionManifestQuery());
      expect(result.revisions).toHaveLength(201);
      expect(result.revisions[0]?.session.nativeId).toBe("manifest-000");
      expect(result.revisions.at(-1)?.session.nativeId).toBe("manifest-200");
      expect(new Set(result.revisions.map(({ session }) => key(session))).size).toBe(201);
    } finally {
      await fixture.close();
    }
  });

  test("fails the whole manifest when a selected canonical session lacks metrics", async () => {
    const fixture = await createFixture();
    const target = sessionQueryContractCorpus().present.identity;
    try {
      fixture.removeManifestMetrics(target);
      await expect(
        fixture.query.manifest(createSessionManifestQuery({ filter: { session: target } })),
      ).rejects.toMatchObject({ code: "corrupt-data" });
    } finally {
      await fixture.close();
    }
  });

  test("lists with every shared exact, time, state, and identity filter", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      if (corpus.present.workspace === undefined) throw new Error("Corpus workspace is required");
      const result = await fixture.query.list(
        createSessionListQuery({
          filter: {
            source: corpus.present.identity.source.kind,
            instance: corpus.present.identity.source.instanceId,
            nativeId: corpus.present.identity.nativeId,
            sourceState: "present",
            workspace: corpus.present.workspace,
            capturedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            capturedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
            observedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            observedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
            session: corpus.present.identity,
          },
          limit: 200,
        }),
      );

      expect(result.sessions.map(({ identity }) => key(identity))).toEqual([
        key(corpus.present.identity),
      ]);
      await expect(
        fixture.query.list(
          createSessionListQuery({
            filter: {
              source: corpus.present.identity.source.kind,
              instance: corpus.present.identity.source.instanceId,
              workspace: "/workspace/primary",
            },
            limit: 200,
          }),
        ),
      ).resolves.toMatchObject({ sessions: [] });
    } finally {
      await fixture.close();
    }
  });

  test("reports one capture scope with exact filter disclosure for every query kind", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      if (corpus.present.workspace === undefined) throw new Error("Corpus workspace is required");
      const listed = await fixture.query.list(
        createSessionListQuery({
          filter: {
            source: corpus.present.identity.source.kind,
            instance: corpus.present.identity.source.instanceId,
            nativeId: corpus.present.identity.nativeId,
            sourceState: "present",
            workspace: corpus.present.workspace,
            capturedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            capturedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
            observedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            observedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
            session: corpus.present.identity,
          },
          limit: 20,
        }),
      );
      expect(listed.captureScope).toEqual({
        status: "complete",
        trackedSessions: 1,
        retainedSessions: { current: 1, stale: 0 },
        unindexedSessions: 0,
        sourceState: { present: 1, missing: 0, unknown: 0 },
        sourceCoverage: { complete: 1, unknown: 0 },
        latestFailures: {
          unavailable: 0,
          unreadable: 0,
          malformed: 0,
          sourceChanged: 0,
          unsupportedFormat: 0,
          repositoryWrite: 0,
        },
        appliedFilters: ["source", "instance", "nativeId", "sourceState", "session"],
        unassessedFilters: [
          "workspace",
          "capturedAfter",
          "capturedBefore",
          "observedAfter",
          "observedBefore",
        ],
      });

      const searched = await fixture.query.search(
        createSessionSearchQuery({
          text: "filterable",
          filter: { session: corpus.present.identity, actor: "model" },
          limit: 20,
          context: 0,
        }),
      );
      expect(searched.captureScope).toMatchObject({
        status: "complete",
        trackedSessions: 1,
        appliedFilters: ["session"],
        unassessedFilters: ["actor", "searchText"],
      });

      const entries = await fixture.query.entries(
        createSessionEntryQuery({
          filter: { session: corpus.unknown.identity, entryKind: "message" },
          limit: 20,
        }),
      );
      expect(entries.captureScope).toMatchObject({
        status: "incomplete",
        trackedSessions: 1,
        retainedSessions: { current: 1, stale: 0 },
        sourceState: { present: 0, missing: 0, unknown: 1 },
        sourceCoverage: { complete: 0, unknown: 1 },
        appliedFilters: ["session"],
        unassessedFilters: ["entryKind"],
      });
    } finally {
      await fixture.close();
    }
  });

  test("finds retained sessions by exact provider-native ID", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const expected = corpus.ranking.binaryOrder.filter(
        ({ identity }) => identity.nativeId === "same",
      );
      const narrowTarget = expected[1];
      if (narrowTarget === undefined) throw new Error("Native-ID fixture requires two matches");
      const listed = await fixture.query.list(
        createSessionListQuery({
          filter: { nativeId: "same" },
          limit: 200,
        }),
      );
      const searched = await fixture.query.search(
        createSessionSearchQuery({
          text: "binaryrank",
          filter: { nativeId: "same" },
          limit: 20,
          context: 0,
        }),
      );
      const narrowed = await fixture.query.list(
        createSessionListQuery({
          filter: {
            source: narrowTarget.identity.source.kind,
            instance: narrowTarget.identity.source.instanceId,
            nativeId: "same",
          },
          limit: 200,
        }),
      );
      const wrongCase = await fixture.query.list(
        createSessionListQuery({
          filter: { nativeId: "Same" },
          limit: 200,
        }),
      );
      const contradictory = await fixture.query.list(
        createSessionListQuery({
          filter: {
            nativeId: corpus.missing.identity.nativeId,
            session: corpus.present.identity,
          },
          limit: 200,
        }),
      );

      expect(listed.sessions.map(({ identity }) => key(identity))).toEqual(
        expected.map(({ identity }) => key(identity)),
      );
      expect(searched.hits.map(({ session }) => key(session.identity))).toEqual(
        expected.map(({ identity }) => key(identity)),
      );
      expect(searched.support).toEqual({
        occurrences: 2,
        uniqueContent: 1,
        uniqueKnownRoots: 2,
        unknownLineageSessions: 0,
      });
      expect(narrowed.sessions.map(({ identity }) => key(identity))).toEqual([
        key(narrowTarget.identity),
      ]);
      expect(wrongCase.sessions).toEqual([]);
      expect(contradictory.sessions).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("searches literal Unicode and quotes while applying entry and opaque identity filters", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const literal = await fixture.query.search(
        createSessionSearchQuery({
          text: 'naïve "quoted phrase" abc:123@v1',
          filter: { session: corpus.present.identity },
          limit: 20,
          context: 0,
        }),
      );
      expect(literal.hits).toHaveLength(1);
      expect(literal.hits[0]?.session.identity).toEqual(corpus.present.identity);
      expect(literal.hits[0]?.entry.ordinal).toBe(0);
      expect(literal.hits[0]?.snippet.contentHash).toEqual(
        hashContent('filterable unicode naïve "quoted phrase" opaque abc:123@v1'),
      );

      const filtered = await fixture.query.search(
        createSessionSearchQuery({
          text: "filterable",
          filter: {
            session: corpus.present.identity,
            actor: "model",
            origin: "model",
            entryKind: "analysis-note",
            entryAfter: "2026-07-14T09:19:59.999Z",
            entryBefore: "2026-07-14T09:20:00.001Z",
          },
          limit: 20,
          context: 0,
        }),
      );
      expect(filtered.hits.map(({ entry }) => entry.ordinal)).toEqual([1]);

      const injected = await fixture.query.search(
        createSessionSearchQuery({
          text: "toolfilter",
          filter: { origin: "injected" },
          limit: 20,
          context: 0,
        }),
      );
      expect(injected.hits.map(({ entry }) => entry.ordinal)).toEqual([4]);
    } finally {
      await fixture.close();
    }
  });

  test("uses unicode61 case folding and diacritic removal", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const byCase = await search(fixture.query, "UNICODE", corpus.present.identity);
      const byDiacritic = await search(fixture.query, "naive", corpus.present.identity);

      expect(byCase.hits.map(({ entry }) => entry.ordinal)).toEqual([0]);
      expect(byDiacritic.hits.map(({ entry }) => entry.ordinal)).toEqual([0]);
    } finally {
      await fixture.close();
    }
  });

  test("matches any literal term and reports the qualifying terms per entry", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    const filter = { session: corpus.literalAny.identity } as const;
    try {
      const defaultAll = await fixture.query.search(
        createSessionSearchQuery({
          text: "unionalpha unionbeta",
          filter,
          limit: 20,
          context: 0,
        }),
      );
      const explicitAll = await fixture.query.search(
        createSessionSearchQuery({
          text: "unionalpha unionbeta",
          termMode: "all",
          filter,
          limit: 20,
          context: 0,
        }),
      );
      expect(explicitAll).toEqual(defaultAll);
      expect(defaultAll.hits.map(({ entry }) => entry.ordinal)).toEqual([1]);
      expect(defaultAll.hits[0]?.matchedTerms).toEqual(["unionalpha", "unionbeta"]);

      const any = await fixture.query.search(
        createSessionSearchQuery({
          text: "unionalpha unionbeta",
          termMode: "any",
          filter,
          limit: 20,
          context: 0,
        }),
      );
      expect(
        new Map(any.hits.map(({ entry, matchedTerms }) => [entry.ordinal, matchedTerms])),
      ).toEqual(
        new Map([
          [0, ["unionalpha", "unionbeta"]],
          [1, ["unionalpha", "unionbeta"]],
          [2, ["unionalpha", "unionbeta"]],
        ]),
      );
      expect(any.support).toEqual({
        occurrences: 5,
        uniqueContent: 3,
        uniqueKnownRoots: 1,
        unknownLineageSessions: 0,
      });

      const humanOrigin = await fixture.query.search(
        createSessionSearchQuery({
          text: "unionalpha unionbeta",
          termMode: "any",
          filter: { ...filter, origin: "human" },
          limit: 20,
          context: 0,
        }),
      );
      const byOrdinal = new Map(
        humanOrigin.hits.map(({ entry, matchedTerms }) => [entry.ordinal, matchedTerms]),
      );
      expect(byOrdinal.get(2)).toEqual(["unionalpha"]);
      expect(humanOrigin.support.occurrences).toBe(4);

      const duplicate = await fixture.query.search(
        createSessionSearchQuery({
          text: "unionalpha unionalpha",
          termMode: "any",
          filter,
          limit: 20,
          context: 0,
        }),
      );
      expect(duplicate.hits.every(({ matchedTerms }) => matchedTerms.length === 1)).toBe(true);
      expect(duplicate.support.occurrences).toBe(3);
    } finally {
      await fixture.close();
    }
  });

  test("excludes missing entry timestamps from bounds and uses effective observation time", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const timeless = await fixture.query.search(
        createSessionSearchQuery({
          text: "timeless-filterable",
          filter: { session: corpus.present.identity },
          limit: 20,
          context: 0,
        }),
      );
      expect(timeless.hits.map(({ entry }) => entry.ordinal)).toEqual([5]);
      await expect(
        fixture.query.search(
          createSessionSearchQuery({
            text: "timeless-filterable",
            filter: {
              session: corpus.present.identity,
              entryAfter: "2026-07-14T00:00:00.000Z",
              entryBefore: "2026-07-15T00:00:00.000Z",
            },
            limit: 20,
            context: 0,
          }),
        ),
      ).resolves.toMatchObject({ hits: [] });

      await expectStateAt(
        fixture.query,
        corpus.present.identity,
        "present",
        SESSION_QUERY_CONTRACT_TIMES.present,
      );
      await expectStateAt(
        fixture.query,
        corpus.missing.identity,
        "missing",
        SESSION_QUERY_CONTRACT_TIMES.missing,
      );
      await expectStateAt(
        fixture.query,
        corpus.unknown.identity,
        "unknown",
        SESSION_QUERY_CONTRACT_TIMES.unknown,
      );

      const oldLastSeenWindow = await fixture.query.list(
        createSessionListQuery({
          filter: {
            source: corpus.unknown.identity.source.kind,
            instance: corpus.unknown.identity.source.instanceId,
            sourceState: "unknown",
            observedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            observedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
          },
          limit: 20,
        }),
      );
      expect(oldLastSeenWindow.sessions).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("keeps disappeared provider evidence and trusts only observed tool-call fields", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const retained = await fixture.query.search(
        createSessionSearchQuery({
          text: "retained-disappearance",
          filter: { sourceState: "missing" },
          limit: 20,
          context: 0,
        }),
      );
      expect(retained.hits.map(({ session }) => key(session.identity))).toEqual([
        key(corpus.missing.identity),
      ]);

      const unfiltered = await fixture.query.search(
        createSessionSearchQuery({ text: "toolfilter", limit: 20, context: 0 }),
      );
      expect(unfiltered.hits).toHaveLength(3);
      const observed = await fixture.query.search(
        createSessionSearchQuery({
          text: "toolfilter",
          filter: { toolName: "read_file", toolNamespace: "filesystem" },
          limit: 20,
          context: 0,
        }),
      );
      expect(observed.hits).toHaveLength(1);
      expect(observed.hits[0]?.entry).toMatchObject({
        ordinal: 2,
        kind: "tool-call",
        toolName: "read_file",
        toolNamespace: "filesystem",
      });
    } finally {
      await fixture.close();
    }
  });

  test("ranks stronger BM25 evidence before newer but weaker evidence", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const result = await search(fixture.query, "bm25rank");

      expect(result.hits.map(({ session }) => key(session.identity))).toEqual([
        key(corpus.ranking.bm25Better.identity),
        key(corpus.ranking.bm25Worse.identity),
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("breaks equal BM25 scores by updated/created activity with null last", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const result = await search(fixture.query, "activityrank");

      expect(result.hits.map(({ session }) => key(session.identity))).toEqual(
        corpus.ranking.activityOrder.map(({ identity }) => key(identity)),
      );
    } finally {
      await fixture.close();
    }
  });

  test("filters list, search, and entries by effective session activity", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    const [newest, fallback, older] = corpus.ranking.activityOrder;
    if (newest === undefined || fallback === undefined || older === undefined) {
      throw new Error("Activity corpus is incomplete");
    }
    const filter = {
      source: newest.identity.source.kind,
      instance: newest.identity.source.instanceId,
      activityAfter: "2026-07-14T14:30:00.000Z",
      activityBefore: "2026-07-14T16:00:00.000Z",
    } as const;
    try {
      const listed = await fixture.query.list(createSessionListQuery({ filter, limit: 20 }));
      const searched = await fixture.query.search(
        createSessionSearchQuery({ text: "activityrank", filter, limit: 20, context: 0 }),
      );
      const entries = await fixture.query.entries(
        createSessionEntryQuery({ filter, selection: "first", limit: 20 }),
      );

      expect(listed.sessions.map(({ identity }) => key(identity))).toEqual([
        key(fallback.identity),
      ]);
      expect(searched.hits.map(({ session }) => key(session.identity))).toEqual([
        key(fallback.identity),
      ]);
      expect(searched.support).toEqual({
        occurrences: 1,
        uniqueContent: 1,
        uniqueKnownRoots: 1,
        unknownLineageSessions: 0,
      });
      expect(entries.entries.map(({ session }) => key(session.identity))).toEqual([
        key(fallback.identity),
      ]);

      const updatedWins = await fixture.query.list(
        createSessionListQuery({
          filter: {
            session: older.identity,
            activityAfter: "2026-07-14T14:00:00.000Z",
            activityBefore: "2026-07-14T14:20:00.000Z",
          },
          limit: 20,
        }),
      );
      expect(updatedWins.sessions).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("breaks remaining ties by raw binary identity and entry ordinal", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const result = await search(fixture.query, "binaryrank");
      const [kind, instance, native, entries] = corpus.ranking.binaryOrder;
      if (
        kind === undefined ||
        instance === undefined ||
        native === undefined ||
        entries === undefined
      ) {
        throw new Error("Binary ranking corpus is incomplete");
      }

      expect(result.hits.map(hitKey)).toEqual([
        `${key(kind.identity)}#0`,
        `${key(instance.identity)}#0`,
        `${key(native.identity)}#0`,
        `${key(entries.identity)}#0`,
        `${key(entries.identity)}#1`,
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("does not boost rank for repeated occurrences of identical content", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const result = await search(fixture.query, "occurrencerank");

      expect(result.hits.map(({ session }) => key(session.identity))).toEqual([
        key(corpus.ranking.singleOccurrence.identity),
        key(corpus.ranking.repeatedOccurrence.identity),
      ]);
      expect(result.hits.map(({ snippet }) => snippet.additionalMatchingSegments)).toEqual([0, 4]);
      expect(result.support.occurrences).toBe(6);
      expect(result.support.uniqueContent).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test("enumerates entries with shared, entry, time, and identity filters", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      if (corpus.present.workspace === undefined) throw new Error("Corpus workspace is required");
      const result = await fixture.query.entries(
        createSessionEntryQuery({
          filter: {
            source: corpus.present.identity.source.kind,
            instance: corpus.present.identity.source.instanceId,
            nativeId: corpus.present.identity.nativeId,
            sourceState: "present",
            workspace: corpus.present.workspace,
            capturedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            capturedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
            observedAfter: before(SESSION_QUERY_CONTRACT_TIMES.present),
            observedBefore: after(SESSION_QUERY_CONTRACT_TIMES.present),
            session: corpus.present.identity,
            entryAfter: "2026-07-14T09:19:59.999Z",
            entryBefore: "2026-07-14T09:20:00.001Z",
            actor: "model",
            origin: "model",
            entryKind: "analysis-note",
          },
          limit: 200,
        }),
      );

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({
        session: { identity: corpus.present.identity, sourceState: "present" },
        entry: { ordinal: 1, kind: "analysis-note", actor: "model" },
        root: { kind: "known", root: corpus.present.identity },
        content: {
          textSegmentCount: 1,
          omittedSegmentCount: 0,
          unpreviewedTextSegmentCount: 0,
          preview: {
            segmentOrdinal: 0,
            origin: "model",
            originConfidence: "high",
            contentHash: hashContent("filterable model analysis"),
            text: "filterable model analysis",
            truncated: false,
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("memory://query/");
      expect(JSON.stringify(result)).not.toContain("sourceMetadata");

      await expect(
        fixture.query.entries(
          createSessionEntryQuery({
            filter: {
              session: corpus.present.identity,
              workspace: "/workspace/primary",
            },
            limit: 200,
          }),
        ),
      ).resolves.toMatchObject({ entries: [] });
    } finally {
      await fixture.close();
    }
  });

  test("applies entry filters before first and last selection", async () => {
    const fixture = await createFixture();
    const root = sessionQueryContractCorpus().inventory.root;
    try {
      const firstHuman = await fixture.query.entries(
        createSessionEntryQuery({
          filter: { session: root.identity, actor: "human" },
          selection: "first",
          limit: 20,
        }),
      );
      const lastHuman = await fixture.query.entries(
        createSessionEntryQuery({
          filter: { session: root.identity, actor: "human" },
          selection: "last",
          limit: 20,
        }),
      );
      const boundedFirst = await fixture.query.entries(
        createSessionEntryQuery({
          filter: {
            session: root.identity,
            actor: "human",
            entryAfter: "2026-07-14T08:10:00.000Z",
          },
          selection: "first",
          limit: 20,
        }),
      );
      const lastInjected = await fixture.query.entries(
        createSessionEntryQuery({
          filter: { session: root.identity, origin: "injected" },
          selection: "last",
          limit: 20,
        }),
      );

      expect(firstHuman.entries.map(({ entry }) => entry.ordinal)).toEqual([1]);
      expect(lastHuman.entries.map(({ entry }) => entry.ordinal)).toEqual([9]);
      expect(boundedFirst.entries.map(({ entry }) => entry.ordinal)).toEqual([2]);
      expect(lastInjected.entries).toMatchObject([
        {
          entry: { ordinal: 6, kind: "omission" },
          content: {
            textSegmentCount: 0,
            omittedSegmentCount: 1,
            unpreviewedTextSegmentCount: 0,
          },
        },
      ]);
      expect(lastInjected.entries[0]?.content.preview).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  test("keeps observed tools, origin-aligned previews, omissions, and empty entries distinct", async () => {
    const fixture = await createFixture();
    const root = sessionQueryContractCorpus().inventory.root;
    try {
      const tool = await fixture.query.entries(
        createSessionEntryQuery({
          filter: {
            source: root.identity.source.kind,
            toolName: "exec_command",
            toolNamespace: "functions",
          },
          limit: 20,
        }),
      );
      expect(tool.entries.map(entryKey)).toEqual([`${key(root.identity)}#3`]);
      expect(tool.entries[0]?.entry).toMatchObject({
        kind: "tool-call",
        toolCallId: "entry-call-1",
        toolName: "exec_command",
        toolNamespace: "functions",
        relatedEntryOrdinal: 4,
      });

      const humanOrigin = await fixture.query.entries(
        createSessionEntryQuery({
          filter: { session: root.identity, origin: "human", entryKind: "message" },
          limit: 20,
        }),
      );
      const mixed = humanOrigin.entries.find(({ entry }) => entry.ordinal === 2);
      expect(mixed?.content).toEqual({
        textSegmentCount: 2,
        omittedSegmentCount: 1,
        unpreviewedTextSegmentCount: 1,
        preview: {
          segmentOrdinal: 2,
          origin: "human",
          originConfidence: "high",
          contentHash: hashContent("direct correction one"),
          text: "direct correction one",
          truncated: false,
        },
      });

      const structural = await fixture.query.entries(
        createSessionEntryQuery({
          filter: { session: root.identity },
          limit: 20,
        }),
      );
      const empty = structural.entries.find(({ entry }) => entry.ordinal === 7);
      const long = structural.entries.find(({ entry }) => entry.ordinal === 8);
      expect(empty?.content).toEqual({
        textSegmentCount: 0,
        omittedSegmentCount: 0,
        unpreviewedTextSegmentCount: 0,
      });
      expect(long?.content.preview?.truncated).toBe(true);
      expect(long?.content.preview?.text.isWellFormed()).toBe(true);
      expect(Buffer.byteLength(long?.content.preview?.text ?? "", "utf8")).toBeLessThanOrEqual(512);
      expect(long?.content.preview?.contentHash).toEqual(
        hashContent(`${"é".repeat(300)} model preview tail`),
      );
    } finally {
      await fixture.close();
    }
  });

  test("orders entry inventory by binary identity and ordinal", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const result = await fixture.query.entries(
        createSessionEntryQuery({ filter: { entryKind: "entry-order" }, limit: 20 }),
      );
      const [kind, instance, native, entries] = corpus.ranking.binaryOrder;
      if (
        kind === undefined ||
        instance === undefined ||
        native === undefined ||
        entries === undefined
      ) {
        throw new Error("Binary entry corpus is incomplete");
      }

      expect(result.entries.map(entryKey)).toEqual([
        `${key(kind.identity)}#0`,
        `${key(instance.identity)}#0`,
        `${key(native.identity)}#0`,
        `${key(entries.identity)}#0`,
        `${key(entries.identity)}#1`,
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("returns the same known and unknown roots across list, search, and entries", async () => {
    const fixture = await createFixture();
    const inventory = sessionQueryContractCorpus().inventory;
    try {
      const query = createSessionEntryQuery({
        filter: { source: inventory.root.identity.source.kind },
        selection: "first",
        limit: 20,
      });
      const result = await fixture.query.entries(query);
      const listed = await fixture.query.list(
        createSessionListQuery({
          filter: { source: inventory.root.identity.source.kind },
          limit: 20,
        }),
      );
      const searched = await fixture.query.search(
        createSessionSearchQuery({
          text: "inventory lineage",
          filter: { source: inventory.root.identity.source.kind },
          limit: 20,
          context: 0,
        }),
      );
      await expect(fixture.query.entries(query)).resolves.toEqual(result);
      const roots = new Map(
        result.entries.map(({ session, root }) => [session.identity.nativeId, root]),
      );
      expect(
        new Map(listed.sessions.map(({ identity, root }) => [identity.nativeId, root])),
      ).toEqual(roots);
      expect(
        new Map(searched.hits.map(({ session, root }) => [session.identity.nativeId, root])),
      ).toEqual(roots);
      expect(searched.support).toEqual({
        occurrences: inventory.documents.length,
        uniqueContent: inventory.documents.length,
        uniqueKnownRoots: 2,
        unknownLineageSessions: 4,
      });

      expect(roots.get(inventory.root.identity.nativeId)).toEqual({
        kind: "known",
        root: inventory.root.identity,
      });
      expect(roots.get(inventory.child.identity.nativeId)).toEqual({
        kind: "known",
        root: inventory.root.identity,
      });
      expect(roots.get(inventory.continuation.identity.nativeId)).toEqual({
        kind: "known",
        root: inventory.root.identity,
      });
      expect(roots.get(inventory.independent.identity.nativeId)).toEqual({
        kind: "known",
        root: inventory.independent.identity,
      });
      for (const document of [
        inventory.missingAncestor,
        inventory.unknownCoverage,
        inventory.cycleLeft,
        inventory.cycleRight,
      ]) {
        expect(roots.get(document.identity.nativeId)).toEqual({ kind: "unknown" });
      }
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.entries)).toBe(true);
      expect(Object.isFrozen(result.entries[0]?.root)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  test("traverses entry cursors without duplicates and rejects mismatched or stale cursors", async () => {
    const fixture = await createFixture();
    try {
      const first = await fixture.query.entries(
        createSessionEntryQuery({ filter: { entryKind: "entry-order" }, limit: 2 }),
      );
      expect(first.entries).toHaveLength(2);
      expect(first.nextCursor).toBeDefined();
      if (first.nextCursor === undefined) throw new Error("Expected entry continuation");

      const traversed = await traverseEntries(fixture.query, { entryKind: "entry-order" }, 2);
      expect(traversed).toHaveLength(5);
      expect(new Set(traversed).size).toBe(traversed.length);
      await expect(
        fixture.query.entries(
          createSessionEntryQuery({
            filter: { entryKind: "entry-order" },
            selection: "first",
            limit: 2,
            cursor: first.nextCursor,
          }),
        ),
      ).rejects.toBeInstanceOf(SessionQueryUsageError);
      await expect(
        fixture.query.list(createSessionListQuery({ limit: 2, cursor: first.nextCursor })),
      ).rejects.toBeInstanceOf(SessionQueryUsageError);

      const recreated = await fixture.recreateQuery();
      await expect(
        recreated.entries(
          createSessionEntryQuery({
            filter: { entryKind: "entry-order" },
            limit: 2,
            cursor: first.nextCursor,
          }),
        ),
      ).rejects.toBeInstanceOf(SessionQueryOperationalError);
    } finally {
      await fixture.close();
    }
  });

  test("keeps every entry filter and selection stable across page-size-one traversal", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    const present = corpus.present;
    const observedAt = SESSION_QUERY_CONTRACT_TIMES.present;
    const filterCases: readonly [
      string,
      Parameters<typeof createSessionEntryQuery>[0]["filter"],
    ][] = [
      ["source", { source: present.identity.source.kind }],
      [
        "instance",
        {
          source: present.identity.source.kind,
          instance: present.identity.source.instanceId,
        },
      ],
      [
        "native ID",
        {
          source: present.identity.source.kind,
          instance: present.identity.source.instanceId,
          nativeId: present.identity.nativeId,
        },
      ],
      ["source state", { sourceState: "present" }],
      ["workspace", { workspace: "/workspace/Primary" }],
      [
        "activity",
        {
          activityAfter: "2026-07-14T09:29:59.999Z",
          activityBefore: "2026-07-14T09:30:00.001Z",
        },
      ],
      [
        "capture",
        {
          capturedAfter: before(observedAt),
          capturedBefore: after(observedAt),
        },
      ],
      [
        "observation",
        {
          observedAfter: before(observedAt),
          observedBefore: after(observedAt),
        },
      ],
      ["session", { session: present.identity }],
      [
        "entry time",
        {
          entryAfter: "2026-07-14T09:19:59.999Z",
          entryBefore: "2026-07-14T09:50:00.001Z",
        },
      ],
      ["actor", { actor: "model" }],
      ["origin", { origin: "model" }],
      ["entry kind", { entryKind: "entry-order" }],
      ["tool name", { toolName: "read_file" }],
      ["tool namespace", { toolNamespace: "filesystem" }],
    ];

    try {
      for (const selection of ["all", "first", "last"] as const) {
        for (const [label, filter] of filterCases) {
          const canonical = await fixture.query.entries(
            createSessionEntryQuery({
              selection,
              limit: 200,
              ...(filter === undefined ? {} : { filter }),
            }),
          );
          expect(canonical.entries.length, `${selection} ${label}`).toBeGreaterThan(0);
          const traversed = await traverseEntryPages(fixture.query, filter, 1, selection);
          expect(traversed.entries, `${selection} ${label}`).toEqual(canonical.entries);
          for (const scope of traversed.captureScopes) {
            expect(scope, `${selection} ${label}`).toEqual(canonical.captureScope);
          }
        }
      }
    } finally {
      await fixture.close();
    }
  });

  test("traverses list and default-sized search cursors without duplicates", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const listed = await traverseList(fixture.query, 5);
      const canonicalList = await fixture.query.list(createSessionListQuery({ limit: 200 }));
      expect(listed).toEqual(canonicalList.sessions.map(({ identity }) => key(identity)));
      expect(new Set(listed).size).toBe(listed.length);

      const pageSizeOne = await traverseList(fixture.query, 1);
      expect(pageSizeOne).toEqual(canonicalList.sessions.map(({ identity }) => key(identity)));
      expect(pageSizeOne).toHaveLength(corpus.documents.length);

      const firstList = await fixture.query.list(createSessionListQuery({ limit: 2 }));
      if (firstList.nextCursor === undefined) throw new Error("Expected list continuation");
      const secondList = await fixture.query.list(
        createSessionListQuery({ limit: 2, cursor: firstList.nextCursor }),
      );
      expect(secondList.captureScope).toEqual(firstList.captureScope);
      await expect(
        fixture.query.list(
          createSessionListQuery({
            filter: { activityAfter: "2026-07-14T00:00:00.000Z" },
            limit: 2,
            cursor: firstList.nextCursor,
          }),
        ),
      ).rejects.toBeInstanceOf(SessionQueryUsageError);

      const first = await fixture.query.search(
        createSessionSearchQuery({
          text: "pageable corpus evidence",
          limit: DEFAULT_SEARCH_LIMIT,
          context: 0,
        }),
      );
      expect(first.hits).toHaveLength(20);
      expect(first.support.occurrences).toBe(corpus.pageable.length);
      expect(first.nextCursor).toBeDefined();

      const searched = await traverseSearch(
        fixture.query,
        "pageable corpus evidence",
        DEFAULT_SEARCH_LIMIT,
      );
      expect(searched).toHaveLength(corpus.pageable.length);
      expect(new Set(searched).size).toBe(searched.length);

      if (first.nextCursor === undefined) throw new Error("Expected search continuation");
      const secondSearch = await fixture.query.search(
        createSessionSearchQuery({
          text: "pageable corpus evidence",
          limit: DEFAULT_SEARCH_LIMIT,
          context: 0,
          cursor: first.nextCursor,
        }),
      );
      expect(secondSearch.captureScope).toEqual(first.captureScope);
      await expect(
        fixture.query.search(
          createSessionSearchQuery({
            text: "pageable corpus evidence",
            termMode: "any",
            limit: DEFAULT_SEARCH_LIMIT,
            context: 0,
            cursor: first.nextCursor,
          }),
        ),
      ).rejects.toBeInstanceOf(SessionQueryUsageError);
      const recreated = await fixture.recreateQuery();
      await expect(
        recreated.search(
          createSessionSearchQuery({
            text: "pageable corpus evidence",
            limit: DEFAULT_SEARCH_LIMIT,
            context: 0,
            cursor: first.nextCursor,
          }),
        ),
      ).rejects.toBeInstanceOf(SessionQueryOperationalError);
    } finally {
      await fixture.close();
    }
  });
}

async function traverseEntries(
  query: SessionQueryRepository,
  filter: Parameters<typeof createSessionEntryQuery>[0]["filter"],
  limit: number,
  selection: NonNullable<Parameters<typeof createSessionEntryQuery>[0]["selection"]> = "all",
): Promise<string[]> {
  const traversed = await traverseEntryPages(query, filter, limit, selection);
  return traversed.entries.map(entryKey);
}

async function traverseEntryPages(
  query: SessionQueryRepository,
  filter: Parameters<typeof createSessionEntryQuery>[0]["filter"],
  limit: number,
  selection: NonNullable<Parameters<typeof createSessionEntryQuery>[0]["selection"]>,
): Promise<{
  readonly entries: readonly SessionEntryInventoryItem[];
  readonly captureScopes: readonly SessionEntryPage["captureScope"][];
}> {
  const entries: SessionEntryInventoryItem[] = [];
  const captureScopes: SessionEntryPage["captureScope"][] = [];
  let cursor: SessionQueryCursor | undefined;
  do {
    const page = await query.entries(
      createSessionEntryQuery({
        limit,
        selection,
        ...(filter === undefined ? {} : { filter }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    entries.push(...page.entries);
    captureScopes.push(page.captureScope);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { entries, captureScopes };
}

async function expectStateAt(
  query: SessionQueryRepository,
  identity: SessionIdentity,
  sourceState: "present" | "missing" | "unknown",
  observedAt: string,
): Promise<void> {
  const result = await query.list(
    createSessionListQuery({
      filter: {
        source: identity.source.kind,
        instance: identity.source.instanceId,
        sourceState,
        observedAfter: before(observedAt),
        observedBefore: after(observedAt),
      },
      limit: 20,
    }),
  );
  expect(result.sessions.map(({ identity: found }) => key(found))).toEqual([key(identity)]);
  expect(result.sessions[0]).toMatchObject({
    sourceState,
    sourceObservedAt: observedAt,
    adapterVersion: "synthetic-v1",
    documentDigest: {
      scheme: "sha256-sessions-document-jcs-v1",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    },
  });
  expect(result.sessions[0]?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
}

function search(query: SessionQueryRepository, text: string, session?: SessionIdentity) {
  return query.search(
    createSessionSearchQuery({
      text,
      ...(session === undefined ? {} : { filter: { session } }),
      limit: 20,
      context: 0,
    }),
  );
}

function manifestCounts(document: Parameters<typeof createSessionDocumentMetrics>[0]) {
  const metrics = createSessionDocumentMetrics(document);
  return {
    relations: metrics.relationCount,
    entries: metrics.entryCount,
    segments: metrics.segmentCount,
    omittedSegments: metrics.omittedSegmentCount,
    textUtf8Bytes: metrics.textUtf8Bytes,
  };
}

function hitKey(hit: {
  readonly session: { readonly identity: SessionIdentity };
  readonly entry: { readonly ordinal: number };
}): string {
  return `${key(hit.session.identity)}#${String(hit.entry.ordinal)}`;
}

function entryKey(item: {
  readonly session: { readonly identity: SessionIdentity };
  readonly entry: { readonly ordinal: number };
}): string {
  return `${key(item.session.identity)}#${String(item.entry.ordinal)}`;
}

async function traverseList(query: SessionQueryRepository, limit: number): Promise<string[]> {
  const found: string[] = [];
  let cursor: SessionQueryCursor | undefined;
  do {
    const page = await query.list(
      createSessionListQuery({ limit, ...(cursor === undefined ? {} : { cursor }) }),
    );
    found.push(...page.sessions.map(({ identity }) => key(identity)));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found;
}

async function traverseSearch(
  query: SessionQueryRepository,
  text: string,
  limit: number,
): Promise<string[]> {
  const found: string[] = [];
  let cursor: SessionQueryCursor | undefined;
  do {
    const page = await query.search(
      createSessionSearchQuery({
        text,
        limit,
        context: 0,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    found.push(
      ...page.hits.map(({ session, entry }) => `${key(session.identity)}#${entry.ordinal}`),
    );
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found;
}

function key(identity: SessionIdentity): string {
  return `${identity.source.kind}\u0000${identity.source.instanceId}\u0000${identity.nativeId}`;
}

function before(timestamp: string): string {
  return new Date(Date.parse(timestamp) - 1).toISOString();
}

function after(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 1).toISOString();
}
