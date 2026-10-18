// Test-only executable specification: US-PGI-8, architecture §14.2–14.3.
// Public MCP protocol with isolated API doubles; not real HTTP/WS eligibility proof.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { MeshimizeAPIError } from "../src/api/client.js";
import { createPendingJoinMap } from "../src/state/pending-joins.js";
import { createAuthoritySessionContextStore } from "../src/state/authority-session-context.js";
import { createMembershipPathMap } from "../src/state/membership-paths.js";
import {
  registerJoinGroup,
  registerApproveJoin,
  registerRejectJoin,
  registerListPendingJoins,
} from "../src/tools/groups.js";
import type { ToolDependencies } from "../src/tools/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const page = { data: [], meta: { has_more: false, next_cursor: null, count: 0 } };
const publicGroup = {
  id,
  name: "Public QA",
  description: "Public description",
  type: "qa",
  owner: { id: "22222222-2222-4222-8222-222222222222", display_name: "Owner", verified: false },
  member_count: 3,
};

describe("US-PGI-8 public MCP known-ID approval contract", () => {
  let client: Client;
  let server: McpServer;
  let pending: ReturnType<typeof createPendingJoinMap>;
  let context: ReturnType<typeof createAuthoritySessionContextStore>;
  let paths: ReturnType<typeof createMembershipPathMap>;
  const api = {
    getMyGroups: vi.fn(),
    searchGroups: vi.fn(),
    joinGroup: vi.fn(),
    getGroup: vi.fn(),
    postMessage: vi.fn(),
  };
  const channel = vi.fn();
  const record = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    api.getMyGroups.mockResolvedValue(page);
    api.searchGroups.mockResolvedValue(page);
    api.joinGroup.mockResolvedValue({ data: { group_id: id, role: "member" } });
    vi.stubEnv("MESHIMIZE_API_KEY", "test-only-key");
    const config = { ...loadConfig(), joinTimeoutMs: 600000 };
    context = createAuthoritySessionContextStore();
    paths = createMembershipPathMap();
    pending = createPendingJoinMap(config, {
      onRemoved: (p) => context.clearGroup(p.group_id),
      onExpired: (p) => context.clearGroup(p.group_id),
    });
    // Only the four registered tools below are exercised; no production test APIs.
    const deps = {
      api,
      socket: { channel },
      pendingJoins: pending,
      authoritySessionContext: context,
      membershipPaths: paths,
      workflowRecorder: { record },
      groupReceiver: {
        resetFailure: vi.fn(),
        waitForReady: vi.fn().mockResolvedValue({ status: "ready" }),
      },
    } as unknown as ToolDependencies;
    server = new McpServer({ name: "known-id-contract", version: "0.0.0" });
    registerJoinGroup(server, deps);
    registerApproveJoin(server, deps);
    registerRejectJoin(server, deps);
    registerListPendingJoins(server, deps);
    client = new Client({ name: "operator-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    pending?.dispose();
    await client?.close();
    await server?.close();
  });

  async function call(name: string, args: Record<string, unknown> = { group_id: id }) {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 2000 });
    const content = response.content as Array<{ type: string; text: string }>;
    const data = JSON.parse(content[0].text) as Record<string, unknown>;
    return { isError: response.isError === true, data };
  }

  function noAccess() {
    expect(api.joinGroup).not.toHaveBeenCalled();
    expect(api.getGroup).not.toHaveBeenCalled();
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
  }

  async function unknownPending() {
    const result = await call("join_group");
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      status: "pending_operator_approval",
      group: {
        id,
        metadata_source: "unknown",
        name: null,
        description: null,
        type: null,
        owner_name: null,
        owner_verified: null,
      },
      authority_continuation: {
        state: "join_approval_pending",
        group_id: id,
        next_tool: "approve_join",
      },
    });
    noAccess();
    return result.data;
  }

  it("unknown UUID gives honest null metadata and trusted-ID warning, never access", async () => {
    const data = await unknownPending();
    expect(data.message).toContain(id);
    expect(data.message).toMatch(/unverified|not verified/i);
    expect(data.message).toMatch(/trusted/i);
    expect(data.message).toMatch(/denied|fail/i);
    expect(data.message).not.toMatch(/\bnull\b|\bundefined\b/);
    expect(data.message).not.toMatch(/\bprivate\b|\bpublic\b|✓/i);
    expect(pending.getByGroupId(id)).toMatchObject({
      group_name: null,
      group_description: null,
      group_type: null,
      owner_display_name: null,
      owner_verified: null,
    });
    const stored = pending.getByGroupId(id) as unknown as Record<string, unknown>;
    expect(
      "owner_account_id" in stored ? stored.owner_account_id : stored.owner_identity_id,
    ).toBeNull();
    const event = record.mock.calls.find(([name]) => name === "authority_join_pending");
    expect(event?.[1]).toEqual({ group_id: id });
  });

  it("repeat and list preserve unknown branch, request identity and expiry", async () => {
    const first = await unknownPending();
    const before = pending.getByGroupId(id);
    const repeat = await call("join_group");
    expect(repeat.data).toMatchObject({
      status: "already_pending",
      pending_request_id: first.pending_request_id,
      group: first.group,
    });
    expect(pending.getByGroupId(id)?.expires_at).toBe(before?.expires_at);
    const list = await call("list_pending_joins", {});
    expect(list.data).toMatchObject({
      count: 1,
      pending_requests: [
        {
          group_id: id,
          metadata_source: "unknown",
          group_name: null,
          group_type: null,
          owner_name: null,
          owner_verified: null,
        },
      ],
    });
    noAccess();
  });

  it("reject removes unknown request without joining/subscribing", async () => {
    await unknownPending();
    const rejected = await call("reject_join");
    expect(rejected.isError).toBe(false);
    expect(JSON.stringify(rejected.data)).not.toMatch(/\bnull\b|\bundefined\b/);
    expect((await call("list_pending_joins", {})).data).toMatchObject({ count: 0 });
    expect((await call("approve_join")).isError).toBe(true);
    noAccess();
  });

  it("expiry cannot authorize a join", async () => {
    await unknownPending();
    const expires = pending.getByGroupId(id)!.expires_at;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expires) + 1);
    expect((await call("list_pending_joins", {})).data).toMatchObject({ count: 0 });
    expect((await call("approve_join")).isError).toBe(true);
    noAccess();
  });

  it.each([401, 403, 404, 429])(
    "approval HTTP %s keeps pending, never claims readiness",
    async (status) => {
      await unknownPending();
      const before = pending.getByGroupId(id);
      api.joinGroup.mockRejectedValue(new MeshimizeAPIError(status, { error: `HTTP ${status}` }));
      const result = await call("approve_join");
      expect(result.isError).toBe(true);
      expect(result.data).not.toHaveProperty("authority_continuation");
      expect(result.data).not.toHaveProperty("joined");
      expect(pending.getByGroupId(id)).toEqual(before);
      expect(api.joinGroup).toHaveBeenCalledTimes(1);
      expect(api.joinGroup).toHaveBeenCalledWith(id);
      expect(channel).not.toHaveBeenCalled();
    },
  );

  it.each([new Error("response lost"), new MeshimizeAPIError(500, { error: "uncertain" })])(
    "uncertain approval clears replayable pending, never claims readiness: %s",
    async (error) => {
      await unknownPending();
      api.joinGroup.mockRejectedValue(error);
      const result = await call("approve_join");
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.data)).toMatch(/membership may already exist/i);
      expect(result.data).not.toHaveProperty("authority_continuation");
      expect(result.data).not.toHaveProperty("joined");
      expect(pending.listPending()).toEqual([]);
      expect((await call("approve_join")).isError).toBe(true);
      expect(api.joinGroup).toHaveBeenCalledTimes(1);
      expect(channel).not.toHaveBeenCalled();
    },
  );

  it("fresh pending map is isolated from an existing map (support only)", async () => {
    await unknownPending();
    const fresh = createPendingJoinMap(loadConfig());
    try {
      expect(fresh.listPending()).toEqual([]);
    } finally {
      fresh.dispose();
    }
    // Actual process restart/key-change proof remains required integrated acceptance.
  });

  it("approval alone performs the one join, then removes pending and returns continuation", async () => {
    await unknownPending();
    const result = await call("approve_join");
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      joined: true,
      group_id: id,
      role: "member",
      authority_continuation: { state: "ready_to_ask", membership_path: "post_approval_first_ask" },
    });
    expect(api.joinGroup).toHaveBeenCalledTimes(1);
    expect(api.joinGroup).toHaveBeenCalledWith(id);
    expect(pending.getByGroupId(id)).toBeUndefined();
    expect(channel).not.toHaveBeenCalled(); // MCP receiver is identity-event driven.
  });

  it("public metadata is retained, including known false verification", async () => {
    api.searchGroups.mockResolvedValue({ ...page, data: [publicGroup] });
    const result = await call("join_group");
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      group: {
        id,
        metadata_source: "public_discovery",
        name: "Public QA",
        type: "qa",
        owner_name: "Owner",
        owner_verified: false,
      },
    });
    noAccess();
  });

  it("already-member preserves role without discovery or join", async () => {
    api.getMyGroups.mockResolvedValue({ ...page, data: [{ ...publicGroup, my_role: "owner" }] });
    expect((await call("join_group")).data).toMatchObject({
      status: "already_member",
      role: "owner",
    });
    expect(api.searchGroups).not.toHaveBeenCalled();
    noAccess();
  });

  it.each([
    "membership authentication",
    "discovery transport",
    "discovery rate-limit",
    "malformed discovery",
  ])("%s stays an error, not unknown success", async (failure) => {
    if (failure.startsWith("membership")) api.getMyGroups.mockRejectedValue(new Error(failure));
    else if (failure.startsWith("malformed")) api.searchGroups.mockResolvedValue({ data: null });
    else api.searchGroups.mockRejectedValue(new Error(failure));
    expect((await call("join_group")).isError).toBe(true);
    expect(pending.listPending()).toEqual([]);
    noAccess();
  });
});
