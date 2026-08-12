import { useState } from "react";
import type { ThreadRecord } from "./api.js";
import { renameThread } from "./api.js";

function formatLabel(thread: ThreadRecord): string {
  if (thread.title) return thread.title;
  const date = new Date(thread.createdAt);
  return `Chat ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export default function ThreadPanel({
  threads,
  activeThreadId,
  onSelect,
  onCreate,
  onRenamed,
}: {
  threads: ThreadRecord[];
  activeThreadId: string | null;
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onRenamed: (threadId: string, title: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  async function commitRename(threadId: string) {
    const title = editingValue.trim();
    setEditingId(null);
    if (!title) return;
    await renameThread(threadId, title);
    onRenamed(threadId, title);
  }

  return (
    <aside className="thread-panel">
      <button className="thread-panel__new" onClick={onCreate}>
        + New chat
      </button>
      <ul className="thread-panel__list">
        {threads.map((thread) => (
          <li key={thread.threadId} className={thread.threadId === activeThreadId ? "thread-panel__item thread-panel__item--active" : "thread-panel__item"}>
            {editingId === thread.threadId ? (
              <input
                autoFocus
                className="thread-panel__rename-input"
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                onBlur={() => commitRename(thread.threadId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename(thread.threadId);
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <button
                className="thread-panel__item-label"
                onClick={() => onSelect(thread.threadId)}
                onDoubleClick={() => {
                  setEditingId(thread.threadId);
                  setEditingValue(thread.title ?? "");
                }}
                title="Double-click to rename"
              >
                {formatLabel(thread)}
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
