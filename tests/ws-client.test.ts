import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PhoenixMessage, PhoenixReplyPayload } from "../src/types/channels.js";

// Mock the ws module before any imports that use it
vi.mock("ws", () => {
  return {
    default: vi.fn(),
  };
});

// Import after mock setup
import WebSocket from "ws";
import { PhoenixSocket } from "../src/ws/client.js";

type EventHandler = (...args: unknown[]) => void;

/** Creates a mock WebSocket instance with controllable events and message capture. */
function createMockWS() {
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: string[] = [];

  const mockWS = {
    readyState: 1, // WebSocket.OPEN
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    send(data: string) {
      sentMessages.push(data);
    },
    close() {
      const closeHandlers = handlers.get("close") ?? [];
      for (const h of closeHandlers) h();
    },
    // Test helpers
    _emit(event: string, ...args: unknown[]) {
      const list = handlers.get(event) ?? [];
      for (const h of list) h(...args);
    },
    _getSentMessages(): PhoenixMessage[] {
      return sentMessages.map((s) => JSON.parse(s) as PhoenixMessage);
    },
    _getSentRaw(): string[] {
      return sentMessages;
    },
  };

  return mockWS;
}

describe("PhoenixSocket", () => {
  let mockWS: ReturnType<typeof createMockWS>;
  const MockWebSocket = WebSocket as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockWS = createMockWS();
    MockWebSocket.mockImplementation(() => mockWS);
    // Set OPEN constant on mock constructor
    (MockWebSocket as unknown as Record<string, number>).OPEN = 1;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("connects to URL with token and vsn params", async () => {
    const url = "wss://api.meshimize.com/api/v1/ws?token=mshz_key_123&vsn=2.0.0";
    const socket = new PhoenixSocket(url, {
      logger: () => {},
    });

    const connectPromise = socket.connect();

    // Simulate WebSocket open
    mockWS._emit("open");
    await connectPromise;

    expect(MockWebSocket).toHaveBeenCalledWith(url);
    expect(socket.getState()).toBe("connected");
  });

  it("sends heartbeat at configured interval", async () => {
    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 5000,
      logger: () => {},
    });

    const connectPromise = socket.connect();
    mockWS._emit("open");
    await connectPromise;

    // Advance time by one heartbeat interval
    vi.advanceTimersByTime(5000);

    const sent = mockWS._getSentMessages();
    expect(sent.length).toBe(1);

    const [joinRef, ref, topic, event, payload] = sent[0];
    expect(joinRef).toBeNull();
    expect(ref).toBe("1");
    expect(topic).toBe("phoenix");
    expect(event).toBe("heartbeat");
    expect(payload).toEqual({});
  });

  it("joins channel — sends phx_join, resolves on ok reply", async () => {
    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 60000,
      logger: () => {},
    });

    const connectPromise = socket.connect();
    mockWS._emit("open");
    await connectPromise;

    const ch = socket.channel("group:abc123");
    const joinPromise = ch.join();

    // Verify phx_join was sent
    const sent = mockWS._getSentMessages();
    expect(sent.length).toBe(1);
    const [joinRef, ref, topic, event] = sent[0];
    expect(topic).toBe("group:abc123");
    expect(event).toBe("phx_join");
    expect(joinRef).toBe("1"); // join_ref
    expect(ref).toBe("2"); // message ref

    // Simulate ok reply
    const reply: PhoenixMessage = [
      "1",
      "2",
      "group:abc123",
      "phx_reply",
      { status: "ok", response: { welcome: true } } as PhoenixReplyPayload,
    ];
    mockWS._emit("message", JSON.stringify(reply));

    const result = await joinPromise;
    expect(result).toEqual({ welcome: true });
    expect(ch.getState()).toBe("joined");
  });

  it("joins channel — rejects on error reply", async () => {
    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 60000,
      logger: () => {},
    });

    const connectPromise = socket.connect();
    mockWS._emit("open");
    await connectPromise;

    const ch = socket.channel("group:private-group");
    const joinPromise = ch.join();

    // Simulate error reply
    const reply: PhoenixMessage = [
      "1",
      "2",
      "group:private-group",
      "phx_reply",
      { status: "error", response: { reason: "not_a_member" } } as PhoenixReplyPayload,
    ];
    mockWS._emit("message", JSON.stringify(reply));

    await expect(joinPromise).rejects.toThrow();
    expect(ch.getState()).toBe("errored");
  });

  it("leaves channel — sends phx_leave", async () => {
    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 60000,
      logger: () => {},
    });

    const connectPromise = socket.connect();
    mockWS._emit("open");
    await connectPromise;

    const ch = socket.channel("group:abc123");
    const joinPromise = ch.join();

    // Simulate join ok
    const joinReply: PhoenixMessage = [
      "1",
      "2",
      "group:abc123",
      "phx_reply",
      { status: "ok", response: {} } as PhoenixReplyPayload,
    ];
    mockWS._emit("message", JSON.stringify(joinReply));
    await joinPromise;

    const leavePromise = ch.leave();

    // Verify phx_leave was sent
    const sent = mockWS._getSentMessages();
    const leaveMsg = sent[sent.length - 1];
    expect(leaveMsg[3]).toBe("phx_leave");
    expect(leaveMsg[2]).toBe("group:abc123");

    // Simulate leave ok
    const leaveReply: PhoenixMessage = [
      leaveMsg[0],
      leaveMsg[1],
      "group:abc123",
      "phx_reply",
      { status: "ok", response: {} } as PhoenixReplyPayload,
    ];
    mockWS._emit("message", JSON.stringify(leaveReply));
    await leavePromise;

    expect(ch.getState()).toBe("closed");
  });

  it("dispatches server push events to registered handlers", async () => {
    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 60000,
      logger: () => {},
    });

    const connectPromise = socket.connect();
    mockWS._emit("open");
    await connectPromise;

    const ch = socket.channel("group:abc123");
    const joinPromise = ch.join();

    // Simulate join ok
    const joinReply: PhoenixMessage = [
      "1",
      "2",
      "group:abc123",
      "phx_reply",
      { status: "ok", response: {} } as PhoenixReplyPayload,
    ];
    mockWS._emit("message", JSON.stringify(joinReply));
    await joinPromise;

    // Register event handler
    const receivedPayloads: unknown[] = [];
    ch.on("new_message", (payload: unknown) => {
      receivedPayloads.push(payload);
    });

    // Simulate server push (ref is null for server pushes)
    const push: PhoenixMessage = [
      "1",
      null,
      "group:abc123",
      "new_message",
      { id: "msg-1", content: "Hello!" },
    ];
    mockWS._emit("message", JSON.stringify(push));

    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toEqual({ id: "msg-1", content: "Hello!" });
  });

  it("increments ref counter monotonically", async () => {
    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 60000,
      logger: () => {},
    });

    const connectPromise = socket.connect();
    mockWS._emit("open");
    await connectPromise;

    // Create and join multiple channels to generate refs
    const ch1 = socket.channel("group:a");
    const ch2 = socket.channel("group:b");

    ch1.join(); // generates refs "1" (joinRef) and "2" (ref)
    ch2.join(); // generates refs "3" (joinRef) and "4" (ref)

    const sent = mockWS._getSentMessages();
    expect(sent[0][0]).toBe("1"); // ch1 joinRef
    expect(sent[0][1]).toBe("2"); // ch1 ref
    expect(sent[1][0]).toBe("3"); // ch2 joinRef
    expect(sent[1][1]).toBe("4"); // ch2 ref
  });

  it("reconnects on unexpected connection close", async () => {
    let connectCount = 0;

    MockWebSocket.mockImplementation(() => {
      connectCount++;
      mockWS = createMockWS();
      return mockWS;
    });

    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 60000,
      reconnectIntervalMs: 1000,
      maxReconnectAttempts: 3,
      logger: () => {},
    });

    // First connection
    const connectPromise = socket.connect();
    mockWS._emit("open");
    await connectPromise;

    expect(connectCount).toBe(1);

    // Simulate unexpected close
    mockWS._emit("close");

    expect(socket.getState()).toBe("reconnecting");

    // Advance past reconnect delay (1000ms * attempt 1 = 1000ms)
    await vi.advanceTimersByTimeAsync(1500);

    // The second connection should have been attempted
    expect(connectCount).toBe(2);

    // Simulate second connection open
    mockWS._emit("open");

    // Allow microtasks to settle
    await vi.advanceTimersByTimeAsync(0);

    expect(socket.getState()).toBe("connected");
  });

  it("rejoins all channels after reconnect", async () => {
    let currentMockWS = createMockWS();

    MockWebSocket.mockImplementation(() => {
      currentMockWS = createMockWS();
      return currentMockWS;
    });

    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 60000,
      reconnectIntervalMs: 1000,
      maxReconnectAttempts: 5,
      logger: () => {},
    });

    // First connection
    const connectPromise = socket.connect();
    mockWS = currentMockWS;
    mockWS._emit("open");
    await connectPromise;

    // Join a channel
    const ch = socket.channel("group:abc123");
    const joinPromise = ch.join();

    const joinReply: PhoenixMessage = [
      "1",
      "2",
      "group:abc123",
      "phx_reply",
      { status: "ok", response: {} } as PhoenixReplyPayload,
    ];
    mockWS._emit("message", JSON.stringify(joinReply));
    await joinPromise;

    expect(ch.getState()).toBe("joined");

    // Simulate unexpected close
    mockWS._emit("close");

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(1500);

    // Get the new mock WS and simulate open
    mockWS = currentMockWS;
    mockWS._emit("open");

    // Allow reconnect re-join logic to execute
    await vi.advanceTimersByTimeAsync(100);

    // Verify phx_join was sent on the new connection for the existing channel
    const sent = mockWS._getSentMessages();
    const joinMessages = sent.filter((m) => m[3] === "phx_join");
    expect(joinMessages.length).toBeGreaterThanOrEqual(1);
    expect(joinMessages[0][2]).toBe("group:abc123");
  });

  it("stops reconnecting after max attempts", async () => {
    let connectCount = 0;
    const logMessages: string[] = [];

    MockWebSocket.mockImplementation(() => {
      connectCount++;
      const ws = createMockWS();
      // Simulate immediate connection failure: emit error then close synchronously
      // after a microtask so the event handlers are registered first
      Promise.resolve().then(() => {
        ws._emit("error", new Error("Connection refused"));
        ws._emit("close");
      });
      return ws;
    });

    const socket = new PhoenixSocket("wss://example.com/ws?token=key&vsn=2.0.0", {
      heartbeatIntervalMs: 60000,
      reconnectIntervalMs: 100,
      maxReconnectAttempts: 2,
      logger: (_level, msg) => {
        logMessages.push(msg);
      },
    });

    // First connection attempt — will fail
    await socket.connect().catch(() => {
      // Expected to fail
    });

    expect(connectCount).toBe(1);

    // Reconnect attempt 1: delay = 100 * 1 = 100ms
    await vi.advanceTimersByTimeAsync(150);
    // Allow microtasks from the failed connect() inside the reconnect timer to settle
    await vi.advanceTimersByTimeAsync(0);

    expect(connectCount).toBe(2);

    // Reconnect attempt 2: delay = 100 * 2 = 200ms
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(0);

    expect(connectCount).toBe(3);

    // Allow final attemptReconnect to see max reached
    await vi.advanceTimersByTimeAsync(500);

    // After 2 failed reconnect attempts, it should have stopped
    expect(logMessages.some((m) => m.includes("Max reconnect attempts"))).toBe(true);
    expect(socket.getState()).toBe("disconnected");
  });
});
