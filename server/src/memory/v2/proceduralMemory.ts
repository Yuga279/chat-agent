import type { MemoryItemRecord, MemoryItemScope, MemoryProvenance, ProcedureDetails } from "../types.js";
import { evaluateProcedureStatus } from "./procedurePolicy.js";
import { memoryRepository, type MemoryRepository } from "./repository.js";

/** A procedure candidate needs at least two ordered steps - a single tool call is an action, not
 * a "how to do something" sequence worth remembering as a procedure. */
const MIN_SEQUENCE_LENGTH = 2;

export interface ProcedureOutcomeInput {
  tenantId: string;
  userId: string;
  /** Taxonomy confines procedural memory to workspace scope (see taxonomy.ts) - a procedure is a
   * shared, reusable asset, not a personal one. Callers on a non-workspace thread should not call
   * this at all; recordOutcome does not silently reinterpret the scope for them. */
  scope: Extract<MemoryItemScope, "workspace">;
  workspaceId: string;
  toolSequence: string[];
  success: boolean;
  sourceEventId: string;
  provenance: MemoryProvenance;
}

function canonicalKeyFor(toolSequence: string[]): string {
  return `procedure.${toolSequence.join(">")}`;
}

/**
 * Implements the promotion pipeline: Episode -> Candidate Procedure -> Validation -> Active
 * Procedure. The only thing this module decides is *whether* an outcome moves a procedure's
 * governance state; the actual write (in-place count bump vs. a new superseding version) is
 * MemoryRepository's job, same division of labor consolidator.ts already has with policy.ts.
 *
 * Deliberately does not exist as its own storage system - every procedure is a `memory_items` row
 * with `kind: "procedural"`, per the taxonomy's explicit "reuse memory_items" rule.
 */
export class ProceduralMemoryService {
  constructor(private readonly repo: MemoryRepository = memoryRepository) {}

  /**
   * Records one observed run of a tool sequence. Returns the resulting item, or null when the
   * sequence was too short to qualify, or when a *first* observation of a never-seen sequence
   * failed - a candidate is only ever born from a success; a sequence that fails on its first
   * appearance has produced no evidence worth remembering yet, so nothing is written.
   */
  async recordOutcome(input: ProcedureOutcomeInput): Promise<MemoryItemRecord | null> {
    const { tenantId, userId, scope, workspaceId, toolSequence, success, sourceEventId, provenance } = input;
    if (toolSequence.length < MIN_SEQUENCE_LENGTH) return null;

    const canonicalKey = canonicalKeyFor(toolSequence);
    const existing = await this.repo.findActiveItemByCanonicalKey(tenantId, userId, scope, workspaceId, canonicalKey);

    if (!existing) {
      if (!success) return null;
      return this.createCandidate({ tenantId, userId, scope, workspaceId, toolSequence, canonicalKey, sourceEventId, provenance });
    }

    return this.applyOutcome(existing, { success, sourceEventId, provenance });
  }

  private async createCandidate(input: {
    tenantId: string;
    userId: string;
    scope: MemoryItemScope;
    workspaceId: string;
    toolSequence: string[];
    canonicalKey: string;
    sourceEventId: string;
    provenance: MemoryProvenance;
  }): Promise<MemoryItemRecord> {
    const procedure: ProcedureDetails = {
      steps: input.toolSequence,
      successCount: 1,
      failureCount: 0,
      validationStatus: "candidate",
    };

    return this.repo.upsertByCanonicalKey({
      tenantId: input.tenantId,
      userId: input.userId,
      scope: input.scope,
      workspaceId: input.workspaceId,
      kind: "procedural",
      subtype: "procedure",
      canonicalKey: input.canonicalKey,
      subject: input.userId,
      predicate: "follows_procedure",
      object: input.canonicalKey,
      content: `Procedure: ${input.toolSequence.join(" -> ")}`,
      // A brand-new candidate is, definitionally, unproven - confidence starts low and rises only
      // once evaluateProcedureStatus actually promotes it (see applyOutcome).
      confidence: 0.4,
      importance: 0.4,
      sensitivity: "none",
      sourceEventIds: [input.sourceEventId],
      provenance: input.provenance,
      procedure,
      existing: null,
      revisionAction: "extracted",
    });
  }

  private async applyOutcome(
    existing: MemoryItemRecord,
    outcome: { success: boolean; sourceEventId: string; provenance: MemoryProvenance },
  ): Promise<MemoryItemRecord> {
    // Should be unreachable: only createCandidate/applyOutcome write kind:"procedural" items, and
    // both always populate `procedure`. Treated as a real error rather than silently coerced, so a
    // future write path that forgets this field fails loudly instead of corrupting counts.
    if (!existing.procedure) {
      throw new Error(`Procedural memory item ${existing.id} is missing its procedure payload.`);
    }

    const successCount = existing.procedure.successCount + (outcome.success ? 1 : 0);
    const failureCount = existing.procedure.failureCount + (outcome.success ? 0 : 1);
    const nextStatus = evaluateProcedureStatus(existing.procedure.validationStatus, successCount, failureCount);

    if (nextStatus === existing.procedure.validationStatus) {
      return this.repo.updateProcedureCounts(existing as MemoryItemRecord & { procedure: ProcedureDetails }, {
        successCount,
        failureCount,
        sourceEventIds: [outcome.sourceEventId],
      });
    }

    // A governance transition (promoted/demoted/rejected) gets its own version, so a rollback can
    // point at exactly the version where that happened rather than "sometime after count N".
    const procedure: ProcedureDetails = { ...existing.procedure, successCount, failureCount, validationStatus: nextStatus };
    return this.repo.upsertByCanonicalKey({
      tenantId: existing.tenantId,
      userId: existing.userId,
      scope: existing.scope,
      workspaceId: existing.workspaceId,
      kind: "procedural",
      subtype: "procedure",
      canonicalKey: existing.canonicalKey,
      subject: existing.subject,
      predicate: existing.predicate,
      object: existing.object,
      content: existing.content,
      // Confidence tracks the governance decision itself: promoted procedures are trusted,
      // demoted/rejected ones are not, and a candidate mid-evaluation stays at its prior value.
      confidence: nextStatus === "active" ? 0.9 : nextStatus === "candidate" ? existing.confidence : 0.2,
      importance: existing.importance,
      sensitivity: "none",
      sourceEventIds: [outcome.sourceEventId],
      provenance: outcome.provenance,
      procedure,
      existing,
      revisionAction: "consolidated",
      revisionReason: `validation status changed: ${existing.procedure.validationStatus} -> ${nextStatus}`,
    });
  }
}

export const proceduralMemoryService = new ProceduralMemoryService();
