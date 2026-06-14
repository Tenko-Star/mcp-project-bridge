#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDefaultDbPath } from "./defaultDbPath.js";
import { createProjectBridgeServer } from "./mcpServer.js";
import { ProjectBridgeStore } from "./storage.js";

const store = new ProjectBridgeStore({ dbPath: getDefaultDbPath() });
const server = createProjectBridgeServer(store);

async function shutdown(): Promise<void> {
  await server.close();
  store.close();
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  store.close();
  console.error(error);
  process.exit(1);
}
