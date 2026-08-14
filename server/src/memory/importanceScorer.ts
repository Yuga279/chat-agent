import type { ExtractedFact, IMemoryImportanceScorer } from "./types.js";

/**
 * Default scorer. Passes through the model's own `fact.importance` estimate (from
 * LlmMemoryExtractor) unmodified - no code-side heuristics blended in. Swap this implementation
 * (it's injected, not hardcoded into MemoryService) if a different strategy is needed later.
 */
export class DefaultImportanceScorer implements IMemoryImportanceScorer {
  score(fact: ExtractedFact): number {
    return Math.max(0, Math.min(1, fact.importance));
  }
}
