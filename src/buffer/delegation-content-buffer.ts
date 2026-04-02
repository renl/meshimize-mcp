/**
 * DelegationContentBuffer — In-memory LRU store for transient delegation content (SQ-14).
 *
 * Stores `description` (from create) and `result` (from complete) keyed by delegation ID.
 * Content is never persisted — it exists in memory only for the current session.
 *
 * Eviction policy: LRU — least recently used entries are evicted first when capacity is exceeded.
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

  /** Stores description for a delegation. Creates entry if needed. Promotes to most-recently-used. */
  storeDescription(id: string, description: string): void {
    if (this.maxEntries === 0) return;
    const existing = this.entries.get(id);
    // Delete and re-insert to promote to most-recently-used (Map preserves insertion order)
    if (existing !== undefined) {
      this.entries.delete(id);
      this.entries.set(id, { ...existing, description });
    } else {
      this.evictIfNeeded();
      this.entries.set(id, { description });
    }
  }

  /** Stores result for a delegation. Creates entry if needed. Promotes to most-recently-used. */
  storeResult(id: string, result: string): void {
    if (this.maxEntries === 0) return;
    const existing = this.entries.get(id);
    // Delete and re-insert to promote to most-recently-used (Map preserves insertion order)
    if (existing !== undefined) {
      this.entries.delete(id);
      this.entries.set(id, { ...existing, result });
    } else {
      this.evictIfNeeded();
      this.entries.set(id, { result });
    }
  }

  /** Returns stored content without changing LRU order. */
  get(id: string): DelegationContent | undefined {
    return this.entries.get(id);
  }

  /** Removes an entry manually. */
  delete(id: string): void {
    this.entries.delete(id);
  }

  /** Evicts the least recently used entry if the buffer is at capacity. */
  private evictIfNeeded(): void {
    if (this.entries.size >= this.maxEntries) {
      // Map iteration order is insertion order — first key is the LRU entry
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) {
        this.entries.delete(firstKey);
      }
    }
  }
}
