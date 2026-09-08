import { describe, expect, it, vi } from "vitest";
import { MemoryConsolidator } from "../consolidator.js";
import type { MemoryRepository } from "../repository.js";
import type { MemoryItemRecord } from "../../types.js";

function fakeRepo(existing: MemoryItemRecord | null) {
  const insertItem = vi.fn(async (item: Omit<MemoryItemRecord, "id" | "createdAt" | "updatedAt">) => ({
    ...item,
    id: "new-id",
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const supersedeItem = vi.fn(async (_oldId: string, _newId: string) => {});
  const recordRevision = vi.fn(
    async (
      _tenantId: string,
      _userId: string,
      _itemId: string,
      _action: string,
      _before: unknown,
      _after: unknown,
      _reason?: string | null,
    ) => {},
  );
  const findActiveItemByCanonicalKey = vi.fn(async () => existing);
  // Mirrors the real MemoryRepository.upsertByCanonicalKey's insert/supersede/revision sequence,
  // routed through this fake's own tracked mocks so assertions on them still work.
  const upsertByCanonicalKey = vi.fn(
    async ({
      existing: existingItem,
      revisionAction,
      revisionReason,
      ...fields
    }: Parameters<MemoryRepository["upsertByCanonicalKey"]>[0]) => {
      const item = await insertItem({
        ...fields,
        status: "active",
        supersedes: existingItem?.id ?? null,
        validFrom: new Date(),
        validTo: null,
        embedding: null,
        embeddingStatus: "pending",
      });
      if (existingItem) {
        await supersedeItem(existingItem.id, item.id);
        await recordRevision(fields.tenantId, fields.userId, existingItem.id, "superseded", existingItem, { supersedes: item.id });
      }
      await recordRevision(fields.tenantId, fields.userId, item.id, revisionAction, null, item, revisionReason ?? null);
      return item;
    },
  );
  return { insertItem, supersedeItem, recordRevision, findActiveItemByCanonicalKey, upsertByCanonicalKey } as unknown as MemoryRepository & {
    insertItem: typeof insertItem;
    supersedeItem: typeof supersedeItem;
    recordRevision: typeof recordRevision;
    findActiveItemByCanonicalKey: typeof findActiveItemByCanonicalKey;
    upsertByCanonicalKey: typeof upsertByCanonicalKey;
  };
}

const BASE_CANDIDATE = {
  kind: "fact" as const,
  canonicalKey: "user.timezone",
  subject: "user",
  predicate: "timezone",
  object: "Asia/Kolkata",
  content: "user timezone: Asia/Kolkata",
  confidence: 0.9,
  importance: 0.7,
};

describe("MemoryConsolidator", () => {
  it("creates a new item when nothing exists under the canonical key", async () => {
    const repo = fakeRepo(null);
    const consolidator = new MemoryConsolidator(repo);

    const outcome = await consolidator.consolidate({
      tenantId: "default",
      userId: "u1",
      scope: "user",
      workspaceId: null,
      candidate: BASE_CANDIDATE,
      sourceEventIds: ["evt1"],
    });

    expect(outcome.action).toBe("created");
    expect(repo.insertItem).toHaveBeenCalledTimes(1);
    expect(repo.supersedeItem).not.toHaveBeenCalled();
  });

  it("supersedes the existing active item under the same canonical key", async () => {
    const existing: MemoryItemRecord = {
      id: "old-id",
      tenantId: "default",
      userId: "u1",
      scope: "user",
      workspaceId: null,
      kind: "fact",
      canonicalKey: "user.timezone",
      subject: "user",
      predicate: "timezone",
      object: "UTC",
      content: "user timezone: UTC",
      confidence: 0.7,
      importance: 0.5,
      sensitivity: "none",
      status: "active",
      supersedes: null,
      validFrom: new Date(),
      validTo: null,
      sourceEventIds: ["evt0"],
      embedding: null,
      embeddingStatus: "done",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const repo = fakeRepo(existing);
    const consolidator = new MemoryConsolidator(repo);

    const outcome = await consolidator.consolidate({
      tenantId: "default",
      userId: "u1",
      scope: "user",
      workspaceId: null,
      candidate: BASE_CANDIDATE,
      sourceEventIds: ["evt1"],
    });

    expect(outcome.action).toBe("updated");
    expect(repo.supersedeItem).toHaveBeenCalledWith("old-id", "new-id");
  });

  it("blocks a sensitive candidate from auto-capture", async () => {
    const repo = fakeRepo(null);
    const consolidator = new MemoryConsolidator(repo);

    const outcome = await consolidator.consolidate({
      tenantId: "default",
      userId: "u1",
      scope: "user",
      workspaceId: null,
      candidate: { ...BASE_CANDIDATE, canonicalKey: "user.card", object: "4111 1111 1111 1111" },
      sourceEventIds: ["evt1"],
    });

    expect(outcome.action).toBe("skipped_sensitive");
    expect(repo.insertItem).not.toHaveBeenCalled();
  });

  it("blocks a low-confidence candidate from auto-capture", async () => {
    const repo = fakeRepo(null);
    const consolidator = new MemoryConsolidator(repo);

    const outcome = await consolidator.consolidate({
      tenantId: "default",
      userId: "u1",
      scope: "user",
      workspaceId: null,
      candidate: { ...BASE_CANDIDATE, confidence: 0.3 },
      sourceEventIds: ["evt1"],
    });

    expect(outcome.action).toBe("skipped_low_confidence");
    expect(repo.insertItem).not.toHaveBeenCalled();
  });
});
