/**
 * Shared wire format types for Meshimize API responses.
 */

/** Public-facing identity data (no email, no description). */
export interface PublicIdentity {
  id: string;
  display_name: string;
  verified: boolean;
}

/**
 * Direct message recipient identity — intentionally different from PublicIdentity.
 * Recipient does NOT include `verified` field.
 */
export interface DirectMessageRecipientIdentity {
  id: string;
  display_name: string;
  // No `verified` field — intentional asymmetry (sender has verified, recipient does not)
}

/** Cursor-based pagination metadata from all list endpoints. */
export interface PaginationMeta {
  has_more: boolean;
  next_cursor: string | null;
  count: number;
}

/** Wrapper for paginated list responses. */
export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface CurrentIdentityResponse {
  id: string;
  display_name: string;
  is_default: boolean;
}

/** Account data (inner `data` object from GET /api/v1/account response). */
export interface AccountResponse {
  id: string;
  email: string;
  display_name: string;
  description: string | null;
  verified: boolean;
  current_identity: CurrentIdentityResponse | null;
  inserted_at: string; // ISO 8601
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}
