import { describe, expect, it, vi } from "vitest";
import { MemorySummarizer } from "../summarizer.js";
import type { MemoryRepository } from "../repository.js";
import type { MemoryItemRecord } from "../../types.js";
import { memoryItem } from "./fixtures.js";

function item(content: string, importance: number): MemoryItemRecord {
  return memoryItem({ id: content, subtype: "preference", canonicalKey: content, content, importance });
}

describe("MemorySummarizer.refreshProfileCard", () => {
  it("writes a bullet card built from the top-importance items, no LLM call involved", async () => {
    const items = [item("prefers dark mode", 0.9), item("uses metric units", 0.7)];
    const listTopItems = vi.fn(async () => items);
    const upsertSummary = vi.fn(async (_summary: unknown) => {});
    const repo = { listTopItems, upsertSummary } as unknown as MemoryRepository;

    const summarizer = new MemorySummarizer(repo);
    await summarizer.refreshProfileCard("default", "u1", "user", null);

    expect(upsertSummary).toHaveBeenCalledTimes(1);
    const written = upsertSummary.mock.calls[0]?.[0] as { scope: string; scopeRef: string | null; content: string };
    expect(written.scope).toBe("user");
    expect(written.scopeRef).toBeNull();
    expect(written.content).toContain("prefers dark mode");
    expect(written.content).toContain("uses metric units");
  });

  it("writes nothing when there are no active items in scope", async () => {
    const listTopItems = vi.fn(async () => []);
    const upsertSummary = vi.fn(async () => {});
    const repo = { listTopItems, upsertSummary } as unknown as MemoryRepository;

    const summarizer = new MemorySummarizer(repo);
    await summarizer.refreshProfileCard("default", "u1", "workspace", "ws1");

    expect(upsertSummary).not.toHaveBeenCalled();
  });
});
