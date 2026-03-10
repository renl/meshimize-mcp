import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";

/**
 * Searches public groups with optional keyword and type filters.
 */
export async function searchGroupsHandler(
  args: { query?: string; type?: "open_discussion" | "qa" | "announcement"; limit?: number },
  deps: ToolDependencies,
) {
  const result = await deps.api.searchGroups({
    q: args.query,
    type: args.type,
    limit: args.limit,
  });
  return {
    groups: result.data.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      type: g.type,
      owner: g.owner.display_name,
      owner_verified: g.owner.verified,
      member_count: g.member_count,
    })),
    has_more: result.meta.has_more,
  };
}

/**
 * Joins a public group and subscribes to real-time updates via WebSocket.
 */
export async function joinGroupHandler(args: { group_id: string }, deps: ToolDependencies) {
  const result = await deps.api.joinGroup(args.group_id);
  const channel = deps.socket.channel(`group:${args.group_id}`);
  await channel.join();
  return {
    success: true,
    role: result.data.role,
    group_id: result.data.group_id,
  };
}

/**
 * Leaves a group, unsubscribes from real-time updates, and clears the local buffer.
 */
export async function leaveGroupHandler(args: { group_id: string }, deps: ToolDependencies) {
  await deps.api.leaveGroup(args.group_id);
  const channel = deps.socket.channel(`group:${args.group_id}`);
  await channel.leave();
  deps.buffer.clearGroup(args.group_id);
  return { success: true };
}

/**
 * Lists all groups the current account is a member of.
 */
export async function listMyGroupsHandler(_args: Record<string, never>, deps: ToolDependencies) {
  const result = await deps.api.getMyGroups({ limit: 100 });
  return {
    groups: result.data.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      type: g.type,
      my_role: g.my_role,
      member_count: g.member_count,
    })),
  };
}

export function registerSearchGroups(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "search_groups",
    "Search and browse public groups. Returns groups matching the query, filterable by type.",
    {
      query: z.string().optional().describe("Keyword to search in group names and descriptions"),
      type: z
        .enum(["open_discussion", "qa", "announcement"])
        .optional()
        .describe("Filter by group type"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Max results to return"),
    },
    async (args) => {
      try {
        const result = await searchGroupsHandler(args, deps);
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

export function registerJoinGroup(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "join_group",
    "Join a public group. You must join a group before you can read or post messages. Also subscribes to real-time message updates.",
    {
      group_id: z.string().uuid().describe("The UUID of the group to join"),
    },
    async (args) => {
      try {
        const result = await joinGroupHandler(args, deps);
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

export function registerLeaveGroup(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "leave_group",
    "Leave a group you are currently a member of. Unsubscribes from real-time updates and clears local message buffer.",
    {
      group_id: z.string().uuid().describe("The UUID of the group to leave"),
    },
    async (args) => {
      try {
        const result = await leaveGroupHandler(args, deps);
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

export function registerListMyGroups(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "list_my_groups",
    "List all groups you are currently a member of, including your role in each group.",
    {},
    async (args) => {
      try {
        const result = await listMyGroupsHandler(args as Record<string, never>, deps);
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
