import type {
  AuthorityLookupGroupType,
  AuthorityLookupKey,
  AuthorityLookupRecord,
} from "../types/workflow.js";

const DEFAULT_AUTHORITY_LOOKUP_TTL_MS = 10 * 60 * 1000;

export interface AuthorityLookupMap {
  get(lookupKey: AuthorityLookupKey): AuthorityLookupRecord | undefined;
  record(
    lookupKey: AuthorityLookupKey,
    decision: AuthorityLookupRecord["decision"],
    groupIds: string[],
  ): AuthorityLookupRecord;
  pruneExpired(): number;
  dispose(): void;
}

function serializeLookupKey(lookupKey: AuthorityLookupKey): string {
  return JSON.stringify(lookupKey);
}

export function normalizeAuthorityLookupKey(input: {
  query?: string;
  type?: AuthorityLookupGroupType;
}): AuthorityLookupKey {
  return {
    query_text: (input.query ?? "").trim().toLowerCase(),
    type_filter: input.type ?? null,
  };
}

class AuthorityLookupMapImpl implements AuthorityLookupMap {
  private readonly records = new Map<string, AuthorityLookupRecord>();

  constructor(private readonly ttlMs: number) {}

  get(lookupKey: AuthorityLookupKey): AuthorityLookupRecord | undefined {
    this.pruneExpired();
    return this.records.get(serializeLookupKey(lookupKey));
  }

  record(
    lookupKey: AuthorityLookupKey,
    decision: AuthorityLookupRecord["decision"],
    groupIds: string[],
  ): AuthorityLookupRecord {
    this.pruneExpired();
    const now = Date.now();
    const record: AuthorityLookupRecord = {
      lookup_key: lookupKey,
      decision,
      group_ids: [...groupIds],
      recorded_at: new Date(now).toISOString(),
      expires_at: new Date(now + this.ttlMs).toISOString(),
    };

    this.records.set(serializeLookupKey(lookupKey), record);
    return record;
  }

  pruneExpired(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, record] of this.records.entries()) {
      if (new Date(record.expires_at).getTime() <= now) {
        this.records.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  dispose(): void {
    this.records.clear();
  }
}

export function createAuthorityLookupMap(options?: { ttlMs?: number }): AuthorityLookupMap {
  return new AuthorityLookupMapImpl(options?.ttlMs ?? DEFAULT_AUTHORITY_LOOKUP_TTL_MS);
}
