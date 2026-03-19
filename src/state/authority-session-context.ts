import type {
  AuthorityContinuation,
  AuthorityLookupKey,
  AuthoritySessionContext,
  AuthoritySessionState,
  ResolvedMembershipPath,
} from "../types/workflow.js";

const LOOKUP_CONTEXT_TTL_MS = 15 * 60 * 1000;
const READY_TO_ASK_TTL_MS = 10 * 60 * 1000;
const TIMED_OUT_WAITING_TTL_MS = 30 * 60 * 1000;

type LookupScopedAuthoritySessionState = "search_results_available" | "no_relevant_group_found";

function serializeLookupKey(lookupKey: AuthorityLookupKey): string {
  return JSON.stringify(lookupKey);
}

function nextToolForState(state: AuthoritySessionState): AuthorityContinuation["next_tool"] {
  switch (state) {
    case "join_approval_pending":
      return "approve_join";
    case "ready_to_ask":
      return "ask_question";
    case "timed_out_waiting_for_answer":
      return "get_messages";
    default:
      return null;
  }
}

function deriveScope(context: AuthoritySessionContext): AuthorityContinuation["scope"] {
  return context.lookup_key !== null ? "lookup" : "group";
}

function cloneContext(context: AuthoritySessionContext): AuthoritySessionContext {
  return {
    ...context,
    lookup_key: context.lookup_key === null ? null : { ...context.lookup_key },
  };
}

function toISOString(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

export interface AuthoritySessionContextStore {
  getLookupContext(lookupKey: AuthorityLookupKey): AuthoritySessionContext | undefined;
  getGroupContext(groupId: string): AuthoritySessionContext | undefined;
  recordLookupState(
    state: LookupScopedAuthoritySessionState,
    lookupKey: AuthorityLookupKey,
  ): AuthoritySessionContext;
  recordJoinApprovalPending(
    groupId: string,
    pendingJoinId: string,
    expiresAt: string,
  ): AuthoritySessionContext;
  recordReadyToAsk(
    groupId: string,
    membershipPath: "post_approval_first_ask",
  ): AuthoritySessionContext;
  recordTimedOutWaitingForAnswer(
    groupId: string,
    membershipPath: ResolvedMembershipPath,
    questionId: string,
  ): AuthoritySessionContext;
  buildCompleted(
    groupId: string,
    membershipPath: ResolvedMembershipPath,
    questionId: string,
  ): AuthoritySessionContext;
  clearLookup(lookupKey: AuthorityLookupKey): void;
  clearGroup(groupId: string): void;
  clearAll(): void;
  clearTimedOutIfRecovered(
    groupId: string,
    messages: Array<{ message_type?: string; parent_message_id?: string | null }>,
  ): boolean;
  pruneExpired(): number;
}

class AuthoritySessionContextStoreImpl implements AuthoritySessionContextStore {
  private readonly lookupContexts = new Map<string, AuthoritySessionContext>();
  private readonly groupContexts = new Map<string, AuthoritySessionContext>();

  getLookupContext(lookupKey: AuthorityLookupKey): AuthoritySessionContext | undefined {
    this.pruneExpired();
    const context = this.lookupContexts.get(serializeLookupKey(lookupKey));
    return context ? cloneContext(context) : undefined;
  }

  getGroupContext(groupId: string): AuthoritySessionContext | undefined {
    this.pruneExpired();
    const context = this.groupContexts.get(groupId);
    return context ? cloneContext(context) : undefined;
  }

  recordLookupState(
    state: LookupScopedAuthoritySessionState,
    lookupKey: AuthorityLookupKey,
  ): AuthoritySessionContext {
    this.pruneExpired();

    const key = serializeLookupKey(lookupKey);
    const now = Date.now();
    const existing = this.lookupContexts.get(key);
    const context: AuthoritySessionContext = {
      state,
      lookup_key: { ...lookupKey },
      group_id: null,
      pending_join_id: null,
      membership_path: null,
      question_id: null,
      created_at: existing?.created_at ?? toISOString(now),
      updated_at: toISOString(now),
      expires_at: toISOString(now + LOOKUP_CONTEXT_TTL_MS),
    };

    this.lookupContexts.set(key, context);
    return cloneContext(context);
  }

  recordJoinApprovalPending(
    groupId: string,
    pendingJoinId: string,
    expiresAt: string,
  ): AuthoritySessionContext {
    return this.upsertGroupContext(groupId, {
      state: "join_approval_pending",
      pending_join_id: pendingJoinId,
      membership_path: null,
      question_id: null,
      expires_at: expiresAt,
    });
  }

  recordReadyToAsk(
    groupId: string,
    membershipPath: "post_approval_first_ask",
  ): AuthoritySessionContext {
    const now = Date.now();

    return this.upsertGroupContext(groupId, {
      state: "ready_to_ask",
      pending_join_id: null,
      membership_path: membershipPath,
      question_id: null,
      expires_at: toISOString(now + READY_TO_ASK_TTL_MS),
    });
  }

  recordTimedOutWaitingForAnswer(
    groupId: string,
    membershipPath: ResolvedMembershipPath,
    questionId: string,
  ): AuthoritySessionContext {
    const now = Date.now();

    return this.upsertGroupContext(groupId, {
      state: "timed_out_waiting_for_answer",
      pending_join_id: null,
      membership_path: membershipPath,
      question_id: questionId,
      expires_at: toISOString(now + TIMED_OUT_WAITING_TTL_MS),
    });
  }

  buildCompleted(
    groupId: string,
    membershipPath: ResolvedMembershipPath,
    questionId: string,
  ): AuthoritySessionContext {
    this.pruneExpired();

    const now = Date.now();
    const existing = this.groupContexts.get(groupId);

    return {
      state: "completed",
      lookup_key: null,
      group_id: groupId,
      pending_join_id: null,
      membership_path: membershipPath,
      question_id: questionId,
      created_at: existing?.created_at ?? toISOString(now),
      updated_at: toISOString(now),
      expires_at: null,
    };
  }

  clearLookup(lookupKey: AuthorityLookupKey): void {
    this.lookupContexts.delete(serializeLookupKey(lookupKey));
  }

  clearGroup(groupId: string): void {
    this.groupContexts.delete(groupId);
  }

  clearAll(): void {
    this.lookupContexts.clear();
    this.groupContexts.clear();
  }

  clearTimedOutIfRecovered(
    groupId: string,
    messages: Array<{ message_type?: string; parent_message_id?: string | null }>,
  ): boolean {
    this.pruneExpired();

    const context = this.groupContexts.get(groupId);
    if (
      !context ||
      context.state !== "timed_out_waiting_for_answer" ||
      context.question_id === null
    ) {
      return false;
    }

    const recovered = messages.some(
      (message) =>
        message.message_type === "answer" && message.parent_message_id === context.question_id,
    );

    if (recovered) {
      this.groupContexts.delete(groupId);
      return true;
    }

    return false;
  }

  pruneExpired(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, context] of this.lookupContexts.entries()) {
      if (context.expires_at !== null && new Date(context.expires_at).getTime() <= now) {
        this.lookupContexts.delete(key);
        removed += 1;
      }
    }

    for (const [groupId, context] of this.groupContexts.entries()) {
      if (context.expires_at !== null && new Date(context.expires_at).getTime() <= now) {
        this.groupContexts.delete(groupId);
        removed += 1;
      }
    }

    return removed;
  }

  private upsertGroupContext(
    groupId: string,
    fields: Pick<
      AuthoritySessionContext,
      "state" | "pending_join_id" | "membership_path" | "question_id" | "expires_at"
    >,
  ): AuthoritySessionContext {
    this.pruneExpired();

    const now = Date.now();
    const existing = this.groupContexts.get(groupId);
    const context: AuthoritySessionContext = {
      state: fields.state,
      lookup_key: null,
      group_id: groupId,
      pending_join_id: fields.pending_join_id,
      membership_path: fields.membership_path,
      question_id: fields.question_id,
      created_at: existing?.created_at ?? toISOString(now),
      updated_at: toISOString(now),
      expires_at: fields.expires_at,
    };

    this.groupContexts.set(groupId, context);
    return cloneContext(context);
  }
}

export function createAuthoritySessionContextStore(): AuthoritySessionContextStore {
  return new AuthoritySessionContextStoreImpl();
}

export function toAuthorityContinuation(context: AuthoritySessionContext): AuthorityContinuation {
  return {
    state: context.state,
    scope: deriveScope(context),
    lookup_key: context.lookup_key === null ? null : { ...context.lookup_key },
    group_id: context.group_id,
    pending_join_id: context.pending_join_id,
    membership_path: context.membership_path,
    question_id: context.question_id,
    next_tool: nextToolForState(context.state),
    expires_at: context.expires_at,
  };
}
