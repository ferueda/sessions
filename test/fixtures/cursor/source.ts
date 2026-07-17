import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SourceCaptureWorkspace } from "../../../src/application/ports/session-source.ts";
import type { CursorEnvironment } from "../../../src/adapters/cursor/paths.ts";
import type { CursorStoreMetadata } from "../../../src/adapters/cursor/store.ts";
import { encodeRoot, insertBlob, insertStoreMetadata, messageBlobId } from "./store.ts";

export const CURSOR_CHAT_NATIVE_ID = "agent-11111111-1111-4111-8111-111111111111";
export const CURSOR_AGENT_NATIVE_ID = "agent-secondary";
export const CURSOR_JSONL_NATIVE_ID = "agent-33333333-3333-4333-8333-333333333333";
export const CURSOR_JSONL_CHILD_NATIVE_ID = "44444444-4444-4444-8444-444444444444";
export const CURSOR_SHARED_TEXT = "Shared synthetic Cursor evidence";
export const CURSOR_JSONL_TEXT = "Synthetic Cursor JSONL evidence";
export const CURSOR_CHAT_TITLE = "Synthetic Cursor chat";
export const CURSOR_AGENT_TITLE = "Synthetic Cursor agent";
export const CURSOR_CHAT_ROOT_BLOB_ID = "10".repeat(32);
export const CURSOR_AGENT_ROOT_BLOB_ID = "20".repeat(32);

const CREATED_MS = Date.parse("2026-07-16T10:00:00.000Z");
const UPDATED_MS = Date.parse("2026-07-16T10:05:00.000Z");
const CREATED_AT = new Date(CREATED_MS).toISOString();
const UPDATED_AT = new Date(UPDATED_MS).toISOString();
const CHAT_SCOPE = "local";
const AGENT_PROJECT = "generic-project";
const AGENT_SCOPE = "local";

export interface CursorSourceFixture {
  readonly root: string;
  readonly home: string;
  readonly cursorHome: string;
  readonly privateRoot: string;
  readonly environment: CursorEnvironment;
  readonly workspace: SourceCaptureWorkspace;
  readonly chatMetadata: string;
  readonly chatStore: string;
  readonly catalog: string;
  readonly agentStore: string;
  readonly jsonlTranscript: string;
  writeReadySource(): Promise<void>;
  writeChatMetadata(overrides?: CursorChatMetadataOverrides): Promise<void>;
  writeChatStore(options?: CursorStoreOptions): void;
  writeAgentCatalog(overrides?: CursorAgentCatalogOverrides): void;
  writeAgentStore(options?: CursorStoreOptions): void;
  writeJsonlTranscript(options?: CursorJsonlTranscriptOptions): Promise<string>;
  mutateChatMetadata(): void;
  mutateChatMessage(text?: string): void;
  mutateAgentMessage(text?: string): void;
  mutateCatalogRow(): void;
  makeChatMessageMalformed(): void;
  makeChatStoreUnsupported(): void;
  dispose(): Promise<void>;
}

export interface CursorChatMetadataOverrides {
  readonly hasConversation?: boolean;
  readonly title?: string | null;
  readonly workspace?: string | null;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}

export interface CursorAgentCatalogOverrides {
  readonly checkpoint?: { readonly blobId: string; readonly storeKind: string } | null;
  readonly title?: string | null;
  readonly status?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface CursorStoreOptions {
  readonly nativeId?: string;
  readonly rootBlobId?: string;
  readonly title?: string;
  readonly messages?: readonly unknown[];
  readonly malformedMessage?: boolean;
  readonly unsupportedSchema?: boolean;
}

export interface CursorJsonlTranscriptOptions {
  readonly nativeId?: string;
  readonly project?: string;
  readonly parentId?: string;
  readonly records?: readonly unknown[];
  readonly bytes?: string | Uint8Array;
}

/**
 * Create a generated provider tree under the real default `<home>/.cursor`
 * location. Smoke tests can inject only HOME and exercise production routing.
 */
export async function createCursorSourceFixture(
  options: { readonly ready?: boolean } = { ready: true },
): Promise<CursorSourceFixture> {
  const root = await mkdtemp(join(tmpdir(), "sessions-cursor-source-"));
  const home = join(root, "home");
  const cursorHome = join(home, ".cursor");
  const privateRoot = join(root, "private");
  const chatDirectory = join(cursorHome, "chats", CHAT_SCOPE, CURSOR_CHAT_NATIVE_ID);
  const chatMetadata = join(chatDirectory, "meta.json");
  const chatStore = join(chatDirectory, "store.db");
  const agentScope = join(cursorHome, "projects", AGENT_PROJECT, "sdk-agent-store", AGENT_SCOPE);
  const catalog = join(agentScope, "index.db");
  const agentStore = join(
    agentScope,
    "agents",
    agentStoreDirectory(CURSOR_AGENT_NATIVE_ID),
    "store.db",
  );
  const jsonlTranscript = cursorJsonlTranscriptPath(cursorHome, {
    nativeId: CURSOR_JSONL_NATIVE_ID,
  });
  await Promise.all([mkdir(home, { recursive: true }), mkdir(privateRoot, { recursive: true })]);

  const workspace: SourceCaptureWorkspace = Object.freeze({
    async withPrivateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
      const directory = await mkdtemp(join(privateRoot, "attempt-"));
      try {
        return await operation(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  });

  let catalogMutation = 0;
  let chatMetadataMutation = 0;
  let chatStoreMutation = 0;
  let agentStoreMutation = 0;
  const fixture: CursorSourceFixture = {
    root,
    home,
    cursorHome,
    privateRoot,
    environment: { home },
    workspace,
    chatMetadata,
    chatStore,
    catalog,
    agentStore,
    jsonlTranscript,
    async writeReadySource(): Promise<void> {
      await this.writeChatMetadata();
      this.writeChatStore();
      this.writeAgentCatalog();
      this.writeAgentStore();
    },
    async writeChatMetadata(overrides = {}): Promise<void> {
      await mkdir(dirname(chatMetadata), { recursive: true });
      await writeFile(
        chatMetadata,
        JSON.stringify({
          schemaVersion: 1,
          createdAtMs: overrides.createdAtMs ?? CREATED_MS,
          updatedAtMs: overrides.updatedAtMs ?? UPDATED_MS,
          hasConversation: overrides.hasConversation ?? true,
          ...(overrides.workspace === null
            ? {}
            : { cwd: overrides.workspace ?? "/synthetic/cursor-workspace" }),
          ...(overrides.title === null ? {} : { title: overrides.title ?? CURSOR_CHAT_TITLE }),
        }),
      );
    },
    writeChatStore(options = {}): void {
      writeStoreDatabase(chatStore, {
        nativeId: options.nativeId ?? CURSOR_CHAT_NATIVE_ID,
        rootBlobId: options.rootBlobId ?? CURSOR_CHAT_ROOT_BLOB_ID,
        title: options.title ?? CURSOR_CHAT_TITLE,
        messages:
          options.messages ?? cursorConversationMessages(CURSOR_SHARED_TEXT, "cursor_chat_tool"),
        malformedMessage: options.malformedMessage ?? false,
        unsupportedSchema: options.unsupportedSchema ?? false,
      });
    },
    writeAgentCatalog(overrides = {}): void {
      writeCatalogDatabase(catalog, {
        agentId: CURSOR_AGENT_NATIVE_ID,
        checkpoint:
          overrides.checkpoint === undefined
            ? { blobId: CURSOR_AGENT_ROOT_BLOB_ID, storeKind: "local-agent-store" }
            : overrides.checkpoint,
        title: overrides.title === undefined ? CURSOR_AGENT_TITLE : overrides.title,
        status: overrides.status ?? "ready",
        createdAt: overrides.createdAt ?? CREATED_AT,
        updatedAt: overrides.updatedAt ?? UPDATED_AT,
      });
    },
    writeAgentStore(options = {}): void {
      writeStoreDatabase(agentStore, {
        nativeId: options.nativeId ?? CURSOR_AGENT_NATIVE_ID,
        rootBlobId: options.rootBlobId ?? CURSOR_AGENT_ROOT_BLOB_ID,
        title: options.title ?? CURSOR_AGENT_TITLE,
        messages:
          options.messages ?? cursorConversationMessages(CURSOR_SHARED_TEXT, "cursor_agent_tool"),
        malformedMessage: options.malformedMessage ?? false,
        unsupportedSchema: options.unsupportedSchema ?? false,
      });
    },
    async writeJsonlTranscript(options = {}): Promise<string> {
      const file = cursorJsonlTranscriptPath(cursorHome, options);
      await mkdir(dirname(file), { recursive: true });
      const value =
        options.bytes ??
        cursorJsonlRecords(
          options.nativeId === CURSOR_JSONL_CHILD_NATIVE_ID
            ? "Synthetic Cursor child JSONL evidence"
            : CURSOR_JSONL_TEXT,
        )
          .map((record) => JSON.stringify(record))
          .join("\n");
      await writeFile(file, value);
      return file;
    },
    mutateChatMetadata(): void {
      chatMetadataMutation += 1;
      writeFileSync(
        chatMetadata,
        JSON.stringify({
          schemaVersion: 1,
          createdAtMs: CREATED_MS,
          updatedAtMs: UPDATED_MS + chatMetadataMutation,
          hasConversation: true,
          cwd: "/synthetic/cursor-workspace",
          title: `${CURSOR_CHAT_TITLE} ${chatMetadataMutation}`,
        }),
      );
    },
    mutateChatMessage(text): void {
      chatStoreMutation += 1;
      replaceSelectedMessage(chatStore, 0, {
        role: "user",
        content: text ?? `Changed Cursor chat ${chatStoreMutation}`,
      });
    },
    mutateAgentMessage(text): void {
      agentStoreMutation += 1;
      replaceSelectedMessage(agentStore, 0, {
        role: "user",
        content: text ?? `Changed Cursor agent ${agentStoreMutation}`,
      });
    },
    mutateCatalogRow(): void {
      catalogMutation += 1;
      const database = new DatabaseSync(catalog);
      try {
        database
          .prepare(`UPDATE agents SET status = ?, name = ? WHERE agent_id = ?`)
          .run(
            `changed-${catalogMutation}`,
            `${CURSOR_AGENT_TITLE} ${catalogMutation}`,
            CURSOR_AGENT_NATIVE_ID,
          );
      } finally {
        database.close();
      }
    },
    makeChatMessageMalformed(): void {
      replaceSelectedMessageBytes(chatStore, 0, Buffer.from("not-json", "utf8"));
    },
    makeChatStoreUnsupported(): void {
      const database = new DatabaseSync(chatStore);
      try {
        database.exec(`CREATE TABLE unsupported(value TEXT)`);
      } finally {
        database.close();
      }
    },
    async dispose(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };

  if (options.ready !== false) await fixture.writeReadySource();
  return fixture;
}

export function cursorConversationMessages(
  repeatedText = CURSOR_SHARED_TEXT,
  toolName = "cursor_fixture_tool",
): readonly unknown[] {
  const callId = `${toolName}-call`;
  return [
    { id: "user-message", role: "user", content: repeatedText },
    {
      id: "assistant-message",
      role: "assistant",
      content: [
        { type: "text", text: "Synthetic Cursor answer" },
        { type: "tool-call", toolCallId: callId, toolName, args: { value: 1 } },
      ],
    },
    {
      id: "tool-message",
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName,
          result: "Synthetic Cursor tool result",
          experimental_content: [],
        },
      ],
    },
  ];
}

export function cursorJsonlRecords(text = CURSOR_JSONL_TEXT): readonly unknown[] {
  return [
    { role: "user", message: { content: [{ type: "text", text }] } },
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Synthetic Cursor JSONL answer" },
          { type: "tool_use", name: "cursor_jsonl_tool", input: { value: 1 } },
        ],
      },
    },
    { type: "turn_ended", status: "success" },
  ];
}

export function snapshotCursorProviderTree(root: string): string {
  if (!existsSync(root)) return JSON.stringify({ kind: "missing" });
  const entries: unknown[] = [];
  visitProviderTree(root, root, entries);
  return JSON.stringify(entries);
}

function writeStoreDatabase(file: string, options: Required<CursorStoreOptions>): void {
  mkdirSyncParent(file);
  rmFile(file);
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      CREATE TABLE blobs(id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    `);
    const metadata: CursorStoreMetadata = {
      agentId: options.nativeId,
      createdAt: CREATED_MS,
      isRunEverything: false,
      latestRootBlobId: options.rootBlobId,
      mode: "agent",
      name: options.title,
    };
    insertStoreMetadata(database, metadata);
    const messageIds = options.messages.map((_, index) => messageBlobId(index + 1));
    insertBlob(
      database,
      options.rootBlobId,
      encodeRoot(
        messageIds.map((id) => ({
          number: 1,
          wire: 2 as const,
          value: Buffer.from(id, "hex"),
        })),
      ),
    );
    for (const [index, message] of options.messages.entries()) {
      insertBlob(
        database,
        messageIds[index]!,
        options.malformedMessage && index === 0 ? "not-json" : JSON.stringify(message),
      );
    }
    if (options.unsupportedSchema) database.exec(`CREATE TABLE unsupported(value TEXT)`);
  } finally {
    database.close();
  }
}

function writeCatalogDatabase(
  file: string,
  options: {
    readonly agentId: string;
    readonly checkpoint: { readonly blobId: string; readonly storeKind: string } | null;
    readonly title: string | null;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  },
): void {
  mkdirSyncParent(file);
  rmFile(file);
  const database = new DatabaseSync(file);
  try {
    database.exec(`
      CREATE TABLE agents (
        agent_id TEXT PRIMARY KEY,
        workspace_ref TEXT NOT NULL,
        status TEXT NOT NULL,
        active_run_id TEXT,
        latest_checkpoint_ref_json TEXT,
        name TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    database
      .prepare(
        `INSERT INTO agents (
           agent_id,
           workspace_ref,
           status,
           active_run_id,
           latest_checkpoint_ref_json,
           name,
           metadata_json,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.agentId,
        "opaque-workspace",
        options.status,
        null,
        options.checkpoint === null ? null : JSON.stringify(options.checkpoint),
        options.title,
        "{}",
        options.createdAt,
        options.updatedAt,
      );
  } finally {
    database.close();
  }
}

function replaceSelectedMessage(file: string, index: number, value: unknown): void {
  replaceSelectedMessageBytes(file, index, Buffer.from(JSON.stringify(value), "utf8"));
}

function replaceSelectedMessageBytes(file: string, index: number, value: Uint8Array): void {
  const database = new DatabaseSync(file);
  try {
    database.prepare(`UPDATE blobs SET data = ? WHERE id = ?`).run(value, messageBlobId(index + 1));
  } finally {
    database.close();
  }
}

function agentStoreDirectory(agentId: string): string {
  return `agent-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
}

function cursorJsonlTranscriptPath(
  cursorHome: string,
  options: CursorJsonlTranscriptOptions,
): string {
  const project = options.project ?? AGENT_PROJECT;
  const nativeId = options.nativeId ?? CURSOR_JSONL_NATIVE_ID;
  const root = join(cursorHome, "projects", project, "agent-transcripts");
  return options.parentId === undefined
    ? join(root, nativeId, `${nativeId}.jsonl`)
    : join(root, options.parentId, "subagents", `${nativeId}.jsonl`);
}

function mkdirSyncParent(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function rmFile(file: string): void {
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
}

function visitProviderTree(root: string, file: string, entries: unknown[]): void {
  const stats = lstatSync(file, { bigint: true });
  const name = relative(root, file) || ".";
  const common = {
    name,
    dev: stats.dev.toString(10),
    ino: stats.ino.toString(10),
    mode: stats.mode.toString(10),
    size: stats.size.toString(10),
    mtimeNs: stats.mtimeNs.toString(10),
    ctimeNs: stats.ctimeNs.toString(10),
    birthtimeNs: stats.birthtimeNs.toString(10),
  };
  if (stats.isDirectory()) {
    entries.push({ ...common, kind: "directory" });
    for (const child of readdirSync(file).sort()) {
      visitProviderTree(root, join(file, child), entries);
    }
    return;
  }
  entries.push({
    ...common,
    kind: stats.isFile() ? "file" : "other",
    ...(stats.isFile()
      ? { digest: createHash("sha256").update(readFileSync(file)).digest("hex") }
      : {}),
  });
}
