import { memoryItemsCollection, memorySummariesCollection } from "../collections.js";
import { embedText } from "../embeddings.js";
import type { MemoryItemRecord, MemorySummaryRecord } from "../types.js";
import { estimateTokens, truncateToTokenBudget } from "./tokenBudget.js";

const PROFILE_TOKEN_BUDGET = 250;
const SUMMARY_TOKEN_BUDGET = 250;
const RETRIEVED_ITEMS_TOKEN_BUDGET = 400;
const CANDIDATE_POOL_SIZE = 20;
const MAX_INJECTED_ITEMS = 5;

// Each retrieval leg gets its own, honest budget, rather than one shared 200ms race the vector leg
// could never win: that race included a Gemini network round trip (embedding the query) *and* the
// Atlas query behind a single timeout shorter than the embedding call alone typically takes, so
// vector retrieval was silently dead in production. Text search needs no network call upstream, so
// it keeps a tight budget; embedding gets the most room since it is the genuinely slow step.
const EMBED_TIMEOUT_MS = 400;
const TEXT_SEARCH_TIMEOUT_MS = 250;
const VECTOR_QUERY_TIMEOUT_MS = 250;

/** Reciprocal Rank Fusion constant - the standard choice (60) from the original RRF paper. Only
 * the item's *rank* within each leg matters, not Atlas's raw, differently-scaled search/vector
 * scores, so no cross-leg score normalization is needed before combining. */
const RRF_K = 60;

export interface MemoryContext {
  profileCard: string | null;
  /** Populated only when the thread is workspace-scoped. Kept as its own slot rather than
   * substituting for threadSummary - the two used to occupy the same context slot, so a
   * workspace-scoped thread received the workspace card *instead of* its own conversation recap,
   * and the recap was regenerated (at real LLM cost) every worker batch only to be discarded. */
  workspaceCard: string | null;
  threadSummary: string | null;
  retrievedItems: MemoryItemRecord[];
  /** True when retrieval (not the summary/profile loads, which have their own independent
   * fallback) was cut short or failed. Surfaced so a caller can log/count it - a turn must never
   * fail because of this, but the degradation itself must not be invisible either. */
  degraded: boolean;
}

/** Builds an AbortController that fires after `ms` - used to actually cancel a request whose
 * result we've stopped waiting for, rather than merely discarding it once the timeout elapses. */
function abortAfter(ms: number): AbortController {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller;
}

/**
 * Filtered hybrid retrieval over memory_items. Always loads the bounded profile/workspace/summary
 * cards; in parallel, runs Atlas text + vector search over the newest user message, fuses by
 * reciprocal rank, and injects at most MAX_INJECTED_ITEMS within RETRIEVED_ITEMS_TOKEN_BUDGET. On
 * timeout/failure (e.g. Atlas Search not provisioned, or a slow embedding call) degrades to
 * whichever leg succeeded - retrieval failing is never allowed to fail the turn.
 */
export class MemoryRetriever {
  async getContext(
    tenantId: string,
    userId: string,
    threadId: string,
    workspaceId: string | null,
    queryText: string,
  ): Promise<MemoryContext> {
    const [profile, workspaceCard, threadSummary, fused] = await Promise.all([
      this.loadSummary(tenantId, userId, "user", null),
      workspaceId ? this.loadSummary(tenantId, userId, "workspace", workspaceId) : Promise.resolve(null),
      // Thread summary is always keyed by threadId, workspace or not - it is a distinct slot from
      // the workspace card, not an alternative to it.
      this.loadSummary(tenantId, userId, "thread", threadId),
      this.hybridSearch(tenantId, userId, workspaceId, queryText),
    ]);

    return {
      profileCard: profile ? truncateToTokenBudget(profile.content, PROFILE_TOKEN_BUDGET) : null,
      workspaceCard: workspaceCard ? truncateToTokenBudget(workspaceCard.content, SUMMARY_TOKEN_BUDGET) : null,
      threadSummary: threadSummary ? truncateToTokenBudget(threadSummary.content, SUMMARY_TOKEN_BUDGET) : null,
      retrievedItems: fused.items,
      degraded: fused.degraded,
    };
  }

  private async loadSummary(
    tenantId: string,
    userId: string,
    scope: MemorySummaryRecord["scope"],
    scopeRef: string | null,
  ): Promise<MemorySummaryRecord | null> {
    try {
      return await memorySummariesCollection().findOne({ tenantId, userId, scope, scopeRef }, { projection: { _id: 0 } });
    } catch (error) {
      console.error("MemoryRetriever.loadSummary failed - continuing without it:", error);
      return null;
    }
  }

  private async hybridSearch(
    tenantId: string,
    userId: string,
    workspaceId: string | null,
    queryText: string,
  ): Promise<{ items: MemoryItemRecord[]; degraded: boolean }> {
    if (!queryText.trim()) return { items: [], degraded: false };

    const [textResult, vectorResult] = await Promise.all([
      this.textSearch(tenantId, userId, workspaceId, queryText),
      this.vectorSearch(tenantId, userId, workspaceId, queryText),
    ]);

    return {
      items: this.fuseAndBudget(textResult.items, vectorResult.items),
      degraded: textResult.degraded || vectorResult.degraded,
    };
  }

  /** Atlas Search filter clauses scoping to this tenant/user/active status, plus workspace scope:
   * exactly `null` when the thread has no workspace, or (null OR this workspace) when it does -
   * modelled as a nested `should`/minimumShouldMatch, since Atlas Search's `filter` array is an
   * implicit AND and has no native OR. Applied inside the search stage itself rather than as a
   * post-search $match, so scoping narrows the candidate pool instead of narrowing an
   * already-truncated top-N result of it. */
  private searchScopeFilter(tenantId: string, userId: string, workspaceId: string | null) {
    const workspaceClause = workspaceId
      ? {
          compound: {
            should: [{ equals: { path: "workspaceId", value: null } }, { equals: { path: "workspaceId", value: workspaceId } }],
            minimumShouldMatch: 1,
          },
        }
      : { equals: { path: "workspaceId", value: null } };

    return [
      { equals: { path: "tenantId", value: tenantId } },
      { equals: { path: "userId", value: userId } },
      { equals: { path: "status", value: "active" } },
      workspaceClause,
    ];
  }

  private async textSearch(
    tenantId: string,
    userId: string,
    workspaceId: string | null,
    queryText: string,
  ): Promise<{ items: MemoryItemRecord[]; degraded: boolean }> {
    const controller = abortAfter(TEXT_SEARCH_TIMEOUT_MS);
    try {
      const items = await memoryItemsCollection()
        .aggregate<MemoryItemRecord>(
          [
            {
              $search: {
                index: "memory-items-text",
                compound: {
                  must: [{ text: { query: queryText, path: ["content", "canonicalKey", "subject", "predicate", "object"] } }],
                  filter: this.searchScopeFilter(tenantId, userId, workspaceId),
                },
              },
            },
            { $limit: CANDIDATE_POOL_SIZE },
            { $project: { _id: 0 } },
          ],
          { signal: controller.signal },
        )
        .toArray();
      return { items, degraded: false };
    } catch (error) {
      // Expected in any environment without Atlas Search provisioned (e.g. local dev against a
      // plain MongoDB), and on our own timeout abort - degrade to whatever the vector leg finds.
      if (!controller.signal.aborted) {
        console.warn("MemoryRetriever.textSearch failed - continuing with vector results only:", (error as Error).message);
      }
      return { items: [], degraded: true };
    }
  }

  private async vectorSearch(
    tenantId: string,
    userId: string,
    workspaceId: string | null,
    queryText: string,
  ): Promise<{ items: MemoryItemRecord[]; degraded: boolean }> {
    const embedController = abortAfter(EMBED_TIMEOUT_MS);
    const queryVector = await embedText(queryText, embedController.signal);
    if (!queryVector) return { items: [], degraded: true };

    const queryController = abortAfter(VECTOR_QUERY_TIMEOUT_MS);
    try {
      const items = await memoryItemsCollection()
        .aggregate<MemoryItemRecord>(
          [
            {
              $vectorSearch: {
                index: "memory-items-vector",
                path: "embedding",
                queryVector,
                numCandidates: CANDIDATE_POOL_SIZE * 10,
                limit: CANDIDATE_POOL_SIZE,
                // $vectorSearch's pre-filter accepts a bounded MQL-like expression against
                // indexed filter fields, including $in - used here to express "no workspace, or
                // this one" without a second query.
                filter: {
                  tenantId,
                  userId,
                  status: "active",
                  workspaceId: workspaceId ? { $in: [null, workspaceId] } : null,
                },
              },
            },
            { $project: { _id: 0 } },
          ],
          { signal: queryController.signal },
        )
        .toArray();
      return { items, degraded: false };
    } catch (error) {
      if (!queryController.signal.aborted) {
        console.warn("MemoryRetriever.vectorSearch failed - continuing with text results only:", (error as Error).message);
      }
      return { items: [], degraded: true };
    }
  }

  /**
   * Fuses the two ranked result lists via Reciprocal Rank Fusion, then blends the fused relevance
   * with importance/confidence/recency as modifiers - not as replacements for it. The previous
   * version discarded Atlas's ranking entirely once a candidate cleared the search filter,
   * projected no `searchScore`/`vectorSearchScore`, and sorted purely on stored metadata: an
   * exact match could rank below an unrelated item with higher importance. Relevance is now the
   * dominant term (matching Phase 13's requirement that semantic similarity actually count),
   * while importance/confidence/recency still get to break ties and reward well-established memory.
   */
  private fuseAndBudget(textResults: MemoryItemRecord[], vectorResults: MemoryItemRecord[]): MemoryItemRecord[] {
    const now = Date.now();
    const byId = new Map<string, MemoryItemRecord>();
    const rrf = new Map<string, number>();

    for (const list of [textResults, vectorResults]) {
      list.forEach((item, index) => {
        if (item.validTo && new Date(item.validTo).getTime() < now) return;
        // A procedure that hasn't cleared governance yet - still a "candidate", or worse,
        // "rejected"/"deprecated" - must never surface as if it were validated guidance. Without
        // this, the entire promotion pipeline (procedurePolicy.ts) would be cosmetic: an unproven
        // or explicitly-rejected procedure would be exactly as retrievable as an active one.
        if (item.kind === "procedural" && item.procedure?.validationStatus !== "active") return;
        byId.set(item.id, item);
        rrf.set(item.id, (rrf.get(item.id) ?? 0) + 1 / (RRF_K + index + 1));
      });
    }

    const maxRrf = Math.max(0, ...rrf.values());
    const ranked = [...byId.values()].sort((a, b) => {
      const relevanceA = maxRrf > 0 ? (rrf.get(a.id) ?? 0) / maxRrf : 0;
      const relevanceB = maxRrf > 0 ? (rrf.get(b.id) ?? 0) / maxRrf : 0;
      const scoreA = relevanceA * 0.55 + a.importance * 0.25 + a.confidence * 0.1 + this.recencyScore(a) * 0.1;
      const scoreB = relevanceB * 0.55 + b.importance * 0.25 + b.confidence * 0.1 + this.recencyScore(b) * 0.1;
      return scoreB - scoreA;
    });

    const budgeted: MemoryItemRecord[] = [];
    let usedTokens = 0;
    for (const item of ranked) {
      if (budgeted.length >= MAX_INJECTED_ITEMS) break;
      const estTokens = estimateTokens(item.content);
      if (usedTokens + estTokens > RETRIEVED_ITEMS_TOKEN_BUDGET) continue;
      budgeted.push(item);
      usedTokens += estTokens;
    }
    return budgeted;
  }

  private recencyScore(item: MemoryItemRecord): number {
    const ageMs = Date.now() - new Date(item.updatedAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return 1 / (1 + ageDays / 30);
  }
}

export const memoryRetriever = new MemoryRetriever();
