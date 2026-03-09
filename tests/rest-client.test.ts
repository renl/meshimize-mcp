import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MeshimizeAPI, MeshimizeAPIError } from "../src/api/client.js";
import type { Config } from "../src/config.js";

function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    apiKey: "mshz_test_key_123",
    baseUrl: "https://api.meshimize.com",
    wsUrl: "wss://api.meshimize.com/api/v1/ws",
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

  it("getAccount() sends GET with correct auth header and returns AccountResponse", async () => {
    const accountData = {
      data: {
        id: "550e8400-e29b-41d4-a716-446655440000",
        email: "dev@example.com",
        display_name: "Acme Agent",
        description: null,
        allow_direct_connections: true,
        verified: false,
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
        account_id: "account-1",
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

    // Flat JSON body — not nested under "message" key
    expect(parsedBody).toEqual({
      content: "Hello world",
      message_type: "question",
      parent_message_id: null,
    });
    expect(parsedBody).not.toHaveProperty("message");
  });

  it("sendDirectMessage() sends recipient_account_id (NOT recipient_id) as flat JSON", async () => {
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
      recipient_account_id: "recipient-1",
      content: "Hey there",
    });

    const [, options] = mockFetch.mock.calls[0];
    const parsedBody = JSON.parse(options.body as string);

    // Flat body with recipient_account_id (NOT recipient_id)
    expect(parsedBody).toEqual({
      recipient_account_id: "recipient-1",
      content: "Hey there",
    });
    expect(parsedBody).not.toHaveProperty("recipient_id");
    expect(parsedBody).not.toHaveProperty("direct_message");
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
            allow_direct_connections: true,
            verified: false,
            created_at: "2026-02-16T10:00:00.000000Z",
            updated_at: "2026-02-16T10:00:00.000000Z",
          },
        }),
      );

    const api = new MeshimizeAPI(createTestConfig());
    const requestPromise = api.getAccount();

    // Advance past the Retry-After delay (1 second)
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
            allow_direct_connections: true,
            verified: false,
            created_at: "2026-02-16T10:00:00.000000Z",
            updated_at: "2026-02-16T10:00:00.000000Z",
          },
        }),
      );

    const api = new MeshimizeAPI(createTestConfig());
    const requestPromise = api.getAccount();

    // Advance past the exponential backoff delay (up to 30s max)
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

    // Capture the rejection eagerly so it doesn't leak as unhandled
    let caughtErr: unknown;
    const requestPromise = api.getAccount().catch((err) => {
      caughtErr = err;
    });

    // Advance past both retry delays (each up to 30s max)
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
});
