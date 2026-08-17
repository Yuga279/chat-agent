import type { Express } from "express";
import { requireAuth, type AuthedRequest } from "./auth.js";
import { claimOrVerifyThreadOwnership } from "./threadOwnership.js";
import { extractText } from "./agents/shared.js";

const LANGGRAPH_DEPLOYMENT_URL = process.env.LANGGRAPH_DEPLOYMENT_URL ?? "http://localhost:2024";

interface LangChainMessage {
  id?: string;
  type: "human" | "ai" | "tool" | "system";
  content: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  tool_call_id?: string;
}

interface AgUiMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  toolCallId?: string;
}

/** Converts LangGraph's raw checkpointed messages (GET /threads/:id/state) into the AG-UI
 * message shape the CopilotKit client's Agent.setMessages() expects. */
function toAgUiMessages(messages: LangChainMessage[]): AgUiMessage[] {
  return messages.map((m, i) => {
    const id = m.id ?? `resync-${i}`;
    if (m.type === "human") return { id, role: "user" as const, content: extractText(m.content) };
    if (m.type === "tool") return { id, role: "tool" as const, content: extractText(m.content), toolCallId: m.tool_call_id ?? "" };
    return {
      id,
      role: "assistant" as const,
      content: extractText(m.content),
      toolCalls: (m.tool_calls ?? []).map((call) => ({
        id: call.id ?? `${id}-${call.name}`,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  });
}

/**
 * Workaround for a client-side gap: after resuming an interrupted LangGraph run (approving a
 * plan), the CopilotKit client's Agent.runAgent() sometimes never appends the resumed run's
 * output to its own `this.messages` (confirmed via its own runAgent() returning
 * `newMessages: []` despite the server genuinely producing new content - see CLAUDE.md's
 * "resume rendering gap" note). Since the underlying HttpAgent exposes a public
 * `setMessages()` that does correctly notify subscribers/trigger a re-render, the frontend can
 * call this endpoint after a suspiciously-empty resume to pull the true current state directly
 * and force it into the client agent.
 */
export function registerThreadResyncRoute(app: Express): void {
  app.get("/api/thread-messages/:threadId", requireAuth, async (req: AuthedRequest, res) => {
    const { threadId } = req.params;
    const externalUserId = req.userId!;

    const owned = await claimOrVerifyThreadOwnership(threadId, externalUserId);
    if (!owned) {
      res.status(403).json({ error: "This thread belongs to a different user." });
      return;
    }

    try {
      const response = await fetch(`${LANGGRAPH_DEPLOYMENT_URL}/threads/${threadId}/state`);
      if (!response.ok) {
        res.status(502).json({ error: `Failed to fetch thread state (${response.status})` });
        return;
      }

      const state = (await response.json()) as { values?: { messages?: LangChainMessage[] } };
      const messages = toAgUiMessages(state.values?.messages ?? []);
      res.json({ messages });
    } catch (error) {
      console.error("Thread resync failed:", error);
      res.status(500).json({ error: "Failed to resync thread messages." });
    }
  });
}
