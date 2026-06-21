#!/usr/bin/env node
import { getDefaultDbPath } from "./defaultDbPath.js";
import { createProjectBridgeHttpServer } from "./httpServer.js";
import { ProjectBridgeStore } from "./storage.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;

try {
  start();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

function start(): void {
  if (process.argv.slice(2).length > 0) {
    throw new Error("Usage: node dist/index.js");
  }

  const token = readRequiredToken();
  const host = process.env.MCP_PROJECT_BRIDGE_HOST?.trim() || DEFAULT_HOST;
  const port = readPort(process.env.MCP_PROJECT_BRIDGE_PORT);
  const store = new ProjectBridgeStore({ dbPath: getDefaultDbPath() });
  const httpServer = createProjectBridgeHttpServer({ store, token });
  let shuttingDown = false;

  async function shutdown(exitCode: number): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;

    try {
      await closeHttpServer(httpServer);
    } finally {
      store.close();
    }

    process.exit(exitCode);
  }

  process.once("SIGINT", () => {
    void shutdown(0);
  });
  process.once("SIGTERM", () => {
    void shutdown(0);
  });

  httpServer.on("error", (error) => {
    console.error(error);
    store.close();
    process.exit(1);
  });

  httpServer.listen(port, host, () => {
    console.log(`MCP Project Bridge listening on http://${host}:${port}/mcp`);
  });
}

function readRequiredToken(): string {
  const token = process.env.MCP_PROJECT_BRIDGE_TOKEN?.trim();

  if (!token) {
    throw new Error("MCP_PROJECT_BRIDGE_TOKEN is required");
  }

  return token;
}

function readPort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MCP_PROJECT_BRIDGE_PORT must be an integer from 1 to 65535");
  }

  return port;
}

async function closeHttpServer(httpServer: ReturnType<typeof createProjectBridgeHttpServer>): Promise<void> {
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
