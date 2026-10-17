// Test-only real loopback HTTP/WS + production MCP stdio. Run in managed container.
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, it, expect } from "vitest";

const group = "11111111-1111-4111-8111-111111111111";
const identity = "22222222-2222-4222-8222-222222222222";
const metadata = {
  id: group,
  name: "Wire QA",
  description: null,
  type: "qa",
  my_role: null,
  owner: { id: identity, display_name: "Owner", verified: false },
  member_count: 1,
};
const page = (data: unknown[]) => ({
  data,
  meta: { has_more: false, next_cursor: null, count: data.length },
});

async function fixture(mode: "429" | "lost" | "delayed-error" | "ok") {
  const writes: Array<{ method: string; path: string; auth: string | undefined; body: string }> =
    [];
  let socket: WebSocket | undefined;
  let groupFrame: unknown[] | undefined;
  let notifyGroup!: () => void;
  const groupAttempt = new Promise<void>((resolve) => {
    notifyGroup = resolve;
  });
  let membership = false;
  const http = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      writes.push({ method: request.method, path, auth: request.headers.authorization, body });
      if (mode === "429") {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
        response.end(JSON.stringify({ error: { message: "Rate limited" } }));
        return;
      }
      membership = true;
      if (mode === "lost") {
        request.socket.destroy();
        return;
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ data: { group_id: group, agent_identity_id: identity, role: "member" } }),
      );
      socket!.send(
        JSON.stringify([
          null,
          null,
          `identity:${identity}`,
          "group_joined",
          { group_id: group, role: "member" },
        ]),
      );
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        path.endsWith("/account")
          ? {
              data: {
                id: identity,
                display_name: "Account",
                current_identity: { id: identity, display_name: "Acting", is_default: true },
              },
            }
          : path.endsWith("/discover/groups")
            ? page([metadata])
            : page([]),
      ),
    );
  });
  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as unknown[];
      if (frame[3] === "phx_join" && frame[2] === `group:${group}`) {
        groupFrame = frame;
        notifyGroup();
        if (mode !== "ok") return;
      }
      ws.send(
        JSON.stringify([frame[0], frame[1], frame[2], "phx_reply", { status: "ok", response: {} }]),
      );
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address() as { port: number };
  const client = new Client({ name: "wire-operator", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      PATH: process.env.PATH ?? "",
      MESHIMIZE_API_KEY: "wire-only-key",
      MESHIMIZE_BASE_URL: `http://127.0.0.1:${address.port}`,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {}); // Never emit credential-bearing diagnostics.
  async function call(name: string) {
    return client.callTool({ name, arguments: { group_id: group } }, undefined, { timeout: 4000 });
  }
  async function close() {
    await client.close();
    await transport.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
  try {
    await client.connect(transport, { timeout: 4000 });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    call,
    close,
    writes,
    groupAttempt,
    get membership() {
      return membership;
    },
    failReceiver() {
      if (groupFrame)
        socket!.send(
          JSON.stringify([
            groupFrame[0],
            groupFrame[1],
            groupFrame[2],
            "phx_reply",
            { status: "error", response: { reason: "not_a_member" } },
          ]),
        );
    },
  };
}

describe("US-PGI-8 §14.3.4–5 actual write and receiver boundary", () => {
  it.each(["429", "lost"] as const)(
    "%s outcome never repeats a join write",
    async (mode) => {
      const f = await fixture(mode);
      try {
        await f.call("join_group"); // Existing PUBLIC metadata; unknown branch not needed for this test.
        expect(f.writes).toHaveLength(0);
        const result = await f.call("approve_join");
        expect(result.isError).toBe(true);
        // Count actual received requests, not a mocked MeshimizeAPI method call.
        expect(f.writes).toEqual([
          {
            method: "POST",
            path: `/api/v1/groups/${group}/join`,
            auth: "Bearer wire-only-key",
            body: "",
          },
        ]);
        expect(JSON.stringify(result)).not.toContain('"state": "ready_to_ask"');
        if (mode === "lost") expect(f.membership).toBe(true); // Commit may have happened; no automatic replay.
      } finally {
        await f.close();
      }
    },
    10000,
  );

  it("delayed then failed actual group receiver cannot yield ready_to_ask", async () => {
    const f = await fixture("delayed-error");
    try {
      await f.call("join_group");
      let settled = false;
      const approval = f.call("approve_join").then((r) => {
        settled = true;
        return r;
      });
      await Promise.race([
        f.groupAttempt,
        delay(3000).then(() => {
          throw Error("No identity-event group join observed");
        }),
      ]);
      await delay(100); // Bounded negative window AFTER actual phx_join, before controlled reply.
      const early = settled;
      f.failReceiver();
      const result = await approval;
      expect(f.membership).toBe(true);
      expect(f.writes).toHaveLength(1);
      expect.soft(early, "approval returned before group receiver acknowledgement").toBe(false);
      const content = result.content as Array<{ text: string }>;
      const data = JSON.parse(content[0].text) as Record<string, unknown>;
      const text = JSON.stringify(data);
      expect.soft(data).not.toHaveProperty("authority_continuation.state", "ready_to_ask");
      expect.soft(text).toMatch(/membership.*(may|already)|may.*(joined|member)/i);
      expect.soft(text).toMatch(/(delivery|receiv|subscription).*(not ready|fail|unavailable)/i);
      // Contract specifies meaning, not a new readiness field/helper API/error wrapper.
    } finally {
      f.failReceiver();
      await f.close();
    }
  }, 10000);
});
