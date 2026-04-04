import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDependencies } from "../src/tools/index.js";
import {
  createDelegationHandler,
  listDelegationsHandler,
  getDelegationHandler,
  acceptDelegationHandler,
  completeDelegationHandler,
  cancelDelegationHandler,
  acknowledgeDelegationHandler,
  extendDelegationHandler,
} from "../src/tools/delegations.js";
import type { MeshimizeAPI } from "../src/api/client.js";
import type { MessageBuffer } from "../src/buffer/message-buffer.js";
import { DelegationContentBuffer } from "../src/buffer/delegation-content-buffer.js";
import type { Delegation } from "../src/types/delegations.js";
import type { Config } from "../src/config.js";
import { createAuthorityLookupMap } from "../src/state/authority-lookups.js";
import { createAuthoritySessionContextStore } from "../src/state/authority-session-context.js";
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

function makeDelegation(overrides: Partial<Delegation> = {}): Delegation {
  return {
    id: overrides.id ?? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    state: overrides.state ?? "pending",
    group_id: overrides.group_id ?? "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    group_name: overrides.group_name ?? "Test Group",
    sender_account_id: overrides.sender_account_id ?? "cccccccc-cccc-cccc-cccc-cccccccccccc",
    sender_display_name: overrides.sender_display_name ?? "Sender Agent",
    target_account_id: overrides.target_account_id ?? null,
    target_display_name: overrides.target_display_name ?? null,
    assignee_account_id: overrides.assignee_account_id ?? null,
    assignee_display_name: overrides.assignee_display_name ?? null,
    description: overrides.description ?? null,
    result: overrides.result ?? null,
    original_ttl_seconds: overrides.original_ttl_seconds ?? 86400,
    expires_at: overrides.expires_at ?? "2026-04-03T00:00:00Z",
    accepted_at: overrides.accepted_at ?? null,
    completed_at: overrides.completed_at ?? null,
    acknowledged_at: overrides.acknowledged_at ?? null,
    cancelled_at: overrides.cancelled_at ?? null,
    inserted_at: overrides.inserted_at ?? "2026-04-02T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-04-02T00:00:00Z",
  };
}

function createMockDeps(): ToolDependencies {
  const authoritySessionContext = createAuthoritySessionContextStore();

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
      createDelegation: vi.fn(),
      listDelegations: vi.fn(),
      getDelegation: vi.fn(),
      acceptDelegation: vi.fn(),
      completeDelegation: vi.fn(),
      cancelDelegation: vi.fn(),
      acknowledgeDelegation: vi.fn(),
      extendDelegation: vi.fn(),
    } as unknown as MeshimizeAPI,
    socket: {
      channel: vi.fn(),
    } as unknown as PhoenixSocket,
    buffer: {
      getGroupMessages: vi.fn(),
      getDirectMessages: vi.fn(),
      clearGroup: vi.fn(),
    } as unknown as MessageBuffer,
    delegationBuffer: new DelegationContentBuffer(),
    pendingJoins: createPendingJoinMap(createTestConfig(), {
      onExpired: (request) => authoritySessionContext.clearGroup(request.group_id),
      onRemoved: (request) => authoritySessionContext.clearGroup(request.group_id),
    }),
    authorityLookups: createAuthorityLookupMap(),
    membershipPaths: createMembershipPathMap(),
    authoritySessionContext,
    workflowRecorder: { record: vi.fn() },
  };
}

describe("delegation tool handlers", () => {
  let deps: ToolDependencies;

  beforeEach(() => {
    deps = createMockDeps();
  });

  // --- createDelegationHandler ---

  describe("createDelegationHandler", () => {
    it("calls API with correct body and stores description in buffer", async () => {
      const delegation = makeDelegation({ description: "Please handle this" });

      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await createDelegationHandler(
        {
          group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          description: "Please handle this",
        },
        deps,
      );

      expect(deps.api.createDelegation).toHaveBeenCalledWith({
        group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        description: "Please handle this",
      });
      expect(result.delegation).toEqual(delegation);
      // Verify buffer stored the description
      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toEqual({
        description: "Please handle this",
      });
    });

    it("passes optional target_account_id and ttl_seconds", async () => {
      const delegation = makeDelegation({
        target_account_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        target_display_name: "Target Agent",
        description: "Targeted task",
      });

      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      await createDelegationHandler(
        {
          group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          description: "Targeted task",
          target_account_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          ttl_seconds: 3600,
        },
        deps,
      );

      expect(deps.api.createDelegation).toHaveBeenCalledWith({
        group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        description: "Targeted task",
        target_account_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        ttl_seconds: 3600,
      });
    });

    it("does not include optional params when not provided", async () => {
      const delegation = makeDelegation({ description: "Task" });
      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      await createDelegationHandler(
        {
          group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          description: "Task",
        },
        deps,
      );

      const calledWith = (deps.api.createDelegation as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(calledWith).not.toHaveProperty("target_account_id");
      expect(calledWith).not.toHaveProperty("ttl_seconds");
    });

    it("does not buffer description when server returns null", async () => {
      const delegation = makeDelegation({ description: null });
      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      await createDelegationHandler(
        {
          group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          description: "Task",
        },
        deps,
      );

      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBeUndefined();
    });
  });

  // --- listDelegationsHandler ---

  describe("listDelegationsHandler", () => {
    it("calls API and returns delegations with meta", async () => {
      const d1 = makeDelegation({ id: "d-1" });
      const d2 = makeDelegation({ id: "d-2" });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1, d2],
        meta: { has_more: false, next_cursor: null, count: 2 },
      });

      const result = await listDelegationsHandler({}, deps);

      expect(deps.api.listDelegations).toHaveBeenCalledWith({
        group_id: undefined,
        state: undefined,
        role: undefined,
        limit: undefined,
        after: undefined,
      });
      expect(result.delegations).toHaveLength(2);
      expect(result.meta).toEqual({ has_more: false, next_cursor: null, count: 2 });
    });

    it("passes all filter params to API", async () => {
      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [],
        meta: { has_more: false, next_cursor: null, count: 0 },
      });

      await listDelegationsHandler(
        {
          group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          state: "pending",
          role: "sender",
          limit: 25,
          after: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        },
        deps,
      );

      expect(deps.api.listDelegations).toHaveBeenCalledWith({
        group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        state: "pending",
        role: "sender",
        limit: 25,
        after: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      });
    });

    it("passes acknowledged state to API", async () => {
      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [],
        meta: { has_more: false, next_cursor: null, count: 0 },
      });

      await listDelegationsHandler({ state: "acknowledged" }, deps);

      expect(deps.api.listDelegations).toHaveBeenCalledWith({
        group_id: undefined,
        state: "acknowledged",
        role: undefined,
        limit: undefined,
        after: undefined,
      });
    });

    it("uses server content and ignores buffer when server has values", async () => {
      const d1 = makeDelegation({
        id: "d-1",
        description: "Server description",
        result: "Server result",
      });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      // Pre-populate buffer with different content
      deps.delegationBuffer.storeDescription("d-1", "Buffer description");
      deps.delegationBuffer.storeResult("d-1", "Buffer result");

      const result = await listDelegationsHandler({}, deps);

      // Server content wins
      expect(result.delegations[0].description).toBe("Server description");
      expect(result.delegations[0].result).toBe("Server result");
    });

    it("uses buffer content as fallback when server returns null", async () => {
      const d1 = makeDelegation({
        id: "d-1",
        description: null,
        result: null,
      });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      // Pre-populate buffer with content for d-1
      deps.delegationBuffer.storeDescription("d-1", "Stored description");
      deps.delegationBuffer.storeResult("d-1", "Stored result");

      const result = await listDelegationsHandler({}, deps);

      // Buffer content used as fallback
      expect(result.delegations[0].description).toBe("Stored description");
      expect(result.delegations[0].result).toBe("Stored result");
    });

    it("returns null content when both server and buffer have nothing", async () => {
      const d1 = makeDelegation({
        id: "d-1",
        description: null,
        result: null,
      });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0].description).toBeNull();
      expect(result.delegations[0].result).toBeNull();
    });
  });

  // --- getDelegationHandler ---

  describe("getDelegationHandler", () => {
    it("calls API with delegation_id and returns result with server content", async () => {
      const delegation = makeDelegation({
        description: "Server desc",
        result: null,
      });

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(deps.api.getDelegation).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(result.delegation.description).toBe("Server desc");
    });

    it("uses buffer as fallback when server returns null", async () => {
      const delegation = makeDelegation({
        description: null,
        result: null,
      });

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      deps.delegationBuffer.storeDescription(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "Buffered desc",
      );

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(result.delegation.description).toBe("Buffered desc");
    });

    it("returns null content when both server and buffer have nothing", async () => {
      const delegation = makeDelegation({
        description: null,
        result: null,
      });

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(result.delegation.description).toBeNull();
      expect(result.delegation.result).toBeNull();
      expect(result.delegation.id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    });

    it("enriches with both description and result from buffer when server returns null", async () => {
      const delegation = makeDelegation({
        description: null,
        result: null,
      });

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      deps.delegationBuffer.storeDescription("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "The task");
      deps.delegationBuffer.storeResult("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "The result");

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(result.delegation.description).toBe("The task");
      expect(result.delegation.result).toBe("The result");
    });

    it("prefers server content over buffer content", async () => {
      const delegation = makeDelegation({
        description: "Server description",
        result: "Server result",
      });

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      deps.delegationBuffer.storeDescription(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "Buffer description",
      );
      deps.delegationBuffer.storeResult("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Buffer result");

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      // Server wins
      expect(result.delegation.description).toBe("Server description");
      expect(result.delegation.result).toBe("Server result");
    });
  });

  // --- acceptDelegationHandler ---

  describe("acceptDelegationHandler", () => {
    it("calls API and returns delegation", async () => {
      const delegation = makeDelegation({
        state: "accepted",
        assignee_account_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        assignee_display_name: "Assignee Agent",
        accepted_at: "2026-04-02T01:00:00Z",
      });

      (deps.api.acceptDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await acceptDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(deps.api.acceptDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      );
      expect(result.delegation).toEqual(delegation);
      expect(result.delegation.state).toBe("accepted");
    });
  });

  // --- completeDelegationHandler ---

  describe("completeDelegationHandler", () => {
    it("calls API with result body and stores result in buffer", async () => {
      const delegation = makeDelegation({
        state: "completed",
        completed_at: "2026-04-02T02:00:00Z",
        result: "Task is done",
      });

      (deps.api.completeDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await completeDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", result: "Task is done" },
        deps,
      );

      expect(deps.api.completeDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        { result: "Task is done" },
      );
      expect(result.delegation).toEqual(delegation);
      // Verify buffer stored the result
      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toMatchObject({
        result: "Task is done",
      });
    });

    it("does not buffer result when server returns null", async () => {
      const delegation = makeDelegation({
        state: "completed",
        completed_at: "2026-04-02T02:00:00Z",
        result: null,
      });

      (deps.api.completeDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      await completeDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", result: "Task is done" },
        deps,
      );

      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBeUndefined();
    });
  });

  // --- cancelDelegationHandler ---

  describe("cancelDelegationHandler", () => {
    it("calls API and returns delegation", async () => {
      const delegation = makeDelegation({
        state: "cancelled",
        cancelled_at: "2026-04-02T03:00:00Z",
      });

      (deps.api.cancelDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await cancelDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(deps.api.cancelDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      );
      expect(result.delegation).toEqual(delegation);
      expect(result.delegation.state).toBe("cancelled");
    });
  });

  // --- acknowledgeDelegationHandler ---

  describe("acknowledgeDelegationHandler", () => {
    it("calls API, evicts from buffer, and returns delegation", async () => {
      const delegation = makeDelegation({
        state: "acknowledged",
        acknowledged_at: "2026-04-02T04:00:00Z",
        description: null,
        result: null,
      });

      (deps.api.acknowledgeDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      // Pre-populate buffer
      deps.delegationBuffer.storeDescription(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "Old description",
      );
      deps.delegationBuffer.storeResult("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Old result");

      const result = await acknowledgeDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(deps.api.acknowledgeDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      );
      expect(result.delegation).toEqual(delegation);
      expect(result.delegation.state).toBe("acknowledged");
      expect(result.delegation.description).toBeNull();
      expect(result.delegation.result).toBeNull();
      // Buffer entry should be evicted
      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBeUndefined();
    });

    it("works when buffer has no entry for the delegation", async () => {
      const delegation = makeDelegation({
        state: "acknowledged",
        acknowledged_at: "2026-04-02T04:00:00Z",
        description: null,
        result: null,
      });

      (deps.api.acknowledgeDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await acknowledgeDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(result.delegation.state).toBe("acknowledged");
      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBeUndefined();
    });

    it("propagates API errors", async () => {
      (deps.api.acknowledgeDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Conflict"),
      );

      await expect(
        acknowledgeDelegationHandler(
          { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
          deps,
        ),
      ).rejects.toThrow("Conflict");
    });

    it("does not evict from buffer when API throws", async () => {
      (deps.api.acknowledgeDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Conflict"),
      );

      deps.delegationBuffer.storeDescription(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "Should survive",
      );

      await expect(
        acknowledgeDelegationHandler(
          { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
          deps,
        ),
      ).rejects.toThrow("Conflict");

      // Buffer should still have the entry
      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toEqual({
        description: "Should survive",
      });
    });
  });

  // --- extendDelegationHandler ---

  describe("extendDelegationHandler", () => {
    it("calls API with ttl_seconds when provided", async () => {
      const delegation = makeDelegation({
        expires_at: "2026-04-04T00:00:00Z",
      });

      (deps.api.extendDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await extendDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ttl_seconds: 3600 },
        deps,
      );

      expect(deps.api.extendDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        { ttl_seconds: 3600 },
      );
      expect(result.delegation).toEqual(delegation);
    });

    it("calls API without body when ttl_seconds is not provided (reset mode)", async () => {
      const delegation = makeDelegation({
        expires_at: "2026-04-04T00:00:00Z",
      });

      (deps.api.extendDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await extendDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(deps.api.extendDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        undefined,
      );
      expect(result.delegation).toEqual(delegation);
    });

    it("propagates API errors", async () => {
      (deps.api.extendDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Conflict"),
      );

      await expect(
        extendDelegationHandler(
          { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ttl_seconds: 3600 },
          deps,
        ),
      ).rejects.toThrow("Conflict");
    });

    it("propagates 422 errors for invalid TTL", async () => {
      (deps.api.extendDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ttl_seconds must be between 300 and 604800"),
      );

      await expect(
        extendDelegationHandler(
          { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", ttl_seconds: 100 },
          deps,
        ),
      ).rejects.toThrow("ttl_seconds must be between 300 and 604800");
    });
  });

  // --- Content enrichment edge cases ---

  describe("content enrichment (server primary, buffer fallback)", () => {
    it("server has content, buffer has nothing — use server", async () => {
      const d1 = makeDelegation({
        id: "d-1",
        description: "Server description",
        result: "Server result",
      });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0].description).toBe("Server description");
      expect(result.delegations[0].result).toBe("Server result");
    });

    it("server has null, buffer has content — use buffer (fallback)", async () => {
      const d1 = makeDelegation({
        id: "d-1",
        description: null,
        result: null,
      });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      deps.delegationBuffer.storeDescription("d-1", "Buffer description");
      deps.delegationBuffer.storeResult("d-1", "Buffer result");

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0].description).toBe("Buffer description");
      expect(result.delegations[0].result).toBe("Buffer result");
    });

    it("server has null, buffer has nothing — stay null", async () => {
      const d1 = makeDelegation({
        id: "d-1",
        description: null,
        result: null,
      });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0].description).toBeNull();
      expect(result.delegations[0].result).toBeNull();
    });

    it("server has content, buffer has different content — use server (server wins)", async () => {
      const d1 = makeDelegation({
        id: "d-1",
        description: "Server description",
        result: "Server result",
      });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      deps.delegationBuffer.storeDescription("d-1", "Different buffer description");
      deps.delegationBuffer.storeResult("d-1", "Different buffer result");

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0].description).toBe("Server description");
      expect(result.delegations[0].result).toBe("Server result");
    });

    it("list enriches only delegations with matching buffer entries", async () => {
      const d1 = makeDelegation({ id: "d-1", description: null, result: null });
      const d2 = makeDelegation({ id: "d-2", description: null, result: null });
      const d3 = makeDelegation({ id: "d-3", description: null, result: null });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1, d2, d3],
        meta: { has_more: false, next_cursor: null, count: 3 },
      });

      // Only d-2 has buffer content
      deps.delegationBuffer.storeDescription("d-2", "Only this one");

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0].description).toBeNull();
      expect(result.delegations[1].description).toBe("Only this one");
      expect(result.delegations[2].description).toBeNull();
    });

    it("mixed: server has description but null result, buffer has result — use both sources", async () => {
      const d1 = makeDelegation({
        id: "d-1",
        description: "Server description",
        result: null,
      });

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: d1,
      });

      deps.delegationBuffer.storeResult("d-1", "Buffer result");

      const result = await getDelegationHandler({ delegation_id: "d-1" }, deps);

      expect(result.delegation.description).toBe("Server description");
      expect(result.delegation.result).toBe("Buffer result");
    });

    it("create followed by complete — buffer has both description and result", async () => {
      // Simulate create
      const createDelegation = makeDelegation({
        state: "pending",
        description: "Do something",
      });
      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: createDelegation,
      });

      await createDelegationHandler(
        {
          group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          description: "Do something",
        },
        deps,
      );

      // Simulate complete
      const completeDelegation = makeDelegation({
        state: "completed",
        result: "All done",
      });
      (deps.api.completeDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: completeDelegation,
      });

      await completeDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", result: "All done" },
        deps,
      );

      // Buffer should have both
      const content = deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(content).toEqual({ description: "Do something", result: "All done" });

      // Now get with server returning null should return enriched
      const getDelegationResponse = makeDelegation({
        state: "completed",
        description: null,
        result: null,
      });
      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: getDelegationResponse,
      });

      const getResult = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(getResult.delegation.description).toBe("Do something");
      expect(getResult.delegation.result).toBe("All done");
    });
  });

  // --- 20-field response shape ---

  describe("20-field response shape", () => {
    it("delegation has all 20 fields", async () => {
      const delegation = makeDelegation({
        state: "completed",
        description: "A task",
        result: "Done",
        original_ttl_seconds: 3600,
        acknowledged_at: null,
        accepted_at: "2026-04-02T01:00:00Z",
        completed_at: "2026-04-02T02:00:00Z",
      });

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      const d = result.delegation;
      expect(d).toHaveProperty("id");
      expect(d).toHaveProperty("state");
      expect(d).toHaveProperty("group_id");
      expect(d).toHaveProperty("group_name");
      expect(d).toHaveProperty("sender_account_id");
      expect(d).toHaveProperty("sender_display_name");
      expect(d).toHaveProperty("target_account_id");
      expect(d).toHaveProperty("target_display_name");
      expect(d).toHaveProperty("assignee_account_id");
      expect(d).toHaveProperty("assignee_display_name");
      expect(d).toHaveProperty("description");
      expect(d).toHaveProperty("result");
      expect(d).toHaveProperty("original_ttl_seconds");
      expect(d).toHaveProperty("expires_at");
      expect(d).toHaveProperty("accepted_at");
      expect(d).toHaveProperty("completed_at");
      expect(d).toHaveProperty("acknowledged_at");
      expect(d).toHaveProperty("cancelled_at");
      expect(d).toHaveProperty("inserted_at");
      expect(d).toHaveProperty("updated_at");
    });

    it("acknowledged delegation has acknowledged_at set and content purged", async () => {
      const delegation = makeDelegation({
        state: "acknowledged",
        acknowledged_at: "2026-04-02T04:00:00Z",
        description: null,
        result: null,
      });

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: delegation,
      });

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(result.delegation.state).toBe("acknowledged");
      expect(result.delegation.acknowledged_at).toBe("2026-04-02T04:00:00Z");
      expect(result.delegation.description).toBeNull();
      expect(result.delegation.result).toBeNull();
    });
  });

  // --- Error propagation ---

  describe("error propagation", () => {
    it("createDelegationHandler propagates API errors", async () => {
      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Forbidden"),
      );

      await expect(
        createDelegationHandler(
          {
            group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            description: "Task",
          },
          deps,
        ),
      ).rejects.toThrow("Forbidden");
    });

    it("listDelegationsHandler propagates API errors", async () => {
      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Unauthorized"),
      );

      await expect(listDelegationsHandler({}, deps)).rejects.toThrow("Unauthorized");
    });

    it("getDelegationHandler propagates API errors", async () => {
      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Not Found"),
      );

      await expect(
        getDelegationHandler({ delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, deps),
      ).rejects.toThrow("Not Found");
    });

    it("acceptDelegationHandler propagates API errors", async () => {
      (deps.api.acceptDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Conflict"),
      );

      await expect(
        acceptDelegationHandler({ delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, deps),
      ).rejects.toThrow("Conflict");
    });

    it("completeDelegationHandler propagates API errors", async () => {
      (deps.api.completeDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Unprocessable Entity"),
      );

      await expect(
        completeDelegationHandler(
          { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", result: "Done" },
          deps,
        ),
      ).rejects.toThrow("Unprocessable Entity");
    });

    it("cancelDelegationHandler propagates API errors", async () => {
      (deps.api.cancelDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Conflict"),
      );

      await expect(
        cancelDelegationHandler({ delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, deps),
      ).rejects.toThrow("Conflict");
    });

    it("acknowledgeDelegationHandler propagates API errors", async () => {
      (deps.api.acknowledgeDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Conflict"),
      );

      await expect(
        acknowledgeDelegationHandler(
          { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
          deps,
        ),
      ).rejects.toThrow("Conflict");
    });

    it("extendDelegationHandler propagates API errors", async () => {
      (deps.api.extendDelegation as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Conflict"),
      );

      await expect(
        extendDelegationHandler({ delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, deps),
      ).rejects.toThrow("Conflict");
    });
  });
});
