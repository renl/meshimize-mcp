import type { MeshimizeAPI } from "../api/client.js";
import type { GroupResponse } from "../types/groups.js";

export async function findMyGroupById(
  api: Pick<MeshimizeAPI, "getMyGroups">,
  groupId: string,
): Promise<GroupResponse | null> {
  let after: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await api.getMyGroups({ limit: 100, after });
    const group = page.data.find((candidate) => candidate.id === groupId);

    if (group) {
      return group;
    }

    hasMore = page.meta.has_more && page.meta.next_cursor !== null;
    after = page.meta.next_cursor ?? undefined;
  }

  return null;
}
