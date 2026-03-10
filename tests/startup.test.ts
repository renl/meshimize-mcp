import { describe, it, expect, vi, beforeEach } from "vitest";
import { startOrchestration } from "../src/startup.js";
import type { StartupDeps } from "../src/startup.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

interface MockChannel {
  join: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  /** Fire all handlers registered for the given event. */
  trigger: (event: string, payload: unknown) => void;
  /** Direct access to the handler map (test helper). */
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
    /** Get a channel that was already created (test helper). */
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
        display_name: "Test Agent",
        description: null,
        allow_direct_connections: true,
        verified: true,
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
    clearGroup: vi.fn(),
  };
}

/** Minimal GroupResponse factory. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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

  // 1. Authenticates and connects WebSocket
  it("authenticates and connects WebSocket", async () => {
    const result = await startOrchestration(deps);

    expect(api.getAccount).toHaveBeenCalledOnce();
    expect(socket.connect).toHaveBeenCalledOnce();
    expect(socket.channel).toHaveBeenCalledWith("account:acc-1");

    const accountCh = socket._getChannel("account:acc-1");
    expect(accountCh?.join).toHaveBeenCalledOnce();

    expect(result.accountId).toBe("acc-1");
    expect(result.displayName).toBe("Test Agent");
  });

  // 2. Paginates through all group memberships
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

    // All 3 groups should be joined
    expect(socket._getChannel("group:g-1")?.join).toHaveBeenCalledOnce();
    expect(socket._getChannel("group:g-2")?.join).toHaveBeenCalledOnce();
    expect(socket._getChannel("group:g-3")?.join).toHaveBeenCalledOnce();
  });

  // 3. Joins all initial group channels with handlers
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

  // 4. Deduplicates group joins
  it("deduplicates group joins (setupGroupChannel called twice)", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    await startOrchestration(deps);

    const ch1 = socket._getChannel("group:g-1")!;
    expect(ch1.join).toHaveBeenCalledOnce();

    // Trigger group_joined for the same group
    const accountCh = socket._getChannel("account:acc-1")!;
    accountCh.trigger("group_joined", { group_id: "g-1", role: "member" });

    // Wait for the async handler to settle
    await vi.waitFor(() => {
      // join should still only have been called once — dedup guard prevents re-join
      expect(ch1.join).toHaveBeenCalledOnce();
    });
  });

  // 5. Cleans up handler on join failure
  it("cleans up handler on join failure", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-fail")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const failChannel = createMockChannel();
    failChannel.join.mockRejectedValue(new Error("join rejected"));
    socket._channels.set("group:g-fail", failChannel);

    await expect(startOrchestration(deps)).rejects.toThrow("join rejected");

    // Handler should have been cleaned up
    expect(failChannel.off).toHaveBeenCalledWith("new_message", expect.any(Function));
    // The handler passed to off should be the same one passed to on
    const onHandler = failChannel.on.mock.calls.find((c: unknown[]) => c[0] === "new_message")?.[1];
    const offHandler = failChannel.off.mock.calls.find(
      (c: unknown[]) => c[0] === "new_message",
    )?.[1];
    expect(onHandler).toBe(offHandler);
  });

  // 6. group_joined event triggers channel setup
  it("group_joined event triggers channel setup", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await startOrchestration(deps);

    // Trigger group_joined for a new group
    const accountCh = socket._getChannel("account:acc-1")!;
    accountCh.trigger("group_joined", { group_id: "g-new", role: "member" });

    // Wait for the async handler to settle
    await vi.waitFor(() => {
      const newCh = socket._getChannel("group:g-new");
      expect(newCh?.join).toHaveBeenCalledOnce();
      expect(newCh?.on).toHaveBeenCalledWith("new_message", expect.any(Function));
    });
  });

  // 7. group_left event leaves channel and clears buffer
  it("group_left event leaves channel and clears buffer", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await startOrchestration(deps);
    expect(result.joinedGroups.has("g-1")).toBe(true);

    const groupCh = socket._getChannel("group:g-1")!;

    // Trigger group_left
    const accountCh = socket._getChannel("account:acc-1")!;
    accountCh.trigger("group_left", { group_id: "g-1" });

    await vi.waitFor(() => {
      expect(groupCh.off).toHaveBeenCalledWith("new_message", expect.any(Function));
      expect(groupCh.leave).toHaveBeenCalledOnce();
      expect(buffer.clearGroup).toHaveBeenCalledWith("g-1");
      expect(result.joinedGroups.has("g-1")).toBe(false);
    });
  });

  // 8. group_left for unknown group is ignored
  it("group_left for unknown group is ignored", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await startOrchestration(deps);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Trigger group_left for a group that was never joined
    const accountCh = socket._getChannel("account:acc-1")!;
    accountCh.trigger("group_left", { group_id: "g-unknown" });

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("group_left for unknown group:g-unknown"),
      );
    });

    // No channel leave should have been called
    const unknownCh = socket._getChannel("group:g-unknown");
    expect(unknownCh).toBeUndefined();
    expect(buffer.clearGroup).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  // 9. new_message handler buffers group messages
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

    // Trigger the new_message handler
    groupCh.trigger("new_message", fakeMessage);

    expect(buffer.addGroupMessage).toHaveBeenCalledWith("g-1", fakeMessage);
  });

  // 10. new_direct_message handler buffers direct messages
  it("new_direct_message handler buffers direct messages", async () => {
    await startOrchestration(deps);

    const accountCh = socket._getChannel("account:acc-1")!;

    const fakeDM = {
      id: "dm-1",
      content: "Hi there",
      sender: { id: "s-1", display_name: "Sender", verified: true },
      recipient: { id: "acc-1", display_name: "Test Agent" },
      created_at: "2026-01-01T00:00:00Z",
    };

    accountCh.trigger("new_direct_message", fakeDM);

    expect(buffer.addDirectMessage).toHaveBeenCalledWith(fakeDM);
  });

  // 11. group_left clears buffer AFTER leave (order matters)
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

    const accountCh = socket._getChannel("account:acc-1")!;
    accountCh.trigger("group_left", { group_id: "g-1" });

    await vi.waitFor(() => {
      expect(callOrder).toEqual(["leave", "clearGroup"]);
    });
  });

  // 12. group_left tolerates leave() throwing
  it("group_left tolerates leave() throwing", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1")],
      meta: { has_more: false, next_cursor: null, count: 1 },
    });

    const result = await startOrchestration(deps);

    const groupCh = socket._getChannel("group:g-1")!;
    groupCh.leave.mockRejectedValue(new Error("leave failed"));

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const accountCh = socket._getChannel("account:acc-1")!;
    accountCh.trigger("group_left", { group_id: "g-1" });

    await vi.waitFor(() => {
      // Buffer should still be cleared even though leave() threw
      expect(buffer.clearGroup).toHaveBeenCalledWith("g-1");
      expect(result.joinedGroups.has("g-1")).toBe(false);
    });

    consoleErrorSpy.mockRestore();
  });

  // 13. group_joined failure is caught and logged (no unhandled rejection)
  it("group_joined failure is caught and logged", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [],
      meta: { has_more: false, next_cursor: null, count: 0 },
    });

    await startOrchestration(deps);

    // Pre-create a channel that will fail to join
    const failChannel = createMockChannel();
    failChannel.join.mockRejectedValue(new Error("server error"));
    socket._channels.set("group:g-fail", failChannel);

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const accountCh = socket._getChannel("account:acc-1")!;
    accountCh.trigger("group_joined", { group_id: "g-fail", role: "member" });

    await vi.waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to join group:g-fail"),
      );
    });

    consoleErrorSpy.mockRestore();
  });

  // 14. Returns correct startup result
  it("returns correct startup result shape", async () => {
    api.getMyGroups.mockResolvedValue({
      data: [makeGroup("g-1"), makeGroup("g-2")],
      meta: { has_more: false, next_cursor: null, count: 2 },
    });

    const result = await startOrchestration(deps);

    expect(result).toEqual(
      expect.objectContaining({
        accountId: "acc-1",
        displayName: "Test Agent",
      }),
    );
    expect(result.joinedGroups).toBeInstanceOf(Set);
    expect(result.joinedGroups.size).toBe(2);
    expect(result.joinedGroups.has("g-1")).toBe(true);
    expect(result.joinedGroups.has("g-2")).toBe(true);
  });
});
