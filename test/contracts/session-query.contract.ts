import { expect, test } from "vitest";

import type { SessionQueryRepository } from "../../src/application/ports/session-query.ts";
import { SessionQueryOperationalError } from "../../src/application/session-query-error.ts";
import { DEFAULT_SEARCH_LIMIT } from "../../src/application/search-sessions.ts";
import {
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
