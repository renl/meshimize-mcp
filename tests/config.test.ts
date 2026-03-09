import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all MESHIMIZE_ env vars before each test
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MESHIMIZE_")) {
        delete process.env[key];
      }
    }
  });

  afterEach(() => {
    // Restore original environment
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MESHIMIZE_")) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  it("should load valid config from env vars", () => {
    process.env.MESHIMIZE_API_KEY = "mshz_test_key_123";
    process.env.MESHIMIZE_BASE_URL = "https://custom.meshimize.com";

    const config = loadConfig();

    expect(config.apiKey).toBe("mshz_test_key_123");
    expect(config.baseUrl).toBe("https://custom.meshimize.com");
  });

  it("should throw when MESHIMIZE_API_KEY is missing or empty", () => {
    // Missing entirely
    expect(() => loadConfig()).toThrow();

    // Empty string
    process.env.MESHIMIZE_API_KEY = "";
    expect(() => loadConfig()).toThrow();
  });

  it("should apply defaults for optional fields", () => {
    process.env.MESHIMIZE_API_KEY = "mshz_test_key_123";

    const config = loadConfig();

    expect(config.baseUrl).toBe("https://api.meshimize.com");
    expect(config.bufferSize).toBe(1000);
    expect(config.heartbeatIntervalMs).toBe(30000);
    expect(config.reconnectIntervalMs).toBe(5000);
    expect(config.maxReconnectAttempts).toBe(10);
  });

  it("should derive wsUrl from baseUrl when https produces wss", () => {
    process.env.MESHIMIZE_API_KEY = "mshz_test_key_123";
    process.env.MESHIMIZE_BASE_URL = "https://api.meshimize.com";

    const config = loadConfig();

    expect(config.wsUrl).toBe("wss://api.meshimize.com/api/v1/ws");
  });

  it("should derive wsUrl from baseUrl when http produces ws", () => {
    process.env.MESHIMIZE_API_KEY = "mshz_test_key_123";
    process.env.MESHIMIZE_BASE_URL = "http://localhost:4000";

    const config = loadConfig();

    expect(config.wsUrl).toBe("ws://localhost:4000/api/v1/ws");
  });
});
