import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";
import type { Delegation } from "../types/delegations.js";
import type { DelegationContentBuffer } from "../buffer/delegation-content-buffer.js";

/**
 * Enriches a delegation with content from the local buffer as fallback.
 * Server-provided content is primary. Buffer content used only when server returns null
 * and buffer has a cached value (e.g., stale read, or content not yet reflected).
 */
function enrichWithBuffer(delegation: Delegation, buffer: DelegationContentBuffer): Delegation {
  const content = buffer.get(delegation.id);
  if (!content) return delegation;
  return {
    ...delegation,
    // Only use buffer content as fallback when server returns null
    description: delegation.description ?? content.description ?? delegation.description,
    result: delegation.result ?? content.result ?? delegation.result,
  };
}

/**
 * Creates a new delegation in a group.
 */
export async function createDelegationHandler(
  args: {
    group_id: string;
    description: string;
    target_account_id?: string;
    ttl_seconds?: number;
  },
  deps: ToolDependencies,
) {
  const body: {
    group_id: string;
    description: string;
    target_account_id?: string;
    ttl_seconds?: number;
  } = {
    group_id: args.group_id,
    description: args.description,
  };
  if (args.target_account_id !== undefined) {
    body.target_account_id = args.target_account_id;
  }
  if (args.ttl_seconds !== undefined) {
    body.ttl_seconds = args.ttl_seconds;
  }

  const result = await deps.api.createDelegation(body);
  if (result.data.description !== null) {
    deps.delegationBuffer.storeDescription(result.data.id, result.data.description);
  }
  return { delegation: result.data };
}

/**
 * Lists delegations with optional filters. Enriches with local buffer content as fallback.
 */
export async function listDelegationsHandler(
  args: {
    group_id?: string;
    state?: "pending" | "accepted" | "completed" | "acknowledged" | "cancelled" | "expired";
    role?: "sender" | "assignee" | "available";
    limit?: number;
    after?: string;
  },
  deps: ToolDependencies,
) {
  const result = await deps.api.listDelegations({
    group_id: args.group_id,
    state: args.state,
    role: args.role,
    limit: args.limit,
    after: args.after,
  });

  const enriched = result.data.map((d) => enrichWithBuffer(d, deps.delegationBuffer));
  return { delegations: enriched, meta: result.meta };
}

/**
 * Gets a single delegation by ID. Enriches with local buffer content as fallback.
 */
export async function getDelegationHandler(
  args: { delegation_id: string },
  deps: ToolDependencies,
) {
  const result = await deps.api.getDelegation(args.delegation_id);
  const enriched = enrichWithBuffer(result.data, deps.delegationBuffer);
  return { delegation: enriched };
}

/**
 * Accepts a pending delegation.
 */
export async function acceptDelegationHandler(
  args: { delegation_id: string },
  deps: ToolDependencies,
) {
  const result = await deps.api.acceptDelegation(args.delegation_id);
  return { delegation: result.data };
}

/**
 * Completes an accepted delegation with a result.
 */
export async function completeDelegationHandler(
  args: { delegation_id: string; result: string },
  deps: ToolDependencies,
) {
  const apiResult = await deps.api.completeDelegation(args.delegation_id, {
    result: args.result,
  });
  if (apiResult.data.result !== null) {
    deps.delegationBuffer.storeResult(apiResult.data.id, apiResult.data.result);
  }
  return { delegation: apiResult.data };
}

/**
 * Cancels a delegation.
 */
export async function cancelDelegationHandler(
  args: { delegation_id: string },
  deps: ToolDependencies,
) {
  const result = await deps.api.cancelDelegation(args.delegation_id);
  return { delegation: result.data };
}

/**
 * Acknowledges a completed delegation. Purges content and evicts from local buffer.
 */
export async function acknowledgeDelegationHandler(
  args: { delegation_id: string },
  deps: ToolDependencies,
) {
  const result = await deps.api.acknowledgeDelegation(args.delegation_id);
  // Content is purged on acknowledge — evict from local buffer
  deps.delegationBuffer.delete(result.data.id);
  return { delegation: result.data };
}

/**
 * Extends the TTL of a delegation.
 */
export async function extendDelegationHandler(
  args: { delegation_id: string; ttl_seconds?: number },
  deps: ToolDependencies,
) {
  const body = args.ttl_seconds !== undefined ? { ttl_seconds: args.ttl_seconds } : undefined;
  const result = await deps.api.extendDelegation(args.delegation_id, body);
  return { delegation: result.data };
}

// --- Registration functions ---

export function registerCreateDelegation(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "create_delegation",
    "Create a new delegation in a group. The sender is automatically set to the authenticated account. The description is persisted server-side with lifecycle-tied cleanup (purged on acknowledge or TTL expiry).",
    {
      group_id: z.string().uuid().describe("The UUID of the group"),
      description: z
        .string()
        .min(1)
        .max(32000)
        .describe(
          "Description of the delegated task (persisted server-side; purged on acknowledge or TTL expiry)",
        ),
      target_account_id: z
        .string()
        .uuid()
        .optional()
        .describe("Optional UUID of the target account to assign the delegation to"),
      ttl_seconds: z
        .number()
        .int()
        .min(300)
        .max(604800)
        .optional()
        .describe("Time-to-live in seconds (300\u2013604800). Defaults to server setting."),
    },
    async (args) => {
      try {
        const result = await createDelegationHandler(args, deps);
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

export function registerListDelegations(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "list_delegations",
    "List delegations with optional filters. Returns delegations from the server with content included. Local buffer provides fallback enrichment when server returns null for content fields.",
    {
      group_id: z.string().uuid().optional().describe("Filter by group UUID"),
      state: z
        .enum(["pending", "accepted", "completed", "acknowledged", "cancelled", "expired"])
        .optional()
        .describe("Filter by delegation state"),
      role: z
        .enum(["sender", "assignee", "available"])
        .optional()
        .describe("Filter by role relative to the authenticated account"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Max delegations to return"),
      after: z.string().uuid().optional().describe("Cursor for pagination"),
    },
    async (args) => {
      try {
        const result = await listDelegationsHandler(args, deps);
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

export function registerGetDelegation(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "get_delegation",
    "Get a single delegation by ID. Returns delegation from server with content included. Local buffer provides fallback enrichment when server returns null for content fields.",
    {
      delegation_id: z.string().uuid().describe("The UUID of the delegation"),
    },
    async (args) => {
      try {
        const result = await getDelegationHandler(args, deps);
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

export function registerAcceptDelegation(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "accept_delegation",
    "Accept a pending delegation. Only the target account (if set) or any group member (if no target) can accept.",
    {
      delegation_id: z.string().uuid().describe("The UUID of the delegation to accept"),
    },
    async (args) => {
      try {
        const result = await acceptDelegationHandler(args, deps);
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

export function registerCompleteDelegation(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "complete_delegation",
    "Complete an accepted delegation with a result. The result is persisted server-side with lifecycle-tied cleanup (purged on acknowledge or TTL expiry).",
    {
      delegation_id: z.string().uuid().describe("The UUID of the delegation to complete"),
      result: z
        .string()
        .min(1)
        .max(32000)
        .describe(
          "The result of the delegation (persisted server-side; purged on acknowledge or TTL expiry)",
        ),
    },
    async (args) => {
      try {
        const handlerResult = await completeDelegationHandler(args, deps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(handlerResult, null, 2) }],
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

export function registerCancelDelegation(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "cancel_delegation",
    "Cancel a delegation. Only the sender can cancel a pending or accepted delegation.",
    {
      delegation_id: z.string().uuid().describe("The UUID of the delegation to cancel"),
    },
    async (args) => {
      try {
        const result = await cancelDelegationHandler(args, deps);
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

export function registerAcknowledgeDelegation(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "acknowledge_delegation",
    "Acknowledge a completed delegation. Only the sender can call. Transitions to 'acknowledged' state and purges description/result content. Clears the local content buffer for this delegation.",
    {
      delegation_id: z.string().uuid().describe("The UUID of the delegation to acknowledge"),
    },
    async (args) => {
      try {
        const result = await acknowledgeDelegationHandler(args, deps);
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

export function registerExtendDelegation(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "extend_delegation",
    "Extend the TTL of a delegation. Only the sender can call. Works on pending, accepted, or completed delegations. If ttl_seconds is provided, adds that many seconds to the current expires_at. If omitted, resets expires_at to now + original_ttl_seconds.",
    {
      delegation_id: z.string().uuid().describe("The UUID of the delegation to extend"),
      ttl_seconds: z
        .number()
        .int()
        .min(300)
        .max(604800)
        .optional()
        .describe(
          "Seconds to add to current expires_at (300\u2013604800). If omitted, resets to now + original_ttl_seconds.",
        ),
    },
    async (args) => {
      try {
        const result = await extendDelegationHandler(args, deps);
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

/**
 * Registers all 8 delegation MCP tool handlers on the server.
 */
export function registerDelegationTools(server: McpServer, deps: ToolDependencies): void {
  registerCreateDelegation(server, deps);
  registerListDelegations(server, deps);
  registerGetDelegation(server, deps);
  registerAcceptDelegation(server, deps);
  registerCompleteDelegation(server, deps);
  registerCancelDelegation(server, deps);
  registerAcknowledgeDelegation(server, deps);
  registerExtendDelegation(server, deps);
}
