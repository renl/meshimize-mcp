// US-PGI-8 / private-group-invitations §14.2–14.3. Public MCP, API doubles.
// Supporting prompt proof, not installed/private-answer acceptance.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createPendingJoinMap } from "../src/state/pending-joins.js";
import { createAuthoritySessionContextStore } from "../src/state/authority-session-context.js";
import { registerJoinGroup } from "../src/tools/groups.js";
import type { ToolDependencies } from "../src/tools/index.js";
const id = "11111111-1111-4111-8111-111111111111";
const page = { data: [], meta: { has_more: false, next_cursor: null } };
const corrected = `Group ID ${id}: details and eligibility are unverified. Compare this ID with a trusted source before approving. Approval only attempts the join and may be denied.`;
const broken =
  "A join request for this group is already pending operator approval. Ask your operator to approve it, then call `approve_join`.";
function warnings(message: string) {
  expect(message).toContain(id);
  expect(message).toMatch(/details[\s\S]*eligibility[\s\S]*(unverified|not verified)/i);
  expect(message).toMatch(/compare[\s\S]*\bid\b[\s\S]*trusted source[\s\S]*approv/i);
  expect(message).toMatch(/approval[\s\S]*only attempts?[\s\S]*join[\s\S]*may be denied/i);
}
it("corrected prompt independently satisfies every warning meaning", () => warnings(corrected));
it("current broken repeat is independently rejected", () => {
  expect(() => warnings(broken)).toThrow();
});
let client: Client;
let server: McpServer;
let pending: ReturnType<typeof createPendingJoinMap>;
const api = {
  getMyGroups: vi.fn(),
  searchGroups: vi.fn(),
  joinGroup: vi.fn(),
  getGroup: vi.fn(),
  postMessage: vi.fn(),
};
const channel = vi.fn();
beforeEach(async () => {
  vi.resetAllMocks();
  vi.stubEnv("MESHIMIZE_API_KEY", "test-only-key");
  api.getMyGroups.mockResolvedValue(page);
  api.searchGroups.mockResolvedValue(page);
  pending = createPendingJoinMap({ ...loadConfig(), joinTimeoutMs: 600000 });
  const deps = {
    api,
    pendingJoins: pending,
    authoritySessionContext: createAuthoritySessionContextStore(),
    workflowRecorder: { record: vi.fn() },
    socket: { channel },
  } as unknown as ToolDependencies;
  server = new McpServer({ name: "prompt-contract", version: "0.0.0" });
  registerJoinGroup(server, deps);
  client = new Client({ name: "operator", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
});
afterEach(async () => {
  pending?.dispose();
  await client?.close();
  await server?.close();
  vi.unstubAllEnvs();
});
async function call() {
  const result = await client.callTool(
    { name: "join_group", arguments: { group_id: id } },
    undefined,
    { timeout: 2000 },
  );
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}
it.each([false, true])(
  "unknown prompt has all warnings; repeat=%s without replay or writes",
  async (repeat) => {
    const first = await call();
    const stored = structuredClone(pending.getByGroupId(id));
    const data = repeat ? await call() : first;
    expect(data.status).toBe(repeat ? "already_pending" : "pending_operator_approval");
    expect(data.pending_request_id).toBe(first.pending_request_id);
    expect(data.group).toEqual({
      id,
      metadata_source: "unknown",
      name: null,
      description: null,
      type: null,
      owner_name: null,
      owner_verified: null,
    });
    expect(pending.getByGroupId(id)).toEqual(stored);
    expect(data.authority_continuation).toEqual(first.authority_continuation);
    expect(api.getMyGroups).toHaveBeenCalledTimes(1);
    expect(api.searchGroups).toHaveBeenCalledTimes(1);
    expect(api.joinGroup).not.toHaveBeenCalled();
    expect(api.getGroup).not.toHaveBeenCalled();
    expect(api.postMessage).not.toHaveBeenCalled();
    expect(channel).not.toHaveBeenCalled();
    warnings(data.message);
  },
);
