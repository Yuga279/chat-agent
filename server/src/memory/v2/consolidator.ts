import type { ExtractionCandidate } from "./extractor.js";
import type { SensitivityLevel } from "./policy.js";
import { memoryPolicy } from "./policy.js";
import { memoryRepository, type MemoryRepository } from "./repository.js";
import type { MemoryItemRecord, MemoryItemScope } from "../types.js";

export interface ConsolidationInput {
  tenantId: string;
  userId: string;
  scope: MemoryItemScope;
  workspaceId: string | null;
  candidate: ExtractionCandidate;
  sourceEventIds: string[];
}

export type ConsolidationOutcome =
  | { action: "created" | "updated"; item: MemoryItemRecord }
  | { action: "skipped_sensitive"; sensitivity: SensitivityLevel; candidate: ExtractionCandidate }
  | { action: "skipped_low_confidence"; candidate: ExtractionCandidate };

/**
 * Merges an extraction candidate into memory_items by canonicalKey + scope: a stable fact
 * updates/supersedes the existing active item under that key; a new, low-confidence candidate
 * never overwrites a stronger existing record. Every write also appends a memory_revisions row
 * so history/"why was this stored" is reconstructable later.
 */
export class MemoryConsolidator {
  constructor(private readonly repo: MemoryRepository = memoryRepository) {}

  async consolidate(input: ConsolidationInput): Promise<ConsolidationOutcome> {
    const { tenantId, userId, scope, workspaceId, candidate, sourceEventIds } = input;

    const sensitivity = memoryPolicy.classify(candidate);
    if (!memoryPolicy.canAutoCapture(sensitivity, candidate.confidence)) {
      return sensitivity === "sensitive"
        ? { action: "skipped_sensitive", sensitivity, candidate }
        : { action: "skipped_low_confidence", candidate };
    }

    const existing = await this.repo.findActiveItemByCanonicalKey(tenantId, userId, scope, workspaceId, candidate.canonicalKey);

    if (existing && candidate.confidence < existing.confidence && candidate.object === existing.object) {
      // Same value restated with lower confidence than what's already on file - nothing to do.
      return { action: "updated", item: existing };
    }

    const item = await this.repo.upsertByCanonicalKey({
      tenantId,
      userId,
      scope,
      workspaceId,
      kind: candidate.kind,
      canonicalKey: candidate.canonicalKey,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      content: candidate.content,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sensitivity,
      sourceEventIds,
      existing,
      revisionAction: "extracted",
    });

    return { action: existing ? "updated" : "created", item };
  }
}

export const memoryConsolidator = new MemoryConsolidator();
