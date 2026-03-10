/**
 * Represents a join request that is awaiting operator approval.
 * Stored in-memory in the MCP server process.
 * Not persisted — lost on process restart (acceptable for MCP session lifecycle).
 */
export interface PendingJoinRequest {
  /** Unique ID for this pending request (locally generated UUID) */
  id: string;

  /** The group the agent wants to join — subset of GroupResponse fields */
  group: {
    id: string;
    name: string;
    description: string | null;
    type: "open_discussion" | "qa" | "announcement";
    visibility: "public" | "private";
    owner: {
      id: string;
      display_name: string;
      verified: boolean;
    };
    member_count: number;
  };

  /** When the request was created (ISO 8601) */
  created_at: string;

  /** When the request expires (ISO 8601) — default: 10 minutes after creation */
  expires_at: string;

  /** Current status */
  status: "pending" | "approved" | "rejected" | "expired";
}
