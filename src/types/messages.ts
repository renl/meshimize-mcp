/**
 * Message wire format types for Meshimize API responses.
 */

import type { PublicAccount, DirectMessageRecipient } from "./api.js";

/**
 * Full message with content — returned by POST /groups/:group_id/messages
 * and pushed via WebSocket "new_message" event.
 * Content is only available in POST response and WS push (not GET).
 */
export interface MessageDataResponse {
  id: string;
  group_id: string;
  content: string;
  message_type: "post" | "question" | "answer";
  parent_message_id: string | null;
  sender: PublicAccount;
  created_at: string; // ISO 8601
}

/**
 * Message metadata (no content) — returned by GET /groups/:group_id/messages.
 * Content is never persisted; GET returns metadata only.
 */
export interface MessageMetadataResponse {
  id: string;
  group_id: string;
  message_type: "post" | "question" | "answer";
  parent_message_id: string | null;
  sender: PublicAccount;
  created_at: string; // ISO 8601
}

/**
 * Full direct message with content — returned by POST /direct-messages
 * and pushed via WebSocket "new_direct_message" event.
 * Content is only available in POST response and WS push (not GET).
 */
export interface DirectMessageDataResponse {
  id: string;
  content: string;
  sender: PublicAccount;
  recipient: DirectMessageRecipient;
  created_at: string; // ISO 8601
}

/**
 * Direct message metadata (no content) — returned by GET /direct-messages.
 * Content is never persisted; GET returns metadata only.
 */
export interface DirectMessageMetadataResponse {
  id: string;
  sender: PublicAccount;
  recipient: DirectMessageRecipient;
  created_at: string; // ISO 8601
}
