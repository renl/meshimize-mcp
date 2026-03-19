import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createAuthoritySessionContextStore,
  toAuthorityContinuation,
} from "../../src/state/authority-session-context.js";

const lookupKey = {
  query_text: "meshimize",
  type_filter: "qa" as const,
};

describe("AuthoritySessionContextStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores lookup-scoped continuations with the canonical shape and 15-minute expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T12:00:00.000Z"));

    const store = createAuthoritySessionContextStore();
    const context = store.recordLookupState("no_relevant_group_found", lookupKey);
    const continuation = toAuthorityContinuation(context);

    expect(continuation).toEqual({
      state: "no_relevant_group_found",
      scope: "lookup",
      lookup_key: lookupKey,
      group_id: null,
      pending_join_id: null,
      membership_path: null,
      question_id: null,
      next_tool: null,
      expires_at: "2026-03-19T12:15:00.000Z",
    });
  });

  it("refreshes repeated lookup state expiry without changing scope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T12:00:00.000Z"));

    const store = createAuthoritySessionContextStore();
    const first = store.recordLookupState("no_relevant_group_found", lookupKey);

    vi.setSystemTime(new Date("2026-03-19T12:05:00.000Z"));
    const second = store.recordLookupState("no_relevant_group_found", lookupKey);

    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).toBe("2026-03-19T12:05:00.000Z");
    expect(second.expires_at).toBe("2026-03-19T12:20:00.000Z");
  });

  it("expires ready_to_ask after 10 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T12:00:00.000Z"));

    const store = createAuthoritySessionContextStore();
    store.recordReadyToAsk("11111111-1111-1111-1111-111111111111", "post_approval_first_ask");

    vi.setSystemTime(new Date("2026-03-19T12:10:01.000Z"));

    expect(store.getGroupContext("11111111-1111-1111-1111-111111111111")).toBeUndefined();
  });

  it("clears timed_out_waiting_for_answer when a matching late answer is observed", () => {
    const store = createAuthoritySessionContextStore();
    store.recordTimedOutWaitingForAnswer(
      "11111111-1111-1111-1111-111111111111",
      "existing_membership",
      "22222222-2222-2222-2222-222222222222",
    );

    const cleared = store.clearTimedOutIfRecovered("11111111-1111-1111-1111-111111111111", [
      {
        message_type: "answer",
        parent_message_id: "22222222-2222-2222-2222-222222222222",
      },
    ]);

    expect(cleared).toBe(true);
    expect(store.getGroupContext("11111111-1111-1111-1111-111111111111")).toBeUndefined();
  });

  it("builds completed as a response-only state with null expiry", () => {
    const store = createAuthoritySessionContextStore();
    const context = store.buildCompleted(
      "11111111-1111-1111-1111-111111111111",
      "existing_membership",
      "22222222-2222-2222-2222-222222222222",
    );
    const continuation = toAuthorityContinuation(context);

    expect(continuation).toEqual({
      state: "completed",
      scope: "group",
      lookup_key: null,
      group_id: "11111111-1111-1111-1111-111111111111",
      pending_join_id: null,
      membership_path: "existing_membership",
      question_id: "22222222-2222-2222-2222-222222222222",
      next_tool: null,
      expires_at: null,
    });
    expect(store.getGroupContext("11111111-1111-1111-1111-111111111111")).toBeUndefined();
  });
});
