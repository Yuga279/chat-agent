import { randomUUID } from "node:crypto";
import { memoryRepository } from "./repository.js";
import type { ToolExecutionSummary } from "../types.js";

export interface ToolCallLike {
  toolName: string;
  status: "success" | "error" | "timeout";
  startedAt: string;
  completedAt: string;
}

export function toToolSummaries(toolCalls: ToolCallLike[]): ToolExecutionSummary[] {
  return toolCalls.map((c) => ({
    toolName: c.toolName,
    status: c.status,
    startedAt: new Date(c.startedAt),
    durationMs: new Date(c.completedAt).getTime() - new Date(c.startedAt).getTime(),
  }));
}

export interface EnqueueTurnMemoryEventInput {
  tenantId: string;
  userId: string;
  threadId: string;
  workspaceId: string | null;
  userText: string;
  assistantText: string;
  toolCalls: ToolCallLike[];
  goalId: string | null;
  stepIndex: number | null;
}

/**
 * The single synchronous write on the graph's completion path (see PLAN.md's "one durable event
 * write after a turn" design) - replaces the old persistChatMemory + recordEpisodeForRun +
 * extractPassiveFacts sequence. Everything downstream (extraction, consolidation, embeddings,
 * episode creation) happens later, asynchronously, in MemoryWorker. Best-effort: never throws,
 * mirroring the v1 functions' contract that a memory-recording failure must never break the turn.
 */
export async function enqueueTurnMemoryEvent(input: EnqueueTurnMemoryEventInput): Promise<void> {
  if (!input.userText && !input.assistantText) return;

  try {
    await memoryRepository.enqueueEvent({
      tenantId: input.tenantId,
      userId: input.userId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      turnId: randomUUID(),
      userText: input.userText,
      assistantText: input.assistantText,
      toolSummaries: toToolSummaries(input.toolCalls),
      goalId: input.goalId,
      stepIndex: input.stepIndex,
    });
  } catch (error) {
    console.error("enqueueTurnMemoryEvent failed (chat turn continues normally):", error);
  }
}
