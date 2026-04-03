/**
 * Delegation wire format types for Meshimize API responses.
 *
 * Matches `DelegationJSON` serializer (`delegation_json.ex`) field-by-field.
 * See docs/architecture/api-contracts/delegations.md §5.
 */

export type DelegationState = "pending" | "accepted" | "completed" | "cancelled" | "expired";
export type DelegationRoleFilter = "sender" | "assignee" | "available";

/** Metadata-only shape — returned by list, show, accept, cancel. */
export interface DelegationMetadataResponse {
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
  expires_at: string; // ISO 8601
  accepted_at: string | null; // ISO 8601 | null
  completed_at: string | null; // ISO 8601 | null
  cancelled_at: string | null; // ISO 8601 | null
  inserted_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/** Create response — metadata + transient description. */
export interface DelegationCreateResponse extends DelegationMetadataResponse {
  description: string;
}

/** Complete response — metadata + transient result. */
export interface DelegationCompleteResponse extends DelegationMetadataResponse {
  result: string;
}
