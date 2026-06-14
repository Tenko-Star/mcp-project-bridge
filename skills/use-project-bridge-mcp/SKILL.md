---
name: use-project-bridge-mcp
description: Use the MCP Project Bridge server to coordinate work across multiple local projects through shared direct and broadcast messages. Trigger this skill when Codex needs to derive project keys, send or update project handoff messages, read unread project inbox messages, search message summaries, or inspect message history with the mcp-project-bridge tools.
---

# Use Project Bridge MCP

## Overview

Use this skill to exchange structured context between projects through the `mcp-project-bridge` MCP server. Prefer it for cross-project coordination, API handoffs, implementation status, release notes, and durable notes that should not be written into either project directory.

## Tool Availability

Expect these MCP tools:

- `derive_project_key`
- `upsert_message`
- `read_unread_messages`
- `list_messages`
- `get_message_history`

If the tools are not available, tell the user the Project Bridge MCP server must be connected before using this skill. Do not invent local files as a substitute message store.

## Workflow

1. Determine the current project key.
   - Use `derive_project_key` with the absolute project path when a stable path-derived key is needed.
   - Reuse a known project key when the user or previous message provides one.
2. Choose direct or broadcast scope.
   - Use `targetProjectKey` for a direct project-to-project message.
   - Omit `targetProjectKey`, pass `null`, or pass an empty string for a broadcast.
3. Use a stable `docKey`.
   - Treat `docKey` as the durable identity for a topic, such as `users-api`, `release-note`, or `frontend-handoff`.
   - Reusing the same sender, target, and `docKey` creates a new version of the existing message.
4. Write concise structured content.
   - Use `format: "markdown"` for human-readable handoffs.
   - Use `format: "json"` only when the content itself is valid JSON text.
   - Add short tags for filtering, such as `api`, `handoff`, `release`, or feature names.
5. Read inbox messages with the right visibility.
   - Use `read_unread_messages` when the user wants new messages and accepts marking returned versions as read.
   - Use `list_messages` when the user wants to inspect or search without changing read state.
   - Pass `withBroadcast: true` when broadcasts should be included.
6. Use `get_message_history` when prior versions matter.
   - Direct message history is available to sender and target.
   - Broadcast history for non-senders requires `withBroadcast: true`.

## Usage Patterns

Send a direct handoff:

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

Send a broadcast:

```json
{
  "currentProjectKey": "_mnt_d_workspace_backend",
  "docKey": "release-note",
  "title": "Backend Release",
  "content": "Backend release is ready",
  "tags": ["release"]
}
```

Read unread messages including broadcasts:

```json
{
  "currentProjectKey": "_mnt_d_workspace_frontend",
  "withBroadcast": true,
  "limit": 20
}
```

Search without marking messages read:

```json
{
  "currentProjectKey": "_mnt_d_workspace_frontend",
  "withBroadcast": true,
  "query": "users",
  "tags": ["api"],
  "limit": 20
}
```

## Guardrails

- Do not store secrets, credentials, or private tokens in bridge messages.
- Do not mark messages read with `read_unread_messages` when the user only asked to preview or search; use `list_messages` instead.
- Do not change a message target on update. Create a new message when the intended target changes.
- Do not assume broadcasts are included unless `withBroadcast: true` is set.
- Keep handoff messages factual and actionable so another project can use them without additional context.
