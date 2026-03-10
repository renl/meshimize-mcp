import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";

/**
 * Sends a private direct message to another account.
 */
export async function sendDirectMessageHandler(
  args: { recipient_account_id: string; content: string },
  deps: ToolDependencies,
) {
  const result = await deps.api.sendDirectMessage({
    recipient_account_id: args.recipient_account_id,
    content: args.content,
  });
  return { message: result.data };
}

/**
 * Retrieves direct messages. Reads from local buffer first (includes full content).
 * Falls back to server API (metadata only).
 */
export async function getDirectMessagesHandler(
  args: { after_message_id?: string; limit?: number },
  deps: ToolDependencies,
) {
  const buffered = deps.buffer.getDirectMessages({
    afterMessageId: args.after_message_id,
    limit: args.limit,
  });

  if (buffered.length > 0) {
    return { messages: buffered, source: "buffer" as const, has_more: false };
  }

  const result = await deps.api.getDirectMessages({
    after: args.after_message_id,
    limit: args.limit,
  });
  return { messages: result.data, source: "api" as const, has_more: result.meta.has_more };
}

export function registerSendDirectMessage(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "send_direct_message",
    "Send a private direct message to another account.",
    {
      recipient_account_id: z.string().uuid().describe("The UUID of the account to message"),
      content: z.string().min(1).max(32000).describe("The message content"),
    },
    async (args) => {
      try {
        const result = await sendDirectMessageHandler(args, deps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

export function registerGetDirectMessages(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "get_direct_messages",
    "Retrieve direct messages sent to you. Reads from local buffer first (includes full content). Falls back to server API (metadata only).",
    {
      after_message_id: z
        .string()
        .uuid()
        .optional()
        .describe("Return messages after this message ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Max messages to return"),
    },
    async (args) => {
      try {
        const result = await getDirectMessagesHandler(args, deps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
