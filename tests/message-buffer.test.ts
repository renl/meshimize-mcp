import { describe, it, expect, beforeEach } from "vitest";
import { MessageBuffer } from "../src/buffer/message-buffer.js";
import type { MessageDataResponse, DirectMessageDataResponse } from "../src/types/messages.js";

let idCounter = 0;

/** Creates a realistic group message with all required fields. */
function makeGroupMessage(overrides: Partial<MessageDataResponse> = {}): MessageDataResponse {
  return {
    id: overrides.id ?? `msg-auto-${++idCounter}`,
    group_id: overrides.group_id ?? "group-default",
    content: overrides.content ?? "Test message content",
    message_type: overrides.message_type ?? "post",
    parent_message_id: overrides.parent_message_id ?? null,
    sender: overrides.sender ?? {
      id: "sender-1",
      display_name: "Test Agent",
      verified: false,
    },
    created_at: overrides.created_at ?? "2026-03-09T10:00:00.000000Z",
  };
}

/** Creates a realistic direct message with all required fields. */
function makeDirectMessage(
  overrides: Partial<DirectMessageDataResponse> = {},
): DirectMessageDataResponse {
  return {
    id: overrides.id ?? `dm-auto-${++idCounter}`,
    content: overrides.content ?? "Direct message content",
    sender: overrides.sender ?? {
      id: "sender-1",
      display_name: "Sender Agent",
      verified: false,
    },
    recipient: overrides.recipient ?? {
      id: "recipient-1",
      display_name: "Recipient Agent",
    },
    created_at: overrides.created_at ?? "2026-03-09T10:00:00.000000Z",
  };
}

describe("MessageBuffer", () => {
  beforeEach(() => {
    idCounter = 0;
  });

  it("push and retrieve group messages", () => {
    const buffer = new MessageBuffer(100);
    const msg1 = makeGroupMessage({ id: "msg-1", group_id: "group-a" });
    const msg2 = makeGroupMessage({ id: "msg-2", group_id: "group-a" });

    buffer.addGroupMessage("group-a", msg1);
    buffer.addGroupMessage("group-a", msg2);

    const result = buffer.getGroupMessages("group-a");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("msg-1");
    expect(result[1].id).toBe("msg-2");
  });

  it("respects capacity limit — evicts oldest on overflow", () => {
    const buffer = new MessageBuffer(3);

    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-1" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-2" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-3" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-4" }));

    const result = buffer.getGroupMessages("group-a");
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe("msg-2");
    expect(result[1].id).toBe("msg-3");
    expect(result[2].id).toBe("msg-4");
  });

  it("maintains independent buffers per group", () => {
    const buffer = new MessageBuffer(100);

    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-a1", group_id: "group-a" }));
    buffer.addGroupMessage("group-b", makeGroupMessage({ id: "msg-b1", group_id: "group-b" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-a2", group_id: "group-a" }));

    const groupA = buffer.getGroupMessages("group-a");
    const groupB = buffer.getGroupMessages("group-b");

    expect(groupA).toHaveLength(2);
    expect(groupA[0].id).toBe("msg-a1");
    expect(groupA[1].id).toBe("msg-a2");
    expect(groupB).toHaveLength(1);
    expect(groupB[0].id).toBe("msg-b1");
  });

  it("returns messages in insertion order", () => {
    const buffer = new MessageBuffer(100);

    for (let i = 1; i <= 5; i++) {
      buffer.addGroupMessage("group-a", makeGroupMessage({ id: `msg-${i}` }));
    }

    const result = buffer.getGroupMessages("group-a");
    expect(result.map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3", "msg-4", "msg-5"]);
  });

  it("query with limit returns first N after filters", () => {
    const buffer = new MessageBuffer(100);

    for (let i = 1; i <= 10; i++) {
      buffer.addGroupMessage("group-a", makeGroupMessage({ id: `msg-${i}` }));
    }

    const result = buffer.getGroupMessages("group-a", { limit: 3 });
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("clearGroup() removes all messages for a group", () => {
    const buffer = new MessageBuffer(100);

    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-1" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-2" }));
    buffer.addGroupMessage("group-b", makeGroupMessage({ id: "msg-3" }));

    buffer.clearGroup("group-a");

    expect(buffer.getGroupMessages("group-a")).toHaveLength(0);
    expect(buffer.getGroupMessages("group-b")).toHaveLength(1);
  });

  it("empty buffer returns empty array", () => {
    const buffer = new MessageBuffer(100);

    expect(buffer.getGroupMessages("nonexistent")).toEqual([]);
    expect(buffer.getDirectMessages()).toEqual([]);
  });

  it("push to new group auto-creates buffer", () => {
    const buffer = new MessageBuffer(100);

    buffer.addGroupMessage("brand-new-group", makeGroupMessage({ id: "msg-1" }));

    const result = buffer.getGroupMessages("brand-new-group");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-1");
  });

  it("FIFO order: first in, first out on eviction", () => {
    const buffer = new MessageBuffer(2);

    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "first" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "second" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "third" }));

    const result = buffer.getGroupMessages("group-a");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("second");
    expect(result[1].id).toBe("third");
  });

  it("capacity of 1 — only keeps latest message", () => {
    const buffer = new MessageBuffer(1);

    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-1" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-2" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-3" }));

    const result = buffer.getGroupMessages("group-a");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("msg-3");
  });

  it("large capacity (10000) — no eviction below limit", () => {
    const buffer = new MessageBuffer(10000);

    for (let i = 0; i < 500; i++) {
      buffer.addGroupMessage("group-a", makeGroupMessage({ id: `msg-${i}` }));
    }

    const result = buffer.getGroupMessages("group-a");
    expect(result).toHaveLength(500);
    expect(result[0].id).toBe("msg-0");
    expect(result[499].id).toBe("msg-499");
  });

  it("buffer stores full message objects (all fields preserved)", () => {
    const buffer = new MessageBuffer(100);

    const fullMessage = makeGroupMessage({
      id: "msg-full",
      group_id: "group-a",
      content: "Full content here",
      message_type: "question",
      parent_message_id: null,
      sender: { id: "agent-42", display_name: "Expert Agent", verified: true },
      created_at: "2026-03-09T15:30:00.000000Z",
    });

    buffer.addGroupMessage("group-a", fullMessage);

    const result = buffer.getGroupMessages("group-a");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(fullMessage);
    expect(result[0].id).toBe("msg-full");
    expect(result[0].group_id).toBe("group-a");
    expect(result[0].content).toBe("Full content here");
    expect(result[0].message_type).toBe("question");
    expect(result[0].parent_message_id).toBeNull();
    expect(result[0].sender.id).toBe("agent-42");
    expect(result[0].sender.display_name).toBe("Expert Agent");
    expect(result[0].sender.verified).toBe(true);
    expect(result[0].created_at).toBe("2026-03-09T15:30:00.000000Z");
  });

  it("afterMessageId filtering works correctly", () => {
    const buffer = new MessageBuffer(100);

    for (let i = 1; i <= 5; i++) {
      buffer.addGroupMessage("group-a", makeGroupMessage({ id: `msg-${i}` }));
    }

    // Get messages after msg-3
    const result = buffer.getGroupMessages("group-a", { afterMessageId: "msg-3" });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("msg-4");
    expect(result[1].id).toBe("msg-5");

    // Nonexistent ID returns empty array
    const empty = buffer.getGroupMessages("group-a", { afterMessageId: "nonexistent" });
    expect(empty).toEqual([]);
  });

  it("messageType filtering works correctly", () => {
    const buffer = new MessageBuffer(100);

    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-1", message_type: "post" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-2", message_type: "question" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-3", message_type: "post" }));
    buffer.addGroupMessage(
      "group-a",
      makeGroupMessage({ id: "msg-4", message_type: "answer", parent_message_id: "msg-2" }),
    );
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-5", message_type: "question" }));

    const questions = buffer.getGroupMessages("group-a", { messageType: "question" });
    expect(questions).toHaveLength(2);
    expect(questions[0].id).toBe("msg-2");
    expect(questions[1].id).toBe("msg-5");

    const posts = buffer.getGroupMessages("group-a", { messageType: "post" });
    expect(posts).toHaveLength(2);
    expect(posts[0].id).toBe("msg-1");
    expect(posts[1].id).toBe("msg-3");
  });

  it("unanswered filtering finds questions without corresponding answers", () => {
    const buffer = new MessageBuffer(100);

    // Q1 — has an answer
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "q1", message_type: "question" }));
    // Answer to Q1
    buffer.addGroupMessage(
      "group-a",
      makeGroupMessage({ id: "a1", message_type: "answer", parent_message_id: "q1" }),
    );
    // Q2 — no answer
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "q2", message_type: "question" }));
    // A post (should be excluded)
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "p1", message_type: "post" }));
    // Q3 — no answer
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "q3", message_type: "question" }));

    const unanswered = buffer.getGroupMessages("group-a", { unanswered: true });
    expect(unanswered).toHaveLength(2);
    expect(unanswered[0].id).toBe("q2");
    expect(unanswered[1].id).toBe("q3");
  });

  it("getLastMessageId and getLastDirectMessageId return correct values", () => {
    const buffer = new MessageBuffer(100);

    // Empty — returns undefined
    expect(buffer.getLastMessageId("group-a")).toBeUndefined();
    expect(buffer.getLastDirectMessageId()).toBeUndefined();

    // Add group messages
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-1" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-2" }));
    expect(buffer.getLastMessageId("group-a")).toBe("msg-2");

    // Add direct messages
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-1" }));
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-2" }));
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-3" }));
    expect(buffer.getLastDirectMessageId()).toBe("dm-3");
  });

  it("direct message buffer works independently from group buffers", () => {
    const buffer = new MessageBuffer(100);

    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-1" }));
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-1" }));
    buffer.addGroupMessage("group-a", makeGroupMessage({ id: "msg-2" }));
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-2" }));

    const groupMsgs = buffer.getGroupMessages("group-a");
    const dms = buffer.getDirectMessages();

    expect(groupMsgs).toHaveLength(2);
    expect(dms).toHaveLength(2);
    expect(groupMsgs[0].id).toBe("msg-1");
    expect(dms[0].id).toBe("dm-1");

    // Clearing group doesn't affect DMs
    buffer.clearGroup("group-a");
    expect(buffer.getGroupMessages("group-a")).toHaveLength(0);
    expect(buffer.getDirectMessages()).toHaveLength(2);
  });

  it("addDirectMessage + getDirectMessages with filtering", () => {
    const buffer = new MessageBuffer(100);

    buffer.addDirectMessage(makeDirectMessage({ id: "dm-1" }));
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-2" }));
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-3" }));
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-4" }));
    buffer.addDirectMessage(makeDirectMessage({ id: "dm-5" }));

    // afterMessageId
    const afterDm2 = buffer.getDirectMessages({ afterMessageId: "dm-2" });
    expect(afterDm2).toHaveLength(3);
    expect(afterDm2[0].id).toBe("dm-3");
    expect(afterDm2[2].id).toBe("dm-5");

    // limit
    const limited = buffer.getDirectMessages({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].id).toBe("dm-1");
    expect(limited[1].id).toBe("dm-2");

    // afterMessageId + limit combined
    const combined = buffer.getDirectMessages({ afterMessageId: "dm-1", limit: 2 });
    expect(combined).toHaveLength(2);
    expect(combined[0].id).toBe("dm-2");
    expect(combined[1].id).toBe("dm-3");

    // Nonexistent afterMessageId returns empty
    const empty = buffer.getDirectMessages({ afterMessageId: "nonexistent" });
    expect(empty).toEqual([]);
  });
});
