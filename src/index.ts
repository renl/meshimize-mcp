/**
 * Meshimize MCP Server — Entry Point
 *
 * Loads config, runs startup orchestration, then starts the MCP stdio transport.
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
import { DelegationContentBuffer } from "./buffer/delegation-content-buffer.js";
import { createAuthorityLookupMap } from "./state/authority-lookups.js";
import { createAuthoritySessionContextStore } from "./state/authority-session-context.js";
import { createMembershipPathMap } from "./state/membership-paths.js";
import { createPendingJoinMap } from "./state/pending-joins.js";
import { noopWorkflowSupportRecorder } from "./types/workflow.js";
import { registerTools } from "./tools/index.js";
import { startOrchestration } from "./startup.js";

async function main(): Promise<void> {
  // 1. Load configuration
  const config = loadConfig();
  console.error("[meshimize-mcp] Starting...");

  // 2. Create dependencies
  const api = new MeshimizeAPI(config);
  const wsUrl = `${config.wsUrl}?token=${encodeURIComponent(config.apiKey)}&vsn=2.0.0`;
  const socket = new PhoenixSocket(wsUrl, {
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    reconnectIntervalMs: config.reconnectIntervalMs,
    maxReconnectAttempts: config.maxReconnectAttempts,
  });
  const buffer = new MessageBuffer(config.bufferSize);
  const delegationBuffer = new DelegationContentBuffer();
  const authorityLookups = createAuthorityLookupMap();
  const authoritySessionContext = createAuthoritySessionContextStore();
  const pendingJoins = createPendingJoinMap(config, {
    onExpired: (request) => authoritySessionContext.clearGroup(request.group_id),
    onRemoved: (request) => authoritySessionContext.clearGroup(request.group_id),
  });
  const membershipPaths = createMembershipPathMap();

  // 3. Run startup orchestration (authenticate, connect WS, join channels)
  await startOrchestration({ api, socket, buffer });

  // 4. Create and start MCP server
  const server = new McpServer({ name: "meshimize-mcp", version: "0.1.0" });
  registerTools(server, {
    api,
    socket,
    buffer,
    delegationBuffer,
    pendingJoins,
    authorityLookups,
    membershipPaths,
    authoritySessionContext,
    workflowRecorder: noopWorkflowSupportRecorder,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[meshimize-mcp] MCP server ready — listening on stdio");
}

main().catch((err: unknown) => {
  console.error("[meshimize-mcp] Fatal error:", err);
  process.exit(1);
});
