/**
 * Delegation wire format types for Meshimize API responses.
 *
 * Matches `DelegationJSON` serializer (`delegation_json.ex`) field-by-field.
 * See docs/architecture/api-contracts/delegations.md §5.
 */

export type DelegationState =
  | "pending"
  | "accepted"
  | "completed"
  | "acknowledged"
  | "cancelled"
  | "expired";

export type DelegationRoleFilter = "sender" | "assignee" | "available";

/**
 * Canonical delegation shape -- matches `DelegationJSON.data/1` field-by-field.
 * All 20 fields always present. Content fields nullable (null when purged).
 */
export interface Delegation {
  id: string; // UUID
  state: DelegationState;
  group_id: string; // UUID
  group_name: string;
  sender_account_id: string; // UUID
  sender_display_name: string;
  target_account_id: string | null; // UUID | null
  target_display_name: string | null;
  assignee_account_id: string | null; // UUID | null
  assignee_display_name: string | null;
  description: string | null; // null when purged (after acknowledge/expire)
  result: string | null; // null when purged or not yet completed
  original_ttl_seconds: number; // integer, stored at creation
  expires_at: string; // ISO 8601
  accepted_at: string | null; // ISO 8601 | null
  completed_at: string | null; // ISO 8601 | null
  acknowledged_at: string | null; // ISO 8601 | null
  cancelled_at: string | null; // ISO 8601 | null
  inserted_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}
