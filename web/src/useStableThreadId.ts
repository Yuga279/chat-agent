import { useState } from "react";

/**
 * §16 persistence: without an explicit threadId, CopilotChat mints a fresh one on every mount,
 * so a page reload loses the plan/conversation LangGraph had checkpointed for that thread. One
 * random UUID is picked once per (user, agent) and reused from localStorage from then on.
 */
export function useStableThreadId(username: string, agentId: string): string {
  const key = `chat-agent:thread:${username}:${agentId}`;
  const [threadId] = useState(() => {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  });
  return threadId;
}
