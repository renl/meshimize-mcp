import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPendingJoinMap } from "../../src/state/pending-joins.js";
import type { PendingJoinMap } from "../../src/state/pending-joins.js";
import type { PendingJoinRequest } from "../../src/types/pending-joins.js";
import type { Config } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: "test-key",
    baseUrl: "https://api.meshimize.com",
    wsUrl: "wss://api.meshimize.com/api/v1/ws/websocket",
    bufferSize: 1000,
    heartbeatIntervalMs: 30000,
    reconnectIntervalMs: 5000,
    maxReconnectAttempts: 10,
    joinTimeoutMs: 600000,
    maxPendingJoins: 50,
    ...overrides,
  };
}

function makeGroup(id: string = "group-1"): PendingJoinRequest["group"] {
  return {
    id,
    name: `Test Group ${id}`,
    description: "A test group",
    type: "open_discussion",
    visibility: "public",
    owner: {
      id: "owner-1",
      display_name: "Test Owner",
      verified: true,
    },
    member_count: 5,
  };
}

describe("PendingJoinMap", () => {
  let map: PendingJoinMap;

  afterEach(() => {
    map?.dispose();
  });

  describe("add() + getByGroupId()", () => {
    it("stores and retrieves a pending request", () => {
      map = createPendingJoinMap(makeConfig());
      const group = makeGroup("g-1");

      const request = map.add(group);

      expect(request.id).toBeDefined();
      expect(request.group).toEqual(group);
      expect(request.status).toBe("pending");
      expect(request.created_at).toBeDefined();
      expect(request.expires_at).toBeDefined();

      const retrieved = map.getByGroupId("g-1");
      expect(retrieved).toEqual(request);
    });
  });

  describe("add() + getById()", () => {
    it("retrieves by locally-generated UUID", () => {
      map = createPendingJoinMap(makeConfig());
      const group = makeGroup("g-2");

      const request = map.add(group);
      const retrieved = map.getById(request.id);

      expect(retrieved).toEqual(request);
    });
  });

  describe("capacity limit", () => {
    it("rejects the 51st entry when maxPendingJoins is 50", () => {
      map = createPendingJoinMap(makeConfig({ maxPendingJoins: 50 }));

      for (let i = 0; i < 50; i++) {
        map.add(makeGroup(`group-${i}`));
      }

      expect(() => map.add(makeGroup("group-50"))).toThrow(/maximum/);
      expect(() => map.add(makeGroup("group-50"))).toThrow(/pending/);
    });
  });

  describe("TTL expiry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      map?.dispose();
      vi.useRealTimers();
    });

    it("request expires after timeout", () => {
      map = createPendingJoinMap(makeConfig({ joinTimeoutMs: 1000 }));
      map.add(makeGroup("g-ttl"));

      vi.advanceTimersByTime(1001);

      expect(map.getByGroupId("g-ttl")).toBeUndefined();
    });
  });

  describe("lazy prune on getByGroupId() access", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      map?.dispose();
      vi.useRealTimers();
    });

    it("cleans up expired entries on access", () => {
      map = createPendingJoinMap(makeConfig({ joinTimeoutMs: 1000 }));
      map.add(makeGroup("g-lazy"));

      vi.advanceTimersByTime(1001);

      expect(map.getByGroupId("g-lazy")).toBeUndefined();
      expect(map.listPending()).toHaveLength(0);
    });
  });

  describe("interval prune", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      map?.dispose();
      vi.useRealTimers();
    });

    it("expired entries cleaned by timer", () => {
      map = createPendingJoinMap(makeConfig({ joinTimeoutMs: 1000 }));
      map.add(makeGroup("g-interval"));

      // Advance past expiry and past the 60s prune interval
      vi.advanceTimersByTime(61000);

      expect(map.listPending()).toHaveLength(0);
    });
  });

  describe("idempotent add", () => {
    it("same group.id returns existing entry", () => {
      map = createPendingJoinMap(makeConfig());

      const first = map.add(makeGroup("g-1"));
      const second = map.add(makeGroup("g-1"));

      expect(second.id).toBe(first.id);
      expect(second.created_at).toBe(first.created_at);
      expect(map.listPending()).toHaveLength(1);
    });
  });

  describe("add() prunes expired before capacity check", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      map?.dispose();
      vi.useRealTimers();
    });

    it("succeeds when at capacity but expired entries can be freed", () => {
      map = createPendingJoinMap(makeConfig({ maxPendingJoins: 3, joinTimeoutMs: 1000 }));

      map.add(makeGroup("g-exp-1"));
      map.add(makeGroup("g-exp-2"));
      map.add(makeGroup("g-exp-3"));

      // All 3 slots filled; advance past expiry
      vi.advanceTimersByTime(1001);

      // Without prune-before-capacity-check, this would throw
      const request = map.add(makeGroup("g-new"));
      expect(request.group.id).toBe("g-new");
      expect(request.status).toBe("pending");
    });

    it("creates fresh entry when expired entry exists for same group_id", () => {
      map = createPendingJoinMap(makeConfig({ joinTimeoutMs: 1000 }));

      const original = map.add(makeGroup("g-stale"));
      const originalId = original.id;

      // Advance past expiry
      vi.advanceTimersByTime(1001);

      // Without prune-before-idempotency-check, this could return stale entry
      const fresh = map.add(makeGroup("g-stale"));
      expect(fresh.id).not.toBe(originalId);
      expect(fresh.status).toBe("pending");
      expect(new Date(fresh.expires_at).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("remove()", () => {
    it("removes entry by groupId", () => {
      map = createPendingJoinMap(makeConfig());
      map.add(makeGroup("g-rm"));

      map.remove("g-rm");

      expect(map.getByGroupId("g-rm")).toBeUndefined();
    });
  });

  describe("listPending() filters out expired", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      map?.dispose();
      vi.useRealTimers();
    });

    it("returns only non-expired entries", () => {
      // Group with short TTL
      const shortMap = createPendingJoinMap(makeConfig({ joinTimeoutMs: 2000 }));
      map = shortMap;

      shortMap.add(makeGroup("g-short"));

      // Now create entries with a longer effective expiry by adding them later
      // Actually, we need entries that expire at different times.
      // All entries share the same config timeout, so we add g-short first,
      // then advance time partially, then add two more that haven't expired yet.
      vi.advanceTimersByTime(1000);
      shortMap.add(makeGroup("g-long-1"));
      shortMap.add(makeGroup("g-long-2"));

      // Advance so g-short expires (2000ms total from its creation) but not the others
      vi.advanceTimersByTime(1001);

      const pending = shortMap.listPending();
      expect(pending).toHaveLength(2);
      expect(pending.map((p) => p.group.id).sort()).toEqual(["g-long-1", "g-long-2"]);
    });
  });

  describe("config defaults", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MESHIMIZE_")) {
          delete process.env[key];
        }
      }
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MESHIMIZE_")) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, originalEnv);
    });

    it("joinTimeoutMs defaults to 600000 and maxPendingJoins defaults to 50", () => {
      process.env.MESHIMIZE_API_KEY = "mshz_test_key";

      const config = loadConfig();

      expect(config.joinTimeoutMs).toBe(600000);
      expect(config.maxPendingJoins).toBe(50);
    });
  });

  describe("config custom env vars", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MESHIMIZE_")) {
          delete process.env[key];
        }
      }
    });

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("MESHIMIZE_")) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, originalEnv);
    });

    it("reads joinTimeoutMs and maxPendingJoins from env", () => {
      process.env.MESHIMIZE_API_KEY = "mshz_test_key";
      process.env.MESHIMIZE_JOIN_TIMEOUT_MS = "5000";
      process.env.MESHIMIZE_MAX_PENDING_JOINS = "5";

      const config = loadConfig();

      expect(config.joinTimeoutMs).toBe(5000);
      expect(config.maxPendingJoins).toBe(5);
    });
  });

  describe("dispose()", () => {
    it("clears interval and Map", () => {
      map = createPendingJoinMap(makeConfig());
      map.add(makeGroup("g-d1"));
      map.add(makeGroup("g-d2"));

      map.dispose();

      expect(map.listPending()).toHaveLength(0);
    });
  });
});
