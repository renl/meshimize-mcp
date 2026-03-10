/**
 * Meshimize MCP Server — Entry Point
 *
 * Startup orchestration: loads config, authenticates via REST API, establishes
 * WebSocket connection, joins account and group channels, wires real-time event
 * handlers into the message buffer, then starts the MCP stdio transport.
 *
 * NOTE: console.log() is banned — stdout is reserved for MCP stdio transport.
 * All logging MUST use console.error() or console.warn().
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { MeshimizeAPI } from "./api/client.js";
import { PhoenixSocket } from "./ws/client.js";
import { MessageBuffer } from "./buffer/message-buffer.js";
import { registerTools } from "./tools/index.js";
import type { MessageDataResponse, DirectMessageDataResponse } from "./types/messages.js";

async function main(): Promise<void> {
  // 1. Load configuration from environment variables
  const config = loadConfig();

  // 2. Log startup
  console.error("[meshimize-mcp] Starting...");

  // 3. Create REST client
  const api = new MeshimizeAPI(config);

  // 4. Verify API key — fail fast if invalid
  const { data: account } = await api.getAccount();
  console.error(`[meshimize-mcp] Authenticated as ${account.display_name} (${account.id})`);

  // 5. Build WebSocket URL with authentication token
  const wsUrl = `${config.wsUrl}?token=${encodeURIComponent(config.apiKey)}&vsn=2.0.0`;

  // 6. Create WebSocket client
  const socket = new PhoenixSocket(wsUrl, {
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    reconnectIntervalMs: config.reconnectIntervalMs,
    maxReconnectAttempts: config.maxReconnectAttempts,
  });

  // 7. Create message buffer
  const buffer = new MessageBuffer(config.bufferSize);

  // 8. Connect WebSocket
  await socket.connect();
  console.error("[meshimize-mcp] WebSocket connected");

  // 9. Join account channel for direct messages and membership events
  const accountChannel = socket.channel(`account:${account.id}`);
  await accountChannel.join();
  console.error("[meshimize-mcp] Joined account channel");

  // 10. Get current group memberships
  const groups = await api.getMyGroups({ limit: 100 });

  // 11. Helper: set up a group channel with message handler
  //     Uses a Set to guard against duplicate handler registration
  //     (e.g., if group_joined fires for an already-joined group).
  const joinedGroups = new Set<string>();

  async function setupGroupChannel(groupId: string): Promise<void> {
    if (joinedGroups.has(groupId)) return;
    joinedGroups.add(groupId);

    const ch = socket.channel(`group:${groupId}`);
    ch.on("new_message", (payload: unknown) => {
      buffer.addGroupMessage(groupId, payload as MessageDataResponse);
    });
    await ch.join();
    console.error(`[meshimize-mcp] Joined group:${groupId}`);
  }

  // 12. Join all initial group channels
  for (const group of groups.data) {
    await setupGroupChannel(group.id);
  }

  // 13. Register account channel event handlers
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
    joinedGroups.delete(group_id);
    const ch = socket.channel(`group:${group_id}`);
    ch.leave().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[meshimize-mcp] Failed to leave group:${group_id}: ${msg}`);
    });
    buffer.clearGroup(group_id);
    console.error(`[meshimize-mcp] Left group:${group_id}`);
  });

  // 14. Create MCP server
  const server = new McpServer({ name: "meshimize-mcp", version: "0.1.0" });

  // 15. Register MCP tools
  registerTools(server, { api, socket, buffer });

  // 16. Create stdio transport and connect
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 17. Ready
  console.error("[meshimize-mcp] MCP server ready — listening on stdio");
}

main().catch((err: unknown) => {
  console.error("[meshimize-mcp] Fatal error:", err);
  process.exit(1);
});
