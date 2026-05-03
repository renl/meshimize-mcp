import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MeshimizeAPI, MeshimizeAPIError } from "../src/api/client.js";
import type { Config } from "../src/config.js";

function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    apiKey: "mshz_test_key_123",
    baseUrl: "https://api.meshimize.com",
    wsUrl: "wss://api.meshimize.com/api/v1/ws/websocket",
    bufferSize: 1000,
    heartbeatIntervalMs: 30000,
    reconnectIntervalMs: 5000,
    maxReconnectAttempts: 10,
    ...overrides,
  };
}

function mockFetchResponse(status: number, body: unknown, headers?: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  } as Response;
}

describe("MeshimizeAPI", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("getAccount() sends GET with correct auth header and returns current_identity payload", async () => {
    const accountData = {
      data: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        email: "dev@example.com",
        display_name: "Acme Operator",
        description: null,
        verified: false,
        current_identity: {
          id: "660e8400-e29b-41d4-a716-446655440000",
          display_name: "Acme Agent",
          is_default: true,
        },
        inserted_at: "2026-02-16T10:00:00.000000Z",
        created_at: "2026-02-16T10:00:00.000000Z",
        updated_at: "2026-02-16T10:00:00.000000Z",
      },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, accountData));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.getAccount();

    expect(result).toEqual(accountData);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/account");
    expect(options.method).toBe("GET");
    expect(options.headers.Authorization).toBe("Bearer mshz_test_key_123");
  });

  it("searchGroups() passes query params correctly", async () => {
    const searchResult = {
      data: [
        {
          id: "group-1",
          name: "Fly.io Docs",
          description: "Q&A for Fly.io",
          type: "qa",
          visibility: "public",
          my_role: null,
          owner: { id: "owner-1", display_name: "Fly Team", verified: true },
          member_count: 42,
          created_at: "2026-02-16T10:00:00.000000Z",
          updated_at: "2026-02-16T10:00:00.000000Z",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 1 },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, searchResult));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.searchGroups({ q: "fly", type: "qa", limit: 10 });

    expect(result).toEqual(searchResult);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/discover/groups?");
    expect(url).toContain("q=fly");
    expect(url).toContain("type=qa");
    expect(url).toContain("limit=10");
  });

  it("joinGroup() sends POST to correct path and returns GroupJoinResponse", async () => {
    const joinResult = {
      data: {
        group_id: "group-1",
        agent_identity_id: "identity-1",
        role: "member",
        created_at: "2026-02-16T10:00:00.000000Z",
      },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, joinResult));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.joinGroup("group-1");

    expect(result).toEqual(joinResult);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/groups/group-1/join");
    expect(options.method).toBe("POST");
  });

  it("postMessage() sends flat JSON body (NOT nested under 'message' key)", async () => {
    const messageResult = {
      data: {
        id: "msg-1",
        group_id: "group-1",
        content: "Hello world",
        message_type: "question",
        parent_message_id: null,
        sender: { id: "sender-1", display_name: "Agent", verified: false },
        created_at: "2026-02-16T10:00:00.000000Z",
      },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, messageResult));

    const api = new MeshimizeAPI(createTestConfig());
    await api.postMessage("group-1", {
      content: "Hello world",
      message_type: "question",
      parent_message_id: null,
    });

    const [, options] = mockFetch.mock.calls[0];
    const parsedBody = JSON.parse(options.body as string);

    expect(parsedBody).toEqual({
      content: "Hello world",
      message_type: "question",
      parent_message_id: null,
    });
    expect(parsedBody).not.toHaveProperty("message");
  });

  it("sendDirectMessage() sends recipient_identity_id (NOT recipient_id) as flat JSON", async () => {
    const dmResult = {
      data: {
        id: "dm-1",
        content: "Hey there",
        sender: { id: "sender-1", display_name: "Agent", verified: false },
        recipient: { id: "recipient-1", display_name: "Other Agent" },
        created_at: "2026-02-16T10:00:00.000000Z",
      },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, dmResult));

    const api = new MeshimizeAPI(createTestConfig());
    await api.sendDirectMessage({
      recipient_identity_id: "recipient-1",
      content: "Hey there",
    });

    const [, options] = mockFetch.mock.calls[0];
    const parsedBody = JSON.parse(options.body as string);

    expect(parsedBody).toEqual({
      recipient_identity_id: "recipient-1",
      content: "Hey there",
    });
    expect(parsedBody).not.toHaveProperty("recipient_id");
    expect(parsedBody).not.toHaveProperty("direct_message");
  });

  it("getMyGroups() sends GET to /groups with query params", async () => {
    const groupsResult = {
      data: [
        {
          id: "group-1",
          name: "My Group",
          description: "A test group",
          type: "qa",
          visibility: "public",
          my_role: "member",
          owner: { id: "owner-1", display_name: "Owner", verified: true },
          member_count: 5,
          created_at: "2026-02-16T10:00:00.000000Z",
          updated_at: "2026-02-16T10:00:00.000000Z",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 1 },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, groupsResult));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.getMyGroups({ limit: 5, after: "cursor-abc" });

    expect(result).toEqual(groupsResult);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/groups?limit=5&after=cursor-abc");
    expect(options.method).toBe("GET");
  });

  it("leaveGroup() sends DELETE to correct path", async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse(204, undefined));

    const api = new MeshimizeAPI(createTestConfig());
    await api.leaveGroup("group-1");

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/groups/group-1/leave");
    expect(options.method).toBe("DELETE");
  });

  it("getMessages() sends GET to /groups/:id/messages with query params", async () => {
    const messagesResult = {
      data: [
        {
          id: "msg-1",
          group_id: "group-1",
          message_type: "question",
          parent_message_id: null,
          sender: { id: "sender-1", display_name: "Agent", verified: false },
          created_at: "2026-02-16T10:00:00.000000Z",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 1 },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, messagesResult));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.getMessages("group-1", {
      limit: 10,
      message_type: "question",
      unanswered: true,
    });

    expect(result).toEqual(messagesResult);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain("/groups/group-1/messages?");
    expect(url).toContain("limit=10");
    expect(url).toContain("message_type=question");
    expect(url).toContain("unanswered=true");
    expect(options.method).toBe("GET");
  });

  it("getDirectMessages() sends GET to /direct-messages with query params", async () => {
    const dmsResult = {
      data: [
        {
          id: "dm-1",
          sender: { id: "sender-1", display_name: "Agent", verified: false },
          recipient: { id: "recipient-1", display_name: "Other Agent" },
          created_at: "2026-02-16T10:00:00.000000Z",
        },
      ],
      meta: { has_more: false, next_cursor: null, count: 1 },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, dmsResult));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.getDirectMessages({ limit: 20, after: "cursor-xyz" });

    expect(result).toEqual(dmsResult);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/direct-messages?limit=20&after=cursor-xyz");
    expect(options.method).toBe("GET");
  });

  it("retries on 429 with Retry-After header", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockFetchResponse(429, { error: "rate_limited" }, { "Retry-After": "1" }),
      )
      .mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: {
            id: "account-1",
            email: "test@example.com",
            display_name: "Test",
            description: null,
            verified: false,
            current_identity: {
              id: "identity-1",
              display_name: "Test Identity",
              is_default: false,
            },
            inserted_at: "2026-02-16T10:00:00.000000Z",
            created_at: "2026-02-16T10:00:00.000000Z",
            updated_at: "2026-02-16T10:00:00.000000Z",
          },
        }),
      );

    const api = new MeshimizeAPI(createTestConfig());
    const requestPromise = api.getAccount();

    await vi.advanceTimersByTimeAsync(2_000);

    const result = await requestPromise;

    expect(result.data.id).toBe("account-1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 with exponential backoff (no Retry-After header)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockFetchResponse(429, { error: "rate_limited" }))
      .mockResolvedValueOnce(
        mockFetchResponse(200, {
          data: {
            id: "account-1",
            email: "test@example.com",
            display_name: "Test",
            description: null,
            verified: false,
            current_identity: {
              id: "identity-1",
              display_name: "Test Identity",
              is_default: false,
            },
            inserted_at: "2026-02-16T10:00:00.000000Z",
            created_at: "2026-02-16T10:00:00.000000Z",
            updated_at: "2026-02-16T10:00:00.000000Z",
          },
        }),
      );

    const api = new MeshimizeAPI(createTestConfig());
    const requestPromise = api.getAccount();

    await vi.advanceTimersByTimeAsync(31_000);

    const result = await requestPromise;

    expect(result.data.id).toBe("account-1");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("throws MeshimizeAPIError after max retries exhausted (3x 429)", async () => {
    mockFetch
      .mockResolvedValueOnce(mockFetchResponse(429, { error: "rate_limited" }))
      .mockResolvedValueOnce(mockFetchResponse(429, { error: "rate_limited" }))
      .mockResolvedValueOnce(mockFetchResponse(429, { error: "rate_limited" }));

    const api = new MeshimizeAPI(createTestConfig());

    let caughtErr: unknown;
    const requestPromise = api.getAccount().catch((err) => {
      caughtErr = err;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await requestPromise;

    expect(caughtErr).toBeInstanceOf(MeshimizeAPIError);
    const apiErr = caughtErr as MeshimizeAPIError;
    expect(apiErr.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("throws MeshimizeAPIError on 4xx (non-429)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockFetchResponse(403, {
        error: { code: "forbidden", message: "Insufficient permissions" },
      }),
    );

    const api = new MeshimizeAPI(createTestConfig());

    try {
      await api.getAccount();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MeshimizeAPIError);
      const apiErr = err as MeshimizeAPIError;
      expect(apiErr.status).toBe(403);
      expect(apiErr.message).toBe("Insufficient permissions");
      expect(apiErr.responseBody).toEqual({
        error: { code: "forbidden", message: "Insufficient permissions" },
      });
    }
  });

  it("throws MeshimizeAPIError on 5xx", async () => {
    mockFetch.mockResolvedValueOnce(mockFetchResponse(500, { error: "Internal server error" }));

    const api = new MeshimizeAPI(createTestConfig());

    try {
      await api.getAccount();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MeshimizeAPIError);
      const apiErr = err as MeshimizeAPIError;
      expect(apiErr.status).toBe(500);
    }
  });

  it("createDelegation() sends target_identity_id and returns identity-scoped delegation", async () => {
    const delegationData = {
      data: {
        id: "del-1",
        state: "pending",
        group_id: "group-1",
        group_name: "Test Group",
        sender_identity_id: "sender-identity-1",
        sender_display_name: "Sender",
        target_identity_id: "target-identity-1",
        target_display_name: "Target",
        assignee_identity_id: null,
        assignee_display_name: null,
        description: "A task",
        result: null,
        original_ttl_seconds: 86400,
        expires_at: "2026-04-03T00:00:00Z",
        accepted_at: null,
        completed_at: null,
        acknowledged_at: null,
        cancelled_at: null,
        inserted_at: "2026-04-02T00:00:00Z",
        updated_at: "2026-04-02T00:00:00Z",
      },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, delegationData));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.createDelegation({
      group_id: "group-1",
      description: "A task",
      target_identity_id: "target-identity-1",
      ttl_seconds: 3600,
    });

    expect(result).toEqual(delegationData);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/delegations");
    expect(options.method).toBe("POST");
    const parsedBody = JSON.parse(options.body as string);
    expect(parsedBody).toEqual({
      group_id: "group-1",
      description: "A task",
      target_identity_id: "target-identity-1",
      ttl_seconds: 3600,
    });
  });

  it("acknowledgeDelegation() sends POST to correct path with no body", async () => {
    const delegationData = {
      data: {
        id: "del-1",
        state: "acknowledged",
        group_id: "group-1",
        group_name: "Test Group",
        sender_identity_id: "sender-1",
        sender_display_name: "Sender",
        target_identity_id: null,
        target_display_name: null,
        assignee_identity_id: "assignee-1",
        assignee_display_name: "Assignee",
        description: null,
        result: null,
        original_ttl_seconds: 86400,
        expires_at: "2026-04-03T00:00:00Z",
        accepted_at: "2026-04-02T01:00:00Z",
        completed_at: "2026-04-02T02:00:00Z",
        acknowledged_at: "2026-04-02T03:00:00Z",
        cancelled_at: null,
        inserted_at: "2026-04-02T00:00:00Z",
        updated_at: "2026-04-02T03:00:00Z",
      },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, delegationData));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.acknowledgeDelegation("del-1");

    expect(result).toEqual(delegationData);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/delegations/del-1/acknowledge");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBeUndefined();
    expect(options.body).toBeUndefined();
  });

  it("extendDelegation() sends POST with body when ttl_seconds provided", async () => {
    const delegationData = {
      data: {
        id: "del-1",
        state: "pending",
        group_id: "group-1",
        group_name: "Test Group",
        sender_identity_id: "sender-1",
        sender_display_name: "Sender",
        target_identity_id: null,
        target_display_name: null,
        assignee_identity_id: null,
        assignee_display_name: null,
        description: "A task",
        result: null,
        original_ttl_seconds: 86400,
        expires_at: "2026-04-04T00:00:00Z",
        accepted_at: null,
        completed_at: null,
        acknowledged_at: null,
        cancelled_at: null,
        inserted_at: "2026-04-02T00:00:00Z",
        updated_at: "2026-04-02T00:00:00Z",
      },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, delegationData));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.extendDelegation("del-1", { ttl_seconds: 3600 });

    expect(result).toEqual(delegationData);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/delegations/del-1/extend");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    const parsedBody = JSON.parse(options.body as string);
    expect(parsedBody).toEqual({ ttl_seconds: 3600 });
  });

  it("extendDelegation() sends POST with no body when ttl_seconds omitted (reset mode)", async () => {
    const delegationData = {
      data: {
        id: "del-1",
        state: "pending",
        group_id: "group-1",
        group_name: "Test Group",
        sender_identity_id: "sender-1",
        sender_display_name: "Sender",
        target_identity_id: null,
        target_display_name: null,
        assignee_identity_id: null,
        assignee_display_name: null,
        description: "A task",
        result: null,
        original_ttl_seconds: 86400,
        expires_at: "2026-04-04T00:00:00Z",
        accepted_at: null,
        completed_at: null,
        acknowledged_at: null,
        cancelled_at: null,
        inserted_at: "2026-04-02T00:00:00Z",
        updated_at: "2026-04-02T00:00:00Z",
      },
    };
    mockFetch.mockResolvedValueOnce(mockFetchResponse(200, delegationData));

    const api = new MeshimizeAPI(createTestConfig());
    const result = await api.extendDelegation("del-1");

    expect(result).toEqual(delegationData);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.meshimize.com/api/v1/delegations/del-1/extend");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBeUndefined();
    expect(options.body).toBeUndefined();
  });
});
