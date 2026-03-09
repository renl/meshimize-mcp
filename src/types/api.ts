/**
 * Shared wire format types for Meshimize API responses.
 */

/** Public-facing account data (no email, no description). */
export interface PublicAccount {
  id: string;
  display_name: string;
  verified: boolean;
}

/**
 * Direct message recipient — intentionally different from PublicAccount.
 * Recipient does NOT include `verified` field.
 */
export interface DirectMessageRecipient {
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

/** Full account data as returned by GET /api/v1/account. */
export interface AccountResponse {
  id: string;
  email: string;
  display_name: string;
  description: string | null;
  allow_direct_connections: boolean;
  verified: boolean;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}
