import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectBridgeStore } from "../src/storage.js";
import { createToolHandlers } from "../src/toolHandlers.js";

let tempDir: string;
let store: ProjectBridgeStore;
let tools: ReturnType<typeof createToolHandlers>;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-project-bridge-tools-"));
  store = new ProjectBridgeStore({ dbPath: path.join(tempDir, "bridge.sqlite") });
  tools = createToolHandlers(store);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("tool handlers", () => {
  it("supports direct and broadcast inbox workflow", () => {
    const backend = tools.deriveProjectKey({ path: "D:\\workspace\\backend" });
    const frontend = tools.deriveProjectKey({ path: "D:\\workspace\\frontend" });

    const direct = tools.upsertMessage({
      currentProjectKey: backend.key,
      targetProjectKey: frontend.key,
      docKey: "user-pages",
      title: "User pages API",
      content: "GET /users\nPOST /users",
      tags: ["api", "users"]
    });
    const broadcast = tools.upsertMessage({
      currentProjectKey: backend.key,
      targetProjectKey: null,
      docKey: "release-note",
      content: "Backend release is ready"
    });

    const defaultUnread = tools.readUnreadMessages({
      currentProjectKey: frontend.key
    });
    const broadcastUnread = tools.readUnreadMessages({
      currentProjectKey: frontend.key,
      withBroadcast: true
    });
    const history = tools.getMessageHistory({
      currentProjectKey: frontend.key,
      messageId: direct.messageId
    });

    expect(direct.targetProjectKey).toBe(frontend.key);
    expect(broadcast.targetProjectKey).toBeNull();
    expect(defaultUnread.map((item) => item.messageId)).toEqual([direct.messageId]);
    expect(broadcastUnread.map((item) => item.messageId)).toEqual([broadcast.messageId]);
    expect(history[0]?.content).toContain("GET /users");
  });
});
