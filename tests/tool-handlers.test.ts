import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ToolDependencies } from "../src/tools/index.js";
import {
  searchGroupsHandler,
  joinGroupHandler,
  leaveGroupHandler,
  listMyGroupsHandler,
  approveJoinHandler,
  rejectJoinHandler,
  listPendingJoinsHandler,
} from "../src/tools/groups.js";
import {
  getMessagesHandler,
  postMessageHandler,
  askQuestionHandler,
  getPendingQuestionsHandler,
} from "../src/tools/messages.js";
import {
  sendDirectMessageHandler,
  getDirectMessagesHandler,
} from "../src/tools/direct-messages.js";
import type { MeshimizeAPI } from "../src/api/client.js";
import type { PhoenixSocket } from "../src/ws/client.js";
import type { MessageBuffer } from "../src/buffer/message-buffer.js";
import { createPendingJoinMap } from "../src/state/pending-joins.js";
import type { Config } from "../src/config.js";

function createTestConfig(): Config {
  return {
    apiKey: "test-key",
    baseUrl: "https://test.meshimize.com",
    wsUrl: "wss://test.meshimize.com/api/v1/ws/websocket",
    bufferSize: 1000,
    heartbeatIntervalMs: 30000,
    reconnectIntervalMs: 5000,
    maxReconnectAttempts: 10,
    joinTimeoutMs: 600000, // 10 minutes
    maxPendingJoins: 50,
  };
}

function createMockDeps(): ToolDependencies {
  return {
    api: {
      searchGroups: vi.fn(),
      joinGroup: vi.fn(),
      leaveGroup: vi.fn(),
      getMyGroups: vi.fn(),
      getMessages: vi.fn(),
      postMessage: vi.fn(),
      getDirectMessages: vi.fn(),
      sendDirectMessage: vi.fn(),
      getAccount: vi.fn(),
    } as unknown as MeshimizeAPI,
    socket: {
      channel: vi.fn(),
    } as unknown as PhoenixSocket,
    buffer: {
      getGroupMessages: vi.fn(),
      getDirectMessages: vi.fn(),
      clearGroup: vi.fn(),
    } as unknown as MessageBuffer,
    pendingJoins: createPendingJoinMap(createTestConfig()),
  };
}

const mockGroup = {
  id: "group-1",
  name: "Test Group",
  description: "A test group",
  type: "qa" as const,
  visibility: "public" as const,
  my_role: null,
  owner: { id: "owner-1", display_name: "Owner", verified: true },
  member_count: 42,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const mockSearchResult = {
  data: [mockGroup],
  meta: { has_more: false, next_cursor: null, count: 1 },
};

describe("tool handlers", () => {
  let deps: ToolDependencies;

  beforeEach(() => {
    deps = createMockDeps();
  });

  afterEach(() => {
    deps.pendingJoins.dispose();
  });

  it("search_groups calls api.searchGroups and returns formatted results with membership enrichment", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ ...mockGroup, my_role: "member" }],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await searchGroupsHandler({ query: "test", limit: 50 }, deps);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe("group-1");
    expect(result.groups[0].name).toBe("Test Group");
    expect(result.groups[0].owner).toBe("Owner");
    expect(result.groups[0].owner_verified).toBe(true);
    expect(result.groups[0].member_count).toBe(42);
    expect(result.groups[0].is_member).toBe(true);
    expect(result.groups[0].my_role).toBe("member");
    expect(result.has_more).toBe(false);
    expect(deps.api.searchGroups).toHaveBeenCalledWith({
      q: "test",
      type: undefined,
      limit: 50,
    });
    expect(deps.api.getMyGroups).toHaveBeenCalledWith({ limit: 100 });
  });

  it("search_groups marks non-member groups correctly", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    const result = await searchGroupsHandler({ query: "test", limit: 50 }, deps);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].is_member).toBe(false);
    expect(result.groups[0].my_role).toBeNull();
  });

  it("search_groups degrades gracefully when getMyGroups fails", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Network error"),
    );

    const result = await searchGroupsHandler({ query: "test", limit: 50 }, deps);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe("group-1");
    expect(result.groups[0].name).toBe("Test Group");
    // Without membership data, all groups show as non-member
    expect(result.groups[0].is_member).toBe(false);
    expect(result.groups[0].my_role).toBeNull();
    expect(result.has_more).toBe(false);
  });

  it("search_groups marks member correctly even when my_role is null", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ ...mockGroup, my_role: null }],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await searchGroupsHandler({ query: "test", limit: 50 }, deps);

    expect(result.groups).toHaveLength(1);
    // Group returned by getMyGroups means user IS a member, regardless of my_role value
    expect(result.groups[0].is_member).toBe(true);
    expect(result.groups[0].my_role).toBeNull();
  });

  // --- join_group (rewritten: creates pending request, no server join) ---

  it("join_group creates pending request and returns pending_operator_approval status", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);

    const result = await joinGroupHandler({ group_id: "group-1" }, deps);

    expect(result.status).toBe("pending_operator_approval");
    expect(result).toHaveProperty("pending_request_id");
    expect(result).toHaveProperty("group");
    if ("group" in result && result.group && typeof result.group === "object") {
      const group = result.group as Record<string, unknown>;
      expect(group.id).toBe("group-1");
      expect(group.name).toBe("Test Group");
      expect(group.type).toBe("qa");
      expect(group.owner_name).toBe("Owner");
      expect(group.owner_verified).toBe(true);
      expect(group.member_count).toBe(42);
    }
    // join_group should NOT call api.joinGroup
    expect(deps.api.joinGroup).not.toHaveBeenCalled();
    expect(deps.api.searchGroups).toHaveBeenCalledWith({ limit: 100 });
  });

  it("join_group returns already_pending for same group_id", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);

    const first = await joinGroupHandler({ group_id: "group-1" }, deps);
    const second = await joinGroupHandler({ group_id: "group-1" }, deps);

    expect(first.status).toBe("pending_operator_approval");
    expect(second.status).toBe("already_pending");
    expect(second).toHaveProperty("pending_request_id");
    // Both should reference the same pending_request_id
    expect((second as { pending_request_id: string }).pending_request_id).toBe(
      (first as { pending_request_id: string }).pending_request_id,
    );
  });

  it("join_group throws error when group not found", async () => {
    const emptyResult = {
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    };
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(emptyResult);

    await expect(joinGroupHandler({ group_id: "group-nonexistent" }, deps)).rejects.toThrow(
      "not found",
    );
  });

  it("join_group returns already_member when account has a role in the group", async () => {
    const memberGroup = { ...mockGroup, my_role: "member" as const };
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [memberGroup],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await joinGroupHandler({ group_id: "group-1" }, deps);

    expect(result.status).toBe("already_member");
    expect((result as { role: string }).role).toBe("member");
    // Should NOT create a pending request
    expect(deps.pendingJoins.getByGroupId("group-1")).toBeUndefined();
    // Should NOT call api.joinGroup
    expect(deps.api.joinGroup).not.toHaveBeenCalled();
  });

  it("join_group returns error when max pending joins exceeded", async () => {
    // Create a PendingJoinMap with maxPendingJoins: 1
    deps.pendingJoins.dispose();
    const limitedConfig = { ...createTestConfig(), maxPendingJoins: 1 };
    deps.pendingJoins = createPendingJoinMap(limitedConfig);

    const mockGroup2 = {
      ...mockGroup,
      id: "group-2",
      name: "Second Group",
    };

    // First call succeeds
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    await joinGroupHandler({ group_id: "group-1" }, deps);

    // Second call should fail because max is 1
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockGroup2],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    await expect(joinGroupHandler({ group_id: "group-2" }, deps)).rejects.toThrow(
      "maximum number of pending requests",
    );
  });

  // --- approve_join ---

  it("approve_join completes join via REST and returns joined status", async () => {
    // First create a pending request
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    await joinGroupHandler({ group_id: "group-1" }, deps);

    // Mock the REST join
    const mockJoinResult = {
      data: {
        group_id: "group-1",
        account_id: "account-1",
        role: "member" as const,
        created_at: "2026-01-01T00:00:00Z",
      },
    };
    (deps.api.joinGroup as ReturnType<typeof vi.fn>).mockResolvedValue(mockJoinResult);

    const result = await approveJoinHandler({ group_id: "group-1" }, deps);

    expect(result.status).toBe("joined");
    expect((result as { group_id: string }).group_id).toBe("group-1");
    expect((result as { role: string }).role).toBe("member");
    expect(deps.api.joinGroup).toHaveBeenCalledWith("group-1");
    // Pending request should be removed
    expect(deps.pendingJoins.getByGroupId("group-1")).toBeUndefined();
  });

  it("approve_join throws error when no pending request", async () => {
    await expect(approveJoinHandler({ group_id: "group-1" }, deps)).rejects.toThrow(
      "No pending join request",
    );
  });

  it("approve_join throws error after request expires", async () => {
    vi.useFakeTimers();
    try {
      (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
      await joinGroupHandler({ group_id: "group-1" }, deps);

      // Advance past expiry (>600000ms = 10 minutes)
      vi.advanceTimersByTime(600001);

      await expect(approveJoinHandler({ group_id: "group-1" }, deps)).rejects.toThrow(
        "No pending join request",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("approve_join propagates REST API errors", async () => {
    // Create pending request
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    await joinGroupHandler({ group_id: "group-1" }, deps);

    // Mock REST join to throw
    (deps.api.joinGroup as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Forbidden"));

    await expect(approveJoinHandler({ group_id: "group-1" }, deps)).rejects.toThrow("Forbidden");
  });

  it("approve_join does not make WebSocket calls", async () => {
    // Create pending request
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    await joinGroupHandler({ group_id: "group-1" }, deps);

    // Mock REST join success
    const mockJoinResult = {
      data: {
        group_id: "group-1",
        account_id: "account-1",
        role: "member" as const,
        created_at: "2026-01-01T00:00:00Z",
      },
    };
    (deps.api.joinGroup as ReturnType<typeof vi.fn>).mockResolvedValue(mockJoinResult);

    await approveJoinHandler({ group_id: "group-1" }, deps);

    // socket.channel should NOT have been called
    expect(deps.socket.channel).not.toHaveBeenCalled();
  });

  // --- reject_join ---

  it("reject_join removes pending request and returns rejected status", async () => {
    // Create pending request
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    await joinGroupHandler({ group_id: "group-1" }, deps);

    const result = await rejectJoinHandler({ group_id: "group-1" }, deps);

    expect(result.status).toBe("rejected");
    expect((result as { group_id: string }).group_id).toBe("group-1");
    expect(deps.pendingJoins.getByGroupId("group-1")).toBeUndefined();
  });

  it("reject_join throws error when no pending request", async () => {
    await expect(rejectJoinHandler({ group_id: "group-1" }, deps)).rejects.toThrow(
      "No pending join request",
    );
  });

  // --- list_pending_joins ---

  it("list_pending_joins returns all pending requests", async () => {
    const mockGroup2 = {
      ...mockGroup,
      id: "group-2",
      name: "Second Group",
    };
    const twoGroupsResult = {
      data: [mockGroup, mockGroup2],
      meta: { has_more: false, next_cursor: null, count: 2 },
    };
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(twoGroupsResult);

    await joinGroupHandler({ group_id: "group-1" }, deps);
    await joinGroupHandler({ group_id: "group-2" }, deps);

    const result = await listPendingJoinsHandler({} as Record<string, never>, deps);

    expect(result.count).toBe(2);
    expect(result.pending_requests).toHaveLength(2);
    const groupIds = result.pending_requests.map((p) => p.group_id).sort();
    expect(groupIds).toEqual(["group-1", "group-2"]);
  });

  it("list_pending_joins excludes expired requests", async () => {
    vi.useFakeTimers();
    try {
      (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
      await joinGroupHandler({ group_id: "group-1" }, deps);

      // Advance past expiry
      vi.advanceTimersByTime(600001);

      const result = await listPendingJoinsHandler({} as Record<string, never>, deps);

      expect(result.count).toBe(0);
      expect(result.pending_requests).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("list_pending_joins returns empty when no requests", async () => {
    const result = await listPendingJoinsHandler({} as Record<string, never>, deps);

    expect(result.count).toBe(0);
    expect(result.pending_requests).toEqual([]);
  });

  // --- Full flow tests ---

  it("full flow: join_group → approve_join → joined", async () => {
    // Step 1: Create pending join request
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    const joinResult = await joinGroupHandler({ group_id: "group-1" }, deps);
    expect(joinResult.status).toBe("pending_operator_approval");

    // Step 2: Approve the join
    const mockJoinResult = {
      data: {
        group_id: "group-1",
        account_id: "account-1",
        role: "member" as const,
        created_at: "2026-01-01T00:00:00Z",
      },
    };
    (deps.api.joinGroup as ReturnType<typeof vi.fn>).mockResolvedValue(mockJoinResult);

    const approveResult = await approveJoinHandler({ group_id: "group-1" }, deps);
    expect(approveResult.status).toBe("joined");
    expect((approveResult as { group_id: string }).group_id).toBe("group-1");

    // Pending should be cleared
    expect(deps.pendingJoins.getByGroupId("group-1")).toBeUndefined();
  });

  it("full flow: join_group → reject_join → cleared", async () => {
    // Step 1: Create pending join request
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);
    const joinResult = await joinGroupHandler({ group_id: "group-1" }, deps);
    expect(joinResult.status).toBe("pending_operator_approval");

    // Step 2: Reject the join
    const rejectResult = await rejectJoinHandler({ group_id: "group-1" }, deps);
    expect(rejectResult.status).toBe("rejected");

    // Pending should be cleared
    expect(deps.pendingJoins.getByGroupId("group-1")).toBeUndefined();
  });

  it("full flow: join_group → expire → re-join_group works", async () => {
    vi.useFakeTimers();
    try {
      (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockSearchResult);

      // Step 1: Create pending
      const first = await joinGroupHandler({ group_id: "group-1" }, deps);
      expect(first.status).toBe("pending_operator_approval");
      const firstId = (first as { pending_request_id: string }).pending_request_id;

      // Step 2: Advance past expiry
      vi.advanceTimersByTime(600001);

      // Step 3: Re-join should create a new pending request
      const second = await joinGroupHandler({ group_id: "group-1" }, deps);
      expect(second.status).toBe("pending_operator_approval");
      const secondId = (second as { pending_request_id: string }).pending_request_id;

      // Should have a new ID (different from expired one)
      expect(secondId).not.toBe(firstId);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- Existing tests (unchanged) ---

  it("leave_group calls api.leaveGroup + socket.channel().leave() + buffer.clearGroup()", async () => {
    (deps.api.leaveGroup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const mockChannel = { join: vi.fn(), leave: vi.fn().mockResolvedValue(undefined) };
    (deps.socket.channel as ReturnType<typeof vi.fn>).mockReturnValue(mockChannel);

    const result = await leaveGroupHandler({ group_id: "group-1" }, deps);

    expect(result.success).toBe(true);
    expect(deps.api.leaveGroup).toHaveBeenCalledWith("group-1");
    expect(deps.socket.channel).toHaveBeenCalledWith("group:group-1");
    expect(mockChannel.leave).toHaveBeenCalled();
    expect(deps.buffer.clearGroup).toHaveBeenCalledWith("group-1");
  });

  it("list_my_groups calls api.getMyGroups and returns formatted list", async () => {
    const mockResult = {
      data: [
        {
          id: "group-1",
          name: "My Group",
          description: "Description",
          type: "qa" as const,
          visibility: "public" as const,
          my_role: "member" as const,
          owner: { id: "owner-1", display_name: "Owner", verified: true },
          member_count: 10,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 1 },
    };
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const result = await listMyGroupsHandler({} as Record<string, never>, deps);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe("group-1");
    expect(result.groups[0].name).toBe("My Group");
    expect(result.groups[0].my_role).toBe("member");
    expect(result.groups[0].member_count).toBe(10);
    expect(deps.api.getMyGroups).toHaveBeenCalledWith({ limit: 100 });
  });

  it("get_messages (buffer hit) returns from buffer with source 'buffer'", async () => {
    const bufferedMessages = [
      {
        id: "msg-1",
        group_id: "group-1",
        content: "Hello world",
        message_type: "post" as const,
        parent_message_id: null,
        sender: { id: "s-1", display_name: "Sender", verified: false },
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue(bufferedMessages);

    const result = await getMessagesHandler({ group_id: "group-1", limit: 50 }, deps);

    expect(result.source).toBe("buffer");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("msg-1");
    expect(deps.api.getMessages).not.toHaveBeenCalled();
  });

  it("get_messages (buffer miss) calls api.getMessages with source 'api'", async () => {
    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const mockResult = {
      data: [
        {
          id: "msg-1",
          group_id: "group-1",
          message_type: "post" as const,
          parent_message_id: null,
          sender: { id: "s-1", display_name: "Sender", verified: false },
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      meta: { has_more: true, next_cursor: "cursor-1", count: 1 },
    };
    (deps.api.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const result = await getMessagesHandler({ group_id: "group-1", limit: 50 }, deps);

    expect(result.source).toBe("api");
    expect(result.messages).toHaveLength(1);
    expect("has_more" in result && result.has_more).toBe(true);
    expect(deps.api.getMessages).toHaveBeenCalledWith("group-1", {
      after: undefined,
      limit: 50,
    });
  });

  it("post_message calls api.postMessage with flat params", async () => {
    const mockResult = {
      data: {
        id: "msg-1",
        group_id: "group-1",
        content: "Test content",
        message_type: "post" as const,
        parent_message_id: null,
        sender: { id: "s-1", display_name: "Sender", verified: false },
        created_at: "2026-01-01T00:00:00Z",
      },
    };
    (deps.api.postMessage as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const result = await postMessageHandler(
      {
        group_id: "group-1",
        content: "Test content",
        message_type: "post",
      },
      deps,
    );

    expect(result.message.id).toBe("msg-1");
    expect(result.message.content).toBe("Test content");
    expect(deps.api.postMessage).toHaveBeenCalledWith("group-1", {
      content: "Test content",
      message_type: "post",
      parent_message_id: null,
    });
  });

  it("ask_question posts question then finds answer in buffer", async () => {
    vi.useFakeTimers();

    (deps.api.postMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: "q-1",
        group_id: "group-1",
        content: "What is X?",
        message_type: "question",
        parent_message_id: null,
        sender: { id: "s-1", display_name: "Asker", verified: false },
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    let callCount = 0;
    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount >= 2) {
        return [
          {
            id: "a-1",
            group_id: "group-1",
            content: "Answer is Y",
            message_type: "answer",
            parent_message_id: "q-1",
            sender: { id: "s-2", display_name: "Responder", verified: true },
            created_at: "2026-01-01T00:00:01Z",
          },
        ];
      }
      return [];
    });

    const promise = askQuestionHandler(
      { group_id: "group-1", question: "What is X?", timeout_seconds: 30 },
      deps,
    );
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;

    expect(result.answered).toBe(true);
    if (result.answered) {
      expect(result.answer.content).toBe("Answer is Y");
      expect(result.answer.responder).toBe("Responder");
      expect(result.answer.responder_verified).toBe(true);
    }

    vi.useRealTimers();
  });

  it("ask_question returns actionable timeout with group_id and timeout_seconds", async () => {
    vi.useFakeTimers();

    (deps.api.postMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: "q-timeout",
        group_id: "group-1",
        content: "Slow question?",
        message_type: "question",
        parent_message_id: null,
        sender: { id: "s-1", display_name: "Asker", verified: false },
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    // Buffer never returns an answer
    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const promise = askQuestionHandler(
      { group_id: "group-1", question: "Slow question?", timeout_seconds: 5 },
      deps,
    );
    await vi.advanceTimersByTimeAsync(6000);
    const result = await promise;

    expect(result.answered).toBe(false);
    expect(result.question_id).toBe("q-timeout");
    expect(result).toHaveProperty("group_id", "group-1");
    expect(result).toHaveProperty("timeout_seconds", 5);
    expect(result).toHaveProperty("message");
    if ("message" in result) {
      expect(result.message).toContain("get_messages");
      expect(result.message).toContain("group-1");
    }

    vi.useRealTimers();
  });

  it("ask_question timeout uses default timeout_seconds when not specified", async () => {
    vi.useFakeTimers();

    (deps.api.postMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: "q-default",
        group_id: "group-2",
        content: "Default timeout?",
        message_type: "question",
        parent_message_id: null,
        sender: { id: "s-1", display_name: "Asker", verified: false },
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const promise = askQuestionHandler({ group_id: "group-2", question: "Default timeout?" }, deps);
    await vi.advanceTimersByTimeAsync(31000);
    const result = await promise;

    expect(result.answered).toBe(false);
    expect(result).toHaveProperty("group_id", "group-2");
    expect(result).toHaveProperty("timeout_seconds", 30);
    expect(result).toHaveProperty("message");
    if ("message" in result) {
      expect(result.message).toContain("30s");
      expect(result.message).toContain("get_messages");
    }

    vi.useRealTimers();
  });

  it("get_pending_questions (single group) returns from buffer when available", async () => {
    const bufferedQuestions = [
      {
        id: "q-1",
        group_id: "group-1",
        content: "Unanswered question?",
        message_type: "question" as const,
        parent_message_id: null,
        sender: { id: "s-1", display_name: "Asker", verified: false },
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue(bufferedQuestions);

    const result = await getPendingQuestionsHandler({ group_id: "group-1", limit: 10 }, deps);

    expect(result).toHaveProperty("source", "buffer");
    expect("questions" in result && result.questions).toHaveLength(1);
    expect(deps.buffer.getGroupMessages).toHaveBeenCalledWith("group-1", {
      unanswered: true,
      limit: 10,
    });
    expect(deps.api.getMessages).not.toHaveBeenCalled();
  });

  it("get_pending_questions (cross-group) aggregates from buffer and API, filtering to QA owner/responder", async () => {
    // Mock getMyGroups returning mixed groups: QA owner, QA responder, QA member (excluded), discussion (excluded)
    const mockGroups = {
      data: [
        {
          id: "qa-owner",
          name: "QA Owned",
          description: "Owned QA group",
          type: "qa" as const,
          visibility: "public" as const,
          my_role: "owner" as const,
          owner: { id: "me", display_name: "Me", verified: true },
          member_count: 5,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "qa-responder",
          name: "QA Responding",
          description: "Responder QA group",
          type: "qa" as const,
          visibility: "public" as const,
          my_role: "responder" as const,
          owner: { id: "other", display_name: "Other", verified: true },
          member_count: 10,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "qa-member",
          name: "QA Member Only",
          description: "Member QA group",
          type: "qa" as const,
          visibility: "public" as const,
          my_role: "member" as const,
          owner: { id: "other2", display_name: "Other2", verified: false },
          member_count: 20,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "discussion-group",
          name: "Discussion",
          description: "A discussion group",
          type: "open_discussion" as const,
          visibility: "public" as const,
          my_role: "member" as const,
          owner: { id: "other3", display_name: "Other3", verified: false },
          member_count: 15,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 4 },
    };
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockGroups);

    // qa-owner: buffer returns data (buffer-first path)
    // qa-responder: buffer returns empty, API returns data (API fallback path)
    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockImplementation(
      (groupId: string) => {
        if (groupId === "qa-owner") {
          return [
            {
              id: "q-buf-1",
              group_id: "qa-owner",
              content: "Buffered question?",
              message_type: "question" as const,
              parent_message_id: null,
              sender: { id: "s-1", display_name: "Asker1", verified: false },
              created_at: "2026-01-01T00:00:00Z",
            },
          ];
        }
        return [];
      },
    );

    (deps.api.getMessages as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        {
          id: "q-api-1",
          group_id: "qa-responder",
          message_type: "question" as const,
          parent_message_id: null,
          sender: { id: "s-2", display_name: "Asker2", verified: false },
          created_at: "2026-01-01T00:00:01Z",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await getPendingQuestionsHandler({ limit: 10 }, deps);

    // Should only include qa-owner and qa-responder (not qa-member or discussion)
    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups).toHaveLength(2);
      expect(result.groups.map((g) => g.group_id).sort()).toEqual(["qa-owner", "qa-responder"]);

      // qa-owner came from buffer
      const ownerGroup = result.groups.find((g) => g.group_id === "qa-owner")!;
      expect(ownerGroup.group_name).toBe("QA Owned");
      expect(ownerGroup.questions).toHaveLength(1);

      // qa-responder came from API
      const responderGroup = result.groups.find((g) => g.group_id === "qa-responder")!;
      expect(responderGroup.group_name).toBe("QA Responding");
      expect(responderGroup.questions).toHaveLength(1);
    }

    // Should NOT have fetched API messages for qa-owner (buffer had data)
    expect(deps.api.getMessages).toHaveBeenCalledTimes(1);
    expect(deps.api.getMessages).toHaveBeenCalledWith("qa-responder", {
      unanswered: true,
      limit: 10,
    });
  });

  it("leave_group clears buffer even if channel.leave() throws", async () => {
    (deps.api.leaveGroup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const mockChannel = {
      join: vi.fn(),
      leave: vi.fn().mockRejectedValue(new Error("WebSocket disconnected")),
    };
    (deps.socket.channel as ReturnType<typeof vi.fn>).mockReturnValue(mockChannel);

    const result = await leaveGroupHandler({ group_id: "group-1" }, deps);

    expect(result.success).toBe(true);
    expect(deps.api.leaveGroup).toHaveBeenCalledWith("group-1");
    expect(mockChannel.leave).toHaveBeenCalled();
    // Buffer should be cleared despite channel.leave() throwing
    expect(deps.buffer.clearGroup).toHaveBeenCalledWith("group-1");
  });

  it("send_direct_message calls api.sendDirectMessage with recipient_account_id", async () => {
    const mockResult = {
      data: {
        id: "dm-1",
        content: "Hello there",
        sender: { id: "s-1", display_name: "Sender", verified: false },
        recipient: { id: "r-1", display_name: "Recipient" },
        created_at: "2026-01-01T00:00:00Z",
      },
    };
    (deps.api.sendDirectMessage as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const result = await sendDirectMessageHandler(
      { recipient_account_id: "r-1", content: "Hello there" },
      deps,
    );

    expect(result.message.id).toBe("dm-1");
    expect(result.message.content).toBe("Hello there");
    expect(deps.api.sendDirectMessage).toHaveBeenCalledWith({
      recipient_account_id: "r-1",
      content: "Hello there",
    });
  });

  it("get_direct_messages (buffer hit) returns from buffer with source 'buffer'", async () => {
    const bufferedDMs = [
      {
        id: "dm-1",
        content: "Buffered DM",
        sender: { id: "s-1", display_name: "Sender", verified: false },
        recipient: { id: "r-1", display_name: "Recipient" },
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    (deps.buffer.getDirectMessages as ReturnType<typeof vi.fn>).mockReturnValue(bufferedDMs);

    const result = await getDirectMessagesHandler({ limit: 50 }, deps);

    expect(result.source).toBe("buffer");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("dm-1");
    expect(deps.api.getDirectMessages).not.toHaveBeenCalled();
  });
});
