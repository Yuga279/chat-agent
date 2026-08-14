import { useEffect } from "react";
import { useAgent } from "@copilotkit/react-core/v2";
import { resyncThreadMessagesUntilGrown } from "./threadHistory.js";

/**
 * General-purpose counterpart to InteractionRenderer.tsx's resync-after-resolve() workaround.
 * That one only covers interrupt approve/reject/update, because it's the only place with a
 * `resolve()` callback to hook into - but the underlying CopilotKit client bug it works around
 * (a run's final messages sometimes never landing in `agent.messages`, so the finished run
 * produces no visible change even though the server genuinely responded - confirmed via
 * LangSmith showing a full, successful execution) is not scoped to interrupts. Any run whose
 * final turn spans multiple LangChain messages (a tool-call AIMessage, its ToolMessage result,
 * then a final text AIMessage) exercises the same merge path and can drop the final message the
 * same way - which is why plain text replies ("hi") render fine but tool-driven turns (start/stop
 * a time entry) sometimes don't.
 *
 * `onRunFinalized` fires after every run (success or interrupt-paused) regardless of how it was
 * triggered, so mounting this once resyncs the true backend state after every turn - cheap
 * (one extra fetch) and idempotent (setMessages with the same content is a no-op re-render).
 */
export default function RunResyncGuard() {
  const { agent, isReady } = useAgent();

  useEffect(() => {
    if (!isReady) return;
    let cancelled = false;

    const { unsubscribe } = agent.subscribe({
      onRunFinalized: () => {
        // A single immediate fetch can win a race against the still-running graph and land
        // before its final message is checkpointed (same race InteractionRenderer's resolve()
        // handles via resyncThreadMessagesUntilGrown) - poll past the pre-run count instead of
        // trusting the first response, or a tool-driven turn's reply silently never appears
        // until the user manually refreshes the page.
        const baselineCount = agent.messages.length;
        resyncThreadMessagesUntilGrown(agent.threadId, baselineCount).then((resynced) => {
          if (!cancelled && resynced) agent.setMessages(resynced as never);
        });
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [agent, isReady]);

  return null;
}
