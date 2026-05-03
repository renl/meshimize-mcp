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
import type { AccountResponse, CurrentIdentityResponse, PaginatedResponse } from "./types/api.js";

export interface StartupResult {
  currentIdentityId: string;
  actingIdentityDisplayName: string;
  actingIdentityIsDefault: boolean;
  accountDisplayName: string;
  joinedGroups: ReadonlySet<string>;
}

export interface StartupDeps {
  api: Pick<MeshimizeAPI, "getAccount" | "getMyGroups">;
  socket: Pick<PhoenixSocket, "connect" | "channel">;
  buffer: Pick<MessageBuffer, "addGroupMessage" | "addDirectMessage" | "clearAll" | "clearGroup">;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotAMemberInitialGroupJoinFailure(err: unknown, groupId: string): boolean {
  const message = getErrorMessage(err);

  return (
    message.includes(`Channel join failed for topic "group:${groupId}"`) &&
    message.includes('reason="not_a_member"')
  );
}

function requireCurrentIdentity(account: AccountResponse): CurrentIdentityResponse {
  const currentIdentity = account.current_identity;

  if (
    !currentIdentity ||
    typeof currentIdentity.id !== "string" ||
    currentIdentity.id.length === 0 ||
    typeof currentIdentity.display_name !== "string" ||
    currentIdentity.display_name.length === 0 ||
    typeof currentIdentity.is_default !== "boolean"
  ) {
    throw new Error(
      "Meshimize contract error: GET /api/v1/account returned an invalid current_identity. " +
        "Each MCP process requires an identity-specific API key and no account-scoped fallback is allowed.",
    );
  }

  return currentIdentity;
}

export async function startOrchestration(deps: StartupDeps): Promise<StartupResult> {
  const { api, socket, buffer } = deps;

  buffer.clearAll();

  const { data: account } = await api.getAccount();
  const currentIdentity = requireCurrentIdentity(account);

  console.error(
    `[meshimize-mcp] Authenticated account container ${account.display_name} (${account.id}); ` +
      `acting identity ${currentIdentity.display_name} (${currentIdentity.id})` +
      `${currentIdentity.is_default ? " [default]" : ""}`,
  );

  await socket.connect();
  console.error("[meshimize-mcp] WebSocket connected");

  const identityChannelTopic = `identity:${currentIdentity.id}`;
  const identityChannel: Channel = socket.channel(identityChannelTopic);

  try {
    await identityChannel.join();
  } catch (err) {
    throw new Error(
      `Failed to join acting identity topic ${identityChannelTopic}: ${getErrorMessage(err)}`,
    );
  }

  console.error(`[meshimize-mcp] Joined acting identity topic ${identityChannelTopic}`);

  const joinedGroups = new Set<string>();
  const groupHandlers = new Map<string, (payload: unknown) => void>();

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

  identityChannel.on("new_direct_message", (payload: unknown) => {
    buffer.addDirectMessage(payload as DirectMessageDataResponse);
  });

  identityChannel.on("group_joined", (payload: unknown) => {
    const { group_id } = payload as { group_id: string; role: string };
    setupGroupChannel(group_id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[meshimize-mcp] Failed to join group:${group_id}: ${msg}`);
    });
  });

  identityChannel.on("group_left", (payload: unknown) => {
    const { group_id } = payload as { group_id: string };
    handleGroupLeft(group_id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[meshimize-mcp] Error handling group_left for ${group_id}: ${msg}`);
    });
  });

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

  for (const group of allGroups) {
    try {
      await setupGroupChannel(group.id);
    } catch (err) {
      if (isNotAMemberInitialGroupJoinFailure(err, group.id)) {
        socket.channel(`group:${group.id}`).resetState();
        console.error(
          `[meshimize-mcp] Startup membership mismatch: getMyGroups returned group:${group.id}, but channel join was rejected with reason="not_a_member". Skipping group subscription.`,
        );
        continue;
      }

      throw err;
    }
  }

  return {
    currentIdentityId: currentIdentity.id,
    actingIdentityDisplayName: currentIdentity.display_name,
    actingIdentityIsDefault: currentIdentity.is_default,
    accountDisplayName: account.display_name,
    joinedGroups,
  };
}
