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
  it("supports registered remote projects and device-scoped inbox workflow", () => {
    const backend = tools.registerProject({
      remote: "git@github.com:Example/Backend.git",
      deviceId: "desktop",
      projectDescription: "Backend API",
      deviceDescription: "Local desktop"
    });
    const frontend = tools.registerProject({
      remote: "https://github.com/Example/Frontend.git",
      deviceId: "server",
      projectDescription: "Frontend UI"
    });

    const direct = tools.upsertMessage({
      currentProjectRemote: "https://github.com/example/backend.git",
      targetProjectRemote: "git@github.com:example/frontend.git",
      docKey: "user-pages",
      title: "User pages API",
      content: "GET /users\nPOST /users",
      tags: ["api", "users"]
    });
    const broadcast = tools.upsertMessage({
      currentProjectRemote: "git@github.com:Example/Backend.git",
      targetProjectRemote: null,
      docKey: "release-note",
      content: "Backend release is ready"
    });

    const defaultUnread = tools.readUnreadMessages({
      currentProjectRemote: "https://github.com/example/frontend.git",
      deviceId: "server"
    });
    const broadcastUnread = tools.readUnreadMessages({
      currentProjectRemote: "https://github.com/example/frontend.git",
      deviceId: "server",
      withBroadcast: true
    });
    const history = tools.getMessageHistory({
      currentProjectRemote: "https://github.com/example/frontend.git",
      messageId: direct.messageId
    });
    const projects = tools.listProjects({ query: "front" });

    expect(backend.key).toBe("github.com/example/backend");
    expect(frontend.key).toBe("github.com/example/frontend");
    expect(direct.targetProjectKey).toBe(frontend.key);
    expect(broadcast.targetProjectKey).toBeNull();
    expect(defaultUnread.map((item) => item.messageId)).toEqual([direct.messageId]);
    expect(broadcastUnread.map((item) => item.messageId)).toEqual([broadcast.messageId]);
    expect(history[0]?.content).toContain("GET /users");
    expect(projects).toMatchObject([
      {
        key: "github.com/example/frontend",
        projectDescription: "Frontend UI"
      }
    ]);
  });
});
