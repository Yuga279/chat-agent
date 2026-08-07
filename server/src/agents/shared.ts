import type { AIMessageChunk } from "@langchain/core/messages";
import { memoryService } from "../memory/memoryService.js";
import { DEFAULT_TENANT_ID } from "../constants.js";

export { DEFAULT_TENANT_ID };

export function extractText(content: AIMessageChunk["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is { type: "text"; text: string } => "type" in part && part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Tees an agent's message stream: passes chunks through untouched for the caller to render,
 * while logging the assistant's final text to conversation memory and (optionally) recording
 * an episode once the run completes.
 */
export function wrapWithConversationMemory(
  stream: AsyncIterable<unknown>,
  externalUserId: string,
  sessionId: string,
  userMessage: string | undefined,
  episode?: { task: string },
) {
  return (async function* () {
    let assistantText = "";
    const toolsUsed = new Set<string>();

    for await (const chunk of stream as AsyncIterable<[AIMessageChunk, unknown]>) {
      const [message] = chunk;
      if (message.getType() === "ai") {
        assistantText += extractText(message.content);
        for (const call of message.tool_calls ?? []) {
          if (call.name) toolsUsed.add(call.name);
        }
      }
      yield chunk;
    }

    if (assistantText) {
      await memoryService.addMessage(DEFAULT_TENANT_ID, externalUserId, sessionId, "assistant", assistantText);
    }

    if (episode && userMessage) {
      await memoryService.recordEpisode({
        tenantId: DEFAULT_TENANT_ID,
        userId: externalUserId,
        task: episode.task,
        outcome: assistantText.slice(0, 500),
        success: true,
        failureReason: null,
        toolsUsed: JSON.stringify([...toolsUsed]),
        importance: 0.4,
      });
    }
  })();
}
