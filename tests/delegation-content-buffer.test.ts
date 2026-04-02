import { describe, it, expect } from "vitest";
import { DelegationContentBuffer } from "../src/buffer/delegation-content-buffer.js";

describe("DelegationContentBuffer", () => {
  // --- Basic storeDescription ---

  it("storeDescription stores and retrieves description", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.storeDescription("d-1", "Do this task");

    const content = buffer.get("d-1");
    expect(content).toEqual({ description: "Do this task" });
  });

  it("storeDescription overwrites existing description", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.storeDescription("d-1", "Original");
    buffer.storeDescription("d-1", "Updated");

    expect(buffer.get("d-1")).toEqual({ description: "Updated" });
  });

  // --- Basic storeResult ---

  it("storeResult stores and retrieves result", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.storeResult("d-1", "Task completed");

    const content = buffer.get("d-1");
    expect(content).toEqual({ result: "Task completed" });
  });

  it("storeResult overwrites existing result", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.storeResult("d-1", "Original result");
    buffer.storeResult("d-1", "Updated result");

    expect(buffer.get("d-1")).toEqual({ result: "Updated result" });
  });

  // --- Mixed description + result ---

  it("storeResult on existing entry preserves description", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.storeDescription("d-1", "Do this task");
    buffer.storeResult("d-1", "Done");

    expect(buffer.get("d-1")).toEqual({ description: "Do this task", result: "Done" });
  });

  it("storeDescription on existing entry preserves result", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.storeResult("d-1", "Done");
    buffer.storeDescription("d-1", "The task description");

    expect(buffer.get("d-1")).toEqual({ description: "The task description", result: "Done" });
  });

  // --- get returns undefined for unknown ---

  it("get returns undefined for unknown IDs", () => {
    const buffer = new DelegationContentBuffer(10);
    expect(buffer.get("nonexistent")).toBeUndefined();
  });

  it("get does not change LRU order", () => {
    const buffer = new DelegationContentBuffer(3);
    buffer.storeDescription("d-1", "First");
    buffer.storeDescription("d-2", "Second");
    buffer.storeDescription("d-3", "Third");

    // Access d-1 via get — should NOT promote it
    buffer.get("d-1");

    // Adding a new entry should evict d-1 (the LRU), not d-2
    buffer.storeDescription("d-4", "Fourth");

    expect(buffer.get("d-1")).toBeUndefined();
    expect(buffer.get("d-2")).toEqual({ description: "Second" });
    expect(buffer.get("d-3")).toEqual({ description: "Third" });
    expect(buffer.get("d-4")).toEqual({ description: "Fourth" });
  });

  // --- delete ---

  it("delete removes an entry", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.storeDescription("d-1", "Task");
    buffer.delete("d-1");

    expect(buffer.get("d-1")).toBeUndefined();
  });

  it("delete on nonexistent ID is a no-op", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.delete("nonexistent"); // Should not throw
    expect(buffer.get("nonexistent")).toBeUndefined();
  });

  // --- LRU eviction ---

  it("evicts least recently used entry when at capacity", () => {
    const buffer = new DelegationContentBuffer(3);
    buffer.storeDescription("d-1", "First");
    buffer.storeDescription("d-2", "Second");
    buffer.storeDescription("d-3", "Third");

    // Buffer is full. Adding d-4 should evict d-1 (LRU).
    buffer.storeDescription("d-4", "Fourth");

    expect(buffer.get("d-1")).toBeUndefined();
    expect(buffer.get("d-2")).toEqual({ description: "Second" });
    expect(buffer.get("d-3")).toEqual({ description: "Third" });
    expect(buffer.get("d-4")).toEqual({ description: "Fourth" });
  });

  it("storeDescription promotes entry to most-recently-used", () => {
    const buffer = new DelegationContentBuffer(3);
    buffer.storeDescription("d-1", "First");
    buffer.storeDescription("d-2", "Second");
    buffer.storeDescription("d-3", "Third");

    // Touch d-1 by storing description again — promotes to MRU
    buffer.storeDescription("d-1", "First updated");

    // Now d-2 is LRU. Adding d-4 should evict d-2.
    buffer.storeDescription("d-4", "Fourth");

    expect(buffer.get("d-1")).toEqual({ description: "First updated" });
    expect(buffer.get("d-2")).toBeUndefined();
    expect(buffer.get("d-3")).toEqual({ description: "Third" });
    expect(buffer.get("d-4")).toEqual({ description: "Fourth" });
  });

  it("storeResult promotes entry to most-recently-used", () => {
    const buffer = new DelegationContentBuffer(3);
    buffer.storeDescription("d-1", "First");
    buffer.storeDescription("d-2", "Second");
    buffer.storeDescription("d-3", "Third");

    // Touch d-1 by storing result — promotes to MRU
    buffer.storeResult("d-1", "Result for first");

    // Now d-2 is LRU. Adding d-4 should evict d-2.
    buffer.storeDescription("d-4", "Fourth");

    expect(buffer.get("d-1")).toEqual({ description: "First", result: "Result for first" });
    expect(buffer.get("d-2")).toBeUndefined();
    expect(buffer.get("d-3")).toEqual({ description: "Third" });
    expect(buffer.get("d-4")).toEqual({ description: "Fourth" });
  });

  it("eviction cascade — multiple entries evicted in LRU order", () => {
    const buffer = new DelegationContentBuffer(2);
    buffer.storeDescription("d-1", "First");
    buffer.storeDescription("d-2", "Second");

    // Add d-3 — evicts d-1
    buffer.storeDescription("d-3", "Third");
    expect(buffer.get("d-1")).toBeUndefined();
    expect(buffer.get("d-2")).toEqual({ description: "Second" });

    // Add d-4 — evicts d-2
    buffer.storeDescription("d-4", "Fourth");
    expect(buffer.get("d-2")).toBeUndefined();
    expect(buffer.get("d-3")).toEqual({ description: "Third" });
    expect(buffer.get("d-4")).toEqual({ description: "Fourth" });
  });

  // --- Capacity 1 ---

  it("capacity 1 — only keeps latest entry", () => {
    const buffer = new DelegationContentBuffer(1);
    buffer.storeDescription("d-1", "First");
    buffer.storeDescription("d-2", "Second");

    expect(buffer.get("d-1")).toBeUndefined();
    expect(buffer.get("d-2")).toEqual({ description: "Second" });
  });

  it("capacity 1 — updating same entry does not evict it", () => {
    const buffer = new DelegationContentBuffer(1);
    buffer.storeDescription("d-1", "First");
    buffer.storeResult("d-1", "Done");

    expect(buffer.get("d-1")).toEqual({ description: "First", result: "Done" });
  });

  // --- Capacity 0 ---

  it("capacity 0 — stores nothing", () => {
    const buffer = new DelegationContentBuffer(0);
    buffer.storeDescription("d-1", "First");

    expect(buffer.get("d-1")).toBeUndefined();
  });

  // --- Constructor validation ---

  it("throws RangeError for negative maxEntries", () => {
    expect(() => new DelegationContentBuffer(-1)).toThrow(RangeError);
  });

  it("throws RangeError for non-integer maxEntries", () => {
    expect(() => new DelegationContentBuffer(3.5)).toThrow(RangeError);
  });

  it("throws RangeError for NaN maxEntries", () => {
    expect(() => new DelegationContentBuffer(NaN)).toThrow(RangeError);
  });

  it("throws RangeError for Infinity maxEntries", () => {
    expect(() => new DelegationContentBuffer(Infinity)).toThrow(RangeError);
  });

  it("throws RangeError for -Infinity maxEntries", () => {
    expect(() => new DelegationContentBuffer(-Infinity)).toThrow(RangeError);
  });

  // --- Multiple independent entries ---

  it("maintains independent entries for different delegation IDs", () => {
    const buffer = new DelegationContentBuffer(10);
    buffer.storeDescription("d-1", "Task A");
    buffer.storeDescription("d-2", "Task B");
    buffer.storeResult("d-1", "Result A");

    expect(buffer.get("d-1")).toEqual({ description: "Task A", result: "Result A" });
    expect(buffer.get("d-2")).toEqual({ description: "Task B" });
  });

  // --- Default constructor ---

  it("uses default maxEntries of 200", () => {
    const buffer = new DelegationContentBuffer();
    // Add 201 entries; first should be evicted
    for (let i = 0; i < 201; i++) {
      buffer.storeDescription(`d-${i}`, `Desc ${i}`);
    }
    expect(buffer.get("d-0")).toBeUndefined();
    expect(buffer.get("d-1")).toEqual({ description: "Desc 1" });
    expect(buffer.get("d-200")).toEqual({ description: "Desc 200" });
  });
});
