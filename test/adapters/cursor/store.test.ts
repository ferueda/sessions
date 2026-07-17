import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import type { CursorFormatError } from "../../../src/adapters/cursor/format-error.ts";
import { materializeCursorStore } from "../../../src/adapters/cursor/store.ts";
import {
  createCursorStoreDatabase,
  encodeRoot,
  insertBlob,
  messageBlobId,
  replaceStoreMetadata,
  ROOT_BLOB_ID,
} from "../../fixtures/cursor/store.ts";

describe("Cursor local store reader", () => {
  let database: DatabaseSync | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  test("validates chat metadata and loads selected messages in root order", () => {
    database = createCursorStoreDatabase();
    const first = messageBlobId(1);
    const second = messageBlobId(2);
    insertBlob(
      database,
      ROOT_BLOB_ID,
      encodeRoot([
        { number: 1, wire: 2, value: Buffer.from(first, "hex") },
        { number: 1, wire: 2, value: Buffer.from(second, "hex") },
        { number: 1, wire: 2, value: Buffer.from(first, "hex") },
      ]),
    );
    insertBlob(database, first, JSON.stringify({ role: "user", content: "first" }));
    insertBlob(database, second, JSON.stringify({ role: "assistant", content: [] }));

    const store = materializeCursorStore(database, {
      family: "chat-store-v1",
      nativeId: "generic-session",
    });

    expect(store).toMatchObject({
      metadata: {
        agentId: "generic-session",
        createdAt: 1_700_000_000_000,
        isRunEverything: false,
        latestRootBlobId: ROOT_BLOB_ID,
        mode: "agent",
        name: "Generic session",
      },
      rootBlobId: ROOT_BLOB_ID,
      messages: [
        { rootOrdinal: 0, value: { role: "user", content: "first" } },
        { rootOrdinal: 1, value: { role: "assistant", content: [] } },
        { rootOrdinal: 2, value: { role: "user", content: "first" } },
      ],
    });
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(store.messages)).toBe(true);
  });

  test("uses the catalog checkpoint root for an agent store", () => {
    database = createCursorStoreDatabase();
    const catalogRoot = "20".repeat(32);
    replaceStoreMetadata(database, {
      agentId: "generic-session",
      createdAt: 0,
      isRunEverything: false,
      latestRootBlobId: "ignored-agent-root",
      mode: "agent",
      name: "Generic",
    });
    insertBlob(database, ROOT_BLOB_ID, new Uint8Array());
    insertBlob(database, catalogRoot, new Uint8Array());

    const store = materializeCursorStore(database, {
      family: "agent-checkpoint-store-v1",
      nativeId: "generic-session",
      rootBlobId: catalogRoot,
    });

    expect(store.rootBlobId).toBe(catalogRoot);
    expect(store.messages).toEqual([]);
  });

  test.each([
    [
      "extra user schema",
      (db: DatabaseSync) => {
        db.exec(`CREATE TABLE extra(value TEXT)`);
        insertBlob(db, ROOT_BLOB_ID, new Uint8Array());
      },
      "unsupported-format",
    ],
    [
      "extra metadata key",
      (db: DatabaseSync) => {
        replaceStoreMetadata(db, {
          agentId: "generic-session",
          createdAt: 0,
          isRunEverything: false,
          latestRootBlobId: ROOT_BLOB_ID,
          mode: "agent",
          name: "Generic",
          future: true,
        });
        insertBlob(db, ROOT_BLOB_ID, new Uint8Array());
      },
      "unsupported-format",
    ],
    [
      "conflicting agent identity",
      (db: DatabaseSync) => {
        replaceStoreMetadata(db, {
          agentId: "another-session",
          createdAt: 0,
          isRunEverything: false,
          latestRootBlobId: ROOT_BLOB_ID,
          mode: "agent",
          name: "Generic",
        });
        insertBlob(db, ROOT_BLOB_ID, new Uint8Array());
      },
      "malformed",
    ],
    ["missing root", () => undefined, "malformed"],
    [
      "non-JSON selected message",
      (db: DatabaseSync) => {
        const messageId = messageBlobId(1);
        insertBlob(
          db,
          ROOT_BLOB_ID,
          encodeRoot([{ number: 1, wire: 2, value: Buffer.from(messageId, "hex") }]),
        );
        insertBlob(db, messageId, "not JSON");
      },
      "malformed",
    ],
  ])("rejects %s without exposing provider values", (_name, mutate, kind) => {
    database = createCursorStoreDatabase();
    mutate(database);

    let error: unknown;
    try {
      materializeCursorStore(database, {
        family: "chat-store-v1",
        nativeId: "generic-session",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ kind });
    expect((error as CursorFormatError).message).not.toContain("generic-session");
  });

  test("rejects invalid metadata hex without partial decoding", () => {
    database = createCursorStoreDatabase();
    database.exec(`UPDATE meta SET value = '7b2'`);
    insertBlob(database, ROOT_BLOB_ID, new Uint8Array());

    expect(() =>
      materializeCursorStore(database!, {
        family: "chat-store-v1",
        nativeId: "generic-session",
      }),
    ).toThrowError(expect.objectContaining({ kind: "malformed" }) as CursorFormatError);
  });
});
