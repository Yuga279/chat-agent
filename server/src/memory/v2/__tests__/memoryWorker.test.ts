import { describe, expect, it, vi } from "vitest";
import { MemoryWorker } from "../memoryWorker.js";
import type { MemoryEventRecord } from "../../types.js";

/** processBatch is private - reached via `as any`, the same pattern retriever.test.ts uses for
 * fuseAndBudget, since it's the one piece of worker logic with real per-event branching worth
 * testing directly rather than only through the full tick()/findEligibleGroup machinery. */
function callProcessBatch(worker: MemoryWorker, events: MemoryEventRecord[]) {
  return (worker as any).processBatch(events);
}

function event(overrides: Partial<MemoryEventRecord> = {}): MemoryEventRecord {
  return {
    id: overrides.id ?? "evt",
    tenantId: "default",
    userId: "u1",
    threadId: "t1",
    workspaceId: null,
    turnId: overrides.id ?? "turn",
    userText: "do something",
    assistantText: "done",
    toolSummaries: [{ toolName: "start_time_entry", status: "success", startedAt: new Date(), durationMs: 10 }],
    goalId: null,
    stepIndex: null,
    status: "processing",
    attempts: 0,
    lastError: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: new Date(Date.now() + 60_000),
    nextAttemptAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeRepo() {
  return {
    markEventsDone: vi.fn(async (_ids: string[]) => {}),
    failEvent: vi.fn(async (_id: string, _error: string, _maxAttempts: number) => {}),
    listPendingEmbeddings: vi.fn(async () => [] as never[]),
  };
}

describe("MemoryWorker.processBatch - per-event failure isolation", () => {
  it("marks only the failing event's id failed, and every other event in the batch done", async () => {
    // Regression test for H2: previously any error inside the batch's consolidation loop was
    // caught by one outer try/catch that dead-lettered *every* event in the batch together - a
    // single poison event could take healthy, unrelated events down with it.
    const good = event({ id: "good" });
    const bad = event({ id: "bad" });

    const repo = fakeRepo();
    const extractor = { extractFromEvents: vi.fn(async () => []) };
    const consolidator = {
      consolidate: vi.fn(async (input: { sourceEventIds: string[] }) => {
        if (input.sourceEventIds.includes("bad")) throw new Error("simulated consolidation failure");
        return { action: "created" };
      }),
    };
    const summarizer = { refreshThreadSummary: vi.fn(async () => {}), refreshProfileCard: vi.fn(async () => {}) };
    const proceduralMemory = { recordOutcome: vi.fn(async () => null) };

    const worker = new MemoryWorker(repo as any, extractor as any, consolidator as any, summarizer as any, proceduralMemory as any);

    await callProcessBatch(worker, [good, bad]);

    expect(repo.markEventsDone).toHaveBeenCalledWith(["good"]);
    expect(repo.failEvent).toHaveBeenCalledTimes(1);
    expect(repo.failEvent.mock.calls[0][0]).toBe("bad");
  });

  it("still completes every healthy event when nothing fails", async () => {
    const events = [event({ id: "a" }), event({ id: "b" }), event({ id: "c" })];
    const repo = fakeRepo();
    const extractor = { extractFromEvents: vi.fn(async () => []) };
    const consolidator = { consolidate: vi.fn(async () => ({ action: "created" })) };
    const summarizer = { refreshThreadSummary: vi.fn(async () => {}), refreshProfileCard: vi.fn(async () => {}) };
    const proceduralMemory = { recordOutcome: vi.fn(async () => null) };

    const worker = new MemoryWorker(repo as any, extractor as any, consolidator as any, summarizer as any, proceduralMemory as any);

    await callProcessBatch(worker, events);

    expect(repo.markEventsDone).toHaveBeenCalledWith(["a", "b", "c"]);
    expect(repo.failEvent).not.toHaveBeenCalled();
  });

  it("does not fail the episode event when only its procedural-memory derivation throws", async () => {
    // Procedural derivation is best-effort on top of an already-recorded episode - its own
    // failure must never fail the event that triggered it.
    const withWorkspace = event({ id: "e1", workspaceId: "ws1" });
    const repo = fakeRepo();
    const extractor = { extractFromEvents: vi.fn(async () => []) };
    const consolidator = { consolidate: vi.fn(async () => ({ action: "created" })) };
    const summarizer = { refreshThreadSummary: vi.fn(async () => {}), refreshProfileCard: vi.fn(async () => {}) };
    const proceduralMemory = { recordOutcome: vi.fn(async () => { throw new Error("boom"); }) };

    const worker = new MemoryWorker(repo as any, extractor as any, consolidator as any, summarizer as any, proceduralMemory as any);

    await callProcessBatch(worker, [withWorkspace]);

    expect(repo.markEventsDone).toHaveBeenCalledWith(["e1"]);
    expect(repo.failEvent).not.toHaveBeenCalled();
  });
});

describe("MemoryWorker.requestStop / runForever", () => {
  it("exits the poll loop once requestStop() is called, without an infinite hang", async () => {
    const repo = { ...fakeRepo(), findEligibleGroup: vi.fn(async () => null), expireStaleItems: vi.fn(async () => 0) };
    const worker = new MemoryWorker(repo as any, {} as any, {} as any, {} as any, {} as any);

    const runPromise = worker.runForever(5, ["default"]);
    // Let a couple of poll cycles happen, then request a graceful stop.
    await new Promise((resolve) => setTimeout(resolve, 20));
    worker.requestStop();

    await expect(runPromise).resolves.toBeUndefined();
  });
});
