import { useEffect, useState } from "react";
import {
  CopilotKit,
  CopilotChat,
  CopilotChatConfigurationProvider,
  useAgent,
  useConfigureSuggestions,
} from "@copilotkit/react-core/v2";
import "@copilotkit/react-core/v2/styles.css";
import { getThreads, createThread, logout, type ThreadRecord } from "./api.js";
import ThreadPanel from "./ThreadPanel.js";
import InteractionRenderer from "./InteractionRenderer.js";
import RunResyncGuard from "./RunResyncGuard.js";
import ProfileModal from "./ProfileModal.js";
import { resyncThreadMessages } from "./threadHistory.js";

const AGENT_ID = "assistant";

const STARTER_SUGGESTIONS = [
  { title: "Start tracking time", message: "Start a time entry for the project I'm working on right now." },
  { title: "Stop the current entry", message: "Stop my currently running time entry." },
  { title: "What am I tracking?", message: "What time entry, if any, do I currently have running?" },
  { title: "Research a topic", message: "Research the best approach for " },
];

/** Static starter suggestion pills shown before the first message - CopilotChat renders
 * whatever useConfigureSuggestions registers automatically, so this just needs to run once
 * under the CopilotChatConfigurationProvider tree. */
function ChatSuggestions() {
  useConfigureSuggestions({
    available: "before-first-message",
    suggestions: STARTER_SUGGESTIONS,
  });
  return null;
}

/** Loads the selected thread's prior messages into the client agent on mount - CopilotChat does
 * not fetch history for an existing threadId on its own, so switching threads would otherwise
 * render a blank chat until the next live run. See InteractionRenderer.tsx's identical use of
 * `agent.setMessages()` for why this is the reliable way to force messages into view. */
function ThreadHistoryLoader({ threadId }: { threadId: string }) {
  const { agent } = useAgent();

  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    resyncThreadMessages(threadId).then((messages) => {
      if (!cancelled && messages) agent.setMessages(messages as never);
    });
    return () => {
      cancelled = true;
    };
  }, [agent, threadId]);

  return null;
}

export default function ChatView({ username, onLoggedOut }: { username: string; onLoggedOut: () => void }) {
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);

  useEffect(() => {
    (async () => {
      const existing = await getThreads();
      if (existing.length > 0) {
        setThreads(existing);
        setThreadId(existing[0].threadId);
        return;
      }
      const created = await createThread();
      setThreads([{ threadId: created, createdAt: new Date().toISOString() }]);
      setThreadId(created);
    })();
  }, []);

  async function handleLogout() {
    await logout();
    onLoggedOut();
  }

  async function handleCreateThread() {
    const created = await createThread();
    setThreads((prev) => [{ threadId: created, createdAt: new Date().toISOString() }, ...prev]);
    setThreadId(created);
  }

  function handleRenamed(renamedThreadId: string, title: string) {
    setThreads((prev) => prev.map((t) => (t.threadId === renamedThreadId ? { ...t, title } : t)));
  }

  // The "connect System1" link CopilotChat renders from markdown is a plain <a> that would
  // otherwise navigate the whole SPA away to the external IdP - intercept it via delegation
  // (works regardless of when/how the markdown renderer mounts the anchor) and open it in a new
  // tab instead, matching the button styling in style.css.
  function handleChatAreaClick(e: React.MouseEvent<HTMLDivElement>) {
    const anchor = (e.target as HTMLElement).closest("a");
    if (anchor && anchor.href.includes("/oauth/link")) {
      e.preventDefault();
      window.open(anchor.href, "_blank", "noopener");
    }
  }

  return (
    <div className="view">
      <header>
        <span>{username}</span>
        <div>
          <button onClick={() => setShowProfile(true)}>Profile</button>
          <button onClick={handleLogout}>Log out</button>
        </div>
      </header>
      {showProfile && <ProfileModal onClose={() => setShowProfile(false)} />}
      <div className="chat-layout" onClick={handleChatAreaClick}>
        <ThreadPanel
          threads={threads}
          activeThreadId={threadId}
          onSelect={setThreadId}
          onCreate={handleCreateThread}
          onRenamed={handleRenamed}
        />
        {threadId && (
          // Keying on threadId forces a full remount when switching threads, so CopilotKit
          // re-initializes against the newly selected thread's checkpointed history instead of
          // continuing to render the previous thread's client-side state.
          <CopilotKit key={threadId} runtimeUrl="/api/copilotkit" credentials="include" useSingleEndpoint={false}>
            <CopilotChatConfigurationProvider agentId={AGENT_ID} threadId={threadId}>
              <ThreadHistoryLoader threadId={threadId} />
              <ChatSuggestions />
              <RunResyncGuard />
              <InteractionRenderer />
              <CopilotChat className="research-chat" />
            </CopilotChatConfigurationProvider>
          </CopilotKit>
        )}
      </div>
    </div>
  );
}
