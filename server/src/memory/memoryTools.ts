import { randomUUID } from "node:crypto";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { goalService } from "./goalService.js";
import { memoryPolicy } from "./v2/policy.js";
import { memoryRepository } from "./v2/repository.js";
import type { MemoryItemScope } from "./types.js";
import type { AgentInteraction } from "../graph/interactionTypes.js";

/**
 * LangChain tools backed by the memory v2 pipeline (memoryRepository/memoryPolicy) - the only
 * surface an agent gets onto memory, no direct DB access is ever exposed to the LLM.
 */
export function buildMemoryTools(
  tenantId: string,
  userId: string,
  memoryScope: { scope: MemoryItemScope; workspaceId: string | null; threadId: string | null } = {
    scope: "user",
    workspaceId: null,
    threadId: null,
  },
) {
  const rememberFact = tool(
    async ({ subject, predicate, object, confidence, subtype }) => {
      const content = `${subject} ${predicate}: ${object}`;
      const sensitivity = memoryPolicy.classify({ subject, predicate, object, content });

      // Refused outright, no consent prompt at all - unlike "sensitive" content (a health fact,
      // say), which a user might deliberately choose to remember, there is no legitimate reason to
      // persist a live credential, so it never even reaches the interrupt() below.
      if (sensitivity === "secret") {
        await memoryRepository.recordRejection(
          tenantId,
          userId,
          { subject, predicate, object, content, canonicalKey: `${subject}.${predicate}`.toLowerCase(), confidence: confidence ?? 0.9 },
          "policy: content matches a credential/secret pattern - refused outright, never offered for consent",
        );
        return "I can't remember that - it looks like it contains a credential or secret, and those are never saved to memory.";
      }

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
      await memoryRepository.upsertByCanonicalKey({
        tenantId,
        userId,
        scope: memoryScope.scope,
        workspaceId: memoryScope.workspaceId,
        kind: "semantic",
        subtype: subtype ?? "fact",
        canonicalKey,
        subject,
        predicate,
        object,
        content,
        confidence: confidence ?? 0.9,
        importance: 0.8,
        sensitivity,
        sourceEventIds: [],
        // An explicit tool call is the user asserting something directly, so the actor is the
        // user, not the worker - and there is no extraction model behind it.
        provenance: {
          sourceType: "explicit_tool",
          actorType: "user",
          actorId: userId,
          sourceThreadId: memoryScope.threadId,
          sourceGoalId: null,
          sourceTurnIds: [],
          extractedAt: null,
          extractionModel: null,
          extractionVersion: null,
        },
        existing,
        revisionAction: "manual_edit",
        revisionReason: "explicit remember_fact tool call",
      });

      return `Remembered: ${content}`;
    },
    {
      name: "remember_fact",
      description:
        "Store or UPDATE a durable fact or preference about the user (e.g. subject='user', " +
        "predicate='prefers_currency', object='INR'). If this is a correction or reversal of something already " +
        "remembered, reuse the exact same subject and predicate as before and only change the object - this " +
        "supersedes the old value instead of creating a conflicting duplicate. Relevant remembered facts are " +
        "already surfaced automatically in your context, so check there first before assuming something isn't " +
        "known. Only use for things that should persist beyond this conversation.",
      schema: z.object({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        confidence: z.number().min(0).max(1).optional(),
        subtype: z
          .enum(["fact", "preference"])
          .optional()
          .describe("'preference' for something the user likes/wants, 'fact' for something that is simply true. Defaults to 'fact'."),
      }),
    },
  );

  return [rememberFact];
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
