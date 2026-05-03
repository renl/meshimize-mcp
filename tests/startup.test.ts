import { describe, it, expect, vi, beforeEach } from "vitest";
import { startOrchestration } from "../src/startup.js";
import type { StartupDeps } from "../src/startup.js";

interface MockChannel {
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  trigger: (event: string, payload: unknown) => void;
  _handlers: Map<string, Array<(payload: unknown) => void>>;
}

function createMockChannel(): MockChannel {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  return {
    join: vi.fn().mockResolvedValue({}),
    leave: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    off: vi.fn((event: string, handler: (payload: unknown) => void) => {
      const list = handlers.get(event);
      if (list) {
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
      }
    }),
    getState: vi.fn().mockReturnValue("joined"),
    trigger(event: string, payload: unknown) {
      const list = handlers.get(event) ?? [];
      for (const h of list) h(payload);
    },
    _handlers: handlers,
  };
}

function createMockSocket() {
  const channels = new Map<string, MockChannel>();
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    channel: vi.fn((topic: string): MockChannel => {
      let ch = channels.get(topic);
      if (!ch) {
        ch = createMockChannel();
        channels.set(topic, ch);
      }
      return ch;
    }),
    _getChannel(topic: string): MockChannel | undefined {
      return channels.get(topic);
    },
    _channels: channels,
  };
}

function createMockApi() {
  return {
    getAccount: vi.fn().mockResolvedValue({
      data: {
        id: "acc-1",
        email: "test@example.com",
        display_name: "Operator Account",
        description: null,
        verified: true,
        current_identity: {
          id: "ident-1",
          display_name: "Test Agent",
          is_default: true,
        },
        inserted_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    }),
    getMyGroups: vi.fn().mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    }),
  };
}

function createMockBuffer() {
  return {
    addGroupMessage: vi.fn(),
    addDirectMessage: vi.fn(),
    clearAll: vi.fn(),
    clearGroup: vi.fn(),
  };
}

function makeGroup(id: string) {
  return {
    id,
    name: `Group ${id}`,
    description: null,
    type: "qa" as const,
    visibility: "public" as const,
    my_role: "member" as const,
    owner: { id: "owner-1", display_name: "Owner", verified: true },
    member_count: 2,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("startOrchestration", () => {
  let api: ReturnType<typeof createMockApi>;
  let socket: ReturnType<typeof createMockSocket>;
  let buffer: ReturnType<typeof createMockBuffer>;
  let deps: StartupDeps;

  beforeEach(() => {
    api = createMockApi();
    socket = createMockSocket();
    buffer = createMockBuffer();
    deps = { api, socket, buffer };
  });

  it("authenticates and connects WebSocket", async () => {
    const result = await startOrchestration(deps);

    expect(api.getAccount).toHaveBeenCalledOnce();
    expect(buffer.clearAll).toHaveBeenCalledOnce();
    expect(socket.connect).toHaveBeenCalledOnce();
    expect(socket.channel).toHaveBeenCalledWith("identity:ident-1");

    const identityCh = socket._getChannel("identity:ident-1");
    expect(identityCh?.join).toHaveBeenCalledOnce();

    expect(result.currentIdentityId).toBe("ident-1");
    expect(result.actingIdentityDisplayName).toBe("Test Agent");
    expect(result.actingIdentityIsDefault).toBe(true);
    expect(result.accountDisplayName).toBe("Operator Account");
  });

  it("fails startup when current_identity is missing", async () => {
    api.getAccount.mockResolvedValue({
      data: {
        id: "acc-1",
        email: "test@example.com",
        display_name: "Operator Account",
        description: null,
        verified: true,
        current_identity: null,
        inserted_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    });

    await expect(startOrchestration(deps)).rejects.toThrow("invalid current_identity");
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it("fails startup when current_identity is malformed", async () => {
    api.getAccount.mockResolvedValue({
      data: {
        id: "acc-1",
        email: "test@example.com",
        display_name: "Operator Account",
        description: null,
        verified: true,
        current_identity: {
          id: "ident-1",
          display_name: "Test Agent",
        },
        inserted_at: "2026-01-01T00:00:00Z",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    });

    await expect(startOrchestration(deps)).rejects.toThrow("invalid current_identity");
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it("fails startup when acting identity topic join fails", async () => {
    const identityChannel = createMockChannel();
    identityChannel.join.mockRejectedValue(
      new Error('Channel join failed for topic "identity:ident-1"'),
    );
    socket._channels.set("identity:ident-1", identityChannel);

    await expect(startOrchestration(deps)).rejects.toThrow(
      'Failed to join acting identity topic identity:ident-1: Channel join failed for topic "identity:ident-1"',
    );
  });

  it("tolerates initial group join not_a_member mismatch and continues startup", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-ok"), makeGroup("g-skip")],
      meta: { has_more: false, next_cursor: null, count: 2 },
    });

    const unauthorizedChannel = createMockChannel();
    unauthorizedChannel.join.mockRejectedValue(
      new Error(
        'Channel join failed for topic "group:g-skip" | status="error" | reason="not_a_member"',
      ),
    );
    socket._channels.set("group:g-skip", unauthorizedChannel);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await startOrchestration(deps);

    const identityCh = socket._getChannel("identity:ident-1");
    const authorizedChannel = socket._getChannel("group:g-ok");

    expect(identityCh?.join).toHaveBeenCalledOnce();
    expect(authorizedChannel?.join).toHaveBeenCalledOnce();
    expect(unauthorizedChannel.join).toHaveBeenCalledOnce();
    expect(result.joinedGroups.has("g-ok")).toBe(true);
    expect(result.joinedGroups.has("g-skip")).toBe(false);
    expect(unauthorizedChannel.off).toHaveBeenCalledWith("new_message", expect.any(Function));

    const onHandler = unauthorizedChannel.on.mock.calls.find(
      (c: unknown[]) => c[0] === "new_message",
    )?.[1];
    const offHandler = unauthorizedChannel.off.mock.calls.find(
      (c: unknown[]) => c[0] === "new_message",
    )?.[1];
    expect(onHandler).toBe(offHandler);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Startup membership mismatch: getMyGroups returned group:g-skip"),
    );

    consoleErrorSpy.mockRestore();
  });

  it("paginates through all group memberships", async () => {
    api.getMyGroups
      .mockResolvedValueOnce({
        data: [makeGroup("g-1"), makeGroup("g-2")],
        meta: { has_more: true, next_cursor: "cursor-1", count: 2 },
      })
      .mockResolvedValueOnce({
        data: [makeGroup("g-3")],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

    await startOrchestration(deps);

    expect(api.getMyGroups).toHaveBeenCalledTimes(2);
    expect(api.getMyGroups).toHaveBeenNthCalledWith(1, { limit: 100, after: undefined });
    expect(api.getMyGroups).toHaveBeenNthCalledWith(2, { limit: 100, after: "cursor-1" });
    expect(socket._getChannel("group:g-1")?.join).toHaveBeenCalledOnce();
    expect(socket._getChannel("group:g-2")?.join).toHaveBeenCalledOnce();
    expect(socket._getChannel("group:g-3")?.join).toHaveBeenCalledOnce();
  });

  it("joins all initial group channels with handlers", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1"), makeGroup("g-2")],
      meta: { has_more: false, next_cursor: null, count: 2 },
    });

    const result = await startOrchestration(deps);

    const ch1 = socket._getChannel("group:g-1");
    const ch2 = socket._getChannel("group:g-2");

    expect(ch1?.on).toHaveBeenCalledWith("new_message", expect.any(Function));
    expect(ch1?.join).toHaveBeenCalledOnce();
    expect(ch2?.on).toHaveBeenCalledWith("new_message", expect.any(Function));
    expect(ch2?.join).toHaveBeenCalledOnce();
    expect(result.joinedGroups.has("g-1")).toBe(true);
    expect(result.joinedGroups.has("g-2")).toBe(true);
  });

  it("deduplicates group joins (setupGroupChannel called twice)", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    await startOrchestration(deps);

    const ch1 = socket._getChannel("group:g-1")!;
    expect(ch1.join).toHaveBeenCalledOnce();

    const identityCh = socket._getChannel("identity:ident-1")!;
    identityCh.trigger("group_joined", { group_id: "g-1", role: "member" });

    await vi.waitFor(() => {
      expect(ch1.join).toHaveBeenCalledOnce();
    });
  });

  it("cleans up handler on join failure", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-fail")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const failChannel = createMockChannel();
    failChannel.join.mockRejectedValue(new Error("join rejected"));
    socket._channels.set("group:g-fail", failChannel);

    await expect(startOrchestration(deps)).rejects.toThrow("join rejected");

    expect(failChannel.off).toHaveBeenCalledWith("new_message", expect.any(Function));
    const onHandler = failChannel.on.mock.calls.find((c: unknown[]) => c[0] === "new_message")?.[1];
    const offHandler = failChannel.off.mock.calls.find(
      (c: unknown[]) => c[0] === "new_message",
    )?.[1];
    expect(onHandler).toBe(offHandler);
  });

  it("still rejects initial group join failures for reasons other than not_a_member", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-fail")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const failChannel = createMockChannel();
    failChannel.join.mockRejectedValue(
      new Error(
        'Channel join failed for topic "group:g-fail" | status="error" | reason="server_error"',
      ),
    );
    socket._channels.set("group:g-fail", failChannel);

    await expect(startOrchestration(deps)).rejects.toThrow('reason="server_error"');

    expect(failChannel.off).toHaveBeenCalledWith("new_message", expect.any(Function));
  });

  it("group_joined event triggers channel setup", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await startOrchestration(deps);

    const identityCh = socket._getChannel("identity:ident-1")!;
    identityCh.trigger("group_joined", { group_id: "g-new", role: "member" });

    await vi.waitFor(() => {
      const newCh = socket._getChannel("group:g-new");
      expect(newCh?.join).toHaveBeenCalledOnce();
      expect(newCh?.on).toHaveBeenCalledWith("new_message", expect.any(Function));
    });
  });

  it("group_left event leaves channel and clears buffer", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await startOrchestration(deps);
    expect(result.joinedGroups.has("g-1")).toBe(true);

    const groupCh = socket._getChannel("group:g-1")!;
    const identityCh = socket._getChannel("identity:ident-1")!;
    identityCh.trigger("group_left", { group_id: "g-1" });

    await vi.waitFor(() => {
      expect(groupCh.off).toHaveBeenCalledWith("new_message", expect.any(Function));
      expect(groupCh.leave).toHaveBeenCalledOnce();
      expect(buffer.clearGroup).toHaveBeenCalledWith("g-1");
      expect(result.joinedGroups.has("g-1")).toBe(false);
    });
  });

  it("group_left for unknown group is ignored", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await startOrchestration(deps);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const identityCh = socket._getChannel("identity:ident-1")!;
    identityCh.trigger("group_left", { group_id: "g-unknown" });

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("group_left for unknown group:g-unknown"),
      );
    });

    const unknownCh = socket._getChannel("group:g-unknown");
    expect(unknownCh).toBeUndefined();
    expect(buffer.clearGroup).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("new_message handler buffers group messages", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    await startOrchestration(deps);

    const groupCh = socket._getChannel("group:g-1")!;
    const fakeMessage = {
      id: "msg-1",
      group_id: "g-1",
      content: "Hello",
      message_type: "post",
      parent_message_id: null,
      sender: { id: "s-1", display_name: "Sender", verified: true },
      created_at: "2026-01-01T00:00:00Z",
    };

    groupCh.trigger("new_message", fakeMessage);
    expect(buffer.addGroupMessage).toHaveBeenCalledWith("g-1", fakeMessage);
  });

  it("new_direct_message handler buffers direct messages", async () => {
    await startOrchestration(deps);

    const identityCh = socket._getChannel("identity:ident-1")!;
    const fakeDM = {
      id: "dm-1",
      content: "Hi there",
      sender: { id: "s-1", display_name: "Sender", verified: true },
      recipient: { id: "ident-1", display_name: "Test Agent" },
      created_at: "2026-01-01T00:00:00Z",
    };

    identityCh.trigger("new_direct_message", fakeDM);
    expect(buffer.addDirectMessage).toHaveBeenCalledWith(fakeDM);
  });

  it("group_left clears buffer after leave completes", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    await startOrchestration(deps);

    const groupCh = socket._getChannel("group:g-1")!;
    const callOrder: string[] = [];

    groupCh.leave.mockImplementation(async () => {
      callOrder.push("leave");
    });
    buffer.clearGroup.mockImplementation(() => {
      callOrder.push("clearGroup");
    });

    const identityCh = socket._getChannel("identity:ident-1")!;
    identityCh.trigger("group_left", { group_id: "g-1" });

    await vi.waitFor(() => {
      expect(callOrder).toEqual(["leave", "clearGroup"]);
    });
  });

  it("group_left tolerates leave() throwing", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await startOrchestration(deps);
    const groupCh = socket._getChannel("group:g-1")!;
    groupCh.leave.mockRejectedValue(new Error("leave failed"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const identityCh = socket._getChannel("identity:ident-1")!;
    identityCh.trigger("group_left", { group_id: "g-1" });

    await vi.waitFor(() => {
      expect(buffer.clearGroup).toHaveBeenCalledWith("g-1");
      expect(result.joinedGroups.has("g-1")).toBe(false);
    });

    consoleErrorSpy.mockRestore();
  });

  it("group_joined failure is caught and logged", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await startOrchestration(deps);

    const failChannel = createMockChannel();
    failChannel.join.mockRejectedValue(new Error("server error"));
    socket._channels.set("group:g-fail", failChannel);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const identityCh = socket._getChannel("identity:ident-1")!;
    identityCh.trigger("group_joined", { group_id: "g-fail", role: "member" });

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to join group:g-fail"),
      );
    });

    consoleErrorSpy.mockRestore();
  });

  it("returns correct startup result shape", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1"), makeGroup("g-2")],
      meta: { has_more: false, next_cursor: null, count: 2 },
    });

    const result = await startOrchestration(deps);

    expect(result).toEqual(
      expect.objectContaining({
        currentIdentityId: "ident-1",
        actingIdentityDisplayName: "Test Agent",
        actingIdentityIsDefault: true,
        accountDisplayName: "Operator Account",
      }),
    );
    expect(result.joinedGroups).toBeInstanceOf(Set);
    expect(result.joinedGroups.size).toBe(2);
    expect(result.joinedGroups.has("g-1")).toBe(true);
    expect(result.joinedGroups.has("g-2")).toBe(true);
  });
});
