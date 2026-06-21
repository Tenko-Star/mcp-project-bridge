# MCP Project Bridge 中文文档

MCP Project Bridge 是一个通过 Streamable HTTP 运行的 MCP 服务，用本机 SQLite 在多个项目之间保存和读取消息。它适合多项目协作场景，例如一个项目把 API 约定、实现状态、交接说明或结构化备忘发送给另一个项目。

服务只写入自己的集中数据库，不会在被桥接的项目目录里生成文件。

## 核心逻辑

每个项目用 project key 标识。你可以自己指定 project key，也可以用 `derive_project_key` 根据项目绝对路径生成稳定 key。

消息采用集中收件箱模型：

- 定向消息包含发送方 project key、接收方 project key 和 `docKey`。
- 广播消息包含发送方 project key 和 `docKey`，没有接收方 project key。
- 同一个发送方、接收方和 `docKey` 再次写入时，会生成同一条消息的新版本。
- 传入 `messageId` 可以更新指定消息，但只有发送方项目可以更新。
- 已读状态按查看方 project key 和消息版本记录。
- `read_unread_messages` 只会把本次返回的最新版本标记为已读。
- 后续产生的新版本会重新变成未读。

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

HTTP 传输是无状态的：服务不会创建 MCP session，不会返回 `MCP-Session-Id`，也不提供独立的 GET SSE 流。普通请求响应使用 `Content-Type: application/json`。CORS 对浏览器客户端开放为 `Access-Control-Allow-Origin: *`；鉴权仍然依赖 Bearer token。

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

## Project Key 规则

`derive_project_key` 会先把 Windows 盘符路径转换成 WSL 风格路径，再把路径分隔符替换成下划线。

示例：

```text
D:\mcp\api -> /mnt/d/mcp/api -> _mnt_d_mcp_api
C:/work\frontend -> /mnt/c/work/frontend -> _mnt_c_work_frontend
/home/me/web -> _home_me_web
```

Project key 只是消息标识，不需要提前注册。

## 工具说明

### `derive_project_key`

根据项目绝对路径生成稳定 project key，不写入数据库。

```json
{
  "path": "D:\\workspace\\backend"
}
```

### `upsert_message`

创建或更新定向消息、广播消息。

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

省略 `targetProjectKey`、传 `null` 或传空字符串会创建广播消息：

```json
{
  "currentProjectKey": "_mnt_d_workspace_backend",
  "docKey": "release-note",
  "title": "Backend Release",
  "content": "Backend release is ready",
  "tags": ["release"]
}
```

支持的 `format` 为 `markdown`、`text`、`json`，默认是 `markdown`。

### `read_unread_messages`

读取当前项目未读消息，并把返回的最新版本标记为已读。

```json
{
  "currentProjectKey": "_mnt_d_workspace_frontend",
  "withBroadcast": true,
  "limit": 20
}
```

### `list_messages`

列出当前项目收件箱里的最新消息摘要，不改变已读状态。

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

按消息 id 读取版本历史，不改变已读状态。

```json
{
  "currentProjectKey": "_mnt_d_workspace_frontend",
  "messageId": 1,
  "withBroadcast": true,
  "limit": 10
}
```

定向消息历史允许发送方和接收方查看。广播消息历史允许发送方查看；其他项目需要传 `withBroadcast: true`。

## 常用流程

1. 为每个工作区生成或指定 project key。
2. 发送方用稳定的 `docKey` 调用 `upsert_message`。
3. 接收方调用 `read_unread_messages` 读取未读消息。
4. 需要搜索或查看状态但不想标记已读时，使用 `list_messages`。
5. 需要查看历史版本时，使用 `get_message_history`。
