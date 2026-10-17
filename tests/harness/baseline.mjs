// Baseline transport spike, NOT known-private-ID acceptance. Public API fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PhoenixSocket } from "../../dist/ws/client.js";
const base = "http://localhost:4000";

test(
  "candidate baseline: real stdio → public approval → identity event receiver → correlated QA; private unknown remains RED",
  { timeout: 120000 },
  async (t) => {
    assert.equal(process.env.TEST_DISPOSABLE_ENV, "true");
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).ok) break;
      } catch {}
      assert.ok(Date.now() < deadline, "server readiness timeout");
      await delay(500);
    }
    async function api(path, method = "GET", auth = {}, body, status = 200) {
      const r = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: { ...auth, "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(8000),
      });
      assert.equal(r.status, status, `${method} ${path} status only; bodies redacted`);
      return status === 204 ? null : r.json();
    }
    const nonce = randomUUID();
    const owner = await api(
      "/auth/register",
      "POST",
      {},
      {
        email: `mcp-${nonce}@example.com`,
        display_name: "Spike Owner",
        password: `Proof-${nonce}!`,
      },
      201,
    );
    const session = { "x-session-token": owner.token };
    const keys = [],
      groups = [];
    let client, transport, responder;
    t.after(async () => {
      try {
        await client?.close();
        await transport?.close();
        responder?.disconnect();
        for (const group of groups)
          await api(`/groups/${group}`, "DELETE", keys[0].auth, undefined, 204);
        for (const key of keys) await api(`/account/api-keys/${key.id}`, "DELETE", session);
        t.diagnostic(
          "CLEANUP public groups/keys and stdio/WS closed; outer container teardown destroys accounts/identities/DB.",
        );
      } finally {
        responder?.disconnect();
        await transport?.close();
      }
    });
    async function keyFor(identity) {
      const k = (
        await api(
          "/account/api-keys",
          "POST",
          session,
          { label: "Spike", ...(identity ? { agent_identity_id: identity } : {}) },
          201,
        )
      ).data;
      keys.push({ id: k.id, key: k.key, auth: { authorization: `Bearer ${k.key}` } });
      return keys.at(-1);
    }
    const creator = await keyFor();
    const actingId = (
      await api("/account/identities", "POST", session, { display_name: "Spike Acting" }, 201)
    ).data.id;
    const controlId = (
      await api("/account/identities", "POST", session, { display_name: "Spike Control" }, 201)
    ).data.id;
    const acting = await keyFor(actingId),
      control = await keyFor(controlId);
    async function group(visibility) {
      const g = (
        await api(
          "/groups",
          "POST",
          creator.auth,
          { name: `Spike ${visibility} ${nonce}`, type: "qa", visibility },
          201,
        )
      ).data.id;
      groups.push(g);
      return g;
    }
    const publicId = await group("public"),
      privateId = await group("private");
    await api(`/groups/${privateId}`, "GET", acting.auth, undefined, 404);
    await api(`/groups/${privateId}`, "GET", control.auth, undefined, 404);
    assert.equal(
      (await api(`/discover/groups?q=${privateId}`, "GET", acting.auth)).data.some(
        (g) => g.id === privateId,
      ),
      false,
    );
    t.diagnostic(
      "SETUP PASS: new account, creator-only groups, acting/control keys; private read/discovery denied before mutations.",
    );

    responder = new PhoenixSocket(
      `ws://localhost:4000/api/v1/ws/websocket?token=${encodeURIComponent(creator.key)}&vsn=2.0.0`,
      { maxReconnectAttempts: 0, logger: () => {} },
    );
    await responder.connect();
    const channel = responder.channel(`group:${publicId}`);
    let answerError;
    const fact = `wire-proof-${nonce}`;
    channel.on("new_message", (payload) => {
      const m = payload.data ?? payload;
      if (m.message_type === "question")
        api(
          `/groups/${publicId}/messages`,
          "POST",
          creator.auth,
          { content: fact, message_type: "answer", parent_message_id: m.id },
          201,
        ).catch((e) => {
          answerError = e;
        });
    });
    await channel.join();
    client = new Client({ name: "baseline-operator", version: "0.0.0" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: {
        PATH: process.env.PATH ?? "",
        MESHIMIZE_API_KEY: acting.key,
        MESHIMIZE_BASE_URL: base,
      },
      stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-16000);
    });
    await client.connect(transport, { timeout: 10000 });
    async function call(name, args = {}) {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
      return { isError: r.isError === true, data: JSON.parse(r.content[0].text) };
    }
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "approve_join"));
    assert.ok(
      diagnostics.includes(`identity:${actingId}`),
      "own MCP identity receiver established before approval",
    );
    const unknown = await call("join_group", { group_id: privateId });
    assert.equal(
      unknown.isError,
      true,
      "baseline known-private-ID limitation observed, NOT acceptance pass",
    );
    assert.equal((await api(`/groups/${privateId}/members`, "GET", creator.auth)).data.length, 1);
    t.diagnostic(
      "KNOWN-ID RED observation: baseline returns error for private nonmember; zero private membership. No fix required to run transport spike.",
    );
    const pending = await call("join_group", { group_id: publicId });
    assert.equal(pending.isError, false);
    assert.equal(pending.data.status, "pending_operator_approval");
    assert.equal((await api(`/groups/${publicId}/members`, "GET", creator.auth)).data.length, 1);
    const approved = await call("approve_join", { group_id: publicId });
    assert.equal(approved.isError, false);
    const readyDeadline = Date.now() + 5000;
    while (!diagnostics.includes(`Joined group:${publicId}`)) {
      assert.ok(Date.now() < readyDeadline, "MCP group receiver readiness");
      await delay(20);
    }
    const membership = (await api(`/groups/${publicId}/members`, "GET", creator.auth)).data;
    assert.ok(membership.some((m) => m.agent_identity_id === actingId && m.role === "member"));
    assert.ok(!membership.some((m) => m.agent_identity_id === controlId));
    const answer = await call("ask_question", {
      group_id: publicId,
      question: `Return spike fact ${nonce}`,
      timeout_seconds: 90,
    });
    assert.ifError(answerError);
    assert.equal(answer.isError, false);
    assert.equal(answer.data.answered, true);
    assert.equal(answer.data.answer.content, fact);
    assert.equal(answer.data.provenance.group_id, publicId);
    assert.equal(answer.data.provenance.membership_path, "post_approval_first_ask");
    assert.equal((await api("/groups", "GET", control.auth)).data.length, 0);
    t.diagnostic(
      "ASSERTION PASS: production stdio + real server HTTP/Phoenix-v2 identity event and own group receiver delivered correlated public QA. Not private unknown/accepted-other-account/full-feature proof.",
    );
  },
);
