/**
 * DelegationContentBuffer — Supplementary cache for delegation content.
 * Server is the primary source; buffer provides fallback enrichment.
 *
 * Stores `description` (from create) and `result` (from complete) keyed by delegation ID.
 * Content is cached in memory for the current session as a fallback when the server
 * returns null for content fields (e.g., stale read, content not yet reflected).
 *
 * Eviction policy: Least Recently Written — entries are ordered by their last write
 * (storeDescription / storeResult). Reads via `get()` do not promote entries.
 * When capacity is exceeded, the entry with the oldest write is evicted first.
 */

export interface DelegationContent {
  description?: string;
  result?: string;
}

export class DelegationContentBuffer {
  private entries: Map<string, DelegationContent> = new Map();
  private readonly maxEntries: number;

  constructor(maxEntries: number = 200) {
    if (!Number.isFinite(maxEntries) || !Number.isInteger(maxEntries) || maxEntries < 0) {
      throw new RangeError(`maxEntries must be a finite non-negative integer, got: ${maxEntries}`);
    }
    this.maxEntries = maxEntries;
  }

  /** Stores description for a delegation. Creates entry if needed. Promotes to most-recently-written. */
  storeDescription(id: string, description: string): void {
    if (this.maxEntries === 0) return;
    const existing = this.entries.get(id);
    // Delete and re-insert to promote to most-recently-written (Map preserves insertion order)
    if (existing !== undefined) {
      this.entries.delete(id);
      this.entries.set(id, { ...existing, description });
    } else {
      this.evictIfNeeded();
      this.entries.set(id, { description });
    }
  }

  /** Stores result for a delegation. Creates entry if needed. Promotes to most-recently-written. */
  storeResult(id: string, result: string): void {
    if (this.maxEntries === 0) return;
    const existing = this.entries.get(id);
    // Delete and re-insert to promote to most-recently-written (Map preserves insertion order)
    if (existing !== undefined) {
      this.entries.delete(id);
      this.entries.set(id, { ...existing, result });
    } else {
      this.evictIfNeeded();
      this.entries.set(id, { result });
    }
  }

  /** Returns a shallow copy of stored content. Does not affect eviction order. */
  get(id: string): DelegationContent | undefined {
    const value = this.entries.get(id);
    return value === undefined ? undefined : { ...value };
  }

  /** Removes an entry manually. */
  delete(id: string): void {
    this.entries.delete(id);
  }

  /** Evicts the least recently written entry if the buffer is at capacity. */
  private evictIfNeeded(): void {
    if (this.entries.size >= this.maxEntries) {
      // Map iteration order is insertion order — first key is the least recently written entry
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) {
        this.entries.delete(firstKey);
      }
    }
  }
}
