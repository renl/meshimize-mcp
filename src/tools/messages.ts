import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDependencies } from "./index.js";
import { findMyGroupById } from "./my-groups.js";
import { toAuthorityContinuation } from "../state/authority-session-context.js";
import type { LateAnswerRecovery, MeshimizeAuthorityProvenance } from "../types/workflow.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildProvenance(
  group: {
    id: string;
    name: string;
    owner: { id: string; display_name: string; verified: boolean };
  },
  membershipPath: MeshimizeAuthorityProvenance["membership_path"],
): MeshimizeAuthorityProvenance {
  return {
    authority_source: "meshimize",
    invocation_path: "authority_group_live_work",
    membership_path: membershipPath,
    group_id: group.id,
    group_name: group.name,
    provider_account_id: group.owner.id,
    provider_display_name: group.owner.display_name,
    provider_verified: group.owner.verified,
  };
}

function buildLateAnswerRecovery(groupId: string, questionId: string): LateAnswerRecovery {
  return {
    retrieval_tool: "get_messages",
    group_id: groupId,
    after_message_id: questionId,
    match_parent_message_id: questionId,
    instructions:
      `Call \`get_messages\` with group_id "${groupId}" and after_message_id "${questionId}". ` +
      `Then inspect returned messages for message_type = "answer" and parent_message_id = "${questionId}".`,
  };
}

/**
 * Retrieves recent messages from a group. Reads from local buffer first (includes
 * full content). Falls back to server API which returns metadata only (no message content).
 */
export async function getMessagesHandler(
  args: { group_id: string; after_message_id?: string; limit?: number },
  deps: ToolDependencies,
) {
  const buffered = deps.buffer.getGroupMessages(args.group_id, {
    afterMessageId: args.after_message_id,
    limit: args.limit,
  });

  if (buffered.length > 0) {
    deps.authoritySessionContext.clearTimedOutIfRecovered(args.group_id, buffered);
    return { messages: buffered, source: "buffer" as const, has_more: false };
  }

  const result = await deps.api.getMessages(args.group_id, {
    after: args.after_message_id,
    limit: args.limit,
  });
  deps.authoritySessionContext.clearTimedOutIfRecovered(args.group_id, result.data);
  return { messages: result.data, source: "api" as const, has_more: result.meta.has_more };
}

/**
 * Sends a message to a group.
 */
export async function postMessageHandler(
  args: {
    group_id: string;
    content: string;
    message_type: "post" | "question" | "answer";
    parent_message_id?: string;
  },
  deps: ToolDependencies,
) {
  const result = await deps.api.postMessage(args.group_id, {
    content: args.content,
    message_type: args.message_type,
    parent_message_id: args.parent_message_id ?? null,
  });
  return { message: result.data };
}

/**
 * Posts a question to a Q&A group and waits for an answer via the local buffer.
 */
export async function askQuestionHandler(
  args: { group_id: string; question: string; timeout_seconds?: number },
  deps: ToolDependencies,
) {
  const group = await findMyGroupById(deps.api, args.group_id);

  if (!group) {
    throw new Error(
      "You are not currently a member of this group. First resolve access through the existing membership/discovery/join path before using `ask_question`.",
    );
  }

  if (group.type !== "qa") {
    throw new Error("`ask_question` is only valid for Q&A groups.");
  }

  const timeoutSeconds = args.timeout_seconds ?? 90;
  const membershipPath = deps.membershipPaths.consume(args.group_id);
  deps.authoritySessionContext.clearGroup(args.group_id);
  const provenance = buildProvenance(group, membershipPath);

  if (membershipPath === "post_approval_first_ask") {
    deps.workflowRecorder.record("authority_first_ask_after_approval", {
      group_id: args.group_id,
      group_name: group.name,
    });
  }

  const questionResult = await deps.api.postMessage(args.group_id, {
    content: args.question,
    message_type: "question",
    parent_message_id: null,
  });
  const questionId = questionResult.data.id;

  const timeoutMs = timeoutSeconds * 1000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const messages = deps.buffer.getGroupMessages(args.group_id, {
      messageType: "answer",
      parentMessageId: questionId,
    });
    const answer = messages.find((m) => m.message_type === "answer");
    if (answer) {
      const authorityContext = deps.authoritySessionContext.buildCompleted(
        args.group_id,
        membershipPath,
        questionId,
      );

      const result = {
        answered: true,
        question_id: questionId,
        group_id: args.group_id,
        timeout_seconds: timeoutSeconds,
        provenance,
        answer: {
          id: answer.id,
          content: answer.content,
          responder_account_id: answer.sender.id,
          responder_display_name: answer.sender.display_name,
          responder_verified: answer.sender.verified,
          created_at: answer.created_at,
        },
        authority_continuation: toAuthorityContinuation(authorityContext),
      };

      return result;
    }

    await sleep(500);
  }

  deps.workflowRecorder.record("authority_ask_timed_out", {
    group_id: args.group_id,
    question_id: questionId,
    membership_path: membershipPath,
  });

  const authorityContext = deps.authoritySessionContext.recordTimedOutWaitingForAnswer(
    args.group_id,
    membershipPath,
    questionId,
  );

  const result = {
    answered: false,
    question_id: questionId,
    group_id: args.group_id,
    timeout_seconds: timeoutSeconds,
    provenance,
    recovery: buildLateAnswerRecovery(args.group_id, questionId),
    message:
      `No answer received within ${timeoutSeconds}s. The question was posted successfully and the provider may still be processing. ` +
      "Use the recovery instructions to retrieve a late answer without re-asking.",
    authority_continuation: toAuthorityContinuation(authorityContext),
  };

  return result;
}

/**
 * Retrieves unanswered questions from Q&A groups where you are an owner or responder.
 * Reads from local buffer (includes content). Falls back to server API (metadata only).
 */
export async function getPendingQuestionsHandler(
  args: { group_id?: string; limit?: number },
  deps: ToolDependencies,
) {
  if (args.group_id) {
    const buffered = deps.buffer.getGroupMessages(args.group_id, {
      unanswered: true,
      limit: args.limit,
    });
    if (buffered.length > 0) {
      return { questions: buffered, source: "buffer" as const };
    }
    const result = await deps.api.getMessages(args.group_id, {
      unanswered: true,
      limit: args.limit,
    });
    return { questions: result.data, source: "api" as const };
  }

  const groupsResult = await deps.api.getMyGroups({ limit: 100 });
  const qaGroups = groupsResult.data.filter(
    (g) => g.type === "qa" && (g.my_role === "owner" || g.my_role === "responder"),
  );

  const perGroupResults = await Promise.all(
    qaGroups.map(async (group) => {
      const buffered = deps.buffer.getGroupMessages(group.id, {
        unanswered: true,
        limit: args.limit,
      });
      if (buffered.length > 0) {
        return { group_id: group.id, group_name: group.name, questions: buffered as unknown[] };
      }
      const result = await deps.api.getMessages(group.id, {
        unanswered: true,
        limit: args.limit,
      });
      if (result.data.length > 0) {
        return { group_id: group.id, group_name: group.name, questions: result.data as unknown[] };
      }
      return null;
    }),
  );

  const allQuestions = perGroupResults.filter(
    (r): r is { group_id: string; group_name: string; questions: unknown[] } => r !== null,
  );

  return { groups: allQuestions };
}

export function registerGetMessages(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "get_messages",
    "Retrieve recent messages from a group. Reads from local buffer first (includes full content). Falls back to server API which returns metadata only (no message content).",
    {
      group_id: z.string().uuid().describe("The UUID of the group"),
      after_message_id: z
        .string()
        .uuid()
        .optional()
        .describe("Return messages after this message ID (for pagination)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe("Max messages to return"),
    },
    async (args) => {
      try {
        const result = await getMessagesHandler(args, deps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

export function registerPostMessage(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "post_message",
    "Send a message to a group. Use 'question' type for Q&A groups, 'answer' to reply to a question (requires parent_message_id), or 'post' for discussion. Check `list_my_groups` first to confirm membership before posting.",
    {
      group_id: z.string().uuid().describe("The UUID of the group to post to"),
      content: z.string().min(1).max(32000).describe("The message content"),
      message_type: z.enum(["post", "question", "answer"]).describe("Type of message"),
      parent_message_id: z
        .string()
        .uuid()
        .optional()
        .describe("Required for 'answer' type — the question being answered"),
    },
    async (args) => {
      try {
        const result = await postMessageHandler(args, deps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

export function registerAskQuestion(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "ask_question",
    "Ask a membership-resolved Q&A group directly, including the first ask immediately after operator approval. This tool verifies current membership before posting, waits for a live answer in the local buffer, and returns Meshimize authority provenance on success. If no answer arrives in time, it returns recoverable timeout metadata so you can use `get_messages` to retrieve a late answer without re-asking. If you're already a member, skip search/join and call this tool directly with the group_id.",
    {
      group_id: z.string().uuid().describe("The UUID of the Q&A group"),
      question: z.string().min(1).max(32000).describe("The question to ask"),
      timeout_seconds: z
        .number()
        .int()
        .min(5)
        .max(300)
        .optional()
        .default(90)
        .describe("How long to wait for an answer (seconds)"),
    },
    async (args) => {
      try {
        const result = await askQuestionHandler(args, deps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}

export function registerGetPendingQuestions(server: McpServer, deps: ToolDependencies): void {
  server.tool(
    "get_pending_questions",
    "Retrieve unanswered questions from Q&A groups where you are an owner or responder. Reads from local buffer (includes content). Falls back to server API (metadata only).",
    {
      group_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Filter to a specific group. If omitted, returns questions from all your Q&A groups.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe("Max questions to return"),
    },
    async (args) => {
      try {
        const result = await getPendingQuestionsHandler(args, deps);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
