import { useEffect, useState } from "react";
import { disconnectSystem1, getSystem1Status, type System1Status } from "./api.js";

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
        </div>
      </div>
    </div>
  );
}
