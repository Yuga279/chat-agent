import type { MemoryItemRecord, MemoryProvenance } from "../../types.js";

/** Provenance for a worker-extracted item, which is what most tests exercise. */
export function extractionProvenance(overrides: Partial<MemoryProvenance> = {}): MemoryProvenance {
  return {
    sourceType: "extraction",
    actorType: "worker",
    actorId: "u1",
    sourceThreadId: "t1",
    sourceGoalId: null,
    sourceTurnIds: ["turn-1"],
    extractedAt: new Date("2026-01-01T00:00:00Z"),
    extractionModel: "test-model",
    extractionVersion: "2",
    ...overrides,
  };
}

/** A fully-populated active memory item. Tests override only the fields they care about, so a
 * schema addition breaks in one place rather than in every test file. */
export function memoryItem(overrides: Partial<MemoryItemRecord> = {}): MemoryItemRecord {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "item-1",
    tenantId: "default",
    userId: "u1",
    scope: "user",
    workspaceId: null,
    kind: "semantic",
    subtype: "fact",
    canonicalKey: "user.timezone",
    subject: "user",
    predicate: "timezone",
    object: "Asia/Kolkata",
    content: "user timezone: Asia/Kolkata",
    confidence: 0.9,
    importance: 0.7,
    sensitivity: "none",
    status: "active",
    version: 1,
    supersedes: null,
    supersededBy: null,
    validFrom: now,
    validTo: null,
    sourceEventIds: ["evt0"],
    provenance: extractionProvenance(),
    embedding: null,
    embeddingStatus: "done",
    embeddingAttempts: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
