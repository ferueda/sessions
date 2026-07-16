import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { encodeStructuredJson } from "../src/cli/encode-json-output.ts";
import { encodeStructuredJsonl } from "../src/cli/encode-jsonl-output.ts";
import {
  MAX_BOUNDED_STRUCTURED_OUTPUT_BYTES,
  StructuredOutputTooLargeError,
  STRUCTURED_OUTPUT_TOO_LARGE,
} from "../src/cli/structured-output-encoding.ts";
import {
  buildListJsonV1,
  buildListJsonlV1,
  buildEntriesJsonV1,
  buildEntriesJsonlV1,
  buildSearchJsonV1,
  buildSearchJsonlV1,
  buildSnapshotJsonV1,
  buildSnapshotJsonlV1,
  type SelectedTextV1,
  type StructuredListInputV1,
  type StructuredEntriesInputV1,
  type StructuredSearchInputV1,
  type StructuredSessionSummaryInputV1,
  type StructuredSnapshotInputV1,
} from "../src/cli/structured-output.ts";
import {
  completeCaptureScope as baseCompleteCaptureScope,
  uninitializedCaptureScope,
} from "./fixtures/session-capture-scope.ts";

const documentDigest = {
  scheme: "sha256-sessions-document-jcs-v1",
  digest: "a".repeat(64),
} as const;
const contentHash = { scheme: "sha256-utf8-v1", digest: "b".repeat(64) } as const;
const identity = {
  source: { kind: "synthetic", instanceId: "instance one" },
  nativeId: "session/one",
} as const;
const completeCaptureScope = {
  ...baseCompleteCaptureScope,
  appliedFilters: ["source", "nativeId"],
  unassessedFilters: ["workspace", "searchText"],
} as const;

describe("schema-1 structured output", () => {
  it("builds an exact list bundle and attributable JSONL records", () => {
    const input: StructuredListInputV1 = {
      sessions: [listedSummary()],
      captureScope: completeCaptureScope,
      nextCursor: "next-page",
    };

    const json = buildListJsonV1(input);
    const jsonl = buildListJsonlV1(input);

    expect(json).toEqual({
      schemaVersion: 1,
      command: "list",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: "next-page",
      captureScope: completeCaptureScope,
      sessions: [publicListedSummary()],
    });
    expect(jsonl).toEqual([
      {
        schemaVersion: 1,
        command: "list",
        type: "page",
        disposition: "untrusted-history",
        sessionCount: 1,
        nextCursor: "next-page",
        captureScope: completeCaptureScope,
      },
      {
        schemaVersion: 1,
        command: "list",
        type: "session",
        disposition: "untrusted-history",
        summary: publicListedSummary(),
      },
    ]);
    const sessionRecord = jsonl[1]!;
    if (sessionRecord.command !== "list" || sessionRecord.type !== "session") {
      throw new TypeError("Expected list session record");
    }
    expect(json.sessions).toEqual([sessionRecord.summary]);
    expectRecursivelyFrozen(json);
    expectRecursivelyFrozen(jsonl);
  });

  it("emits an explicit empty page and nullable cursor", () => {
    expect(
      buildListJsonV1({ sessions: [], captureScope: uninitializedCaptureScope }),
    ).toMatchObject({
      nextCursor: null,
      captureScope: uninitializedCaptureScope,
      sessions: [],
    });
    expect(buildListJsonlV1({ sessions: [], captureScope: uninitializedCaptureScope })).toEqual([
      {
        schemaVersion: 1,
        command: "list",
        type: "page",
        disposition: "untrusted-history",
        sessionCount: 0,
        nextCursor: null,
        captureScope: uninitializedCaptureScope,
      },
    ]);
  });

  it("maps search snippets and context into explicit evidence records", () => {
    const input = searchInput();
    const json = buildSearchJsonV1(input);
    const jsonl = buildSearchJsonlV1(input);

    expect(json).toMatchObject({
      schemaVersion: 1,
      command: "search",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: null,
      captureScope: completeCaptureScope,
      support: input.support,
    });
    expect(json.hits[0]).toEqual({
      session: publicSummary(),
      root: publicRoot(),
      entry: {
        ordinal: 4,
        kind: "tool-call",
        actor: "tool",
        relatedEntryOrdinal: 5,
        toolCallId: "call-1",
        toolName: "exec",
        toolNamespace: "shell",
      },
      match: {
        segmentOrdinal: 2,
        origin: "tool",
        originConfidence: "high",
        excerpt: { text: "match\ntext", truncated: true },
        contentHash,
        additionalMatchingSegments: 1,
        matchedTerms: ["match", "text"],
      },
      context: [
        {
          type: "entry-excerpt",
          entry: {
            ordinal: 5,
            kind: "tool-result",
            actor: "tool",
            relatedEntryOrdinal: 4,
          },
          excerpt: { text: "result", truncated: false },
          adjacent: false,
          linked: true,
        },
      ],
      linkedContextTruncated: false,
    });
    expect(jsonl[0]).toMatchObject({
      command: "search",
      type: "page",
      hitCount: 1,
      captureScope: completeCaptureScope,
    });
    expect(jsonl[1]).not.toHaveProperty("captureScope");
    expect(jsonl[1]).toEqual({
      schemaVersion: 1,
      command: "search",
      type: "hit",
      disposition: "untrusted-history",
      hit: json.hits[0],
    });
  });

  it("emits one search page when no hits match", () => {
    const input: StructuredSearchInputV1 = {
      hits: [],
      captureScope: uninitializedCaptureScope,
      support: {
        occurrences: 0,
        uniqueContent: 0,
        uniqueKnownRoots: 0,
        unknownLineageSessions: 0,
      },
    };

    expect(buildSearchJsonV1(input)).toMatchObject({ hits: [], nextCursor: null });
    expect(buildSearchJsonlV1(input)).toEqual([
      {
        schemaVersion: 1,
        command: "search",
        type: "page",
        disposition: "untrusted-history",
        hitCount: 0,
        nextCursor: null,
        captureScope: uninitializedCaptureScope,
        support: input.support,
      },
    ]);
  });

  it("maps entry inventory into exact attributable JSON and JSONL records", () => {
    const input = entriesInput();
    const json = buildEntriesJsonV1(input);
    const jsonl = buildEntriesJsonlV1(input);

    expect(json).toEqual({
      schemaVersion: 1,
      command: "entries",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: "next-entry-page",
      captureScope: completeCaptureScope,
      entries: [
        {
          session: publicSummary(),
          root: {
            kind: "known",
            session: {
              canonicalId: "synthetic@root:root-session",
              source: { kind: "synthetic", instanceId: "root" },
              nativeId: "root-session",
            },
          },
          coordinate: {
            ordinal: 4,
            kind: "tool-call",
            actor: "tool",
            toolCallId: "call-1",
            toolName: "exec",
            toolNamespace: "shell",
            relatedEntryOrdinal: 5,
          },
          content: {
            textSegmentCount: 2,
            omittedSegmentCount: 1,
            unpreviewedTextSegmentCount: 1,
            preview: {
              segmentOrdinal: 0,
              origin: "tool",
              originConfidence: "high",
              excerpt: { text: "preview", truncated: false },
              contentHash,
            },
          },
        },
      ],
    });
    expect(jsonl).toEqual([
      {
        schemaVersion: 1,
        command: "entries",
        type: "page",
        disposition: "untrusted-history",
        entryCount: 1,
        nextCursor: "next-entry-page",
        captureScope: completeCaptureScope,
      },
      {
        schemaVersion: 1,
        command: "entries",
        type: "entry",
        disposition: "untrusted-history",
        entry: json.entries[0],
      },
    ]);
    expectRecursivelyFrozen(json);
    expectRecursivelyFrozen(jsonl);
    expect(jsonl[1]).not.toHaveProperty("captureScope");
  });

  it("emits one entries page for an empty result", () => {
    expect(
      buildEntriesJsonV1({ entries: [], captureScope: uninitializedCaptureScope }),
    ).toMatchObject({
      entries: [],
      captureScope: uninitializedCaptureScope,
      nextCursor: null,
    });
    expect(buildEntriesJsonlV1({ entries: [], captureScope: uninitializedCaptureScope })).toEqual([
      {
        schemaVersion: 1,
        command: "entries",
        type: "page",
        disposition: "untrusted-history",
        entryCount: 0,
        nextCursor: null,
        captureScope: uninitializedCaptureScope,
      },
    ]);
  });

  it.each(["show", "export"] as const)(
    "keeps %s JSON and JSONL transcript evidence equivalent",
    (command) => {
      const input = snapshotInput();
      const json = buildSnapshotJsonV1(command, input);
      const jsonl = buildSnapshotJsonlV1(command, input);

      expect(json).toMatchObject({
        schemaVersion: 1,
        command,
        type: "snapshot",
        disposition: "untrusted-history",
      });
      expect(jsonl.map((record) => record.type)).toEqual(["session", "relation", "entry"]);
      expect(jsonl[0]).toEqual({
        schemaVersion: 1,
        command,
        type: "session",
        disposition: "untrusted-history",
        snapshot: json.snapshot,
      });
      expect(jsonl[1]).toEqual({
        schemaVersion: 1,
        command,
        type: "relation",
        disposition: "untrusted-history",
        session: json.snapshot.session,
        documentDigest: json.snapshot.documentDigest,
        relation: json.relations[0],
      });
      expect(jsonl[2]).toEqual({
        schemaVersion: 1,
        command,
        type: "entry",
        disposition: "untrusted-history",
        session: json.snapshot.session,
        documentDigest: json.snapshot.documentDigest,
        entry: json.entries[0],
      });
    },
  );

  it("emits one session record for an empty snapshot", () => {
    const input = snapshotInput({ empty: true });
    const records = buildSnapshotJsonlV1("export", input);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ command: "export", type: "session" });
  });

  it("copies only allowlisted fields from safe application results", () => {
    const privateMarker = "private-marker-never-export";
    const unsafeSummary = {
      ...listedSummary(),
      workspace: privateMarker,
      locator: { uri: privateMarker },
      sourceMetadata: { hidden: privateMarker },
      title: { ...selectedText("title"), hidden: privateMarker },
      documentDigest: { ...documentDigest, hidden: privateMarker },
    };
    const input = {
      sessions: [unsafeSummary],
      captureScope: {
        ...completeCaptureScope,
        privateIdentity: privateMarker,
        retainedSessions: { ...completeCaptureScope.retainedSessions, privateMarker },
        latestFailures: { ...completeCaptureScope.latestFailures, privateMarker },
      },
      diagnostic: privateMarker,
    };

    const encoded = encodeStructuredJson(buildListJsonV1(input));

    expect(encoded).not.toContain(privateMarker);
    expect(Object.keys(JSON.parse(encoded).sessions[0])).toEqual([
      "session",
      "documentDigest",
      "title",
      "createdAt",
      "updatedAt",
      "capturedAt",
      "sourceState",
      "sourceObservedAt",
      "adapterVersion",
      "freshness",
      "root",
    ]);
    expect(Object.keys(JSON.parse(encoded).captureScope)).toEqual([
      "status",
      "trackedSessions",
      "retainedSessions",
      "unindexedSessions",
      "sourceState",
      "sourceCoverage",
      "latestFailures",
      "appliedFilters",
      "unassessedFilters",
    ]);
  });

  it("defensively copies capture scope and validates its fixed invariants", () => {
    const mutableScope = {
      ...completeCaptureScope,
      retainedSessions: { ...completeCaptureScope.retainedSessions },
      sourceState: { ...completeCaptureScope.sourceState },
      sourceCoverage: { ...completeCaptureScope.sourceCoverage },
      latestFailures: { ...completeCaptureScope.latestFailures },
      appliedFilters: [...completeCaptureScope.appliedFilters],
      unassessedFilters: [...completeCaptureScope.unassessedFilters],
    };
    const output = buildListJsonV1({ sessions: [], captureScope: mutableScope });

    Reflect.set(mutableScope.retainedSessions, "current", 0);
    Reflect.set(mutableScope.sourceState, "present", 0);
    mutableScope.appliedFilters.push("source");

    expect(output.captureScope).toEqual(completeCaptureScope);
    expectRecursivelyFrozen(output.captureScope);
    expect(() =>
      buildListJsonV1({
        sessions: [],
        captureScope: { ...completeCaptureScope, trackedSessions: 2 },
      }),
    ).toThrow("do not partition tracked sessions");
    expect(() =>
      buildListJsonV1({
        sessions: [],
        captureScope: {
          ...completeCaptureScope,
          sourceState: { ...completeCaptureScope.sourceState, present: 0 },
        },
      }),
    ).toThrow("source-state counts");
    expect(() =>
      buildListJsonV1({
        sessions: [],
        captureScope: {
          ...completeCaptureScope,
          latestFailures: { ...completeCaptureScope.latestFailures, malformed: 1 },
        },
      }),
    ).toThrow("failure counts");
    expect(() =>
      buildListJsonV1({
        sessions: [],
        captureScope: {
          ...completeCaptureScope,
          latestFailures: {
            ...completeCaptureScope.latestFailures,
            repositoryWrite: Number.MAX_SAFE_INTEGER + 1,
          },
        },
      }),
    ).toThrow("non-negative safe integers");
    expect(() =>
      buildListJsonV1({
        sessions: [],
        captureScope: {
          ...completeCaptureScope,
          appliedFilters: ["nativeId", "source"],
        },
      }),
    ).toThrow("canonical order");
    expect(() =>
      buildListJsonV1({
        sessions: [],
        captureScope: {
          ...completeCaptureScope,
          appliedFilters: ["private-filter"] as never,
        },
      }),
    ).toThrow("canonical order");
    expect(() =>
      buildListJsonV1({
        sessions: [],
        captureScope: {
          ...completeCaptureScope,
          appliedFilters: ["source"],
          unassessedFilters: ["nativeId", "workspace"],
        },
      }),
    ).toThrow("classification is invalid");
    expect(() =>
      buildListJsonV1({
        sessions: [],
        captureScope: {
          ...completeCaptureScope,
          appliedFilters: ["workspace"],
          unassessedFilters: ["searchText"],
        },
      }),
    ).toThrow("classification is invalid");
  });

  it("removes private markers at every transcript nesting level", () => {
    const marker = "nested-private-marker";
    const base = snapshotInput();
    const input = {
      snapshot: { ...base.snapshot, workspace: marker, sourceMetadata: { marker } },
      relations: base.relations.map((relation) => ({ ...relation, providerRelation: marker })),
      entries: base.entries.map((entry) => ({
        ...entry,
        sourceLocator: { uri: marker },
        content: entry.content.map((segment) => ({
          ...segment,
          sourceMetadata: { marker },
          privateAttachment: marker,
        })),
      })),
    };

    const encoded = encodeStructuredJson(buildSnapshotJsonV1("export", input));

    expect(encoded).not.toContain(marker);
    expect(encoded).not.toContain("workspace");
    expect(encoded).not.toContain("sourceMetadata");
    expect(encoded).not.toContain("sourceLocator");
    expect(encoded).not.toContain("privateAttachment");
  });

  it("allowlists entry inventory fields and rejects inconsistent counts", () => {
    const marker = "entry-inventory-private-marker";
    const base = entriesInput();
    const encoded = encodeStructuredJson(
      buildEntriesJsonV1({
        ...base,
        entries: base.entries.map((entry) => ({
          ...entry,
          workspace: marker,
          sourceLocator: marker,
          session: { ...entry.session, workspace: marker, sourceMetadata: marker },
          entry: { ...entry.entry, sourceLocator: marker },
          content: {
            ...entry.content,
            hidden: marker,
            preview: { ...entry.content.preview!, sourceMetadata: marker },
          },
        })),
      }),
    );

    expect(encoded).not.toContain(marker);
    expect(encoded).not.toContain("sourceLocator");
    expect(JSON.parse(encoded).entries[0].session).not.toHaveProperty("workspace");
    expect(() =>
      buildEntriesJsonV1({
        ...base,
        entries: [
          {
            ...base.entries[0]!,
            content: { ...base.entries[0]!.content, unpreviewedTextSegmentCount: 2 },
          },
        ],
      }),
    ).toThrow("counts are inconsistent");
  });

  it("omits optional members instead of serializing null", () => {
    const value = buildListJsonV1({
      captureScope: completeCaptureScope,
      sessions: [
        {
          identity,
          documentDigest,
          capturedAt: "2026-07-15T12:00:00.000Z",
          sourceState: "present",
          sourceObservedAt: "2026-07-15T12:00:00.000Z",
          adapterVersion: "synthetic-v1",
          freshness: "current",
          root: knownRoot(),
        },
      ],
    });

    const session = value.sessions[0]!;
    expect(session).not.toHaveProperty("title");
    expect(session).not.toHaveProperty("createdAt");
    expect(session).not.toHaveProperty("updatedAt");
    expect(value.nextCursor).toBeNull();
  });

  it("rejects inconsistent or unsafe application values", () => {
    expect(() =>
      buildListJsonV1({
        captureScope: completeCaptureScope,
        sessions: [
          {
            ...listedSummary(),
            title: { text: "é", truncated: false, originalUtf8Bytes: 1, emittedUtf8Bytes: 1 },
          },
        ],
      }),
    ).toThrow("byte accounting");
    expect(() =>
      buildListJsonV1({
        captureScope: completeCaptureScope,
        sessions: [{ ...listedSummary(), documentDigest: { ...documentDigest, digest: "0" } }],
      }),
    ).toThrow("document digest");
    expect(() =>
      buildSearchJsonV1({
        ...searchInput(),
        support: { ...searchInput().support, occurrences: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow("safe integer");
    expect(() =>
      buildSearchJsonV1({
        ...searchInput(),
        hits: [{ ...searchInput().hits[0]!, matchedTerms: ["duplicate", "duplicate"] }],
      }),
    ).toThrow("must be unique");
    expect(() =>
      buildSearchJsonV1({
        ...searchInput(),
        hits: [{ ...searchInput().hits[0]!, matchedTerms: ["two terms"] }],
      }),
    ).toThrow("single search terms");
    expect(() =>
      buildListJsonV1({
        captureScope: completeCaptureScope,
        sessions: [{ ...listedSummary(), root: { kind: "invalid" } as never }],
      }),
    ).toThrow("session root");
    expect(() =>
      buildSnapshotJsonV1("show", {
        ...snapshotInput(),
        snapshot: {
          ...snapshotInput().snapshot,
          selection: {
            ...snapshotInput().snapshot.selection,
            canonicalOmittedSegments: 0,
          },
        },
      }),
    ).toThrow("selection is inconsistent");
  });
});

describe("structured encoders", () => {
  it("uses the fixed 16 MiB production cap", () => {
    expect(MAX_BOUNDED_STRUCTURED_OUTPUT_BYTES).toBe(16 * 1024 * 1024);
  });

  it("pretty-prints JSON with one trailing newline", () => {
    const encoded = encodeStructuredJson(
      buildListJsonV1({ sessions: [], captureScope: uninitializedCaptureScope }),
    );

    expect(encoded).toBe(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          command: "list",
          type: "page",
          disposition: "untrusted-history",
          nextCursor: null,
          captureScope: uninitializedCaptureScope,
          sessions: [],
        },
        null,
        2,
      )}\n`,
    );
  });

  it("encodes compact independently parseable JSONL physical lines", () => {
    const encoded = encodeStructuredJsonl(buildSearchJsonlV1(searchInput()));
    const physicalLines = encoded.slice(0, -1).split("\n");

    expect(encoded.endsWith("\n")).toBe(true);
    expect(physicalLines).toHaveLength(2);
    expect(physicalLines.every((line) => !line.includes("\n"))).toBe(true);
    expect(physicalLines.map((line) => JSON.parse(line).type)).toEqual(["page", "hit"]);
    expect(physicalLines[1]).toContain("match\\ntext");
  });

  it.each([
    [
      "json",
      () =>
        encodeStructuredJson(
          buildListJsonV1({ sessions: [listedSummary()], captureScope: completeCaptureScope }),
        ),
    ],
    [
      "jsonl",
      () =>
        encodeStructuredJsonl(
          buildListJsonlV1({ sessions: [listedSummary()], captureScope: completeCaptureScope }),
        ),
    ],
  ] as const)("admits %s exactly at its UTF-8 cap and rejects one byte less", (_name, encode) => {
    const unbounded = encode();
    const bytes = Buffer.byteLength(unbounded, "utf8");
    const value =
      _name === "json"
        ? buildListJsonV1({ sessions: [listedSummary()], captureScope: completeCaptureScope })
        : buildListJsonlV1({ sessions: [listedSummary()], captureScope: completeCaptureScope });
    const atBoundary =
      _name === "json"
        ? encodeStructuredJson(value as ReturnType<typeof buildListJsonV1>, {
            maximumBytesForTest: bytes,
          })
        : encodeStructuredJsonl(value as ReturnType<typeof buildListJsonlV1>, {
            maximumBytesForTest: bytes,
          });

    expect(atBoundary).toBe(unbounded);
    const overLimit = () =>
      _name === "json"
        ? encodeStructuredJson(value as ReturnType<typeof buildListJsonV1>, {
            maximumBytesForTest: bytes - 1,
          })
        : encodeStructuredJsonl(value as ReturnType<typeof buildListJsonlV1>, {
            maximumBytesForTest: bytes - 1,
          });
    expect(overLimit).toThrow(StructuredOutputTooLargeError);
    expect(captureError(overLimit)).toMatchObject({ code: STRUCTURED_OUTPUT_TOO_LARGE });
  });

  it("exempts an explicit full export from the aggregate byte cap", () => {
    const value = buildSnapshotJsonV1("export", snapshotInput());

    expect(() => encodeStructuredJson(value, { maximumBytesForTest: 0 })).toThrow(
      StructuredOutputTooLargeError,
    );
    expect(
      encodeStructuredJson(value, { maximumBytesForTest: 0, exemptFromLimit: true }),
    ).toContain('"command": "export"');
  });

  it("refuses values that bypass the allowlist builders", () => {
    const raw = {
      schemaVersion: 1,
      command: "list",
      type: "page",
      disposition: "untrusted-history",
      nextCursor: null,
      captureScope: completeCaptureScope,
      sessions: [],
    } as const;

    expect(() => encodeStructuredJson(raw)).toThrow("safe application result");
  });
});

function summary(): StructuredSessionSummaryInputV1 {
  return {
    identity,
    documentDigest,
    title: selectedText("title"),
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T11:00:00.000Z",
    capturedAt: "2026-07-15T12:00:00.000Z",
    sourceState: "present",
    sourceObservedAt: "2026-07-15T12:00:00.000Z",
    adapterVersion: "synthetic-v1",
    freshness: "current",
  };
}

function knownRoot() {
  return {
    kind: "known" as const,
    root: {
      source: { kind: "synthetic", instanceId: "root" },
      nativeId: "root-session",
    },
  };
}

function publicRoot() {
  return {
    kind: "known" as const,
    session: {
      canonicalId: "synthetic@root:root-session",
      source: { kind: "synthetic", instanceId: "root" },
      nativeId: "root-session",
    },
  };
}

function listedSummary() {
  return { ...summary(), root: knownRoot() };
}

function publicListedSummary() {
  return { ...publicSummary(), root: publicRoot() };
}

function publicSummary() {
  return {
    session: {
      canonicalId: "synthetic@instance%20one:session%2Fone",
      source: { kind: "synthetic", instanceId: "instance one" },
      nativeId: "session/one",
    },
    documentDigest,
    title: selectedText("title"),
    createdAt: "2026-07-15T10:00:00.000Z",
    updatedAt: "2026-07-15T11:00:00.000Z",
    capturedAt: "2026-07-15T12:00:00.000Z",
    sourceState: "present",
    sourceObservedAt: "2026-07-15T12:00:00.000Z",
    adapterVersion: "synthetic-v1",
    freshness: "current",
  } as const;
}

function searchInput(): StructuredSearchInputV1 {
  return {
    captureScope: completeCaptureScope,
    hits: [
      {
        session: summary(),
        root: knownRoot(),
        matchedTerms: ["match", "text"],
        entry: {
          ordinal: 4,
          kind: "tool-call",
          actor: "tool",
          relatedEntryOrdinal: 5,
          toolCallId: "call-1",
          toolName: "exec",
          toolNamespace: "shell",
        },
        snippet: {
          segmentOrdinal: 2,
          origin: "tool",
          originConfidence: "high",
          contentHash,
          text: "match\ntext",
          truncated: true,
          additionalMatchingSegments: 1,
        },
        context: [
          {
            ordinal: 5,
            kind: "tool-result",
            actor: "tool",
            relatedEntryOrdinal: 4,
            body: "result",
            bodyTruncated: false,
            adjacent: false,
            linked: true,
          },
        ],
        linkedContextTruncated: false,
      },
    ],
    support: {
      occurrences: 2,
      uniqueContent: 1,
      uniqueKnownRoots: 1,
      unknownLineageSessions: 0,
    },
  };
}

function entriesInput(): StructuredEntriesInputV1 {
  return {
    captureScope: completeCaptureScope,
    entries: [
      {
        session: summary(),
        root: {
          kind: "known",
          root: {
            source: { kind: "synthetic", instanceId: "root" },
            nativeId: "root-session",
          },
        },
        entry: {
          ordinal: 4,
          kind: "tool-call",
          actor: "tool",
          relatedEntryOrdinal: 5,
          toolCallId: "call-1",
          toolName: "exec",
          toolNamespace: "shell",
        },
        content: {
          textSegmentCount: 2,
          omittedSegmentCount: 1,
          unpreviewedTextSegmentCount: 1,
          preview: {
            segmentOrdinal: 0,
            origin: "tool",
            originConfidence: "high",
            text: "preview",
            truncated: false,
            contentHash,
          },
        },
      },
    ],
    nextCursor: "next-entry-page",
  };
}

function snapshotInput(options: { readonly empty?: boolean } = {}): StructuredSnapshotInputV1 {
  if (options.empty === true) {
    return {
      snapshot: {
        ...summary(),
        lineageCoverage: "complete",
        selection: {
          mode: "bounded",
          relations: { selected: 0, total: 0, truncated: false },
          entries: {
            selected: 0,
            total: 0,
            truncated: false,
            firstOrdinal: null,
            lastOrdinal: null,
          },
          segments: { selected: 0, total: 0, truncated: false },
          segmentText: { emittedUtf8Bytes: 0, originalUtf8Bytes: 0, truncated: false },
          canonicalOmittedSegments: 0,
          truncatedTextSegments: 0,
        },
      },
      relations: [],
      entries: [],
    };
  }

  const text = selectedText("line\n😀");
  return {
    snapshot: {
      ...summary(),
      lineageCoverage: "complete",
      selection: {
        mode: "bounded",
        relations: { selected: 1, total: 1, truncated: false },
        entries: {
          selected: 1,
          total: 2,
          truncated: true,
          firstOrdinal: 4,
          lastOrdinal: 4,
        },
        segments: { selected: 2, total: 3, truncated: true },
        segmentText: {
          emittedUtf8Bytes: text.emittedUtf8Bytes,
          originalUtf8Bytes: text.originalUtf8Bytes + 100,
          truncated: true,
        },
        canonicalOmittedSegments: 1,
        truncatedTextSegments: 0,
      },
    },
    relations: [
      {
        ordinal: 0,
        kind: "parent",
        target: {
          source: { kind: "synthetic", instanceId: "instance two" },
          nativeId: "parent",
        },
        confidence: "high",
      },
    ],
    entries: [
      {
        ordinal: 4,
        kind: "message",
        actor: "human",
        timestamp: "2026-07-15T10:30:00.000Z",
        content: [
          {
            ordinal: 0,
            kind: "text",
            origin: "human",
            originConfidence: "high",
            text,
            contentHash,
          },
          {
            ordinal: 1,
            kind: "omitted",
            origin: "human",
            originConfidence: "high",
            contentClass: "image",
            sourceType: "input-image",
          },
        ],
        omittedSegmentCount: 1,
      },
    ],
  };
}

function selectedText(text: string): SelectedTextV1 {
  const bytes = Buffer.byteLength(text, "utf8");
  return { text, truncated: false, originalUtf8Bytes: bytes, emittedUtf8Bytes: bytes };
}

function expectRecursivelyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const item of value) expectRecursivelyFrozen(item);
    return;
  }
  for (const nested of Object.values(value)) expectRecursivelyFrozen(nested);
}

function captureError(operation: () => unknown): unknown {
  try {
    operation();
    return undefined;
  } catch (error) {
    return error;
  }
}
