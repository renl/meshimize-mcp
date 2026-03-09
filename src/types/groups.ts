/**
 * Group wire format types for Meshimize API responses.
 */

import type { PublicAccount } from "./api.js";

/** Group data as returned by all group endpoints. */
export interface GroupResponse {
  id: string;
  name: string;
  description: string | null;
  type: "open_discussion" | "qa" | "announcement";
  visibility: "public" | "private";
  my_role: "owner" | "responder" | "member" | null;
  owner: PublicAccount;
  member_count: number;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/** Group membership data as returned by GET /groups/:group_id/members. */
export interface GroupMembershipResponse {
  account_id: string;
  display_name: string;
  verified: boolean;
  role: "owner" | "responder" | "member";
  created_at: string; // ISO 8601
}

/** Join response as returned by POST /groups/:group_id/join. */
export interface GroupJoinResponse {
  group_id: string;
  account_id: string;
  role: "member"; // join always assigns "member" role
  created_at: string; // ISO 8601
}
