import type { ResolvedMembershipPath } from "../types/workflow.js";

export interface MembershipPathMap {
  markPostApprovalFirstAsk(groupId: string): void;
  resolve(groupId: string): ResolvedMembershipPath;
  consume(groupId: string): ResolvedMembershipPath;
  clear(groupId: string): void;
  clearAll(): void;
}

class MembershipPathMapImpl implements MembershipPathMap {
  private readonly postApprovalGroups = new Set<string>();

  markPostApprovalFirstAsk(groupId: string): void {
    this.postApprovalGroups.add(groupId);
  }

  resolve(groupId: string): ResolvedMembershipPath {
    return this.postApprovalGroups.has(groupId) ? "post_approval_first_ask" : "existing_membership";
  }

  consume(groupId: string): ResolvedMembershipPath {
    const resolved = this.resolve(groupId);
    if (resolved === "post_approval_first_ask") {
      this.postApprovalGroups.delete(groupId);
    }
    return resolved;
  }

  clear(groupId: string): void {
    this.postApprovalGroups.delete(groupId);
  }

  clearAll(): void {
    this.postApprovalGroups.clear();
  }
}

export function createMembershipPathMap(): MembershipPathMap {
  return new MembershipPathMapImpl();
}
