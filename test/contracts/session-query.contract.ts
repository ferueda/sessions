import { expect, test } from "vitest";

import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import {
  SessionQueryOperationalError,
  SessionQueryUsageError,
} from "../../src/application/session-query-error.ts";
import { DEFAULT_SEARCH_LIMIT } from "../../src/application/search-sessions.ts";
import { hashContent } from "../../src/domain/content-hash.ts";
import {
  createSessionEntryQuery,
  createSessionListQuery,
  createSessionSearchQuery,
  type SessionQueryCursor,
} from "../../src/domain/session-query.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import {
  SESSION_QUERY_CONTRACT_TIMES,
  sessionQueryContractCorpus,
} from "../fixtures/session-query-corpus.ts";

export interface SessionQueryContractFixture {
  readonly query: SessionQueryRepository;
  /** Same corpus in a newly initialized library, for library-bound cursor checks. */
  recreateQuery(): Promise<SessionQueryRepository>;
  close(): Promise<void>;
}

export function runSessionQueryContract(
  createFixture: () => Promise<SessionQueryContractFixture> | SessionQueryContractFixture,
): void {
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
      ).resolves.toEqual({ sessions: [] });
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
      ).resolves.toEqual({ entries: [] });
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

  test("returns known and unknown retained roots without inferring missing ancestry", async () => {
    const fixture = await createFixture();
    const inventory = sessionQueryContractCorpus().inventory;
    try {
      const query = createSessionEntryQuery({
        filter: { source: inventory.root.identity.source.kind },
        selection: "first",
        limit: 20,
      });
      const result = await fixture.query.entries(query);
      await expect(fixture.query.entries(query)).resolves.toEqual(result);
      const roots = new Map(
        result.entries.map(({ session, root }) => [session.identity.nativeId, root]),
      );

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

  test("traverses list and default-sized search cursors without duplicates", async () => {
    const fixture = await createFixture();
    const corpus = sessionQueryContractCorpus();
    try {
      const listed = await traverseList(fixture.query, 5);
      expect(listed).toHaveLength(corpus.documents.length);
      expect(new Set(listed).size).toBe(listed.length);

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
): Promise<string[]> {
  const found: string[] = [];
  let cursor: SessionQueryCursor | undefined;
  do {
    const page = await query.entries(
      createSessionEntryQuery({
        limit,
        ...(filter === undefined ? {} : { filter }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    found.push(...page.entries.map(entryKey));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return found;
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
