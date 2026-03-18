import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDependencies } from "../src/tools/index.js";
import {
  approveJoinHandler,
  joinGroupHandler,
  leaveGroupHandler,
  listMyGroupsHandler,
  listPendingJoinsHandler,
  rejectJoinHandler,
  searchGroupsHandler,
} from "../src/tools/groups.js";
import {
  askQuestionHandler,
  getMessagesHandler,
  getPendingQuestionsHandler,
  postMessageHandler,
} from "../src/tools/messages.js";
import {
  getDirectMessagesHandler,
  sendDirectMessageHandler,
} from "../src/tools/direct-messages.js";
import type { MeshimizeAPI } from "../src/api/client.js";
import type { MessageBuffer } from "../src/buffer/message-buffer.js";
import type { Config } from "../src/config.js";
import { createAuthorityLookupMap } from "../src/state/authority-lookups.js";
import { createMembershipPathMap } from "../src/state/membership-paths.js";
import { createPendingJoinMap } from "../src/state/pending-joins.js";
import type { PhoenixSocket } from "../src/ws/client.js";

function createTestConfig(): Config {
  return {
    apiKey: "test-key",
    baseUrl: "https://test.meshimize.com",
    wsUrl: "wss://test.meshimize.com/api/v1/ws/websocket",
    bufferSize: 1000,
    heartbeatIntervalMs: 30000,
    reconnectIntervalMs: 5000,
    maxReconnectAttempts: 10,
    joinTimeoutMs: 600000,
    maxPendingJoins: 50,
  };
}

function createRecorder() {
  return {
    record: vi.fn(),
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
    authorityLookups: createAuthorityLookupMap(),
    membershipPaths: createMembershipPathMap(),
    workflowRecorder: createRecorder(),
  };
}

const mockGroup = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Test Group",
  description: "A test group",
  type: "qa" as const,
  visibility: "public" as const,
  my_role: null,
  owner: {
    id: "22222222-2222-2222-2222-222222222222",
    display_name: "Owner",
    verified: true,
  },
  member_count: 42,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("tool handlers", () => {
  let deps: ToolDependencies;

  beforeEach(() => {
    deps = createMockDeps();
  });

  afterEach(() => {
    deps.pendingJoins.dispose();
    deps.authorityLookups.dispose();
  });

  it("search_groups enriches discovery results with membership state and records lookup start", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockGroup],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ ...mockGroup, my_role: "member" }],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await searchGroupsHandler({ query: " Test ", type: "qa", limit: 50 }, deps);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      id: mockGroup.id,
      is_member: true,
      my_role: "member",
    });
    expect(deps.api.searchGroups).toHaveBeenCalledWith({ q: "test", type: "qa", limit: 50 });
    expect(deps.api.getMyGroups).toHaveBeenCalledWith({ limit: 100 });
    expect(deps.workflowRecorder.record).toHaveBeenCalledWith("authority_lookup_started", {
      query_text: "test",
      type_filter: "qa",
    });
  });

  it("search_groups omits q when the normalized query is empty", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockGroup],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await searchGroupsHandler({ query: "   ", type: "qa", limit: 25 }, deps);

    expect(deps.api.searchGroups).toHaveBeenCalledWith({ q: undefined, type: "qa", limit: 25 });
    expect(deps.workflowRecorder.record).toHaveBeenCalledWith("authority_lookup_started", {
      query_text: "",
      type_filter: "qa",
    });
  });

  it("search_groups suppresses exact repeated no-result lookups within the session", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    const first = await searchGroupsHandler({ query: "Unknown", type: "qa", limit: 10 }, deps);
    const second = await searchGroupsHandler({ query: " unknown ", type: "qa", limit: 10 }, deps);

    expect(first.groups).toEqual([]);
    expect(second).toMatchObject({
      groups: [],
      suppressed_repeat_lookup: true,
    });
    expect(deps.api.searchGroups).toHaveBeenCalledTimes(1);
    expect(deps.workflowRecorder.record).toHaveBeenCalledWith("authority_lookup_zero_results", {
      query_text: "unknown",
      type_filter: "qa",
    });
    expect(deps.workflowRecorder.record).toHaveBeenCalledWith(
      "authority_lookup_repeat_suppressed",
      expect.objectContaining({ query_text: "unknown", type_filter: "qa" }),
    );
  });

  it("search_groups does not suppress repeated lookups when candidates were previously returned", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockGroup],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await searchGroupsHandler({ query: "meshimize", type: "qa", limit: 10 }, deps);
    await searchGroupsHandler({ query: "meshimize", type: "qa", limit: 10 }, deps);

    expect(deps.api.searchGroups).toHaveBeenCalledTimes(2);
  });

  it("join_group creates only pending local state and emits authority_join_pending", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockGroup],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    const result = await joinGroupHandler({ group_id: mockGroup.id }, deps);

    expect(result.status).toBe("pending_operator_approval");
    expect(deps.api.joinGroup).not.toHaveBeenCalled();
    expect(deps.pendingJoins.getByGroupId(mockGroup.id)).toBeDefined();
    expect(deps.workflowRecorder.record).toHaveBeenCalledWith("authority_join_pending", {
      group_id: mockGroup.id,
      group_name: mockGroup.name,
      group_type: mockGroup.type,
    });
  });

  it("approve_join returns canonical result and marks the next ask as post_approval_first_ask", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockGroup],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });
    await joinGroupHandler({ group_id: mockGroup.id }, deps);

    (deps.api.joinGroup as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        group_id: mockGroup.id,
        account_id: "33333333-3333-3333-3333-333333333333",
        role: "member",
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    const result = await approveJoinHandler({ group_id: mockGroup.id }, deps);

    expect(result).toEqual({
      group_id: mockGroup.id,
      joined: true,
      membership_path_ready: "post_approval_first_ask",
      role: "member",
    });
    expect(deps.pendingJoins.getByGroupId(mockGroup.id)).toBeUndefined();
    expect(deps.membershipPaths.resolve(mockGroup.id)).toBe("post_approval_first_ask");
    expect(deps.workflowRecorder.record).toHaveBeenCalledWith("authority_join_approved", {
      group_id: mockGroup.id,
      role: "member",
    });
  });

  it("reject_join clears pending state and does not create post-approval state", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockGroup],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });
    await joinGroupHandler({ group_id: mockGroup.id }, deps);

    const result = await rejectJoinHandler({ group_id: mockGroup.id }, deps);

    expect(result.status).toBe("rejected");
    expect(deps.pendingJoins.getByGroupId(mockGroup.id)).toBeUndefined();
    expect(deps.membershipPaths.resolve(mockGroup.id)).toBe("existing_membership");
  });

  it("list_pending_joins returns canonical pending entries", async () => {
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [mockGroup],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });
    await joinGroupHandler({ group_id: mockGroup.id }, deps);

    const result = await listPendingJoinsHandler({}, deps);

    expect(result.count).toBe(1);
    expect(result.pending_requests[0]).toMatchObject({
      group_id: mockGroup.id,
      group_name: mockGroup.name,
      group_type: mockGroup.type,
      owner_name: mockGroup.owner.display_name,
      owner_verified: true,
    });
  });

  it("leave_group clears the message buffer and membership-path state", async () => {
    (deps.api.leaveGroup as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const channel = { leave: vi.fn().mockResolvedValue(undefined) };
    (deps.socket.channel as ReturnType<typeof vi.fn>).mockReturnValue(channel);
    deps.membershipPaths.markPostApprovalFirstAsk(mockGroup.id);

    const result = await leaveGroupHandler({ group_id: mockGroup.id }, deps);

    expect(result).toEqual({ success: true });
    expect(deps.buffer.clearGroup).toHaveBeenCalledWith(mockGroup.id);
    expect(deps.membershipPaths.resolve(mockGroup.id)).toBe("existing_membership");
  });

  it("list_my_groups returns the current memberships", async () => {
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ ...mockGroup, my_role: "member" }],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await listMyGroupsHandler({}, deps);

    expect(result.groups).toEqual([
      {
        id: mockGroup.id,
        name: mockGroup.name,
        description: mockGroup.description,
        type: mockGroup.type,
        my_role: "member",
        member_count: mockGroup.member_count,
      },
    ]);
  });

  it("get_messages reads from the local buffer before the API", async () => {
    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "44444444-4444-4444-4444-444444444444",
        group_id: mockGroup.id,
        content: "Hello world",
        message_type: "post",
        parent_message_id: null,
        sender: { id: "a", display_name: "Sender", verified: false },
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);

    const result = await getMessagesHandler({ group_id: mockGroup.id, limit: 50 }, deps);

    expect(result.source).toBe("buffer");
    expect(deps.api.getMessages).not.toHaveBeenCalled();
  });

  it("post_message sends flat params", async () => {
    (deps.api.postMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: "55555555-5555-5555-5555-555555555555",
        group_id: mockGroup.id,
        content: "Test content",
        message_type: "post",
        parent_message_id: null,
        sender: { id: "a", display_name: "Sender", verified: false },
        created_at: "2026-01-01T00:00:00Z",
      },
    });

    await postMessageHandler(
      { group_id: mockGroup.id, content: "Test content", message_type: "post" },
      deps,
    );

    expect(deps.api.postMessage).toHaveBeenCalledWith(mockGroup.id, {
      content: "Test content",
      message_type: "post",
      parent_message_id: null,
    });
  });

  it("ask_question rejects non-member access before posting", async () => {
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await expect(
      askQuestionHandler({ group_id: mockGroup.id, question: "What is X?" }, deps),
    ).rejects.toThrow("First resolve access");
    expect(deps.api.postMessage).not.toHaveBeenCalled();
  });

  it("ask_question rejects non-qa groups", async () => {
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [{ ...mockGroup, type: "open_discussion" }],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    await expect(
      askQuestionHandler({ group_id: mockGroup.id, question: "What is X?" }, deps),
    ).rejects.toThrow("only valid for Q&A groups");
  });

  it("ask_question returns canonical success with existing_membership provenance", async () => {
    vi.useFakeTimers();
    try {
      (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{ ...mockGroup, my_role: "member" }],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });
      (deps.api.postMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: "66666666-6666-6666-6666-666666666666",
          group_id: mockGroup.id,
          content: "What is X?",
          message_type: "question",
          parent_message_id: null,
          sender: { id: "asker", display_name: "Asker", verified: false },
          created_at: "2026-01-01T00:00:00Z",
        },
      });

      let pollCount = 0;
      (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockImplementation(() => {
        pollCount += 1;
        if (pollCount >= 2) {
          return [
            {
              id: "77777777-7777-7777-7777-777777777777",
              group_id: mockGroup.id,
              content: "Answer is Y",
              message_type: "answer",
              parent_message_id: "66666666-6666-6666-6666-666666666666",
              sender: { id: "responder", display_name: "Responder", verified: true },
              created_at: "2026-01-01T00:00:01Z",
            },
          ];
        }
        return [];
      });

      const promise = askQuestionHandler(
        { group_id: mockGroup.id, question: "What is X?", timeout_seconds: 30 },
        deps,
      );
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;

      expect(result).toMatchObject({
        answered: true,
        question_id: "66666666-6666-6666-6666-666666666666",
        group_id: mockGroup.id,
        timeout_seconds: 30,
        provenance: {
          authority_source: "meshimize",
          invocation_path: "authority_group_live_work",
          membership_path: "existing_membership",
          group_id: mockGroup.id,
          group_name: mockGroup.name,
          provider_account_id: mockGroup.owner.id,
          provider_display_name: mockGroup.owner.display_name,
          provider_verified: true,
        },
        answer: {
          id: "77777777-7777-7777-7777-777777777777",
          content: "Answer is Y",
          responder_account_id: "responder",
          responder_display_name: "Responder",
          responder_verified: true,
          created_at: "2026-01-01T00:00:01Z",
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ask_question uses post_approval_first_ask once, emits metric, then consumes that state", async () => {
    vi.useFakeTimers();
    try {
      deps.membershipPaths.markPostApprovalFirstAsk(mockGroup.id);
      (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{ ...mockGroup, my_role: "member" }],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });
      (deps.api.postMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: "88888888-8888-8888-8888-888888888888",
          group_id: mockGroup.id,
          content: "First ask after approval?",
          message_type: "question",
          parent_message_id: null,
          sender: { id: "asker", display_name: "Asker", verified: false },
          created_at: "2026-01-01T00:00:00Z",
        },
      });
      (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          id: "99999999-9999-9999-9999-999999999999",
          group_id: mockGroup.id,
          content: "Approved answer",
          message_type: "answer",
          parent_message_id: "88888888-8888-8888-8888-888888888888",
          sender: { id: "responder", display_name: "Responder", verified: true },
          created_at: "2026-01-01T00:00:01Z",
        },
      ]);

      const result = await askQuestionHandler(
        { group_id: mockGroup.id, question: "First ask after approval?", timeout_seconds: 5 },
        deps,
      );

      expect(result.answered).toBe(true);
      if (result.answered) {
        expect(result.provenance.membership_path).toBe("post_approval_first_ask");
      }
      expect(deps.membershipPaths.resolve(mockGroup.id)).toBe("existing_membership");
      expect(deps.workflowRecorder.record).toHaveBeenCalledWith(
        "authority_first_ask_after_approval",
        {
          group_id: mockGroup.id,
          group_name: mockGroup.name,
        },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ask_question returns canonical recoverable timeout metadata and emits timeout metric", async () => {
    vi.useFakeTimers();
    try {
      (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [{ ...mockGroup, my_role: "member" }],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });
      (deps.api.postMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: {
          id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          group_id: mockGroup.id,
          content: "Slow question?",
          message_type: "question",
          parent_message_id: null,
          sender: { id: "asker", display_name: "Asker", verified: false },
          created_at: "2026-01-01T00:00:00Z",
        },
      });
      (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockReturnValue([]);

      const promise = askQuestionHandler(
        { group_id: mockGroup.id, question: "Slow question?", timeout_seconds: 5 },
        deps,
      );
      await vi.advanceTimersByTimeAsync(6000);
      const result = await promise;

      expect(result.answered).toBe(false);
      if (!result.answered) {
        expect(result).toMatchObject({
          question_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          group_id: mockGroup.id,
          timeout_seconds: 5,
          provenance: {
            authority_source: "meshimize",
            invocation_path: "authority_group_live_work",
            membership_path: "existing_membership",
          },
          recovery: {
            retrieval_tool: "get_messages",
            group_id: mockGroup.id,
            after_message_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            match_parent_message_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          },
        });
        expect(result.recovery.instructions).toContain("get_messages");
      }
      expect(deps.workflowRecorder.record).toHaveBeenCalledWith("authority_ask_timed_out", {
        group_id: mockGroup.id,
        question_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        membership_path: "existing_membership",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("get_pending_questions filters to QA owner/responder groups", async () => {
    (deps.api.getMyGroups as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: [
        { ...mockGroup, id: "qa-owner", name: "QA Owned", my_role: "owner" },
        { ...mockGroup, id: "qa-responder", name: "QA Responding", my_role: "responder" },
        { ...mockGroup, id: "qa-member", name: "QA Member", my_role: "member" },
        {
          ...mockGroup,
          id: "discussion",
          name: "Discussion",
          type: "open_discussion",
          my_role: "member",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 4 },
    });
    (deps.buffer.getGroupMessages as ReturnType<typeof vi.fn>).mockImplementation(
      (groupId: string) => {
        if (groupId === "qa-owner") {
          return [
            {
              id: "question-1",
              group_id: "qa-owner",
              content: "Buffered question?",
              message_type: "question",
              parent_message_id: null,
              sender: { id: "sender", display_name: "Sender", verified: false },
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
          id: "question-2",
          group_id: "qa-responder",
          message_type: "question",
          parent_message_id: null,
          sender: { id: "sender", display_name: "Sender", verified: false },
          created_at: "2026-01-01T00:00:01Z",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await getPendingQuestionsHandler({ limit: 10 }, deps);

    expect("groups" in result).toBe(true);
    if ("groups" in result) {
      expect(result.groups.map((group) => group.group_id).sort()).toEqual([
        "qa-owner",
        "qa-responder",
      ]);
    }
  });

  it("send_direct_message and get_direct_messages preserve existing behavior", async () => {
    (deps.api.sendDirectMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: {
        id: "dm-1",
        content: "Hello there",
        sender: { id: "sender", display_name: "Sender", verified: false },
        recipient: { id: "recipient", display_name: "Recipient" },
        created_at: "2026-01-01T00:00:00Z",
      },
    });
    (deps.buffer.getDirectMessages as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "dm-1",
        content: "Buffered DM",
        sender: { id: "sender", display_name: "Sender", verified: false },
        recipient: { id: "recipient", display_name: "Recipient" },
        created_at: "2026-01-01T00:00:00Z",
      },
    ]);

    const sendResult = await sendDirectMessageHandler(
      { recipient_account_id: "recipient", content: "Hello there" },
      deps,
    );
    const readResult = await getDirectMessagesHandler({ limit: 50 }, deps);

    expect(sendResult.message.content).toBe("Hello there");
    expect(readResult.source).toBe("buffer");
  });
});
