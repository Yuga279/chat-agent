import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { memoryService } from "./memoryService.js";
import { goalService } from "./goalService.js";

/**
 * LangChain tools backed by MemoryService. These are the only surface an agent gets onto
 * memory - no direct DB access is ever exposed to the LLM.
 */
export function buildMemoryTools(tenantId: string, userId: string) {
  const rememberFact = tool(
    async ({ subject, predicate, object, confidence }) => {
      const record = await memoryService.remember({
        tenantId,
        userId,
        type: "semantic",
        subject,
        predicate,
        object,
        source: "agent",
        confidence: confidence ?? 0.9,
        importance: 0.8,
      });
      return `Remembered: ${record.content}`;
    },
    {
      name: "remember_fact",
      description:
        "Store a durable fact or preference about the user so it can be recalled in future conversations " +
        "(e.g. subject='user', predicate='prefers_currency', object='INR'). Only use for things that should " +
        "persist beyond this conversation.",
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
        .map((e) => `Task: ${e.task} | Outcome: ${e.outcome} | Success: ${e.success ? "yes" : "no"} | Tools: ${e.toolsUsed}`)
        .join("\n");
    },
    {
      name: "get_similar_experiences",
      description: "Look up how similar tasks were handled previously, to reuse a working approach or avoid a past failure.",
      schema: z.object({ task: z.string() }),
    },
  );

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

  return [rememberFact, recallMemory, getSimilarExperiences, getActiveGoals];
}

/** Builds a compact, token-aware context block of the user's known preferences/facts. */
export async function composePreferenceContext(tenantId: string, userId: string): Promise<string> {
  const facts = await memoryService.getActiveFacts(tenantId, userId, "semantic", 10);
  if (facts.length === 0) return "";

  const lines = facts.map((f) => `- ${f.subject} ${f.predicate}: ${f.object}`);
  return `## Known user preferences\n${lines.join("\n")}`;
}
