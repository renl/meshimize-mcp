import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDependencies } from "../src/tools/index.js";
import {
  createDelegationHandler,
  listDelegationsHandler,
  getDelegationHandler,
  acceptDelegationHandler,
  completeDelegationHandler,
  cancelDelegationHandler,
} from "../src/tools/delegations.js";
import type { MeshimizeAPI } from "../src/api/client.js";
import type { MessageBuffer } from "../src/buffer/message-buffer.js";
import { DelegationContentBuffer } from "../src/buffer/delegation-content-buffer.js";
import type { DelegationMetadataResponse } from "../src/types/delegations.js";
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

function makeDelegationMetadata(
  overrides: Partial<DelegationMetadataResponse> = {},
): DelegationMetadataResponse {
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
    expires_at: overrides.expires_at ?? "2026-04-03T00:00:00Z",
    accepted_at: overrides.accepted_at ?? null,
    completed_at: overrides.completed_at ?? null,
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
      const metadata = makeDelegationMetadata();
      const createResponse = { ...metadata, description: "Please handle this" };

      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: createResponse,
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
      expect(result.delegation).toEqual(createResponse);
      // Verify buffer stored the description
      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toEqual({
        description: "Please handle this",
      });
    });

    it("passes optional target_account_id and ttl_seconds", async () => {
      const metadata = makeDelegationMetadata({
        target_account_id: "dddddddd-dddd-dddd-dddd-dddddddddddd",
        target_display_name: "Target Agent",
      });
      const createResponse = { ...metadata, description: "Targeted task" };

      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: createResponse,
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
      const metadata = makeDelegationMetadata();
      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { ...metadata, description: "Task" },
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
  });

  // --- listDelegationsHandler ---

  describe("listDelegationsHandler", () => {
    it("calls API and returns delegations with meta", async () => {
      const d1 = makeDelegationMetadata({ id: "d-1" });
      const d2 = makeDelegationMetadata({ id: "d-2" });

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

    it("enriches delegations with buffer content when available", async () => {
      const d1 = makeDelegationMetadata({ id: "d-1" });
      const d2 = makeDelegationMetadata({ id: "d-2" });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1, d2],
        meta: { has_more: false, next_cursor: null, count: 2 },
      });

      // Pre-populate buffer with content for d-1 only
      deps.delegationBuffer.storeDescription("d-1", "Stored description");
      deps.delegationBuffer.storeResult("d-1", "Stored result");

      const result = await listDelegationsHandler({}, deps);

      // d-1 should be enriched
      expect(result.delegations[0]).toMatchObject({
        id: "d-1",
        description: "Stored description",
        result: "Stored result",
      });
      // d-2 should not have description or result
      expect(result.delegations[1]).not.toHaveProperty("description");
      expect(result.delegations[1]).not.toHaveProperty("result");
    });

    it("returns metadata only when buffer is empty", async () => {
      const d1 = makeDelegationMetadata({ id: "d-1" });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0]).not.toHaveProperty("description");
      expect(result.delegations[0]).not.toHaveProperty("result");
      expect(result.delegations[0].id).toBe("d-1");
    });
  });

  // --- getDelegationHandler ---

  describe("getDelegationHandler", () => {
    it("calls API with delegation_id and returns enriched result", async () => {
      const metadata = makeDelegationMetadata();

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: metadata,
      });

      deps.delegationBuffer.storeDescription(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "Buffered desc",
      );

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(deps.api.getDelegation).toHaveBeenCalledWith("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(result.delegation).toMatchObject({
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        description: "Buffered desc",
      });
    });

    it("returns metadata only when buffer has no entry", async () => {
      const metadata = makeDelegationMetadata();

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: metadata,
      });

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(result.delegation).not.toHaveProperty("description");
      expect(result.delegation).not.toHaveProperty("result");
      expect(result.delegation.id).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    });

    it("enriches with both description and result from buffer", async () => {
      const metadata = makeDelegationMetadata();

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: metadata,
      });

      deps.delegationBuffer.storeDescription("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "The task");
      deps.delegationBuffer.storeResult("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "The result");

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(result.delegation).toMatchObject({
        description: "The task",
        result: "The result",
      });
    });
  });

  // --- acceptDelegationHandler ---

  describe("acceptDelegationHandler", () => {
    it("calls API and returns metadata", async () => {
      const metadata = makeDelegationMetadata({
        state: "accepted",
        assignee_account_id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
        assignee_display_name: "Assignee Agent",
        accepted_at: "2026-04-02T01:00:00Z",
      });

      (deps.api.acceptDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: metadata,
      });

      const result = await acceptDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(deps.api.acceptDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      );
      expect(result.delegation).toEqual(metadata);
      expect(result.delegation.state).toBe("accepted");
    });
  });

  // --- completeDelegationHandler ---

  describe("completeDelegationHandler", () => {
    it("calls API with result body and stores result in buffer", async () => {
      const metadata = makeDelegationMetadata({
        state: "completed",
        completed_at: "2026-04-02T02:00:00Z",
      });
      const completeResponse = { ...metadata, result: "Task is done" };

      (deps.api.completeDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: completeResponse,
      });

      const result = await completeDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", result: "Task is done" },
        deps,
      );

      expect(deps.api.completeDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        { result: "Task is done" },
      );
      expect(result.delegation).toEqual(completeResponse);
      // Verify buffer stored the result
      expect(deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toMatchObject({
        result: "Task is done",
      });
    });
  });

  // --- cancelDelegationHandler ---

  describe("cancelDelegationHandler", () => {
    it("calls API and returns metadata", async () => {
      const metadata = makeDelegationMetadata({
        state: "cancelled",
        cancelled_at: "2026-04-02T03:00:00Z",
      });

      (deps.api.cancelDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: metadata,
      });

      const result = await cancelDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(deps.api.cancelDelegation).toHaveBeenCalledWith(
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      );
      expect(result.delegation).toEqual(metadata);
      expect(result.delegation.state).toBe("cancelled");
    });
  });

  // --- Content enrichment edge cases ---

  describe("content enrichment edge cases", () => {
    it("list enriches only delegations with matching buffer entries", async () => {
      const d1 = makeDelegationMetadata({ id: "d-1" });
      const d2 = makeDelegationMetadata({ id: "d-2" });
      const d3 = makeDelegationMetadata({ id: "d-3" });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1, d2, d3],
        meta: { has_more: false, next_cursor: null, count: 3 },
      });

      // Only d-2 has buffer content
      deps.delegationBuffer.storeDescription("d-2", "Only this one");

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0]).not.toHaveProperty("description");
      expect(result.delegations[1]).toMatchObject({ id: "d-2", description: "Only this one" });
      expect(result.delegations[2]).not.toHaveProperty("description");
    });

    it("list enriches with description only when result is not in buffer", async () => {
      const d1 = makeDelegationMetadata({ id: "d-1" });

      (deps.api.listDelegations as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: [d1],
        meta: { has_more: false, next_cursor: null, count: 1 },
      });

      deps.delegationBuffer.storeDescription("d-1", "Desc only");

      const result = await listDelegationsHandler({}, deps);

      expect(result.delegations[0]).toMatchObject({ description: "Desc only" });
      expect(result.delegations[0]).not.toHaveProperty("result");
    });

    it("get enriches with result only when description is not in buffer", async () => {
      const metadata = makeDelegationMetadata();

      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: metadata,
      });

      deps.delegationBuffer.storeResult("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Result only");

      const result = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(result.delegation).toMatchObject({ result: "Result only" });
      expect(result.delegation).not.toHaveProperty("description");
    });

    it("create followed by complete — buffer has both description and result", async () => {
      // Simulate create
      const createMetadata = makeDelegationMetadata({ state: "pending" });
      (deps.api.createDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { ...createMetadata, description: "Do something" },
      });

      await createDelegationHandler(
        {
          group_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          description: "Do something",
        },
        deps,
      );

      // Simulate complete
      const completeMetadata = makeDelegationMetadata({ state: "completed" });
      (deps.api.completeDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: { ...completeMetadata, result: "All done" },
      });

      await completeDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", result: "All done" },
        deps,
      );

      // Buffer should have both
      const content = deps.delegationBuffer.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      expect(content).toEqual({ description: "Do something", result: "All done" });

      // Now get should return enriched
      (deps.api.getDelegation as ReturnType<typeof vi.fn>).mockResolvedValue({
        data: completeMetadata,
      });

      const getResult = await getDelegationHandler(
        { delegation_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
        deps,
      );

      expect(getResult.delegation).toMatchObject({
        description: "Do something",
        result: "All done",
      });
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
  });
});
