/**
 * Channel — represents a single channel subscription on a PhoenixSocket.
 *
 * Manages join/leave lifecycle, event handler registration,
 * and routes incoming server push events to registered handlers.
 */

import type { PhoenixReplyPayload } from "../types/channels.js";

export type ChannelState = "closed" | "joining" | "joined" | "leaving" | "errored";

/**
 * Interface that Channel uses to communicate with PhoenixSocket.
 * This decouples Channel from the concrete PhoenixSocket class.
 */
export interface SocketAdapter {
  makeRef(): string;
  sendJoin(joinRef: string, ref: string, topic: string): Promise<PhoenixReplyPayload>;
  sendLeave(joinRef: string | null, ref: string, topic: string): Promise<PhoenixReplyPayload>;
}

export class Channel {
  private topic: string;
  private socket: SocketAdapter;
  private state: ChannelState = "closed";
  private joinRef: string | null = null;
  private eventHandlers: Map<string, Array<(payload: unknown) => void>> = new Map();

  constructor(topic: string, socket: SocketAdapter) {
    this.topic = topic;
    this.socket = socket;
  }

  /** Resets channel state to closed without sending phx_leave. Used by socket on disconnect. */
  resetState(): void {
    this.state = "closed";
    this.joinRef = null;
  }

  /** Join the channel — sends phx_join, returns promise that resolves on ok reply. */
  async join(): Promise<Record<string, unknown>> {
    if (this.state === "joining" || this.state === "joined") {
      throw new Error(`Channel "${this.topic}" is already ${this.state}`);
    }
    this.state = "joining";
    this.joinRef = this.socket.makeRef();
    const ref = this.socket.makeRef();

    try {
      const reply = await this.socket.sendJoin(this.joinRef, ref, this.topic);
      if (reply.status === "ok") {
        this.state = "joined";
        return reply.response;
      } else {
        this.state = "errored";
        const response = reply.response as Record<string, unknown>;
        const reason = typeof response.reason === "string" ? response.reason : undefined;
        const details = reason ?? JSON.stringify(reply.response);
        throw new Error(
          `Channel join failed for topic "${this.topic}" | status="${reply.status}" | ${reason ? `reason="${reason}"` : `details=${details}`}`,
        );
      }
    } catch (err) {
      if (this.state === "joining") {
        this.state = "errored";
      }
      throw err;
    }
  }

  /** Leave the channel — sends phx_leave. */
  async leave(): Promise<void> {
    this.state = "leaving";
    const ref = this.socket.makeRef();

    try {
      await this.socket.sendLeave(this.joinRef, ref, this.topic);
    } finally {
      this.state = "closed";
      this.joinRef = null;
    }
  }

  /** Register an event handler for server push events. */
  on(event: string, handler: (payload: unknown) => void): void {
    const handlers = this.eventHandlers.get(event) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  /** Remove an event handler. */
  off(event: string, handler: (payload: unknown) => void): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    const idx = handlers.indexOf(handler);
    if (idx !== -1) {
      handlers.splice(idx, 1);
    }
    if (handlers.length === 0) {
      this.eventHandlers.delete(event);
    }
  }

  /** Called by PhoenixSocket when a message arrives for this channel's topic. */
  trigger(event: string, payload: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      handler(payload);
    }
  }

  /** Called by PhoenixSocket on reconnection to re-join the channel. */
  async rejoin(): Promise<Record<string, unknown>> {
    this.state = "closed";
    this.joinRef = null;
    return this.join();
  }

  getState(): ChannelState {
    return this.state;
  }

  getTopic(): string {
    return this.topic;
  }

  getJoinRef(): string | null {
    return this.joinRef;
  }
}
