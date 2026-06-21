import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectBridgeStore } from "../src/storage.js";

let tempDir: string;
let store: ProjectBridgeStore;

const backendRemote = "git@github.com:Example/Backend.git";
const frontendRemote = "https://github.com/Example/Frontend.git";
const opsRemote = "ssh://git@git.example.com/Example/Ops.git";
const backendKey = "github.com/example/backend";
const frontendKey = "github.com/example/frontend";

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-project-bridge-"));
  store = new ProjectBridgeStore({ dbPath: path.join(tempDir, "bridge.sqlite") });
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ProjectBridgeStore", () => {
  it("registers projects once and upserts devices on later calls", () => {
    const first = store.registerProject({
      remote: backendRemote,
      deviceId: "desktop",
      projectDescription: "Backend API",
      deviceDescription: "Office workstation"
    });
    const second = store.registerProject({
      remote: "https://github.com/example/backend.git",
      deviceId: "server",
      projectDescription: "Should not replace description",
      deviceDescription: "Remote server"
    });
    const third = store.registerProject({
      remote: backendRemote,
      deviceId: "desktop",
      deviceDescription: "Updated workstation"
    });

    expect(first.key).toBe(backendKey);
    expect(first.remote).toBe(backendRemote);
    expect(second.remote).toBe(backendRemote);
    expect(second.projectDescription).toBe("Backend API");
    expect(third.device?.deviceDescription).toBe("Updated workstation");

    expect(store.listProjects()).toMatchObject([
      {
        key: backendKey,
        remote: backendRemote,
        projectDescription: "Backend API",
        devices: expect.arrayContaining([
          expect.objectContaining({ deviceId: "desktop", deviceDescription: "Updated workstation" }),
          expect.objectContaining({ deviceId: "server", deviceDescription: "Remote server" })
        ])
      }
    ]);
  });

  it("lists registered projects with query and limit", () => {
    store.registerProject({
      remote: backendRemote,
      projectDescription: "Backend API"
    });
    store.registerProject({
      remote: frontendRemote,
      projectDescription: "Frontend UI"
    });
    store.registerProject({
      remote: opsRemote,
      projectDescription: "Ops automation"
    });

    expect(store.listProjects({ query: "front" }).map((item) => item.key)).toEqual([frontendKey]);
    expect(store.listProjects({ limit: 2 })).toHaveLength(2);
  });

  it("requires current and target projects to be registered before direct messages", () => {
    expect(() => store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "GET /users"
    })).toThrowError(/Current project is not registered/);

    store.registerProject({ remote: backendRemote });

    expect(() => store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "GET /users"
    })).toThrowError(/Target project is not registered/);

    store.registerProject({ remote: frontendRemote });

    const direct = store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      title: "Users API",
      content: "GET /users",
      tags: ["api", "users"]
    });

    expect(direct.messageId).toEqual(expect.any(Number));
    expect(direct.senderProjectKey).toBe(backendKey);
    expect(direct.targetProjectKey).toBe(frontendKey);
    expect(direct.version).toBe(1);
  });

  it("allows broadcasts without a target project", () => {
    store.registerProject({ remote: backendRemote });

    const broadcast = store.upsertMessage({
      currentProjectRemote: backendRemote,
      docKey: "release-note",
      content: "Backend release is ready"
    });

    expect(broadcast.targetProjectKey).toBeNull();
    expect(broadcast.senderProjectKey).toBe(backendKey);
  });

  it("updates existing messages by doc identity or message id", () => {
    store.registerProject({ remote: backendRemote });
    store.registerProject({ remote: frontendRemote });

    const created = store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "GET /users"
    });
    const byDocKey = store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "GET /users\nPOST /users"
    });
    const byId = store.upsertMessage({
      currentProjectRemote: backendRemote,
      messageId: created.messageId,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      title: "Users API",
      content: "GET /users\nPOST /users\nDELETE /users"
    });

    expect(byDocKey.messageId).toBe(created.messageId);
    expect(byDocKey.version).toBe(2);
    expect(byId.messageId).toBe(created.messageId);
    expect(byId.version).toBe(3);
    expect(store.getMessageHistory({
      currentProjectRemote: frontendRemote,
      messageId: created.messageId
    }).map((item) => item.version)).toEqual([3, 2, 1]);
  });

  it("rejects message id updates from non-senders", () => {
    store.registerProject({ remote: backendRemote });
    store.registerProject({ remote: frontendRemote });

    const created = store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "GET /users"
    });

    expect(() => store.upsertMessage({
      currentProjectRemote: frontendRemote,
      messageId: created.messageId,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "tamper"
    })).toThrowError(/Only the sender project can update message/);
  });

  it("tracks unread state per project device", () => {
    store.registerProject({ remote: backendRemote });
    store.registerProject({ remote: frontendRemote, deviceId: "desktop" });
    store.registerProject({ remote: frontendRemote, deviceId: "server" });

    const direct = store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "GET /users"
    });

    const desktopRead = store.readUnreadMessages({
      currentProjectRemote: frontendRemote,
      deviceId: "desktop"
    });
    const desktopAgain = store.readUnreadMessages({
      currentProjectRemote: frontendRemote,
      deviceId: "desktop"
    });
    const serverRead = store.readUnreadMessages({
      currentProjectRemote: frontendRemote,
      deviceId: "server"
    });

    expect(desktopRead.map((item) => item.messageId)).toEqual([direct.messageId]);
    expect(desktopAgain).toEqual([]);
    expect(serverRead.map((item) => item.messageId)).toEqual([direct.messageId]);

    const updated = store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "GET /users\nPOST /users"
    });

    expect(store.readUnreadMessages({
      currentProjectRemote: frontendRemote,
      deviceId: "desktop"
    }).map((item) => item.version)).toEqual([updated.version]);
  });

  it("lists inbox messages without marking them as read", () => {
    store.registerProject({ remote: backendRemote });
    store.registerProject({ remote: frontendRemote, deviceId: "desktop" });

    const direct = store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "orders-api",
      title: "Orders API",
      content: "GET /orders",
      tags: ["api", "orders"]
    });
    const broadcast = store.upsertMessage({
      currentProjectRemote: backendRemote,
      docKey: "release-note",
      content: "Backend release is ready",
      tags: ["release"]
    });

    const defaultList = store.listMessages({
      currentProjectRemote: frontendRemote,
      deviceId: "desktop",
      query: "orders"
    });
    const withBroadcast = store.listMessages({
      currentProjectRemote: frontendRemote,
      deviceId: "desktop",
      withBroadcast: true
    });
    const unreadAfterList = store.readUnreadMessages({
      currentProjectRemote: frontendRemote,
      deviceId: "desktop",
      withBroadcast: true
    });

    expect(defaultList).toHaveLength(1);
    expect(defaultList[0]?.messageId).toBe(direct.messageId);
    expect(defaultList[0]?.viewed).toBe(false);
    expect(withBroadcast.map((item) => item.messageId)).toEqual([broadcast.messageId, direct.messageId]);
    expect(unreadAfterList.map((item) => item.messageId).sort((a, b) => a - b)).toEqual([direct.messageId, broadcast.messageId].sort((a, b) => a - b));
  });

  it("checks message history access by remote project", () => {
    store.registerProject({ remote: backendRemote });
    store.registerProject({ remote: frontendRemote });
    store.registerProject({ remote: opsRemote });

    const direct = store.upsertMessage({
      currentProjectRemote: backendRemote,
      targetProjectRemote: frontendRemote,
      docKey: "users-api",
      content: "GET /users"
    });
    const broadcast = store.upsertMessage({
      currentProjectRemote: backendRemote,
      docKey: "release-note",
      content: "Backend release is ready"
    });

    expect(store.getMessageHistory({
      currentProjectRemote: frontendRemote,
      messageId: direct.messageId
    })).toHaveLength(1);
    expect(store.getMessageHistory({
      currentProjectRemote: backendRemote,
      messageId: broadcast.messageId
    })).toHaveLength(1);
    expect(() => store.getMessageHistory({
      currentProjectRemote: frontendRemote,
      messageId: broadcast.messageId
    })).toThrowError(/withBroadcast/);
    expect(store.getMessageHistory({
      currentProjectRemote: frontendRemote,
      messageId: broadcast.messageId,
      withBroadcast: true
    })).toHaveLength(1);
    expect(() => store.getMessageHistory({
      currentProjectRemote: opsRemote,
      messageId: direct.messageId
    })).toThrowError(/not accessible/);
  });
});
