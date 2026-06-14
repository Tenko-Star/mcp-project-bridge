import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deriveProjectKey, normalizeProjectPathForKey } from "./pathKey.js";
import { ProjectBridgeStore } from "./storage.js";

const documentFormatSchema = z.enum(["markdown", "text", "json"]);
const stringArraySchema = z.array(z.string()).optional();

export const deriveProjectKeySchema = z.object({
  path: z.string().min(1)
});

export const upsertMessageSchema = z.object({
  currentProjectKey: z.string().min(1),
  messageId: z.number().int().positive().optional(),
  targetProjectKey: z.string().nullable().optional(),
  docKey: z.string().min(1),
  title: z.string().min(1).optional(),
  content: z.string().min(1),
  format: documentFormatSchema.optional(),
  tags: stringArraySchema
});

export const readUnreadMessagesSchema = z.object({
  currentProjectKey: z.string().min(1),
  withBroadcast: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional()
});

export const listMessagesSchema = z.object({
  currentProjectKey: z.string().min(1),
  withBroadcast: z.boolean().optional(),
  query: z.string().min(1).optional(),
  tags: stringArraySchema,
  limit: z.number().int().positive().max(100).optional()
});

export const getMessageHistorySchema = z.object({
  currentProjectKey: z.string().min(1),
  messageId: z.number().int().positive(),
  withBroadcast: z.boolean().optional(),
  limit: z.number().int().positive().max(100).optional()
});

export function createToolHandlers(store: ProjectBridgeStore) {
  return {
    deriveProjectKey(input: z.infer<typeof deriveProjectKeySchema>) {
      return {
        key: deriveProjectKey(input.path),
        normalizedPath: normalizeProjectPathForKey(input.path)
      };
    },
    upsertMessage(input: z.infer<typeof upsertMessageSchema>) {
      return store.upsertMessage(input);
    },
    readUnreadMessages(input: z.infer<typeof readUnreadMessagesSchema>) {
      return store.readUnreadMessages(input);
    },
    listMessages(input: z.infer<typeof listMessagesSchema>) {
      return store.listMessages(input);
    },
    getMessageHistory(input: z.infer<typeof getMessageHistorySchema>) {
      return store.getMessageHistory(input);
    }
  };
}

export function registerProjectBridgeTools(server: McpServer, store: ProjectBridgeStore): void {
  const handlers = createToolHandlers(store);

  registerJsonTool(
    server,
    "derive_project_key",
    "Derive a stable project key from an absolute project path without writing to storage.",
    deriveProjectKeySchema,
    handlers.deriveProjectKey
  );
  registerJsonTool(
    server,
    "upsert_message",
    "Create or update a direct or broadcast message. If targetProjectKey is omitted, null, or empty, the message is broadcast.",
    upsertMessageSchema,
    handlers.upsertMessage
  );
  registerJsonTool(
    server,
    "read_unread_messages",
    "Read unread inbox messages for the current project and mark the returned latest versions as read.",
    readUnreadMessagesSchema,
    handlers.readUnreadMessages
  );
  registerJsonTool(
    server,
    "list_messages",
    "List latest inbox messages for the current project without changing read state.",
    listMessagesSchema,
    handlers.listMessages
  );
  registerJsonTool(
    server,
    "get_message_history",
    "Read message version history by message id without changing read state.",
    getMessageHistorySchema,
    handlers.getMessageHistory
  );
}

type AnyZodObject = z.ZodObject<Record<string, z.ZodTypeAny>>;

function registerJsonTool<TSchema extends AnyZodObject, TResult>(
  server: McpServer,
  name: string,
  description: string,
  schema: TSchema,
  handler: (input: z.infer<TSchema>) => TResult
): void {
  server.registerTool(
    name,
    {
      description,
      inputSchema: schema.shape
    },
    async (input) => toCallToolResult(handler(schema.parse(input)))
  );
}

function toCallToolResult(result: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: toStructuredContent(result)
  };
}

function toStructuredContent(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }

  return { result };
}
