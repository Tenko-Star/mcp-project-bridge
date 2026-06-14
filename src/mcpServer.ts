import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProjectBridgeStore } from "./storage.js";
import { registerProjectBridgeTools } from "./toolHandlers.js";

export function createProjectBridgeServer(store: ProjectBridgeStore): McpServer {
  const server = new McpServer({
    name: "mcp-project-bridge",
    version: "0.1.0"
  });

  registerProjectBridgeTools(server, store);

  return server;
}
