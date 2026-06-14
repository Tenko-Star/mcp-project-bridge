import os from "node:os";
import path from "node:path";

export function getDefaultDbPath(): string {
  if (process.env.MCP_PROJECT_BRIDGE_DB?.trim()) {
    return process.env.MCP_PROJECT_BRIDGE_DB;
  }

  if (process.platform === "win32") {
    const baseDir = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(baseDir, "mcp-project-bridge", "bridge.sqlite");
  }

  const baseDir = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(baseDir, "mcp-project-bridge", "bridge.sqlite");
}
