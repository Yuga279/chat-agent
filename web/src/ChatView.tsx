import { useState } from "react";
import { CopilotKit, CopilotChat, CopilotChatConfigurationProvider } from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { logout } from "./api.js";
import ResearchPlan from "./ResearchPlan.js";
import InteractionRenderer from "./InteractionRenderer.js";
import { useStableThreadId } from "./useStableThreadId.js";

const AGENTS = [
  { id: "clockwork", label: "ClockWork" },
  { id: "research", label: "Research" },
  { id: "qna", label: "Q&A" },
] as const;

type AgentId = (typeof AGENTS)[number]["id"];

export default function ChatView({ username, onLoggedOut }: { username: string; onLoggedOut: () => void }) {
  const [agentId, setAgentId] = useState<AgentId>("research");
  const threadId = useStableThreadId(username, agentId);

  async function handleLogout() {
    await logout();
    onLoggedOut();
  }

  return (
    <div className="view">
      <header>
        <span>{username}</span>
        <button onClick={handleLogout}>Log out</button>
      </header>
      <CopilotKit runtimeUrl="/api/copilotkit" credentials="include">
        <CopilotChatConfigurationProvider agentId={agentId} threadId={threadId}>
          <div className="agent-tabs">
            {AGENTS.map((a) => (
              <button
                key={a.id}
                className={a.id === agentId ? "agent-tab agent-tab--active" : "agent-tab"}
                onClick={() => setAgentId(a.id)}
              >
                {a.label}
              </button>
            ))}
          </div>
          <div className="research-layout">
            {agentId === "research" && <ResearchPlan />}
            {agentId === "research" && <InteractionRenderer />}
            <CopilotChat className="research-chat" />
          </div>
        </CopilotChatConfigurationProvider>
      </CopilotKit>
    </div>
  );
}
