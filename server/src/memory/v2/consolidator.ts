import type { SensitivityLevel } from "./policy.js";
import { memoryPolicy } from "./policy.js";
import { memoryMetrics } from "./metrics.js";
import { memoryRepository, type MemoryRepository } from "./repository.js";
import type { MemoryItemRecord, MemoryItemScope, MemoryKind, MemoryProvenance, MemorySubtype } from "../types.js";

/**
 * A candidate ready for consolidation: an extraction candidate with its taxonomy resolved, or an
 * episode the worker derived deterministically from tool/goal activity. Kept separate from
 * ExtractionCandidate because the extractor only ever proposes semantic subtypes - kind is
 * derived, never model-supplied.
 */
export interface ConsolidationCandidate {
  kind: MemoryKind;
  subtype: MemorySubtype;
  canonicalKey: string;
  subject: string;
  predicate: string;
  object: string;
  content: string;
  confidence: number;
  importance: number;
}

export interface ConsolidationInput {
  tenantId: string;
  userId: string;
  scope: MemoryItemScope;
  workspaceId: string | null;
  candidate: ConsolidationCandidate;
  sourceEventIds: string[];
  provenance: MemoryProvenance;
}

export type ConsolidationOutcome =
  | { action: "created" | "updated" | "reinforced"; item: MemoryItemRecord }
  | { action: "skipped_secret"; candidate: ConsolidationCandidate }
  | { action: "skipped_sensitive"; sensitivity: SensitivityLevel; candidate: ConsolidationCandidate }
  | { action: "skipped_low_confidence"; candidate: ConsolidationCandidate };

/**
 * Merges a candidate into memory_items by canonicalKey + scope. Three distinct outcomes, which the
 * previous single "updated" path conflated:
 *
 *   created    - nothing on file under this key
 *   updated    - the value changed, so a new version supersedes the old one
 *   reinforced - the same value was restated, so the existing item is strengthened in place
 *
 * Every write also appends a memory_revisions row, and every *rejection* now does too - a refused
 * candidate used to vanish without trace, which is the case an operator most needs to review.
 */
export class MemoryConsolidator {
  constructor(private readonly repo: MemoryRepository = memoryRepository) {}

  async consolidate(input: ConsolidationInput): Promise<ConsolidationOutcome> {
    const { tenantId, userId, scope, workspaceId, candidate, sourceEventIds, provenance } = input;

    const sensitivity = memoryPolicy.classify(candidate);
    if (!memoryPolicy.canAutoCapture(sensitivity, candidate.confidence)) {
      const reason =
        sensitivity === "secret"
          ? "policy: content matches a credential/secret pattern - never auto-captured, regardless of confidence"
          : sensitivity === "sensitive"
            ? `policy: ${sensitivity} content may not be auto-captured`
            : `policy: confidence ${candidate.confidence} below auto-capture threshold`;
      await this.repo.recordRejection(tenantId, userId, candidate, reason);

      if (sensitivity === "secret") {
        memoryMetrics.increment("consolidation_skipped_secret");
        return { action: "skipped_secret", candidate };
      }
      if (sensitivity === "sensitive") {
        memoryMetrics.increment("consolidation_skipped_sensitive");
        return { action: "skipped_sensitive", sensitivity, candidate };
      }
      memoryMetrics.increment("consolidation_skipped_low_confidence");
      return { action: "skipped_low_confidence", candidate };
    }

    // canAutoCapture having returned true above guarantees sensitivity === "none" at runtime, but
    // that guarantee lives in a separate function TS can't see through - this both narrows the
    // type for the write below and fails loudly, instead of silently persisting secret/sensitive
    // content, if that contract is ever changed without updating this call site.
    if (sensitivity !== "none") {
      throw new Error(`Unreachable: sensitivity "${sensitivity}" passed canAutoCapture.`);
    }

    const existing = await this.repo.findActiveItemByCanonicalKey(tenantId, userId, scope, workspaceId, candidate.canonicalKey);

    // Same value restated - corroboration, not a change. Strengthen in place rather than adding a
    // version, regardless of whether the incoming confidence is higher or lower than what's on
    // file: either way the stored value itself is unchanged, so a new version would say nothing.
    if (existing && candidate.object === existing.object) {
      const item = await this.repo.reinforceItem(existing, {
        confidence: candidate.confidence,
        importance: candidate.importance,
        sourceEventIds,
      });
      memoryMetrics.increment("consolidation_reinforced");
      return { action: "reinforced", item };
    }

    // The value genuinely differs. A lower-confidence contradiction must not overwrite a
    // higher-confidence record - but an explicit user statement outranks worker inference even at
    // equal confidence, since the user is the authority on their own facts.
    if (existing && candidate.confidence < existing.confidence && provenance.sourceType === "extraction") {
      await this.repo.recordRejection(
        tenantId,
        userId,
        candidate,
        `conflicting value at lower confidence (${candidate.confidence}) than active item (${existing.confidence})`,
      );
      memoryMetrics.increment("consolidation_skipped_low_confidence");
      return { action: "skipped_low_confidence", candidate };
    }

    const item = await this.repo.upsertByCanonicalKey({
      tenantId,
      userId,
      scope,
      workspaceId,
      kind: candidate.kind,
      subtype: candidate.subtype,
      canonicalKey: candidate.canonicalKey,
      subject: candidate.subject,
      predicate: candidate.predicate,
      object: candidate.object,
      content: candidate.content,
      confidence: candidate.confidence,
      importance: candidate.importance,
      sensitivity,
      sourceEventIds,
      provenance,
      existing,
      revisionAction: provenance.sourceType === "extraction" ? "extracted" : "manual_edit",
    });

    memoryMetrics.increment(existing ? "consolidation_updated" : "consolidation_created");
    return { action: existing ? "updated" : "created", item };
  }
}

export const memoryConsolidator = new MemoryConsolidator();
