export interface AgUiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  toolCallId?: string;
}

/**
 * Pulls a thread's checkpointed messages from `/api/thread-messages/:threadId` (server-side,
 * reads directly from the LangGraph thread state) in the AG-UI shape the CopilotKit client
 * agent's `setMessages()` expects. See InteractionRenderer.tsx's resume-resync use for why
 * `setMessages()` is the reliable way to force these into view (it notifies subscribers; other
 * paths observed not to).
 */
export async function resyncThreadMessages(threadId: string): Promise<AgUiMessage[] | null> {
  try {
    const response = await fetch(`/api/thread-messages/${threadId}`, { credentials: "include" });
    if (!response.ok) {
      console.error("[threadHistory] thread resync request failed:", response.status);
      return null;
    }
    const body = (await response.json()) as { messages: AgUiMessage[] };
    return body.messages;
  } catch (error) {
    console.error("[threadHistory] thread resync threw:", error);
    return null;
  }
}

/**
 * Resuming an interrupted run kicks off the graph's execute node asynchronously - the checkpoint
 * this reads from may not yet contain the run's final assistant message the instant resolve()
 * settles. A single immediate fetch can win a race against the still-running graph and freeze
 * the transcript on a stale (pre-response) snapshot. Poll until the message count grows past
 * `minCount`, or give up after `maxAttempts`.
 */
export async function resyncThreadMessagesUntilGrown(
  threadId: string,
  minCount: number,
  maxAttempts = 8,
  delayMs = 600,
): Promise<AgUiMessage[] | null> {
  let latest: AgUiMessage[] | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    latest = await resyncThreadMessages(threadId);
    if (latest && latest.length > minCount) return latest;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return latest;
}
