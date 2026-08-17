import type { RunnableConfig } from "@langchain/core/runnables";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { memoryService } from "../memory/memoryService.js";
import { extractText } from "../agents/shared.js";
import { DEFAULT_TENANT_ID } from "../constants.js";

export interface ToolCallRecord {
  toolName: string;
  arguments: Record<string, unknown> | undefined;
  result: unknown;
  status: "success" | "error";
  startedAt: string;
  completedAt: string;
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

    const episode = await memoryService.recordEpisode({
      tenantId: DEFAULT_TENANT_ID,
      userId: externalUserId,
      threadId,
      sessionId: threadId,
      goalId,
      stepIndex,
      task,
      actions: toolCalls.map((c) => ({ toolName: c.toolName, status: c.status, startedAt: c.startedAt })),
      outcome,
      success,
      failureReason,
      importance: 0.4,
    });

    for (const call of toolCalls) {
      await memoryService.recordToolExecution({
        tenantId: DEFAULT_TENANT_ID,
        userId: externalUserId,
        threadId,
        sessionId: threadId,
        episodeId: episode.id,
        toolName: call.toolName,
        arguments: call.arguments,
        result: call.result,
        status: call.status,
        startedAt: call.startedAt,
        completedAt: call.completedAt,
      });
    }
  } catch (error) {
    console.error("recordEpisodeForRun failed (chat turn continues normally):", error);
  }
}
