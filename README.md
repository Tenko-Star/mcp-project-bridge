# MCP Project Bridge

[Chinese documentation](doc/README.zh-CN.md)

MCP Project Bridge is a Streamable HTTP MCP server for sharing project messages through a local SQLite database. It is designed for multi-project workspaces where one project needs to leave structured notes, API contracts, implementation status, or handoff messages for another project.

The server writes only to its own central database. It does not create files inside the projects being bridged.

## How It Works

Each project is represented by a project key. You can provide your own key, or derive a stable key from an absolute project path with `derive_project_key`.

Messages are stored in a central inbox model:

- A direct message has a sender project key, a target project key, and a `docKey`.
- A broadcast message has a sender project key and a `docKey`, with no target project key.
- Reusing the same sender, target, and `docKey` creates a new version of the same message.
- Passing `messageId` updates that message, but only the sender project can update it.
- Read state is tracked per viewer project and per message version.
- `read_unread_messages` marks only the returned latest versions as read.
- A later message version becomes unread again for projects that have not read that version.

Broadcast messages are hidden from normal inbox reads unless `withBroadcast: true` is passed.

## Local Setup

Requirements:

- Node.js 20 or newer
- Yarn 1.x

Install and build:

```bash
yarn install
yarn build
```

Start the Streamable HTTP server:

```bash
MCP_PROJECT_BRIDGE_TOKEN=change-me node dist/index.js
```

On PowerShell:

```powershell
$env:MCP_PROJECT_BRIDGE_TOKEN = "change-me"
node dist/index.js
```

The server listens on `127.0.0.1:3000` by default and exposes the MCP endpoint at `/mcp`.
Configure your MCP client to use a Streamable HTTP endpoint such as `http://127.0.0.1:3000/mcp`, and send `Authorization: Bearer change-me` on every request.

The HTTP transport is stateless: the server does not create MCP sessions, does not return `MCP-Session-Id`, and does not expose a standalone GET SSE stream. Normal request responses use `Content-Type: application/json`. CORS is open for browser-based clients with `Access-Control-Allow-Origin: *`; authentication still requires the Bearer token.

Optional environment variables:

- `MCP_PROJECT_BRIDGE_HOST`: listen host, default `127.0.0.1`
- `MCP_PROJECT_BRIDGE_PORT`: listen port, default `3000`
- `MCP_PROJECT_BRIDGE_TOKEN`: required Bearer token

## Database Location

By default, the database is stored in the user data directory:

- Windows: `%APPDATA%\\mcp-project-bridge\\bridge.sqlite`
- Linux and WSL: `$XDG_DATA_HOME/mcp-project-bridge/bridge.sqlite`, or `~/.local/share/mcp-project-bridge/bridge.sqlite`

Set `MCP_PROJECT_BRIDGE_DB` to choose a database file:

```bash
MCP_PROJECT_BRIDGE_TOKEN=change-me MCP_PROJECT_BRIDGE_DB=/data/bridge.sqlite node dist/index.js
```

## Docker Image

Build the image:

```bash
docker build -t mcp-project-bridge:latest .
```

Run it as a Streamable HTTP MCP server:

```bash
docker run --rm \
  -p 3000:3000 \
  -e MCP_PROJECT_BRIDGE_TOKEN=change-me \
  -v mcp-project-bridge-data:/data \
  mcp-project-bridge:latest
```

The image sets `MCP_PROJECT_BRIDGE_DB=/data/bridge.sqlite` and `MCP_PROJECT_BRIDGE_HOST=0.0.0.0`, so mount `/data` to keep messages across container restarts and publish the container port as needed. The HTTP endpoint is `http://<host>:3000/mcp`.

## Project Keys

`derive_project_key` normalizes Windows drive paths into WSL-style paths before replacing path separators with underscores.

Examples:

```text
D:\mcp\api -> /mnt/d/mcp/api -> _mnt_d_mcp_api
C:/work\frontend -> /mnt/c/work/frontend -> _mnt_c_work_frontend
/home/me/web -> _home_me_web
```

Project keys are just message identifiers. They do not need to be registered before use.

## Tools

### `derive_project_key`

Derive a stable project key from an absolute project path without writing to storage.

```json
{
  "path": "D:\\workspace\\backend"
}
```

### `upsert_message`

Create or update a direct or broadcast message.

```json
{
  "currentProjectKey": "_mnt_d_workspace_backend",
  "targetProjectKey": "_mnt_d_workspace_frontend",
  "docKey": "users-api",
  "title": "Users API",
  "content": "GET /users\nPOST /users",
  "format": "markdown",
  "tags": ["api", "users"]
}
```

Omit `targetProjectKey`, pass `null`, or pass an empty string to create a broadcast message:

```json
{
  "currentProjectKey": "_mnt_d_workspace_backend",
  "docKey": "release-note",
  "title": "Backend Release",
  "content": "Backend release is ready",
  "tags": ["release"]
}
```

Supported formats are `markdown`, `text`, and `json`. The default format is `markdown`.

### `read_unread_messages`

Read unread inbox messages for the current project and mark the returned latest versions as read.

```json
{
  "currentProjectKey": "_mnt_d_workspace_frontend",
  "withBroadcast": true,
  "limit": 20
}
```

### `list_messages`

List latest inbox message summaries without changing read state.

```json
{
  "currentProjectKey": "_mnt_d_workspace_frontend",
  "withBroadcast": true,
  "query": "users",
  "tags": ["api"],
  "limit": 20
}
```

### `get_message_history`

Read version history for a message without changing read state.

```json
{
  "currentProjectKey": "_mnt_d_workspace_frontend",
  "messageId": 1,
  "withBroadcast": true,
  "limit": 10
}
```

Direct message history is visible to the sender and target project. Broadcast history is visible to the sender, and to other projects only when `withBroadcast: true` is passed.

## Typical Workflow

1. Derive or choose the project key for each workspace.
2. Have the sender call `upsert_message` with a stable `docKey`.
3. Have the receiver call `read_unread_messages`.
4. Use `list_messages` when you need search or status without marking anything read.
5. Use `get_message_history` when you need prior versions of a message.
