/**
 * Startup orchestration — extracted for testability.
 *
 * Connects to the Meshimize platform (REST + WebSocket), joins channels,
 * wires event handlers, and returns the dependencies needed by the MCP server.
 */

import type { MeshimizeAPI } from "./api/client.js";
import type { PhoenixSocket } from "./ws/client.js";
import type { Channel } from "./ws/channel.js";
import type { MessageBuffer } from "./buffer/message-buffer.js";
import type { MessageDataResponse, DirectMessageDataResponse } from "./types/messages.js";
import type { GroupResponse } from "./types/groups.js";
import type { PaginatedResponse } from "./types/api.js";

export interface StartupResult {
  accountId: string;
  displayName: string;
  joinedGroups: ReadonlySet<string>;
}

export interface StartupDeps {
  api: Pick<MeshimizeAPI, "getAccount" | "getMyGroups">;
  socket: Pick<PhoenixSocket, "connect" | "channel">;
  buffer: Pick<MessageBuffer, "addGroupMessage" | "addDirectMessage" | "clearGroup">;
}

export async function startOrchestration(deps: StartupDeps): Promise<StartupResult> {
  const { api, socket, buffer } = deps;

  // Verify API key — fail fast if invalid
  const { data: account } = await api.getAccount();
  console.error(`[meshimize-mcp] Authenticated as ${account.display_name} (${account.id})`);

  // Connect WebSocket
  await socket.connect();
  console.error("[meshimize-mcp] WebSocket connected");

  // Join account channel for direct messages and membership events
  const accountChannel: Channel = socket.channel(`account:${account.id}`);
  await accountChannel.join();
  console.error("[meshimize-mcp] Joined account channel");

  // Fetch ALL group memberships (paginate until has_more is false)
  const allGroups: GroupResponse[] = [];
  let cursor: string | undefined;
  do {
    const page: PaginatedResponse<GroupResponse> = await api.getMyGroups({
      limit: 100,
      after: cursor,
    });
    allGroups.push(...page.data);
    cursor = page.meta.has_more && page.meta.next_cursor ? page.meta.next_cursor : undefined;
  } while (cursor);

  // Track joined groups and their handlers for cleanup
  const joinedGroups = new Set<string>();
  const groupHandlers = new Map<string, (payload: unknown) => void>();

  // Helper: set up a group channel with dedup + handler tracking
  async function setupGroupChannel(groupId: string): Promise<void> {
    if (joinedGroups.has(groupId)) return;

    const ch: Channel = socket.channel(`group:${groupId}`);
    const handler = (payload: unknown): void => {
      buffer.addGroupMessage(groupId, payload as MessageDataResponse);
    };
    ch.on("new_message", handler);
    groupHandlers.set(groupId, handler);

    try {
      await ch.join();
      joinedGroups.add(groupId);
      console.error(`[meshimize-mcp] Joined group:${groupId}`);
    } catch (err) {
      ch.off("new_message", handler);
      groupHandlers.delete(groupId);
      throw err;
    }
  }

  // Helper: handle group_left
  async function handleGroupLeft(groupId: string): Promise<void> {
    if (!joinedGroups.has(groupId)) {
      console.error(`[meshimize-mcp] group_left for unknown group:${groupId} — ignoring`);
      return;
    }
    joinedGroups.delete(groupId);

    const ch: Channel = socket.channel(`group:${groupId}`);
    const handler = groupHandlers.get(groupId);
    if (handler) {
      ch.off("new_message", handler);
      groupHandlers.delete(groupId);
    }

    try {
      await ch.leave();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[meshimize-mcp] Failed to leave group:${groupId}: ${msg}`);
    }

    buffer.clearGroup(groupId);
    console.error(`[meshimize-mcp] Left group:${groupId}`);
  }

  // Join all initial group channels
  for (const group of allGroups) {
    await setupGroupChannel(group.id);
  }

  // Wire account channel event handlers
  accountChannel.on("new_direct_message", (payload: unknown) => {
    buffer.addDirectMessage(payload as DirectMessageDataResponse);
  });

  accountChannel.on("group_joined", (payload: unknown) => {
    const { group_id } = payload as { group_id: string; role: string };
    setupGroupChannel(group_id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[meshimize-mcp] Failed to join group:${group_id}: ${msg}`);
    });
  });

  accountChannel.on("group_left", (payload: unknown) => {
    const { group_id } = payload as { group_id: string };
    handleGroupLeft(group_id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[meshimize-mcp] Error handling group_left for ${group_id}: ${msg}`);
    });
  });

  return {
    accountId: account.id,
    displayName: account.display_name,
    joinedGroups,
  };
}
