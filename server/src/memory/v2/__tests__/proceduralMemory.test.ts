import { beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCollection } from "./inMemoryMongo.js";
import { extractionProvenance } from "./fixtures.js";
import { MIN_SUCCESSES_FOR_PROMOTION } from "../procedurePolicy.js";
import type { MemoryItemRecord, MemoryRevisionRecord } from "../../types.js";

const items = new InMemoryCollection<MemoryItemRecord>();
const revisions = new InMemoryCollection<MemoryRevisionRecord>();

vi.mock("../../collections.js", () => ({
  NO_ID_PROJECTION: { projection: { _id: 0 } },
  memoryItemsCollection: () => items,
  memoryRevisionsCollection: () => revisions,
  memorySummariesCollection: () => new InMemoryCollection(),
  memoryEventsCollection: () => new InMemoryCollection(),
  memoryWorkerLocksCollection: () => new InMemoryCollection(),
}));

const { MemoryRepository } = await import("../repository.js");
const { ProceduralMemoryService } = await import("../proceduralMemory.js");

/** Every item this suite reads back was just written by createCandidate/applyOutcome, both of
 * which always populate `procedure` - narrows the optional field for readability at call sites. */
function procedureOf(item: MemoryItemRecord) {
  if (!item.procedure) throw new Error(`expected item ${item.id} to carry a procedure payload`);
  return item.procedure;
}

function outcome(success: boolean, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "default",
    userId: "u1",
    scope: "workspace" as const,
    workspaceId: "ws1",
    toolSequence: ["start_time_entry", "stop_time_entry"],
    success,
    sourceEventId: `evt-${Math.random()}`,
    provenance: extractionProvenance({ sourceType: "extraction" }),
    ...overrides,
  };
}

describe("ProceduralMemoryService.recordOutcome", () => {
  let service: InstanceType<typeof ProceduralMemoryService>;

  beforeEach(() => {
    items.reset();
    revisions.reset();
    service = new ProceduralMemoryService(new MemoryRepository());
  });

  it("ignores a sequence shorter than two steps", async () => {
    const result = await service.recordOutcome(outcome(true, { toolSequence: ["one_tool"] }));

    expect(result).toBeNull();
    expect(items.docs).toHaveLength(0);
  });

  it("never creates a candidate from a sequence's first appearance failing", async () => {
    // A pattern that has produced no evidence of working yet is not worth remembering as a
    // "candidate" procedure - it is just a failure.
    const result = await service.recordOutcome(outcome(false));

    expect(result).toBeNull();
    expect(items.docs).toHaveLength(0);
  });

  it("creates a candidate at successCount=1 on a first success, never active", async () => {
    const item = await service.recordOutcome(outcome(true));

    expect(item).not.toBeNull();
    expect(item!.kind).toBe("procedural");
    expect(item!.subtype).toBe("procedure");
    expect(item!.scope).toBe("workspace");
    expect(item!.procedure).toEqual({
      steps: ["start_time_entry", "stop_time_entry"],
      successCount: 1,
      failureCount: 0,
      validationStatus: "candidate",
    });
    expect(item!.version).toBe(1);
  });

  it("stays at version 1 while accumulating clean successes below the promotion threshold", async () => {
    for (let i = 0; i < MIN_SUCCESSES_FOR_PROMOTION - 1; i += 1) {
      await service.recordOutcome(outcome(true));
    }

    expect(items.docs).toHaveLength(1);
    const item = items.docs[0];
    expect(item.version).toBe(1);
    expect(procedureOf(item).successCount).toBe(MIN_SUCCESSES_FOR_PROMOTION - 1);
    expect(procedureOf(item).validationStatus).toBe("candidate");
  });

  it("promotes to active exactly at the threshold, creating a new superseding version", async () => {
    for (let i = 0; i < MIN_SUCCESSES_FOR_PROMOTION; i += 1) {
      await service.recordOutcome(outcome(true));
    }

    const active = items.docs.filter((d) => d.status === "active");
    expect(active).toHaveLength(1);
    expect(procedureOf(active[0]).validationStatus).toBe("active");
    expect(active[0].version).toBe(2);
    expect(active[0].confidence).toBeGreaterThan(0.4);

    const superseded = items.docs.filter((d) => d.status === "superseded");
    expect(superseded).toHaveLength(1);
    expect(procedureOf(superseded[0]).validationStatus).toBe("candidate");
    expect(superseded[0].supersededBy).toBe(active[0].id);
  });

  it("blocks promotion permanently once a single failure lands, even past the success threshold", async () => {
    // "Repeated success" means an unbroken record. Once failureCount is nonzero it never resets,
    // so a candidate that has ever failed can accumulate any number of further successes and still
    // never satisfy candidate's promotion condition (successCount >= threshold AND failureCount
    // === 0) - it is stuck at "candidate" for good, distinct from outright rejection.
    await service.recordOutcome(outcome(true)); // successCount=1
    await service.recordOutcome(outcome(true)); // successCount=2, still below threshold
    await service.recordOutcome(outcome(false)); // failureCount=1 - the permanent block
    for (let i = 0; i < 3; i += 1) {
      await service.recordOutcome(outcome(true)); // successCount climbs to 5, well past threshold
    }

    // Every one of these calls left validationStatus unchanged ("candidate" throughout), so every
    // write was an in-place count update - never a new version.
    expect(items.docs).toHaveLength(1);
    const item = items.docs[0];
    expect(item.version).toBe(1);
    expect(procedureOf(item).validationStatus).toBe("candidate");
    expect(procedureOf(item).successCount).toBe(5);
    expect(procedureOf(item).failureCount).toBe(1);
  });

  it("demotes an active procedure to deprecated once failures catch up", async () => {
    for (let i = 0; i < MIN_SUCCESSES_FOR_PROMOTION; i += 1) {
      await service.recordOutcome(outcome(true));
    }
    // Now active. Fail it enough times to catch up with the success count.
    for (let i = 0; i < MIN_SUCCESSES_FOR_PROMOTION; i += 1) {
      await service.recordOutcome(outcome(false));
    }

    const deprecated = items.docs.filter((d) => d.status === "active" && d.procedure?.validationStatus === "deprecated");
    expect(deprecated).toHaveLength(1);
  });

  it("records a revision for every count update, not just governance transitions", async () => {
    await service.recordOutcome(outcome(true));
    await service.recordOutcome(outcome(true));

    // One "extracted" (candidate created) + one "consolidated" (count bump in place).
    expect(revisions.docs.filter((r) => r.action === "extracted")).toHaveLength(1);
    expect(revisions.docs.filter((r) => r.action === "consolidated")).toHaveLength(1);
  });

  it("keeps distinct tool sequences as distinct procedures", async () => {
    await service.recordOutcome(outcome(true, { toolSequence: ["a", "b"] }));
    await service.recordOutcome(outcome(true, { toolSequence: ["c", "d"] }));

    expect(items.docs).toHaveLength(2);
    expect(new Set(items.docs.map((d) => d.canonicalKey)).size).toBe(2);
  });
});
