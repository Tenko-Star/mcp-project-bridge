import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectBridgeStore } from "../src/storage.js";

let tempDir: string;
let store: ProjectBridgeStore;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-project-bridge-"));
  store = new ProjectBridgeStore({ dbPath: path.join(tempDir, "bridge.sqlite") });
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ProjectBridgeStore", () => {
  it("creates direct and broadcast messages without project registration", () => {
    const direct = store.upsertMessage({
      currentProjectKey: "backend",
      targetProjectKey: "frontend",
      docKey: "users-api",
      title: "Users API",
      content: "GET /users",
      tags: ["api", "users"]
    });
    const broadcast = store.upsertMessage({
      currentProjectKey: "backend",
      docKey: "release-note",
      content: "Backend release is ready"
    });

    expect(direct.messageId).toEqual(expect.any(Number));
    expect(direct.targetProjectKey).toBe("frontend");
    expect(direct.version).toBe(1);
    expect(broadcast.targetProjectKey).toBeNull();
    expect(broadcast.senderProjectKey).toBe("backend");
  });

  it("updates existing messages by doc identity or message id", () => {
    const created = store.upsertMessage({
      currentProjectKey: "backend",
      targetProjectKey: "frontend",
      docKey: "users-api",
      content: "GET /users"
    });
    const byDocKey = store.upsertMessage({
      currentProjectKey: "backend",
      targetProjectKey: "frontend",
      docKey: "users-api",
      content: "GET /users\nPOST /users"
    });
    const byId = store.upsertMessage({
      currentProjectKey: "backend",
      messageId: created.messageId,
      targetProjectKey: "frontend",
      docKey: "users-api",
      title: "Users API",
      content: "GET /users\nPOST /users\nDELETE /users"
    });

    expect(byDocKey.messageId).toBe(created.messageId);
    expect(byDocKey.version).toBe(2);
    expect(byId.messageId).toBe(created.messageId);
    expect(byId.version).toBe(3);
    expect(store.getMessageHistory({
      currentProjectKey: "frontend",
      messageId: created.messageId
    }).map((item) => item.version)).toEqual([3, 2, 1]);
  });

  it("rejects message id updates from non-senders", () => {
    const created = store.upsertMessage({
      currentProjectKey: "backend",
      targetProjectKey: "frontend",
      docKey: "users-api",
      content: "GET /users"
    });

    expect(() => store.upsertMessage({
      currentProjectKey: "frontend",
      messageId: created.messageId,
      targetProjectKey: "frontend",
      docKey: "users-api",
      content: "tamper"
    })).toThrowError(/Only the sender project can update message/);
  });

  it("reads unread direct messages by default and broadcasts only when requested", () => {
    const direct = store.upsertMessage({
      currentProjectKey: "backend",
      targetProjectKey: "frontend",
      docKey: "users-api",
      content: "GET /users"
    });
    const broadcast = store.upsertMessage({
      currentProjectKey: "backend",
      docKey: "release-note",
      content: "Backend release is ready"
    });

    const firstDirectRead = store.readUnreadMessages({ currentProjectKey: "frontend" });
    const secondDirectRead = store.readUnreadMessages({ currentProjectKey: "frontend" });
    const broadcastRead = store.readUnreadMessages({
      currentProjectKey: "frontend",
      withBroadcast: true
    });

    expect(firstDirectRead.map((item) => item.messageId)).toEqual([direct.messageId]);
    expect(firstDirectRead[0]?.viewed).toBe(true);
    expect(secondDirectRead).toEqual([]);
    expect(broadcastRead.map((item) => item.messageId)).toEqual([broadcast.messageId]);

    const updated = store.upsertMessage({
      currentProjectKey: "backend",
      targetProjectKey: "frontend",
      docKey: "users-api",
      content: "GET /users\nPOST /users"
    });
    const afterUpdate = store.readUnreadMessages({ currentProjectKey: "frontend" });

    expect(afterUpdate.map((item) => item.version)).toEqual([updated.version]);
  });

  it("lists inbox messages without marking them as read", () => {
    const direct = store.upsertMessage({
      currentProjectKey: "backend",
      targetProjectKey: "frontend",
      docKey: "orders-api",
      title: "Orders API",
      content: "GET /orders",
      tags: ["api", "orders"]
    });
    const broadcast = store.upsertMessage({
      currentProjectKey: "backend",
      docKey: "release-note",
      content: "Backend release is ready",
      tags: ["release"]
    });
    store.upsertMessage({
      currentProjectKey: "frontend",
      targetProjectKey: "backend",
      docKey: "frontend-note",
      content: "Frontend sent message"
    });

    const defaultList = store.listMessages({
      currentProjectKey: "frontend",
      query: "orders"
    });
    const withBroadcast = store.listMessages({
      currentProjectKey: "frontend",
      withBroadcast: true
    });
    const unreadAfterList = store.readUnreadMessages({
      currentProjectKey: "frontend",
      withBroadcast: true
    });

    expect(defaultList).toHaveLength(1);
    expect(defaultList[0]?.messageId).toBe(direct.messageId);
    expect(defaultList[0]?.viewed).toBe(false);
    expect(withBroadcast.map((item) => item.messageId)).toEqual([broadcast.messageId, direct.messageId]);
    expect(unreadAfterList.map((item) => item.messageId).sort((a, b) => a - b)).toEqual([direct.messageId, broadcast.messageId].sort((a, b) => a - b));
  });

  it("checks message history access by id", () => {
    const direct = store.upsertMessage({
      currentProjectKey: "backend",
      targetProjectKey: "frontend",
      docKey: "users-api",
      content: "GET /users"
    });
    const broadcast = store.upsertMessage({
      currentProjectKey: "backend",
      docKey: "release-note",
      content: "Backend release is ready"
    });

    expect(store.getMessageHistory({
      currentProjectKey: "frontend",
      messageId: direct.messageId
    })).toHaveLength(1);
    expect(store.getMessageHistory({
      currentProjectKey: "backend",
      messageId: broadcast.messageId
    })).toHaveLength(1);
    expect(() => store.getMessageHistory({
      currentProjectKey: "frontend",
      messageId: broadcast.messageId
    })).toThrowError(/withBroadcast/);
    expect(store.getMessageHistory({
      currentProjectKey: "frontend",
      messageId: broadcast.messageId,
      withBroadcast: true
    })).toHaveLength(1);
    expect(() => store.getMessageHistory({
      currentProjectKey: "ops",
      messageId: direct.messageId
    })).toThrowError(/not accessible/);
  });
});
