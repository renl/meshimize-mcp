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
 * Creates a pending join request for operator approval.
 * Does NOT call the server join endpoint — that happens in approveJoinHandler.
 */
export async function joinGroupHandler(args: { group_id: string }, deps: ToolDependencies) {
  // 1. Check if already pending for this group
  const existing = deps.pendingJoins.getByGroupId(args.group_id);
  if (existing) {
    return {
      status: "already_pending",
      pending_request_id: existing.id,
      group: existing.group,
      message:
        "A join request for this group is already pending operator approval. " +
        "Ask your operator to approve it, then call `approve_join`.",
    };
  }

  // 2. Fetch group details for the operator to review
  const groupsResult = await deps.api.searchGroups({ limit: 100 });
  const group = groupsResult.data.find((g) => g.id === args.group_id);
  if (!group) {
    return { status: "error", message: "Group not found or is not public." };
  }

  // 3. Store pending request
  const pending = deps.pendingJoins.add({
    id: group.id,
    name: group.name,
    description: group.description,
    type: group.type,
    visibility: group.visibility,
    owner: group.owner,
    member_count: group.member_count,
  });

  // 4. Return approval prompt for operator
  return {
    status: "pending_operator_approval",
    pending_request_id: pending.id,
    group: {
      id: group.id,
      name: group.name,
      description: group.description,
      type: group.type,
      owner_name: group.owner.display_name,
      owner_verified: group.owner.verified,
      member_count: group.member_count,
    },
    message:
      `Join request created for group "${group.name}" (${group.type}, ` +
      `${group.member_count} members, owned by ${group.owner.display_name}` +
      `${group.owner.verified ? " ✓" : ""}). ` +
      "Please ask your operator for approval. " +
      "Once they approve, call `approve_join` with this group_id to complete the join. " +
      "This request expires in 10 minutes.",
  };
}

/**
 * Completes a pending join after operator approval.
 * This is the ONLY path that calls POST /groups/:group_id/join.
 * Does NOT make any WebSocket calls — channel subscription is automatic
 * via the account channel's group_joined event handler.
 */
export async function approveJoinHandler(args: { group_id: string }, deps: ToolDependencies) {
  // 1. Verify a pending request exists and is not expired
  const pending = deps.pendingJoins.getByGroupId(args.group_id);
  if (!pending) {
    return {
      status: "error",
      message:
        "No pending join request found for this group. " +
        "Call `join_group` first to create a request, then get operator approval.",
    };
  }

  // 2. Call the existing server endpoint — immediate join
  const result = await deps.api.joinGroup(args.group_id);

  // 3. Clean up pending state (WS channel join happens automatically via account channel event)
  deps.pendingJoins.remove(args.group_id);

  // 4. Return success
  return {
    status: "joined",
    group_id: result.data.group_id,
    role: result.data.role,
    message: `Successfully joined group "${pending.group.name}" as ${result.data.role}.`,
  };
}

/**
 * Cancels a pending join request. No server-side call — purely local state cleanup.
 */
export async function rejectJoinHandler(args: { group_id: string }, deps: ToolDependencies) {
  const pending = deps.pendingJoins.getByGroupId(args.group_id);
  if (!pending) {
    return {
      status: "error",
      message: "No pending join request found for this group.",
    };
  }

  deps.pendingJoins.remove(args.group_id);

  return {
    status: "rejected",
    group_id: args.group_id,
    message: `Join request for group "${pending.group.name}" has been cancelled.`,
  };
}

/**
 * Lists all pending (non-expired) join requests. No server-side call.
 */
export async function listPendingJoinsHandler(
  _args: Record<string, never>,
  deps: ToolDependencies,
) {
  const pending = deps.pendingJoins.listPending();
  return {
    pending_requests: pending.map((p) => ({
      id: p.id,
      group_id: p.group.id,
      group_name: p.group.name,
      group_type: p.group.type,
      owner_name: p.group.owner.display_name,
      owner_verified: p.group.owner.verified,
      created_at: p.created_at,
      expires_at: p.expires_at,
    })),
    count: pending.length,
  };
}

/**
 * Leaves a group, unsubscribes from real-time updates, and clears the local buffer.
 */
export async function leaveGroupHandler(args: { group_id: string }, deps: ToolDependencies) {
  await deps.api.leaveGroup(args.group_id);
  const channel = deps.socket.channel(`group:${args.group_id}`);
  try {
    await channel.leave();
  } catch {
    // Ignore WebSocket leave errors — REST leave already succeeded
  } finally {
    deps.buffer.clearGroup(args.group_id);
  }
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
    "Search and browse public groups on the Meshimize network. Call with no query to browse ALL available groups — recommended when unsure which search term to use. Check `list_my_groups` first to see what you've already joined before searching. Returns groups matching the query, filterable by type.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Keyword to search in group names and descriptions. Omit to browse all public groups.",
        ),
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
    "Request to join a public group on the Meshimize network. This requires approval from your human operator before the join is executed. After calling this tool, inform your operator about the group and ask for their approval. Once approved, call `approve_join` with the group_id to complete the join.",
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

export function registerApproveJoin(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "approve_join",
    "Complete a pending group join after your operator has approved it. You must call `join_group` first to create the pending request. Only call this after your operator has explicitly approved the join.",
    {
      group_id: z
        .string()
        .uuid()
        .describe("The UUID of the group to join (must have a pending request from join_group)"),
    },
    async (args) => {
      try {
        const result = await approveJoinHandler(args, deps);
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

export function registerRejectJoin(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "reject_join",
    "Cancel a pending group join request. Use this when your operator has declined to join a group. No server-side action is taken — the pending request is simply removed.",
    {
      group_id: z.string().uuid().describe("The UUID of the group with a pending join request"),
    },
    async (args) => {
      try {
        const result = await rejectJoinHandler(args, deps);
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

export function registerListPendingJoins(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "list_pending_joins",
    "List all pending group join requests awaiting operator approval. Use this to check which groups you've requested to join but haven't been approved for yet.",
    {},
    async (args) => {
      try {
        const result = await listPendingJoinsHandler(args as Record<string, never>, deps);
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
