import type { RunnableConfig } from "@langchain/core/runnables";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { memoryService } from "../memory/memoryService.js";
import { extractText } from "../agents/shared.js";
import { DEFAULT_TENANT_ID } from "../constants.js";

export interface ToolCallRecord {
  toolName: string;
  arguments: Record<string, unknown> | undefined;
  result: unknown;
  status: "success" | "error" | "timeout";
  startedAt: string;
  completedAt: string;
}

/**
 * Passive fact extraction: re-introduces the old clockwork agent's fire-and-forget pipeline that
 * pulled durable facts out of any user message, not just explicit remember_fact calls (see
 * CLAUDE.md's "known gap" note - memoryService.extractAndPersist() already existed but had zero
 * callers). Runs an extra small structured-output LLM call per turn (LlmMemoryExtractor, ~300
 * token budget) - a real cost, but it's what makes semantic_memories populate during normal
 * conversation instead of staying empty until a user happens to ask to be remembered. Best-effort,
 * same pattern as persistChatMemory/recordEpisodeForRun: never let a failure break the turn.
 */
export async function extractPassiveFacts(externalUserId: string, userMessage: string): Promise<void> {
  if (!userMessage) return;

  try {
    const persisted = await memoryService.extractAndPersist(DEFAULT_TENANT_ID, externalUserId, userMessage);
    // Cheap hit-rate signal: how often this extra LLM call actually finds something durable vs.
    // running for nothing. Watch this in logs before deciding whether to gate/batch/drop it.
    console.log(`extractPassiveFacts: ${persisted.length} fact(s) persisted for user ${externalUserId}`);
  } catch (error) {
    console.error("extractPassiveFacts failed (chat turn continues normally):", error);
  }
}

export function taskFromLatestUserMessage(state: { messages: BaseMessage[] }): string {
  const latestUserMessage = [...state.messages].reverse().find((m) => m.getType() === "human");
  return latestUserMessage ? String(latestUserMessage.content) : "";
}

/** Mirrors this turn's user message and final assistant reply into MongoDB (`conversation_messages`),
 * in addition to LangGraph's own thread checkpointing - see MemoryService.addMessage. Best-effort:
 * a failure here must never break the actual chat turn. */
export async function persistChatMemory(
  state: { messages: BaseMessage[] },
  config: RunnableConfig,
  externalUserId: string,
  newMessages: Array<AIMessage | ToolMessage>,
): Promise<void> {
  const sessionId = config.configurable?.thread_id as string | undefined;
  if (!sessionId) return;
  const threadId = sessionId;

  try {
    const latestUserMessage = [...state.messages].reverse().find((m) => m.getType() === "human");
    if (latestUserMessage) {
      await memoryService.addMessage(DEFAULT_TENANT_ID, externalUserId, threadId, sessionId, "user", String(latestUserMessage.content));
    }

    const finalReply = [...newMessages].reverse().find((m) => m.getType() === "ai" && extractText(m.content).length > 0);
    if (finalReply) {
      await memoryService.addMessage(DEFAULT_TENANT_ID, externalUserId, threadId, sessionId, "assistant", extractText(finalReply.content));
    }
  } catch (error) {
    console.error("persistChatMemory failed (chat turn continues normally):", error);
  }
}

/** Records this turn (or goal step) as an episode - what `get_similar_experiences` reads back,
 * so it stops being a tool wired to a permanently empty collection. `success` is a simple
 * heuristic (no "Unknown tool:" fallback and no unlinked-account error surfaced) rather than
 * anything the model judges itself - good enough for "was there friction" without another model
 * call. Best-effort, same as persistChatMemory: never let a recording failure break the turn. */
export async function recordEpisodeForRun(
  externalUserId: string,
  threadId: string | null,
  task: string,
  newMessages: Array<AIMessage | ToolMessage>,
  toolCalls: ToolCallRecord[],
  goalId: string | null,
  stepIndex: number | null,
): Promise<void> {
  if (!task) return;

  try {
    let success = true;
    let failureReason: string | null = null;

    for (const message of newMessages) {
      if (message.getType() === "tool" && typeof message.content === "string") {
        if (message.content.startsWith("Unknown tool:") || message.content.startsWith("NOT_LINKED::")) {
          success = false;
          failureReason = message.content.slice(0, 300);
        }
      }
    }

    const finalReply = [...newMessages].reverse().find((m) => m.getType() === "ai" && extractText(m.content).length > 0);
    const outcome = finalReply ? extractText(finalReply.content) : "";

    await memoryService.recordEpisode({
      tenantId: DEFAULT_TENANT_ID,
      userId: externalUserId,
      threadId,
      goalId,
      stepIndex,
      task,
      actions: toolCalls.map((c) => ({
        toolName: c.toolName,
        status: c.status,
        startedAt: new Date(c.startedAt),
        durationMs: new Date(c.completedAt).getTime() - new Date(c.startedAt).getTime(),
      })),
      outcome,
      success,
      failureReason,
      importance: 0.4,
    });
  } catch (error) {
    console.error("recordEpisodeForRun failed (chat turn continues normally):", error);
  }
}
