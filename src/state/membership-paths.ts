import type { ResolvedMembershipPath } from "../types/workflow.js";

export interface MembershipPathMap {
  markPostApprovalFirstAsk(groupId: string, expiresAt?: string): void;
  resolve(groupId: string): ResolvedMembershipPath;
  consume(groupId: string): ResolvedMembershipPath;
  clear(groupId: string): void;
  clearAll(): void;
}

class MembershipPathMapImpl implements MembershipPathMap {
  private readonly postApprovalGroups = new Map<string, string>();

  markPostApprovalFirstAsk(groupId: string, expiresAt?: string): void {
    const resolvedExpiresAt = expiresAt ?? new Date(Date.now() + 10 * 60 * 1000).toISOString();
    this.postApprovalGroups.set(groupId, resolvedExpiresAt);
  }

  resolve(groupId: string): ResolvedMembershipPath {
    this.pruneExpired();
    return this.postApprovalGroups.has(groupId) ? "post_approval_first_ask" : "existing_membership";
  }

  consume(groupId: string): ResolvedMembershipPath {
    const resolved = this.resolve(groupId);
    if (resolved === "post_approval_first_ask") {
      this.clear(groupId);
    }
    return resolved;
  }

  clear(groupId: string): void {
    this.postApprovalGroups.delete(groupId);
  }

  clearAll(): void {
    this.postApprovalGroups.clear();
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [groupId, expiresAt] of this.postApprovalGroups.entries()) {
      if (new Date(expiresAt).getTime() <= now) {
        this.postApprovalGroups.delete(groupId);
      }
    }
  }
}

export function createMembershipPathMap(): MembershipPathMap {
  return new MembershipPathMapImpl();
}
