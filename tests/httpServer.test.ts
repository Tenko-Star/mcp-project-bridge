import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectBridgeHttpServer } from "../src/httpServer.js";
import { ProjectBridgeStore } from "../src/storage.js";

const token = "test-token";

let tempDir: string;
let store: ProjectBridgeStore;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-project-bridge-http-"));
  store = new ProjectBridgeStore({ dbPath: path.join(tempDir, "bridge.sqlite") });
  server = createProjectBridgeHttpServer({ store, token });
  await listen(server);

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/mcp`;
});

afterEach(async () => {
  await closeServer(server);
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Streamable HTTP server", () => {
  it("rejects missing and invalid bearer tokens", async () => {
    const missingToken = await postInitialize();
    const invalidToken = await postInitialize("wrong-token");

    expect(missingToken.status).toBe(401);
    expect(missingToken.headers.get("access-control-allow-origin")).toBe("*");
    expect(invalidToken.status).toBe(401);
    expect(invalidToken.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("allows any origin in CORS preflight responses", async () => {
    const response = await fetch(baseUrl, {
      method: "OPTIONS",
      headers: {
        origin: "https://example.invalid",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Authorization, Content-Type"
      }
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not expose standalone SSE or session termination endpoints", async () => {
    const response = await fetch(baseUrl, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`
      }
    });
    const deleteResponse = await fetch(baseUrl, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(deleteResponse.status).toBe(405);
    expect(deleteResponse.headers.get("allow")).toContain("POST");
    expect(deleteResponse.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns direct JSON responses without session ids", async () => {
    const response = await postInitialize(token);
    const body = await response.json() as { result: { protocolVersion: string } };

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.result.protocolVersion).toBe("2025-11-25");
  });

  it("rejects incompatible Streamable HTTP request envelopes", async () => {
    const wrongAccept = await postJson(initializeRequest(), {
      accept: "application/json"
    });
    const wrongContentType = await fetch(baseUrl, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "text/plain",
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(initializeRequest())
    });
    const invalidJson = await fetch(baseUrl, {
      method: "POST",
      headers: defaultPostHeaders(),
      body: "{"
    });
    const batch = await postJson([initializeRequest()]);

    expect(wrongAccept.status).toBe(406);
    expect(wrongContentType.status).toBe(415);
    expect(invalidJson.status).toBe(400);
    expect(batch.status).toBe(400);
    await expect(batch.json()).resolves.toMatchObject({
      error: {
        code: -32600,
        message: "Invalid Request: JSON-RPC batch is not supported"
      }
    });
  });

  it("serves tools through stateless Streamable HTTP", async () => {
    const client = new Client({ name: "project-bridge-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`
        }
      }
    });

    await client.connect(transport);

    try {
      const tools = await client.listTools();
      const result = await client.callTool({
        name: "register_project",
        arguments: {
          remote: "git@github.com:Example/Bridge.git",
          deviceId: "desktop",
          projectDescription: "Bridge service"
        }
      });

      expect(tools.tools.map((tool) => tool.name)).toContain("register_project");
      expect(tools.tools.map((tool) => tool.name)).toContain("list_projects");
      expect(result.structuredContent).toMatchObject({
        key: "github.com/example/bridge",
        remote: "git@github.com:Example/Bridge.git",
        projectDescription: "Bridge service"
      });
    } finally {
      await transport.close();
      await client.close();
    }
  });
});

async function postInitialize(bearerToken?: string): Promise<Response> {
  return postJson(initializeRequest(), bearerToken ? { authorization: `Bearer ${bearerToken}` } : { authorization: "" });
}

async function postJson(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(baseUrl, {
    method: "POST",
    headers: {
      ...defaultPostHeaders(),
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function defaultPostHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${token}`
  };
}

function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: {
        name: "project-bridge-test",
        version: "1.0.0"
      }
    }
  };
}

async function listen(httpServer: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };

    httpServer.once("error", onError);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", onError);
      resolve();
    });
  });
}

async function closeServer(httpServer: Server): Promise<void> {
  if (!httpServer.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
