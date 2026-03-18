import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";
import { normalizeAuthorityLookupKey } from "../state/authority-lookups.js";
import type { ApproveJoinResult } from "../types/workflow.js";

/**
 * Searches public groups with optional keyword and type filters.
 */
export async function searchGroupsHandler(
  args: { query?: string; type?: "open_discussion" | "qa" | "announcement"; limit?: number },
  deps: ToolDependencies,
) {
  const lookupKey = normalizeAuthorityLookupKey({ query: args.query, type: args.type });
  const normalizedQuery = lookupKey.query_text === "" ? undefined : lookupKey.query_text;

  deps.workflowRecorder.record("authority_lookup_started", {
    query_text: lookupKey.query_text,
    type_filter: lookupKey.type_filter,
  });

  const priorLookup = deps.authorityLookups.get(lookupKey);
  if (priorLookup?.decision === "no_relevant_group_found") {
    deps.workflowRecorder.record("authority_lookup_repeat_suppressed", {
      query_text: lookupKey.query_text,
      type_filter: lookupKey.type_filter,
      recorded_at: priorLookup.recorded_at,
      expires_at: priorLookup.expires_at,
    });

    return {
      groups: [],
      has_more: false,
      suppressed_repeat_lookup: true,
      message:
        "Meshimize already found no relevant public group for this exact lookup in the current session. " +
        "Do not keep repeating the same no-result search unless the authority need has changed.",
    };
  }

  const [searchResult, myGroupsResult] = await Promise.all([
    deps.api.searchGroups({
      q: normalizedQuery,
      type: args.type,
      limit: args.limit,
    }),
    deps.api.getMyGroups({ limit: 100 }).catch(() => null),
  ]);

  deps.authorityLookups.record(
    lookupKey,
    searchResult.data.length === 0 ? "no_relevant_group_found" : "candidate_groups_returned",
    searchResult.data.map((group) => group.id),
  );

  if (searchResult.data.length === 0) {
    deps.workflowRecorder.record("authority_lookup_zero_results", {
      query_text: lookupKey.query_text,
      type_filter: lookupKey.type_filter,
    });
  }

  const myGroups = myGroupsResult?.data ?? [];
  const memberIdSet = new Set<string>(myGroups.map((g) => g.id));
  const roleMap = new Map<string, string | null>(myGroups.map((g) => [g.id, g.my_role]));

  return {
    groups: searchResult.data.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      type: g.type,
      owner: g.owner.display_name,
      owner_verified: g.owner.verified,
      member_count: g.member_count,
      is_member: memberIdSet.has(g.id),
      my_role: roleMap.get(g.id) ?? null,
    })),
    has_more: searchResult.meta.has_more,
  };
}

/**
 * Creates a pending join request for operator approval.
 * Does NOT call the server join endpoint — that happens in approveJoinHandler.
 */
export async function joinGroupHandler(args: { group_id: string }, deps: ToolDependencies) {
  const existing = deps.pendingJoins.getByGroupId(args.group_id);
  if (existing) {
    return {
      status: "already_pending",
      pending_request_id: existing.id,
      group: {
        id: existing.group_id,
        name: existing.group_name,
        description: existing.group_description,
        type: existing.group_type,
        owner_name: existing.owner_display_name,
        owner_verified: existing.owner_verified,
      },
      message:
        "A join request for this group is already pending operator approval. " +
        "Ask your operator to approve it, then call `approve_join`.",
    };
  }

  const [groupsResult, myGroupsResult] = await Promise.all([
    deps.api.searchGroups({ limit: 100 }),
    deps.api.getMyGroups({ limit: 100 }).catch(() => null),
  ]);
  const group = groupsResult.data.find((g) => g.id === args.group_id);
  if (!group) {
    throw new Error("Group not found or is not public.");
  }

  const membership = myGroupsResult?.data.find((candidate) => candidate.id === args.group_id);
  if (membership) {
    const resolvedRole = membership.my_role ?? "member";
    return {
      status: "already_member",
      group_id: group.id,
      role: resolvedRole,
      message: `You are already a ${resolvedRole} of group "${group.name}".`,
    };
  }

  const pending = deps.pendingJoins.add({
    id: group.id,
    name: group.name,
    description: group.description,
    type: group.type,
    owner: group.owner,
  });

  deps.workflowRecorder.record("authority_join_pending", {
    group_id: group.id,
    group_name: group.name,
    group_type: group.type,
  });

  const expiresIn = Math.round((new Date(pending.expires_at).getTime() - Date.now()) / 60000);

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
      `This request expires in ${expiresIn} minute${expiresIn !== 1 ? "s" : ""}.`,
  };
}

/**
 * Completes a pending join after operator approval.
 * This is the ONLY path that calls POST /groups/:group_id/join.
 * Does NOT make any WebSocket calls — channel subscription is automatic
 * via the account channel's group_joined event handler.
 */
export async function approveJoinHandler(args: { group_id: string }, deps: ToolDependencies) {
  if (!deps.pendingJoins.getByGroupId(args.group_id)) {
    throw new Error(
      "No pending join request found for this group. " +
        "Call `join_group` first to create a request, then get operator approval.",
    );
  }

  const result = await deps.api.joinGroup(args.group_id);

  deps.pendingJoins.remove(args.group_id);
  deps.membershipPaths.markPostApprovalFirstAsk(args.group_id);
  deps.workflowRecorder.record("authority_join_approved", {
    group_id: args.group_id,
    role: result.data.role,
  });

  const approveResult: ApproveJoinResult = {
    group_id: result.data.group_id,
    joined: true,
    membership_path_ready: "post_approval_first_ask",
    role: result.data.role,
  };

  return approveResult;
}

/**
 * Cancels a pending join request. No server-side call — purely local state cleanup.
 */
export async function rejectJoinHandler(args: { group_id: string }, deps: ToolDependencies) {
  const pending = deps.pendingJoins.getByGroupId(args.group_id);
  if (!pending) {
    throw new Error("No pending join request found for this group.");
  }

  deps.pendingJoins.remove(args.group_id);
  deps.membershipPaths.clear(args.group_id);

  return {
    status: "rejected",
    group_id: args.group_id,
    message: `Join request for group "${pending.group_name}" has been cancelled.`,
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
      group_id: p.group_id,
      group_name: p.group_name,
      group_type: p.group_type,
      owner_name: p.owner_display_name,
      owner_verified: p.owner_verified,
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
    deps.membershipPaths.clear(args.group_id);
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
    "Search and browse public groups on the Meshimize network. Use this when you need an external/source-of-truth answer and do not already know that you are a member of the right group. Check `list_my_groups` first to see what you've already joined before searching. Call with no query to browse ALL available groups — recommended when unsure which search term to use. If you already searched Meshimize for this exact need in the current session and found no relevant public group, do not keep searching again. Returns groups matching the query, filterable by type.",
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
    "Complete a pending group join after your operator has approved it. You must call `join_group` first to create the pending request. Only call this after your operator has explicitly approved the join. On success, ask the same group immediately with `ask_question` — the next ask is treated as the post-approval first ask and should not re-run discovery.",
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
    "List all groups you are currently a member of, including your role in each group. Call this first before searching or joining — if the group you need is already in your memberships, you can interact with it directly (ask_question, post_message, get_messages) without searching or joining.",
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
