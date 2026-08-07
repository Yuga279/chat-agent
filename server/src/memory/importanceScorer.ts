import type { ExtractedFact, IMemoryImportanceScorer } from "./types.js";

/**
 * Default heuristic scorer. Swap this implementation (it's injected, not hardcoded into
 * MemoryService) if a different weighting strategy is needed later.
 */
export class DefaultImportanceScorer implements IMemoryImportanceScorer {
  score(fact: ExtractedFact, opts: { explicitStatement: boolean }): number {
    let score = 0.3;

    if (opts.explicitStatement) score += 0.3;
    if (fact.memoryType === "preference") score += 0.2;
    score += fact.confidence * 0.2;

    return Math.max(0, Math.min(1, score));
  }
}
