import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { clearData } from "../../src/application/clear-index.ts";
import { exportSession } from "../../src/application/export-session.ts";
import { forgetSession } from "../../src/application/forget-session.ts";
import { listSessionEntries } from "../../src/application/list-session-entries.ts";
import { listSessions } from "../../src/application/list-sessions.ts";
import type { IndexPaths } from "../../src/application/ports/index-lifecycle.ts";
import type {
  DiscoveredSession,
  SessionSource,
  SourceCaptureWorkspace,
} from "../../src/application/ports/session-source.ts";
import { runIndex } from "../../src/application/run-index.ts";
import { searchSessions } from "../../src/application/search-sessions.ts";
import { showSession } from "../../src/application/show-session.ts";
import {
  createCursorSource,
  CURSOR_ADAPTER_VERSION,
  CURSOR_JSONL_ADAPTER_VERSION,
} from "../../src/adapters/cursor/source.ts";
import type { SessionIdentity } from "../../src/domain/session.ts";
import { createSqliteIndexLifecycle } from "../../src/infrastructure/sqlite/database.ts";
import { createSqliteIndexMaintenance } from "../../src/infrastructure/sqlite/index-maintenance.ts";
import {
  createCursorSourceFixture,
  CURSOR_AGENT_NATIVE_ID,
  CURSOR_CHAT_NATIVE_ID,
  CURSOR_CHAT_TITLE,
  CURSOR_JSONL_TEXT,
  CURSOR_SHARED_TEXT,
  snapshotCursorProviderTree,
  type CursorSourceFixture,
} from "../fixtures/cursor/source.ts";
import { uninitializedCaptureScope } from "../fixtures/session-capture-scope.ts";

let fixture: CursorSourceFixture | undefined;

afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

describe("Cursor durable vertical slice", () => {
  test("retains and queries both families across complete, incomplete, stale, and deletion runs", async () => {
    fixture = await createCursorSourceFixture();
    const paths = indexPaths(fixture.root);
    const leaseNow = monotonicNow("2026-07-16T12:00:00.000Z", 100);
    const lifecycle = createSqliteIndexLifecycle({
      now: leaseNow,
      writerToken: tokenFactory("index"),
    });
    const maintenance = createSqliteIndexMaintenance({
      now: leaseNow,
      token: tokenFactory("maintenance"),
    });
    const indexClock = { now: monotonicNow("2026-07-16T13:00:00.000Z", 1_000) };
    const selected = await withoutProviderMutation(fixture.cursorHome, () =>
      createCursorSource(fixture!.environment),
    );
    const chatIdentity = identity(selected.instance, CURSOR_CHAT_NATIVE_ID);
    const agentIdentity = identity(selected.instance, CURSOR_AGENT_NATIVE_ID);
    const index = () =>
      withoutProviderMutation(fixture!.cursorHome, () =>
        runIndex({ paths, sources: [selected], lifecycle, clock: indexClock }),
      );
    const list = (nativeId?: string) =>
      withoutProviderMutation(fixture!.cursorHome, () =>
        listSessions({
          paths,
          lifecycle,
          ...(nativeId === undefined ? {} : { filter: { source: "cursor", nativeId } }),
        }),
      );
    const show = (value: SessionIdentity) =>
      withoutProviderMutation(fixture!.cursorHome, () =>
        showSession({ paths, lifecycle, identity: value }),
      );

    const first = await index();
    expect(first).toMatchObject({
      counts: {
        discovered: 2,
        unchanged: 0,
        updated: 2,
        failed: 0,
        missing: 0,
        stale: 0,
      },
      incompleteSources: 0,
      sources: [{ status: "completed", coverage: { status: "complete" } }],
    });
    expect(storedAdapterVersions(paths.database)).toEqual([CURSOR_ADAPTER_VERSION]);
    await expectNoValueInLibrary(paths, fixture.cursorHome);

    const stable = await index();
    expect(stable.counts).toEqual({
      discovered: 2,
      unchanged: 2,
      updated: 0,
      failed: 0,
      missing: 0,
      stale: 0,
    });

    const listed = await list(CURSOR_CHAT_NATIVE_ID);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({
      identity: chatIdentity,
      title: { text: CURSOR_CHAT_TITLE, truncated: false },
      freshness: "current",
      sourceState: "present",
    });
    expect(listed.captureScope).toMatchObject({
      status: "complete",
      trackedSessions: 1,
      retainedSessions: { current: 1, stale: 0 },
      appliedFilters: ["source", "nativeId"],
    });

    const search = await withoutProviderMutation(fixture.cursorHome, () =>
      searchSessions({
        paths,
        lifecycle,
        text: CURSOR_SHARED_TEXT,
        filter: { source: "cursor", nativeId: CURSOR_CHAT_NATIVE_ID },
      }),
    );
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0]).toMatchObject({
      session: { identity: chatIdentity },
      entry: { ordinal: 0, kind: "message", actor: "human" },
      snippet: { text: CURSOR_SHARED_TEXT, origin: "human", originConfidence: "high" },
    });
    expect(search.support).toEqual({
      occurrences: 1,
      uniqueContent: 1,
      uniqueKnownRoots: 0,
      unknownLineageSessions: 1,
    });

    const entries = await withoutProviderMutation(fixture.cursorHome, () =>
      listSessionEntries({
        paths,
        lifecycle,
        filter: { source: "cursor", nativeId: CURSOR_CHAT_NATIVE_ID },
      }),
    );
    expect(entries.entries).toHaveLength(4);
    expect(entries.entries.map(({ entry }) => entry.kind)).toEqual([
      "message",
      "message",
      "tool-call",
      "tool-result",
    ]);
    const shown = await show(chatIdentity);
    expect(shown.entries).toHaveLength(4);
    const exported = await withoutProviderMutation(fixture.cursorHome, () =>
      exportSession({ paths, lifecycle, identity: agentIdentity, full: true }),
    );
    expect(exported).toMatchObject({
      snapshot: {
        identity: agentIdentity,
        freshness: "current",
        sourceState: "present",
        selection: { mode: "full" },
      },
    });
    expect(exported.entries).toHaveLength(4);

    setStoredAdapterVersion(paths.database, "cursor-v0");
    const invalidated = await index();
    expect(invalidated.counts).toMatchObject({
      discovered: 2,
      unchanged: 0,
      updated: 2,
      failed: 0,
    });
    expect(storedAdapterVersions(paths.database)).toEqual([CURSOR_ADAPTER_VERSION]);
    expect((await index()).counts).toMatchObject({
      discovered: 2,
      unchanged: 2,
      updated: 0,
      failed: 0,
    });

    await fixture.writeChatMetadata({ hasConversation: false });
    const missing = await index();
    expect(missing).toMatchObject({
      counts: {
        discovered: 1,
        unchanged: 1,
        updated: 0,
        failed: 0,
        missing: 1,
        stale: 0,
      },
      sources: [{ status: "completed", coverage: { status: "complete" } }],
    });
    expect(await show(chatIdentity)).toMatchObject({
      snapshot: { freshness: "current", sourceState: "missing" },
      entries: shown.entries,
    });

    await fixture.writeChatMetadata();
    const reappeared = await index();
    expect(reappeared.counts).toMatchObject({
      discovered: 2,
      unchanged: 2,
      updated: 0,
      missing: 0,
    });
    expect(await show(chatIdentity)).toMatchObject({
      snapshot: { freshness: "current", sourceState: "present" },
      entries: shown.entries,
    });

    const unavailableStore = `${fixture.chatStore}.unavailable`;
    await rename(fixture.chatStore, unavailableStore);
    const incomplete = await index();
    expect(incomplete).toMatchObject({
      counts: {
        discovered: 0,
        unchanged: 0,
        updated: 0,
        failed: 0,
        missing: 0,
        stale: 0,
      },
      incompleteSources: 1,
      sources: [
        {
          status: "incomplete",
          failure: "discovery-failed",
          coverage: { status: "unknown" },
        },
      ],
    });
    expect((await list()).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identity: chatIdentity,
          freshness: "current",
          sourceState: "unknown",
        }),
        expect.objectContaining({
          identity: agentIdentity,
          freshness: "current",
          sourceState: "unknown",
        }),
      ]),
    );
    await rename(unavailableStore, fixture.chatStore);

    fixture.makeChatMessageMalformed();
    const stale = await index();
    expect(stale).toMatchObject({
      counts: {
        discovered: 2,
        unchanged: 1,
        updated: 0,
        failed: 1,
        missing: 0,
        stale: 1,
      },
      sources: [{ status: "completed", coverage: { status: "complete" } }],
    });
    expect(await show(chatIdentity)).toMatchObject({
      snapshot: { freshness: "stale", sourceState: "present" },
      entries: shown.entries,
    });

    fixture.writeChatStore({
      messages: [
        { role: "user", content: "Recovered synthetic Cursor evidence" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Recovered synthetic Cursor answer" }],
        },
      ],
    });
    const recovered = await index();
    expect(recovered.counts).toMatchObject({
      discovered: 2,
      unchanged: 1,
      updated: 1,
      failed: 0,
    });
    expect((await show(chatIdentity)).entries).toHaveLength(2);

    await expect(
      withoutProviderMutation(fixture.cursorHome, () =>
        forgetSession(paths, maintenance, chatIdentity),
      ),
    ).resolves.toMatchObject({ outcome: "forgotten" });
    await expect(show(chatIdentity)).rejects.toMatchObject({ code: "session-not-found" });
    expect((await list()).sessions.map(({ identity: value }) => value)).toEqual([agentIdentity]);
    expect((await index()).counts).toMatchObject({
      discovered: 2,
      unchanged: 1,
      updated: 1,
      failed: 0,
    });

    const neighbor = join(paths.directory, "keep.txt");
    await mkdir(paths.scratch, { mode: 0o700, recursive: true });
    await writeFile(join(paths.scratch, "temporary.txt"), "owned scratch", { mode: 0o600 });
    await writeFile(neighbor, "unrelated library neighbor", { mode: 0o600 });
    const cleared = await withoutProviderMutation(fixture.cursorHome, () =>
      clearData(paths, maintenance),
    );
    expect(cleared).toMatchObject({
      outcome: "cleared",
      scratchRemoved: true,
      databaseRemoved: true,
    });
    expect(existsSync(paths.database)).toBe(false);
    expect(existsSync(paths.wal)).toBe(false);
    expect(existsSync(paths.shm)).toBe(false);
    expect(existsSync(paths.scratch)).toBe(false);
    await expect(readFile(neighbor, "utf8")).resolves.toBe("unrelated library neighbor");
    await expect(list()).resolves.toEqual({
      sessions: [],
      captureScope: uninitializedCaptureScope,
    });
  });

  test("recovers one first-read source change through bounded fresh discovery", async () => {
    fixture = await createCursorSourceFixture();
    const paths = indexPaths(fixture.root);
    const lifecycle = createSqliteIndexLifecycle({
      now: monotonicNow("2026-07-16T14:00:00.000Z", 100),
      writerToken: tokenFactory("index"),
    });
    const selected = await createCursorSource(fixture.environment);
    let injectChange = true;
    const adapter: SessionSource = Object.freeze({
      kind: selected.adapter.kind,
      probe: () => selected.adapter.probe(),
      discover: (workspace: SourceCaptureWorkspace) => selected.adapter.discover(workspace),
      read(candidate: DiscoveredSession, workspace: SourceCaptureWorkspace) {
        const operation = selected.adapter.read(candidate, workspace);
        if (injectChange && candidate.identity.nativeId === CURSOR_CHAT_NATIVE_ID) {
          injectChange = false;
          fixture!.mutateChatMessage("Captured after bounded fresh discovery");
        }
        return operation;
      },
    });

    const first = await runIndex({
      paths,
      sources: [{ instance: selected.instance, adapter }],
      lifecycle,
      clock: { now: monotonicNow("2026-07-16T15:00:00.000Z", 1_000) },
    });

    expect(injectChange).toBe(false);
    expect(first).toMatchObject({
      counts: {
        discovered: 2,
        unchanged: 0,
        updated: 2,
        failed: 0,
        missing: 0,
        stale: 0,
      },
      incompleteSources: 0,
    });
    const chat = await showSession({
      paths,
      lifecycle,
      identity: identity(selected.instance, CURSOR_CHAT_NATIVE_ID),
    });
    expect(chat.entries[0]).toMatchObject({
      content: [{ kind: "text", text: { text: "Captured after bounded fresh discovery" } }],
    });
  });

  test("promotes reduced JSONL evidence without allowing a later rich downgrade", async () => {
    fixture = await createCursorSourceFixture({ ready: false });
    await fixture.writeJsonlTranscript({ nativeId: CURSOR_CHAT_NATIVE_ID });
    const paths = indexPaths(fixture.root);
    const leaseNow = monotonicNow("2026-07-16T16:00:00.000Z", 100);
    const lifecycle = createSqliteIndexLifecycle({
      now: leaseNow,
      writerToken: tokenFactory("jsonl-index"),
    });
    const maintenance = createSqliteIndexMaintenance({
      now: leaseNow,
      token: tokenFactory("jsonl-maintenance"),
    });
    const selected = await createCursorSource(fixture.environment);
    const sessionIdentity = identity(selected.instance, CURSOR_CHAT_NATIVE_ID);
    const indexClock = { now: monotonicNow("2026-07-16T17:00:00.000Z", 1_000) };
    const index = () =>
      withoutProviderMutation(fixture!.cursorHome, () =>
        runIndex({
          paths,
          sources: [selected],
          lifecycle,
          clock: indexClock,
        }),
      );

    expect(await index()).toMatchObject({
      counts: { discovered: 1, unchanged: 0, updated: 1, failed: 0, stale: 0 },
    });
    expect(storedAdapterVersions(paths.database)).toEqual([CURSOR_JSONL_ADAPTER_VERSION]);
    expect((await index()).counts).toMatchObject({ unchanged: 1, updated: 0, failed: 0 });
    const search = await searchSessions({
      paths,
      lifecycle,
      text: CURSOR_JSONL_TEXT,
      filter: { source: "cursor", nativeId: CURSOR_CHAT_NATIVE_ID },
    });
    expect(search.hits).toHaveLength(1);
    const exported = await exportSession({
      paths,
      lifecycle,
      identity: sessionIdentity,
      full: true,
    });
    expect(exported.entries.map(({ kind }) => kind)).toEqual([
      "message",
      "message",
      "tool-call",
      "turn-completed",
    ]);

    await fixture.writeChatMetadata();
    fixture.writeChatStore();
    expect(await index()).toMatchObject({
      counts: { discovered: 1, unchanged: 0, updated: 1, failed: 0, stale: 0 },
    });
    expect(storedAdapterVersions(paths.database)).toEqual([CURSOR_ADAPTER_VERSION]);
    const rich = await showSession({ paths, lifecycle, identity: sessionIdentity });
    expect(JSON.stringify(rich.entries)).toContain(CURSOR_SHARED_TEXT);

    await rm(join(fixture.cursorHome, "chats"), { recursive: true });
    expect(await index()).toMatchObject({
      counts: { discovered: 1, unchanged: 0, updated: 0, failed: 1, stale: 1 },
      sources: [
        {
          status: "completed",
          items: [{ outcome: "failed", failure: "unsupported-format" }],
        },
      ],
    });
    expect(await showSession({ paths, lifecycle, identity: sessionIdentity })).toMatchObject({
      snapshot: { freshness: "stale", sourceState: "present" },
      entries: rich.entries,
    });

    await expect(forgetSession(paths, maintenance, sessionIdentity)).resolves.toMatchObject({
      outcome: "forgotten",
    });
    expect(await index()).toMatchObject({
      counts: { discovered: 1, unchanged: 0, updated: 1, failed: 0, stale: 0 },
    });
    expect(storedAdapterVersions(paths.database)).toEqual([CURSOR_JSONL_ADAPTER_VERSION]);
  });
});

function identity(source: SessionIdentity["source"], nativeId: string): SessionIdentity {
  return { source, nativeId };
}

function indexPaths(root: string): IndexPaths {
  const directory = join(root, "library");
  const database = join(directory, "sessions.sqlite3");
  return {
    directory,
    scratch: join(directory, ".scratch"),
    database,
    wal: `${database}-wal`,
    shm: `${database}-shm`,
  };
}

function monotonicNow(iso: string, incrementMs: number): () => Date {
  let milliseconds = Date.parse(iso) - incrementMs;
  return () => {
    milliseconds += incrementMs;
    return new Date(milliseconds);
  };
}

function tokenFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function setStoredAdapterVersion(databaseFile: string, version: string): void {
  const database = new DatabaseSync(databaseFile);
  try {
    const result = database
      .prepare(
        `UPDATE sessions_session_tracking
         SET last_good_adapter_version = ?, latest_adapter_version = ?
         WHERE last_good_adapter_version IS NOT NULL`,
      )
      .run(version, version);
    expect(result.changes).toBe(2);
  } finally {
    database.close();
  }
}

function storedAdapterVersions(databaseFile: string): readonly string[] {
  const url = pathToFileURL(databaseFile);
  url.searchParams.set("mode", "ro");
  url.searchParams.set("immutable", "1");
  const database = new DatabaseSync(url.href, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT DISTINCT last_good_adapter_version AS version
         FROM sessions_session_tracking
         WHERE last_good_adapter_version IS NOT NULL
         ORDER BY version`,
      )
      .all() as unknown as readonly { readonly version: string }[];
    return rows.map(({ version }) => version);
  } finally {
    database.close();
  }
}

async function withoutProviderMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const before = snapshotCursorProviderTree(root);
  try {
    return await operation();
  } finally {
    expect(snapshotCursorProviderTree(root)).toBe(before);
  }
}

async function expectNoValueInLibrary(paths: IndexPaths, value: string): Promise<void> {
  const needle = Buffer.from(value);
  for (const file of [paths.database, paths.wal, paths.shm]) {
    if (!existsSync(file)) continue;
    expect((await readFile(file)).indexOf(needle)).toBe(-1);
  }
}
