import { useEffect, useState } from "react";
import {
  clearMemories,
  createWorkspace,
  deleteMemory,
  deleteWorkspace,
  disconnectSystem1,
  getMemories,
  getMemorySettings,
  getSystem1Status,
  getWorkspaces,
  setMemorySettings,
  type MemoryItem,
  type System1Status,
  type WorkspaceRecord,
} from "./api.js";

function MemorySection() {
  const [enabled, setEnabled] = useState(true);
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const [settings, ws] = await Promise.all([getMemorySettings(), getWorkspaces()]);
      setEnabled(settings.enabled);
      setWorkspaces(ws);
      const scopedItems = selectedWorkspaceId
        ? await getMemories({ scope: "workspace", workspaceId: selectedWorkspaceId })
        : await getMemories({ scope: "user" });
      setItems(scopedItems);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaceId]);

  async function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    await setMemorySettings(next);
  }

  async function handleCreateWorkspace() {
    const name = newWorkspaceName.trim();
    if (!name) return;
    await createWorkspace(name);
    setNewWorkspaceName("");
    refresh();
  }

  async function handleDeleteWorkspace(id: string) {
    if (!window.confirm("Delete this workspace? Its workspace-scoped memories will be removed; chats stay intact.")) return;
    await deleteWorkspace(id);
    if (selectedWorkspaceId === id) setSelectedWorkspaceId("");
    refresh();
  }

  async function handleDeleteItem(id: string) {
    await deleteMemory(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  }

  async function handleClearAll() {
    if (!window.confirm("Clear all memory in this scope? This can't be undone.")) return;
    await clearMemories(selectedWorkspaceId ? "workspace" : "user", selectedWorkspaceId || undefined);
    setItems([]);
  }

  return (
    <>
      <h3>Memory</h3>
      <label className="memory-settings__toggle">
        <input type="checkbox" checked={enabled} onChange={toggleEnabled} />
        Remember things across conversations
      </label>

      <h4>Workspaces</h4>
      <ul className="workspace-list">
        <li>
          <button
            className={selectedWorkspaceId === "" ? "workspace-list__item workspace-list__item--active" : "workspace-list__item"}
            onClick={() => setSelectedWorkspaceId("")}
          >
            Personal
          </button>
        </li>
        {workspaces.map((ws) => (
          <li key={ws.id}>
            <button
              className={selectedWorkspaceId === ws.id ? "workspace-list__item workspace-list__item--active" : "workspace-list__item"}
              onClick={() => setSelectedWorkspaceId(ws.id)}
            >
              {ws.name}
            </button>
            <button className="workspace-list__delete" aria-label={`Delete workspace ${ws.name}`} onClick={() => handleDeleteWorkspace(ws.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="workspace-create"
        onSubmit={(e) => {
          e.preventDefault();
          handleCreateWorkspace();
        }}
      >
        <input placeholder="New workspace name" value={newWorkspaceName} onChange={(e) => setNewWorkspaceName(e.target.value)} />
        <button type="submit">Add</button>
      </form>

      <h4>{selectedWorkspaceId ? "Workspace memories" : "Your memories"}</h4>
      {loading && <p>Loading...</p>}
      {!loading && items.length === 0 && <p>Nothing remembered here yet.</p>}
      {!loading && items.length > 0 && (
        <>
          <ul className="memory-item-list">
            {items.map((item) => (
              <li key={item.id} className="memory-item-list__row">
                <div>
                  <p>{item.content}</p>
                  <p className="memory-item-list__meta">
                    {item.kind} · {item.sourceEventIds.length > 0 ? `${item.sourceEventIds.length} source turn(s)` : "explicitly remembered"} ·
                    updated {new Date(item.updatedAt).toLocaleDateString()}
                  </p>
                </div>
                <button aria-label="Delete memory" onClick={() => handleDeleteItem(item.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button className="modal-panel__danger" onClick={handleClearAll}>
            Clear all in this scope
          </button>
        </>
      )}
    </>
  );
}

export default function ProfileModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<System1Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getSystem1Status());
    } catch {
      setError("Could not check System1 connection status.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm("Disconnect your System1 account? You can reconnect it any time.")) return;
    setDisconnecting(true);
    setError(null);
    try {
      await disconnectSystem1();
      await refresh();
    } catch {
      setError("Could not disconnect System1 account.");
    } finally {
      setDisconnecting(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-panel__header">
          <h2>Profile</h2>
          <button className="modal-panel__close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="modal-panel__body">
          <h3>System1 account</h3>
          {loading && <p>Checking connection status...</p>}
          {error && <p className="error">{error}</p>}
          {!loading && !error && status && (
            <>
              {status.linked ? (
                <>
                  <p className="system1-status system1-status--connected">Connected</p>
                  <button className="modal-panel__danger" onClick={handleDisconnect} disabled={disconnecting}>
                    {disconnecting ? "Disconnecting..." : "Disconnect System1 account"}
                  </button>
                </>
              ) : (
                <>
                  <p className="system1-status system1-status--disconnected">Not connected</p>
                  <button onClick={() => window.open(status.linkUrl, "_blank")}>Connect System1 account</button>
                </>
              )}
              <button className="modal-panel__refresh" onClick={refresh}>
                Refresh status
              </button>
            </>
          )}

          <MemorySection />
        </div>
      </div>
    </div>
  );
}
