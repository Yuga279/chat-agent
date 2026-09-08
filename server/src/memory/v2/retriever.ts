import { memoryItemsCollection, memorySummariesCollection } from "../collections.js";
import { embedText } from "../embeddings.js";
import type { MemoryItemRecord, MemorySummaryRecord } from "../types.js";
import { estimateTokens, truncateToTokenBudget } from "./tokenBudget.js";

const PROFILE_TOKEN_BUDGET = 250;
const SUMMARY_TOKEN_BUDGET = 250;
const RETRIEVED_ITEMS_TOKEN_BUDGET = 400;
const RETRIEVAL_TIMEOUT_MS = 200;
const CANDIDATE_POOL_SIZE = 20;
const MAX_INJECTED_ITEMS = 5;

export interface MemoryContext {
  profileCard: string | null;
  threadSummary: string | null;
  retrievedItems: MemoryItemRecord[];
  degraded: boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/**
 * Filtered hybrid retrieval over memory_items, replacing full-collection in-process cosine
 * ranking. Always loads the bounded profile/summary cards; in parallel, runs Atlas text + vector
 * search over the newest user message, fuses the results, and injects at most MAX_INJECTED_ITEMS
 * within RETRIEVED_ITEMS_TOKEN_BUDGET. On timeout/failure (e.g. Atlas Search not provisioned yet,
 * or MEMORY_RETRIEVAL_ENABLED-gated dev environments without Atlas) falls back to profile/summary
 * only - retrieval degrading is never allowed to fail the turn.
 */
export class MemoryRetriever {
  async getContext(
    tenantId: string,
    userId: string,
    threadId: string,
    workspaceId: string | null,
    queryText: string,
  ): Promise<MemoryContext> {
    const [profile, threadSummary, retrievedItems] = await Promise.all([
      this.loadSummary(tenantId, userId, "user", null),
      this.loadSummary(tenantId, userId, workspaceId ? "workspace" : "thread", workspaceId ?? threadId),
      withTimeout(this.hybridSearch(tenantId, userId, workspaceId, queryText), RETRIEVAL_TIMEOUT_MS, null),
    ]);

    return {
      profileCard: profile ? truncateToTokenBudget(profile.content, PROFILE_TOKEN_BUDGET) : null,
      threadSummary: threadSummary ? truncateToTokenBudget(threadSummary.content, SUMMARY_TOKEN_BUDGET) : null,
      retrievedItems: retrievedItems ?? [],
      degraded: retrievedItems === null,
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
  ): Promise<MemoryItemRecord[]> {
    if (!queryText.trim()) return [];

    const scopeFilter = workspaceId ? { workspaceId: { $in: [null, workspaceId] } } : {};

    const [textResults, vectorResults] = await Promise.all([
      this.textSearch(tenantId, userId, scopeFilter, queryText),
      this.vectorSearch(tenantId, userId, scopeFilter, queryText),
    ]);

    return this.fuseAndBudget([...textResults, ...vectorResults]);
  }

  private async textSearch(
    tenantId: string,
    userId: string,
    scopeFilter: Record<string, unknown>,
    queryText: string,
  ): Promise<MemoryItemRecord[]> {
    try {
      return await memoryItemsCollection()
        .aggregate<MemoryItemRecord>([
          {
            $search: {
              index: "memory-items-text",
              compound: {
                must: [{ text: { query: queryText, path: ["content", "canonicalKey"] } }],
                filter: [
                  { equals: { path: "tenantId", value: tenantId } },
                  { equals: { path: "userId", value: userId } },
                  { equals: { path: "status", value: "active" } },
                ],
              },
            },
          },
          { $match: scopeFilter },
          { $limit: CANDIDATE_POOL_SIZE },
          { $project: { _id: 0 } },
        ])
        .toArray();
    } catch (error) {
      // Expected in any environment without Atlas Search provisioned (e.g. local dev against a
      // plain MongoDB) - degrade silently to whatever the vector leg finds, never throw.
      return [];
    }
  }

  private async vectorSearch(
    tenantId: string,
    userId: string,
    scopeFilter: Record<string, unknown>,
    queryText: string,
  ): Promise<MemoryItemRecord[]> {
    try {
      const queryVector = await embedText(queryText);
      if (!queryVector) return [];

      return await memoryItemsCollection()
        .aggregate<MemoryItemRecord>([
          {
            $vectorSearch: {
              index: "memory-items-vector",
              path: "embedding",
              queryVector,
              numCandidates: CANDIDATE_POOL_SIZE * 10,
              limit: CANDIDATE_POOL_SIZE,
              filter: { tenantId, userId, status: "active" },
            },
          },
          { $match: scopeFilter },
          { $project: { _id: 0 } },
        ])
        .toArray();
    } catch (error) {
      return [];
    }
  }

  /** Fuse/rerank by relevance-order-of-appearance (Atlas already scored each leg), recency,
   * importance, confidence, and expiry, then de-dupe by id and cap to the token budget. */
  private fuseAndBudget(items: MemoryItemRecord[]): MemoryItemRecord[] {
    const now = Date.now();
    const seen = new Map<string, MemoryItemRecord>();
    for (const item of items) {
      if (item.validTo && new Date(item.validTo).getTime() < now) continue;
      if (!seen.has(item.id)) seen.set(item.id, item);
    }

    const ranked = [...seen.values()].sort((a, b) => {
      const scoreA = a.importance * 0.5 + a.confidence * 0.3 + this.recencyScore(a) * 0.2;
      const scoreB = b.importance * 0.5 + b.confidence * 0.3 + this.recencyScore(b) * 0.2;
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
