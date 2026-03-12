import crypto from "node:crypto";
import type { PendingJoinRequest } from "../types/pending-joins.js";
import type { Config } from "../config.js";

export interface PendingJoinMap {
  add(group: PendingJoinRequest["group"]): PendingJoinRequest;
  getByGroupId(groupId: string): PendingJoinRequest | undefined;
  getById(id: string): PendingJoinRequest | undefined;
  remove(groupId: string): void;
  listPending(): PendingJoinRequest[];
  pruneExpired(): number;
  dispose(): void;
}

class PendingJoinMapImpl implements PendingJoinMap {
  private readonly map = new Map<string, PendingJoinRequest>();
  private readonly joinTimeoutMs: number;
  private readonly maxPendingJoins: number;
  private pruneInterval: ReturnType<typeof setInterval> | null;

  constructor(config: Config) {
    this.joinTimeoutMs = config.joinTimeoutMs;
    this.maxPendingJoins = config.maxPendingJoins;
    this.pruneInterval = setInterval(() => this.pruneExpired(), 60_000);
    this.pruneInterval.unref?.();
  }

  add(group: PendingJoinRequest["group"]): PendingJoinRequest {
    this.pruneExpired();

    // Idempotent: return existing entry if one exists for this group
    const existing = this.map.get(group.id);
    if (existing) {
      return existing;
    }

    if (this.map.size >= this.maxPendingJoins) {
      throw new Error(
        `Cannot add pending join request: maximum number of pending requests (${this.maxPendingJoins}) reached`,
      );
    }

    const now = Date.now();
    const request: PendingJoinRequest = {
      id: crypto.randomUUID(),
      group,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.joinTimeoutMs).toISOString(),
      status: "pending",
    };

    this.map.set(group.id, request);
    return request;
  }

  getByGroupId(groupId: string): PendingJoinRequest | undefined {
    this.pruneExpired();
    const entry = this.map.get(groupId);
    if (entry && entry.status !== "pending") {
      return undefined;
    }
    return entry;
  }

  getById(id: string): PendingJoinRequest | undefined {
    this.pruneExpired();
    for (const entry of this.map.values()) {
      if (entry.id === id) {
        return entry.status === "pending" ? entry : undefined;
      }
    }
    return undefined;
  }

  remove(groupId: string): void {
    this.map.delete(groupId);
  }

  listPending(): PendingJoinRequest[] {
    this.pruneExpired();
    const result: PendingJoinRequest[] = [];
    for (const entry of this.map.values()) {
      if (entry.status === "pending") {
        result.push(entry);
      }
    }
    return result;
  }

  pruneExpired(): number {
    let count = 0;
    const now = Date.now();
    for (const [groupId, entry] of this.map.entries()) {
      if (new Date(entry.expires_at).getTime() <= now) {
        entry.status = "expired";
        this.map.delete(groupId);
        count++;
      }
    }
    return count;
  }

  dispose(): void {
    if (this.pruneInterval !== null) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    this.map.clear();
  }
}

export function createPendingJoinMap(config: Config): PendingJoinMap {
  return new PendingJoinMapImpl(config);
}
