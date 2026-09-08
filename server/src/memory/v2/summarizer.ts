import { z } from "zod";
import { silentJsonCompletion } from "../../silentModel.js";
import type { MemoryEventRecord } from "../types.js";
import { memoryRepository, type MemoryRepository } from "./repository.js";
import { tokenBudgetToChars } from "./tokenBudget.js";

const SUMMARY_TOKEN_BUDGET = 250;
const SUMMARY_CHAR_BUDGET = tokenBudgetToChars(SUMMARY_TOKEN_BUDGET);
const PROFILE_ITEM_LIMIT = 12;

const SUMMARY_SCHEMA = z.object({ summary: z.string() });

const THREAD_SUMMARY_PROMPT = `You maintain a short rolling recap of one ongoing conversation, so a future turn can pick \
up context without re-reading the full transcript. Given the previous recap (if any) and the newest turns, write an \
updated recap in at most 4-5 sentences: what the user is trying to accomplish, key decisions/preferences stated, and \
where things currently stand. Keep only what would still matter a few turns from now - drop pleasantries and one-off \
details already resolved. Respond with ONLY a JSON object: {"summary": string}.`;

/**
 * Generates the rolling summary cards MemoryRetriever reads (memory_summaries) - the write side
 * that was missing until now. Two different strategies, deliberately:
 *  - Thread recap: needs real synthesis of what happened, so it goes through an LLM call
 *    (silentJsonCompletion, same non-streaming mechanism MemoryExtractor uses).
 *  - User/workspace profile card: just the top-importance memory_items already extracted,
 *    rendered as bullets - no LLM call needed, since the synthesis already happened when those
 *    items were created. Cheaper and more literal than re-summarizing facts that are already
 *    concise structured records.
 */
export class MemorySummarizer {
  constructor(private readonly repo: MemoryRepository = memoryRepository) {}

  async refreshThreadSummary(
    tenantId: string,
    userId: string,
    threadId: string,
    events: MemoryEventRecord[],
  ): Promise<void> {
    if (events.length === 0) return;

    const existing = await this.repo.getSummary(tenantId, userId, "thread", threadId);
    const newTurnsText = events.map((e) => `User: ${e.userText}\nAssistant: ${e.assistantText}`).join("\n\n");
    const userPrompt = existing ? `Previous recap:\n${existing.content}\n\nNewest turns:\n${newTurnsText}` : `Newest turns:\n${newTurnsText}`;

    let summary: string;
    try {
      const result = await silentJsonCompletion(THREAD_SUMMARY_PROMPT, userPrompt, SUMMARY_SCHEMA, 300);
      summary = result.summary;
    } catch (error) {
      console.error(`MemorySummarizer.refreshThreadSummary failed for thread ${threadId} - keeping the previous recap:`, error);
      return;
    }

    const latestEvent = events[events.length - 1];
    await this.repo.upsertSummary({
      tenantId,
      userId,
      scope: "thread",
      scopeRef: threadId,
      content: summary.slice(0, SUMMARY_CHAR_BUDGET),
      tokenBudget: SUMMARY_TOKEN_BUDGET,
      sourceWatermark: latestEvent.createdAt,
    });
  }

  /** Deterministic bullet card from the top-importance active items in a scope. Regenerated
   * every batch tick - cheap enough (no LLM call) that there's no need to diff against what
   * changed. */
  async refreshProfileCard(
    tenantId: string,
    userId: string,
    scope: "user" | "workspace",
    workspaceId: string | null,
  ): Promise<void> {
    const items = await this.repo.listTopItems(tenantId, userId, scope, workspaceId, PROFILE_ITEM_LIMIT);
    if (items.length === 0) return;

    const bullets: string[] = [];
    let usedChars = 0;
    for (const item of items) {
      const line = `- ${item.content}`;
      if (usedChars + line.length > SUMMARY_CHAR_BUDGET) break;
      bullets.push(line);
      usedChars += line.length + 1;
    }
    if (bullets.length === 0) return;

    await this.repo.upsertSummary({
      tenantId,
      userId,
      scope,
      scopeRef: scope === "workspace" ? workspaceId : null,
      content: bullets.join("\n"),
      tokenBudget: SUMMARY_TOKEN_BUDGET,
      sourceWatermark: items[0].updatedAt,
    });
  }
}

export const memorySummarizer = new MemorySummarizer();
