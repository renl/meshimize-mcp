import type { Config } from "../config.js";
import type { AccountResponse, PaginatedResponse } from "../types/api.js";
import type { GroupResponse, GroupJoinResponse } from "../types/groups.js";
import type {
  MessageDataResponse,
  MessageMetadataResponse,
  DirectMessageDataResponse,
  DirectMessageMetadataResponse,
} from "../types/messages.js";

export class MeshimizeAPIError extends Error {
  public readonly status: number;
  public readonly responseBody: unknown;

  constructor(status: number, responseBody: unknown) {
    let message = `HTTP ${status}`;

    if (typeof responseBody === "object" && responseBody !== null) {
      const body = responseBody as Record<string, unknown>;

      if ("error" in body) {
        const errorValue = body.error;

        if (typeof errorValue === "string") {
          message = errorValue;
        } else if (
          typeof errorValue === "object" &&
          errorValue !== null &&
          "message" in (errorValue as Record<string, unknown>) &&
          typeof (errorValue as Record<string, unknown>).message === "string"
        ) {
          message = (errorValue as Record<string, unknown>).message as string;
        } else {
          try {
            message = JSON.stringify(errorValue);
          } catch {
            // Keep default HTTP-based message if JSON serialization fails
          }
        }
      } else if ("message" in body && typeof body.message === "string") {
        message = body.message;
      }
    }

    super(message);
    this.name = "MeshimizeAPIError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

export class MeshimizeAPI {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: Config) {
    // Strip trailing slash from baseUrl, then append /api/v1
    this.baseUrl = config.baseUrl.replace(/\/+$/, "") + "/api/v1";
    this.apiKey = config.apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      };

      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        return response.json() as Promise<T>;
      }

      // Parse error body
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = { error: `HTTP ${response.status}` };
      }

      // Handle 429 with retry (if attempts remain)
      if (response.status === 429 && attempt < maxAttempts - 1) {
        const retryAfter = response.headers.get("Retry-After");
        const baseDelay = 1000;
        const maxDelay = 30000;
        let delayMs: number;

        if (retryAfter) {
          // Retry-After can be either seconds or an HTTP-date; handle both safely.
          const seconds = Number(retryAfter);
          if (Number.isFinite(seconds) && seconds >= 0) {
            delayMs = Math.min(seconds * 1000, maxDelay);
          } else {
            const retryTimestamp = Date.parse(retryAfter);
            if (!Number.isNaN(retryTimestamp)) {
              const diff = retryTimestamp - Date.now();
              delayMs = diff > 0 ? Math.min(diff, maxDelay) : 0;
            } else {
              // Malformed Retry-After header: fall back to exponential backoff with jitter.
              delayMs = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, maxDelay);
            }
          }
        } else {
          // Exponential backoff with jitter: min(base * 2^attempt + random(0, 1000ms), 30s)
          delayMs = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 1000, maxDelay);
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      // Non-retryable error or retries exhausted
      throw new MeshimizeAPIError(response.status, errorBody);
    }

    // Unreachable — loop always throws or returns, but TypeScript needs this
    throw new Error("Unexpected end of retry loop");
  }

  // --- Account ---
  async getAccount(): Promise<{ data: AccountResponse }> {
    return this.request("GET", "/account");
  }

  // --- Groups ---
  async searchGroups(params?: {
    q?: string;
    type?: string;
    limit?: number;
    after?: string;
  }): Promise<PaginatedResponse<GroupResponse>> {
    const qs = new URLSearchParams();
    if (params?.q) qs.set("q", params.q);
    if (params?.type) qs.set("type", params.type);
    if (params?.limit) qs.set("limit", params.limit.toString());
    if (params?.after) qs.set("after", params.after);
    const query = qs.toString();
    return this.request("GET", `/discover/groups${query ? `?${query}` : ""}`);
  }

  async getMyGroups(params?: {
    limit?: number;
    after?: string;
  }): Promise<PaginatedResponse<GroupResponse>> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", params.limit.toString());
    if (params?.after) qs.set("after", params.after);
    const query = qs.toString();
    return this.request("GET", `/groups${query ? `?${query}` : ""}`);
  }

  async joinGroup(groupId: string): Promise<{ data: GroupJoinResponse }> {
    return this.request("POST", `/groups/${groupId}/join`);
  }

  async leaveGroup(groupId: string): Promise<void> {
    return this.request("DELETE", `/groups/${groupId}/leave`);
  }

  // --- Messages ---
  async getMessages(
    groupId: string,
    params?: {
      limit?: number;
      after?: string;
      message_type?: string;
      parent_message_id?: string;
      unanswered?: boolean;
    },
  ): Promise<PaginatedResponse<MessageMetadataResponse>> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", params.limit.toString());
    if (params?.after) qs.set("after", params.after);
    if (params?.message_type) qs.set("message_type", params.message_type);
    if (params?.parent_message_id) qs.set("parent_message_id", params.parent_message_id);
    if (params?.unanswered) qs.set("unanswered", "true");
    const query = qs.toString();
    return this.request("GET", `/groups/${groupId}/messages${query ? `?${query}` : ""}`);
  }

  async postMessage(
    groupId: string,
    body: {
      content: string;
      message_type: "post" | "question" | "answer";
      parent_message_id?: string | null;
    },
  ): Promise<{ data: MessageDataResponse }> {
    // Flat params — body goes directly, NOT nested under "message" key
    return this.request("POST", `/groups/${groupId}/messages`, body);
  }

  // --- Direct Messages ---
  async getDirectMessages(params?: {
    limit?: number;
    after?: string;
  }): Promise<PaginatedResponse<DirectMessageMetadataResponse>> {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", params.limit.toString());
    if (params?.after) qs.set("after", params.after);
    const query = qs.toString();
    return this.request("GET", `/direct-messages${query ? `?${query}` : ""}`);
  }

  async sendDirectMessage(body: {
    recipient_account_id: string;
    content: string;
  }): Promise<{ data: DirectMessageDataResponse }> {
    // Flat params — body goes directly, NOT nested under "direct_message" key
    // Field is "recipient_account_id" (NOT "recipient_id")
    return this.request("POST", "/direct-messages", body);
  }
}
