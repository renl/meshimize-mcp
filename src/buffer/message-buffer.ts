/**
 * MessageBuffer — Domain-specific bounded FIFO buffer for Meshimize messages.
 *
 * Stores group messages and direct messages in separate buffers.
 * Group messages are keyed by group ID; each group has its own bounded buffer.
 * Direct messages share a single bounded buffer.
 *
 * Eviction policy: oldest messages are evicted first (FIFO) when capacity is exceeded.
 */

import type { MessageDataResponse, DirectMessageDataResponse } from "../types/messages.js";

export class MessageBuffer {
  private groupMessages: Map<string, MessageDataResponse[]> = new Map();
  private directMessages: DirectMessageDataResponse[] = [];
  private maxPerChannel: number;

  constructor(maxPerChannel: number = 1000) {
    this.maxPerChannel = maxPerChannel;
  }

  /** Appends a group message. Evicts oldest if over capacity. Auto-creates group buffer on first push. */
  addGroupMessage(groupId: string, message: MessageDataResponse): void {
    let buffer = this.groupMessages.get(groupId);
    if (!buffer) {
      buffer = [];
      this.groupMessages.set(groupId, buffer);
    }
    buffer.push(message);
    while (buffer.length > this.maxPerChannel) {
      buffer.shift();
    }
  }

  /** Appends a direct message. Evicts oldest if over capacity. */
  addDirectMessage(message: DirectMessageDataResponse): void {
    this.directMessages.push(message);
    while (this.directMessages.length > this.maxPerChannel) {
      this.directMessages.shift();
    }
  }

  /**
   * Returns messages for the group, applying filters in order:
   * 1. afterMessageId — messages after the specified ID (empty array if ID not found)
   * 2. messageType — filter by message_type
   * 3. parentMessageId — filter by parent_message_id
   * 4. unanswered — questions without corresponding answers (cross-references FULL group buffer)
   * 5. limit — take first N results
   */
  getGroupMessages(
    groupId: string,
    options?: {
      afterMessageId?: string;
      limit?: number;
      messageType?: string;
      parentMessageId?: string;
      unanswered?: boolean;
    },
  ): MessageDataResponse[] {
    const buffer = this.groupMessages.get(groupId);
    if (!buffer) return [];

    let result = [...buffer];

    if (options?.afterMessageId !== undefined) {
      const idx = result.findIndex((m) => m.id === options.afterMessageId);
      if (idx === -1) return [];
      result = result.slice(idx + 1);
    }

    if (options?.messageType !== undefined) {
      result = result.filter((m) => m.message_type === options.messageType);
    }

    if (options?.parentMessageId !== undefined) {
      result = result.filter((m) => m.parent_message_id === options.parentMessageId);
    }

    if (options?.unanswered === true) {
      // Find questions that don't have a corresponding answer in the FULL group buffer
      const fullBuffer = buffer;
      const answeredQuestionIds = new Set<string>();
      for (const msg of fullBuffer) {
        if (msg.message_type === "answer" && msg.parent_message_id) {
          answeredQuestionIds.add(msg.parent_message_id);
        }
      }
      result = result.filter(
        (m) => m.message_type === "question" && !answeredQuestionIds.has(m.id),
      );
    }

    if (options?.limit !== undefined) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  /**
   * Returns direct messages with optional afterMessageId and limit filtering.
   */
  getDirectMessages(options?: {
    afterMessageId?: string;
    limit?: number;
  }): DirectMessageDataResponse[] {
    let result = [...this.directMessages];

    if (options?.afterMessageId !== undefined) {
      const idx = result.findIndex((m) => m.id === options.afterMessageId);
      if (idx === -1) return [];
      result = result.slice(idx + 1);
    }

    if (options?.limit !== undefined) {
      result = result.slice(0, options.limit);
    }

    return result;
  }

  /** Returns the ID of the last (most recent) message in the specified group buffer. */
  getLastMessageId(groupId: string): string | undefined {
    const buffer = this.groupMessages.get(groupId);
    if (!buffer || buffer.length === 0) return undefined;
    return buffer[buffer.length - 1].id;
  }

  /** Returns the ID of the last direct message. */
  getLastDirectMessageId(): string | undefined {
    if (this.directMessages.length === 0) return undefined;
    return this.directMessages[this.directMessages.length - 1].id;
  }

  /** Deletes the entire buffer for the specified group. */
  clearGroup(groupId: string): void {
    this.groupMessages.delete(groupId);
  }
}
