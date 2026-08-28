import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { memoryService } from "./memoryService.js";
import { goalService } from "./goalService.js";
import { config } from "../config.js";
import { memoryPolicy } from "./v2/policy.js";
import { memoryRepository } from "./v2/repository.js";
import type { MemoryItemScope } from "./types.js";
import type { AgentInteraction } from "../graph/interactionTypes.js";

/**
 * LangChain tools backed by MemoryService. These are the only surface an agent gets onto
 * memory - no direct DB access is ever exposed to the LLM.
 *
 * `scope`/`workspaceId` are only used by remember_fact's v2 write path (config.memoryV2Enabled) -
 * when v2 is off, remember_fact falls back to the legacy tenant/user-scoped semantic_memories
 * write exactly as before.
 */
export function buildMemoryTools(
  tenantId: string,
  userId: string,
  memoryScope: { scope: MemoryItemScope; workspaceId: string | null } = { scope: "user", workspaceId: null },
) {
  const rememberFact = tool(
    async ({ subject, predicate, object, confidence }) => {
      if (!config.memoryV2Enabled) {
        const record = await memoryService.remember({
          tenantId,
          userId,
          type: "semantic",
          subject,
          predicate,
          object,
          source: { type: "explicit_tool_call", agent: "assistant" },
          confidence: confidence ?? 0.9,
          importance: 0.8,
        });
        return `Remembered: ${record.content}`;
      }

      const content = `${subject} ${predicate}: ${object}`;
      const sensitivity = memoryPolicy.classify({ subject, predicate, object, content });

      if (sensitivity === "sensitive") {
        const interaction: AgentInteraction = {
          type: "memory_consent",
          id: randomUUID(),
          candidate: { subject, predicate, object, content },
        };
        // Pauses the whole graph run at this point in the ReAct loop - same interrupt()
        // mechanism planReviewNode uses. Nothing is written until the user approves; a rejection
        // (or any other resume shape) leaves no trace at all.
        const resume = interrupt(interaction) as { action: "approve" | "reject" };
        if (resume.action !== "approve") {
          return "Okay, I won't remember that.";
        }
      }

      const canonicalKey = `${subject}.${predicate}`.toLowerCase();
      const existing = await memoryRepository.findActiveItemByCanonicalKey(
        tenantId,
        userId,
        memoryScope.scope,
        memoryScope.workspaceId,
        canonicalKey,
      );
      const item = await memoryRepository.insertItem({
        tenantId,
        userId,
        scope: memoryScope.scope,
        workspaceId: memoryScope.workspaceId,
        kind: "fact",
        canonicalKey,
        subject,
        predicate,
        object,
        content,
        confidence: confidence ?? 0.9,
        importance: 0.8,
        sensitivity,
        status: "active",
        supersedes: existing?.id ?? null,
        validFrom: new Date(),
        validTo: null,
        sourceEventIds: [],
        embedding: null,
        embeddingStatus: "pending",
      });
      if (existing) {
        await memoryRepository.supersedeItem(existing.id, item.id);
        await memoryRepository.recordRevision(tenantId, userId, existing.id, "superseded", existing, { supersedes: item.id });
      }
      await memoryRepository.recordRevision(tenantId, userId, item.id, "manual_edit", null, item, "explicit remember_fact tool call");

      return `Remembered: ${content}`;
    },
    {
      name: "remember_fact",
      description:
        "Store or UPDATE a durable fact or preference about the user (e.g. subject='user', " +
        "predicate='prefers_currency', object='INR'). If this is a correction or reversal of something already " +
        "remembered, reuse the exact same subject and predicate as before and only change the object - this " +
        "supersedes the old value instead of creating a conflicting duplicate. Call recall_memory first if " +
        "unsure whether a related fact already exists. Only use for things that should persist beyond this " +
        "conversation.",
      schema: z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        confidence: z.number().min(0).max(1).optional(),
      }),
    },
  );

  const recallMemory = tool(
    async ({ query }) => {
      const results = await memoryService.recall(tenantId, userId, query);
      if (results.length === 0) return "No matching memory found.";
      return results.map((r) => `${r.content} (confidence: ${r.confidence.toFixed(2)})`).join("\n");
    },
    {
      name: "recall_memory",
      description: "Search remembered facts/preferences about the user relevant to a query.",
      schema: z.object({ query: z.string() }),
    },
  );

  const getSimilarExperiences = tool(
    async ({ task }) => {
      const episodes = await memoryService.findSimilarEpisodes(tenantId, userId, task);
      if (episodes.length === 0) return "No similar past experience found.";
      return episodes
        .map((e) => `Task: ${e.task} | Outcome: ${e.outcome} | Success: ${e.success ? "yes" : "no"} | Tools: ${e.actions.map((a) => a.toolName).join(", ")}`)
        .join("\n");
    },
    {
      name: "get_similar_experiences",
      description: "Look up how similar tasks were handled previously, to reuse a working approach or avoid a past failure.",
      schema: z.object({ task: z.string() }),
    },
  );

  const searchPastConversations = tool(
    async ({ query, limit }) => {
      const messages = await memoryService.searchConversations(tenantId, userId, query, limit ?? 10);
      if (messages.length === 0) return "No past messages matching that query were found, across any conversation.";
      return messages
        .map((m) => `[${m.createdAt}] ${m.role === "user" ? "User" : "You"}: ${m.content}`)
        .join("\n");
    },
    {
      name: "search_past_conversations",
      description:
        "Search the user's own message history across ALL of their past conversations/threads, not just this " +
        "one, for a keyword or phrase (case-insensitive substring match). Use this to answer questions like " +
        "'what did I ask you about X before' or 'how many times have I asked about Y' - it returns the actual " +
        "matching messages (newest first), so count/summarize from what's returned. If nothing is returned, " +
        "say plainly that no matching past conversation was found rather than guessing.",
      schema: z.object({
        query: z.string().describe("Keyword or phrase to search for in past messages."),
        limit: z.number().min(1).max(50).optional().describe("Max messages to return, default 10."),
      }),
    },
  );

  return [rememberFact, recallMemory, getSimilarExperiences, searchPastConversations];
}

/**
 * Goal tools are split out from memory tools (PLAN.md's Phase 3 requirement) so they can stay
 * available even when memory reads/writes are paused or the thread is temporary - a durable goal
 * is orthogonal to whether facts/preferences are being remembered this turn.
 */
export function buildGoalTools(tenantId: string, userId: string) {
  const getActiveGoals = tool(
    async () => {
      const goals = await goalService.listActiveGoals(tenantId, userId);
      if (goals.length === 0) return "No active goals.";
      return goals
        .map((g) => {
          const done = g.steps.filter((s) => s.status === "done").length;
          const next = g.steps[g.currentStepIndex];
          return `Goal "${g.title}": ${done}/${g.steps.length} steps done. Next: ${next ? next.description : "none (complete)"}`;
        })
        .join("\n");
    },
    {
      name: "get_active_goals",
      description: "Look up the user's in-progress multi-step goals and how far along they are, e.g. to resume or report progress.",
      schema: z.object({}),
    },
  );

  return [getActiveGoals];
}

/** Builds a compact, token-aware context block of the user's known preferences/facts. */
export async function composePreferenceContext(tenantId: string, userId: string): Promise<string> {
  const facts = await memoryService.getActiveFacts(tenantId, userId, "semantic", 10);
  if (facts.length === 0) return "";

  const lines = facts.map((f) => `- ${f.subject} ${f.predicate}: ${f.object}`);
  return `## Known user preferences\n${lines.join("\n")}`;
}
