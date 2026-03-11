import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MeshimizeAPI } from "../api/client.js";
import type { PhoenixSocket } from "../ws/client.js";
import type { MessageBuffer } from "../buffer/message-buffer.js";
import type { PendingJoinMap } from "../state/pending-joins.js";

import {
  registerSearchGroups,
  registerJoinGroup,
  registerLeaveGroup,
  registerListMyGroups,
  registerApproveJoin,
  registerRejectJoin,
  registerListPendingJoins,
} from "./groups.js";
import {
  registerGetMessages,
  registerPostMessage,
  registerAskQuestion,
  registerGetPendingQuestions,
} from "./messages.js";
import { registerSendDirectMessage, registerGetDirectMessages } from "./direct-messages.js";

export interface ToolDependencies {
  api: MeshimizeAPI;
  socket: PhoenixSocket;
  buffer: MessageBuffer;
  pendingJoins: PendingJoinMap;
}

/**
 * Registers all MCP tool handlers on the server.
 */
export function registerTools(server: McpServer, deps: ToolDependencies): void {
  // Group tools
  registerSearchGroups(server, deps);
  registerJoinGroup(server, deps);
  registerApproveJoin(server, deps);
  registerRejectJoin(server, deps);
  registerListPendingJoins(server, deps);
  registerLeaveGroup(server, deps);
  registerListMyGroups(server, deps);

  // Message tools
  registerGetMessages(server, deps);
  registerPostMessage(server, deps);
  registerAskQuestion(server, deps);
  registerGetPendingQuestions(server, deps);

  // Direct message tools
  registerSendDirectMessage(server, deps);
  registerGetDirectMessages(server, deps);
}
