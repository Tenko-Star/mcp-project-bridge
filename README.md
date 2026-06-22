# MCP Project Bridge

[Chinese documentation](doc/README.zh-CN.md)

MCP Project Bridge is a Streamable HTTP MCP server for sharing messages between registered Git remote projects through a central SQLite database. It is designed for multi-project or multi-device work where one project needs to leave structured notes, API contracts, implementation status, or handoff messages for another project.

The server writes only to its own central database. It does not create files inside the projects being bridged.

## How It Works

Projects are identified by Git remotes, not local paths. A project must be registered before it can send, receive, or inspect messages.

On registration, the server parses the Git remote into a canonical key:

- The canonical key is a single lower-case string in `host/namespace/project` style.
- Multi-level namespaces are preserved, such as `github.com/org/team/repo`.
- The database stores the original remote from the first registration.
- Later registrations of the same canonical key do not overwrite the original remote or project description.
- The key is not an alias system. Different remote strings only refer to the same project when they canonicalize to the same key.

Messages are stored in a central inbox model:

- A direct message has a sender project key, a target project key, and a `docKey`.
- A direct target must already be registered, otherwise the write fails.
- A broadcast message has a sender project key and a `docKey`, with no target project key.
- Reusing the same sender, target, and `docKey` creates a new version of the same message.
- Passing `messageId` updates that message, but only the sender project can update it.
- Read state is tracked per viewer project, per `deviceId`, and per message version.
- `read_unread_messages` marks only the returned latest versions as read for that device.
- A later message version becomes unread again for devices that have not read that version.

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

The HTTP transport is stateless: the server does not create MCP sessions, does not return `MCP-Session-Id`, and does not expose a standalone GET SSE stream. Normal request responses use `Content-Type: application/json`. `GET /mcp` and `DELETE /mcp` return `405`. CORS is open for browser-based clients with `Access-Control-Allow-Origin: *`; authentication still requires the Bearer token and credentials/cookies are not used.

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

## Remote Key Rules

Use a Git remote URL when calling tools. The server canonicalizes it and stores the resulting project key.

Examples:

```text
https://github.com/Org/Repo.git -> github.com/org/repo
git@github.com:Org/Repo.git -> github.com/org/repo
ssh://git@github.com/org/team/Repo.git -> github.com/org/team/repo
```

Rules:

- The remote must include a host, namespace, and project.
- The canonical key is lower-case and keeps `/` separators.
- The database stores the original remote string only on first project registration.
- Tool inputs use remotes such as `currentProjectRemote` and `targetProjectRemote`; callers should send remotes, not local paths or legacy path-based keys.

## Tools

### `register_project`

Register a Git remote project and optionally upsert the current device.

```json
{
  "remote": "https://github.com/example/backend.git",
  "deviceId": "desktop",
  "projectDescription": "Backend service",
  "deviceDescription": "Windows desktop"
}
```

`deviceId` is optional. Registering a target project before a direct send can use only `remote` and `projectDescription`.

```json
{
  "remote": "git@github.com:example/frontend.git",
  "projectDescription": "Frontend app"
}
```

On first registration, the project remote and project description are saved. Later registrations of the same canonical key only upsert device information when `deviceId` is provided.

### `list_projects`

List registered projects and device summaries. Use this to discover valid direct targets.

```json
{
  "query": "frontend",
  "limit": 20
}
```

`query` matches the canonical key, original remote, or project description.

### `upsert_message`

Create or update a direct or broadcast message.

```json
{
  "currentProjectRemote": "https://github.com/example/backend.git",
  "targetProjectRemote": "git@github.com:example/frontend.git",
  "docKey": "users-api",
  "title": "Users API",
  "content": "GET /users\nPOST /users",
  "format": "markdown",
  "tags": ["api", "users"]
}
```

The current project must be registered before writing. For direct messages, `targetProjectRemote` must also be registered before writing.

Omit `targetProjectRemote`, pass `null`, or pass an empty string to create a broadcast message:

```json
{
  "currentProjectRemote": "https://github.com/example/backend.git",
  "docKey": "release-note",
  "title": "Backend Release",
  "content": "Backend release is ready",
  "tags": ["release"]
}
```

Supported formats are `markdown`, `text`, and `json`. The default format is `markdown`.

### `read_unread_messages`

Read unread inbox messages for the current project device and mark the returned latest versions as read for that device.

```json
{
  "currentProjectRemote": "git@github.com:example/frontend.git",
  "deviceId": "server",
  "withBroadcast": true,
  "limit": 20
}
```

The current project and `deviceId` must be registered first with `register_project`.

### `list_messages`

List latest inbox message summaries for the current project device without changing read state.

```json
{
  "currentProjectRemote": "git@github.com:example/frontend.git",
  "deviceId": "server",
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
  "currentProjectRemote": "git@github.com:example/frontend.git",
  "messageId": 1,
  "withBroadcast": true,
  "limit": 10
}
```

Direct message history is visible to the sender and target project. Broadcast history is visible to the sender, and to other projects only when `withBroadcast: true` is passed.

## Typical Workflow

1. Pick the current project's Git remote and a stable user/device-provided `deviceId`.
2. Call `register_project` with the current remote and `deviceId` before any read or write.
3. For direct messages, make sure the target remote is registered first. Use `list_projects` to check existing targets, or manually call `register_project` for the target remote.
4. Send or update messages with `upsert_message` and a stable `docKey`.
5. Read new messages with `read_unread_messages` when marking them read is acceptable.
6. Use `list_messages` to search or inspect without marking anything read.
7. Use `get_message_history` when prior versions of a message matter.
