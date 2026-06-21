import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createProjectBridgeServer } from "./mcpServer.js";
import { ProjectBridgeStore } from "./storage.js";

const MCP_PATH = "/mcp";
const CORS_ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS";
const CORS_ALLOWED_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "MCP-Protocol-Version",
  "MCP-Session-Id",
  "Last-Event-ID"
].join(", ");
const ALLOW_HEADER = "POST, OPTIONS";

export interface ProjectBridgeHttpServerOptions {
  store: ProjectBridgeStore;
  token: string;
}

export function createProjectBridgeHttpServer(options: ProjectBridgeHttpServerOptions): Server {
  if (options.token.length === 0) {
    throw new Error("MCP_PROJECT_BRIDGE_TOKEN must not be empty");
  }

  return createServer((req, res) => {
    void handleProjectBridgeHttpRequest(req, res, options).catch((error) => {
      if (!res.headersSent) {
        applyCorsHeaders(res);
        writeJsonRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
}

async function handleProjectBridgeHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ProjectBridgeHttpServerOptions
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  applyCorsHeaders(res);

  if (url.pathname !== MCP_PATH) {
    writeJsonRpcError(res, 404, -32004, "Not found");
    return;
  }

  if (req.method === "OPTIONS") {
    writeNoContent(res, 204, {
      "Access-Control-Allow-Methods": CORS_ALLOWED_METHODS,
      "Access-Control-Allow-Headers": CORS_ALLOWED_HEADERS,
      "Access-Control-Max-Age": "86400"
    });
    return;
  }

  if (!hasValidBearerToken(req, options.token)) {
    writeJsonRpcError(res, 401, -32001, "Unauthorized", {
      "WWW-Authenticate": "Bearer"
    });
    return;
  }

  if (req.method !== "POST") {
    writeJsonRpcError(res, 405, -32000, "Method not allowed.", {
      Allow: ALLOW_HEADER
    });
    return;
  }

  const parsedBody = await readJsonRpcBody(req).catch((error: unknown) => {
    if (error instanceof JsonRpcHttpError) {
      writeJsonRpcError(res, error.statusCode, error.code, error.message);
      return undefined;
    }

    throw error;
  });
  if (parsedBody === undefined) {
    return;
  }

  if (Array.isArray(parsedBody)) {
    writeJsonRpcError(res, 400, -32600, "Invalid Request: JSON-RPC batch is not supported");
    return;
  }

  const server = createProjectBridgeServer(options.store);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  let cleanedUp = false;

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    void Promise.allSettled([
      transport.close(),
      server.close()
    ]);
  };

  res.once("close", cleanup);
  res.once("finish", cleanup);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    cleanup();

    if (!res.headersSent) {
      writeJsonRpcError(res, 500, -32603, "Internal server error");
      return;
    }

    throw error;
  }
}

function hasValidBearerToken(req: IncomingMessage, expectedToken: string): boolean {
  const authorization = req.headers.authorization;

  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }

  return safeEquals(authorization.slice("Bearer ".length), expectedToken);
}

function safeEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function readJsonRpcBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  try {
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    const rawBody = Buffer.concat(chunks).toString("utf8");
    return JSON.parse(rawBody);
  } catch {
    throw new JsonRpcHttpError(400, -32700, "Parse error: Invalid JSON");
  }
}

class JsonRpcHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: number,
    message: string
  ) {
    super(message);
  }
}

function applyCorsHeaders(res: ServerResponse): void {
  if (res.headersSent || res.destroyed) {
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
}

function writeNoContent(res: ServerResponse, statusCode: number, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) {
    return;
  }

  res.writeHead(statusCode, headers);
  res.end();
}

function writeJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  if (res.headersSent || res.destroyed) {
    return;
  }

  applyCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    ...headers
  });
  res.end(JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code,
      message
    },
    id: null
  }));
}
