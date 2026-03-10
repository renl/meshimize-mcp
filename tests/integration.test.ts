import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { MeshimizeAPI } from "../src/api/client.js";
import { PhoenixSocket } from "../src/ws/client.js";

// Only run when INTEGRATION=true — skipped in CI
const runIntegration = process.env.INTEGRATION === "true";
const describeIntegration = runIntegration ? describe : describe.skip;

describeIntegration("Integration Tests", () => {
  // Track sockets for cleanup
  const socketsToCleanup: PhoenixSocket[] = [];

  afterEach(() => {
    for (const socket of socketsToCleanup) {
      socket.disconnect();
    }
    socketsToCleanup.length = 0;
  });

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

  it("Full startup sequence — account + group channels joined", async () => {
    const config = loadConfig();
    const api = new MeshimizeAPI(config);

    // Verify account
    const { data: account } = await api.getAccount();
    expect(account.id).toBeDefined();

    // Connect WebSocket
    const wsUrl = `${config.wsUrl}?token=${encodeURIComponent(config.apiKey)}&vsn=2.0.0`;
    const socket = new PhoenixSocket(wsUrl, {
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      reconnectIntervalMs: config.reconnectIntervalMs,
      maxReconnectAttempts: config.maxReconnectAttempts,
    });
    socketsToCleanup.push(socket);

    await socket.connect();
    expect(socket.getState()).toBe("connected");

    // Join account channel
    const accountChannel = socket.channel(`account:${account.id}`);
    await accountChannel.join();
    expect(accountChannel.getState()).toBe("joined");

    // Get group memberships
    const groups = await api.getMyGroups({ limit: 100 });
    expect(Array.isArray(groups.data)).toBe(true);

    // Join a sample of group channels (limit to avoid timeout with many groups)
    const sampleGroups = groups.data.slice(0, 3);
    for (const group of sampleGroups) {
      const ch = socket.channel(`group:${group.id}`);
      await ch.join();
      expect(ch.getState()).toBe("joined");
    }

    // Clean up
    socket.disconnect();
    expect(socket.getState()).toBe("disconnected");
  }, 30000);
});
