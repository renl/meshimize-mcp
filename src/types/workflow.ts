export type AuthorityLookupGroupType = "open_discussion" | "qa" | "announcement";

export interface AuthorityLookupKey {
  query_text: string;
  type_filter: AuthorityLookupGroupType | null;
}

export interface AuthorityLookupRecord {
  lookup_key: AuthorityLookupKey;
  decision: "no_relevant_group_found" | "candidate_groups_returned";
  group_ids: string[];
  recorded_at: string;
  expires_at: string;
}

export type ResolvedMembershipPath = "existing_membership" | "post_approval_first_ask";

export type AuthoritySessionState =
  | "search_results_available"
  | "no_relevant_group_found"
  | "join_approval_pending"
  | "ready_to_ask"
  | "timed_out_waiting_for_answer"
  | "completed";

export interface AuthoritySessionContext {
  state: AuthoritySessionState;
  lookup_key: AuthorityLookupKey | null;
  group_id: string | null;
  pending_join_id: string | null;
  membership_path: ResolvedMembershipPath | null;
  question_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface AuthorityContinuation {
  state: AuthoritySessionState;
  scope: "lookup" | "group";
  lookup_key: AuthorityLookupKey | null;
  group_id: string | null;
  pending_join_id: string | null;
  membership_path: ResolvedMembershipPath | null;
  question_id: string | null;
  next_tool: "approve_join" | "ask_question" | "get_messages" | null;
  expires_at: string | null;
}

export interface PendingJoinRequest {
  id: string;
  group_id: string;
  group_name: string;
  group_type: AuthorityLookupGroupType;
  group_description: string | null;
  owner_account_id: string;
  owner_display_name: string;
  owner_verified: boolean;
  created_at: string;
  expires_at: string;
}

export interface ApproveJoinResult {
  group_id: string;
  joined: true;
  membership_path_ready: "post_approval_first_ask";
  role: "member";
}

export interface MeshimizeAuthorityProvenance {
  authority_source: "meshimize";
  invocation_path: "authority_group_live_work";
  membership_path: ResolvedMembershipPath;
  group_id: string;
  group_name: string;
  provider_account_id: string;
  provider_display_name: string;
  provider_verified: boolean;
}

export interface LateAnswerRecovery {
  retrieval_tool: "get_messages";
  group_id: string;
  after_message_id: string;
  match_parent_message_id: string;
  instructions: string;
}

export interface AskQuestionAnsweredResult {
  answered: true;
  question_id: string;
  group_id: string;
  timeout_seconds: number;
  provenance: MeshimizeAuthorityProvenance;
  answer: {
    id: string;
    content: string;
    responder_account_id: string;
    responder_display_name: string;
    responder_verified: boolean;
    created_at: string;
  };
  authority_continuation: AuthorityContinuation;
}

export interface AskQuestionTimeoutResult {
  answered: false;
  question_id: string;
  group_id: string;
  timeout_seconds: number;
  provenance: MeshimizeAuthorityProvenance;
  recovery: LateAnswerRecovery;
  message: string;
  authority_continuation: AuthorityContinuation;
}

export type AskQuestionResult = AskQuestionAnsweredResult | AskQuestionTimeoutResult;

export type AuthorityWorkflowSignalName =
  | "authority_lookup_started"
  | "authority_lookup_zero_results"
  | "authority_lookup_repeat_suppressed"
  | "authority_join_pending"
  | "authority_join_approved"
  | "authority_first_ask_after_approval"
  | "authority_ask_timed_out";

export interface WorkflowSupportRecorder {
  record(signalName: AuthorityWorkflowSignalName, payload?: Record<string, unknown>): void;
}

export const noopWorkflowSupportRecorder: WorkflowSupportRecorder = {
  record: () => {
    // Intentionally empty. Production telemetry is optional for this slice.
  },
};
