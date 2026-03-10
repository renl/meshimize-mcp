import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDependencies } from "../src/tools/index.js";
import {
  searchGroupsHandler,
  joinGroupHandler,
  leaveGroupHandler,
  listMyGroupsHandler,
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
  };
}

describe("tool handlers", () => {
  let deps: ToolDependencies;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("search_groups calls api.searchGroups and returns formatted results", async () => {
    const mockResult = {
      data: [
        {
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
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 1 },
    };
    (deps.api.searchGroups as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const result = await searchGroupsHandler({ query: "test", limit: 50 }, deps);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe("group-1");
    expect(result.groups[0].name).toBe("Test Group");
    expect(result.groups[0].owner).toBe("Owner");
    expect(result.groups[0].owner_verified).toBe(true);
    expect(result.groups[0].member_count).toBe(42);
    expect(result.has_more).toBe(false);
    expect(deps.api.searchGroups).toHaveBeenCalledWith({
      q: "test",
      type: undefined,
      limit: 50,
    });
  });

  it("join_group calls api.joinGroup + socket.channel().join(), returns confirmation", async () => {
    const mockJoinResult = {
      data: {
        group_id: "group-1",
        account_id: "account-1",
        role: "member" as const,
        created_at: "2026-01-01T00:00:00Z",
      },
    };
    (deps.api.joinGroup as ReturnType<typeof vi.fn>).mockResolvedValue(mockJoinResult);

    const mockChannel = { join: vi.fn().mockResolvedValue({}), leave: vi.fn() };
    (deps.socket.channel as ReturnType<typeof vi.fn>).mockReturnValue(mockChannel);

    const result = await joinGroupHandler({ group_id: "group-1" }, deps);

    expect(result.success).toBe(true);
    expect(result.role).toBe("member");
    expect(result.group_id).toBe("group-1");
    expect(deps.api.joinGroup).toHaveBeenCalledWith("group-1");
    expect(deps.socket.channel).toHaveBeenCalledWith("group:group-1");
    expect(mockChannel.join).toHaveBeenCalled();
  });

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
