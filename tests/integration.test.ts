import { afterEach, describe, expect, it } from "vitest";
import { MeshimizeAPI } from "../src/api/client.js";
import { MessageBuffer } from "../src/buffer/message-buffer.js";
import { DelegationContentBuffer } from "../src/buffer/delegation-content-buffer.js";
import { loadConfig } from "../src/config.js";
import { createAuthorityLookupMap } from "../src/state/authority-lookups.js";
import { createAuthoritySessionContextStore } from "../src/state/authority-session-context.js";
import { createMembershipPathMap } from "../src/state/membership-paths.js";
import { createPendingJoinMap } from "../src/state/pending-joins.js";
import { askQuestionHandler } from "../src/tools/messages.js";
import { searchGroupsHandler } from "../src/tools/groups.js";
import type { ToolDependencies } from "../src/tools/index.js";
import { PhoenixSocket } from "../src/ws/client.js";

const runIntegration = process.env.INTEGRATION === "true";
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration("Integration Tests", () => {
  const socketsToCleanup: PhoenixSocket[] = [];
  const pendingJoinMaps: Array<ReturnType<typeof createPendingJoinMap>> = [];
  const authorityLookupMaps: Array<ReturnType<typeof createAuthorityLookupMap>> = [];

  afterEach(() => {
    for (const socket of socketsToCleanup) {
      socket.disconnect();
    }
    socketsToCleanup.length = 0;

    for (const pendingJoins of pendingJoinMaps) {
      pendingJoins.dispose();
    }
    pendingJoinMaps.length = 0;

    for (const authorityLookups of authorityLookupMaps) {
      authorityLookups.dispose();
    }
    authorityLookupMaps.length = 0;
  });

  function createLiveDeps(
    api: MeshimizeAPI,
    socket: PhoenixSocket,
    buffer: MessageBuffer,
  ): ToolDependencies {
    const config = loadConfig();
    const authorityLookups = createAuthorityLookupMap();
    const authoritySessionContext = createAuthoritySessionContextStore();
    const pendingJoins = createPendingJoinMap(config, {
      onExpired: (request) => authoritySessionContext.clearGroup(request.group_id),
      onRemoved: (request) => authoritySessionContext.clearGroup(request.group_id),
    });
    pendingJoinMaps.push(pendingJoins);
    authorityLookupMaps.push(authorityLookups);

    return {
      api,
      socket,
      buffer,
      delegationBuffer: new DelegationContentBuffer(),
      pendingJoins,
      authorityLookups,
      membershipPaths: createMembershipPathMap(),
      authoritySessionContext,
      workflowRecorder: { record: () => {} },
    };
  }

  it("loadConfig loads from environment variables", () => {
    const config = loadConfig();

    expect(config.apiKey).toBeDefined();
    expect(config.apiKey.length).toBeGreaterThan(0);
    expect(config.baseUrl).toBeDefined();
    expect(config.wsUrl).toBeDefined();
    expect(config.bufferSize).toBeGreaterThan(0);
    expect(config.heartbeatIntervalMs).toBeGreaterThan(0);
    expect(config.reconnectIntervalMs).toBeGreaterThan(0);
    expect(config.maxReconnectAttempts).toBeGreaterThanOrEqual(0);
  }, 15000);

  it("REST client connects — getAccount returns valid data", async () => {
    const config = loadConfig();
    const api = new MeshimizeAPI(config);

    const { data: account } = await api.getAccount();

    expect(account.id).toBeDefined();
    expect(typeof account.id).toBe("string");
    expect(account.display_name).toBeDefined();
    expect(typeof account.display_name).toBe("string");
    expect(account.email).toBeDefined();
    expect(typeof account.email).toBe("string");
  }, 15000);

  it("WebSocket connects to server", async () => {
    const config = loadConfig();
    const wsUrl = `${config.wsUrl}?token=${encodeURIComponent(config.apiKey)}&vsn=2.0.0`;
    const socket = new PhoenixSocket(wsUrl, {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      reconnectIntervalMs: config.reconnectIntervalMs,
      maxReconnectAttempts: config.maxReconnectAttempts,
    });
    socketsToCleanup.push(socket);

    await socket.connect();

    expect(socket.getState()).toBe("connected");

    socket.disconnect();
    expect(socket.getState()).toBe("disconnected");
  }, 15000);

  it("search_groups performs live discovery plus membership cross-reference", async () => {
    const config = loadConfig();
    const api = new MeshimizeAPI(config);
    const wsUrl = `${config.wsUrl}?token=${encodeURIComponent(config.apiKey)}&vsn=2.0.0`;
    const socket = new PhoenixSocket(wsUrl, {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      reconnectIntervalMs: config.reconnectIntervalMs,
      maxReconnectAttempts: config.maxReconnectAttempts,
    });
    socketsToCleanup.push(socket);

    const deps = createLiveDeps(api, socket, new MessageBuffer(config.bufferSize));
    const result = await searchGroupsHandler({ limit: 10 }, deps);

    expect(Array.isArray(result.groups)).toBe(true);
    expect(result.authority_continuation).toBeDefined();
    expect(result.authority_continuation.scope).toBe("lookup");
    if (result.groups.length > 0) {
      expect(result.groups[0]).toHaveProperty("is_member");
      expect(result.groups[0]).toHaveProperty("my_role");
      expect(result.authority_continuation.state).toBe("search_results_available");
    } else {
      expect(result.authority_continuation.state).toBe("no_relevant_group_found");
    }
  }, 20000);

  it("ask_question live boundary returns either an answer or recoverable timeout metadata", async () => {
    const groupId = process.env.MESHIMIZE_INTEGRATION_QA_GROUP_ID;
    if (!groupId) {
      return;
    }

    const config = loadConfig();
    const api = new MeshimizeAPI(config);
    const buffer = new MessageBuffer(config.bufferSize);
    const wsUrl = `${config.wsUrl}?token=${encodeURIComponent(config.apiKey)}&vsn=2.0.0`;
    const socket = new PhoenixSocket(wsUrl, {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      reconnectIntervalMs: config.reconnectIntervalMs,
      maxReconnectAttempts: config.maxReconnectAttempts,
    });
    socketsToCleanup.push(socket);

    await socket.connect();

    const { data: account } = await api.getAccount();
    const accountChannel = socket.channel(`account:${account.id}`);
    await accountChannel.join();
    const groupChannel = socket.channel(`group:${groupId}`);
    await groupChannel.join();

    const deps = createLiveDeps(api, socket, buffer);

    const result = await askQuestionHandler(
      {
        group_id: groupId,
        question: `Integration test question at ${new Date().toISOString()}`,
        timeout_seconds: 90,
      },
      deps,
    );

    expect(result.group_id).toBe(groupId);
    expect(result.provenance.authority_source).toBe("meshimize");
    expect(result.provenance.invocation_path).toBe("authority_group_live_work");

    if (result.answered) {
      expect(result.answer.content.length).toBeGreaterThan(0);
      expect(result.answer.responder_account_id).toBeDefined();
      expect(result.authority_continuation).toMatchObject({
        state: "completed",
        scope: "group",
        group_id: groupId,
        question_id: result.question_id,
        expires_at: null,
      });
    } else {
      expect(result.recovery.retrieval_tool).toBe("get_messages");
      expect(result.recovery.after_message_id).toBe(result.question_id);
      expect(result.recovery.match_parent_message_id).toBe(result.question_id);
      expect(result.authority_continuation).toMatchObject({
        state: "timed_out_waiting_for_answer",
        scope: "group",
        group_id: groupId,
        question_id: result.question_id,
        next_tool: "get_messages",
      });
    }
  }, 100000);
});
