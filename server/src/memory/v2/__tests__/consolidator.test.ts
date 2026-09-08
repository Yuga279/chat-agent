import { describe, expect, it, vi } from "vitest";
import { MemoryConsolidator, type ConsolidationCandidate } from "../consolidator.js";
import type { MemoryRepository } from "../repository.js";
import type { MemoryItemRecord } from "../../types.js";
import { extractionProvenance, memoryItem } from "./fixtures.js";

/**
 * These tests cover the consolidator's *decisions* - capture, reinforce, supersede, reject - with
 * the repository stubbed at its public method boundary. The repository's own write semantics
 * (version chain, supersession direction, lifecycle) are tested against real logic in
 * repository.test.ts rather than re-asserted against a stub here.
 */
function fakeRepo(existing: MemoryItemRecord | null) {
  const findActiveItemByCanonicalKey = vi.fn(async () => existing);
  const upsertByCanonicalKey = vi.fn(async (input: Parameters<MemoryRepository["upsertByCanonicalKey"]>[0]) =>
    memoryItem({
      id: "new-id",
      kind: input.kind,
      subtype: input.subtype,
      canonicalKey: input.canonicalKey,
      object: input.object,
      confidence: input.confidence,
      importance: input.importance,
      version: (input.existing?.version ?? 0) + 1,
      supersedes: input.existing?.id ?? null,
    }),
  );
  const reinforceItem = vi.fn(async (item: MemoryItemRecord) => item);
  const recordRejection = vi.fn(async (..._args: Parameters<MemoryRepository["recordRejection"]>) => {});

  return {
    findActiveItemByCanonicalKey,
    upsertByCanonicalKey,
    reinforceItem,
    recordRejection,
  } as unknown as MemoryRepository & {
    findActiveItemByCanonicalKey: typeof findActiveItemByCanonicalKey;
    upsertByCanonicalKey: typeof upsertByCanonicalKey;
    reinforceItem: typeof reinforceItem;
    recordRejection: typeof recordRejection;
  };
}

const CANDIDATE: ConsolidationCandidate = {
  kind: "semantic",
  subtype: "fact",
  canonicalKey: "user.timezone",
  subject: "user",
  predicate: "timezone",
  object: "Asia/Kolkata",
  content: "user timezone: Asia/Kolkata",
  confidence: 0.9,
  importance: 0.7,
};

function input(repoCandidate: Partial<ConsolidationCandidate> = {}, provenanceOverrides = {}) {
  return {
    tenantId: "default",
    userId: "u1",
    scope: "user" as const,
    workspaceId: null,
    candidate: { ...CANDIDATE, ...repoCandidate },
    sourceEventIds: ["evt1"],
    provenance: extractionProvenance(provenanceOverrides),
  };
}

describe("MemoryConsolidator", () => {
  it("creates a new item when nothing exists under the canonical key", async () => {
    const repo = fakeRepo(null);
    const outcome = await new MemoryConsolidator(repo).consolidate(input());

    expect(outcome.action).toBe("created");
    expect(repo.upsertByCanonicalKey).toHaveBeenCalledTimes(1);
    expect(repo.reinforceItem).not.toHaveBeenCalled();
  });

  it("supersedes the existing item when the value actually changed", async () => {
    const repo = fakeRepo(memoryItem({ id: "old-id", object: "UTC", confidence: 0.7 }));

    const outcome = await new MemoryConsolidator(repo).consolidate(input({ object: "Asia/Kolkata" }));

    expect(outcome.action).toBe("updated");
    expect(repo.upsertByCanonicalKey).toHaveBeenCalledTimes(1);
    expect(repo.upsertByCanonicalKey.mock.calls[0][0].existing?.id).toBe("old-id");
  });

  it("reinforces instead of versioning when the same value is restated", async () => {
    // Repeating a fact is corroboration, not a change. Versioning it would grow an unbounded
    // insert/supersede chain describing a value that never moved.
    const repo = fakeRepo(memoryItem({ id: "old-id", object: "Asia/Kolkata", confidence: 0.7 }));

    const outcome = await new MemoryConsolidator(repo).consolidate(input({ object: "Asia/Kolkata" }));

    expect(outcome.action).toBe("reinforced");
    expect(repo.reinforceItem).toHaveBeenCalledTimes(1);
    expect(repo.upsertByCanonicalKey).not.toHaveBeenCalled();
  });

  it("reinforces even when the restatement is less confident than what is on file", async () => {
    // Still above the policy auto-capture floor - the gate runs first by design, so a restatement
    // below that floor is refused outright rather than reaching the reinforce path and extending a
    // stored memory's life on weak evidence.
    const repo = fakeRepo(memoryItem({ id: "old-id", object: "Asia/Kolkata", confidence: 0.95 }));

    const outcome = await new MemoryConsolidator(repo).consolidate(input({ object: "Asia/Kolkata", confidence: 0.7 }));

    expect(outcome.action).toBe("reinforced");
    expect(repo.upsertByCanonicalKey).not.toHaveBeenCalled();
  });

  it("refuses a restatement below the auto-capture floor rather than reinforcing on it", async () => {
    const repo = fakeRepo(memoryItem({ id: "old-id", object: "Asia/Kolkata", confidence: 0.9 }));

    const outcome = await new MemoryConsolidator(repo).consolidate(input({ object: "Asia/Kolkata", confidence: 0.3 }));

    expect(outcome.action).toBe("skipped_low_confidence");
    expect(repo.reinforceItem).not.toHaveBeenCalled();
  });

  it("refuses a lower-confidence contradiction from extraction", async () => {
    const repo = fakeRepo(memoryItem({ id: "old-id", object: "UTC", confidence: 0.95 }));

    const outcome = await new MemoryConsolidator(repo).consolidate(input({ object: "Asia/Kolkata", confidence: 0.65 }));

    expect(outcome.action).toBe("skipped_low_confidence");
    expect(repo.upsertByCanonicalKey).not.toHaveBeenCalled();
    expect(repo.recordRejection).toHaveBeenCalledTimes(1);
  });

  it("lets an explicit user statement override a more confident inferred value", async () => {
    // The user is the authority on their own facts, so an explicit tool call outranks worker
    // inference even when the inferred record claims higher confidence.
    const repo = fakeRepo(memoryItem({ id: "old-id", object: "UTC", confidence: 0.95 }));

    const outcome = await new MemoryConsolidator(repo).consolidate(
      input({ object: "Asia/Kolkata", confidence: 0.65 }, { sourceType: "explicit_tool", actorType: "user" }),
    );

    expect(outcome.action).toBe("updated");
    expect(repo.upsertByCanonicalKey).toHaveBeenCalledTimes(1);
  });

  it("blocks a sensitive candidate from auto-capture and audits the rejection", async () => {
    const repo = fakeRepo(null);

    const outcome = await new MemoryConsolidator(repo).consolidate(
      input({ canonicalKey: "user.card", object: "4111 1111 1111 1111" }),
    );

    expect(outcome.action).toBe("skipped_sensitive");
    expect(repo.upsertByCanonicalKey).not.toHaveBeenCalled();
    // A refused sensitive candidate used to vanish with no trace at all.
    expect(repo.recordRejection).toHaveBeenCalledTimes(1);
  });

  it("blocks a low-confidence candidate from auto-capture", async () => {
    const repo = fakeRepo(null);

    const outcome = await new MemoryConsolidator(repo).consolidate(input({ confidence: 0.3 }));

    expect(outcome.action).toBe("skipped_low_confidence");
    expect(repo.upsertByCanonicalKey).not.toHaveBeenCalled();
    expect(repo.recordRejection).toHaveBeenCalledTimes(1);
  });

  it("passes the resolved taxonomy through to the write", async () => {
    const repo = fakeRepo(null);

    await new MemoryConsolidator(repo).consolidate(input({ kind: "semantic", subtype: "preference" }));

    const written = repo.upsertByCanonicalKey.mock.calls[0][0];
    expect(written.kind).toBe("semantic");
    expect(written.subtype).toBe("preference");
    expect(written.provenance.sourceType).toBe("extraction");
  });

  it("refuses a secret outright, distinctly from merely-sensitive content", async () => {
    // A secret is strictly worse than "sensitive" - the outcome type itself distinguishes it, so
    // a caller (memoryTools.ts's explicit path) can refuse outright rather than offer a consent
    // prompt the way it does for a health/political fact.
    const repo = fakeRepo(null);

    const outcome = await new MemoryConsolidator(repo).consolidate(
      input({ canonicalKey: "user.api_key", object: "sk-abcdefghijklmnopqrstuvwx1234" }),
    );

    expect(outcome.action).toBe("skipped_secret");
    expect(repo.upsertByCanonicalKey).not.toHaveBeenCalled();
    expect(repo.recordRejection).toHaveBeenCalledTimes(1);
    expect(repo.recordRejection.mock.calls[0][3]).toMatch(/credential|secret/);
  });
});
