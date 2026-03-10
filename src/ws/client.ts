/**
 * PhoenixSocket — Custom Phoenix Channels v2 wire protocol WebSocket client.
 *
 * Generic protocol client. Does NOT import or reference any Meshimize domain types
 * (MessageBuffer, MessageDataResponse, etc.). Domain wiring happens in a later slice.
 *
 * Wire format: [join_ref, ref, topic, event, payload] — 5-element JSON arrays.
 */

import WebSocket from "ws";
import type { PhoenixMessage, PhoenixReplyPayload } from "../types/channels.js";
import { Channel } from "./channel.js";
import type { SocketAdapter } from "./channel.js";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface PhoenixSocketOptions {
  heartbeatIntervalMs?: number; // default 30000
  reconnectIntervalMs?: number; // default 5000
  maxReconnectAttempts?: number; // default 10
  logger?: (level: "info" | "warn" | "error", msg: string) => void;
  onStateChange?: (state: ConnectionState) => void;
}

export class PhoenixSocket implements SocketAdapter {
  private url: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = "disconnected";
  private refCounter: number = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingHeartbeatRef: string | null = null;
  private channels: Map<string, Channel> = new Map();
  private pendingReplies: Map<string, (reply: PhoenixReplyPayload) => void> = new Map();
  private pendingRejects: Map<string, (err: Error) => void> = new Map();
  private reconnectAttempts: number = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect: boolean = false;

  private readonly heartbeatIntervalMs: number;
  private readonly reconnectIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly logger: (level: "info" | "warn" | "error", msg: string) => void;

  public onStateChange?: (state: ConnectionState) => void;

  constructor(url: string, options?: PhoenixSocketOptions) {
    this.url = url;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30000;
    this.reconnectIntervalMs = options?.reconnectIntervalMs ?? 5000;
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? 10;
    // ESLint no-console only allows console.error and console.warn (stdout reserved for MCP stdio),
    // so info-level messages are routed to console.error as a fallback.
    this.logger =
      options?.logger ??
      ((level, msg) => {
        if (level === "warn") {
          console.warn(msg);
        } else {
          console.error(msg);
        }
      });
    this.onStateChange = options?.onStateChange;
  }

  /** Opens the WebSocket connection. Resolves on open, rejects on error/close before open. */
  connect(): Promise<void> {
    if (this.state === "connected") {
      return Promise.resolve();
    }
    if (this.state === "connecting") {
      return Promise.reject(new Error("Connection already in progress"));
    }

    // Clear any pending reconnect timer to prevent duplicate connections
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;
    }

    return new Promise<void>((resolve, reject) => {
      this.intentionalDisconnect = false;
      this.setState("connecting");

      this.ws = new WebSocket(this.url);
      const ws = this.ws;

      this.ws.on("open", () => {
        if (ws !== this.ws) return;
        this.setState("connected");
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        if (ws !== this.ws) return;
        this.handleMessage(data);
      });

      this.ws.on("close", () => {
        if (ws !== this.ws) return;
        this.stopHeartbeat();
        this.ws = null;
        this.rejectAllPending();

        const wasConnecting = this.state === "connecting";

        if (wasConnecting) {
          // Connection failed before open — reject the connect() promise
          this.setState("disconnected");
          reject(new Error("WebSocket closed before connection established"));
        }

        if (!this.intentionalDisconnect) {
          // Schedule reconnect regardless of whether this was a connect() or established connection.
          // For initial connect() failures during a reconnect cycle, this ensures the next
          // reconnect attempt is scheduled (the catch in attemptReconnect logs but doesn't re-schedule).
          this.attemptReconnect();
        } else if (!wasConnecting) {
          this.setState("disconnected");
        }
      });

      this.ws.on("error", (err: Error) => {
        if (ws !== this.ws) return;
        this.logger("error", `WebSocket error: ${err.message}`);
        if (this.state === "connecting") {
          this.setState("disconnected");
          reject(err);
        }
      });
    });
  }

  /** Gracefully disconnects: sends phx_leave for all joined channels, stops heartbeat, closes socket. */
  disconnect(): void {
    this.intentionalDisconnect = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Send phx_leave for all joined channels
    for (const channel of this.channels.values()) {
      if (channel.getState() === "joined") {
        const ref = this.makeRef();
        const message: PhoenixMessage = [
          channel.getJoinRef(),
          ref,
          channel.getTopic(),
          "phx_leave",
          {},
        ];
        this.send(message);
      }
    }

    // Reset all channel states without sending (fire-and-forget leave already sent above)
    for (const channel of this.channels.values()) {
      channel.resetState();
    }

    this.stopHeartbeat();
    this.rejectAllPending();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState("disconnected");
  }

  /** Returns the current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Creates or returns an existing Channel for the given topic. Does NOT auto-join. */
  channel(topic: string): Channel {
    let ch = this.channels.get(topic);
    if (!ch) {
      ch = new Channel(topic, this);
      this.channels.set(topic, ch);
    }
    return ch;
  }

  // --- SocketAdapter implementation ---

  /** Generates a monotonically incrementing ref string. */
  makeRef(): string {
    this.refCounter++;
    return this.refCounter.toString();
  }

  /** Sends phx_join for a channel and returns a promise that resolves with the reply. */
  sendJoin(joinRef: string, ref: string, topic: string): Promise<PhoenixReplyPayload> {
    const message: PhoenixMessage = [joinRef, ref, topic, "phx_join", {}];
    return this.pushWithReply(ref, message);
  }

  /** Sends phx_leave for a channel and returns a promise that resolves with the reply. */
  sendLeave(joinRef: string | null, ref: string, topic: string): Promise<PhoenixReplyPayload> {
    const message: PhoenixMessage = [joinRef, ref, topic, "phx_leave", {}];
    return this.pushWithReply(ref, message);
  }

  // --- Internal methods ---

  private send(message: PhoenixMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    this.logger("warn", "Attempted to send message while socket is not open");
    return false;
  }

  private pushWithReply(ref: string, message: PhoenixMessage): Promise<PhoenixReplyPayload> {
    return new Promise<PhoenixReplyPayload>((resolve, reject) => {
      this.pendingReplies.set(ref, resolve);
      this.pendingRejects.set(ref, reject);
      const sent = this.send(message);
      if (!sent) {
        this.pendingReplies.delete(ref);
        this.pendingRejects.delete(ref);
        reject(new Error("WebSocket is not connected; message was not sent"));
      }
    });
  }

  private normalizeData(data: WebSocket.Data): string {
    if (typeof data === "string") return data;
    if (Buffer.isBuffer(data)) return data.toString("utf-8");
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
    if (Array.isArray(data)) return Buffer.concat(data).toString("utf-8");
    return String(data);
  }

  private handleMessage(data: WebSocket.Data): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.normalizeData(data));
    } catch {
      this.logger("error", "Failed to parse incoming WebSocket message");
      return;
    }

    if (!Array.isArray(parsed) || parsed.length !== 5) {
      this.logger("warn", "Received invalid Phoenix message frame shape");
      return;
    }

    const [joinRef, ref, topic, event, payload] = parsed as PhoenixMessage;

    if (event === "phx_reply") {
      this.handleReply(ref, payload as PhoenixReplyPayload);
      return;
    }

    if (event === "phx_error") {
      this.handleChannelError(topic, payload);
      return;
    }

    if (event === "phx_close") {
      this.handleChannelClose(topic, payload);
      return;
    }

    // Route server push events to the channel, validating join_ref to drop stale pushes.
    // Lifecycle events (phx_error, phx_close) and phx_reply are authoritative and always delivered.
    const channel = this.channels.get(topic);
    if (channel) {
      if (joinRef !== null && joinRef !== channel.getJoinRef()) {
        this.logger(
          "warn",
          `Dropping stale push for topic "${topic}" event "${event}": ` +
            `join_ref ${joinRef} does not match current ${channel.getJoinRef()}`,
        );
        return;
      }
      channel.trigger(event, payload);
    }
  }

  private handleReply(ref: string | null, payload: PhoenixReplyPayload): void {
    if (!ref) return;

    // Check if this is a heartbeat reply
    if (this.pendingHeartbeatRef === ref) {
      this.pendingHeartbeatRef = null;
    }

    const resolve = this.pendingReplies.get(ref);
    if (resolve) {
      this.pendingReplies.delete(ref);
      this.pendingRejects.delete(ref);
      resolve(payload);
    }
  }

  private handleChannelError(topic: string, payload: unknown = {}): void {
    const channel = this.channels.get(topic);
    if (channel) {
      channel.trigger("phx_error", payload);
    }
  }

  private handleChannelClose(topic: string, payload: unknown = {}): void {
    const channel = this.channels.get(topic);
    if (channel) {
      channel.trigger("phx_close", payload);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // If a pending heartbeat wasn't acknowledged, connection is dead
      if (this.pendingHeartbeatRef !== null) {
        this.logger("warn", "Heartbeat timeout — connection appears dead");
        this.pendingHeartbeatRef = null;
        if (this.ws) {
          this.ws.close();
        }
        return;
      }

      const ref = this.makeRef();
      this.pendingHeartbeatRef = ref;
      const message: PhoenixMessage = [null, ref, "phoenix", "heartbeat", {}];
      this.send(message);
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pendingHeartbeatRef = null;
  }

  private rejectAllPending(): void {
    for (const [ref, reject] of this.pendingRejects) {
      reject(new Error("WebSocket connection closed"));
      this.pendingReplies.delete(ref);
    }
    this.pendingRejects.clear();
    this.pendingReplies.clear();
  }

  private attemptReconnect(): void {
    if (this.intentionalDisconnect) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger("error", `Max reconnect attempts (${this.maxReconnectAttempts}) reached`);
      this.setState("disconnected");
      return;
    }

    // Clear any existing reconnect timer to prevent duplicate concurrent connect attempts
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.setState("reconnecting");
    this.reconnectAttempts++;
    const delay = this.reconnectIntervalMs * this.reconnectAttempts;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        // Re-join all channels that were previously joined
        const rejoinPromises: Promise<unknown>[] = [];
        for (const channel of this.channels.values()) {
          if (
            channel.getState() === "joined" ||
            channel.getState() === "errored" ||
            channel.getState() === "joining"
          ) {
            rejoinPromises.push(
              channel.rejoin().catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger("error", `Failed to rejoin channel ${channel.getTopic()}: ${msg}`);
              }),
            );
          }
        }
        await Promise.all(rejoinPromises);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger("error", `Reconnect attempt ${this.reconnectAttempts} failed: ${msg}`);
        // attemptReconnect will be called again by the close handler
      }
    }, delay);
  }

  private setState(newState: ConnectionState): void {
    this.state = newState;
    this.onStateChange?.(newState);
  }
}
