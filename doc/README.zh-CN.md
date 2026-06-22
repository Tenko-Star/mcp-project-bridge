# MCP Project Bridge 中文文档

MCP Project Bridge 是一个通过 Streamable HTTP 运行的 MCP 服务，用集中 SQLite 在已注册的 Git remote 项目之间保存和读取消息。它适合多项目、多设备协作场景，例如一个项目把 API 约定、实现状态、交接说明或结构化备忘发送给另一个项目。

服务只写入自己的集中数据库，不会在被桥接的项目目录里生成文件。

## 核心逻辑

项目用 Git remote 标识，不再用本地路径。项目必须先注册，之后才能发送、接收或查看消息。

注册时，服务会把 Git remote 解析成 canonical key：

- canonical key 是单个全小写字符串，格式类似 `host/namespace/project`。
- 多级 namespace 会保留，例如 `github.com/org/team/repo`。
- 数据库会保存首次注册时的原始 remote。
- 后续注册同一个 canonical key 时，不会覆盖原始 remote 或项目描述。
- key 不是别名系统。只有不同 remote 解析到同一个 canonical key 时，才会指向同一个项目。

消息采用集中收件箱模型：

- 定向消息包含发送方 project key、接收方 project key 和 `docKey`。
- 定向消息的目标项目必须已注册，否则写入失败。
- 广播消息包含发送方 project key 和 `docKey`，没有接收方 project key。
- 同一个发送方、接收方和 `docKey` 再次写入时，会生成同一条消息的新版本。
- 传入 `messageId` 可以更新指定消息，但只有发送方项目可以更新。
- 已读状态按查看方 project key、`deviceId` 和消息版本记录。
- `read_unread_messages` 只会把本次返回的最新版本标记为该设备已读。
- 后续产生的新版本会重新变成该设备未读。

普通收件箱默认不包含广播消息。需要传 `withBroadcast: true` 才会读取广播。

## 本地连接

要求：

- Node.js 20 或更新版本
- Yarn 1.x

安装并构建：

```bash
yarn install
yarn build
```

启动 Streamable HTTP 服务：

```bash
MCP_PROJECT_BRIDGE_TOKEN=change-me node dist/index.js
```

PowerShell:

```powershell
$env:MCP_PROJECT_BRIDGE_TOKEN = "change-me"
node dist/index.js
```

服务默认监听 `127.0.0.1:3000`，MCP 端点是 `/mcp`。
请把 MCP 客户端配置为 Streamable HTTP 端点，例如 `http://127.0.0.1:3000/mcp`，并在每个请求中发送 `Authorization: Bearer change-me`。

HTTP 传输是无状态的：服务不会创建 MCP session，不会返回 `MCP-Session-Id`，也不提供独立的 GET SSE 流。普通请求响应使用 `Content-Type: application/json`。`GET /mcp` 和 `DELETE /mcp` 返回 `405`。CORS 对浏览器客户端开放为 `Access-Control-Allow-Origin: *`；鉴权仍然依赖 Bearer token，不使用 cookie/credentials。

可选环境变量：

- `MCP_PROJECT_BRIDGE_HOST`：监听地址，默认 `127.0.0.1`
- `MCP_PROJECT_BRIDGE_PORT`：监听端口，默认 `3000`
- `MCP_PROJECT_BRIDGE_TOKEN`：必填 Bearer token

## 数据库位置

默认数据库位置：

- Windows: `%APPDATA%\\mcp-project-bridge\\bridge.sqlite`
- Linux 和 WSL: `$XDG_DATA_HOME/mcp-project-bridge/bridge.sqlite`，或 `~/.local/share/mcp-project-bridge/bridge.sqlite`

可以用 `MCP_PROJECT_BRIDGE_DB` 指定数据库文件：

```bash
MCP_PROJECT_BRIDGE_TOKEN=change-me MCP_PROJECT_BRIDGE_DB=/data/bridge.sqlite node dist/index.js
```

## Docker 镜像

构建镜像：

```bash
docker build -t mcp-project-bridge:latest .
```

以 Streamable HTTP 服务运行 Docker 镜像：

```bash
docker run --rm \
  -p 3000:3000 \
  -e MCP_PROJECT_BRIDGE_TOKEN=change-me \
  -v mcp-project-bridge-data:/data \
  mcp-project-bridge:latest
```

镜像默认设置 `MCP_PROJECT_BRIDGE_DB=/data/bridge.sqlite` 和 `MCP_PROJECT_BRIDGE_HOST=0.0.0.0`。挂载 `/data` 后，容器重启不会丢失消息，并可按需映射容器端口。HTTP 端点是 `http://<host>:3000/mcp`。

## Remote Key 规则

调用工具时传 Git remote URL。服务会把它 canonicalize 成项目 key 并保存。

示例：

```text
https://github.com/Org/Repo.git -> github.com/org/repo
git@github.com:Org/Repo.git -> github.com/org/repo
ssh://git@github.com/org/team/Repo.git -> github.com/org/team/repo
```

规则：

- remote 必须包含 host、namespace 和 project。
- canonical key 全小写，保留 `/` 分隔。
- 数据库只在首次注册项目时保存原始 remote 字符串。
- 工具入参使用 `currentProjectRemote`、`targetProjectRemote` 这类 remote 字段；调用方应传 remote，不应传本地路径或旧的路径型 key。

## 工具说明

### `register_project`

注册 Git remote 项目，并可选地 upsert 当前设备。

```json
{
  "remote": "https://github.com/example/backend.git",
  "deviceId": "desktop",
  "projectDescription": "Backend service",
  "deviceDescription": "Windows desktop"
}
```

`deviceId` 是可选的。发送定向消息前注册目标项目时，可以只传 `remote` 和 `projectDescription`。

```json
{
  "remote": "git@github.com:example/frontend.git",
  "projectDescription": "Frontend app"
}
```

首次注册会保存项目 remote 和项目描述。后续注册同一个 canonical key 时，只会在提供 `deviceId` 时 upsert 设备信息。

### `list_projects`

列出已注册项目和设备摘要。用它查询当前服务中有哪些可用的定向目标。

```json
{
  "query": "frontend",
  "limit": 20
}
```

`query` 会匹配 canonical key、原始 remote 或项目描述。

### `upsert_message`

创建或更新定向消息、广播消息。

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

写入前，当前项目必须已注册。对于定向消息，`targetProjectRemote` 也必须已注册。

省略 `targetProjectRemote`、传 `null` 或传空字符串会创建广播消息：

```json
{
  "currentProjectRemote": "https://github.com/example/backend.git",
  "docKey": "release-note",
  "title": "Backend Release",
  "content": "Backend release is ready",
  "tags": ["release"]
}
```

支持的 `format` 为 `markdown`、`text`、`json`，默认是 `markdown`。

### `read_unread_messages`

读取当前项目设备的未读消息，并把返回的最新版本标记为该设备已读。

```json
{
  "currentProjectRemote": "git@github.com:example/frontend.git",
  "deviceId": "server",
  "withBroadcast": true,
  "limit": 20
}
```

当前项目和 `deviceId` 必须先通过 `register_project` 注册。

### `list_messages`

列出当前项目设备收件箱里的最新消息摘要，不改变已读状态。

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

按消息 id 读取版本历史，不改变已读状态。

```json
{
  "currentProjectRemote": "git@github.com:example/frontend.git",
  "messageId": 1,
  "withBroadcast": true,
  "limit": 10
}
```

定向消息历史允许发送方和接收方查看。广播消息历史允许发送方查看；其他项目需要传 `withBroadcast: true`。

## 常用流程

1. 确定当前项目 Git remote，并使用用户主动指定的稳定 `deviceId`。
2. 任何读写操作前，先用当前 remote 和 `deviceId` 调用 `register_project`。
3. 发送定向消息前，确认目标 remote 已注册。可以用 `list_projects` 查询，也可以手动对目标 remote 调用 `register_project`。
4. 用稳定的 `docKey` 调用 `upsert_message` 发送或更新消息。
5. 可以标记已读时，用 `read_unread_messages` 读取新消息。
6. 只想搜索或查看状态、不想标记已读时，用 `list_messages`。
7. 需要查看历史版本时，用 `get_message_history`。
